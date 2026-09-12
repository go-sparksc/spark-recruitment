# Spark SC Recruitment Platform — Product Requirements Document

**Owner:** Kai Lincoln
**Status:** v1.27, Phases 0-9 complete, decisions recorded through 119 — every slice shipped and gated, and the reconciliation pass in `plans/prd-reconciliation.md` applied. Phase 8's succession gate, a board member running a full mock cycle from `ADMIN_GUIDE.md` alone, is complete and found nothing pressing (`plans/phase-8.md`). Spark's first real cycle is pending. The freeze ahead of it has one owner-approved exception, decision 119's class standing (`plans/decision-119.md`), which ships before that cycle; every other refinement still waits until after it
**Target:** Replace the S26 recruitment spreadsheet before the next full recruitment cycle

---

## 1. Problem

Spark SC currently runs recruitment out of a single Excel workbook. The S26 file contains 36 sheets, 160+ applicants, and roughly 30 reviewers. Every round adds a new layer of manually maintained sheets (`WR Data`, `1RD Voting`, `2RD Vote Backend`, `Sparklet Maker`) that duplicate applicant identity, scores, and demographics.

Concrete failure modes visible in the current file:

- **Applicant identity is re-keyed by name across sheets.** `Decisions` uses `ID` + `Full Name`, `1RD Voting` uses `Name` only, `1R Notes` uses free-text `Applicant Name` typed by interviewers. Any typo or accidental cell manipulation can silently orphan a record or break the workbook.
- **Voting is a manually maintained reviewer-by-applicant grid.** `Voting Results` has 30 reviewer columns. `2RD Vote` has 11. Adding or removing a reviewer means restructuring a sheet mid-round.
- **Rubric scores and demographics live in the same rows.** Showing a first-round interviewer the scores without also exposing race, first-gen status, and written responses means manually fine-tuning which columns are visible, which is difficult and error-prone.
- **The workbook is not transferable.** Its logic lives in cell formulas and in the head of whoever built it. Training a new operator on the workbook takes significant time and close oversight.
- **Editing the workbook is difficult.** Updating or making changes to the workbook is tricky and cumbersome, with significant limitations based on how the workbook was originally built. Changes to the rubric, number or types of questions, and other variables between application cycles requires significant maintenance of the workbook beforehand.
- **Reviewers make and record their scores outside of the workbook.** To prevent someone accidentally breaking the workbook, all reviews and scores are recorded on separate linked and unlinked spreadsheets, leading to complicated cross-workbook dependencies or cumbersome manual uploads.

## 2. Goals

1. **One canonical applicant record.** Every score, note, vote, and decision attaches to a stable applicant ID, never a name string.
2. **Near-zero reviewer friction.** A reviewer opens a link, picks a round and their name, and starts grading. No account creation, no download, no spreadsheet training.
3. **Structural bias controls.** Field-level visibility per round, enforced by the system rather than by an admin remembering to hide columns.
4. **Survives succession.** A new E-Board with no context can run a full cycle from documentation alone.
5. **Flexible to future application changes.** The system should be flexible and able to adapt to changes in number of questions, types of questions, rubric criteria, point values, or number of categories.
6. **Portfolio-legible.** The data model, the assignment algorithm, and the pass state machine are the three pieces worth talking about in a PM interview. They should be clean enough to explain in five minutes.

## 3. Non-goals (v1)

- Applicant-facing anything. Applicants never log in. Application intake stays in the existing form tool and all responses are uploaded as CSVs (Typeform).
- Automated email to applicants. The platform surfaces the email list; sending happens elsewhere.
- Multi-org / multi-tenant SaaS. This is Spark SC's tool. Instances are recruitment cycles, not customers.
- Interview scheduling.
- Mobile-native apps. The reviewer dashboard must work well in a phone browser; that is the requirement.

## 4. Users

| Role | Count per cycle | Access | Needs |
|---|---|---|---|
| Administrator | 2–6 (Co-Presidents, E-Board) | Password per instance | Setup, assignment, overrides, decisions, exports |
| Written reviewer | ~30-40 | Round link + access code + name | Read assigned profiles, score against rubric, return conflicts |
| First-round reviewer | ~15–25 | Same | Read interview scores and notes, vote yes/no |
| Second-round reviewer | ~10–15 | Same | Read full profile, flag conflicts, submit votes per pass |

## 5. Core data model

The single most important design decision: **applicants are identified by a system-generated ID, and CSV columns become typed field definitions rather than ad-hoc column names.**

```
Instance
  id, name, passwordHash, createdAt
  currentStage: WRITTEN | FIRST_ROUND | SECOND_ROUND | COMPLETE
  importCommittedAt            // null until FR-3 commit. Non-null is what
                               //   refuses a second CSV. See FR-3.
  importProposals: jsonb       // detected group proposals awaiting the admin's
                               //   name-or-dismiss. Null once committed.
  CHECK (importCommittedAt IS NULL OR importProposals IS NULL)
                               // clearing proposals at commit is a line of code
                               //   that a refactor can drop; this makes it a
                               //   database guarantee. Stale proposals on a
                               //   committed instance would read as meaningful
                               //   and could contradict the FieldGroup rows.
  currentTermSeason: SPRING | FALL   // nullable. The semester the cycle runs in,
  currentTermYear              //   nullable int. Together they are the "now" that
                               //   class standing counts from — decision 119.
                               //   Collected at creation and IMMUTABLE once set;
                               //   null only on instances created before 119,
                               //   which get one set-once control on settings.
  CHECK ((currentTermSeason IS NULL) = (currentTermYear IS NULL))
                               // a half-set semester is not a semester
  CHECK (currentTermYear IS NULL OR currentTermYear BETWEEN 2000 AND 2100)

FieldGroup                     // several CSV columns forming one logical question
  id, instanceId
  key                          // stable slug, e.g. "ethnicity". IMMUTABLE:
                               //   slugged once from the name given at creation
                               //   and never re-slugged on rename. FR-19 and
                               //   FR-20 reference it, and a key that moves when
                               //   someone fixes a typo is the name-keying
                               //   defect this system exists to remove.
                               //   displayName is what a rename changes.
  displayName                  // admin-editable; the heading FR-19 renders
  category: DEMOGRAPHIC | RESPONSE | OTHER
                               //   classification, not visibility. Decides §10.7's
                               //   1/n counting and FR-19's breakdown, and gates
                               //   the DEMOGRAPHIC lock in §6. See decision 108.
  isMultiSelect                // bool; true when members can be checked together
  isIncluded                   // bool, default true; applies to every member
  ordinal
  isReviewerVisible            // nullable bool; applies to every member.
                               //   true = every reviewer round; false = no reviewer
                               //   round; NULL = not yet chosen, and resolves hidden.
                               //   There is no default: see FR-2 and decision 108.
  UNIQUE (instanceId, key)

Field                          // one per CSV column
  id, instanceId
  sourceHeader                 // exact header text from the CSV, verbatim
  displayName                  // admin-editable
  groupId                      // nullable; the FieldGroup this column belongs to
  groupRole: OPTION | FREE_TEXT   // nullable; set only when groupId is set
  promotedRole: EMAIL | NAME   // nullable; FR-2's designation. EMAIL is the
                               //   join key for FR-12/FR-13. NAME may be one
                               //   column or two ("First Name" + "Last Name"),
                               //   joined in ordinal order. Both are removed
                               //   at commit, when their values become
                               //   Applicant.email and Applicant.displayName.
  category: DEMOGRAPHIC | RESPONSE | OTHER
                               //   the group's value wins when groupId is set.
                               //   Classification, not visibility — decision 108.
  ordinal
  isIncluded                   // bool, default true; false = value retained but excluded
                               //   from every review surface. See FR-2. The group's
                               //   value wins when groupId is set.
  isReviewerVisible            // nullable bool. true = every reviewer round;
                               //   false = no reviewer round; NULL = not yet chosen,
                               //   and resolves hidden. No default, and forced false
                               //   where category is DEMOGRAPHIC. The group's value
                               //   wins when groupId is set. See §6 and decision 108.
  isGraduationDate             // bool, default false. FR-2's graduation-date
                               //   designation: the column class standing is
                               //   derived from, per decision 119. Not a
                               //   promotedRole — the row survives commit — and
                               //   not frozen at commit, since it keys nothing.
  UNIQUE (instanceId, ordinal)
  CHECK ((groupId IS NULL) = (groupRole IS NULL))
                               // "set only when groupId is set", enforced.
                               //   Prisma cannot express a CHECK, so this lives
                               //   in raw migration SQL and is asserted by
                               //   prisma/checks/field-groups.ts.
  UNIQUE (instanceId) WHERE promotedRole = 'EMAIL'
                               // partial index: at most one EMAIL column per
                               //   instance. NAME is deliberately not covered,
                               //   since two columns can carry it.
  CHECK (promotedRole IS NULL OR (isIncluded AND groupId IS NULL))
                               // FR-2's "cannot be excluded" made real. A
                               //   promoted column is also never a group
                               //   member, since group properties would
                               //   override its inclusion.
  UNIQUE (instanceId) WHERE isGraduationDate
                               // partial index, EMAIL's shape: at most one
                               //   graduation-date column per instance.
  CHECK (NOT (isGraduationDate AND promotedRole IS NOT NULL))
                               // a promoted row is deleted at commit, and would
                               //   take the designation with it. Both live in
                               //   raw migration SQL, asserted by prisma/checks/.

ImportRow                      // FR-2/FR-3 staging. Exists only between upload
  id, instanceId               //   and commit, and is deleted at commit.
  rowIndex                     // 1-based position in the source file. Becomes
                               //   Applicant.sourceRowIndex, never renumbered,
                               //   so discarding a duplicate leaves a gap and
                               //   "Applicant 47" still means record 47.
  cells: jsonb                 // { columnIndex: verbatim value }. Verbatim so
                               //   the preview can report Quinn Spacey's padded
                               //   email rather than silently fixing it.
  UNIQUE (instanceId, rowIndex)

Applicant
  id, instanceId
  sourceRowIndex
  email                        // promoted out of data for matching
  displayName                  // promoted out of data for display
  data: jsonb                  // { fieldId: value }
  status: ACTIVE | REJECTED | SPARKLET
  stageReached: WRITTEN | FIRST_ROUND | SECOND_ROUND
  UNIQUE (instanceId, email)   // makes FR-3 duplicate resolution a database
                               //   guarantee, not a UI convention. Blank emails
                               //   are null, and Postgres permits many nulls.

RubricCategory
  id, instanceId, name, maxPoints, ordinal
                               // `description` is GONE, per decision 114. One
                               //   blurb per category said what the category
                               //   asked for and left every reviewer to invent
                               //   the boundary between a 2 and a 3 privately,
                               //   which is where the disagreement FR-10 flags
                               //   actually lives. Replaced by RubricLevel below.
                               //   Decision 32's reasoning survives it: a name
                               //   and a maximum are a scale, not a rubric.
  minPoints                    // default 0. The scale's floor, so a category can
                               //   run 1..4 rather than 0..maxPoints. Invariant
                               //   0 <= minPoints < maxPoints, enforced in
                               //   validateRubric; validateScore takes the floor
                               //   as a parameter rather than assuming zero.
                               //   See decision 40.

RubricLevel                    // what one score value means, in one category.
  id, rubricCategoryId         //   Decision 114. FR-9 renders each criterion
  points                       //   against the value it belongs to, beside the
  criterion                    //   score input. Nullable/absent is fine — a
                               //   criterion is individually optional for the
                               //   reason decision 32 made the description
                               //   optional, and an absent row simply renders
                               //   the bare value.
  UNIQUE (rubricCategoryId, points)
                               // "one criterion per offered value", as a database
                               //   guarantee rather than a convention held in a
                               //   form component. A table rather than a jsonb
                               //   map on the category for decision 40's reason:
                               //   the scale is data that travels with the
                               //   instance that used it, and history stays
                               //   coherent. Cascades from RubricCategory, and
                               //   sits inside FR-4's lock with the rest of the
                               //   rubric.

Reviewer
  id, instanceId, firstName, lastName
  isSparklet: bool
  rounds: [WRITTEN, FIRST_ROUND, SECOND_ROUND]   // which rounds they serve in

Assignment
  id, instanceId, round, applicantId, reviewerId
  origin: AUTO | MANUAL | CLAIMED_FROM_POOL
  status: ACTIVE | RETURNED_TO_POOL
  returnReason: CONFLICT_OF_INTEREST | OTHER
                               // nullable. FR-9's required reason, set on
                               //   return to pool and cleared when the row is
                               //   reactivated by a re-claim or an FR-8 assign.
                               //   See decisions 27, 28 and 39.
  returnNote                   // nullable free text, optional for both reasons
  returnedAt                   // nullable
  suspectedAiUse               // bool, default false. Decision 116. One written
                               //   reviewer's read that this application looks
                               //   AI-written, ticked on FR-9's score card and
                               //   surfaced to the admin on FR-10. On the
                               //   assignment rather than the applicant because
                               //   it is one person's judgment and three
                               //   reviewers disagreeing is itself the signal.
                               //   Admin-only under §6 — it does NOT travel to a
                               //   second-round reviewer with the scores and
                               //   notes decision 77 opened up. Nothing detects
                               //   anything; §11's automated flagging is still
                               //   out of scope.
  UNIQUE (round, applicantId, reviewerId)

Score                          // written round
  id, assignmentId, rubricCategoryId, points
  UNIQUE (assignmentId, rubricCategoryId)

ReviewNote
  id, assignmentId, body

InterviewCategory              // the first-round interview rubric. Instance-scoped
  id, instanceId               //   and admin-configured, per goal 5. NOT the same
  name, maxPoints, ordinal     //   rows as RubricCategory, which is the written rubric.
  UNIQUE (instanceId, ordinal)

InterviewResult                // first round, imported. Two rows per applicant.
  id, applicantId
  interviewerName
  score                        // the average as it appears in the source sheet,
                               //   imported verbatim. Never recomputed from the
                               //   category rows. See decision 6.
  UNIQUE (applicantId, interviewerName)
                               // makes a re-upload an upsert rather than a
                               //   duplicate. See decision 47.

InterviewCategoryScore         // one per category per InterviewResult
  id, interviewResultId, interviewCategoryId, points
  UNIQUE (interviewResultId, interviewCategoryId)

InterviewNotes                 // one row per applicant; only one interviewer of
  id, applicantId, body        //   the pair writes them, and the "Your Name"
  interviewerName              //   column records which. Nullable, per decision 60.
  UNIQUE (applicantId)

InterviewImport                // FR-12 staging header. One row per sheet, deleted
  id, instanceId               //   at that sheet's commit, taking its rows with it.
  sheet: SCORES | NOTES
  headers: jsonb               // the source file's header row, verbatim
  mapping: jsonb               // { columnIndex: role }, role being APPLICANT_EMAIL |
                               //   APPLICANT_NAME | INTERVIEWER_NAME | AVERAGE |
                               //   NOTES | CATEGORY:<interviewCategoryId> | IGNORED
  uploadedAt
  UNIQUE (instanceId, sheet)   // A re-upload replaces this row and cascades its
                               //   staged rows away, which is FR-12's "accepts
                               //   repeated uploads" without a second staging set.
                               //   Row existence is also the answer to "is this
                               //   sheet staged?", the question importCommittedAt
                               //   answers for FR-3 — decision 47 gives the two
                               //   sheets independent lifecycles, and a shared
                               //   nullable column on Instance would make each
                               //   commit responsible for clearing half of it.

InterviewImportRow             // FR-12/13 staging. Exists only between upload
  id, instanceId               //   and commit for each sheet, and is deleted
                               //   at that sheet's commit.
  importId                     // the InterviewImport this row was staged by
  sheet: SCORES | NOTES        // which of FR-12's two uploads this row came from
  rowIndex                     // 1-based position in its source file
  cells: jsonb                 // { columnIndex: verbatim value }, same
                               //   verbatim-preview reasoning as ImportRow
  matchedApplicantId           // nullable; set once the row is resolved to
                               //   an Applicant, by any tier
  matchTier: EMAIL | NAME | FUZZY | MANUAL   // nullable until resolved
  matchConfidence               // nullable; the similarity score, set only
                               //   when matchTier = FUZZY. See decision 45.
  skipped                      // bool, default false. Decision 51's third
                               //   outcome: the admin has said this row matches
                               //   nobody in the pool. A decision that was made,
                               //   recorded, rather than a row silently dropped.
  UNIQUE (instanceId, sheet, rowIndex)
  CHECK ((matchedApplicantId IS NULL) = (matchTier IS NULL))
                               // resolved means both or neither
  CHECK ((matchTier = 'FUZZY') = (matchConfidence IS NOT NULL))
                               // "set only when matchTier = FUZZY", enforced
  CHECK (NOT (skipped AND matchedApplicantId IS NOT NULL))
                               // a skipped row is not also a matched one
                               // All three live in raw migration SQL — Prisma
                               //   cannot express a CHECK — and are asserted by
                               //   prisma/checks/, same posture as Field's.

FirstRoundVote
  id, applicantId, reviewerId, value: YES | NO | SKIP
  UNIQUE (applicantId, reviewerId)

ConflictOfInterest
  id, round, applicantId, reviewerId
  UNIQUE (round, applicantId, reviewerId)

Pass                           // second round
  id, instanceId, ordinal, openedAt, closedAt
  status: OPEN | CLOSED
  UNIQUE (instanceId, ordinal) // passes are sequential
  UNIQUE (instanceId) WHERE status = OPEN
                               // FR-17: exactly one pass is OPEN at a time.
                               //   PARTIAL, so closed passes accumulate freely.
                               //   Prisma cannot express the WHERE, so it is
                               //   hand-written SQL; prisma/checks/passes.ts
                               //   asserts it bites and that it is partial.

PassApplicant                  // membership, fixed at pass creation per FR-17
  id, passId, applicantId
  resolution: SPARKLET | REJECTED | CARRIED | NEEDS_ADMIN   // null until resolved
  resolvedAt                   // nullable; when resolution was last written,
                               //   null while it is null
  UNIQUE (passId, applicantId)

PassVote
  id, passId, applicantId, reviewerId
  value: YES | NO | SKIP       // SKIP is permitted by the shared VoteValue type
                               //   and written by nothing in the product; a
                               //   conflict is computed as SKIP without a row,
                               //   and lib/passes.ts honours a stored one if it
                               //   ever exists. See decision 67.
  submittedAt
  UNIQUE (passId, applicantId, reviewerId)

Decision
  id, applicantId, stage, outcome: ADVANCE | REJECT | SPARKLET
  actor: SYSTEM | ADMIN
  decidedAt
  UNIQUE (applicantId, stage)  // one decision per applicant per stage. The
                               //   only reversal is decision 107's, which
                               //   DELETES the row rather than updating it —
                               //   there is no earlier decision to restore to
                               //   — and audits the deleted values. See
                               //   decisions 106 and 107.

RoundAccessCode                // the per-round reviewer code from §8
  id, instanceId, round
  codeHash                     // hashed, never stored in plaintext
  UNIQUE (instanceId, round)

AuditLog                       // admin overrides, per §8
  id
  instanceId?                  // NULLABLE, ON DELETE SET NULL — not CASCADE.
                               //   Deleting an instance is the one irreversible
                               //   action in the product, and under CASCADE the
                               //   row recording that deletion is destroyed by
                               //   the cascade it exists to describe. The
                               //   deletion record survives as an orphan
                               //   carrying the instance's identity in its own
                               //   columns. See §8.
  actor                        // the ROLE: "admin" | "system". Not a person.
                               //   Distinct from Decision.actor, which is the
                               //   DecisionActor enum and means something else
                               //   entirely — see decisions 69 and 93.
  actorName?                   // NULLABLE. The name typed at sign-in (decision
                               //   16). Null on every row written before Phase 8
                               //   and on every "system" row, and deliberately
                               //   not backfilled: those actions have no known
                               //   person, and inventing one would be a
                               //   falsehood in the attribution table itself.
  action
  entityType, entityId
  previousValue: jsonb
  createdAt

RateLimitBucket                // §8's password gates, per decision 92. The ONE
                               //   table that belongs to no instance: it is keyed
                               //   by client address and belongs to the
                               //   deployment. Excluded from FR-20's export by
                               //   name, per decision 96.
  key                          // PK. "<scope>:<client ip>"
  failures, windowStartedAt
  lockedUntil?                 // null while the key is not locked
  lockoutCount                 // lifetime, so a repeat offender is visible
  updatedAt
```

Five notes on this model:

- `Applicant.data` as JSONB rather than a key-value table. CSV columns vary cycle to cycle, so the schema cannot be fixed, but Postgres can still index and query inside JSONB. A separate `Field` table carries the human-facing metadata. This is meaningfully simpler than entity-attribute-value and just as flexible.
- **Every score, vote, and note references `applicantId`, never a name.** This is the fix for the current workbook's core problem.
- The source export uses one-hot columns for ethnicity: ten separate columns, any number of which an applicant may check, plus a free-text column for anything not listed. These become one FieldGroup with ten OPTION members and one FREE_TEXT member, which is what tells the UI and the demographic aggregations to treat them as one question rather than eleven independent ones. Category, inclusion, and the §6 visibility flag are properties of the group, not of its members, so a group cannot end up half hidden and half visible, and a partially excluded group cannot occur. The FREE_TEXT member is a member for display and reconciliation only: it is excluded from the checked predicate and from the 1/n counting in §10.7.
- **`PassApplicant` exists because pass membership cannot be reconstructed after the fact.** FR-17 fixes membership at pass creation, but `Applicant.status` only ever shows the *current* state; once an applicant is resolved there is no way to ask "who was in pass 1?" without a stored roster. It is also where the all-COI case lands: §7.4 requires that an applicant every reviewer has recused from be distinguishable from a unanimous result, and `NEEDS_ADMIN` is that distinction. Resolution is a property of an applicant *within a pass*, not of the applicant.
- **The interview rubric is its own table, and `InterviewResult.score` is imported rather than derived.** `InterviewCategory` is deliberately separate from `RubricCategory`: the written rubric and the interview rubric are different instruments with different categories, and goal 5 requires both be reconfigurable between cycles, which rules out fixed columns. `score` holds the average exactly as the source sheet carries it — if it disagrees with the mean of the category rows, the sheet wins, because that is the number the interviewers actually recorded. There is deliberately no `UNRESOLVED` on `ApplicantStatus`: an applicant left undecided when the second round closes is identified by their row in the final pass, not by a second copy of that fact on the applicant. See FR-17.

## 6. Field visibility matrix

Enforced server-side. A reviewer request for a hidden field returns nothing, rather than the client hiding it.

**Mapped columns carry one binary flag, not a per-round matrix.** Decision 108 replaced the three-category × four-viewer matrix with `isReviewerVisible` on each `Field` and `FieldGroup`. There is no per-round distinction for any mapped column: a column is visible to all three reviewer rounds or to none of them.

| What | Written reviewer | First-round reviewer | Second-round reviewer | Admin |
|---|---|---|---|---|
| Applicant name | **Hidden** | Visible | Visible | Visible |
| Applicant email | **Hidden** | Visible | Visible | Visible |
| Mapped column, `isReviewerVisible = true` | Visible | Visible | Visible | Visible |
| Mapped column, `isReviewerVisible = false` | Hidden | Hidden | Hidden | Visible |
| Mapped column, `isReviewerVisible` unset | Hidden | Hidden | Hidden | Visible |
| Mapped column, category DEMOGRAPHIC | **Hidden, locked** | **Hidden, locked** | **Hidden, locked** | Visible |
| Any column with `isIncluded = false` | Hidden | Hidden | Hidden | **Hidden** |
| Class standing, derived from the designated graduation-date column | Follows that column | Follows that column | Follows that column | Follows that column |
| Interview scores | Hidden | Visible | Visible | Visible |
| Interview notes | Hidden | Visible | Visible | Visible |
| Written rubric scores and review notes, from other reviewers | Hidden | Hidden | Visible | Visible |
| Round votes and tallies — first-round votes and pass votes | Hidden | Hidden | **Hidden** | Visible |
| A resolved applicant's outcome — Sparklet or rejected | Hidden | Hidden | **Visible** | Visible |
| Suspected AI use, from another reviewer | Hidden | Hidden | **Hidden** | Visible |

**The scores row and the votes row were one row, and it was carrying two questions.** It read "Other reviewers' scores/votes — Hidden until pass closes" for a second-round reviewer, which refused FR-16's own list of what that reviewer sees. Prior-round evidence is what a deliberation is conducted on; the votes being cast now are what anchoring is about. See decision 77, and decision 74 for why "until pass closes" became plain Hidden. Written scores and review notes are attributed to the reviewer who gave them, the same way FR-14 attributes an interview score to its interviewer.

**The outcome row splits off the votes row, and the split is a reversal rather than a clarification.** Decision 111 gives a second-round reviewer the *outcome* of a resolved applicant — green for Sparklet, red for rejected — while leaving every vote and every tally hidden. The two are not independent facts and the decision says so: an applicant resolves only when every eligible reviewer has submitted, so a terminal outcome is a complete tally, derived. Decision 111 states the anchoring cost that follows and records it as accepted deliberately. `CARRIED` and `NEEDS_ADMIN` are not outcomes and appear on no reviewer surface as anything but a neutral settled state.

**Suspected AI use is admin-only, including in the second round, and that is deliberate rather than an oversight of decision 77.** 77's argument for opening prior-round evidence to a deliberation is that the person who gave the 2 is in the room and can be asked why — the score has a scale behind it and a reason attached. A suspicion has neither. See decision 116. A reviewer sees their own flag, which is their own datum.

**Category no longer decides visibility, with one exception, and the exception is the point.** `category` survives as a classification — it decides §10.7's 1/n counting and FR-19's breakdown — and it is read by the visibility layer only to force `DEMOGRAPHIC` to hidden. That lock is not configurable and is enforced server-side, not merely omitted from the UI: goal 3's premise is that the bias controls are enforced by the system rather than by an admin remembering. See decision 108, which carries decision 18's reasoning forward into the binary model.

**`RESPONSE` is protected by a commit blocker rather than by a lock.** FR-3 refuses to commit an import in which any included `RESPONSE` column is Backend only, which is the same enforcement strength as the DEMOGRAPHIC lock. It is deliberately not a lock, because the two fail in opposite directions: hiding is fail-safe, while showing is not, and `category` freezes at commit while `isReviewerVisible` does not. A locked-open flag on a frozen enum is the one state in this model that cannot be walked back — a column mistakenly marked Responses would be reviewer-visible for the life of the instance. Decision 34's "a column mis-marked RESPONSE can still be hidden by un-including it" is the escape hatch this preserves.

**Where the flag is set, and for how long.** On the FR-2 mapping table, where it stays editable after the import commits — along with the include/exclude checkbox, and unlike everything else on that table. See decision 34. Rounds run weeks after a CSV is imported, so freezing visibility at commit would close the only window in which it can be set before anyone has a reason to open it. FR-2 requires an explicit choice on every eligible column, and FR-3 blocks the commit until every one has been made.

**There is no default, with one exception, and the exception is where the rule was doing no work.** An included RESPONSE column arrives ticked Reviewer-visible, per decision 110 — the two FR-3 blockers between them already leave that as the only committable state, so requiring the tick was charging an admin for a choice that had been made for them. Everywhere else the no-default rule stands: an OTHER column arrives unset and cannot be committed until someone chooses, which is the case decision 108 was written about and the case where an unchosen column really is a decision nobody has made.

**Class standing has no visibility of its own.** It is derived at render time from the designated graduation-date column and the instance's current semester, and it resolves exactly as that column does — group, inclusion, the DEMOGRAPHIC lock and `isReviewerVisible` included. It is computed on the server only for a viewer who can already see the source value, so a hidden source means the derived line is absent from the response, not hidden by the client. See decision 119 for why a second toggle would add a place to forget rather than a control.

Hiding demographics from reviewers is a deliberate change from the current spreadsheet, where reviewers see whatever columns are in front of them. Reviewers grading essays have no need for ethnicity or first-gen status, and hiding them removes a bias vector at no cost. Under decision 108 that now holds in the second round too, not only in the written and first rounds.

Names are hidden from written reviewers for the same reason (open decision 4). Written reviewers see an anonymous label built from `sourceRowIndex`, e.g. "Applicant 47." Names remain visible to admins throughout, including on FR-10, since decisions cannot be made against anonymous labels. A written reviewer who recognizes an applicant from the essay itself can still return to pool.

**Email is hidden from written reviewers too, and the row above is not redundant.** USC addresses are `firstname.lastname@usc.edu` — an email is a name in disguise, and FR-2 makes email un-excludable, so it exists on every applicant. Both `Applicant.displayName` and `Applicant.email` are promoted columns rather than `Field` rows, so neither is covered by the per-field `isReviewerVisible` flag. The server-side visibility layer therefore has three inputs: FieldGroup rows for grouped columns, Field rows for ungrouped ones, and fixed rules for the promoted ones (displayName and email hidden in the written round, sourceRowIndex exposed only as the anonymous label). Resolving a field to its effective category, inclusion, and visibility belongs in one shared helper, not re-derived per surface.

## 7. Functional requirements

### 7.1 Instance setup

**FR-1 Dashboard.** Landing page lists existing instances by name with created date and stage. Also offers "New instance from CSV."

Opening an instance lands on that instance's hub, which lists every surface it has in the order a cycle uses them — columns, rubric, reviewers, assignments, settings — each carrying the state it is actually in rather than a bare link. Every instance page links back to the hub as well as to this list. See decision 36.

**FR-2 CSV import.** Accept the applicant CSV. Parse headers. Show a mapping table with one row per column:

- Detected header (read-only)
- Editable display name (defaults to a cleaned version of the header)
- Include/exclude checkbox (default on)
- Category selector: Demographics / Responses / Other. **Every column defaults to Other**; the importer never guesses a category from header text, because a wrong silent guess is worse than an unset one. Category is a classification, not a visibility control — see §6 and decision 108.
- Visibility: two mutually exclusive checkboxes, **Reviewer-visible** and **Backend only**. **Neither box is ticked to begin with, except on an included Responses column, which arrives Reviewer-visible per decision 110.** Reviewer-visible means all three reviewer rounds; Backend only means none of them. A column whose category is Demographics shows both boxes disabled, with Backend only fixed — §6's lock, enforced server-side rather than merely omitted from the UI.

**Every eligible column must have a visibility state explicitly chosen**, and FR-3 refuses to commit until they all do. Eligible means included, non-promoted, and not category Demographics; a grouped column inherits the group's choice, so the choice is made once on the group. Leaving a column unset is not a third state — it resolves hidden until chosen, so an unset column can never leak — it is simply not a committable one.

**Responses are the one category that arrives with a state already chosen**, per decision 110. Because the importer never guesses a category, a column becomes Responses only when an admin selects it, and at that moment FR-3's two blockers leave exactly one committable answer: Backend only refuses the commit, and unset refuses the commit. The tick is applied there rather than demanded afterwards. Ticking Backend only over it still stores that choice and is still refused at commit, so the gate is unchanged — only the starting point moved. A column later moved from Responses to Other keeps the flag it was given, since by then it is an explicit choice like any other.

This row and the include/exclude checkbox above it remain editable after the import commits; every other control on this table freezes at that point. The mapping table is therefore the admin's surface for the whole cycle rather than only for the import. See FR-3 and decision 34. Because visibility can also be left unset on an instance that has already committed — decision 108's migration leaves ambiguous rows unchosen rather than guessing — the mapping table shows the outstanding list on committed instances too, not only before commit.

Some questions arrive as several columns. The ten one-hot ethnicity columns are one question, not ten. The mapping table detects likely groups by their value signature — every non-empty value in the column is the same literal, and that literal is the column's own header — and presents them for confirmation. Three guards keep the heuristic honest: a column with no non-empty values has no signature and is never a candidate, a run of one column is not a group, and comparison is exact, since `Black` is a strict prefix of `Black or African American`.

**A detected group is a proposal, not a result.** It is not stored as a FieldGroup until the admin names it, which is also when its immutable `key` is assigned. Dismissing it discards it. Doing neither is a third state, and FR-3 warns about it before commit rather than silently importing the columns ungrouped — which would leave the §10.7 demographic breakdown with no group to read and nobody the wiser until FR-11.

The admin can rename a group, split it, merge two, or assign an ungrouped column to a group. The free-text write-in will not be detected, since its values vary by definition, so attaching it to its group is a manual step the mapping table must support. Include/exclude, category and visibility are set on the group and apply to every member; individual members of a group cannot be excluded, categorized or made visible separately.

Two columns require explicit designation and cannot be excluded: **email** (used as the join key for later imports) and **display name** (first + last, or a single name column).

**A third designation is optional: graduation date**, per decision 119. The admin marks at most one column as the graduation date, and class standing is derived from it. It is a separate control from the email/name designation because it follows the opposite freeze rule: the column stays an ordinary `Field` row after commit, keys nothing, and so the designation stays editable for the life of the instance alongside inclusion and visibility. A promoted column cannot carry it. The importer never guesses it from a header, for the same reason it never guesses a category.

**FR-3 Import preview and commit.** Show row count, detected duplicates by email, and rows with a blank email or name. Admin resolves or discards these before commit. On commit, create one Applicant per row.

**Duplicates are compared on the normalized email — trimmed, NFC, lowercased — not the verbatim one.** USC addresses are case-insensitive, and two rows differing only in case would otherwise pass the preview and then violate `UNIQUE (instanceId, email)` at commit, after the admin has approved the import. The verbatim value is what the preview displays, so a normalization that changes anything is visible rather than silent; an address that is whitespace-only normalizes to empty and counts as blank, not as a duplicate.

The preview carries two blockers of its own, both from decision 108's visibility model, both enforced server-side on the commit action rather than only in the UI:

- **A column with no visibility state chosen.** FR-2 requires an explicit Reviewer-visible or Backend only on every eligible column, and this is where that requirement is enforced. Unset resolves hidden, so committing past it would be safe but silent — an admin would discover in the written round that they had decided nothing.
- **An included RESPONSE column set to Backend only.** §6 protects Responses with a blocker rather than a lock, and this is the blocker. The reasoning for choosing a blocker over a lock is in §6 and decision 108. Decision 110 makes this the rarer of the two blockers rather than removing it: a Responses column now arrives Reviewer-visible, so reaching this state takes a deliberate tick, and the blocker is what refuses that tick at the gate.

The preview also carries two warnings that do not block, because each describes a plausible instance the system should not overrule:

- **A detected group that has been neither named nor dismissed.** Committing past it imports the columns as independent questions, and no demographic breakdown will ever find them.
- **No included field resolving to RESPONSE at all.** The blocker above cannot fire in this case — there is no Response column to be set wrongly — so the warning is still needed. An instance with nothing marked Responses is one where the written round's profiles are likely to be thin, but it is not necessarily wrong, since Other columns can be made Reviewer-visible.

An instance accepts exactly one CSV. Commit is final, and a later upload into a committed instance is refused with a message naming the correction path rather than a disabled control. The only correction after commit is deleting the instance and importing again, which destroys every round's work along with the applicants; v1 has no applicant edit surface, and the only decision reversal is decision 107's, which reaches a manual reject in a still-open pass and nothing earlier (decision 106). This is why the preview above is load-bearing: it is the only point at which a bad file can be caught cheaply.

**What "final" covers is field *identity*, not presentation policy.** Frozen at commit: the one-CSV rule, and each column's category, group membership, display name and email/name designation. Not frozen: inclusion, the `isReviewerVisible` flag, and the graduation-date designation (decision 119), which stay editable for the life of the instance. The line between them is what a property keys — `Applicant.data` is keyed by `Field.id`, so recategorising or regrouping a column changes what an already-written key means, while the two booleans key nothing and orphan nothing. See decisions 34 and 108.

**Commit is guarded by a two-step confirmation**, because it is irreversible and it sits on a page whose whole purpose is reviewing and adjusting. Following the primary control renders a panel naming what is about to become final — how many applicants will be created, the one-CSV rule, and the column properties that freeze — and the commit itself is a separate submit inside that panel. Deliberately lighter than FR-5's typed-name gate for deletion, which is rare and destroys existing work, where commit is on the path every instance takes and creates rather than destroys. See decision 35.

**FR-4 Rubric builder.** Admin enters number of categories and max points per category. System generates the grid for naming each category and for stating what each score in it means. Store as `RubricCategory` and `RubricLevel`. Rubric is locked once any Score exists; changing it after grading has started requires an explicit "reset written scores" action with a confirmation.

**Per decision 40:** the builder collects the scale's *floor* as well as its maximum, so a cycle can run its categories 1–4 rather than 0–`maxPoints`. A new category starts at 1–4; an existing rubric that predates the column keeps a floor of 0 until an admin changes it, which is what makes the change silent for cycles already run.

**Each category carries one line of criteria per score value it offers**, per decision 114 — a 1–4 category collects four, one against each value. A name and a maximum are a scale, not a rubric: thirty reviewers scoring "Fit with Spark SC" out of 5 with no shared definition of a 4 produce exactly the divergence FR-10 then has to surface as high variance. A single blurb per category, which is what this requirement collected until decision 114, is that argument half-applied — it says what the category asks for and leaves the boundary between a 2 and a 3 to each reviewer privately, and the boundaries are where the disagreement lives.

Each criterion is individually optional, because an admin mid-setup should not be blocked and a cycle that genuinely briefs its reviewers elsewhere is entitled to leave them empty. An absent criterion renders the bare value. FR-9 puts them beside the score input.

**The builder caps how wide a scale may be while carrying criteria.** One line per value stops being a rubric somewhere well before a hundred of them, and a category that wide is almost always a typo. `maxPoints`' own ceiling is not lowered to match: doing so would retroactively invalidate an instance that has already run, which is decision 40's whole argument for making the scale data rather than a rule.

The criteria are part of the rubric and are therefore covered by the same lock. That is deliberate but not free: a typo cannot be corrected once grading has started without discarding every score. Accepted for v1 rather than building a second write path that bypasses the lock, on the grounds that the lock only engages after the first score is submitted and the rubric is written before reviewers are let in. If this bites in practice, the fix is a prose-only edit action, since criteria orphan no `Score` row — not a weakening of the lock itself.

**FR-5 Instance save.** Admin sets an instance name and password. Password is hashed (argon2id or bcrypt, cost ≥ 12). Never stored or logged in plaintext. Never recoverable; recovery means an admin with app-level access resets it.

Name and password are collected when the instance is created, at the start of the FR-2 import, because §5 makes `passwordHash` non-null and §8 forbids an ungated instance existing even as a draft. What FR-5 governs is therefore unlock and rotation, not creation.

**Creation also collects the cycle's current semester** — Spring or Fall, and a year — per decision 119. Both are required, neither is preselected, and the pair is immutable once written: class standing counts from it for the whole cycle, and a mis-set semester is corrected only by deleting the instance. An instance created before decision 119 has none, and its settings page offers a set-once control until one is chosen.

**Which gate protects which action:**

| Action | Gate |
|---|---|
| Open an instance and work in it | Instance password |
| Reset or rotate an instance password | App-level password only |
| Delete an instance | App-level password only, plus typing the instance name |

Putting reset behind the instance password would mean the recovery path named above does not exist. Putting deletion there too would complete the trap: an admin who typos a password at creation could not open the instance, reset it, or remove it, leaving a permanently unreachable row holding real applicant data.

The consequence is worth stating plainly rather than leaving to be discovered: **the instance password is not a boundary against anyone holding the app-level password.** It scopes routine access between cycles. §8's app-level gate is the actual admin boundary.

### 7.2 Written round

**FR-6 Reviewer roster.** Admin adds reviewers by first and last name with a Sparklet checkbox. Bulk paste from a newline-separated list is supported, since the current process starts from a Slack message.

**Reviewers are added to the written round only, and later rounds are staffed from it**, per decision 115. Holding `FIRST_ROUND` requires already holding `WRITTEN`; holding `SECOND_ROUND` requires already holding both. The add-by-name form and the paste box therefore appear on the written round's tab and nowhere else, and the roster grid's per-round checkbox is the only way into a later round. A reviewer who never read the written applications would otherwise be deliberating in the second round without the evidence the earlier rounds produced, which is not what FR-16 describes that round as. It also closes the last route by which a name typed into a later round's box creates a second `Reviewer` row for one human — the paragraph below closes that for the paste box, and this closes it for the form.

Participation means membership of the earlier round's roster, not evidence of submitted work. Decision 115 records why, and records the one hole it leaves open: withdrawing someone from the written round while they hold a later one is still permitted and breaks the rule from behind.

Paste parsing: blank and whitespace-only lines are dropped silently. A line is split on its last space, everything before becoming the first name and everything after the last. A line with no space cannot be split and lands in a confirmation queue rather than importing with a blank last name. Two lines producing the same first and last name are not an error, since two reviewers may share a name, but both are flagged for the admin to confirm before commit. All pasted reviewers arrive as non-Sparklets and as members of the round being staffed; the Sparklet flag and any additional rounds are set afterward in the roster grid, so one paste box stays one paste box. That constraint is about keeping the paste box a paste box — the manual-add form in the first sentence has its own Sparklet checkbox and is not covered by it.

**A pasted name is also compared against every reviewer already on the instance, not only against the rest of the paste** (open decision 22). `Reviewer` is one row per person carrying a `rounds` array, so someone already serving another round is the same person; comparing only within the round would create a second row for one human, which is the name-keying defect this system exists to remove. An instance-level match offers two resolutions — add this round to the existing reviewer, or create a second reviewer because two people share a name — and neither is a default.

Names are compared trimmed, whitespace-collapsed and case-folded, but on the two halves separately, so ("Ann Marie", "Smith") and ("Ann", "Marie Smith") are different people. Multi-word surnames are not rejected anywhere; "de la Cruz" is a name.

Reviewer names are editable after entry, since a typo in a pasted name otherwise has no remedy but deletion and re-entry. Renaming touches nothing else: not round membership, not the Sparklet flag, and not any assignment, because every score, vote and assignment references `reviewerId`.

**Removing a reviewer, or withdrawing them from a round, is blocked while they hold submitted work** (open decision 24). `Assignment` cascades from `Reviewer`, and `Score` and `ReviewNote` cascade from `Assignment`, so a removal silently destroys reviewer work with no undo. Where any of the affected assignments carries a score or a note, the removal is refused and names the way out — unassign them from those applicants, or regenerate. Where none does, the confirmation states how many assignments will be deleted and that those slots return to the pool.

**FR-7 Auto-assignment.** Generate assignments subject to:

- At most 1 Sparklet per applicant
- `reviewer_count` throughout means **the roster of the round being assigned**, not every reviewer on the instance. A reviewer serving only the second round is not capacity for the written one.
- Every applicant gets 3 reviewers, except those short one slot to the pool, who get 2. Where the roster is smaller than the target, the target is min(3, reviewer_count) and the pool rule applies against that reduced target: with 2 reviewers no applicant can receive 3 distinct ones. The invariant that holds at every roster size is that **no applicant is short more than one slot below the target, and no applicant is ever left with zero**. "Never fewer than 2" is that rule at a target of 3, and only there — at 2 reviewers each applicant correctly ends with 1.
- **The pool is 0 when the target is below 2** (open decision 20). On a one-reviewer roster the formula below would withhold whole applicants, which is the model §10.1 rejected; and there is no conflict-of-interest buffer to be had from a single reviewer, so there is nothing to hold back.
- Reviewer load as even as possible: no reviewer exceeds ceil(total_slots / reviewer_count), where total_slots = applicant_count × target and target = min(3, reviewer_count) — the full grid at the applicable target, not the reduced count after the pool is withheld. At 150 applicants and 30 reviewers that is `ceil(450 / 30) = 15`. Using the full grid keeps the bound stable as returns add slots back to the pool mid-round.

  **The bound is two-sided.** No reviewer falls below `floor(assigned_slots / reviewer_count)` either. At 150 applicants and 30 reviewers that is a floor of 14 against a ceiling of 15, so every reviewer carries 14 or 15. A ceiling alone is not evenness: 28 reviewers at 15 and two at 4 and 0 also sums to 428 and also satisfies it.

  In plain terms: **nobody is left light while someone else is carrying two more than they are, unless moving one of that person's applicants across would put two Sparklets on it.** That is the whole rule, and the paragraph below is only its precise form.

  Precisely, for a reviewer `r` below the floor there must exist no applicant `a` and reviewer `s` such that `s` is assigned to `a`, `s` carries at least two more assignments than `r`, `r` is not already assigned to `a`, and replacing `s` with `r` on `a` would not leave `a` carrying two Sparklets. If such a triple exists, the load could have been evened out and was not, and the floor is violated. If none exists, the one-Sparklet-per-applicant rule is what stopped it, and `r` is exempt. The exemption is a property of the assignment, not of the reviewer, and being a Sparklet does not confer it. `s`'s assignment to `a` must be a generated one: MANUAL and CLAIMED_FROM_POOL rows are immovable per FR-8, so a reviewer whose only route up runs through a preserved row is exempt on the same terms as the Sparklet case, while the floor itself is still measured over everything a reviewer carries. A swap never creates a RETURNED_TO_POOL pair, for decision 23's reason. See decision 98.

  **Both bounds are checked when a plan is generated, and only then.** The ceiling is stated over `total_slots` so that it stays stable as returns add slots back to the pool mid-round. The floor is over `assigned_slots`, which *shrinks* every time a reviewer returns a slot, so it is not a property the assignment goes on having — a reviewer sitting at 13 in week two has returned a slot, not violated a rule, and nothing re-evaluates the floor until the next generation.

  At 150 applicants, 30 reviewers and 8 Sparklets no reviewer is below the floor at all: `428 = 30 × 14 + 8`, and 8 Sparklets need at most 120 of the 150 available Sparklet slots, so the split into 8 reviewers at 15 and 22 at 14 is reachable. The exemption is never consulted and the floor binds on all 30. It is reached where the rule has genuinely run out of room — 15 Sparklets over 150 applicants, every applicant already carrying one — where Sparklets stop at 10 while non-Sparklets carry 18 or 19.
- Pool size is exactly `min(max(floor(0.05 × total_slots), 3), applicant_count)` — the floor first, then the minimum of 3, then the cap, which wins over both. At 150 applicants: `floor(22.5) = 22` slots across 22 distinct applicants. **Floor, not round**: 22, never 23. At 10 applicants: `floor(1.5) = 1`, raised to 3. At 2 applicants: raised to 3, then capped back to 2. On a regeneration with preserved rows, the pool is that number or the count of applicants the preserved rows still leave shortable, whichever is smaller, and the report counts what was actually pooled (decision 99).
- Each pooled slot comes off a *different* applicant, so an affected applicant is short exactly one reviewer. This is why the pool cannot exceed `applicant_count`: with 2 applicants, a 3-slot minimum would force someone short two, which defeats the purpose. On instances that small the pool is 2 slots, or fewer.

**Feasibility constraint.** With at most 1 Sparklet per applicant, non-Sparklets must fill at least 2 of every 3-slot applicant and at least 1 of every 2-slot applicant. At 150 applicants with a 22-slot pool that is `2 × 128 + 1 × 22 = 278` of 428 assignable slots, or 64.9% — so the "Sparklets ≤ one third of the roster" rule of thumb is deliberately conservative. **The precheck computes against actual assignable slots, not the one-third shortcut.**

When the check fails, the system must not silently violate a constraint. It tells the admin plainly: "You have 14 Sparklets among 30 reviewers. Even distribution is not possible under the one-Sparklet-per-applicant rule. Options: add non-Sparklet reviewers, or allow Sparklet load to be lighter than average."

**Per open decision 2, the second option is offered as an action, not just as prose.** Choosing it generates under a relaxed load rule: the one-Sparklet-per-applicant constraint is never broken, Sparklets take whatever the constraint allows, and non-Sparklets absorb the remainder bounded by `ceil(non_sparklet_slots / non_sparklet_count)`. In the example above that is 16 non-Sparklets carrying ≥278 slots, about 17.4 each, against the 15 that the unrelaxed rule would give. The admin sees both numbers before confirming. The one-Sparklet rule is never the thing that gives. Sparklets stay under the ordinary ceiling; the one-per-applicant rule is what is meant to bound them, and in practice it binds first (decision 98).

**Generation reports what it could not place** (decision 99). The precheck is capacity arithmetic and does not see returned pairs or the fill order, so a plan can pass it and still leave an applicant below target minus one, or at zero. Such a plan is placed, and it names those applicants and the count; the shortfall is the admin's to fix through FR-8, and the page says so for as long as it stands.

**FR-8 Manual assignment override.** Admin can assign, unassign, swap, or return to pool any reviewer on any applicant. Overrides are marked origin: MANUAL so a later regeneration does not clobber them without warning.

**Unassign and return-to-pool are different verbs and both exist deliberately**, per decision 117. Unassign *deletes* the assignment, so a later generation is free to re-pair that reviewer with that applicant — correct for a pairing that should never have existed, and it destroys any scores on it. Return-to-pool writes the same `RETURNED_TO_POOL` row FR-9's reviewer-facing control writes, with `returnReason = OTHER` and a required note: the slot goes back to the pool for anyone to claim, the scores already written are preserved, and decision 23's exclusion means generation will never re-create that pair. That is what a non-responsive reviewer calls for, and it is why the admin has both rather than one. The admin's return is audited under §8, where the reviewer's own is not, because it is an admin override.
A regeneration that preserves manual overrides treats them as consumed capacity rather than as exclusions. A preserved MANUAL assignment counts against its reviewer's load ceiling and against the one-Sparklet-per-applicant rule when the algorithm fills the remaining slots, and the applicant it belongs to still participates in the rest of generation for its unfilled slots. Excluding the applicant wholesale would let manual overrides quietly degrade load evenness. Where the preserved set already exceeds a ceiling or already puts two Sparklets on one applicant, generation reports the violation and does not correct it by removing a manual assignment.

**`CLAIMED_FROM_POOL` is preserved on the same footing as `MANUAL`** (open decision 21). Both are deliberate rather than generated, and a claimed slot may already carry a score. This paragraph named only MANUAL because claiming did not exist when it was written. The regeneration warning names the two counts separately, so an admin discarding manual overrides is not silently discarding claimed work as well.

**A `RETURNED_TO_POOL` row is an exclusion, not consumed capacity** (open decision 23). It records that a reviewer recused from that applicant, so generation must never re-create that pair — but it occupies no slot and counts against nobody's load. It is a third input to generation, distinct from both preserved and generated rows.

**FR-9 Reviewer dashboard, written.** Reviewer selects Round → Written, then their name from a dropdown. They see:

- Their assigned applicants as a list with completion state (0/4 scored, 4/4 scored)
- An applicant detail view: anonymous label (e.g. "Applicant 47"), every reviewer-visible field, rubric always visible alongside. No name, per §6. Class standing appears directly under the graduation date whenever that column is reviewer-visible, per decision 119.
- Score inputs per rubric category, with each value's criterion beside it per decision 114, plus a free-text note
- A **suspected AI use** checkbox, per decision 116. One reviewer's read of one application, stored on the assignment, admin-only under §6 — the reviewer sees their own and nobody else's. Nothing detects anything; this is the `AI Detected?` column the club already fills in by hand.
- Autosave on every change. A dropped connection mid-review must not lose work.
- "Return to pool" on any applicant, with a required reason (conflict of interest / other)
- "Claim from pool," showing open assignment slots on applicants who are short a reviewer

**How a reviewer gets here, since the six bullets above assume it and no requirement stated it.** Reviewers do not pass the §8 app-level gate and never see the instance list. They arrive on a per-instance link shared in the club Slack, pick the round, pick their name, and enter that round's access code — one screen, one submit, per decision 30. Verifying the code starts a reviewer session held in its own signed cookie, separate from the admin session so that neither confers the other, and carrying the instance, the round, and the reviewer id. Every reviewer page and every reviewer action re-checks it; an assignment id in a URL is an untrusted reference until it has been confirmed to belong to the session's reviewer. The code itself is set by an admin, per decision 31.

**FR-10 Written results dashboard.** Applicants ranked by average score descending, then by variance ascending. Each row shows: rank, name, average, variance, review count (2/3, 3/3), any suspected-AI flags raised on it, and demographic fields inline. Filters for "high variance" and "incomplete." Admin can open any applicant to read the full profile and all three reviewers' scores and notes. The profile carries class standing under the graduation date, per decision 119.

**Suspected AI use appears as a count on the row and per reviewer on the profile**, per decision 116. A count because the flag is one reviewer's judgment and three reviewers disagreeing is the thing an admin wants to see; naming the reviewer belongs on the profile, beside the score and note that reviewer also gave. It is not a filter and not a sort key — it is a reason to open the application and read it again, not a rank.

Variance is population variance (divide by review count, not review count minus one) across each reviewer's own category average — these three or two numbers are the entire set being measured, not a sample standing in for a larger one, so no bias correction applies. An applicant with fewer than 3 reviews still gets a computed average and variance over what exists; the review-count cell itself carries a visual marker (not row-level) when under 3/3, so "trust this number less" reads on the number and not on the applicant as a whole.

The "high variance" filter's threshold is admin-set at view time — a numeric input, off by default — rather than a fixed or persisted value. Variance itself is always shown for every applicant regardless of filter state, since E-board reviews high-variance cases by eye and the filter is a convenience for finding them, not the only way to see the number.

Two applicants tied on both stated keys are ordered by `sourceRowIndex` ascending, per decision 42. "Review count" counts **completed** reviews — every live rubric category scored — which is the sense decision 1 already uses when it requires this dashboard warn on applicants with fewer than three of them.

**FR-11 Selection.** Admin checkboxes select applicants to advance. A live panel shows the demographic breakdown of the current selection against the applicant pool, so composition is visible during selection rather than audited after. Finalizing writes `Decision` records and populates the First Round tab.

The confirmation before finalizing names any applicant with zero completed reviews, per decision 44 — rejecting someone nobody read is the failure decision 1's warning exists to prevent, and finalize is the last moment it can be prevented. Once the round is finalized this screen keeps its ranking, its filters and its per-applicant profiles and loses the checkboxes and the finalize control, since it is then a record of a decision rather than a surface for making one.

### 7.3 First round

**FR-12a Interview rubric builder.** Before FR-12's score sheet can be mapped, the instance needs configured `InterviewCategory` rows — the interview rubric is its own instrument per decision 6, not shared with `RubricCategory`. Admin enters number of categories and max points per category, on its own page at `/instances/[id]/interview-rubric`, modelled on FR-4's builder. Store as `InterviewCategory`. The rubric locks once any `InterviewCategoryScore` exists — a distinct lock condition from FR-4's, since the two rubrics are different instruments scored at different times.

FR-12 presupposed these rows and named no surface that creates them, which left the only screen that can produce a mappable score sheet as work no requirement asked for. See decision 54 for why it is its own page rather than a second section of FR-4's.

**FR-12 Score and notes import.** Two uploads with a defined contract:

*First Round Scores* — required columns: `Applicant Email` (or `Applicant Name` if email is unavailable), `Interviewer Name`, one column per configured `InterviewCategory`, and `Average`. Two rows per applicant expected, one per interviewer.

The category columns are matched to `InterviewCategory` rows by the same mapping table FR-2 uses for applicant columns, so a cycle that changes its interview rubric does not need a code change. `Average` imports verbatim into `InterviewResult.score`; the category columns become `InterviewCategoryScore` rows. The importer does **not** recompute the average or reject a row whose average disagrees with its categories — interviewers sometimes adjust it deliberately — but it does flag the disagreement in the preview so the admin sees it before commit.

*First Round Notes* — required columns: `Applicant Email` (or `Applicant Name`), `Notes`. One row per applicant.

Each sheet is staged, previewed, and committed on its own schedule, per decision 47 — scores and notes need not arrive together, and the dashboard renders whichever half exists. A sheet accepts repeated uploads; re-committing upserts on `(applicantId, interviewerName)` for scores and on `applicantId` for notes, rather than refusing a second file the way FR-3 refuses a second applicant CSV.

**FR-13 Name reconciliation.** The current `1R Notes` sheet keys on free-text applicant names typed by interviewers, which will not match cleanly. On import: exact email match first, then exact name match, then fuzzy name match above a similarity threshold presented for confirmation, then an unresolved queue the admin maps by hand. Nothing imports silently under a guessed match.

**Matching is scoped to applicants who reached first round** — `stageReached != WRITTEN` — not the full applicant pool. A fuzzy match against a written-round rejection is a wrong match this scoping removes for free, since nobody outside that set can legitimately appear in an interview sheet. See decision 45 for the normalization and the double-match case, decision 52 for the algorithm and threshold that supersede 45's, and decision 53 for why a single fuzzy candidate is still confirmed by hand.

> **Process recommendation:** add an email field to the interview scoring form. This eliminates the entire class of problem and costs one form field.

**FR-14 First-round reviewer dashboard.** Round → First Round, then name. Reviewer sees each applicant's average interview score per interviewer prominently, with the per-category scores collapsed by default and expandable, plus the interview notes. The category count follows the configured `InterviewCategory` rows — four in S26, but the layout must not assume that. **The reviewer also sees every reviewer-visible field, written responses included** — decision 108 removed the per-round distinction that hid them here, so this round reads the same application the written round did. Demographics remain hidden, per §6's lock. Class standing follows the graduation-date column, per decision 119. Reviewer votes YES or NO per applicant. No vote recorded means SKIP.

**The vote is cast from the applicant's page, not from the list**, per decision 113, matching the second round's pattern under decision 82. This reverses the reasoning this requirement was originally built on: the every-tap-counts rule was applied here on the premise that a first-round vote is a reaction to two numbers and a paragraph already on the row. It is not — the row shows a *summary of what exists* ("2 scores · notes") and links to the page that holds them, so a vote cast from the list was cast on a name. Decision 113 states why that reversal is being made now and why the rule itself is scoped rather than withdrawn.

**The list keeps the reviewer's own vote as a marker**, and the "voted on N of M" counter with it, per decision 62. Only their own: decision 74 forbids showing anyone else's, and a marker is not a control. This is a deliberate divergence from decision 82, which leaves the second round's list bare on its own separate reasoning. The list also carries a search box, since finding an applicant is what it is now for.

**FR-15 First-round results.** Applicants ranked by yes percentage descending, where `yes% = yes / (yes + no)`, skips excluded from both numerator and denominator. Show raw counts alongside the percentage; 2/2 and 14/14 are not the same signal. An applicant with zero non-skip votes carries no real percentage; the count cell — not the row — carries a visual marker the same way FR-10's under-3/3 marker works, per decision 46. Two applicants tied on yes percentage are ordered by raw non-skip vote count descending, then `sourceRowIndex` ascending, per decision 46.

Selection and demographic-breakdown behavior mirrors FR-11's UI. Finalize semantics, stated explicitly rather than left to the word "mirrors": for every applicant in the first-round pool (`status = ACTIVE`, `stageReached = FIRST_ROUND`), write one `Decision` row at `stage = FIRST_ROUND`. Selected: `outcome = ADVANCE`, `status` stays `ACTIVE`, `stageReached → SECOND_ROUND`. Not selected: `outcome = REJECT`, `status → REJECTED`, `stageReached` stays `FIRST_ROUND`. Finalizing moves `Instance.currentStage → SECOND_ROUND`, load-bearing for this screen's post-finalize read-only state exactly as decision 43 made it load-bearing for `/results`. The confirmation panel names any applicant with zero non-skip votes before finalizing, same reasoning as decision 44 — there is no fixed review-count target here to fall short of, so the flag is literal zero rather than "under some threshold."

### 7.4 Second round and passes

**FR-16 Second-round reviewer dashboard.** Round → Second Round, then name. Reviewer sees the complete applicant profile: every reviewer-visible field (with class standing under the graduation date when that column is one, per decision 119), written scores, written review notes, interview scores, interview notes. **Demographics are not in that list**, and neither is another reviewer's suspected-AI flag. Decision 108 locked demographics out of every reviewer round including this one, and decision 116 keeps the flag admin-only; the demographic breakdowns remain an admin surface, FR-11 and FR-19. Written and interview evaluations are attributed to the person who gave them, per decision 77. Reviewer can flag conflict of interest per applicant, which is sticky across all passes.

**Every applicant who reached the second round stays on this list for the life of the round**, per decision 112, whatever their status. A resolved applicant does not disappear: the row persists, the profile stays reachable, neither renders a vote control, and both show the outcome — green for Sparklet, red for rejected — per decision 111. `CARRIED` and `NEEDS_ADMIN` stay too, showing the same settled control with no colour, which is what decision 83a already described for `CARRIED` and is now simply the general rule.

**This reverses decisions 74, 83 and 83a in the parts that hid an outcome.** What survives is the part about votes: no reviewer sees another reviewer's vote or any tally, in any pass, open or closed, and FR-18 remains the only surface in the product that renders one. Decision 111 states the anchoring cost of showing the outcome — a terminal outcome is a unanimous tally, so green tells the last voter how everyone else voted — and records it as accepted deliberately rather than missed.

The list is a reading and recusal surface still: the vote control lives on the profile per decision 82, and a resolved applicant is readable but not votable, which the vote and conflict actions enforce independently of what the page renders.

**FR-17 Passes.** The admin creates sequential passes. This is the most intricate piece of the system, so the state machine is specified explicitly:

- A pass is created by an admin. Its membership is fixed at creation: every applicant with `status = ACTIVE`.
- Exactly one pass is OPEN at a time. A submitted vote lands in the currently open pass.
- A reviewer with an active COI on an applicant is counted as SKIP in that pass — computed from the conflict, never a stored vote, per decision 67 — and cannot vote on that applicant.
- A vote requires an explicit submit action. Selecting yes/no without submitting records nothing.
- An applicant is **resolved** within a pass when every non-SKIP reviewer has submitted:
  - All YES → `PassApplicant.resolution = SPARKLET`, `Applicant.status = SPARKLET`, excluded from future passes
  - All NO → `resolution = REJECTED`, `status = REJECTED`, excluded from future passes
  - Mixed → `resolution = CARRIED`, stays ACTIVE, carries into the next pass
- An admin can manually reject any applicant within a pass, excluding them from future passes.
- An admin can reverse a manual reject while that pass is still open, per decision 107. The applicant returns to ACTIVE with their row cleared to `NULL`; a rejection decided by a unanimous vote, or anything in a closed pass, cannot be reversed.
- Closing a pass without full votes leaves unvoted applicants ACTIVE and carried forward. Their row on that pass stays `resolution = NULL` — the close itself writes nothing, per decision 72.
- A vote can be changed until that applicant resolves, per decision 75. Resolution closes the window on its own, since it requires every eligible reviewer to have submitted.

**`PassApplicant.resolution` records what happened to an applicant *in that pass*. It does not control membership in the next one.** Membership is recomputed at each pass creation from `Applicant.status`, so an applicant can carry a terminal-looking `NEEDS_ADMIN` on pass 1 and still appear in pass 2. These are separate questions and the schema keeps them separate deliberately.

**Closing the second round.** Passes do not end on their own — an admin ends them with an explicit "Close second round" action, which is what moves `Instance.currentStage` to `COMPLETE`. That action writes `resolution = NEEDS_ADMIN` onto the final pass's rows for every applicant still unresolved — `NULL` or `CARRIED`, per decision 73 — and is the *only* thing that produces FR-19's Unresolved group. It also closes the final pass if it is still open, so a `COMPLETE` instance cannot hold an `OPEN` one. Three properties it must have:

- **Idempotent.** Running it twice writes the same rows and changes nothing the second time.
- **Blocked when no pass exists.** An admin who reaches the second round, creates no pass, and closes the round would otherwise leave every applicant unresolved with no `PassApplicant` row to find them by, and FR-19 would render an empty Unresolved group over a live pool. Tell the admin to create a pass first.
- **Audited**, per §8, alongside the other admin overrides.

Note that `Applicant.status` stays `ACTIVE` for these applicants — there is no `UNRESOLVED` status, because an applicant's fate at the end of the round is already recorded on their final pass row and a second copy could disagree with the first. **FR-19 and FR-20 therefore identify unresolved applicants by that row, never by `status`.** A successor reading `ACTIVE` in a `COMPLETE` instance is looking at the wrong column.

**Edge cases that must be handled explicitly, not left to inference:**

| Case | Required behavior |
|---|---|
| All reviewers have COI on an applicant | Cannot resolve. `resolution = NEEDS_ADMIN` on that pass. Do not treat as unanimous. The applicant stays ACTIVE and **carries into the next pass** — `NEEDS_ADMIN` describes the pass, not the applicant. Recovery is an admin lifting a conflict on FR-18's grid while a pass is open (decision 76), or the admin decision FR-19 requires once the round closes (decision 89). The roster cannot be changed after pass 1 (decision 84), so "add a reviewer without a conflict" is not a route. |
| Pass created with zero ACTIVE applicants | Block creation, tell the admin the pool is resolved. |
| Pass created with zero reviewers on the second-round roster | Block creation, per decision 79. Every member would resolve `NEEDS_ADMIN` at creation — a pass that decides nothing and flags everyone. |
| A reviewer is added or withdrawn mid-round | Cannot happen. Decision 84 fixes the second-round roster, adds and removals alike, from the moment the first pass is created — decisions 66 and 78 as amended. This replaces the earlier "they vote only in passes created after they are added", which described a situation the roster page no longer permits. |
| Admin reopens a closed pass | Not supported in v1. A manual reject in the still-open pass can be reversed (decision 107); nothing in a closed pass can be changed. |
| Passes end with an applicant still unresolved | The "Close second round" action writes `resolution = NEEDS_ADMIN` on their final pass row. They are neither SPARKLET nor REJECTED, and FR-19 lists them under Unresolved rather than defaulting them either way. |
| Second round closed with no pass ever created | Block the close. See "Closing the second round" above. |

**FR-17 clause index.** Code comments, tests and `plans/phase-6.md` cite FR-17 by these identifiers. They were assigned in the Phase 6 clause ledger and are reproduced here so a reader holding only this document can resolve them. The letters split FR-17's bullets into the clauses that were ticked separately; 17p–17u are the "Closing the second round" paragraph, 17v–17y are rows of the table above, and 17z is the resolved decision-3 paragraph below.

| # | Clause |
|---|---|
| 17a | "A pass is created by an admin" |
| 17b | "membership is fixed at creation: every applicant with `status = ACTIVE`" |
| 17c | "Exactly one pass is OPEN at a time" |
| 17d | "A submitted vote lands in the currently open pass" |
| 17e | "A reviewer with an active COI … counted as SKIP" (computed per decision 67) |
| 17f | "and cannot vote on that applicant" |
| 17g | "A vote requires an explicit submit action" |
| 17h | "resolved … when every non-SKIP reviewer has submitted" |
| 17i | "All YES → `resolution = SPARKLET`, `status = SPARKLET`, excluded from future passes" |
| 17j | "All NO → `REJECTED` … excluded" |
| 17k | "Mixed → `CARRIED`, stays ACTIVE, carries into the next pass" |
| 17l | "An admin can manually reject any applicant within a pass" |
| 17m | "excluding them from future passes" |
| 17n | "Closing a pass without full votes leaves unvoted applicants ACTIVE and carried forward" |
| 17o | "`PassApplicant.resolution` … does not control membership in the next one" |
| 17p | "Close second round … moves `currentStage` to `COMPLETE`" |
| 17q | "writes `NEEDS_ADMIN` onto the final pass's rows for every applicant still unresolved" |
| 17r | "Idempotent" |
| 17s | "Blocked when no pass exists" |
| 17t | "Audited, per §8" |
| 17u | "`Applicant.status` stays ACTIVE for these applicants" |
| 17v | Table: all-COI → `NEEDS_ADMIN`, stays ACTIVE, carries into the next pass |
| 17w | Table: zero ACTIVE applicants → block creation |
| 17x | Table: reviewer added mid-round → cannot happen (decision 84) |
| 17y | Table: admin reopens a closed pass → not supported |
| 17z | "counts are never revealed to reviewers" (decision 74; **still true of counts, no longer true of outcomes — decisions 111 and 112**) |
| 17aa | "An admin can reverse a manual reject while that pass is still open" (decision 107) |

**Live vote visibility (decision 3, resolved):** should reviewers see live vote counts during an open pass? No, to prevent anchoring, counts are never revealed to reviewers. Reviewers should not have knowledge of other reviewers' votes. Decision 74 extends that to a *closed* pass as well and amends §6's matrix accordingly: FR-18's admin-only grid is the only surface in the product that renders a pass vote.

**That still holds for votes and tallies, and no longer holds for outcomes**, per decisions 111 and 112. A second-round reviewer now sees that a resolved applicant became a Sparklet or was rejected, on the list and on the profile. The two facts are not independent — an applicant resolves only when every eligible reviewer has submitted, so the outcome is a unanimous tally in a smaller package, and decision 111 says so and accepts the anchoring cost explicitly rather than treating the outcome as a different kind of information. What is not derivable from an outcome, and stays hidden, is who voted which way in a pass that did *not* resolve, and every count anywhere.

**FR-16's conflict flag is one-way for the reviewer and removable by an admin**, per decision 76. Flagging deletes any vote that reviewer had already cast in the open pass (decision 68) and that vote does not come back; an admin removing the flag returns the reviewer to the denominator as outstanding. The control lives on FR-18's grid, on the `skip` cell that shows the conflict, and is audited.

**FR-18 Pass dashboard.** Per pass: a reviewer-by-applicant grid showing blank / yes / no / skip, with per-applicant totals and resolution state. This is the direct replacement for the `2RD Vote` sheet, generated instead of hand-maintained. This is only accessible by admin. It carries the second round's two admin controls on an applicant — the manual reject (17l) and its reversal while the pass is open (17aa, decision 107) — and the conflict-removal control of decision 76.

### 7.5 Final and export

**FR-19 Final dashboard.** All second-round applicants sorted into New Sparklet, Rejected, and Unresolved, with full profiles accessible.

**Unresolved** is every applicant whose row in the final pass carries `resolution = NEEDS_ADMIN` — which covers both an applicant every reviewer recused from and one who simply never reached a unanimous result before the round closed. Both require an explicit admin decision and must not be silently dropped. The group is identified by that pass row, never by `Applicant.status`, which stays `ACTIVE`; see FR-17. The underlying votes remain visible, so an admin can tell the two situations apart — eleven skips reads very differently from 7–4.

**The admin decision each of them requires is made here**, on this screen and nowhere else — decision 70 says a `Decision` row is written "whenever an admin actually resolves that applicant" and names no surface for it. Admit or reject, writing `Decision` at `stage = SECOND_ROUND` with `actor = ADMIN`, `Applicant.status`, and an audit row, in one transaction.

**An applicant resolved that way leaves the group without their pass row being rewritten**, per decision 89. The predicate is `resolution = NEEDS_ADMIN` on the final pass **and no `Decision` row at `stage = SECOND_ROUND`**. `PassApplicant.resolution` is left alone: the record that the pass itself could not decide them is not destroyed by the decision that followed it.

Demographic breakdown of the Sparklet class against each preceding stage, replacing the manual `Overall Stats` sheet.

**FR-20 Export.** One-click export of the entire instance as JSON, plus per-stage CSVs (all applicants with scores, decisions by stage, final class with emails). Non-negotiable for succession: the club must never be locked into this tool.

**What "the entire instance" has to mean is fixed by the round trip**, which is BUILD_PLAN's Phase 7 gate and the only real test of this requirement: export, delete the database, restore from that file alone, and compare field by field. Four properties follow from it, each carrying its own decision.

- **Every id is written back verbatim** rather than regenerated (decision 88). Three carriers of id make any remap unsound: `Applicant.data` is keyed by `Field.id`, `InterviewImport.mapping` embeds `InterviewCategory` ids inside its role strings, and `AuditLog.entityId` and `previousValue` hold ids from every table with no foreign key to follow.
- **Every column is emitted, nulls included and explicit.** A missing key on restore is an error, never a default — which is what keeps `PassApplicant.resolution` five-valued, so `NEEDS_ADMIN`, `CARRIED` and `NULL` cannot collapse into one another.
- **The file carries `Instance.passwordHash` and `RoundAccessCode.codeHash`** (decision 86), so a restored instance can be opened. The export is therefore credential-bearing as well as applicant-data-bearing, and the route is admin-only.
- **The reimport is a verification script, not an admin surface** (decision 87), and the per-stage CSVs sit outside the round trip as lossy derivatives, written verbatim with no formula-injection prefixing (decision 90).

## 8. Security and data handling

The applicant data is sensitive. The S26 file contains real names, USC emails, essays about family trauma and immigration status, self-reported ethnicity, and first-generation status.

- **Admin access:** app-level password gate on the instance list, plus a per-instance password. The instance list itself must not be publicly enumerable.
- **Reviewer access:** a per-round access code shared in the club Slack, plus name selection. A name dropdown alone would let anyone with the link vote as anyone. The code keeps friction at one extra field while closing that hole.
- **Passwords:** hashed with argon2id or bcrypt. Never logged, never emailed, never displayed.
- **Transport:** HTTPS only, enforced.
- **Repository:** real applicant data never enters the repo. `.gitignore` covers `*.csv`, `*.xlsx`, `/data`, `/uploads`. Development uses synthetic seed data.
- **Retention: the platform keeps every cycle in full, indefinitely.** There is no scheduled or threshold-driven deletion of applicant data, and FR-5's manual instance deletion is the only way to remove a cycle — admin-triggered, one instance at a time, gated on the app-level password plus typing the instance name. This reverses an earlier requirement for an "archive and purge"; the reasoning is in decision 109, and it is the club's own retention practice rather than a limitation.
- **Audit:** log admin overrides (manual assignment, manual rejection, and the reversal of a manual rejection — the only decision reversal in v1, see decisions 106 and 107) with actor, timestamp, and previous value.
- **Instance deletion is audited, and its audit row outlives the instance.** Deleting an instance runs in one transaction: purge that instance's existing `AuditLog` rows, since they describe entities about to stop existing and their `previousValue` payloads can carry applicant data that retention says should not survive the cycle; write the deletion record with the instance's name, applicant count, and stage, and no applicant data; then delete the instance, which `ON DELETE SET NULL` leaves the record orphaned by design. What remains is exactly one row per deleted instance. **Nothing ages these out.** Archive-and-purge was the only thing that ever did, and decision 109 removes it; these rows and decision 92's app-level lockout rows now accumulate for the life of the deployment. Accepted at this scale and stated here rather than left to be discovered — see decision 109.

## 9. Success metrics

| Metric | Current (S26) | Target |
|---|---|---|
| Admin hours per cycle on spreadsheet maintenance | Estimate before you build; you have the data: ~15+ hours including training the operator | −60% |
| Applicant records orphaned by name mismatch | Nonzero, unmeasured | 0 |
| Time from written round close to first-round list published | Estimate: ~3 hours | < 1 hour |
| New admin able to run a cycle from docs alone | No, training time 2-4 hours | Yes, validated by a dry run with a board member, training time < 1 hour  |

## 10. Open decisions

These need answers before or during the relevant build phase. They are the places where an unstated assumption would produce the wrong system.

1. **Unassigned pool definition. RESOLVED: 5% of assignment slots.** ~22 slots of 450 left open, spread across ~22 distinct applicants who each start with 2 of 3 reviewers rather than concentrating the gap on a few applicants with zero. The pool exists as a conflict-of-interest buffer: a reviewer who recuses returns their slot to the pool, and any reviewer can claim an open slot. Chosen over holding whole applicants unassigned because a pooled applicant under that model needs three separate claims to be reviewed at all, and if the pool moves slowly they receive zero reviews. Under this model a slow-moving pool costs an applicant one opinion, not all three. Consequence: returns add slots to the pool over the course of the round, so FR-10 must warn on total applicants with fewer than 3 completed reviews, not just the initial 22.
2. **Sparklet-heavy roster handling. RESOLVED: uneven Sparklet load.** Offered as an action on the feasibility failure, per FR-7's relaxed rule; the one-Sparklet-per-applicant rule is never relaxed.
3. **Live vote visibility in passes.** RESOLVED: See FR-17.
4. **Blind written review. RESOLVED: Written reviewers should not see applicant names.** Should written reviewers see applicant names at all? Hiding them is a small change now and a much larger one later.
5. **Multiple concurrent admins. RESOLVED: Based on v1 recommendation** Two admins editing assignments simultaneously. v1 recommendation: last-write-wins with a visible "changed by X at Y" indicator rather than locking. **Amended by decision 104: the indicator never shipped, and last-write-wins alone is the v1 behaviour.**
6. **Interview score scale. RESOLVED.** The S26 `1R Scores` sheet carries **four category scores plus an average, per interviewer** — not the single score FR-12 originally assumed.

   *Display:* show the average prominently, with the category scores available but collapsed by default, for both interviewers. Ten numbers on a phone screen works against FR-14's friction goal if all are shown at once.

   *Model:* §5 now carries `InterviewCategory` and `InterviewCategoryScore`. The interview rubric is **instance-scoped and admin-configured, not four fixed columns and not shared with `RubricCategory`** — the written and interview rubrics are different instruments, and goal 5 requires both be reconfigurable between cycles. `InterviewResult.score` is the average **as imported**, never recomputed from the category rows; see FR-12 for how a disagreement between the two is surfaced. Shipped in Phase 5; decisions 47–65 record what the build found.
7. **Multi-select demographic counting. RESOLVED: fractional counting.** An applicant checking both "East Asian" and "White" needs a defined counting rule for the demographic breakdowns in FR-11 and FR-19. The current spreadsheet concatenates the values into a single string ("South AsianIndian"), which is not countable.

   An applicant checking *n* categories contributes `1/n` to each: two boxes gives 0.5 each, three gives 0.33 each.

   **The display is `weighted / poolSize (headcount)`**, per decision 118 — "East Asian: 12.5/150 (18)", a weighted 12.5 of a 150-applicant pool, checked by 18 people. The counting rule is unchanged and this is only how it is shown: the earlier wording here said one decimal place alongside a raw headcount, which printed a fractional number of people with no scale beside it and needed a paragraph underneath to explain the arithmetic. Stating the denominator the weighted column already sums to is what makes it a proportion instead. A single-select column, where `n` is always 1 and weighted equals headcount, drops the parenthesised count and reads "Yes: 33/150" — the same rule where two of its three numbers coincide, not a special case. See decision 118, and note that FR-19's funnel renders the same three numbers as a percentage and is deliberately left as it is.

   **Applicants who check nothing go in a "Not specified" bucket**, counted as a whole person there. `1/n` is undefined at `n = 0`, and without the bucket those applicants vanish from the breakdown entirely and the weighted column silently sums to the responder count rather than the headcount. With it, the invariant holds as stated: **weighted totals sum to the headcount.** Note that an applicant who checks no box but writes into the free-text `Specify your ethnicity…` column has given a real answer that the count cannot read; they belong in "Not specified" too, and the free-text values are worth showing beneath the breakdown rather than discarding.

   **What counts as checked (see also decision 12 on how a group comes to exist at all):** the one-hot columns store the column's own label when checked and an empty string when not, which is what the form exports actually emit. Checked means a non-empty value; empty string, `null`, and an absent key are all unchecked. This predicate belongs in one shared helper, not re-derived per surface. The free-text Specify your ethnicity… column is a member of the group with groupRole = FREE_TEXT. It is excluded from the checked predicate and from 1/n, and it is what FR-19 displays beneath the breakdown. Being a member is what lets FR-19 find it; being FREE_TEXT is what keeps it out of the count. Inclusion is set on the group and applies to every member, so n is never counted over a partially excluded set.

   **Unchanged by decision 108, and the reason the `category` enum survives it.** 108 took visibility away from `category` but not classification: `lib/demographics.ts` still selects the columns this counting runs over by `category === DEMOGRAPHIC`, and FR-19 still finds the write-in through group membership. A demographic column being invisible to every reviewer does not make it uncounted — §6 governs who may read a live applicant, this decision governs what the club counts about the cohort, and FR-19's funnel on the results and final-class surfaces already relies on that separation.

8. **Import draft state. RESOLVED: a staging table.** Parsed rows land in `ImportRow` at upload and are deleted at commit; detected group proposals live in `Instance.importProposals` until named or dismissed, and are cleared at the same moment. A `CHECK` makes that clearing a database guarantee rather than a line of code. Rejected: a client-held payload, which exceeds Next's 1MB server-action body limit on a real 150-applicant export with five essays each; and a temp file, which does not survive a Vercel deploy.

9. **Instance created before the CSV commits. RESOLVED.** Name and password are collected at upload, because `passwordHash` is non-null and §8 forbids an ungated instance existing even as a draft. FR-5 therefore governs unlock and rotation, not creation. Consequence: FR-1 lists draft instances, marked as such.

10. **Email normalization. RESOLVED: trim, NFC, lowercase, and compare normalized.** See FR-3. The staging row keeps the verbatim value and the preview reports any change, so nothing is silent; the pre-normalization form is not retained after commit.

11. **`sourceRowIndex` from parse order. RESOLVED.** Assigned at parse, 1-based, never renumbered. Discarding a row at preview leaves a gap, which is correct: the label points at a record in the source file, and renumbering would break that correspondence for the one audience — written reviewers — who see nothing else.

12. **Group detection scope. RESOLVED.** Exact equality with the column's own header, runs of two or more, empty columns never grouped. Detection produces a proposal that the admin names or dismisses; it never writes a `FieldGroup` on its own. A form tool that exports `Y`/`TRUE`/`1` rather than the option label detects nothing and the admin groups by hand — the safe failure, since no detection costs a minute and a wrong silent detection costs a cycle.

13. **`FieldGroup.key` immutability. RESOLVED: assigned at creation, never re-slugged.** See §5. This is why detection defers materialization: a key stamped before anyone named the group would read `group-1` forever, in every export FR-20 produces.

14. **Auditing instance deletion. RESOLVED: the audit row outlives the instance.** See §8. Rejected alternative: declaring deletion unaudited in v1, which is only defensible if nothing is audited, and §8 already requires overrides be logged.

15. **What gates password reset and instance deletion. RESOLVED: the app-level password.** See FR-5.

16. **Admin identity behind the app gate. RESOLVED: Name prompt (first and last) at sign-in. Built in Phase 8; the schema half is decision 93.** §8 specifies one app-level password shared by 2–6 admins, so `AuditLog.actor` has no real identity behind it: every override, and now every password reset and instance deletion, is attributable to "an admin" and nothing finer. Acceptable among E-Board members who trust each other; not acceptable as the permanent answer for a log whose entire purpose is attribution. Options: per-admin accounts, or a name prompt at sign-in recorded on the session and copied into `actor` — weaker, but honest and cheap. Decision 104 records that decision 5's "changed by" indicator, which this identity would feed, has not been built.

    **One correction to "copied into `actor`", made when this was built.** It is copied into a *new* column, `actorName`, and `actor` keeps carrying the role. Decision 93 has the reasoning; the short form is that this schema has two columns named `actor`, only one of them is this one, and the other must never carry a name.

17. **Two fixture directories. RESOLVED: consolidated into `prisma/fixtures/` — done in Phase 8.** `fixtures/sample-headers.csv` sat at the repo root while `prisma/fixtures/` held the synthetic export and its README. Two directories for one purpose invites saving a file in the wrong one, and the wrong one may hold real applicant data. The `.gitignore` named both exempt files exactly rather than globbing a directory, so neither location was ever a hole — but the ignore rules were a guard against the duplication rather than an answer to it, and a guard has to be remembered each time someone adds a file.

    Phase 8 forced it: the phase adds a fourth committed fixture (decision 97's demo CSV), and adding a file to an arrangement already recorded as a hazard makes the hazard bigger. The move touches `prisma/seed/headers.ts`, which every seed path runs through, so it was taken as its own commit carrying no feature work — the shape this entry originally asked for.

    Consolidating also surfaced a documentation bug worth recording, because it is the exact failure the exact-naming rule exists to prevent: `prisma/fixtures/README.md` claimed `.gitignore` carried a `!prisma/fixtures/*.csv` exception. It never did, and deliberately does not — that glob would re-include any CSV dropped in the directory, a real export among them. The README had been describing the hole rather than the guard.

18. **Which categories the per-round visibility toggles apply to. RESOLVED: OTHER only.** §6 spells DEMOGRAPHIC and RESPONSE as flat Hidden/Visible and marks only OTHER "configurable, default hidden", but the schema carries the nullable override columns on every `Field` and `FieldGroup`, so the question of what happens to an override stored on a DEMOGRAPHIC row had no stated answer.

    Honouring it would create a route to showing ethnicity to written reviewers that no requirement asks for, against goal 3's premise that the bias controls are enforced by the system rather than by an admin remembering. So `lib/fields.ts` reads an override only where the resolved category is `OTHER`, and the FR-2 mapping table only offers the toggles there — an override on another category is unreachable through the UI and inert if it arrives some other way.

    The cost is that the columns are wider than their meaning: a DEMOGRAPHIC row can hold a value that nothing reads. Accepted rather than splitting the columns per category, which would complicate the resolver to prevent a state the UI cannot produce. If a future cycle genuinely needs one response hidden from written reviewers, that is a §6 change first.

    **Superseded by decision 108.** The question this entry answers — which categories the per-round toggles apply to — dissolves with the toggles themselves: there is one binary flag and no per-round distinction. Its *reasoning* is what survives. The hazard it was written to close, a route to showing ethnicity to a reviewer, is now closed by 108's DEMOGRAPHIC lock, which is enforced in the resolver rather than only omitted from the UI — the same "inert if it arrives some other way" property this entry gave the old override columns. The closing sentence above was also load-bearing and was honoured: 108 is a §6 change first.

19. **Rate limiting on the password endpoints. RESOLVED in Phase 8 — see decision 92.** A stopgap shipped in Phase 1 and this entry enumerated what it did not cover; decision 92 answers the first and last of those bullets with a Postgres-backed store and lockout logging. The middle three were correct as written and survive unchanged. The description below is of the Phase 1 stopgap and is kept because it is what the "what it does not cover" list is written against.

    `lib/rate-limit.ts` allows 10 failures per key in 15 minutes and then locks that key for 15 minutes, where a key is the scope plus the client IP. It is consulted before the argon2 verify, so a locked-out caller costs nothing to refuse and learns nothing.

    **What it does not cover, so Phase 8 does not mistake it for the answer:**

    - **State lives in the process.** It resets on every deploy, and on a serverless host each instance keeps its own map — an attacker whose requests land on different instances gets the full allowance from each. A shared store (the database, or Redis) is what makes the limit real.
    - **The key is the client IP,** read from `x-forwarded-for`. Anyone with a pool of addresses sidesteps it, and a request with no such header falls into one shared `unknown` bucket. That fallback is deliberate — stripping the header must not escape the limiter entirely — but it means several admins behind one NAT share an allowance.
    - **It does not extend a lock when a locked-out key keeps trying.** That is on purpose: a locked attempt is refused before any password check, so counting it slows nobody, while extending would let anything retrying in a loop hold the lock open against the real admin. The consequence is that the ceiling really is 40 guesses an hour per address, not less.
    - **It is not a substitute for a strong password.** It raises a brute-force attempt from free to slow. `npm run hash-secret` says so where the password is chosen.
    - **Nothing is logged.** A sustained attack is invisible. Phase 8's audit work should record lockouts.

20. **Pool and target on a roster too small for 3. RESOLVED: the pool is 0 when the target is below 2.** FR-7's pool formula is written against a target of 3 and says nothing about a one-reviewer roster, where `min(3, 1) = 1` and withholding any slot leaves an applicant with no reviewer at all — the model decision 1 rejected. There is also nothing to buffer: the pool exists so a recusing reviewer's slot can be claimed by someone else, and with one reviewer there is no someone else. At two reviewers the formula already behaves, capping at `applicant_count`.

21. **`CLAIMED_FROM_POOL` across a regeneration. RESOLVED: preserved alongside `MANUAL`.** FR-8 names only `MANUAL` because claiming did not exist when it was written, but both are deliberate rather than generated, and by the written round a claimed slot may already carry a score. Regeneration consumes both as capacity and clobbers neither, and its warning names the two counts separately so that discarding manual overrides does not silently discard claimed work too.

22. **Duplicate-name scope on a roster paste. RESOLVED: compared against the paste and against every reviewer on the instance.** FR-6 covered only the within-paste case, but the likelier accident is re-pasting the same Slack message. `Reviewer` is instance-scoped with a `rounds` array, so a match is the same person, and comparing per round would answer "is this a new person?" with "is this person already staffed here?" — producing two rows for one human. A match offers "add this round to them" or "create a second reviewer", with no default, since guessing either way is silently wrong: one merges two people, the other splits one. Comparison folds case and collapses whitespace but keeps the two name halves apart, so ("Ann Marie", "Smith") and ("Ann", "Marie Smith") stay distinct.

    **Decision 115 removes the other half of the problem.** It takes the add form and the paste box off the first- and second-round tabs entirely, so a later round is staffed from the earlier round's roster and there is no longer a box in which to retype a name that already exists.

23. **`RETURNED_TO_POOL` rows during a regeneration. RESOLVED: an exclusion, not consumed capacity.** The row is the record of a recusal. Generation must never re-pair that applicant and reviewer, and the row must not count against anyone's load — those are two different things, and treating it as either one alone gets the other wrong. Inert until Phase 3 builds return-to-pool, but the input shape had to be right before anything was written against it. **Decision 98 records that the floor repair violated this rule until the reconciliation pass**: the fill honoured it and the swap that followed did not.

24. **Removing a reviewer, or unchecking a round, with live assignments. RESOLVED: blocked while they hold submitted work.** `Assignment` cascades from `Reviewer` and `Score`/`ReviewNote` cascade from `Assignment`, so removal destroys reviewer work silently and with no undo. Refused where any affected assignment carries a score or a note, naming unassign-or-regenerate as the way out; otherwise the confirmation states the assignment count and that the slots return to the pool. Unchecking a round is the same rule scoped to that round, so the checkbox is not a cheap way around the block. No `Score` row can exist before Phase 3, so the refusal is unit-tested rather than demonstrated — the same posture FR-4's rubric lock already takes.

25. **How the roster's four name-entry paths stay consistent. RESOLVED: one shared gate.** A name reaches the database by four routes — a pasted line, the two free-text inputs the paste queue offers for a line it could not split, the manual-add form, and a rename in the grid — and only the first is a line at all. `lib/roster.ts` exports one `checkReviewerName` that all four call. It returns the values to store, which is what makes it impossible to validate one string and persist another; it normalizes without folding case, since folding belongs to the comparison key and a gate that lowercased would put the roster and FR-20's export of it in lower case; and it reports duplicate names rather than refusing them, because FR-6 allows two reviewers to share one.

26. **A save in flight when the reviewer navigates away. RESOLVED: settle within 1500 ms or hold, and never a silent loss.** FR-9 requires autosave and that a dropped connection not lose work, but says nothing about the reviewer who changes a score and immediately closes the tab or hits back. If the in-flight save settles fast enough the navigation is not blocked; past the threshold the app holds or warns until it resolves or fails. **Amended by decision 37** (the mirror is also cleared on sign-out and by a 7-day TTL) **and decision 38** (a return to pool clears that draft and does not hold for a save in flight).

    **The threshold is 1500 ms.** One upsert through a server action is 80–250 ms in practice; add a slow-4G round trip and a healthy save still settles under 600 ms, so 1500 ms is roughly 5× the realistic worst case and effectively never fires on a connection that is working. It sits below the ~2 s at which a person concludes the app is stuck and force-closes it — which is the behaviour that causes the loss — and above the ~1 s that still reads as an uninterrupted flow, so a dialog appearing at 1.5 s reads as "something is wrong" rather than as a normal step.

    **What the app can actually do differs by how the reviewer leaves, and the requirement is only honest if that is stated.** In-app navigation is genuinely holdable: past 1500 ms it shows a blocking state offering *Wait* or *Leave anyway*, and *Retry* or *Leave anyway* if the save has already failed. A tab close is **not** holdable — `beforeunload` is the only lever, it is synchronous, and the reviewer can dismiss it — so it is registered whenever anything is dirty or in flight and nothing more is claimed for it. Backgrounding the app, which on a phone is the common case rather than the exception, flushes the pending debounce immediately on `pagehide` / `visibilitychange` rather than waiting it out, so most of these never become a warning at all.

    **So the guarantee is not the dialog.** Every change is mirrored to `localStorage` under the assignment id, cleared only on a confirmed save, and restored when the reviewer next opens that applicant. The dialog reduces how often that restore is needed; the mirror is what makes "never a silent loss" true even when the operating system kills the tab. Relatedly, a save is an upsert on `(assignmentId, rubricCategoryId)`, so a retry after an ambiguous failure cannot write twice — "no silent duplicate write" comes from a constraint that has existed since Phase 0, not from a nonce.

27. **Free text when the return reason is "Other". RESOLVED: optional, the same as conflict of interest.** FR-9 requires a reason and offers two; it does not say whether picking "Other" then demands an explanation. It does not. A required text box is a wall in front of the one action a reviewer takes when they recognize an applicant, and the reason category is what an admin acts on — an unexplained "Other" is still more information than an abandoned return. `Assignment.returnNote` stays nullable for both values. **Amended by decision 117 for the admin's own return**, where the note is required: a reviewer's `CONFLICT_OF_INTEREST` is a complete explanation on its own, while an admin return is always `OTHER` and has no reason category doing that work, so the note is the entire record of what happened. §5 lists `returnReason`, `returnNote` and `returnedAt` as of the reconciliation pass; the schema has carried them since Phase 3.

28. **Claiming a slot on an applicant you previously returned. RESOLVED: allowed, not blocked.** The reviewer judged their own conflict and the system does not second-guess it; a reviewer who returned an applicant in error, or whose conflict turned out not to be one, would otherwise have no way back and the slot would sit open.

    **One implementation consequence, stated because it is not obvious and a naive reading produces a second row.** `UNIQUE (round, applicantId, reviewerId)` means the re-claim cannot insert: it reactivates the existing `RETURNED_TO_POOL` row to `ACTIVE`, sets `origin = CLAIMED_FROM_POOL`, and clears `returnReason`, `returnNote` and `returnedAt`.

    That also settles the apparent tension with decision 23, which says generation must never re-pair a returned applicant and reviewer. It still must not. A reviewer deliberately re-claiming is not generation, and once the row is `ACTIVE` and `CLAIMED_FROM_POOL` it is preserved capacity under decision 21 rather than an exclusion — which is the correct reading in both directions, since the row now records a live assignment and no longer records a recusal.

29. **A recovery path named in prose is not a recovery path. RESOLVED: linked from `/unlock`.** FR-5 puts instance password reset behind the app-level password *alone*, precisely so that an admin who has lost the instance password has a way back. `/unlock` had described that route since Phase 1 without linking it, and the settings page's only inbound link sat on the second-upload refusal inside `/mapping`, which renders behind `requireInstance` — so the sole route to the recovery was gated on the password being recovered. An admin who typoed a password at creation could read the sentence describing their way out and have no way to follow it.

    The capability was never wrong: the settings page and both of its actions gate on `requireAdmin` alone, deliberately and with comments saying why. Only the navigation was missing.

    The link lives on `/unlock` specifically and is unconditional. That page renders exactly when the session does **not** hold the instance — the redirect above it sends you on if it does — which is the state a locked-out admin is in; making it conditional on anything would reintroduce the same class of gap.

    Recorded as a decision rather than left as a bug fix because the general form is worth having written down: **a capability that is correct and unreachable is indistinguishable, from the outside, from one that is missing.** Found by the owner's Phase 2 walkthrough, not by review, tests, or typecheck — none of which can see that a page has no inbound link.

30. **The reviewer roster is served before the access code is verified. RESOLVED: one screen, name and code submitted together.** §8 requires the per-round code because "a name dropdown alone would let anyone with the link vote as anyone", which leaves open whether the dropdown may be *shown* before the code is checked. It may. §8 says the code keeps friction at one extra *field* — a field, not a screen — and FR-9's whole premise is that every extra tap is a review that does not get completed.

    The cost is that anyone holding the round link can see roughly thirty club members' names before entering anything. Accepted: the threat §8 names is impersonation, which the code closes regardless of when the roster loads, and a reviewer roster is club members' names rather than applicant data. Nothing about an applicant is reachable before the code verifies.

    If a future cycle wants the roster gated, the change is to populate the dropdown only after the code validates, on the same screen — not to add a second screen, which is the version that costs a completed review.

31. **Round access codes have no admin surface. RESOLVED: a minimal set/rotate control ships in Phase 3.** `RoundAccessCode` has existed since Phase 0 and only `prisma/seed.ts` has ever written one, so every instance created through FR-2 carries no code and an unreachable reviewer dashboard. §8 requires the code and FR-9 assumes a reviewer can sign in; neither says who creates it, and the answer had been "nobody".

    This is outside FR-9's six bullets and ships anyway, because BUILD_PLAN's Phase 3 gate requires a board member who has never seen the tool to complete a review, and that cannot happen on an instance with no code. Deferring it would leave the phase verifiable only against the seed — which is the same shape as decision 24's mistake, where leaving a decision open would not have stopped the surface that suffers from it being built.

    It lives on `/instances/[id]/reviewers`, which is already round-scoped and is where an admin thinks about a round's staff. Setting a code hashes it with the same argon2id path as every other secret here and never displays it again; rotating replaces it and is audited under §8, since it changes who can reach applicant data. The shareable reviewer link is shown beside it. Rotation does not evict reviewers already signed in — the reviewer session is signed rather than looked up — and the control says so rather than leaving an admin to assume otherwise.

32. **What "rubric" means on the reviewer's screen. RESOLVED: each category carries a description, and FR-9 renders it.** FR-9 requires the rubric "always visible alongside" the responses, and FR-4 defined a rubric as category names plus maximum points. Those two together produce a screen showing four bare words — which satisfies the sentence and defeats its purpose.

    Found the way these things are found here: the owner opened the built screen on a phone, read "Show rubric", tapped it, and got a list of category names. Nothing in the tests, the schema, or the FR text was wrong; the gap only existed at the point where a person had to act on what was rendered.

    §5 therefore gains `RubricCategory.description`, nullable, and FR-4 collects it beside the name and maximum. The cost of not having it is not cosmetic: a shared definition of a 4 is the main thing standing between thirty untrained reviewers and the score variance FR-10 exists to flag, so an unstated rubric converts a setup omission into a data-quality problem two phases later.

    **Superseded by decision 114, which is this argument carried the rest of the way.** `description` is replaced by one criterion per score value. A single blurb says what the category asks for and then leaves the boundary between a 2 and a 3 to each reviewer privately — and those boundaries are where the variance this decision was written about actually comes from. The reasoning here is untouched and is why 114 exists; only the instrument changes. 114 records what happens to the text existing rows hold, and the census taken before deciding it.

    **The description is inside FR-4's lock, and the consequence is stated rather than discovered:** once any `Score` exists, fixing a typo in a description requires the reset that discards every score. Rejected the alternative of a description-only write path that bypasses the lock — it is the right eventual answer, since prose orphans no `Score` row, but it is a second mutation route into a locked table and Phase 3 is not where that belongs.

33. **Work typed before the page finishes hydrating. RESOLVED: adopt the DOM, submit through forms, and never leave a control silently dead.** Distinct from decision 26, which is about a save already in flight. This one loses work *before any save is attempted*, and the two need different fixes.

    **The mechanism, because it is invisible in the code.** A server-rendered page is interactive-looking long before React attaches to it. In that window the markup is real, the fields accept keystrokes, and nothing is wired up. When React hydrates a **controlled** input it renders its own state — which is empty — over whatever is in the DOM, so anything typed in that window is silently discarded. No error, no failed request, nothing in a log: the characters were simply never React's to keep. Measured on this app at roughly **640 ms** on a warm route on a desktop; a cold route in development and a phone over Wi-Fi are both slower. A reviewer who opens an applicant and starts typing immediately is not an unusual user, they are the fast one.

    **The same window has a second effect, on controls rather than fields.** A `<button type="button">` driven by `onClick` has no native behaviour, so a tap before hydration does nothing at all and says nothing. A `<form>` bound to a server action does not share this: React ships it with `method="POST"` and hidden `$ACTION_REF_*` fields, so it submits natively with no JavaScript. Whether a control works before hydration is therefore decided by how it is built, not by what it does.

    **Resolution, three parts:**

    - **Adopt whatever is already in the DOM on mount** rather than assuming a field starts empty, so keystrokes from the hydration window are picked up instead of overwritten.
    - **Every control that mutates data is a form submit**, not an `onClick` handler, so it works before hydration rather than pretending to.
    - **Any control that genuinely cannot work yet says so**, disabled until hydrated, because a button that ignores a tap in silence is worse than one that admits it is not ready.

    Found while investigating why three separate buttons appeared to ignore clicks. Two of those turned out to be a test-automation artifact and one was this. The distinction matters: the automation problem was noise, and underneath it was a real way to lose a reviewer's work on the one screen whose requirement is that work is never lost.

34. **What FR-3's finality covers. RESOLVED: field identity is frozen at commit, presentation policy is not.** FR-3 says "commit is final", and the implementation read that as the entire mapping surface: `/mapping` renders a card and returns early once `importCommittedAt` is set, and every mapping action refuses server-side as well. The stated reason is that `Applicant.data` still points at the old field ids. That hazard is real, but it only covers some of what got frozen — the rest was frozen because it happened to share a screen. **Decision 110 changes only the starting value of one unfrozen control**, not which controls are frozen: an included Responses column arrives with `isReviewerVisible` already true. The line this decision draws — a property that keys nothing and orphans nothing stays editable — is unaffected.

    **Frozen, and correctly:** `category`, group membership and group role, group creation, split and merge, `displayName`, and `promotedRole`. Each of these changes what an already-written `fieldId` key means, or what §10.7 counts over, across a cohort that already exists. `promotedRole` is the strongest case and is different in kind from the others: the EMAIL and NAME columns' `Field` rows are *deleted* at commit, once their values become `Applicant.email` and `Applicant.displayName`, so there is nothing left to re-designate. Its freeze is a fact about the data rather than a choice about scope.

    **Amended by decision 108**, which replaced the two per-round columns with a single `isReviewerVisible`. The frozen/editable line this entry draws is unchanged and survives as written; only the names on the editable side move, and the per-round framing below is now historical. Its final paragraph on the DEMOGRAPHIC case is superseded — see the note at the end of this entry.

    **Editable after commit:** `isIncluded`, `visibleToWrittenReviewer` and `visibleToFirstRoundReviewer`, on both `Field` and `FieldGroup`. They key nothing. §6 marks OTHER "configurable" and FR-2 names the mapping table as where it is configured, so freezing them left that capability with nowhere to live. They are also **per-round** controls, and rounds run weeks after an import — so the one window in which an admin could decide what written reviewers see closed before the applicants existed and long before any reviewer signed in. An admin realistically asks "should written reviewers see the major?" while briefing reviewers, not while mapping CSV columns. The only correction FR-3 offered was deleting the instance and importing again, which destroys every applicant, assignment and score to change one boolean.

    **Two consequences, stated rather than left to be discovered.** Un-including a column after commit removes it from FR-10's admin profile as well as from every reviewer surface, since `lib/fields.ts` resolves `isIncluded: false` to invisible for every viewer including ADMIN — and it is reversible, because commit writes every non-promoted column into `Applicant.data` regardless of inclusion. Separately, because category stays frozen, the *set* of columns eligible for a per-round toggle is fixed at commit: decision 18 reads an override only where the resolved category is OTHER. A column mis-marked RESPONSE can still be hidden by un-including it. A column mis-marked DEMOGRAPHIC cannot be shown to written reviewers at all, and that case stays stuck deliberately — unfreezing category would create a two-step route, recategorise and then tick Written, to showing ethnicity to written reviewers, which is the hazard goal 3 exists to close.

    **Audited under §8, and allowed at any time including mid-round.** Audited on decision 31's argument, since it changes who can reach applicant data. Not restricted to the gaps between rounds, because the admin who notices the problem while reviewers are working is precisely the person this decision is about, and a mid-round block would rebuild the same trap one layer in.

    No schema change. All three columns have existed on both tables since Phase 0; §5 is unchanged by this decision.

    **What decision 108 changes here.** The editable set becomes `isIncluded` and `isReviewerVisible`. The third paragraph's closing case inverts: a column mis-marked DEMOGRAPHIC still cannot be shown to any reviewer, but that is now the doing of §6's lock rather than of category-gated overrides, and it holds in the second round as well. Its companion sentence — *"A column mis-marked RESPONSE can still be hidden by un-including it"* — becomes load-bearing rather than incidental: it is the escape hatch that lets §6 protect Responses with a commit blocker instead of a lock, and 108 cites it by name. One clause here is genuinely gone: this entry says the *set* of columns eligible for a toggle is fixed at commit, which was true when only OTHER was overridable. Under 108 every non-demographic column is eligible, so nothing is fixed by category any more.

35. **The guard on FR-3's commit. RESOLVED: a two-step confirmation naming what becomes final.** Commit was a single unguarded button on the preview page, and it is irreversible twice over: an instance accepts one CSV, and — until decision 34 — commit also permanently froze every category, group, inclusion flag and visibility toggle. FR-5 guards instance *deletion* behind the app-level password **and** typing the instance name. The action that ends the only cheap opportunity to catch a bad file had no guard at all.

    Found the way these things are found here: the owner committed a test instance during the Phase 3 testing pass without registering that they had, on their own tool, while deliberately testing it. Two properties of the control made that easy and both are worth recording. It sat among other buttons on a page whose entire purpose is reviewing and adjusting, so nothing about it read as terminal. And as an `onClick` handler rather than a form submit it is inert before hydration and then fires instantly afterwards — decision 33's profile, which is exactly what produces "I do not think I clicked that".

    **The resolution is a confirmation step, not FR-5's typed-name gate.** Following the primary control renders a panel stating what is about to become final — the applicant count, the one-CSV rule, and the column properties decision 34 leaves frozen — and the commit is a separate submit inside that panel. Lighter than deletion's gate on purpose: deletion is rare and destroys work that exists, while commit is on the path every instance takes and creates rather than destroys, and decision 34 removes the half of its cost that was the mapping surface. Both steps work before hydration, per decision 33.

36. **How an admin reaches an instance's surfaces. RESOLVED: an instance hub at `/instances/[id]`.** FR-1 described the instance *list* and nothing described what opening an instance lands on, so `/instances/[id]` shipped as an unconditional redirect to `/mapping`, with a comment saying an instance has no landing page of its own yet. The consequence was that **`/instances/[id]/reviewers` and `/instances/[id]/assignments` had no inbound link from anywhere in the application.** `/assignments` links to `/reviewers`; nothing links to either. The only way in was typing the URL, which is also why the gap survived a full testing pass — the pass reached both pages because its own instructions supplied the URLs.

    This is decision 29's general form at a larger scale — *"a capability that is correct and unreachable is indistinguishable, from the outside, from one that is missing"* — and the scale is what makes it worse than the original. There it was one link to one recovery page. Here it is FR-6's entire roster surface and FR-7/FR-8's entire assignment surface, all built, all working, none findable. It also defeated decision 31: the round access-code card lives on `/reviewers` precisely so the Phase 3 gate could be run on a non-seeded instance, and an admin cannot set a code without first reaching a page nothing links to. And it defeats goal 4, since an E-Board working from documentation alone cannot navigate to two of the surfaces a written round requires.

    **The resolution is a hub, not a nav bar.** `/instances/[id]` renders every surface the instance has, in the order a cycle uses them, each row carrying state read from the database rather than a bare link: how many columns and whether the import has committed, how many rubric categories and whether the lock has engaged, how many reviewers and whether the round's access code is set, how many assignments and how many applicants are short one. A nav bar would make every surface reachable in one tap and would still never say where the cycle had got to. Goal 4 wants a new E-Board to run a cycle from documentation alone, and a hub stating the running order and the current position is the nearest thing to that documentation living inside the product.

    The cost is one extra hop between sibling surfaces, since leaving the rubric for the roster goes via the hub. Accepted: CLAUDE.md's tap budget is a property of the reviewer dashboard — thirty people, once, on a phone — not of an admin screen used by two to six people working through a cycle over weeks. If it bites in practice the answer is to add a nav bar alongside the hub, not to replace it.

    Every instance page keeps its `← Instances` link to FR-1's list and gains the instance name as a second crumb pointing at the hub, so the hub is reachable from the surfaces it links to rather than only from the list.

37. **The offline draft mirror is reviewer data on a personal device. RESOLVED: cleared on a confirmed save, on sign-out, and by a 7-day TTL.** Decision 26 makes a `localStorage` mirror the thing that makes "never a silent loss" true, and then says nothing about what ever removes it. §8 governs applicant data on the server and in the repository; this is reviewer-authored text *about* an applicant, sitting unencrypted in a browser on someone's own phone, and under decision 26 as written nothing would delete it — not signing out, not the end of the round, not the end of the cycle.

    The mirror is keyed by `assignmentId` and holds only what the reviewer typed: scores, and the free-text note. **No applicant name, no email, and not even the anonymous label** — a reader of the storage sees `spark-review:draft:<cuid>` and some prose, with nothing in it that identifies who the prose is about. That is what keeps the exposure proportionate to the guarantee it buys, and it is a property to preserve rather than an accident of the first implementation.

    Three things clear it. A **confirmed save** clears that key, which is the common case and the reason the mirror is usually empty. **Signing out** clears every draft for the instance. And any record older than **7 days** is dropped rather than restored when it is next read — which matches `REVIEWER_SESSION_TTL_SECONDS` exactly, on the reasoning that a draft outliving the session that could have saved it is not a draft any more.

    **What the sign-out clear does not cover, stated rather than left to be discovered.** Sign-out is a server action and the clearing is a client-side side effect on its submit, so a sign-out tapped before the page hydrates signs the reviewer out and leaves the drafts behind. That is decision 33's window again, and it is not closable here: clearing browser storage is not something a server action can do. The TTL is the backstop for precisely that case, which is why this decision does not rest on the sign-out path alone.

    **Related, and the reason this needed writing down at all:** decision 26 is careful that the dialog is not the guarantee and the mirror is. That makes the mirror the one component whose *absence* is a silent failure and whose *persistence* is a privacy question, and it had neither an owner nor an expiry. Both are now stated. No schema change and no server-side storage — this is entirely browser-local, which is also why §8's data-handling rules could never have reached it.

38. **Unsaved work at the moment an applicant is returned to the pool. RESOLVED: the return clears that assignment's draft, and does not hold for a save in flight.** Decision 37 named three things that clear the mirror — a confirmed save, signing out, and the 7-day TTL — and returning an applicant is a fourth that it did not anticipate, because return-to-pool did not exist when it was written.

    It is different in kind from the other three, and that is what decides it. After a return the reviewer no longer holds the assignment, so every subsequent write for it is refused: the save path re-checks ownership on each request precisely because an assignment id in a request body is untrusted. A mirror entry for a returned assignment can therefore *never* be flushed. It would sit on the device for seven days as reviewer-authored text about an applicant the reviewer has just recused themselves from — which is the exact exposure decision 37 exists to bound, in its least defensible form.

    **The same reasoning removes the navigation hold.** Decision 26's 1500 ms hold waits for an in-flight save to settle before letting the reviewer leave. Applied to a return it would wait for a save that the return itself has guaranteed will be refused, and then offer *Retry* — so the honest behaviour is to not hold at all. The return submits, the assignment leaves the list, and nothing claims otherwise.

    **What is lost is stated plainly rather than implied: work typed and not yet saved at the moment of return is discarded.** That is the intended reading of the action — the reviewer is saying this applicant is not theirs — and it is bounded, because scores and a note already confirmed are *not* deleted by a return. A reviewer who returns in error and claims the applicant back under decision 28 finds everything the server had acknowledged still there.

    Carries decision 37's caveat unchanged: the clear is a client-side side effect on the submit, so a return tapped before the page hydrates returns the applicant and leaves the draft behind. Clearing browser storage is not something a server action can do, and the TTL remains the backstop. No schema change.

39. **A return reason that nobody can read. RESOLVED: returned rows render on the admin assignments page.** FR-9 requires a reason on return-to-pool and decision 27 made its free text optional on the explicit ground that "the reason category is what an admin acts on". Every query on `/instances/[id]/assignments` filters `status: ACTIVE` — the load table, the short-a-reviewer filter, the per-applicant reviewer list, all of it — so a returned row was written, was correctly preserved through regeneration as an exclusion under decision 23, and was visible to nobody. The one requirement the reason exists to serve had no surface. **Decision 117 adds a second producer of these rows** — an admin returning a slot on a non-responsive reviewer's behalf, always `OTHER` and always with a note — so this page now renders returns made by two different actors. It stays non-actionable for the reason below, and FR-8's assign is still the only way to put a reviewer back on an applicant they left.

    This is decision 29's general form for the third time — *a capability that is correct and unreachable is indistinguishable, from the outside, from one that is missing* — and it is the cheap variety: the data was already stored, already correct, and already loaded on the right page under a different filter.

    Each applicant now shows its returned assignments beneath its active reviewers, dimmed and non-actionable, naming the reviewer, the reason, and the free text where one was written. Non-actionable deliberately: a returned row is the record of a recusal, and an admin who could delete it would be able to let generation re-pair that reviewer with that applicant, which decision 23 forbids. The way to put a reviewer back on an applicant they returned is FR-8's assign.

    **FR-8's assign has to be taught about that row, and this is the second half of the same gap.** `assignReviewer` checks only the applicant's *active* reviewers and then inserts, so assigning a reviewer who had returned that applicant violated `UNIQUE (round, applicantId, reviewerId)` and surfaced as a raw database error. It was unreachable until now for the same reason the missing surface was invisible — nothing could create a returned row before FR-9's return-to-pool existed. It reactivates the row as `MANUAL` instead, clearing the return fields, exactly as decision 28 has a reviewer's own re-claim reactivate it as `CLAIMED_FROM_POOL`. Both are a deliberate person overriding a recusal, and neither is generation. The three return columns this and decision 27 name are in §5's `Assignment` block as of the reconciliation pass.

40. **The written scale runs 0 to `maxPoints`, and the rubric it is meant to express runs 1 to 4. RESOLVED: `RubricCategory` gains a `minPoints` column — and the change is deferred to Phase 4.** `maxPoints` is the only bound in §5, and the floor is hardcoded in `lib/review.ts` as "reject anything below zero", so a 5-point category offers six values. The intended instrument is four: fewer options score faster and agree more often across thirty untrained reviewers, and no submitted answer should be scorable as nothing. Raised by the owner during the Slice 7 board-member run; it is a rubric-design decision rather than a defect, and the screen does exactly what FR-4 currently specifies.

    **Why a column rather than a stated convention**, which was the cheaper option and is the wrong one. A convention — "scales run 1 to `maxPoints`, 0 is never offered" — is a change to validation code, so it applies to every instance that has ever existed. Instances here are per-semester and are kept: a past cycle whose reviewers legitimately recorded a 0 would suddenly hold scores the current scale says cannot exist, which FR-10 would then average and FR-20's export-and-reimport round trip would fail to validate. A column makes the scale *data*, so it travels with the instance that used it and history stays coherent. The cost is honest and accepted: per-category configuration that no admin will ever vary between categories, and a second field on the FR-4 builder, which finding F-01 in `plans/phase-3-test-pass.md` already finds fiddly.

    **`minPoints Int @default(0)`**, so the migration changes the meaning of no existing row and new rubrics opt in. Two defaults, two layers, both true: the database default of 0 is what keeps existing rows unchanged, and the builder's default for a new category is 1–4, which is what FR-4 means by "starts at". Invariant `0 ≤ minPoints < maxPoints`, enforced in `validateRubric` beside the existing bounds. `validateScore` takes the floor as a parameter instead of assuming zero; the segmented row and the number-input fallback both render from it. `null` continues to mean *clear this score* and is untouched — **"unscored" is the absence of a `Score` row, not a zero**, which is what makes dropping 0 from the offered values cost nothing semantically. It is also why the obvious shortcut of storing 0–3 and displaying 1–4 is refused: the stored number must be the number the reviewer saw, or FR-10 computes variance over values nobody chose.

    **Why it is deferred, which is the part a later reader will want.** Nothing about it is urgent — no reviewer is blocked and no data is wrong — and the migration would land between the board-member run and its step 8 re-run, which is the gate Phase 3 is actually trying to close. A schema change in that window risks the thing being verified for a change with no deadline. Phase 4 is the natural home: FR-10 is the first requirement that computes on the scale rather than only storing it. **Existing scores need no migration regardless** — FR-4 locks the rubric once any `Score` exists, so changing a scale already requires the reset that discards them.

    **Decision 114 builds on this column rather than around it.** Per-value criteria are collected across `minPoints..maxPoints`, so the floor added here is what decides how many of them a category has. 114 caps how wide that range may be while carrying criteria, and deliberately does *not* lower `MAX_POINTS_CEILING`, for the reason stated above: a global rule applied to instances that are kept is how a past cycle comes to hold data the current rules say cannot exist.

41. **`Applicant.status` carries an `ADVANCED` value with no reader. RESOLVED: drop it, three-state enum.** `ADVANCED` appears only in the §5 schema block, never in §7 prose. FR-17 defines second-round pass membership as "every applicant with `status = ACTIVE`" with no round qualifier, which means by the time an applicant reaches second round they must already be back to `ACTIVE` — so a state that means "selected, not yet active in the next round" has nothing downstream that reads it or clears it. `Applicant.status` becomes `ACTIVE | REJECTED | SPARKLET`.

    **FR-11 finalize, made explicit:** for every applicant in the pool, write a `Decision` row with `stage = WRITTEN`. Selected: `outcome = ADVANCE`, `status` stays `ACTIVE`, `stageReached → FIRST_ROUND`. Not selected: `outcome = REJECT`, `status → REJECTED`, `stageReached` stays `WRITTEN`. This is a decision for every applicant looked at, not just the ones who advance — the record of "we reviewed X and passed on them" is as real as the record of advancing someone, and it's what the `UNIQUE (applicantId, stage)` constraint is there to hold one of.

    "Populates the First Round tab" (FR-11) means `stageReached` moving forward on the advanced applicants and nothing more. Standing up first-round roster or reviewer state is FR-12 onward, Phase 5's job.

42. **Two applicants tied on both of FR-10's sort keys. RESOLVED: `sourceRowIndex` ascending as a third key.** FR-10 names average descending and variance ascending and stops, so an exact tie renders in whatever order Postgres happened to return and can differ between two loads of the same page. It is not a rare case: on a four-category 1–4 rubric, three reviewers all scoring straight 3s and a single reviewer scoring a 3 both produce average 3.0000 and variance 0.0000, and any applicant whose reviewers agreed exactly ties every other such applicant at the same average.

    `sourceRowIndex` is stable, exists on every applicant, and is never renumbered (decision 11). **The alternative worth naming is sorting by name, and it is rejected on fairness rather than on taste:** it would systematically advantage applicants early in the alphabet on every exact tie, across every cycle, in a list an E-board reads top-down. That is a real if small thumb on the scale, chosen by nobody, and invisible precisely because it looks like ordinary alphabetical ordering. Row index is arbitrary with respect to the applicant, which is the property wanted here.

43. **Whether finalizing the written round moves `Instance.currentStage`. RESOLVED: yes, to `FIRST_ROUND`.** Decision 41 bounds "populates the First Round tab" to `stageReached` "and nothing more", which is a statement about *applicant* state and leaves the instance-level field unaddressed. `Instance.currentStage` is what FR-1's list renders beside each instance and what the hub uses to say where the cycle is; leaving it on `WRITTEN` after the written round has been decided makes both surfaces report a stage the cycle has left.

    This is one field on `Instance`. It creates no first-round roster, no reviewer assignments and no access code, so it stays inside decision 41's boundary rather than reaching past it — the sentence exists to stop Phase 5 work migrating into Phase 4, and this is not that.

    **It is also load-bearing, which is the part worth writing down.** FR-11's post-finalize read-only state is decided from this field: once `currentStage` is not `WRITTEN`, the results screen drops its checkboxes and its finalize control. If this decision were reversed the field would never move, that gate would never fire, and the screen would go on offering to finalize an already-finalized round. Reversing it therefore requires choosing a different signal for "the written round is over" — the obvious one being the existence of any `Decision` row at `stage = WRITTEN` — and not simply deleting the write.

    Confirmed load-bearing during Phase 4: /results' read-only gate (clause 11e) reads currentStage to decide whether selection is still offered. Reversing this decision without updating that gate would silently break it.

44. **Applicants with zero completed reviews when the admin finalizes. RESOLVED: finalize proceeds, and the confirmation names them.** Decision 41 requires a `Decision` row for every applicant in the pool, so an applicant nobody reviewed receives `outcome = REJECT` and `status = REJECTED` along with everyone else who was not selected. Read together with decision 1 — which requires FR-10 warn on applicants with fewer than three completed reviews, because returns add pool slots throughout the round — that produces the one outcome this system exists to make impossible: a rejection recorded against an applicant no reviewer ever read.

    The confirmation panel therefore lists them by name and count above the confirm button, phrased as what it is: rejecting them records a decision nobody made. **Blocking finalize outright was the stronger guarantee and is rejected**, because a reviewer who never showed up is exactly the situation the unassigned pool exists to absorb, and a hard block hands a deadline-bound E-board a screen they cannot get past. **Silence was the PRD-literal reading and is rejected** for the reason above. Naming them puts the fact in front of the one person who can act on it, at the one moment acting on it is still possible, and leaves the choice theirs.

45. **The fuzzy-match algorithm, threshold, and what happens when two applicants both clear it. RESOLVED: Jaro-Winkler over the full normalized name at a 0.85 threshold; more than one match above threshold routes to the manual queue.** FR-13 names a fuzzy tier without an algorithm or a number, and BUILD_PLAN's own gate depends on one — "Cici Fang" against "Cecilia Fang" is a whole-string near-miss, not a token-level one, which is why this compares the full trimmed, case-folded, whitespace-collapsed name rather than splitting into first and last halves the way the FR-6 roster comparison does. That split solves a different problem — telling two people with a shared token apart — and buys nothing here.     **Both names are normalized before comparison, past the trim/collapse/case-fold FR-6 already does.** Standalone single-letter tokens (with or without a trailing period) are stripped from both sides before comparing, so "Jordan A. Lee" and "Jordan Lee" collapse to the same string and resolve at tier 2 rather than depending on the fuzzy threshold to absorb an inserted middle initial — a threshold loose enough to swallow an extra token on its own would also swallow genuinely different short names. Non-alphanumeric characters are stripped the same way, so "O'Brien" and "OBrien" compare equal rather than trusting 0.85 to cover apostrophe and hyphen inconsistency across hand-typed sheets.

    0.85 is a starting point, not a derivation, and the deliberately messy fixture data BUILD_PLAN calls for is what actually tests it — trailing whitespace, a middle initial present in one file only, and the Cici/Cecilia pair should clear it, while two genuinely different short names should not.

    > **Superseded on the comparison basis and the threshold by decision 52.** Building that fixture data is exactly what tested it, and it failed: whole-string Jaro-Winkler scores the Cici/Cecilia pair at 0.842 and the Mia/Nia pair at 0.917, so the rule above rejects the example it was written for and admits the one it was written against. **The normalization in this decision stands unchanged and is still what tiers 2 and 3 both run on.** What changes is what the score is computed over. See 52.

    **A row where more than one applicant clears the threshold is not auto-resolved to the closest one.** An ambiguous fuzzy match is worse than an unresolved one, same reasoning as decision 12's stance on group detection — a wrong silent guess costs a cycle, and a row that simply waits for a human costs a minute.

46. **FR-15 ranking: the tiebreak, and how a zero-vote applicant renders. RESOLVED: raw non-skip vote count descending, then `sourceRowIndex` ascending; zero votes marked on the count cell, not hidden or blocked.** Yes-percentage ties are common at low reviewer counts — 2/2 and 6/6 both read 100% — and FR-15 named no tiebreak. Vote count first, because a 6/6 unanimous yes is a stronger signal than a 2/2 one at the same percentage and the ranking should say so before falling back to the arbitrary key; `sourceRowIndex` last, same reasoning as decision 42 — it is arbitrary with respect to the applicant, which is what makes it fair as a last resort.

    Zero non-skip votes should not happen but is not blocked from happening — a reviewer roster that never got to an applicant is a process failure, not a data integrity one. It gets FR-10's under-3/3 treatment: a marker on the review-count cell, not a row-level flag and not an exclusion from the ranked list, so it is visible without being treated as broken.

47. **The two FR-12 sheets commit independently, and a re-upload upserts rather than being refused. RESOLVED.** Interview data arrives while interviews are still being conducted, not all at once the way the FR-2 applicant roster does, so gating one sheet on the other — or refusing a corrected re-upload the way FR-3 refuses a second applicant CSV — is friction with no payoff and would block voting on data that's actually ready. Each sheet stages, previews, and commits on its own schedule; the dashboard renders whichever half exists and treats the other as absent rather than blocking.

    This is why `InterviewResult` gains `UNIQUE (applicantId, interviewerName)` — a constraint that didn't need to exist when the only import path was a single commit-once CSV. A re-committed scores sheet upserts on that key instead of creating a duplicate row. `InterviewNotes`'s existing `UNIQUE (applicantId)` already gives notes the same behavior for free.

48. **Reconciliation is scoped to applicants who reached first round, not the full pool. RESOLVED.** FR-13 says nothing about which applicants a name or fuzzy match is allowed to resolve to, and matching against the full 150 includes applicants FR-11 already rejected — nobody outside `stageReached != WRITTEN` can legitimately appear in an interview sheet, so widening the match pool only manufactures wrong matches for free. Scoping the comparison set to the applicants who actually advanced removes that failure mode rather than relying on the admin to catch it in the manual queue.

49. **Two rows in the same upload resolving to the same applicant. RESOLVED: warned at preview, not silently upserted.** *(Collision key refined by decision 50 — read them together.)* Decision 47's upsert on `(applicantId, interviewerName)` for scores and `applicantId` for notes handles a *re-upload* correctly, but says nothing about two rows inside one file landing on the same applicant — accidentally pasted notes twice, or two sheet rows both resolving to one person through different tiers. Committing silently would let the second row overwrite the first with nothing telling the admin it happened, the same failure decision 35 found in FR-3's unguarded commit. The preview screen surfaces any applicant with more than one resolved row in the batch before commit is offered, same posture as FR-3's duplicate-email warning.

50. **Decision 49's collision key is the sheet's upsert key, not `applicantId`. RESOLVED.** Read literally, 49 flags "any applicant with more than one resolved row in the batch" — but FR-12 *expects* two scores rows per applicant, one per interviewer, so the literal reading fires on every correctly imported applicant and the warning becomes something to click through. **The flagged set is exactly the set where a second row would overwrite a first:** `(applicantId, interviewerName)` on the scores sheet, `applicantId` on the notes sheet. That is 49's own stated reasoning — "the second row overwriting the first with nothing telling the admin it happened" — applied to the key the upsert actually uses, rather than to a coarser one that also covers the case the requirement is built around. Interviewer names are compared case-folded and whitespace-collapsed, so "Alex Kim" and "alex  kim" collide.

51. **Rows still unresolved when the admin commits. RESOLVED: commit is blocked until every staged row is either matched or explicitly skipped.** §5 says `InterviewImportRow` "is deleted at that sheet's commit", which is only true if nothing is left in the queue at that moment; a partial commit would leave the staging table outliving the commit it was defined to end at, and a commit that silently discarded the remainder is the exact behavior FR-13's "nothing imports silently" exists to forbid.

    This adds one outcome to the reconciliation screen — *not an applicant in this pool, skip this row* — for rows that legitimately match nobody: a header row pasted twice, a candidate who withdrew, a written-round rejection appearing in an interview sheet by mistake. A skipped row is a decision an admin made and a state the schema records (`InterviewImportRow.skipped`), which is what distinguishes it from a row that quietly vanished.

52. **The fuzzy tier's comparison basis and threshold, amending decision 45. RESOLVED: exact normalized surname, matching given-name initial, Jaro-Winkler ≥ 0.78 over the given-name remainder.** Decision 45 specified Jaro-Winkler over the full normalized name at 0.85, and that rule rejects decision 45's own worked example while admitting the example it names as a counter-case. Measured, with an implementation validated against the published reference pairs (`MARTHA`/`MARHTA` 0.961, `DWAYNE`/`DUANE` 0.840, `DIXON`/`DICKSONX` 0.813, `CRATE`/`TRACE` 0.733):

    | Pair, normalized | Whole-string Jaro-Winkler | Decision 45 requires |
    |---|---|---|
    | `cici fang` / `cecilia fang` | **0.842** | clears 0.85 — it does not |
    | `mia chen` / `nia chen` | **0.917** | scores below 0.85 — it does not |
    | `cecelia fang` / `cecilia fang` | 0.940 | clears ✓ |
    | `meagan woods` / `megan woods` | 0.954 | clears ✓ |
    | `meagan woods` / `maegan woods` | 0.975 | clears ✓ |

    **No threshold fixes this, because the pair that must match scores strictly lower than the pair that must not.** There is no number between 0.842 and 0.917 in the required direction. Decision 45's stated rationale — "'Cici Fang' against 'Cecilia Fang' is a whole-string near-miss, not a token-level one" — is the sentence that is wrong: split token-wise the pair is a *certainty* on one half and a near-miss on the other (`fang` = `fang` exactly, `cici`/`cecilia` at 0.796), and whole-string scoring averages the half it knows into the half it does not. That is what pushes the pair under the bar while `mia`/`nia`, three characters riding on an identical surname, floats over it.

    The replacement rule, applied after decision 45's normalization, which is unchanged:

    1. The **surname** — the last token — must be exactly equal. A fuzzy surname is a different family, and the surname is the half an interviewer copies off a form rather than recalls.
    2. The **given-name remainder must share its first character.** A difference at the initial is a different person (`mia`/`nia`, `sam`/`pam`, `jon`/`ron`); a difference after it is a spelling variant (`cecelia`/`cecilia`, `meagan`/`megan`, `cici`/`cecilia`). This gate carries the Mia/Nia case structurally rather than by a threshold that happens to land right.
    3. **Jaro-Winkler ≥ 0.78 over the given-name remainder.** `matchConfidence` records this number.

    0.78 is still a starting point rather than a derivation, but the gate above now carries the discrimination the threshold was being asked to carry alone. The rejected alternative was keeping whole-string scoring at 0.84 with the same initial gate: it satisfies the same cases, but `cici`/`cecilia` would clear by 0.002, and a threshold tuned to two thousandths of margin is a number nobody can maintain.

53. **A single fuzzy candidate is confirmed by an admin, not auto-committed. RESOLVED.** FR-13 already says "presented for confirmation"; decision 45 says only what happens when *multiple* candidates clear, leaving the single-candidate path to be assumed. It cannot be assumed, because the arithmetic forbids the obvious reading: a nickname is less similar to its own given name than two different people's names are to each other. Given-name Jaro-Winkler against an identical surname — `cici`/`cecilia` **0.796**, `jason`/`jasmine` **0.853**, `chris`/`christina` **0.911**, `alexandra`/`alexander` **0.956**.

    No similarity function reorders that list; there is no signal in the strings to reorder it by. So any rule that auto-commits the case decision 45 wants auto-committed also auto-commits two different people onto one applicant record — the precise defect this system exists to remove, arrived at by a different route. A fuzzy row is therefore staged as resolved (`matchedApplicantId`, `matchTier = FUZZY`, `matchConfidence`) and appears in a confirm list; commit is not offered while any fuzzy row is unticked. One tick box is the whole cost of never doing that.

54. **Where the interview rubric builder lives. RESOLVED: its own page, `/instances/[id]/interview-rubric`, not a second section of `/rubric`.** FR-12 presupposes configured `InterviewCategory` rows and named no surface for them, which is what FR-12a now fixes. A second section on the existing rubric page would put two instruments, two lock rules, and two "once any score exists" conditions on one screen — decision 6 already treats the written and interview rubrics as separate instruments precisely so they do not tangle, and a shared page reintroduces the tangle at the UI layer. Its own page, modelled on the existing builder and reusing `validateRubric`'s shape, keeps FR-4's lock semantics separate from the interview instrument's, which locks on `InterviewCategoryScore` rows rather than `Score` rows.

55. **An interview category score outside `0..maxPoints`. RESOLVED: flagged in the preview, imported anyway, never rejected.** The question arises because `InterviewCategory` has no `minPoints` — FR-12a asks only for max points per category, and decision 40's floor exists for FR-4's *input* control, where the rule is that no submitted answer should be scorable as nothing. These numbers are not typed into a control. They arrive from an interviewer's spreadsheet, where 0 is a legal thing for a sheet to say and where a 5 in a column scored out of 4 means somebody made a mistake that the import cannot unmake.

    **This is FR-12's existing stance on a disagreeing average, applied to the same sheet's other numbers.** FR-12 already says the importer "does not recompute the average or reject a row whose average disagrees with its categories — interviewers sometimes adjust it deliberately — but it does flag the disagreement in the preview so the admin sees it before commit." An out-of-range category score is the same shape of problem and gets the same treatment, because the alternatives are worse in the same ways:

    - **Rejecting the row** discards an interview that actually happened over a typo in one cell, and leaves the admin editing the source file and re-uploading to recover data the tool already read correctly. The interview is the record; the tool is not entitled to refuse it.
    - **Clamping to the range** silently rewrites what the interviewers recorded, which is the one thing FR-12 is emphatic the importer must never do to the average and has no more licence to do here.
    - **Staying silent** lets a 5-out-of-4 flow into FR-14's dashboard and FR-15's ranking, where it reads as a legitimate score and is unattributable to anything once the sheet is closed.

    The flag is two-directional: below 0 as well as above the category's `maxPoints`. A score of exactly 0 is **not** flagged — there is no floor, and 0 is a real thing for an interviewer to award.

    **Not blocking**, so a flagged row does not hold up the commit the way an unresolved FR-13 row does under decision 51. The distinction is what the admin can do about it: an unresolved row is a question only they can answer, whereas an out-of-range score is a fact about the file that they can act on now, later, or not at all. Blocking on it would stop a whole cohort's scores over one interviewer's fat finger.

    **Deliberately not enforced by a CHECK constraint on `InterviewCategoryScore.points`.** A database that refused the row would make this decision unimplementable, and the value has to survive so the flag has something to point at.

56. **Ambiguity at a stronger tier does not fall through to a weaker one. RESOLVED.** A row with two exact-name matches queues at tier 2 rather than proceeding to fuzzy matching in hopes of a tiebreak. Falling through would mean a row-level certainty (two exact matches exist) gets resolved by a strictly less reliable method, which is backward — fuzzy matching exists for rows with no exact candidate, not as a tiebreak among exact ones.

    The cascade therefore stops at the first tier producing *any* candidate, ambiguous ones included. Implemented and tested in `lib/reconciliation.ts`.

57. **A single-token name cannot be fuzzy-matched. RESOLVED.** Decision 52's method depends on a surname held fixed while the given name varies; a row with no second token has nothing to hold fixed, and comparing it as a bare string is the whole-string method decision 52 exists to replace. Such rows fall through to the manual queue.

    This applies to either side of the comparison — a one-word row name, and a one-word applicant `displayName`, which FR-3 permits since only a blank name blocks import.

58. **FR-12a gains a reset action, not stated in the requirement text. RESOLVED.** Without it, an admin who imports scores against a wrong rubric has no path but deleting the instance. Modelled on clause 12a-4's "modelled on FR-4's builder," and less destructive than FR-4's reset — it discards data that still exists in the source file, and decision 47 makes re-importing routine. Deletes `InterviewResult` rows along with `InterviewCategoryScore` rows, since a result with no category scores underneath is a state nothing else in the system can produce. Audited.

    The confirmation says what comes back, not only what goes away. An admin who cannot tell this apart from FR-4's reset — which destroys work thirty reviewers typed and cannot recover — will treat both as unrecoverable and neither as usable. `InterviewNotes` is untouched: it references no category and survives a rubric change intact.

59. **A category cell that is blank or non-numeric, distinct from decision 55's wrong-but-numeric case. RESOLVED, three readings.** Blank means *not scored* — no `InterviewCategoryScore` row is written for that category, same as the written round's rule that an unscored category is the absence of a row, never a zero. Non-numeric text is flagged like decision 55, with no row written. A decimal in an integer column (`points` is `Int`, `Average` is `Float`) is flagged rather than rounded, on the same reasoning decision 55 rejects clamping — rounding would rewrite what the interviewer actually recorded.

    Decision 55 answers "the cell is a number, but the wrong one". This answers "the cell is not a number at all", which `InterviewCategoryScore.points` being a non-null `Int` makes unavoidable rather than optional: the importer cannot defer it to the database.

    The three readings share one property — **no row is written, and the row's other categories still import.** A single unreadable cell costs that one category, never the interview. That is what keeps this consistent with 55, where a readable but wrong number is kept precisely because the interview is the record.

60. **A row missing `Average` or interviewer name — the two required scores-sheet fields with no fallback — blocks import rather than being skipped automatically. RESOLVED.** The non-null columns force that such a row cannot commit silently, but not that it must block rather than skip; that's a choice, consistent with this phase's practice of stating it. Treated as a per-row blocker rather than an automatic skip, same posture as a batch collision (decision 49) and an unresolved match (decision 51) — an admin should see and act on a genuinely broken row rather than have it quietly excluded from the cohort.

    "With no fallback" is what separates these two from the applicant columns. FR-12 offers `Applicant Email` **or** `Applicant Name`, and FR-13's cascade skips whichever tier it has no value for, so a row missing one still resolves. Nothing stands in for the average — decision 55 and FR-12 both forbid recomputing it from the categories — and nothing stands in for the interviewer name, which is half of `(applicantId, interviewerName)` and therefore half of what keeps two interviewers' scores for one applicant apart under decision 47.

    The escape hatch is decision 51's, unchanged: mark the row as not importing. The difference from an automatic skip is only that a person does it, having seen what they are dropping.

    Neither rule applies to the notes sheet. It has no average, and `InterviewNotes.interviewerName` is nullable because only one interviewer of the pair writes the notes. §5 marks it nullable as of the reconciliation pass; the schema always did.

61. **`InterviewCategory` ids are preserved across a rubric edit, amending clause 12a-5's "replace-not-diff." RESOLVED:** an edit updates existing rows in place and only adds or removes rows for categories actually added or removed, rather than deleting and recreating the whole set. Same ruling §5 already made for `FieldGroup.key`, and the reason is the same: a staged FR-12 mapping references `InterviewCategory` ids, and regenerating them on every save silently invalidates any in-progress mapping, which is exactly the "Not imported" regression this decision fixes. The rubric page also warns when a scores sheet is staged, naming that changing categories will need the mapping re-done — a real cost of editing after upload, stated rather than discovered.

    Found by the owner clicking through, not by review: a typo in one category name was corrected, and all four columns of an already-staged sheet came back unmapped — the three untouched ones because their ids had changed underneath the mapping, the corrected one because it had never matched. The failure was safe rather than silent (`parseRole` degrades an unknown id to `IGNORED`, `validateMapping` then refuses the commit, and the importer builds category ids from the live rubric rather than from the mapping), so no wrong data was reachable — but a dead end an admin reaches by doing something entirely reasonable is still a defect.

    **A self-healing re-proposal was considered and rejected.** Re-matching a stale id by header text would have hidden this instance and any future one, and the phase's practice is to surface a real problem rather than let a second mechanism quietly mask it. Preserving identity removes the cause; re-proposing would only have removed the symptom.

    The immediate consequence is that reordering can no longer be a wholesale replace: `@@unique([instanceId, ordinal])` is not deferrable, so a save parks the surviving rows on temporary ordinals before writing their final ones.

62. **The first-round dashboard shows a reviewer's vote progress, not required by FR-14's text. RESOLVED: "voted on N of M",** matching the completion count Phase 3 already established for the written round. A first-round reviewer votes on every applicant in the pool with no assignment narrowing it, so the navigational aid FR-9 already gives written reviewers applies at least as much here. **Load-bearing under decision 113**, which moves the vote itself off the list: this counter and the per-row marker of the reviewer's own vote are what the list keeps, and they are why the first round does not inherit decision 82's cost statement along with its pattern.

63. **A first-round vote can be changed after submit, up until FR-15's finalize. RESOLVED:** the schema already permits it — `FirstRoundVote` has no immutability, and its `updatedAt` exists for this. FR-17's rule against reopening a vote is scoped to a closed pass, which the first round is not; nothing analogous closes it here before finalize. Resubmitting updates the existing row via the unique constraint rather than creating a second one. Disallowing revision would make a misclick permanent for the rest of the round, which is the exact loss decision 26 already treats as unacceptable in the written round.

64. **"This round is over" and "nothing has reached this round yet" must not read the same. RESOLVED: the first-round reviewer dashboard distinguishes them, using `Instance.currentStage`.** FR-15's finalize moves every applicant out of the pool — advanced to `stageReached = SECOND_ROUND`, rejected to `status = REJECTED` — so the reviewer's list empties itself. That is correct, and the message it produced was not: a reviewer opening the app the morning after the round closed was told "nobody has reached the first round yet", which is what the screen says *before* the round opens. The same empty list means two opposite things and the difference matters to the only person who ever sees it.

    `Instance.currentStage` is what separates them, exactly as decision 43 made it load-bearing for FR-11's read-only `/results`. Past `FIRST_ROUND` means the round is finished; still on `WRITTEN` means it has not started. **This is a second reader for the field decision 43 added**, which is the argument for having moved it rather than inferring the stage from applicant rows.

    Any vote still in flight is refused by the existing pool re-check in the vote action rather than by a new rule — an applicant who has left the round is not votable, whatever the screen was showing when the tab was opened.

65. **`InterviewResult` ids do not survive a re-import. RECORDED as a consequence of decision 47's upsert, not fixed.** A re-committed sheet deletes and re-inserts `InterviewResult` and its `InterviewCategoryScore` rows rather than updating them in place, so the upsert key `(applicantId, interviewerName)` is respected and nothing is duplicated, but the row ids are new. Confirmed against the database after a real second import: twelve results, forty-eight category scores, no duplicates on the key and none after case-folding, and a single shared `createdAt` showing the rows had been replaced.

    **Nothing references these ids today, which is why this is recorded rather than fixed.** Every reader reaches a result through its applicant. The delete-then-insert shape is deliberate — it is what keeps the commit to a fixed number of bulk statements instead of one upsert per row, which is the pattern FR-11's finalize adopted after 150 sequential round trips exceeded Prisma's transaction limit.

    **It is the same instability decision 61 had to fix one table over**, and it is where a future feature breaks. Anything that needs to refer to a particular interview result across a re-upload — a comment thread on an interview, an audit trail of who changed a score, a flag on a disputed number — would silently lose its referent the next time a corrected sheet is imported. The fix, if that day comes, is decision 61's: match existing rows on the upsert key and update them in place. Doing it now would buy nothing and cost the bulk-statement shape.

66. **A reviewer cannot be added to the second round once it has started. RESOLVED.** Second-round pass membership is every reviewer with `SECOND_ROUND` in `rounds` — fixed, not timing-dependent, because the roster cannot change after the round begins. The reviewer roster page must refuse adding `SECOND_ROUND` to a reviewer's `rounds` once `Instance.currentStage` reaches `SECOND_ROUND`. This replaces the "reviewer added mid-round" row in §7.4's edge case table, which described a situation that can no longer occur. **Amended by decision 84: the lock moves from `currentStage` to the creation of the first pass.**

67. **COI-as-skip is computed, never a stored `PassVote` row. RESOLVED.** `PassVote` means a reviewer actually submitted. `lib/passes.ts` computes each reviewer's effective status per applicant per pass from two inputs: actual `PassVote` rows, and the round's `ConflictOfInterest` set. No vote row exists means outstanding, unless the reviewer has an active COI on that applicant, in which case they are SKIP without a row.

68. **Flagging COI on an applicant after already voting on them in the open pass deletes that `PassVote` row. RESOLVED.** The reviewer is SKIP from that point forward, in that pass and any later one. A vote from a reviewer who has since disclosed a conflict cannot be allowed to still count toward unanimity. This is distinct from decision 63 (votes changeable until finalize) — that is the reviewer changing their own mind; this is the system correcting for a known conflict.

69. **A `Decision` row is written at `stage = SECOND_ROUND` the moment an applicant resolves. RESOLVED.** Same table, same pattern as WRITTEN and FIRST_ROUND: `outcome = SPARKLET` or `REJECT`, `actor = SYSTEM` for a pass's own unanimous result, `actor = ADMIN` for a manual reject. This is what FR-20's "decisions by stage" export actually reads for the second round; without it that export has nothing to show.

70. **NEEDS_ADMIN writes no `Decision` row. RESOLVED.** Nothing has been decided yet — that is the entire meaning of NEEDS_ADMIN. A `Decision` row is written only later, whenever an admin actually resolves that applicant, at whatever stage that resolution happens.

71. **Admin's manual reject during an open pass writes `PassApplicant.resolution = REJECTED` on the current pass row immediately, in the same transaction as decision 69's `Decision` row. RESOLVED.** Any other reviewer's vote still in flight on that applicant becomes moot — not blocked, just no longer read by anything, since the applicant is already excluded from future passes. **Reconciled with decision 75 by decision 101.**

72. **Closing a pass writes no resolution; an unvoted row stays `NULL`. RESOLVED.** §7.4 says only that closing "leaves unvoted applicants ACTIVE and carried forward" and does not say what the row records. `CARRIED` keeps FR-17's own meaning — a *completed* mixed vote — and `NULL` keeps §5's, "null until the applicant resolves within this pass". Writing `CARRIED` over an applicant nobody voted on would overload one value with two facts and make the word untrue of half the rows carrying it. The distinction is recoverable either way, since FR-19 keeps the underlying votes visible, but only one of the two readings leaves `resolution` meaning one thing. **See decision 102** for how decision 73's write over `CARRIED` sits with this.

73. **"Still unresolved", in the close-second-round action, means `NULL` **or** `CARRIED`. RESOLVED.** FR-19 finds its Unresolved group by `resolution = NEEDS_ADMIN` and by nothing else, so a `CARRIED` row on the *final* pass — an applicant whose votes were mixed and who had no next pass to carry into — would otherwise be invisible to the only screen obliged to show them. `SPARKLET` and `REJECTED` are never overwritten, which is also what makes the action idempotent as §7.4 requires: the second run matches no rows. **Its relation to decisions 72 and 89 is stated in decision 102.**

74. **Second-round reviewers never see other reviewers' pass votes, closed pass or not. RESOLVED.** §6's matrix said "Hidden until pass closes"; §7.4's resolved open decision says counts are never revealed to reviewers. The latter wins, and §6 is amended by decision 77 below. FR-18 is admin-only and is the only vote-visibility surface any requirement describes; a reviewer-facing closed-pass tally would be a screen nothing asks for and an anchoring vector for the pass that follows it.

    **Reversed in part by decision 111.** Votes and tallies stay hidden exactly as stated above, and FR-18 remains the only surface that renders one. What 111 opens up is the *outcome* of a resolved applicant, which this entry's reasoning also covered without naming it — a terminal outcome is a unanimous tally in a smaller package, so the anchoring vector described here is genuinely reopened rather than sidestepped. 111 states that cost and accepts it deliberately. Read it before concluding the code disagrees with this entry.

75. **A submitted pass vote is changeable until that applicant resolves. RESOLVED.** Resubmitting updates the existing row through `UNIQUE (passId, applicantId, reviewerId)`. The window shuts on its own: an applicant resolves only once every eligible reviewer has submitted, and from that point the control is gone. §7.4's rule against reopening is scoped to a closed *pass*, and decision 26's reasoning about misclicks applies here exactly as it did in the written round. **Amended by decision 101** (a manual reject closes the window the same way a resolution does) **and decision 105** (a lifted conflict does not reopen a `CARRIED` row).

76. **An admin can remove a conflict of interest, audited. RESOLVED.** Reviewer flags stay one-way — FR-16 says "sticky", and decision 68 has already deleted the vote, which does not come back. Removing the flag returns the reviewer to the denominator as *outstanding*, so the applicant needs a vote they did not need a moment ago. This is what makes an all-COI `NEEDS_ADMIN` recoverable inside the open pass rather than only in the next one, and it is why `NEEDS_ADMIN` is recomputed while a pass is open instead of being treated as final. A terminal row is never reopened by it: an applicant who resolved SPARKLET with two conflicts on the board stays SPARKLET when one is removed, the same rule that protects a manual reject. The control lives on FR-18's grid and nowhere else — the grid is the only surface that renders conflicts at all, and it renders them exactly where the question gets asked, on a `skip` cell in a row that will not resolve. **Amended by decision 103** ("nowhere else" means the only control; a withdrawal under decision 85 also removes conflicts, recorded on the withdrawal's audit row) **and decision 105** (a `CARRIED` row is not reopened either).

77. **§6's "Other reviewers' scores/votes" row splits in two. RESOLVED.** FR-16 lists "written scores" among what a second-round reviewer sees, and §6's single row hid "other reviewers' scores" from everyone but an admin — the same rows, granted by one sentence and refused by a table two sections above it. The row was carrying two different questions at once. Split, both are answerable: prior-round evidence is visible to a second-round reviewer, and the votes being cast *now* are not. The anchoring risk decision 3 named is about the latter. The existing "Interview scores" and "Interview notes" rows already answer the interview half and are untouched, so nothing in the matrix says two things about one field.

    Two consequences the split settles. **Written review notes are visible**, which FR-16's list omitted: `ReviewNote` holds a written reviewer's reasoning, and "the complete applicant profile" opens that list rather than closing it. And **the scores are attributed, not anonymized.** Both surfaces that already render someone else's evaluation name its author — FR-14 gives a first-round reviewer "the average interview score per interviewer", and FR-11's admin applicant view names the written reviewer beside both their average and their note. An anonymized second-round profile would be the only place in the product that hides a scorer, and the argument for hiding it — social pressure, with the scorer sitting in the room — is the wrong way round for this round specifically. The second round is a deliberation: the value of knowing who gave the 2 is that they are present and can be asked why. Anonymity is the written round's rule, and it protects the applicant, not the reviewer.

78. **A reviewer cannot be withdrawn from the second round once it has started, the symmetric half of decision 66. RESOLVED.** 66 blocks the add and says nothing about the removal, and `removeReviewer(..., SECOND_ROUND)` works today. Withdrawing a reviewer mid-round shrinks the unanimity denominator retroactively and cascade-deletes their `PassVote` rows: an applicant sitting at 10 YES and one outstanding becomes unanimous the instant the outstanding reviewer is withdrawn — silently, from a screen that mentions no passes. Same rule, same page, same reasoning as 66. Removing them from the written or first round is unaffected; those rounds are over and nothing recomputes over them. **Amended by decision 84** (the lock moves to first-pass creation, so a withdrawal before pass 1 is permitted) **and decision 85** (a withdrawal that does happen deletes that round's `ConflictOfInterest` rows).

79. **Pass creation is blocked against an empty second-round roster. RESOLVED.** §7.4 blocks creation with zero ACTIVE applicants and is silent on zero reviewers. With no electorate, every member has no eligible reviewer, so the pass resolves wholly to `NEEDS_ADMIN` the moment it is created — a pass that decides nothing and flags everyone, which is indistinguishable at a glance from the all-COI case it is not. Blocked, with the same shape of message as the zero-applicant block: name the fix, which is the reviewer roster.

80. A reviewer who stops voting mid-round has no removal path. RECORDED
as a consequence of decision 78, not fixed. Every applicant they haven't
voted on stays outstanding under them until they vote, the admin manually
rejects that applicant (17l), or the round closes into NEEDS_ADMIN. This
is decision 78 working as intended — the alternative is the silent
unanimity shift 78 exists to prevent. No tool is added for it in v1.

    **Decision 115 records a hole of the same shape**, and for the same reason: a rule enforced on the way in rather than held as an invariant over everything already written. Both are recorded rather than fixed, and both name the remedy in the entry.

81. Pass creation is refused when Instance.currentStage is not
SECOND_ROUND. RESOLVED, built beyond FR-17's clause list. §7.4's close
rule — "so a COMPLETE instance cannot hold an OPEN one" — is the same
invariant read forward: creation is blocked before SECOND_ROUND for the
identical reason it's blocked after. Same guard function as 17c, 17w,
and decision 79, checked in the same place.

82. **A second-round reviewer votes from the applicant's profile, not from the list. RESOLVED.** FR-16's list is a reading and recusal surface; the vote control lives on the profile and nowhere else, and the list renders no vote state of its own.

    **This is deliberately not an application of the every-tap-counts rule.** That rule governs fast, independent review surfaces — FR-14's first-round list, where a vote is a reaction to two numbers and a paragraph, and where an extra tap really is a review that does not get completed. Second-round voting is not that surface. §7.4 and FR-16 both frame this round as reading the complete applicant profile — the reviewer-visible fields, written scores and notes, interview scores and notes; demographics until decision 108 removed them — and deliberating over it, and FR-17 requires an explicit submit for exactly that reason. **Requiring the profile to be open before voting is the correct tradeoff, not friction to be designed away.** A vote cast from a row nobody opened is the outcome the requirement is written to prevent, and saving a tap to allow it would be optimizing the wrong quantity.

    The conflict control stays on the list, and that is not an inconsistency. A reviewer recuses because they recognized the name, which happens on the list; if the only way to declare a conflict were the profile, declaring one would mean first opening the demographics and essays of the person you are recusing from. Recusal is triggered by the row, voting is triggered by the profile, and each control sits where its trigger is.

    **What this costs, recorded rather than hidden:** with no vote state on the list, a reviewer part-way through a pass cannot see at a glance which applicants they have already voted on. Accepted for v1 — the pass is worked through in one deliberation rather than resumed across sittings, and adding a per-row marker later is additive and breaks nothing. It would show only the reviewer's own vote; decision 74 forbids showing anyone else's, closed pass or not.

    Consequence for the build: `plans/phase-6.md`'s Slice 8 line said "the vote control on both FR-16 surfaces" and is narrowed to the profile by this decision.

    **The second paragraph above is amended by decision 113, which found its premise false.** It contrasts this round against "FR-14's first-round list, where a vote is a reaction to two numbers and a paragraph". The built first-round row shows no numbers and no paragraph — it shows a summary of what interview data exists, and links to the page holding it — so the contrast was drawn against a screen that does not exist. 113 moves the first-round vote onto the profile using this decision's own argument. The conclusion for the *second* round is unchanged; only the comparison was wrong.

    **The cost statement is amended by decision 112.** Resolved applicants now stay on the list carrying their outcome, so a reviewer can see at a glance which applicants the pass has finished with. What is still unmarked is their own *outstanding* votes, which is the narrower version of what that paragraph accepted.

83. **The vote submission response names no outcome, not just no count. RESOLVED.** A successful pass vote returns "Vote recorded." and nothing further. It does not say the applicant became a Sparklet, or was rejected, or that the pass has moved on from them; the control's settled state says the pass has finished with this applicant without saying which way it went. **Corrected in part by decision 83a below: the claim further down that a resolved applicant leaves the reviewer's list holds for terminal outcomes only, not for `CARRIED`.**

    **This is decision 74 applied to a new surface, not a separate judgement.** 74 keeps other reviewers' pass votes from a reviewer, closed pass or not, and §7.4 says counts are never revealed. An outcome is the same fact in a smaller package. An applicant resolves only when every eligible reviewer has submitted, so "this applicant is now a Sparklet" tells the reviewer who cast the last vote that *every other eligible reviewer voted yes* — a complete reading of the tally, derived without ever seeing one. "Rejected" says the same in the other direction, and even a neutral "the pass has moved on" reveals that theirs was the final outstanding vote and that the result was unanimous either way. The leak arrives through the submission response instead of through a tally, and the response is the surface nobody thought to check, because it feels like feedback rather than data.

    **What this costs, on the same terms 74 already accepted:** a reviewer gets no confirmation of what their vote did. They are told it was recorded and nothing more, which is less than any other submit action in the product gives back. That is the price of 74, paid at the moment it actually bites rather than only in the places it was easy to pay. Two things soften it without breaking the rule: the vote itself is echoed back ("You voted yes"), which is their own data, and a resolved applicant simply leaves their list, which reveals that a decision happened but not what it was or how anyone else voted.

    The admin's FR-18 grid is unaffected and remains the only surface in the product that renders a pass vote.

    **Reversed in its outcome half by decisions 111 and 112, still correct in its count half.** The submission response may now name the outcome, because the page it returns to renders that outcome anyway and a silent confirmation over a green profile is a distinction with no difference. Nothing this entry says about *why* an outcome is a complete tally is disputed by 111 — it is quoted there and accepted as the price. The response still names no count, no tally, and no other reviewer.

83a. **Correction to decision 83's "leaves their list" claim. CONFIRMED BY GATE.** That claim is true for terminal outcomes — `SPARKLET` and `REJECTED` — where the applicant leaves the reviewer's list. It is **false for `CARRIED`**: that applicant stays present on the reviewer's list, and their profile shows a settled control in place of the vote control. The settled control is on the profile, per decision 82; the list renders no vote state, so 82's cost statement stands.

    This does not weaken 83's reasoning. "Settled but still present" reveals only that a mixed result occurred — not which reviewers voted which way, and not what the vote was. That is the boundary 83 was actually protecting, and it holds.

    The original wording overclaimed uniform disappearance. `CARRIED` was the one resolution that does not behave that way, and the gate is what found it.

    **Superseded by decision 112, which removes the disappearance this entry was correcting.** With every applicant staying on the list there is nothing left for `CARRIED` to be an exception to, and the carve-out becomes the general rule. What 112 keeps from this entry is that a settled control reveals only that a result occurred — for `CARRIED` and `NEEDS_ADMIN` that is still all it reveals, and only terminal outcomes carry a colour.

84. **The second-round roster locks when the first pass is created, not when the round begins. RESOLVED, amending decisions 66 and 78.** Both of those fixed the roster at `Instance.currentStage = SECOND_ROUND`. The trigger moves to the existence of a `Pass` on the instance: before the first pass exists the roster is freely editable in both directions, and from the moment pass 1 is created it is completely fixed, adds and removals alike. Same single hard cutover 66 and 78 already describe — moved to the condition that actually carries their reasoning.

    **What 66 and 78 protect is a denominator with votes riding on it.** Adding a reviewer mid-round changes how many votes it takes to decide an applicant; withdrawing one shrinks the denominator retroactively and can make an applicant unanimous the instant they leave. Both of those are facts about a pass that is already open. **Before any pass exists there is no denominator and no vote in flight, however many reviewers are listed**, so the old trigger was locking against a risk that had not yet come into being.

    **This closes a dead end that was reachable in the built product.** FR-15's finalize moves `currentStage` to `SECOND_ROUND` and does not require a second-round roster to exist first. An admin who finalized without one landed in a state where decision 79 blocked pass creation until reviewers were added, and decision 66 refused to add them because the round had started — two guards that are mutually exclusive by construction, with no path out inside the product. The second round simply could not be run. Decision 79's message ("add reviewers to the second round before creating a pass") named the fix correctly and the application refused it; under this decision the message becomes true.

    **Decision 115 adds a second, independent guard to the same page, and conflating the two would give one guard two jobs.** This one is a *time* lock: the roster freezes once a denominator has votes riding on it. 115 is a *membership* rule — a later round is staffed only from the earlier round's roster — which holds from the moment the instance exists, in every round, pass or no pass. They are checked in that order, this one first, because a frozen roster makes eligibility moot and an admin who trips both should be told the roster is fixed rather than sent to go add someone to the written round.

    **Why not "unlock while the roster is empty".** That was the smaller change and it does not work: it permits exactly one add before re-engaging, so an admin still cannot build out a roster of eleven. The condition has to be about whether voting has begun, not about how many names are on the list.

    A `COMPLETE` instance stays locked without a special case: closing the second round is blocked unless a pass exists (FR-17), so every `COMPLETE` instance necessarily has one. The written and first-round rosters are untouched by this and by 66 and 78 — those rounds are over and nothing recomputes over them.

    Consequence for the build: `secondRoundRosterIsFixed` reads whether the instance has any `Pass`, rather than reading `currentStage`. The refusal messages keep 66 and 78's reasoning but name the pass rather than the round.

85. **Withdrawing a reviewer from `SECOND_ROUND` deletes their `ConflictOfInterest` rows for that round. RESOLVED.** Matches how assignments are already handled on withdrawal — round-scoped records do not outlive the reviewer's membership in the round.

    Decision 68's "sticky across all passes" governs a conflict staying in force while the reviewer *remains active and eligible to vote*; it says nothing about what happens once they are removed from the round entirely, and nothing in its reasoning is protected by keeping an orphaned row around. The alternative — retaining it — creates the actual problem: a withdrawn-then-re-added reviewer returns with old conflicts silently reattached, which the admin has no way to see or explain. If a returning reviewer still has the conflict, they re-flag it; that cost is trivial.

    This also resolves the roster-blind conflict count on the hub and the passes page as a side effect, since an orphaned row can no longer exist to be miscounted.

    Deleting the reviewer outright already did this: `ConflictOfInterest.reviewer` is `onDelete: Cascade`, so a full delete has always taken the conflicts with it. This decision makes the round-scoped withdrawal behave the same way, which is what decision 84 made reachable — before it, the roster locked at the moment the second-round dashboard became usable, so flagging a conflict and then being withdrawn could not both happen.

    No separate audit entry: the withdrawal already writes one `AuditLog` row for the removal inside the same transaction, and the deletion is part of that action rather than a second one. **Read with decision 103**, which narrows decision 76's "nowhere else" to the control and records that this row carries the deleted-conflict count.

86. **Export includes `Instance.passwordHash` and `RoundAccessCode.codeHash`. RESOLVED.** CLAUDE.md rule 4 says password hashes are never returned in an API response. FR-20's export is a deliberate exception: the values are argon2id hashes, not recoverable passwords, and omitting them would make a restored instance unusable without a manual reset of both credential types, plus two permanent exceptions in the export/reimport comparison. The export route is admin-only and the file itself is sensitive for this reason, which `ADMIN_GUIDE` (Phase 8) must state.

87. **FR-20's reimport is a verification script, not a product surface. RESOLVED.** FR-20 names export and nothing else. The gate needs a reimport in order to prove the export is complete, which is a property of the artifact rather than a user story. An admin route accepting an uploaded file and writing password hashes and applicant data straight into the database would be the most dangerous surface in the product, and it would have none of the staging-preview-commit machinery FR-2/FR-3 and FR-12 both insist on for far less consequential imports. The lock-in FR-20 exists to prevent is about the JSON being open and complete, not about this tool being able to load it back.

    `prisma/checks/round-trip.ts`, run by hand like the other scripts in that directory: it needs a seeded database, it writes to it, and it cleans up after itself.

    **Recorded cost:** a club holding the export file and no developer cannot restore a backup unaided. If that day comes, the restore path already exists in `lib/instance-io.ts` and the missing half is a guarded upload page rather than a rewrite.

88. **A restore preserves every id verbatim. RESOLVED.** Every `@default(cuid())` is written explicitly from the export, so no foreign key is ever remapped and the round trip is an identity. The alternative — fresh ids and an old→new map applied in foreign-key order — is not merely more work, it is **unsound on this schema**, because three places carry ids that are not foreign keys and that no remap can follow safely:

    - `Applicant.data` is a JSONB object **keyed by `Field.id`**. Regenerating field ids orphans every value on every applicant unless the key set is rewritten in step.
    - `InterviewImport.mapping` encodes roles as `CATEGORY:<interviewCategoryId>` inside a JSON string value.
    - `AuditLog.entityId` and `AuditLog.previousValue` hold ids of rows from every table, as plain strings with no schema link to follow. `previousValue` is an arbitrary snapshot of a prior row and can carry any id in the model.

    The first two are rewritable with care. The third is not, and a remap that silently left the audit log pointing at ids that no longer exist would break the one table whose entire purpose is attribution. Preserving ids removes the problem rather than managing it.

    **Restore semantics:** the target instance id must not already exist, and a collision fails loudly rather than merging. Importing one export twice as two instances is not supported and is not what the gate asks for.

    **What this buys the comparison, which is the reason it is a decision rather than a detail.** With ids preserved, and `createdAt` and `updatedAt` written explicitly from the export, *nothing* in the round trip is expected to differ — so "intact" is an exact field-by-field comparison rather than one carrying a list of exceptions. A comparison with expected drift in it is a comparison a real regression can hide inside.

89. **An applicant an admin has since resolved leaves FR-19's Unresolved group, and their pass row is not rewritten. RESOLVED.** FR-19 finds Unresolved by `resolution = NEEDS_ADMIN` on the final pass, and says the group is identified by that row "never by `Applicant.status`". Decision 70 says an admin who later resolves that applicant writes a `Decision` row. Read together the two contradict: an admin who admits one of them sets `status = SPARKLET`, and the applicant is then in **both** the New Sparklet group (by status) and the Unresolved group (by a pass row nothing has changed).

    The predicate therefore gains one clause: `resolution = NEEDS_ADMIN` on the final pass **and no `Decision` row at `stage = SECOND_ROUND`**. The admin's admit-or-reject writes that `Decision` row, `Applicant.status`, and an `AuditLog` row in one transaction, and leaves `PassApplicant.resolution` alone. FR-19's rule that the group is found by the pass row and never by status survives intact; what is added is a second question — *has this been dealt with since* — answered by the table that already exists to record exactly that.

    **Rejected: overwriting `PassApplicant.resolution` to `SPARKLET` or `REJECTED`.** It empties the group correctly and destroys the record that the pass itself could not decide them — which is the fact `NEEDS_ADMIN` exists to carry, and which §5 is emphatic is a property of the applicant *within a pass* rather than of the applicant. The admin's decision is a later event, not a correction of what the pass did. **See decision 102** for why decision 73's close-round write is not this.

90. **FR-20's CSV cells are written verbatim, RFC 4180-quoted, with no formula-injection prefixing. RESOLVED.** A cell whose text begins `=`, `+`, `-` or `@` is executed as a formula by Excel and Sheets, and applicant free text can begin with any of them. The usual mitigation is to prefix such cells with a tab or an apostrophe, which alters the exported value. Refused here. Every importer in this system is emphatic that the source wins and the tool does not silently rewrite what a human recorded — FR-12 on a disagreeing average, decision 55 on clamping an out-of-range score, decision 59 on rounding a decimal — and an export that mangled an essay in order to defend a spreadsheet application would be the only place in the product that breaks that rule.

    The JSON is the lossless artifact. The CSVs are convenience derivatives and sit outside the round trip decision 88 defines, because a decision row rendered with an applicant's name in it cannot reconstruct a `Decision`.

    **Recorded consequence rather than left to be discovered:** a cell beginning with one of those characters will evaluate when the file is opened in a spreadsheet. That is a property of the spreadsheet, and the remedy is to import the CSV as text — not to change what the export writes.

91. **A seeded complete second round, reversing `prisma/advance.ts`'s stated position. RESOLVED.** `advance.ts` says in a comment that it creates no `Pass` rows, because "those are what an admin creates on FR-17's screen, and seeding them would develop FR-18 against a state nothing produced." That was right for Phase 6, which was building FR-18 and needed the grid developed against passes a person had actually run. It inverts for Phase 7.

    FR-19 renders the *outcome* of a second round, and `npm run seed:advance` stops exactly where an admin would create pass 1 — so the seed produces no second round at all, and FR-19's three groups, its funnel and FR-20's round trip would every one of them be developed against empty sets. BUILD_PLAN's own Phase 6 record already states that producing the all-COI case through the UI takes twelve reviewer sign-ins, so "drive it by hand each time" is not an available answer either, and whatever is driven by hand does not survive the deleted database the Phase 7 gate requires.

    `npm run seed:passes` writes **exactly what the FR-17 actions write** — the posture `advance.ts` already takes toward `finalizeFirstRound`, and for the same reason: a seed whose idea of a finished round differs from the action's would develop every surface against a state the application cannot produce. It yields all four `PassResolution` values plus `NULL` rows, both `Decision` actors at `stage = SECOND_ROUND`, and a non-empty Sparklet class. `advance.ts`'s comment is updated to point at it rather than left contradicting the repository.

92. **The shared rate-limit store. RESOLVED: one Postgres table, read and written under a row lock.** Decision 19 shipped a deliberate stopgap and listed what it did not cover. This is the answer to the first and last of those bullets; the middle three — the IP as the key, the `unknown` fallback, the refusal to extend a lock — were correct as written and are unchanged.

    A `RateLimitBucket` table keyed by the existing `scope:ip` string. **The state machine does not move into SQL.** `lib/rate-limit.ts` stays pure and keeps every transition it has; it is refactored from a closure over a `Map` into functions over a bucket *record*, so the nine cases that already test those transitions keep testing them. Expressing the machine a second time in a `CASE` expression would create two copies that can disagree about when a key is spent, which is the class of bug the pure-module convention exists to prevent. `lib/rate-limit-store.ts` is the Prisma half, on the same split as `lib/export.ts` / `lib/instance-io.ts`.

    **The row lock is the point, not an implementation detail.** Two simultaneous failures that both read `failures = 3` and both write `4` hand an attacker a free guess per concurrent request — a shared store that lost that race would be a slower version of the same hole. The bucket row is locked in one statement (`INSERT … ON CONFLICT DO UPDATE … RETURNING`) before the verdict is computed. At the volume of a login form the lock costs nothing, and `prisma/checks/rate-limit.ts` asserts the property against the database, since no unit test can reach it.

    **Lockouts are recorded**, which decision 19's last bullet asked for and which the in-process limiter could not do at all. A lockout on the instance password or a round access code writes an `AuditLog` row carrying that instance's id, so it appears in the audit view and in the FR-20 export. A lockout on the app-level gate has no instance and writes `instanceId = null`: durable in the database, but invisible in-app and outside every export, since decision 86's export is instance-scoped by construction. **That gap is stated rather than papered over.** Closing it needs an app-level security view, which no requirement asks for; a successor investigating a suspected attack on the app password queries the table directly, and `ARCHITECTURE.md` says so.

93. **Admin identity on the audit row. RESOLVED: `AuditLog.actorName`, a new nullable column beside `actor`.** Decision 16 resolved the product question — a name prompt at sign-in, carried on the session — and left the schema open. The schema question is sharper than it looks, because **two different columns in this schema are called `actor` and they are not the same kind of thing.**

    `Decision.actor` is `DecisionActor`, the `SYSTEM | ADMIN` enum, and decision 69 gives `SYSTEM` a specific meaning: a unanimous tally resolved this applicant, and no person decided it. **It must never learn a name**, because for half its rows there is no person to name. `AuditLog.actor` is an untyped `String` holding the literal `"admin"` at every call site. Only the second one is in scope here.

    So `AuditLog.actor` keeps carrying the role — `"admin"`, and now `"system"` for decision 92's lockout rows — and a new `actorName String?` carries the name. Keeping them apart means a query can still separate "a person did this" from "the system did this" without matching on strings, which writing the name into `actor` would have destroyed. Rows written before Phase 8 keep `actor = "admin"` and `actorName = null`, and **are not backfilled**: those actions genuinely have no known person behind them, and inventing one would be a falsehood in the one table whose entire purpose is attribution. The audit view renders them as "an admin", which is exactly what §8 could promise before this decision.

    The name is not a credential. It is not checked against a roster, and anyone holding the app password can type anything. It is a signature on a shared account, not a login, and both `ADMIN_GUIDE.md` and the sign-in form say so — a name prompt that looked like authentication would be worse than none, because it would imply a guarantee the shared password cannot make.

94. **Where the retention threshold is configured. RESOLVED: the `RETENTION_CYCLES` environment variable, default 2.** §8 says "configurable" and recommends two cycles without saying where the number lives. It is an environment variable, read once and displayed on the archive screen so an admin acts on a figure they can see rather than one they assume.

    **Deliberately not an in-app setting.** Everything else reachable behind the app-level gate is additive or reversible; §8's own gate is one password shared by 2–6 people. A threshold editable from that side of the gate could be set to 0, and the retention control becomes a delete-everything button operated by whoever has the Slack message with the password in it. Configuration that determines how much data gets destroyed belongs with deployment, not with routine admin access.

    The cost is real and worth naming: changing it means a redeploy, and a successor has to know the variable exists. `.env.example` carries it with its default and `ARCHITECTURE.md` names it, which is the whole of the mitigation.

    **Reversed by decision 109.** `RETENTION_CYCLES` no longer exists, in the code or in `.env.example`. Retained as a record of the reasoning, not as a description of the system.

95. **What archive-and-purge keeps, what it destroys, and what "older than N cycles" means. RESOLVED.** §8 gives the requirement in one sentence — "keeps aggregate statistics and deletes essays, emails, and demographics for cycles older than a configurable threshold" — and every operative word in it needed a definition.

    **Ordering.** Instances sorted by `createdAt` descending; the newest `RETENTION_CYCLES` are retained and everything past that rank is a candidate. The **cutoff date** is the `createdAt` of the oldest retained instance. Below `RETENTION_CYCLES` instances there are no candidates and no cutoff.

    **An already-archived instance is never a candidate, and a second purge is refused outright.** Both, because either alone is a trap. Rank is computed over `createdAt`, so a purged instance re-enters the candidate list as soon as enough newer cycles exist — and a second purge would then recompute the summary against the `Applicant.data` the first purge emptied, overwriting a correct frozen record with zeros. It would do so *silently*: every row it reads is legitimately present and legitimately empty, so nothing would fail. `retentionCandidates` therefore refuses candidacy for any instance carrying `archivedAt`, **and** the purge re-reads `archivedAt` inside its own transaction and refuses rather than trusting the list that sent it there. The candidate list is a UI affordance; the one irreversible action here does not get to depend on one for its safety.

    **Destroyed.** `Applicant.email` → null; `Applicant.data` → `{}`; `Applicant.displayName` → `Applicant <sourceRowIndex>`, the anonymous label written reviewers already see, which keeps a non-null column meaningful instead of filling it with a placeholder. `ImportRow` and `InterviewImportRow` rows deleted outright — their `cells` hold the verbatim CSV, which is every essay, address and demographic answer in its rawest form, and is the copy most easily forgotten. `ReviewNote` and `InterviewNotes` deleted. This instance's `AuditLog.previousValue` → null, since §8 already records that those payloads can carry applicant data.

    **`RoundAccessCode` rows are deleted** — the rows, not the column, because `codeHash` is non-null and making it nullable would be a schema change describing a state only the purge produces. The reasoning is worth stating because the opposite reasoning applies one line below: the *only* code path that reads `codeHash` is `signInReviewer`, and an archived cycle has nothing for a reviewer to do, so keeping them would leave a live credential to a purged cycle behind no route that reads it. **`Instance.passwordHash` is kept precisely because it does still have a reader**: the archive summary sits behind `requireInstance`, so opening an archived cycle still means typing its password.

    **Kept.** Every score, vote, decision, assignment, pass and resolution: they are numbers and outcomes, and they are the substrate the retained aggregates rest on. `Field` and `FieldGroup` keep their header text — that is the club's own form, not an applicant's answer. `Reviewer` names are kept; §8 names essays, emails and demographics, and reviewers are club members rather than applicants.

    **The aggregates are materialized before the purge, never computed after it.** FR-19's demographic funnel is computed from `Applicant.data`, which this purge empties — so a purge that did not freeze the funnel first would destroy the very "aggregate statistics" §8 says to retain, and would do it while appearing to comply. `buildArchiveSummary` renders the funnel and the stage counts into `Instance.archiveSummary` inside the same transaction, before anything is deleted. It reuses `buildFunnel` and `lib/demographics.ts` rather than recomputing: §10.7 requires the checked predicate and the 1/n weighting live in exactly one place.

    **An archived instance is read-only, on both gates.** Its live screens would render blank names and empty essays beside real scores, which reads as data loss rather than as retention. `requireInstance` redirects to the archive summary. **`requireReviewer` gets the same check independently** — the reviewer gate never passes through `requireInstance`, so the admin-side redirect does not cover it, and a reviewer holding a cookie issued before the purge would otherwise reach a dashboard of blanked applicants. Deleting the access codes closes new sign-ins; this closes the sessions already outstanding.

    **Four surfaces stay reachable on an archived cycle**, and each is exempt for its own reason rather than as a group:

    - **The archive summary itself.** It is the redirect target; routing it through the same check would loop it to itself.
    - **Settings**, which gates on `requireAdmin` alone anyway, so that FR-5's recovery path survives — an admin who has lost the instance password must still be able to reset or delete a cycle, archived or not.
    - **The FR-20 export.** It is the escape hatch an archived cycle most needs, and it is why `Instance.passwordHash` is kept above rather than purged with the access codes.
    - **The audit view.** Two reasons, and both are specific to what the purge does. The purge nulls every `previousValue` on the cycle, so a post-purge audit row carries no applicant data — the category that made this page gate on `requireInstance` rather than `requireAdmin` in the first place is exactly the category the purge has already removed. And the log is the cycle's history, of which the purge is now part: the `ARCHIVE_AND_PURGE` row naming who ran it and what it destroyed is written into this table, and hiding the one page that renders it would leave the most consequential act in a cycle's life visible only in a JSON export.

    The exemptions are implemented as a second gate, `requireInstanceUnlocked`, rather than as a flag on the first. Anything that mutates, or that renders applicant data the purge emptied, calls `requireInstance` and gets the redirect. Reaching for the weaker gate to make a page load is the mistake this split is shaped to make obvious.

    **Orphaned audit rows.** §8 requires the instance-deletion records — `instanceId = null` by design — be aged out on the same threshold. They belong to no cycle, so cycle rank cannot apply to them: rows older than the cutoff date above are deleted. Decision 92's app-level lockout rows age out by the same rule, which is the only thing that keeps them from accumulating forever.

    **Reversed by decision 109.** Every surface, module and column described above has been deleted, and §8 no longer asks for any of it. Retained as a record: the reasoning about materializing aggregates before a destructive step, and about a UI affordance not being a safety mechanism, outlives the feature. Note that this entry is where the orphaned-row sweep came from, and 109 accepts its loss — those rows now accumulate.

96. **Not every table belongs to an instance, and the export manifest has to say which. RESOLVED: an explicit `NON_INSTANCE_TABLES` list.** `lib/export.test.ts` asserts *set equality* between the models in the generated Prisma client and `EXPORT_TABLE_NAMES`, so that a table added to the schema cannot be silently dropped from FR-20's export. Decision 92 adds the first table that is genuinely not instance-owned, which means that assertion now fails for a correct reason.

    The fix is a second named list, not a widened comparison. `RateLimitBucket` is its first entry: it is keyed by client address, belongs to the deployment rather than to any cycle, and a restore that recreated one deployment's lockouts inside another's database would be incoherent. The guarantee the test was written for survives intact — a new table still fails `npm run verify` until someone decides, **in writing and in the repository**, which side of the line it falls on. A widened comparison would have made that decision implicit and unrecorded, which is what the original assertion existed to prevent.

97. **The demo material. RESOLVED: a small generated CSV plus one completed reference instance.** BUILD_PLAN's Phase 8 asks for "a demo instance with synthetic data for training" and its gate asks a board member to run "a complete mock cycle, start to finish". At 150 applicants and 30 reviewers those two are in conflict: a full cycle at production scale is not clickable in one sitting, and a trainee who shortcuts the scoring is no longer testing the documentation.

    So `npm run seed:demo` produces two things. `prisma/fixtures/demo-cycle.csv` — 25 rows, generated from the existing `prisma/seed/corpus.ts` and `prisma/seed/applicants.ts` under a fixed seed, against the real 37-column header row — is what the trainee imports as their own cycle, which is what makes the gate cover FR-1 through FR-5 rather than starting after them. A second instance, carried all the way to `COMPLETE`, is the reference they compare against when a screen does not look the way the guide says.

    **No second synthetic dataset**: same corpus, same generators, same safety properties as the existing fixtures (`example.com` addresses, every free-text cell prefixed `SYNTHETIC`). A second body of fake applicants would be a second thing to keep honest, and the first one already has a README enumerating every hazard it deliberately contains.

    **The two halves are deliberately different sizes, and only the CSV is small.** The demo CSV is 25 rows because a trainee clicks through every one of them. The reference cycle is seeded at production scale — 150 generated applicants plus the eight pinned reconciliation identities, 158 in all, and 30 reviewers — for two reasons.

    The first is mechanical: `prisma/advance.ts` and `prisma/passes.ts` are written against real cohort constants (`FIRST_ROUND_ADVANCE_COUNT`, `SECOND_ROUND_ADVANCE_COUNT`, the pass plans in `prisma/seed/passes.ts`), and running them over 25 applicants asks for more advancing applicants than exist. Making those proportional means rewriting the seed's internals, which is exactly what this decision's "reuse the existing seed rather than building a second synthetic dataset" rules out.

    The second is that it is better this way, not a compromise. **The reference exists to be looked at, not clicked through**, and a finished cycle at real scale is a more faithful picture of what a real one looks like: 158 applicants narrowing to 7 Sparklets, a funnel with enough people in it for the demographic shares to mean anything, and a second round whose pass structure is not degenerate. A 25-applicant reference would show a trainee a shape no real cycle has. The thing they compare their own work against should be the real thing.

    So: **screenshots in `ADMIN_GUIDE.md` come from the 25-row CSV**, since that is what a board member actually does in the gate. The reference cycle is what the guide points at when it needs to show a finished funnel or a resolved pass.

98. **FR-7's floor repair: every light reviewer, no forbidden pair, preserved rows immovable. RESOLVED.** Three defects in `evenOutToFloor`, found by a cold audit of `lib/assignment.ts` and confirmed by running the module (`plans/prd-reconciliation.md`, items A1, A2 and A18).

    **(1) The repair depended on roster order.** It took the first reviewer below the floor in array order and abandoned the whole repair when *that* reviewer had no legal swap, without looking at any other. The same input with the roster reversed changed one reviewer's load from 10 to 14 against a floor of 14; a 7-reviewer, 27-applicant roster left a non-Sparklet at 9 against a floor of 11 with a legal swap available, because a Sparklet ahead of them in the array had none. FR-7 says the exemption "is a property of the assignment, not of the reviewer"; array position is neither. The loop now visits every light reviewer and stops only when none of them has a swap.

    **(2) The swap search ignored the forbidden set**, so it re-created RETURNED_TO_POOL pairs that the fill had correctly refused, against decision 23: three reviewers, ten applicants, one reviewer having returned seven of them, and the plan put that reviewer back onto four. At the database that pair collides with the surviving RETURNED_TO_POOL row's unique index — the regeneration deletes only ACTIVE rows before inserting — so the symptom would have been a regeneration failing with a raw constraint error, not a silent re-pairing. The search now honours the same forbidden set the fill does.

    **(3) FR-7's precise form quantified over "any reviewer `s` assigned to `a`"**, and the code and its test only ever considered generated rows, because FR-8 forbids removing a manual assignment. That was the right reading and is now FR-7's text: `s`'s assignment must be a generated one, and a reviewer whose only route up runs through a preserved row is exempt on the same terms as the Sparklet case. The floor itself is still measured over everything a reviewer carries.

    Also recorded from the same audit: under decision 2's relaxed rule, Sparklets stay under the ordinary ceiling. The one-per-applicant rule is what is meant to bound them, and with no preserved rows the two bounds cannot bind at once — the arithmetic is in the reconciliation plan — so this states the current behaviour rather than changing it.

    **Why the suite missed all three.** The invariant helper in `lib/assignment.test.ts` already checked the right predicate; every roster in the suite was either comfortably feasible, where the repair never fires, or uniformly saturated, where every light reviewer is swap-less. The breaking shape is a light reviewer with a swap standing behind one without, which is exactly what a returned pair on a small roster produces. Two regression tests now pin order-independence and the no-forbidden-pair property, both built from the cases above.

99. **Generation reports what it could not place, and the report counts what was actually pooled. RESOLVED: the plan is placed and the shortfall is named.** `generateAssignments` broke out of the fill when no candidate remained and returned nothing to say so. The precheck is capacity arithmetic: it does not see returned pairs or the fill order, so `feasible: true` was never a guarantee that the fill completes. Demonstrated: an applicant returned by every reviewer on a three-reviewer roster ends with zero reviewers, the plan is three slots light against `assignedSlots`, and the action's success message reads normally. FR-7's "the system must not silently violate a constraint" is exactly this case.

    The plan gains a `shortfall` list — applicant, slots wanted, slots got — and the action names the applicants and the count in its result and its log line, and does not call the run a success when the list is non-empty. **The plan is placed rather than refused.** Refusing, as the precheck refuses an infeasible roster, would let one applicant nobody can be assigned to block the whole round with no in-product way out except assigning by hand and regenerating; placing the four hundred-odd correct assignments and handing the admin a named list to fix through FR-8 is what they would do anyway, one step sooner. The cost is stated: for as long as the shortfall stands, an applicant sits below FR-7's invariant in the database, and the assignments page says so.

    Same family, same slice: `shortApplicantCount` and `fullApplicantCount` were fixed to `poolSize` in `planShape`, but `prepare` chooses fewer applicants to short when preserved rows leave fewer than `poolSize` shortable. Three reviewers, ten applicants, eight fully preserved: the report said three short and 27 assigned, the plan had two short and 28, and the admin-facing message rendered the report's number. Both counts are now derived from the short set actually chosen, and FR-7's pool sentence says what a regeneration with preserved rows does.

100. **A closed pass is read with the conflicts that existed when it closed. RESOLVED.** Conflicts are round-scoped and sticky (FR-16, decision 68) and carry no pass dimension (decision 67), and every reader — FR-18's grid, FR-19's tallies, the applicant's pass history — passed the round's whole set to every pass. A conflict flagged in pass 3 therefore rendered as SKIP over a YES stored in pass 1, moved pass 1's tally and its recomputed resolution, and moved FR-19's "why unresolved" phrase from incomplete to all-recused. It could also be flagged *after* the round had closed: `flagConflict` checked only that the applicant was still ACTIVE, which every unresolved applicant in a COMPLETE instance is, and the reviewer list still linked to them. No stored resolution was ever rewritten — decision 68's deletion and decision 76's recompute are both scoped to the open pass — which is why nothing was decided wrongly. What was shown was.

    **Time-scoped at read, through one helper.** For a closed pass the readers use the conflicts whose `createdAt` is at or before the pass's `closedAt`; for the open pass, the full set. The scoping lives in one function in `lib/passes.ts` that FR-18, FR-19 and the pass history all call, so the three cannot disagree about what a cell says. Both columns already exist, so there is no schema change. `flagConflict` refuses once the instance is COMPLETE, and says the round is over.

    **What this does not restore, stated rather than left to be discovered.** A conflict an admin removed under decision 76 leaves no row, so a closed pass whose conflict was later lifted renders as if it had never existed. Accepted: 76 already forbids a lifted conflict from reopening a terminal row, the removal's audit row carries the pair, and the alternative — freezing a per-pass SKIP record at close — is a schema change that writes exactly the stored SKIP row decision 67 forbids. The comment in `lib/passes.ts` that said a conflict and a vote row "in practice never coexist" was false for every closed pass and is corrected with this.

101. **A manual reject closes decision 75's window the way a resolution does; decision 71's "not blocked" describes the in-flight submit. RESOLVED, reconciling 71 and 75.** 71 says other reviewers' votes in flight on a manually rejected applicant are "not blocked, just no longer read"; 75 says the control is gone once the applicant resolves, and a manual reject writes a resolution. Both are true of what shipped, of different things. The reject sets `status = REJECTED`, so the applicant leaves every reviewer's list and their profile no longer resolves — that is 75's control, gone. A submit already in flight when that happens is answered, not refused: the vote action re-checks the pool first and returns "This applicant has already been decided. Nothing was recorded" as a notice rather than an error, and stores nothing — that is 71's "not blocked". No reviewer surface reaches the settled state for a rejected applicant, because the pool check runs first.

102. **Decision 73's write over `CARRIED` is the pass's own terminal state, not the correction decision 89 forbids. RESOLVED, stating 73's relation to 72 and 89.** 72 refuses to write `CARRIED` over an unvoted row so that the value keeps one meaning, a completed mixed vote. 89 refuses to overwrite a pass row with an admin's later decision, because that decision is a later event and not a correction of what the pass did. 73 then has the close write `NEEDS_ADMIN` over `CARRIED` on the final pass. It stands, for three reasons stated here so the three entries read as one rule. First, the close is not a decision about the applicant; it is the round ending, and a `CARRIED` row on a pass with no successor has nothing left to carry into, so "carried" has stopped being true of it. Second, the fact 72 protects survives: the votes on that row are kept, FR-19 renders them, and `unresolvedReason` derives "mixed" from the tally, so an admin reading the Unresolved group can tell a mixed final vote from an incomplete one without the resolution column saying so. Third, 89's principle is about an admin's choice overwriting the pass's record; the close writes what the pass's record now means. One cost is recorded: the close's audit row carries counts only, so the per-row `CARRIED` → `NEEDS_ADMIN` transition is recoverable from the votes and not from the audit log. The two alternatives — closing over `NULL` only with FR-19 reading `NEEDS_ADMIN` or `CARRIED`, or closing over nothing at all — were rejected as two predicates for one group and as a rewrite of a gate-verified path.

103. **Decision 76's "nowhere else" means the only control; decision 85's withdrawal removes conflicts as a consequence, and the withdrawal's audit row records it. RESOLVED, reconciling 76 and 85.** 76 says the conflict-removal control lives on FR-18's grid "and nowhere else" and is audited. 85 has withdrawing a reviewer from the second round delete their conflicts with "no separate audit entry". Read together they looked like a second, unaudited path. They are not: withdrawal is a roster action of which conflict removal is a consequence, and the withdrawal's own audit row already carries `deletedConflictCount` beside `deletedAssignmentCount`, inside the same transaction. Decision 84 also confines withdrawal to before the first pass exists, when no vote depends on any conflict, so the two paths never touch the same live state. 76's sentence is narrowed to the control; 85's "no separate audit entry" stands and now says what the existing entry carries.

104. **Decision 5's "changed by X at Y" indicator never shipped; last-write-wins is the v1 behaviour. RESOLVED, recording the gap.** 5 resolved concurrent admin edits as last-write-wins with a visible attribution indicator. No such indicator exists on any surface. Until Phase 8 there was nothing to attribute to — decision 16 records that `AuditLog.actor` carried a role and no person — and decision 93's `actorName` is the first column an indicator could read. The behaviour today is last-write-wins with no indicator, and at two to six admins working a cycle over weeks it has not been reported as a problem. Recorded as a candidate for a later phase rather than built now: the assignments page would show the most recent audit row's `actorName` and time, which is additive and breaks nothing.

105. **A lifted conflict does not reopen a `CARRIED` row. RESOLVED, amending decision 76.** 76 says removing a conflict "returns the reviewer to the denominator as outstanding" and that "a terminal row is never reopened". `CARRIED` is neither terminal nor mutable: it is a completed vote whose result was disagreement, and `isMutableResolution` refuses to write over it for the reason decision 72 gives, that the value should keep one meaning. So lifting a conflict on a `CARRIED` row in the open pass leaves the row `CARRIED`; the reinstated reviewer sees the settled control on that applicant, and their first vote lands in the next pass, which the applicant carries into. The cost is that a pass can end with a reviewer who was eligible and never voted on an applicant. The alternative — a fourth mutable case that could flip a `CARRIED` row to `SPARKLET` or `REJECTED` after the room had moved on — was judged worse.

106. **v1 has no decision reversal; the reject confirm is the only guard; FR-3's "edit an applicant's fields" path does not exist. RESOLVED, recording the gap, with a narrow reversal named as a near-term priority.** §5's `Decision` comment, §8's audit list and the audit page's copy all described an audited decision reversal. No surface performs one: nothing in the product writes `status = ACTIVE`, and the only writes to a `Decision` row are the pass-vote and manual-reject upserts. FR-3 named two correction paths after commit, and one of them, "editing an applicant's fields directly", has no surface either; the other, deleting the instance and importing again, destroys every score, note, vote, pass and decision in the cycle along with the applicants. So a wrong manual reject in the second round, or a wrong finalize in either earlier round, has no recovery in v1 short of destroying the cycle. The manual reject is confirmed, and the confirm names the applicant and their `Applicant N` handle with the consequence spelled out. That confirm is the only guard, and this decision says so where the reject control's own comment used to point at "an override on a later surface".

    Text amended: FR-3 loses the dead sentence; §5's `Decision` comment and §8's audit bullet say reversal is not in v1 and point here; the audit page's copy follows in the code slice.

    **What is built next, and why it is not an indefinite v2 item.** Second-round deliberation is exactly where a board reconsiders a call, and the manual reject is the one action an admin takes alone, in the room, that a vote cannot undo. The narrowest reversal that closes that exposure is scoped to a manual reject made in the still-open pass — row still `REJECTED`, `Decision.actor = ADMIN`, pass still open — offered from FR-18's grid: it sets `status` back to ACTIVE, clears the pass row to `NULL`, deletes the `Decision` row, and writes an audit row carrying the previous values. The applicant is still a member of that pass, so there is no membership consequence. It excludes vote-driven resolutions and the earlier rounds, whose reversal would re-enter an applicant into rounds that have already run. **It is a priority to build before the next live cycle runs**, planned as its own slice after this reconciliation pass, not left on the v2 list. Built as decision 107.

107. **Decision 106's narrow reversal, built. RESOLVED, amending 106, §5's `Decision` comment, §8's audit bullet, FR-3, FR-17 and §7.4's edge-case table.** An admin reverses a manual reject from FR-18's page while the pass it happened in is still open. Planned in `plans/phase-8-decision-106.md`.

    **Guard.** Reversible iff the pass is `OPEN`, the applicant's row in it is `REJECTED`, their `Decision` at `stage = SECOND_ROUND` has `actor = ADMIN` and `outcome = REJECT`, and `Applicant.status = REJECTED`. That `actor = ADMIN` is what makes a manual reject distinguishable after the fact: the pass's own unanimous result writes `SYSTEM` (decision 69), so a vote-driven `REJECTED` row is refused. A closed pass is refused. The earlier rounds have no pass row and cannot reach the predicate at all. One pure predicate in `lib/passes.ts`, read by the page to decide which rows get the control and by the action to refuse — the same posture as pass creation and vote availability, so the control and the refusal cannot disagree about the reason.

    **Writes, one transaction.** The pass row → `NULL`, `resolvedAt` → `NULL`; `Applicant.status` → `ACTIVE`; the `Decision` row **deleted**, not updated — §5's comment used to say a reversal would update the row, but there is no earlier decision to restore to, and "no outcome" is not a value `DecisionOutcome` has; an audit row `REVERSE_MANUAL_REJECT` on the applicant, whose `previousValue` carries the pass, the two previous values and the deleted decision's fields. The reject's own `MANUAL_REJECT_IN_PASS` row is untouched, so the log reads reject-then-reversal in order.

    **The row is cleared to `NULL`, not recomputed.** A manual reject is legal over `NULL`, `CARRIED` and `NEEDS_ADMIN` (17l's "any applicant"), and `NULL` is a true reversal only for the first. Cost stated and accepted: a reject over `CARRIED` reverses to a null row with no outstanding reviewer, which reviewers may vote on again since `NULL` is mutable; a reject over `NEEDS_ADMIN` reverses to a null row that FR-18 still renders as needing an admin, because 18d renders the recount where nothing is stored. Both carry at pass close and both become `NEEDS_ADMIN` at round close under decision 73, so nothing downstream distinguishes them from the value the reject overwrote, and a recompute would buy nothing durable.

    **`isMutableResolution` is unchanged.** `REJECTED` is still immovable to every recount — the reviewer vote, conflict removal and vote availability all keep reading it, and decision 71's protection of a manual reject against a vote in flight stands. The reversal is the one write over a `REJECTED` row that is not a recount, and it goes through its own predicate rather than through a fourth mutable case.

    **Votes are untouched; membership is untouched.** The reject deleted no vote, so the reversal restores none; whatever a reviewer had stored is what the vote control shows them again. The applicant is still a member of the open pass, so nothing is written to membership, and a later pass includes them because they are `ACTIVE` at its creation.

    **Concurrency.** The first write is a conditional update on `(passId, applicantId, resolution = REJECTED)`; zero rows aborts the transaction and the admin is told the rejection was already reversed. Same posture as pass creation letting the index decide between two admins.

    **The reject's confirm is unchanged.** Decision 106 calls it the guard on the mis-tap, and a reversal that exists is a reason to keep that friction, not to soften it with "you can undo this". The reversal is announced by its own section on the pass page and by the admin guide.

108. **Field visibility becomes one binary flag, explicitly chosen. RESOLVED, amending §5, §6, FR-2, FR-3, FR-12, FR-14, FR-16, and decisions 18 and 34.** §6's three-category × four-viewer matrix is replaced by `isReviewerVisible` on `Field` and `FieldGroup`: true means all three reviewer rounds, false means none of them, and there is no per-round distinction for any mapped column. Admin sees everything not excluded, as before. Name, email and the interview surfaces are untouched — they were never category-driven.

    **Three behaviour changes, not two.** The first two were the point of the change and were approved as such. The third follows from the model and is recorded here because it was not asked for and would otherwise be discovered.

    1. **Written responses become visible to first-round reviewers.** RESPONSE resolved hidden for that viewer; it no longer does. FR-14 amended.
    2. **Demographics become invisible to second-round reviewers.** DEMOGRAPHIC resolved visible for that viewer; it no longer does, and the lock below makes it unconfigurable. FR-16 amended.
    3. **Every OTHER-category column loses its unconditional second-round visibility.** The old matrix gave OTHER `SECOND_ROUND_REVIEWER: true`, so a second-round reviewer saw the major, graduation date, minor, how-they-heard and the administrative timestamps whether or not anyone had decided they should. The binary has no state meaning "hidden in the first two rounds, visible in the third", so mapping OTHER to Backend only forecloses it. At migration time this affected **50 ungrouped included OTHER columns across the four committed instances** — grouped members are excluded from that count, since they inherit a DEMOGRAPHIC group and are covered by change 2 instead. Seven are substantive: Major, Other Major, Second Major, Other Second Major, Minor, Graduation Date, and How did you hear about Spark SC?. The remaining 43 are timestamps, Tags, Network ID, Response Type, Ending and a row number, which no deliberation reads.

        Accepted rather than preserved. It could have been preserved — by letting the flag govern only the written and first rounds, with the second round seeing everything included and non-demographic — but that reintroduces the per-round distinction this decision exists to remove, and makes "Backend only" a false label. The direction is fail-safe, it is what "Backend only means no reviewer in any round" has to mean, and the remedy for any column that genuinely belongs in a deliberation is one tick on a screen the admin is already on. That tick also makes the choice explicit, where today it is inherited from a default nobody set. Stated rather than buried because "the complete applicant profile" got quietly narrower and FR-16 is where a successor will look.

    **DEMOGRAPHIC is locked to Backend only; RESPONSE is protected by a blocker instead.** The lock is enforced in `lib/fields.ts` and refused by the mapping actions server-side, not merely omitted from the UI — decision 18's "inert if it arrives some other way" property, carried into the new model, and the reason 18's reasoning outlives 18's question. RESPONSE deliberately does not get the mirror-image lock. The two fail in opposite directions: hiding is fail-safe, showing is not, and `category` freezes at commit while `isReviewerVisible` does not, so a locked-open flag on a frozen enum is the one state here that cannot be walked back — a column mistakenly marked Responses would be reviewer-visible for the life of the instance, with un-including it the only escape, which decision 34 notes also strips it from FR-10's admin profile. Instead FR-3 refuses to commit while any included RESPONSE column is Backend only: the same enforcement strength, applied at a gate rather than as a permanent property.

    **No default, and unset is not a third state.** **Amended by decision 110 for RESPONSE only**, where FR-3's two blockers already left exactly one committable state and the tick was buying nothing; the rule stands unchanged for OTHER, which is the category it was doing work for. Neither checkbox is ticked on a newly mapped column, and FR-3 blocks the commit until every eligible column has a state — eligible meaning included, non-promoted, and not DEMOGRAPHIC. `NULL` resolves hidden everywhere, so an unchosen column cannot leak; it simply is not committable. The mapping table's outstanding list therefore also renders on **committed** instances, which it never did before, because the migration below can leave a committed instance with unchosen columns and no commit gate remains behind them.

    **The migration, and what it decided about existing rows.** The two per-round columns are dropped and backfilled into one. RESPONSE → visible; DEMOGRAPHIC → Backend only; OTHER on a committed instance → its old value where the two rounds agreed. Two cases were judgment calls and are recorded as such:

    - **A split row — the two old booleans disagreeing — becomes unset, not a guess.** "Visible to written reviewers only" has no binary equivalent, and choosing either direction silently would either widen exposure or hide a column an admin deliberately showed. The survey found **zero** such rows in any instance, so this rule wrote nothing; it is kept because the next import can produce one and the alternative is a silent decision.
    - **A draft instance keeps the choices an admin demonstrably made, and unsets the rest.** A row where either old boolean was non-null was touched by a person and carries over; a row where both were null was never touched and becomes unset, so the no-default rule applies to it. Without this the one uncommitted instance would have lost seven real choices to re-ticking. One of those seven — a column explicitly hidden from written reviewers, untouched for the first round — had an old effective state that *included* unconditional second-round visibility under the OTHER rule above, and the Backend-only mapping forecloses that without an explicit re-decision. Accepted because the direction is fail-safe and the row count is one, on a non-production instance — not because the distinction does not matter.

    **`category` survives, as classification.** It decides §10.7's 1/n counting and FR-19's breakdown, and the visibility layer reads it only to apply the DEMOGRAPHIC lock. The mapping table therefore keeps its category selector alongside the new checkboxes. §6 states the exception rather than claiming a clean binary, because a successor reading "binary" and finding `category` in the resolver would reasonably conclude one of the two was wrong.

109. **Archive-and-purge is removed and §8's retention requirement is withdrawn. RESOLVED, reversing decisions 94 and 95 and amending §5, §8, and decisions 14 and 92.** The platform keeps every cycle in full, indefinitely. FR-5's manual instance deletion is untouched and becomes the only way to remove a cycle.

    **Why, and it is not a change of mind about the data being sensitive.** §1 and §8 are still right that these records hold essays about family trauma, immigration status, self-reported ethnicity and first-generation status. What the retention rule got wrong is where that data lives. Spark SC already holds all of it, indefinitely, in Google Drive, Sheets and Typeform, and will go on holding it whatever this platform does. Purging it *here* therefore reduces the club's standing exposure by nothing measurable; it destroys the cycle detail the club wants to keep while leaving every other copy in place, and makes this one system inconsistent with the club's actual practice everywhere else. The club's decision is to retain full cycle detail, responses included, for future reference. A retention control that deletes the least-exposed copy of a record is security theatre with a real cost, and this is the entry that says so rather than leaving a successor to re-derive it.

    **What survives, and it is the part that matters.** Deletion stays possible and stays deliberate: FR-5's typed-name gate, admin-triggered, one instance at a time, behind the app-level password. §8's other protections are untouched — the two password gates, argon2id hashing, HTTPS, the repository rule, and the audit log. Nothing about who may *read* an applicant changes; §6 and decision 108 are the whole of that, and this decision does not touch them.

    **Removed:** `lib/archive.ts`, `lib/archive-io.ts` and their tests; the `/archive` retention screen and its typed-name purge action; the per-instance frozen-summary page; the reviewer-side closed page; `prisma/checks/archive-purge.ts`; the `RETENTION_CYCLES` environment variable; and `Instance.archivedAt`, `Instance.archiveSummary` and the `Instance_archive_pair` CHECK constraint.

    Three consequences, each recorded because each would otherwise be found at a bad moment.

    **1. Orphaned `AuditLog` rows now accumulate forever.** The instance-deletion records of §8 and decision 14 carry `instanceId = null` by design, and decision 92's app-level lockout rows do too. Belonging to no cycle, they could not be ranked by cycle, so decision 95 aged them out by date against the retention cutoff — and that sweep was the only thing that ever deleted them. Nothing replaces it, and deliberately: at one cycle per semester and 2–6 admins this is a handful of rows a year, and a scheduled job would be new machinery, a new failure mode, and a second date-driven deletion path of exactly the kind that already destroyed nine real rows once (see `CLAUDE.md`'s security note). Named here rather than solved. **`RateLimitBucket` rows are not affected**: `pruneSpent` runs on every successful admin sign-in, independently of any of this, which is also why decision 96 is untouched.

    **2. An FR-20 export written before this change no longer restores.** `parseExport` rejects unknown columns, so an older file fails with `Instance[0] carries unknown columns: archivedAt, archiveSummary`. `EXPORT_FORMAT_VERSION` is deliberately **not** bumped: `lib/export.ts` already states that adding or removing a column is not a format change, and that the manifest error naming the column is the more precise failure. The recovery is deleting those two keys from the JSON. Decision 86's round-trip guarantee is a same-version guarantee and always was; this is the first time that has cost anything, so it is written down.

    **3. `requireInstanceUnlocked` is gone, and the gate is one function again.** It existed solely to hold decision 95's four exemptions — the archive summary, settings, the export and the audit view — open on a cycle whose live screens had been emptied. With no purge there is no emptied cycle, so its four callers fold back into `requireInstance`, which loses a per-request `findUnique` in the bargain. Decision 95's warning that "reaching for the weaker gate to make a page load is the mistake this split is shaped to make obvious" goes with it; the audit page keeps its own, separate reason for gating on the instance password rather than app-level access, which is that `previousValue` can carry applicant data.

    Forward pointers:

    - **94** — reversed. `RETENTION_CYCLES`, and its argument that a threshold editable from behind a shared password could be set to 0, describe a control that no longer exists.
    - **95** — reversed in full. Its ordering rule, its two independent defences against a second purge, its keep-and-destroy lists, both read-only gates and the four exemptions all describe code that has been deleted. Worth reading anyway if retention is ever revisited: the reasoning about materializing aggregates *before* a destructive step, and about a UI affordance not being a safety mechanism, is not specific to this feature.
    - **14** — amended. The instance-deletion audit row still outlives its instance; nothing ages it out now. See consequence 1.
    - **92** — amended on the same terms for the app-level lockout rows.
    - **96** — **unchanged.** `NON_INSTANCE_TABLES` and its `RateLimitBucket` entry are driven by decision 92, not by retention, and survive this intact. Said out loud because 94, 95 and 96 were built in one phase and the range is easy to misread.

110. **An included RESPONSE column defaults to Reviewer-visible. RESOLVED, amending decision 108 and FR-2.** When a column's or group's *effective* category becomes RESPONSE while it is included, and `isReviewerVisible` is `NULL`, the flag is set to `true`. The checkbox arrives ticked.

    **Why this is not a hole in 108's no-default rule.** FR-3 already carries two blockers over an included RESPONSE column, and between them they leave exactly one committable state: Backend only refuses the commit, and unset refuses the commit. The admin's only legal move is Reviewer-visible, and the no-default rule was charging them a tick to reach it — a step whose only possible outcome was already determined. Pre-ticking removes a redundant action rather than reopening an exposure.

    The rule keeps its force everywhere it is doing work. For OTHER and for DEMOGRAPHIC the two states are genuinely available and mean different things — that is the case 108 was written about, and the case where an unchosen column really is a decision nobody has made. RESPONSE was never that case; it only looked like one because the rule was stated over every category at once.

    **What does not change, so the amendment cannot be read wider than it is:**

    - **No schema default.** `Field.isReviewerVisible` and `FieldGroup.isReviewerVisible` stay nullable with no `@default`, because an OTHER column must still arrive unset. The default is applied by the two mapping actions at the moment an admin chooses RESPONSE, which is also the only moment a column can become one — FR-2's importer never guesses a category, so every RESPONSE column is reached by a person clicking.
    - **Both FR-3 blockers stay.** An admin who ticks Backend only on a RESPONSE column still stores `false` and is still refused at commit. Nothing here weakens the gate; it changes the starting point, not the wall.
    - **DEMOGRAPHIC's lock is untouched**, both halves of it: `lib/fields.ts` treating a stored `true` as inert, and the two mapping actions refusing to write one.

    **One consequence, recorded rather than discovered.** A column moved RESPONSE → OTHER keeps the `true` it was given. That is deliberate: by then it is an explicit choice like any other, and reverting it to unset would restore a route back to `NULL` that 108 removed on purpose, where clicking a ticked box is a no-op rather than an untick. The admin who wants it hidden ticks Backend only, which is the same action they would take on any other column.

111. **Second-round reviewers see a resolved applicant's outcome. RESOLVED, reversing decision 74 in part and amending §6, FR-16 and decision 83.** A second-round reviewer sees, on their list and on the applicant's profile, that a resolved applicant was accepted — became a Sparklet — or rejected. Green and red respectively.

    **What is not reversed.** Individual votes, tallies and counts stay hidden from reviewers in every pass, open or closed. FR-18 remains the only surface in the product that renders a pass vote. §6's vote row splits in two the way decision 77 split the scores row: *round votes and tallies* stay Hidden, *resolved outcome* becomes Visible to a second-round reviewer.

    **The anchoring risk decision 74 was written to avoid, stated plainly.** An applicant resolves only when every non-SKIP reviewer has submitted, so a terminal outcome **is** a complete tally, derived. Green means every other eligible reviewer voted yes; red means every other one voted no. The reviewer who casts the resolving vote therefore learns exactly how everybody else voted, which is decision 83's argument word for word. And the forward-looking half is 74's own: a reviewer entering pass 2 having watched eight applicants go green in pass 1 carries a read of the room into a vote that is supposed to be independent.

    **Accepted deliberately, not overlooked.** Two reasons, and neither is that the risk is imaginary. The second round is conducted as one deliberation in one room, where the outcome is spoken aloud as it happens — so the product was withholding from a reviewer's screen a fact they already had from the conversation, and buying no independence with it. And the cost of the concealment turned out to be larger than the cost of the leak: a reviewer could not tell whether the applicant they had just spent ten minutes arguing about had been admitted, which reads as the tool being broken rather than as the tool being careful. This entry exists so that a successor who finds green rows on a reviewer screen knows the trade was priced and taken, and can reverse it back if the club ever runs the second round asynchronously — which is the condition under which 74's reasoning becomes decisive again.

    **Decision 83 is superseded in its outcome half and survives in its count half.** The vote submission response may now name the outcome, because the page it returns to renders that outcome anyway and a silent confirmation over a green profile is a distinction with no difference. It still names no count, no other reviewer, and no tally.

    `CARRIED` and `NEEDS_ADMIN` are not outcomes and carry no colour. They stay the neutral settled state decision 83a already describes: a result occurred, and nothing about which way.

112. **A resolved applicant stays on the second-round reviewer's list and profile, locked. RESOLVED, reversing decisions 83 and 83a.** An applicant who resolves `SPARKLET` or `REJECTED` no longer disappears from the reviewer's list. The row persists, the profile stays reachable, neither renders a vote control, and both carry decision 111's red or green.

    **This makes CARRIED and the terminal outcomes one rule instead of two.** 83a corrected 83's overclaim by carving `CARRIED` out of the disappearance; with the disappearance gone there is nothing left to carve. Every applicant who reached the second round stays on the list for the life of the round, and every one of them shows a settled control in place of the vote control once their pass has finished with them. The only remaining difference between them is colour: a terminal outcome has one, `CARRIED` and `NEEDS_ADMIN` do not. `voteAvailability`'s `SETTLED` state, which deliberately carried no payload because 83 forbade naming the outcome, now carries the resolution for terminal outcomes and nothing for the rest.

    **The two predicates that were the same by coincidence must stop being the same.** `SECOND_ROUND_POOL` is `status = ACTIVE`, and it is FR-17 clause 17b's pass-membership predicate — the set a new pass is created over. The reviewer's list happened to want that same set, so it shared the constant. It no longer wants it: the reviewer's set is *everyone who reached the second round*, `stageReached = SECOND_ROUND`, whatever their status. These are two questions with two answers and they get two constants. Sharing one would mean either a pass created over resolved applicants or a reviewer list that hides them, depending on which surface won.

    **Read, not write.** The vote and conflict actions keep the `status = ACTIVE` predicate. A resolved applicant is readable and not votable, and the guard that enforces that is the same one that already refuses a vote arriving from a stale tab.

    **What decision 82 recorded as its cost is now half paid, from the other side.** 82 accepted that a reviewer part-way through a pass cannot see at a glance which applicants they have already voted on. Resolved rows are now visibly distinct, so part of that is answered incidentally. The reviewer's own *outstanding* votes are still not marked on the list, and that remains open on 82's original terms.

113. **First-round voting moves to the applicant's page. RESOLVED, amending FR-14 and reversing the every-tap-counts reasoning it was built on. Amends decisions 62 and 82.** The vote control leaves FR-14's list. A first-round reviewer opens the applicant's page to vote, exactly as a second-round reviewer does under decision 82. The list becomes a browsing and searching surface.

    **The sentence this reverses is decision 82's, and it is worth quoting because it is now wrong.** 82 said: *"That rule governs fast, independent review surfaces — FR-14's first-round list, where a vote is a reaction to two numbers and a paragraph, and where an extra tap really is a review that does not get completed."* The premise is false about the built screen. The first-round row does not show two numbers and a paragraph; it shows a *summary of what exists* — "2 scores · notes" — and links to the page that holds them. What the list actually carried was enough to vote and not enough to decide, which is precisely the outcome 82 says the requirement exists to prevent. The same argument that put the second-round vote on the profile applies here, one round earlier than expected, and the only reason it was not applied at the time is that FR-14 was written before anyone had seen the row.

    **CLAUDE.md's every-tap-counts rule is scoped, not withdrawn.** It governs the written round's reviewer dashboard, which is the surface it was written about and where its premise holds: thirty untrained reviewers, one sitting, on a phone, with the whole application in front of them. It does not license a vote control on a row that renders no evidence. A tap removed from a surface where the reviewer has what they need is a saved review; a tap removed from a surface where they do not is a vote cast on a name.

    **The list keeps the reviewer's own vote state, as a marker rather than a control, and this is a deliberate divergence from 82.** 82's cost paragraph already grants it: a per-row marker showing only the reviewer's own vote is additive, breaks nothing, and is forbidden only for *other* reviewers' votes by decision 74. Decision 62's "Voted on N of M" counter depends on the same data and answers a question — *am I done* — that nothing else on the screen can. The first round therefore takes 82's pattern without taking 82's cost, and the second round's list is the one that stays bare, on its own separate reasoning.

    The list also gains a search box, since its remaining job is finding an applicant rather than acting on one.

114. **The written rubric's category description becomes per-point criteria. RESOLVED, amending §5, FR-4 and decision 32.** `RubricCategory.description` — one blurb for the whole category — is replaced by one line of criteria per offered score value across the category's `minPoints..maxPoints` range.

    **This is decision 32's argument carried the rest of the way.** 32 established that a name and a maximum are a scale and not a rubric, and that a shared definition of a 4 is the main thing standing between thirty untrained reviewers and the variance FR-10 exists to flag. A single blurb per category is that argument half-applied: it says what the category is asking for, and then leaves every reviewer to invent the boundary between a 2 and a 3 privately. The boundaries are where the disagreement lives, and they are exactly what the blurb cannot state.

    **Schema: a new `RubricLevel` table, not a JSON map on the category.** `id, rubricCategoryId, points, criterion`, `UNIQUE (rubricCategoryId, points)`, cascading from `RubricCategory`. A table for decision 40's reason — the scale is data that travels with the instance that used it — and because a unique index makes "one criterion per offered value" a database guarantee rather than a convention held in a form component. It also enters FR-20's export automatically, where `lib/export.test.ts`'s bidirectional `EXPORT_TABLES` assertion fails loudly if the manifest is not updated. A model that exports as nothing while the round trip still passes is the failure that assertion exists to catch, and this is the first new model since it was written.

    **Per-value criteria only make sense on a narrow scale**, so `validateRubric` gains a ceiling on the number of values a category may offer while carrying them. `MAX_POINTS_CEILING` stays where it is: lowering it would retroactively invalidate an instance that has already run, which is decision 40's whole argument for making the scale data rather than a rule.

    Each criterion is individually optional, for the reason 32 made the description optional — an admin mid-setup should not be blocked, and a cycle that briefs its reviewers elsewhere is entitled to leave them empty. They sit inside FR-4's lock on the same accepted terms, and the same escape hatch applies.

    **What happens to the text existing rows already hold, recorded as the judgment call it is.** The column is dropped, and any non-null value is first written into the *top* value's criterion. 32 defined `description` as "what this category is asking for, **and what the top of its scale means**", so the top value is where the text is least wrong — but it is not right, and an admin re-reading it should expect to rewrite it rather than find it correct. Chosen over deleting it, which destroys real prose, and over keeping the column as a preamble, which is the change this decision exists to make.

    **The census was taken before the migration was written, not after, and it changes how much this rule is carrying.** 17 of 18 `RubricCategory` rows across all six instances hold a non-null description, none of them whitespace-only. But 12 of those 17 are the same four strings written by `prisma/seed/` and repeated across the three seed-derived instances, regenerated on every `npm run seed`; 4 more are keyboard mash on a walkthrough instance. **Exactly one row holds prose a person wrote for its purpose** — "Initiative" on *Demo Cycle — my practice run*, which reads "Evidence of starting something and seeing it through. A 4 is a project they ran end to end…". That row is the whole of what the backfill protects, and it happens to be the case where moving the text to the top value is *correct* rather than least-wrong, because the sentence names what a 4 means. The rule is kept anyway: the next cycle's admin will write descriptions that are not, and the migration should not be the thing that decides that quietly.

    Also from the census: every category on every instance runs 1–4, four values, so the scale-width ceiling below binds on nothing that exists.

    **One reviewer render site, not two.** `description` reaches a reviewer only on the written score card. FR-14's first-round view reads `InterviewCategory`, which has no description column at all and is untouched by this — the interview rubric is a different instrument per decision 6, and giving it the same treatment is a separate decision nobody has needed yet.

115. **A later round's reviewer roster is drawn from the earlier round's. RESOLVED, amending FR-6 and sitting beside decisions 66, 78 and 84.** Holding `FIRST_ROUND` requires already holding `WRITTEN`. Holding `SECOND_ROUND` requires already holding both. The add-by-name form and the paste box are removed from the first- and second-round roster tabs; the grid's per-round checkbox becomes the only way into a later round.

    **This is not decision 84 restated, and confusing the two would produce one guard doing two jobs badly.** 84 is a *time* lock: from the moment the first pass exists, the second-round roster is frozen in both directions, because a denominator has votes riding on it. This is a *membership* rule: it holds from the moment the instance is created, applies to the first round as well as the second, and has nothing to do with whether a pass exists. The two are independent and are checked in that order — 84 first, then this — because a frozen roster makes eligibility moot, and an admin who trips both should be told the roster is fixed rather than told to go add someone to the written round.

    **Why participation should be a prerequisite.** A second-round reviewer who never read the written applications is deliberating without the evidence the earlier rounds produced, and FR-16 defines that round as reading the complete profile and arguing over it. The same holds one round earlier. It also closes the last route by which a name typed into a later round's box creates a second `Reviewer` row for one human: decision 22 closed that for the paste box by comparing against every reviewer on the instance, and this closes the form by removing it.

    Participation means membership of the earlier round's roster — the `rounds` array — not evidence of submitted work. A reviewer who was rostered and scored nothing is still someone who was given the applications, and making the roster page ask "did they actually do anything" would put a judgment about a person behind a checkbox.

    **Consequence, recorded rather than fixed, on decision 80's terms.** Withdrawing a reviewer from `WRITTEN` while they hold a later round is still permitted, and breaks the prerequisite from behind. The rule is enforced on the way in; it is not held as an invariant over the whole roster. The remedy is to withdraw them from the later round first, or to put them back on the written one. Named here so that a successor finding an ineligible-looking roster row knows how it got there rather than concluding the guard is broken. Closing it is one condition on the removal path, the same shape as decision 84's, if it ever bites.

    No migration. Rows that already violate the rule keep their rounds; the guard applies to new writes only.

116. **Suspected AI use is flagged by the reviewer who read the application. RESOLVED, amending §5, §6, FR-9 and FR-10.** A checkbox on the written reviewer's score card, one per assignment, surfaced to the admin on FR-10 and on the admin's applicant profile. `Assignment.suspectedAiUse`, boolean, defaulting to false.

    **On the assignment, not on the applicant**, for the reason the whole data model exists: it is one reviewer's read of one application, and three reviewers disagreeing about it is itself the signal an admin wants. Collapsing it to one flag on the applicant would make it last-write-wins over an unattributed accusation. It also matches what the club already does — the S26 `Scores` sheet carries an `AI Detected?` column per reviewer row, which is a per-review datum that the spreadsheet happened to store in the right shape.

    **§11's "AI-assisted flagging" stays out of scope and is untouched.** Nothing here detects anything. This is the manual column the club already fills in by hand, moved into the tool, and the fairness judgment §11 declines to automate stays with the person ticking the box.

    **§6: visible to the admin and to its own author, hidden from every reviewer round including the second.** It deliberately does *not* travel with the written scores and notes that decision 77 made visible to a second-round reviewer. 77's argument for showing prior-round evidence to a deliberation is that the person who gave the 2 is in the room and can be asked why — the score has a scale behind it and a rationale attached. A suspicion has neither. It is an unverified claim about a person, with no scale to interpret it against, and putting it in front of a deliberation would let it do the work of evidence without being any. It is an admin signal for deciding whether to look again, and that is the whole of it.

    It saves through a form bound to a server action rather than the score card's autosave queue. That queue exists for work built up over many edits, where losing the last keystroke costs real thinking; a checkbox is one deliberate act with two states, and a form that posts on change is both simpler and strictly more reliable — it works before hydration and with JavaScript off, per decision 33, and needs no draft mirror to survive the tab dying. It reaches FR-20's JSON export automatically as an `Assignment` column; the per-stage CSVs are lossy derivatives per decision 90 and are left alone.

    **FR-10 renders a bare count, not a fraction, and the denominator lives in the tooltip.** The column shows `⚑ 2` where any reviewer ticked the box and an em dash where none did — deliberately not `2/3`, and a successor should not add the denominator to the cell without reading this paragraph.

    The reason is that **the honest denominator is completed reviews, not assigned reviewers.** `suspectedAiUse` defaults to false, so a reviewer who never opened the application is indistinguishable in this column from one who read it and did not suspect. A `1/3` built on the assignment count would therefore assert "three people considered this and one said yes" when possibly only one person has looked at all — and it would sit next to FR-10's review-count column, which renders `2/3` against the *target*, so two adjacent fractions would carry two different denominators and invite exactly the wrong reading.

    The count is also not a sort key and not a filter. It is a reason to open an application and read it again, not a rank — which is the same posture §11 takes toward automating this judgment at all. The tooltip carries "N of M completed reviews", where M is the number FR-10 already computes for the review-count cell, so the interpretation is available without the ambiguity.

117. **An admin can return an assignment to the pool, through the path that already exists. RESOLVED, amending FR-8 and decision 27.** FR-8's controls gain "Return to pool" beside assign, unassign and swap. It writes the same `RETURNED_TO_POOL` row FR-9's reviewer-facing control writes, with `returnReason = OTHER` and a required note.

    **Extending rather than adding, and the check that says so.** The reviewer path already produces exactly the state an admin wants for a non-responsive reviewer: the slot leaves the active set, the applicant reads as short a reviewer, any reviewer can claim it, and the row records what happened and why. A second mechanism with the same effect and a different row shape would be two ways to say one thing, and `lib/assignment.ts` would have to learn about both — which is how the two come to disagree about whether a slot is open.

    **`unassignReviewer` already exists, is a different verb, and stays.** It *deletes* the assignment row, so generation is free to re-pair that reviewer with that applicant on the next run. That is correct for "this pairing was a mistake" and wrong for "this reviewer is not coming back". A return writes decision 23's exclusion, which is what a non-responsive reviewer calls for: regeneration must not hand them the same applicant again. The asymmetry between the two verbs existed before this decision and was incidental; it is now deliberate and this is where it is written down.

    Two consequences follow from decision 23 and are correct here rather than merely tolerated: the pair can never be regenerated, and putting that reviewer back on that applicant is FR-8's assign, which reactivates the returned row per decision 39. The admin panel already renders returned rows read-only and non-actionable, for the reason decision 23 gives, and that is unchanged.

    **Audited, where the reviewer's own return is not.** §8 logs admin overrides and this is one. The note is required here where it is optional for a reviewer, because the reviewer's reason enum answers "why" on its own — a conflict of interest is a complete explanation — while an admin return is always `OTHER`, so the note is the entire record of what happened. A return preserves the scores already written, unlike an unassign, and the confirmation says so rather than leaving an admin to guess which of the two verbs destroys work.

118. **Demographic aggregates are proportions of a stated pool. RESOLVED, amending §10.7's display rule and the panels in FR-11 and FR-15. FR-19's funnel is deliberately untouched.**

    **Nothing about the counting changes**, and the format follows from that rather than replacing it. The `1/n` weighting, the "Not specified" bucket, the shared checked predicate, the exclusion of the free-text write-in, and the invariant that the weighted column sums to the size of the set being counted are all exactly as this decision has had them since it was resolved. What changes is that the panel finally *states the denominator it has always summed to*, instead of printing a fractional number of people beside a headcount and explaining the arithmetic in a paragraph underneath.

    **The format is `weighted / poolSize (headcount)`.** `1.0/9 (2)` is a weighted one person out of a nine-applicant pool, ticked by two people who each selected two options. Two of those three numbers the panel already computed; the pool size is the third, and it is the one that makes the first legible — a bare "1.0" is a fractional person with no scale, while "1.0/9" is a proportion. Computed once against the full pool, and again against the active selection using the selection's own size as its denominator, so the two columns are each internally coherent rather than sharing a denominator that belongs to one of them.

    **This is the shape FR-19's funnel already uses**, where a cell is `weighted / cohortSize` rendered as a percentage. FR-19 works and is left alone. The two surfaces therefore converge on the same three numbers and differ only in formatting — a fraction where a reader is comparing two columns of a live selection, a percentage where they are comparing four nested cohorts. Said here so a successor does not "fix" one to match the other and lose the reason each chose what it did.

    **A single-select column reads `applicable / total`, with no parenthesised count.** First-generation status renders "Yes 33/150", "No 117/150". This is not a special case: an ungrouped demographic column cannot be multi-selected, so `n = 1` always, `weighted` and `headcount` are identically equal, and the parenthesised number would repeat the numerator. Dropping it is the general rule applied to a set where two of its three numbers coincide.

    **The system is not taught which value means yes.** Every distinct value gets its own line in value order, and "applicable" is whichever line the reader is looking at. Inferring an affirmative out of free-text CSV values is exactly the silent guess FR-2 refuses when it declines to detect a category from a header, and the same reasoning holds: a wrong silent guess about what "Y" or "First gen" means is worse than a display that shows both lines and lets the admin read the one they want.

119. **Class standing is derived from the graduation-date answer and the cycle's current semester. RESOLVED, amending §5, §6, FR-2, FR-3, FR-5, FR-9, FR-10, FR-14 and FR-16.** Applicant views gain a **Class standing** line directly under the graduation date, so thirty reviewers stop doing the same semester arithmetic in their heads and doing it differently. Planned in `plans/decision-119.md`. **Shipped ahead of the first real cycle by the owner's explicit call**, as the one exception to the freeze the status line records.

    **The rule, as behaviour.** Two inputs: the applicant's answer in the designated graduation-date column, and the instance's current semester. A term's index is `year × 2`, plus one for Fall; *semesters out* is the graduation index minus the current one.

    | Answer | Class standing |
    |---|---|
    | No column designated, or the instance has no current semester | no line at all |
    | Blank | Unknown |
    | `Spring`/`Fall` + year, 0–1 semesters out | Senior |
    | … 2–3 out | Junior |
    | … 4–5 out | Sophomore |
    | … 6–9 out | Freshman |
    | `Spring`/`Fall` + year, 10 or more out | Non-standard |
    | `Spring`/`Fall` + year, but in the past | Non-standard |
    | Anything else non-blank — Summer, a month name, the dropdown's "… or later" option, a typo, a degree note | Non-standard |

    A value matches only if, trimmed, with internal whitespace collapsed and case ignored, the *whole* string is a season word followed by a four-digit year. No substring matching.

    **Amended 2026-09-12, before any code shipped: Freshman is capped at 9 semesters out.** As first approved, the Freshman row read "6 or more out", with no upper bound. That made an obvious typo like `Spring 2207` read as a confident Freshman, which is exactly the wrong label Non-standard exists to prevent.

    **Why 9.** Spark's applicant pool includes legitimate five-year programs, and 9 is the furthest a five-year student can be from graduating: someone starting in a Fall graduates in the Spring five years later, 9 semesters on. A ceiling of 7, the four-year maximum, was considered first and rejected because it would turn every first-year in a five-year program into Non-standard. Past 9 the answer fits no program in the pool, whether it is a typo or something genuinely unusual, so it reads Non-standard under the same reasoning as a date in the past.

    **The cost, stated plainly, because it goes against this decision's own "never print a wrong label".** The ranges below the ceiling are still counted on a four-year scale. A five-year student therefore gets a label, but in the middle of their program it is one class younger than their actual year:

    | Year in a five-year program | Semesters out | Reads |
    |---|---|---|
    | First | 8–9 | Freshman |
    | Second | 6–7 | Freshman |
    | Third | 4–5 | Sophomore |
    | Fourth | 2–3 | Junior |
    | Fifth | 0–1 | Senior |

    Only the first and final years read correctly. **The ceiling did not cause the offset, and moving it cannot fix it.** At 7, the same second- to fourth-year students already carried the same one-class-young labels, because they sit 2–7 out, inside both ceilings. Their answer looks exactly like a four-year student's, so no ceiling can tell them apart. The only difference 9 makes for five-year students is their first year, which now reads Freshman, correctly, instead of Non-standard.

    **What 9 actually gives up is typo detection in a narrow band.** A mistyped year that lands 8–9 semesters out now reads Freshman rather than Non-standard. Typos further out, like `Spring 2207`, are still caught, which was the gap this amendment was written to close. A reviewer who needs the precise year reads the graduation date directly above the label.

    **Non-standard exists so the tool never prints a wrong label.** A graduate student, a progressive-degree student, or a transfer on an odd timeline does not fit a four-year count, and forcing one onto them is worse than declining to. Non-standard tells a reviewer to read the raw answer, which is rendered directly above it. **Unknown means only that the applicant left the question blank** — the two are not interchangeable, and a successor collapsing them loses the difference between "nothing to read" and "read this yourself".

    **Strict matching is deliberate.** The real Typeform field is a Fall/Spring dropdown, so anything in that column that is not one of its options is an anomaly worth flagging, not a value to interpret. Two consequences, recorded rather than discovered. A freshman who picks the dropdown's last option, "… or later", reads Non-standard. And the synthetic fixtures, which wrote graduation dates as `May 2027` / `December 2027`, were never the real vocabulary — they are corrected to the dropdown's, rather than the parser being widened to meet them. **Summer is not excluded by a rule, because the real vocabulary never contains it.** The form's dropdown offers eight choices, all Fall or Spring. A `Summer 2027` could only come from someone typing free text outside those eight, so it falls into the same Non-standard bucket as every other off-format entry. It is not a separate carve-out, and a successor should not add one.

    **The column is designated, never guessed, and the designation is not frozen.** An admin marks at most one column as the graduation date on FR-2's mapping table. That keeps FR-2's refusal to infer meaning from a header intact. It is not a `promotedRole` — the `Field` row survives commit — and it sits on the not-frozen side of decision 34's line, because it keys nothing in `Applicant.data`: changing it after commit changes a label, not what any stored value means. It lives on `Field` rather than as a foreign key on `Instance` because FR-20's restore writes tables in foreign-key order, Instance before Field, and an `Instance → Field` reference would make that order circular.

    **Visibility is inherited, not configured, and inheriting it adds no exposure.** Class standing is a function of a value the viewer can already see and a cycle-wide setting that is not sensitive, so showing it reveals nothing new. Where the source column is hidden — Backend only, unset, DEMOGRAPHIC, excluded, or under a hidden group — class standing is hidden too, and is not computed into the response at all. That holds even though class standing is coarser than the date it comes from: goal 3's controls attach to the column, and a second toggle would be a second place for an admin to forget.

    **Class standing is shown in the written round despite that round's blinding, and that is a deliberate tradeoff, not an oversight.** §6 and decision 4 hide name and email from written reviewers for two reasons:
    - a name is a bias vector a reviewer grading essays does not need;
    - a name identifies one specific person, and so does an email.

    Class standing does not identify anyone on its own. **That is a weaker claim than it may sound, and it is not a claim about anonymity.** It is tempting to argue from bucket size: four labels over a pool of 160-odd, or three or four applicants per label among the roughly 12–16 one written reviewer is assigned (160-odd applicants × 3 reviewers ÷ 30–40 reviewers). That argument is the wrong measure at either scale. A written reviewer does not pick an applicant out of the pool statistically. They recognise someone they already know from what is on the screen. The set that matters is the people *that reviewer* knows who applied, and it can be very small — small enough that class standing, combined with other reviewer-visible fields, narrows it to one person.

    What holds is narrower: **class standing adds nothing to that recognition that the graduation date did not already provide.** It appears only where the date is reviewer-visible, and the date says more than the label. So the blinding question is not "should reviewers see class standing". It is "should reviewers see graduation date", and that was answered on the column before this decision existed. The recognition route that does exist, through any combination of visible fields, is the one §6 already names: a reviewer who recognises an applicant returns them to the pool.

    **The cost is real and stated plainly.** Class year can bias a reviewer. Printing "Freshman" beside an essay makes that easier to act on than a date a reviewer would have had to work out. This is a cost of *salience*, not of exposure, and it does not contradict "visibility is inherited … adds no exposure" above: the reviewer learns nothing the date did not already say, but the label puts it in front of them.

    It is accepted for two reasons. The information was already on the screen. And the club decides whether class year belongs in blind review by setting one column, not by the system hiding a derived label while showing its source. **An admin who wants the written round blind to class year sets the graduation-date column to Backend only, and class standing disappears with it in every round.** No setting blinds the label while leaving the date visible, on purpose: that would give the appearance of a bias control without its substance.

    **The semester is set once, and the cost of that is stated.** Mis-set at creation, it mislabels every applicant for the whole cycle, and the only correction is deleting the instance. Accepted because the value cannot legitimately change within a cycle, and an editable one invites relabelling applicants mid-round. The same reasoning is why the creation form preselects nothing: a default derived from the clock would be a silent guess that then becomes permanent, which is FR-2's category argument with higher stakes. Instances created before this decision have no semester; each gets a single set-once control on its settings page, audited, and until it is used class standing is **absent**, not Unknown.

    **Not a demographic, and not stored.** Class standing is computed at render time. It does not enter §10.7's counting, FR-11's or FR-15's panels, FR-19's funnel, or the per-stage CSVs. The two semester columns and the designation flag reach FR-20's JSON export as ordinary columns through `EXPORT_TABLES`.

    Forward pointers:

    - **34** — amended. The editable-after-commit list gains the graduation-date designation, on 34's own test: it keys nothing.
    - **108** — unchanged. Class standing reads `resolveField` and adds no visibility state.
    - **FR-2's no-guessing rule** — unchanged and load-bearing; it is why the designation exists.

## 11. Out of scope for v1, worth noting for v2

- AI-assisted flagging of likely AI-written applications. The `Scores` sheet already has an `AI Detected?` column, so the club is doing this manually. Automating it is a defensible v2 feature and a strong portfolio addition, but it is a judgment call with real fairness stakes and should not ride along with the core rewrite.
- Reviewer calibration: showing a reviewer their own scoring distribution against the cohort mean.
- Cross-cycle analytics: are high written scorers actually the Sparklets who stay active?
