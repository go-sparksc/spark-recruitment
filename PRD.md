# Spark SC Recruitment Platform — Product Requirements Document

**Owner:** Kai Lincoln
**Status:** v1.20, Phases 0-5 complete, decisions 50-71 recorded, Phase 6 (second round and passes) in progress
**Target:** Replace the S26 recruitment spreadsheet before the next full recruitment cycle

---

## 1. Problem

Spark SC currently runs recruitment out of a single Excel workbook. The S26 file contains 36 sheets, 153 applicants, and roughly 30 reviewers. Every round adds a new layer of manually maintained sheets (`WR Data`, `1RD Voting`, `2RD Vote Backend`, `Sparklet Maker`) that duplicate applicant identity, scores, and demographics.

Concrete failure modes visible in the current file:

- **Applicant identity is re-keyed by name across sheets.** `Decisions` uses `ID` + `Full Name`, `1RD Voting` uses `Name` only, `1R Notes` uses free-text `Applicant Name` typed by interviewers. Any typo or accidental cell manipulation can silently orphan a record or break the workbook.
- **Voting is a manually maintained reviewer-by-applicant grid.** `Voting Results` has 30 reviewer columns. `2RD Vote` has 11. Adding or removing a reviewer means restructuring a sheet mid-round.
- **Rubric scores and demographics live in the same rows.** There is no mechanism to show a first-round interviewer the scores without also exposing race, first-gen status, and written responses.
- **The workbook is not transferable.** Its logic lives in cell formulas and in the head of whoever built it. Training a new operator on the workbook takes significant time and close oversight.
- **Editing the workbook is difficult.** Updating or making changes to the workbook is tricky and cumbersome, with significant limitations based on how the workbook was originally built. Changes to the rubric, number or types of questions, and other variables between application cycles requires significant maintenance of the workbook beforehand.
- **Reviewers make and record their scores outside of the workbook.** To prevent leaking sensitive information or someone accidentally breaking the workbook, all reviews and scores are recorded on separate linked and unlinked spreadsheets, leading to complicated cross-workbook dependencies or cumbersome manual uploads.

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
  id, name, passwordHash, createdAt, archivedAt
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
  isMultiSelect                // bool; true when members can be checked together
  isIncluded                   // bool, default true; applies to every member
  ordinal
  visibleToWrittenReviewer     // nullable bool; null = the §6 default
  visibleToFirstRoundReviewer  // nullable bool; null = the §6 default
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
                               //   the group's value wins when groupId is set
  ordinal
  isIncluded                   // bool, default true; false = value retained but excluded
                               //   from every review surface. See FR-2. The group's
                               //   value wins when groupId is set.
  visibleToWrittenReviewer     // nullable bool; null = the §6 default for this category.
                               //   The group's value wins when groupId is set.
  visibleToFirstRoundReviewer  // nullable bool; null = the §6 default for this category.
                               //   The group's value wins when groupId is set.
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
  description                  // nullable. What this category is asking for, and
                               //   what the top of its scale means. FR-9 renders
                               //   it beside the score input, which is the only
                               //   place a written reviewer ever sees it. Without
                               //   it the "rubric" a reviewer scores against is
                               //   four bare words. See decision 32.
  minPoints                    // default 0. The scale's floor, so a category can
                               //   run 1..4 rather than 0..maxPoints. Invariant
                               //   0 <= minPoints < maxPoints, enforced in
                               //   validateRubric; validateScore takes the floor
                               //   as a parameter rather than assuming zero.
                               //   See decision 40.

Reviewer
  id, instanceId, firstName, lastName
  isSparklet: bool
  rounds: [WRITTEN, FIRST_ROUND, SECOND_ROUND]   // which rounds they serve in

Assignment
  id, instanceId, round, applicantId, reviewerId
  origin: AUTO | MANUAL | CLAIMED_FROM_POOL
  status: ACTIVE | RETURNED_TO_POOL
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
                               //   category rows. See open decision 6.
  UNIQUE (applicantId, interviewerName)
                               // makes a re-upload an upsert rather than a
                               //   duplicate. See decision 47.

InterviewCategoryScore         // one per category per InterviewResult
  id, interviewResultId, interviewCategoryId, points
  UNIQUE (interviewResultId, interviewCategoryId)

InterviewNotes                 // one row per applicant; only one interviewer of
  id, applicantId, body        //   the pair writes them, and the "Your Name"
  interviewerName              //   column records which
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

PassApplicant                  // membership, fixed at pass creation per FR-17
  id, passId, applicantId
  resolution: SPARKLET | REJECTED | CARRIED | NEEDS_ADMIN   // null until resolved
  UNIQUE (passId, applicantId)

PassVote
  id, passId, applicantId, reviewerId
  value: YES | NO | SKIP
  submittedAt
  UNIQUE (passId, applicantId, reviewerId)

Decision
  id, applicantId, stage, outcome: ADVANCE | REJECT | SPARKLET
  actor: SYSTEM | ADMIN
  decidedAt
  UNIQUE (applicantId, stage)  // one decision per applicant per stage; a
                               //   reversal updates the row and is audited

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
  actor, action
  entityType, entityId
  previousValue: jsonb
  createdAt
```

Five notes on this model:

- `Applicant.data` as JSONB rather than a key-value table. CSV columns vary cycle to cycle, so the schema cannot be fixed, but Postgres can still index and query inside JSONB. A separate `Field` table carries the human-facing metadata. This is meaningfully simpler than entity-attribute-value and just as flexible.
- **Every score, vote, and note references `applicantId`, never a name.** This is the fix for the current workbook's core problem.
- The source export uses one-hot columns for ethnicity: ten separate columns, any number of which an applicant may check, plus a free-text column for anything not listed. These become one FieldGroup with ten OPTION members and one FREE_TEXT member, which is what tells the UI and the demographic aggregations to treat them as one question rather than eleven independent ones. Category, inclusion, and the §6 visibility toggles are properties of the group, not of its members, so a group cannot end up half hidden and half visible, and a partially excluded group cannot occur. The FREE_TEXT member is a member for display and reconciliation only: it is excluded from the checked predicate and from the 1/n counting in §10.7.
- **`PassApplicant` exists because pass membership cannot be reconstructed after the fact.** FR-17 fixes membership at pass creation, but `Applicant.status` only ever shows the *current* state; once an applicant is resolved there is no way to ask "who was in pass 1?" without a stored roster. It is also where the all-COI case lands: §7.4 requires that an applicant every reviewer has recused from be distinguishable from a unanimous result, and `NEEDS_ADMIN` is that distinction. Resolution is a property of an applicant *within a pass*, not of the applicant.
- **The interview rubric is its own table, and `InterviewResult.score` is imported rather than derived.** `InterviewCategory` is deliberately separate from `RubricCategory`: the written rubric and the interview rubric are different instruments with different categories, and goal 5 requires both be reconfigurable between cycles, which rules out fixed columns. `score` holds the average exactly as the source sheet carries it — if it disagrees with the mean of the category rows, the sheet wins, because that is the number the interviewers actually recorded. There is deliberately no `UNRESOLVED` on `ApplicantStatus`: an applicant left undecided when the second round closes is identified by their row in the final pass, not by a second copy of that fact on the applicant. See FR-17.

## 6. Field visibility matrix

Enforced server-side. A reviewer request for a hidden field returns nothing, rather than the client hiding it.

| Field category | Written reviewer | First-round reviewer | Second-round reviewer | Admin |
|---|---|---|---|---|
| Applicant name | **Hidden** | Visible | Visible | Visible |
| Applicant email | **Hidden** | Visible | Visible | Visible |
| DEMOGRAPHIC | Hidden | Hidden | Visible | Visible |
| RESPONSE | Visible | **Hidden** | Visible | Visible |
| OTHER | Configurable, default hidden | Configurable, default hidden | Visible | Visible |
| Interview scores | Hidden | Visible | Visible | Visible |
| Interview notes | Hidden | Visible | Visible | Visible |
| Written rubric scores and review notes, from other reviewers | Hidden | Hidden | Visible | Visible |
| Round votes — first-round votes and pass votes | Hidden | Hidden | **Hidden** | Visible |

**The last two rows were one row, and it was carrying two questions.** It read "Other reviewers' scores/votes — Hidden until pass closes" for a second-round reviewer, which refused FR-16's own list of what that reviewer sees. Prior-round evidence is what a deliberation is conducted on; the votes being cast now are what anchoring is about. See decision 77, and decision 74 for why "until pass closes" became plain Hidden. Written scores and review notes are attributed to the reviewer who gave them, the same way FR-14 attributes an interview score to its interviewer.

**Where "configurable" is configured, and for how long.** The OTHER row's two toggles live on the FR-2 mapping table, and they stay editable there after the import commits — along with the include/exclude checkbox, and unlike everything else on that table. See decision 34. Visibility is a per-round control and rounds run weeks after a CSV is imported, so freezing it at commit would close the only window in which it can be set before anyone has a reason to open it.

The written-reviewer row is a deliberate change from the current spreadsheet, where reviewers see whatever columns are in front of them. Written reviewers grading essays have no need for ethnicity or first-gen status, and hiding them removes a bias vector at no cost.

Names are hidden from written reviewers for the same reason (open decision 4). Written reviewers see an anonymous label built from `sourceRowIndex`, e.g. "Applicant 47." Names remain visible to admins throughout, including on FR-10, since decisions cannot be made against anonymous labels. A written reviewer who recognizes an applicant from the essay itself can still return to pool.

**Email is hidden from written reviewers too, and the row above is not redundant.** USC addresses are `firstname.lastname@usc.edu` — an email is a name in disguise, and FR-2 makes email un-excludable, so it exists on every applicant. Both `Applicant.displayName` and `Applicant.email` are promoted columns rather than `Field` rows, so neither is covered by the per-field `visibleToWrittenReviewer` toggle. The server-side visibility layer therefore has three inputs: FieldGroup rows for grouped columns, Field rows for ungrouped ones, and fixed rules for the promoted ones (displayName and email hidden in the written round, sourceRowIndex exposed only as the anonymous label). Resolving a field to its effective category, inclusion, and visibility belongs in one shared helper, not re-derived per surface.

## 7. Functional requirements

### 7.1 Instance setup

**FR-1 Dashboard.** Landing page lists existing instances by name with created date and stage. Also offers "New instance from CSV."

Opening an instance lands on that instance's hub, which lists every surface it has in the order a cycle uses them — columns, rubric, reviewers, assignments, settings — each carrying the state it is actually in rather than a bare link. Every instance page links back to the hub as well as to this list. See decision 36.

**FR-2 CSV import.** Accept the applicant CSV. Parse headers. Show a mapping table with one row per column:

- Detected header (read-only)
- Editable display name (defaults to a cleaned version of the header)
- Include/exclude checkbox (default on)
- Category selector: Demographics / Responses / Other. **Every column defaults to Other**; the importer never guesses a category from header text, because a wrong silent guess is worse than an unset one.
- Per-round visibility, shown for Other only: hidden in both reviewer rounds by default, with a toggle for the written round and one for the first round. §6 makes Other "configurable" and this is where it is configured; Demographics and Responses show their §6 default read-only.

This row and the include/exclude checkbox above it remain editable after the import commits; every other control on this table freezes at that point. The mapping table is therefore the admin's surface for the whole cycle rather than only for the import. See FR-3 and decision 34.

Some questions arrive as several columns. The ten one-hot ethnicity columns are one question, not ten. The mapping table detects likely groups by their value signature — every non-empty value in the column is the same literal, and that literal is the column's own header — and presents them for confirmation. Three guards keep the heuristic honest: a column with no non-empty values has no signature and is never a candidate, a run of one column is not a group, and comparison is exact, since `Black` is a strict prefix of `Black or African American`.

**A detected group is a proposal, not a result.** It is not stored as a FieldGroup until the admin names it, which is also when its immutable `key` is assigned. Dismissing it discards it. Doing neither is a third state, and FR-3 warns about it before commit rather than silently importing the columns ungrouped — which would leave the §10.7 demographic breakdown with no group to read and nobody the wiser until FR-11.

The admin can rename a group, split it, merge two, or assign an ungrouped column to a group. The free-text write-in will not be detected, since its values vary by definition, so attaching it to its group is a manual step the mapping table must support. Include/exclude and category are set on the group and apply to every member; individual members of a group cannot be excluded or categorized separately.

Two columns require explicit designation and cannot be excluded: **email** (used as the join key for later imports) and **display name** (first + last, or a single name column).

**FR-3 Import preview and commit.** Show row count, detected duplicates by email, and rows with a blank email or name. Admin resolves or discards these before commit. On commit, create one Applicant per row.

**Duplicates are compared on the normalized email — trimmed, NFC, lowercased — not the verbatim one.** USC addresses are case-insensitive, and two rows differing only in case would otherwise pass the preview and then violate `UNIQUE (instanceId, email)` at commit, after the admin has approved the import. The verbatim value is what the preview displays, so a normalization that changes anything is visible rather than silent; an address that is whitespace-only normalizes to empty and counts as blank, not as a duplicate.

The preview also carries two warnings that do not block, because each describes a plausible instance the system should not overrule:

- **A detected group that has been neither named nor dismissed.** Committing past it imports the columns as independent questions, and no demographic breakdown will ever find them.
- **No included field resolving to RESPONSE.** Under §6 that is the only category a written reviewer sees, so every profile in the written round would be empty — a failure that otherwise surfaces in front of thirty reviewers rather than here.

An instance accepts exactly one CSV. Commit is final, and a later upload into a committed instance is refused with a message naming the correction path rather than a disabled control. Corrections after commit happen by editing an applicant's fields directly, or by deleting the instance and importing again. This is why the preview above is load-bearing: it is the only point at which a bad file can be caught cheaply.

**What "final" covers is field *identity*, not presentation policy.** Frozen at commit: the one-CSV rule, and each column's category, group membership, display name and email/name designation. Not frozen: inclusion and the two per-round visibility toggles, which stay editable for the life of the instance. The line between them is what a property keys — `Applicant.data` is keyed by `Field.id`, so recategorising or regrouping a column changes what an already-written key means, while the three booleans key nothing and orphan nothing. See decision 34.

**Commit is guarded by a two-step confirmation**, because it is irreversible and it sits on a page whose whole purpose is reviewing and adjusting. Following the primary control renders a panel naming what is about to become final — how many applicants will be created, the one-CSV rule, and the column properties that freeze — and the commit itself is a separate submit inside that panel. Deliberately lighter than FR-5's typed-name gate for deletion, which is rare and destroys existing work, where commit is on the path every instance takes and creates rather than destroys. See decision 35.

**FR-4 Rubric builder.** Admin enters number of categories and max points per category. System generates the grid for naming each category and for describing it. Store as `RubricCategory`. Rubric is locked once any Score exists; changing it after grading has started requires an explicit "reset written scores" action with a confirmation.

**Per decision 40:** the builder collects the scale's *floor* as well as its maximum, so a cycle can run its categories 1–4 rather than 0–`maxPoints`. A new category starts at 1–4; an existing rubric that predates the column keeps a floor of 0 until an admin changes it, which is what makes the change silent for cycles already run.

**Each category carries a description, and it is optional but strongly prompted.** A name and a maximum are a scale, not a rubric: thirty reviewers scoring "Fit with Spark SC" out of 5 with no shared definition of a 4 produce exactly the divergence FR-10 then has to surface as high variance. The description is what FR-9 puts beside the score input. It is nullable because an admin mid-setup should not be blocked by it, and because a cycle that genuinely briefs its reviewers elsewhere is entitled to leave it empty.

The description is part of the rubric and is therefore covered by the same lock. That is deliberate but not free: a typo in a description cannot be corrected once grading has started without discarding every score. Accepted for v1 rather than building a second write path that bypasses the lock, on the grounds that the lock only engages after the first score is submitted and the rubric is written before reviewers are let in. If this bites in practice, the fix is a description-only edit action, since prose orphans no `Score` row — not a weakening of the lock itself.

**FR-5 Instance save.** Admin sets an instance name and password. Password is hashed (argon2id or bcrypt, cost ≥ 12). Never stored or logged in plaintext. Never recoverable; recovery means an admin with app-level access resets it.

Name and password are collected when the instance is created, at the start of the FR-2 import, because §5 makes `passwordHash` non-null and §8 forbids an ungated instance existing even as a draft. What FR-5 governs is therefore unlock and rotation, not creation.

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

  Precisely, for a reviewer `r` below the floor there must exist no applicant `a` and reviewer `s` such that `s` is assigned to `a`, `s` carries at least two more assignments than `r`, `r` is not already assigned to `a`, and replacing `s` with `r` on `a` would not leave `a` carrying two Sparklets. If such a triple exists, the load could have been evened out and was not, and the floor is violated. If none exists, the one-Sparklet-per-applicant rule is what stopped it, and `r` is exempt. The exemption is a property of the assignment, not of the reviewer, and being a Sparklet does not confer it.

  **Both bounds are checked when a plan is generated, and only then.** The ceiling is stated over `total_slots` so that it stays stable as returns add slots back to the pool mid-round. The floor is over `assigned_slots`, which *shrinks* every time a reviewer returns a slot, so it is not a property the assignment goes on having — a reviewer sitting at 13 in week two has returned a slot, not violated a rule, and nothing re-evaluates the floor until the next generation.

  At 150 applicants, 30 reviewers and 8 Sparklets no reviewer is below the floor at all: `428 = 30 × 14 + 8`, and 8 Sparklets need at most 120 of the 150 available Sparklet slots, so the split into 8 reviewers at 15 and 22 at 14 is reachable. The exemption is never consulted and the floor binds on all 30. It is reached where the rule has genuinely run out of room — 15 Sparklets over 150 applicants, every applicant already carrying one — where Sparklets stop at 10 while non-Sparklets carry 18 or 19.
- Pool size is exactly `min(max(floor(0.05 × total_slots), 3), applicant_count)` — the floor first, then the minimum of 3, then the cap, which wins over both. At 150 applicants: `floor(22.5) = 22` slots across 22 distinct applicants. **Floor, not round**: 22, never 23. At 10 applicants: `floor(1.5) = 1`, raised to 3. At 2 applicants: raised to 3, then capped back to 2.
- Each pooled slot comes off a *different* applicant, so an affected applicant is short exactly one reviewer. This is why the pool cannot exceed `applicant_count`: with 2 applicants, a 3-slot minimum would force someone short two, which defeats the purpose. On instances that small the pool is 2 slots, or fewer.

**Feasibility constraint.** With at most 1 Sparklet per applicant, non-Sparklets must fill at least 2 of every 3-slot applicant and at least 1 of every 2-slot applicant. At 150 applicants with a 22-slot pool that is `2 × 128 + 1 × 22 = 278` of 428 assignable slots, or 64.9% — so the "Sparklets ≤ one third of the roster" rule of thumb is deliberately conservative. **The precheck computes against actual assignable slots, not the one-third shortcut.**

When the check fails, the system must not silently violate a constraint. It tells the admin plainly: "You have 14 Sparklets among 30 reviewers. Even distribution is not possible under the one-Sparklet-per-applicant rule. Options: add non-Sparklet reviewers, or allow Sparklet load to be lighter than average."

**Per open decision 2, the second option is offered as an action, not just as prose.** Choosing it generates under a relaxed load rule: the one-Sparklet-per-applicant constraint is never broken, Sparklets take whatever the constraint allows, and non-Sparklets absorb the remainder bounded by `ceil(non_sparklet_slots / non_sparklet_count)`. In the example above that is 16 non-Sparklets carrying ≥278 slots, about 17.4 each, against the 15 that the unrelaxed rule would give. The admin sees both numbers before confirming. The one-Sparklet rule is never the thing that gives.

**FR-8 Manual assignment override.** Admin can assign, unassign, or swap any reviewer on any applicant. Overrides are marked origin: MANUAL so a later regeneration does not clobber them without warning.
A regeneration that preserves manual overrides treats them as consumed capacity rather than as exclusions. A preserved MANUAL assignment counts against its reviewer's load ceiling and against the one-Sparklet-per-applicant rule when the algorithm fills the remaining slots, and the applicant it belongs to still participates in the rest of generation for its unfilled slots. Excluding the applicant wholesale would let manual overrides quietly degrade load evenness. Where the preserved set already exceeds a ceiling or already puts two Sparklets on one applicant, generation reports the violation and does not correct it by removing a manual assignment.

**`CLAIMED_FROM_POOL` is preserved on the same footing as `MANUAL`** (open decision 21). Both are deliberate rather than generated, and a claimed slot may already carry a score. This paragraph named only MANUAL because claiming did not exist when it was written. The regeneration warning names the two counts separately, so an admin discarding manual overrides is not silently discarding claimed work as well.

**A `RETURNED_TO_POOL` row is an exclusion, not consumed capacity** (open decision 23). It records that a reviewer recused from that applicant, so generation must never re-create that pair — but it occupies no slot and counts against nobody's load. It is a third input to generation, distinct from both preserved and generated rows.

**FR-9 Reviewer dashboard, written.** Reviewer selects Round → Written, then their name from a dropdown. They see:

- Their assigned applicants as a list with completion state (0/4 scored, 4/4 scored)
- An applicant detail view: anonymous label (e.g. "Applicant 47"), all RESPONSE fields, rubric always visible alongside. No name, per §6.
- Score inputs per rubric category, plus a free-text note
- Autosave on every change. A dropped connection mid-review must not lose work.
- "Return to pool" on any applicant, with a required reason (conflict of interest / other)
- "Claim from pool," showing open assignment slots on applicants who are short a reviewer

**How a reviewer gets here, since the six bullets above assume it and no requirement stated it.** Reviewers do not pass the §8 app-level gate and never see the instance list. They arrive on a per-instance link shared in the club Slack, pick the round, pick their name, and enter that round's access code — one screen, one submit, per decision 30. Verifying the code starts a reviewer session held in its own signed cookie, separate from the admin session so that neither confers the other, and carrying the instance, the round, and the reviewer id. Every reviewer page and every reviewer action re-checks it; an assignment id in a URL is an untrusted reference until it has been confirmed to belong to the session's reviewer. The code itself is set by an admin, per decision 31.

**FR-10 Written results dashboard.** Applicants ranked by average score descending, then by variance ascending. Each row shows: rank, name, average, variance, review count (2/3, 3/3), and demographic fields inline. Filters for "high variance" and "incomplete." Admin can open any applicant to read the full profile and all three reviewers' scores and notes.

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

**FR-14 First-round reviewer dashboard.** Round → First Round, then name. Reviewer sees each applicant's average interview score per interviewer prominently, with the per-category scores collapsed by default and expandable, plus the interview notes. The category count follows the configured `InterviewCategory` rows — four in S26, but the layout must not assume that. Demographics and written responses are hidden per §6. Reviewer votes YES or NO per applicant. No vote recorded means SKIP.

**FR-15 First-round results.** Applicants ranked by yes percentage descending, where `yes% = yes / (yes + no)`, skips excluded from both numerator and denominator. Show raw counts alongside the percentage; 2/2 and 14/14 are not the same signal. An applicant with zero non-skip votes carries no real percentage; the count cell — not the row — carries a visual marker the same way FR-10's under-3/3 marker works, per decision 46. Two applicants tied on yes percentage are ordered by raw non-skip vote count descending, then `sourceRowIndex` ascending, per decision 46.

Selection and demographic-breakdown behavior mirrors FR-11's UI. Finalize semantics, stated explicitly rather than left to the word "mirrors": for every applicant in the first-round pool (`status = ACTIVE`, `stageReached = FIRST_ROUND`), write one `Decision` row at `stage = FIRST_ROUND`. Selected: `outcome = ADVANCE`, `status` stays `ACTIVE`, `stageReached → SECOND_ROUND`. Not selected: `outcome = REJECT`, `status → REJECTED`, `stageReached` stays `FIRST_ROUND`. Finalizing moves `Instance.currentStage → SECOND_ROUND`, load-bearing for this screen's post-finalize read-only state exactly as decision 43 made it load-bearing for `/results`. The confirmation panel names any applicant with zero non-skip votes before finalizing, same reasoning as decision 44 — there is no fixed review-count target here to fall short of, so the flag is literal zero rather than "under some threshold."

### 7.4 Second round and passes

**FR-16 Second-round reviewer dashboard.** Round → Second Round, then name. Reviewer sees the complete applicant profile: demographics, written responses, written scores, written review notes, interview scores, interview notes. Written and interview evaluations are attributed to the person who gave them, per decision 77. Reviewer can flag conflict of interest per applicant, which is sticky across all passes.

**FR-17 Passes.** The admin creates sequential passes. This is the most intricate piece of the system, so the state machine is specified explicitly:

- A pass is created by an admin. Its membership is fixed at creation: every applicant with `status = ACTIVE`.
- Exactly one pass is OPEN at a time. A submitted vote lands in the currently open pass.
- A reviewer with an active COI on an applicant has their vote in that pass automatically set to SKIP and cannot vote on that applicant.
- A vote requires an explicit submit action. Selecting yes/no without submitting records nothing.
- An applicant is **resolved** within a pass when every non-SKIP reviewer has submitted:
  - All YES → `PassApplicant.resolution = SPARKLET`, `Applicant.status = SPARKLET`, excluded from future passes
  - All NO → `resolution = REJECTED`, `status = REJECTED`, excluded from future passes
  - Mixed → `resolution = CARRIED`, stays ACTIVE, carries into the next pass
- An admin can manually reject any applicant within a pass, excluding them from future passes.
- Closing a pass without full votes leaves unvoted applicants ACTIVE and carried forward. Their row on that pass stays `resolution = NULL` — the close itself writes nothing, per decision 72.
- A vote can be changed until that applicant resolves, per decision 75. Resolution closes the window on its own, since it requires every eligible reviewer to have submitted.

**`PassApplicant.resolution` records what happened to an applicant *in that pass*. It does not control membership in the next one.** Membership is recomputed at each pass creation from `Applicant.status`, so an applicant can carry a terminal-looking `NEEDS_ADMIN` on pass 1 and still appear in pass 2. These are separate questions and the schema keeps them separate deliberately.

**Closing the second round.** Passes do not end on their own — an admin ends them with an explicit "Close second round" action, which is what moves `Instance.currentStage` to `COMPLETE`. That action writes `resolution = NEEDS_ADMIN` onto the final pass's rows for every applicant still unresolved — `NULL` or `CARRIED`, per decision 73 — and is the *only* thing that produces FR-19's Unresolved group. It also closes the final pass if it is still open, so a `COMPLETE` instance cannot hold an `OPEN` one. Three properties it must have:

- **Idempotent.** Running it twice writes the same rows and changes nothing the second time.
- **Blocked when no pass exists.** An admin who reaches the second round, creates no pass, and closes the round would otherwise leave every applicant unresolved with no `PassApplicant` row to find them by, and FR-19 would render an empty Unresolved group over a live pool. Tell the admin to create a pass first.
- **Audited**, per §8, alongside the other admin overrides.

Note that `Applicant.status` stays `ACTIVE` for these applicants — there is no `UNRESOLVED` status, because an applicant's fate at the end of the round is already recorded on their final pass row and a second copy could disagree with the first. **FR-19, FR-20, and the §8 archive-and-purge therefore identify unresolved applicants by that row, never by `status`.** A successor reading `ACTIVE` in a `COMPLETE` instance is looking at the wrong column.

**Edge cases that must be handled explicitly, not left to inference:**

| Case | Required behavior |
|---|---|
| All reviewers have COI on an applicant | Cannot resolve. `resolution = NEEDS_ADMIN` on that pass. Do not treat as unanimous. The applicant stays ACTIVE and **carries into the next pass**, where a reviewer without a conflict may yet be added — `NEEDS_ADMIN` describes the pass, not the applicant. |
| Pass created with zero ACTIVE applicants | Block creation, tell the admin the pool is resolved. |
| Pass created with zero reviewers on the second-round roster | Block creation, per decision 79. Every member would resolve `NEEDS_ADMIN` at creation — a pass that decides nothing and flags everyone. |
| A reviewer is added or withdrawn mid-round | Cannot happen. Decisions 66 and 78 fix the second-round roster once `Instance.currentStage` reaches `SECOND_ROUND`, in both directions. This replaces the earlier "they vote only in passes created after they are added", which described a situation the roster page no longer permits. |
| Admin reopens a closed pass | Not supported in v1. Corrections happen via manual override on the applicant. |
| Passes end with an applicant still unresolved | The "Close second round" action writes `resolution = NEEDS_ADMIN` on their final pass row. They are neither SPARKLET nor REJECTED, and FR-19 lists them under Unresolved rather than defaulting them either way. |
| Second round closed with no pass ever created | Block the close. See "Closing the second round" above. |

**Open decision:** should reviewers see live vote counts during an open pass? No, to prevent anchoring, counts are never revealed to reviewers. Reviewers should not have knowledge of other reviewers' votes. Decision 74 extends that to a *closed* pass as well and amends §6's matrix accordingly: FR-18's admin-only grid is the only surface in the product that renders a pass vote.

**FR-16's conflict flag is one-way for the reviewer and removable by an admin**, per decision 76. Flagging deletes any vote that reviewer had already cast in the open pass (decision 68) and that vote does not come back; an admin removing the flag returns the reviewer to the denominator as outstanding. The control lives on FR-18's grid, on the `skip` cell that shows the conflict, and is audited.

**FR-18 Pass dashboard.** Per pass: a reviewer-by-applicant grid showing blank / yes / no / skip, with per-applicant totals and resolution state. This is the direct replacement for the `2RD Vote` sheet, generated instead of hand-maintained. This is only accessible by admin.

### 7.5 Final and export

**FR-19 Final dashboard.** All second-round applicants sorted into New Sparklet, Rejected, and Unresolved, with full profiles accessible.

**Unresolved** is every applicant whose row in the final pass carries `resolution = NEEDS_ADMIN` — which covers both an applicant every reviewer recused from and one who simply never reached a unanimous result before the round closed. Both require an explicit admin decision and must not be silently dropped. The group is identified by that pass row, never by `Applicant.status`, which stays `ACTIVE`; see FR-17. The underlying votes remain visible, so an admin can tell the two situations apart — eleven skips reads very differently from 7–4.

Demographic breakdown of the Sparklet class against each preceding stage, replacing the manual `Overall Stats` sheet.

**FR-20 Export.** One-click export of the entire instance as JSON, plus per-stage CSVs (all applicants with scores, decisions by stage, final class with emails). Non-negotiable for succession: the club must never be locked into this tool.

## 8. Security and data handling

The applicant data is sensitive. The S26 file contains real names, USC emails, essays about family trauma and immigration status, self-reported ethnicity, and first-generation status.

- **Admin access:** app-level password gate on the instance list, plus a per-instance password. The instance list itself must not be publicly enumerable.
- **Reviewer access:** a per-round access code shared in the club Slack, plus name selection. A name dropdown alone would let anyone with the link vote as anyone. The code keeps friction at one extra field while closing that hole.
- **Passwords:** hashed with argon2id or bcrypt. Never logged, never emailed, never displayed.
- **Transport:** HTTPS only, enforced.
- **Repository:** real applicant data never enters the repo. `.gitignore` covers `*.csv`, `*.xlsx`, `/data`, `/uploads`. Development uses synthetic seed data.
- **Retention:** an admin-triggered "archive and purge" that keeps aggregate statistics and deletes essays, emails, and demographics for cycles older than a configurable threshold. Recommend two cycles.
- **Audit:** log admin overrides (manual assignment, manual rejection, decision reversal) with actor, timestamp, and previous value.
- **Instance deletion is audited, and its audit row outlives the instance.** Deleting an instance runs in one transaction: purge that instance's existing `AuditLog` rows, since they describe entities about to stop existing and their `previousValue` payloads can carry applicant data that retention says should not survive the cycle; write the deletion record with the instance's name, applicant count, and stage, and no applicant data; then delete the instance, which `ON DELETE SET NULL` leaves the record orphaned by design. What remains is exactly one row per deleted instance. Archive-and-purge must age these out on the same threshold as everything else, or they accumulate forever.

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
2. **Sparklet-heavy roster handling. RESOLVED: Uneven Sparklet load.** When the feasibility check fails, does the club prefer uneven Sparklet load or relaxing the one-Sparklet rule?
3. **Live vote visibility in passes.** RESOLVED: See FR-17.
4. **Blind written review. RESOLVED: Written reviewers should not see applicant names.** Should written reviewers see applicant names at all? Hiding them is a small change now and a much larger one later.
5. **Multiple concurrent admins. RESOLVED: Based on v1 recommendation** Two admins editing assignments simultaneously. v1 recommendation: last-write-wins with a visible "changed by X at Y" indicator rather than locking.
6. **Interview score scale. RESOLVED.** The S26 `1R Scores` sheet carries **four category scores plus an average, per interviewer** — not the single score FR-12 originally assumed.

   *Display:* show the average prominently, with the category scores available but collapsed by default, for both interviewers. Ten numbers on a phone screen works against FR-14's friction goal if all are shown at once.

   *Model:* §5 now carries `InterviewCategory` and `InterviewCategoryScore`. The interview rubric is **instance-scoped and admin-configured, not four fixed columns and not shared with `RubricCategory`** — the written and interview rubrics are different instruments, and goal 5 requires both be reconfigurable between cycles. `InterviewResult.score` is the average **as imported**, never recomputed from the category rows; see FR-12 for how a disagreement between the two is surfaced. This is Phase 5 schema work and is not in the current migration.
7. **Multi-select demographic counting. RESOLVED: fractional counting.** An applicant checking both "East Asian" and "White" needs a defined counting rule for the demographic breakdowns in FR-11 and FR-19. The current spreadsheet concatenates the values into a single string ("South AsianIndian"), which is not countable.

   An applicant checking *n* categories contributes `1/n` to each: two boxes gives 0.5 each, three gives 0.33 each. Display one decimal place alongside a raw headcount — "East Asian: 12.5 weighted / 18 checked" — since a panel showing fractional people with no explanation will read as a bug to a successor.

   **Applicants who check nothing go in a "Not specified" bucket**, counted as a whole person there. `1/n` is undefined at `n = 0`, and without the bucket those applicants vanish from the breakdown entirely and the weighted column silently sums to the responder count rather than the headcount. With it, the invariant holds as stated: **weighted totals sum to the headcount.** Note that an applicant who checks no box but writes into the free-text `Specify your ethnicity…` column has given a real answer that the count cannot read; they belong in "Not specified" too, and the free-text values are worth showing beneath the breakdown rather than discarding.

   **What counts as checked (see also decision 12 on how a group comes to exist at all):** the one-hot columns store the column's own label when checked and an empty string when not, which is what the form exports actually emit. Checked means a non-empty value; empty string, `null`, and an absent key are all unchecked. This predicate belongs in one shared helper, not re-derived per surface. The free-text Specify your ethnicity… column is a member of the group with groupRole = FREE_TEXT. It is excluded from the checked predicate and from 1/n, and it is what FR-19 displays beneath the breakdown. Being a member is what lets FR-19 find it; being FREE_TEXT is what keeps it out of the count. Inclusion is set on the group and applies to every member, so n is never counted over a partially excluded set.

8. **Import draft state. RESOLVED: a staging table.** Parsed rows land in `ImportRow` at upload and are deleted at commit; detected group proposals live in `Instance.importProposals` until named or dismissed, and are cleared at the same moment. A `CHECK` makes that clearing a database guarantee rather than a line of code. Rejected: a client-held payload, which exceeds Next's 1MB server-action body limit on a real 150-applicant export with five essays each; and a temp file, which does not survive a Vercel deploy.

9. **Instance created before the CSV commits. RESOLVED.** Name and password are collected at upload, because `passwordHash` is non-null and §8 forbids an ungated instance existing even as a draft. FR-5 therefore governs unlock and rotation, not creation. Consequence: FR-1 lists draft instances, marked as such.

10. **Email normalization. RESOLVED: trim, NFC, lowercase, and compare normalized.** See FR-3. The staging row keeps the verbatim value and the preview reports any change, so nothing is silent; the pre-normalization form is not retained after commit.

11. **`sourceRowIndex` from parse order. RESOLVED.** Assigned at parse, 1-based, never renumbered. Discarding a row at preview leaves a gap, which is correct: the label points at a record in the source file, and renumbering would break that correspondence for the one audience — written reviewers — who see nothing else.

12. **Group detection scope. RESOLVED.** Exact equality with the column's own header, runs of two or more, empty columns never grouped. Detection produces a proposal that the admin names or dismisses; it never writes a `FieldGroup` on its own. A form tool that exports `Y`/`TRUE`/`1` rather than the option label detects nothing and the admin groups by hand — the safe failure, since no detection costs a minute and a wrong silent detection costs a cycle.

13. **`FieldGroup.key` immutability. RESOLVED: assigned at creation, never re-slugged.** See §5. This is why detection defers materialization: a key stamped before anyone named the group would read `group-1` forever, in every export FR-20 produces.

14. **Auditing instance deletion. RESOLVED: the audit row outlives the instance.** See §8. Rejected alternative: declaring deletion unaudited in v1, which is only defensible if nothing is audited, and §8 already requires overrides be logged.

15. **What gates password reset and instance deletion. RESOLVED: the app-level password.** See FR-5.

16. **Admin identity behind the app gate. RESOLVED: Name prompt (first and last) at sign-in. — implementation lands in Phase 8.** §8 specifies one app-level password shared by 2–6 admins, so `AuditLog.actor` has no real identity behind it: every override, and now every password reset and instance deletion, is attributable to "an admin" and nothing finer. Acceptable among E-Board members who trust each other; not acceptable as the permanent answer for a log whose entire purpose is attribution. Options: per-admin accounts, or a name prompt at sign-in recorded on the session and copied into `actor` — weaker, but honest and cheap. 

17. **Two fixture directories. OPEN — no phase assigned.** `fixtures/sample-headers.csv` sits at the repo root while `prisma/fixtures/` holds the synthetic export and its README. Two directories for one purpose invites saving a file in the wrong one, and the wrong one may hold real applicant data. The `.gitignore` now names both exempt files exactly rather than globbing a directory, so neither location is currently a hole, but the duplication is the underlying problem and the ignore rules are only a guard against it. Consolidating means moving the file, updating `prisma/seed/headers.ts`, `.gitattributes`, `.gitignore`, and the phase-0 record — small, but it touches the seed, so it wants its own change rather than riding along with feature work.

18. **Which categories the per-round visibility toggles apply to. RESOLVED: OTHER only.** §6 spells DEMOGRAPHIC and RESPONSE as flat Hidden/Visible and marks only OTHER "configurable, default hidden", but the schema carries the nullable override columns on every `Field` and `FieldGroup`, so the question of what happens to an override stored on a DEMOGRAPHIC row had no stated answer.

    Honouring it would create a route to showing ethnicity to written reviewers that no requirement asks for, against goal 3's premise that the bias controls are enforced by the system rather than by an admin remembering. So `lib/fields.ts` reads an override only where the resolved category is `OTHER`, and the FR-2 mapping table only offers the toggles there — an override on another category is unreachable through the UI and inert if it arrives some other way.

    The cost is that the columns are wider than their meaning: a DEMOGRAPHIC row can hold a value that nothing reads. Accepted rather than splitting the columns per category, which would complicate the resolver to prevent a state the UI cannot produce. If a future cycle genuinely needs one response hidden from written reviewers, that is a §6 change first.

19. **Rate limiting on the password endpoints. PARTIAL — a stopgap shipped in Phase 1; Phase 8 owns the real answer.** `lib/rate-limit.ts` allows 10 failures per key in 15 minutes and then locks that key for 15 minutes, where a key is the scope plus the client IP. It is consulted before the argon2 verify, so a locked-out caller costs nothing to refuse and learns nothing.

    **What it does not cover, so Phase 8 does not mistake it for the answer:**

    - **State lives in the process.** It resets on every deploy, and on a serverless host each instance keeps its own map — an attacker whose requests land on different instances gets the full allowance from each. A shared store (the database, or Redis) is what makes the limit real.
    - **The key is the client IP,** read from `x-forwarded-for`. Anyone with a pool of addresses sidesteps it, and a request with no such header falls into one shared `unknown` bucket. That fallback is deliberate — stripping the header must not escape the limiter entirely — but it means several admins behind one NAT share an allowance.
    - **It does not extend a lock when a locked-out key keeps trying.** That is on purpose: a locked attempt is refused before any password check, so counting it slows nobody, while extending would let anything retrying in a loop hold the lock open against the real admin. The consequence is that the ceiling really is 40 guesses an hour per address, not less.
    - **It is not a substitute for a strong password.** It raises a brute-force attempt from free to slow. `npm run hash-secret` says so where the password is chosen.
    - **Nothing is logged.** A sustained attack is invisible. Phase 8's audit work should record lockouts.

20. **Pool and target on a roster too small for 3. RESOLVED: the pool is 0 when the target is below 2.** FR-7's pool formula is written against a target of 3 and says nothing about a one-reviewer roster, where `min(3, 1) = 1` and withholding any slot leaves an applicant with no reviewer at all — the model decision 1 rejected. There is also nothing to buffer: the pool exists so a recusing reviewer's slot can be claimed by someone else, and with one reviewer there is no someone else. At two reviewers the formula already behaves, capping at `applicant_count`.

21. **`CLAIMED_FROM_POOL` across a regeneration. RESOLVED: preserved alongside `MANUAL`.** FR-8 names only `MANUAL` because claiming did not exist when it was written, but both are deliberate rather than generated, and by the written round a claimed slot may already carry a score. Regeneration consumes both as capacity and clobbers neither, and its warning names the two counts separately so that discarding manual overrides does not silently discard claimed work too.

22. **Duplicate-name scope on a roster paste. RESOLVED: compared against the paste and against every reviewer on the instance.** FR-6 covered only the within-paste case, but the likelier accident is re-pasting the same Slack message. `Reviewer` is instance-scoped with a `rounds` array, so a match is the same person, and comparing per round would answer "is this a new person?" with "is this person already staffed here?" — producing two rows for one human. A match offers "add this round to them" or "create a second reviewer", with no default, since guessing either way is silently wrong: one merges two people, the other splits one. Comparison folds case and collapses whitespace but keeps the two name halves apart, so ("Ann Marie", "Smith") and ("Ann", "Marie Smith") stay distinct.

23. **`RETURNED_TO_POOL` rows during a regeneration. RESOLVED: an exclusion, not consumed capacity.** The row is the record of a recusal. Generation must never re-pair that applicant and reviewer, and the row must not count against anyone's load — those are two different things, and treating it as either one alone gets the other wrong. Inert until Phase 3 builds return-to-pool, but the input shape had to be right before anything was written against it.

24. **Removing a reviewer, or unchecking a round, with live assignments. RESOLVED: blocked while they hold submitted work.** `Assignment` cascades from `Reviewer` and `Score`/`ReviewNote` cascade from `Assignment`, so removal destroys reviewer work silently and with no undo. Refused where any affected assignment carries a score or a note, naming unassign-or-regenerate as the way out; otherwise the confirmation states the assignment count and that the slots return to the pool. Unchecking a round is the same rule scoped to that round, so the checkbox is not a cheap way around the block. No `Score` row can exist before Phase 3, so the refusal is unit-tested rather than demonstrated — the same posture FR-4's rubric lock already takes.

25. **How the roster's four name-entry paths stay consistent. RESOLVED: one shared gate.** A name reaches the database by four routes — a pasted line, the two free-text inputs the paste queue offers for a line it could not split, the manual-add form, and a rename in the grid — and only the first is a line at all. `lib/roster.ts` exports one `checkReviewerName` that all four call. It returns the values to store, which is what makes it impossible to validate one string and persist another; it normalizes without folding case, since folding belongs to the comparison key and a gate that lowercased would put the roster and FR-20's export of it in lower case; and it reports duplicate names rather than refusing them, because FR-6 allows two reviewers to share one.

26. **A save in flight when the reviewer navigates away. RESOLVED: settle within 1500 ms or hold, and never a silent loss.** FR-9 requires autosave and that a dropped connection not lose work, but says nothing about the reviewer who changes a score and immediately closes the tab or hits back. If the in-flight save settles fast enough the navigation is not blocked; past the threshold the app holds or warns until it resolves or fails.

    **The threshold is 1500 ms.** One upsert through a server action is 80–250 ms in practice; add a slow-4G round trip and a healthy save still settles under 600 ms, so 1500 ms is roughly 5× the realistic worst case and effectively never fires on a connection that is working. It sits below the ~2 s at which a person concludes the app is stuck and force-closes it — which is the behaviour that causes the loss — and above the ~1 s that still reads as an uninterrupted flow, so a dialog appearing at 1.5 s reads as "something is wrong" rather than as a normal step.

    **What the app can actually do differs by how the reviewer leaves, and the requirement is only honest if that is stated.** In-app navigation is genuinely holdable: past 1500 ms it shows a blocking state offering *Wait* or *Leave anyway*, and *Retry* or *Leave anyway* if the save has already failed. A tab close is **not** holdable — `beforeunload` is the only lever, it is synchronous, and the reviewer can dismiss it — so it is registered whenever anything is dirty or in flight and nothing more is claimed for it. Backgrounding the app, which on a phone is the common case rather than the exception, flushes the pending debounce immediately on `pagehide` / `visibilitychange` rather than waiting it out, so most of these never become a warning at all.

    **So the guarantee is not the dialog.** Every change is mirrored to `localStorage` under the assignment id, cleared only on a confirmed save, and restored when the reviewer next opens that applicant. The dialog reduces how often that restore is needed; the mirror is what makes "never a silent loss" true even when the operating system kills the tab. Relatedly, a save is an upsert on `(assignmentId, rubricCategoryId)`, so a retry after an ambiguous failure cannot write twice — "no silent duplicate write" comes from a constraint that has existed since Phase 0, not from a nonce.

27. **Free text when the return reason is "Other". RESOLVED: optional, the same as conflict of interest.** FR-9 requires a reason and offers two; it does not say whether picking "Other" then demands an explanation. It does not. A required text box is a wall in front of the one action a reviewer takes when they recognize an applicant, and the reason category is what an admin acts on — an unexplained "Other" is still more information than an abandoned return. `Assignment.returnNote` stays nullable for both values.

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

    **The description is inside FR-4's lock, and the consequence is stated rather than discovered:** once any `Score` exists, fixing a typo in a description requires the reset that discards every score. Rejected the alternative of a description-only write path that bypasses the lock — it is the right eventual answer, since prose orphans no `Score` row, but it is a second mutation route into a locked table and Phase 3 is not where that belongs.

33. **Work typed before the page finishes hydrating. RESOLVED: adopt the DOM, submit through forms, and never leave a control silently dead.** Distinct from decision 26, which is about a save already in flight. This one loses work *before any save is attempted*, and the two need different fixes.

    **The mechanism, because it is invisible in the code.** A server-rendered page is interactive-looking long before React attaches to it. In that window the markup is real, the fields accept keystrokes, and nothing is wired up. When React hydrates a **controlled** input it renders its own state — which is empty — over whatever is in the DOM, so anything typed in that window is silently discarded. No error, no failed request, nothing in a log: the characters were simply never React's to keep. Measured on this app at roughly **640 ms** on a warm route on a desktop; a cold route in development and a phone over Wi-Fi are both slower. A reviewer who opens an applicant and starts typing immediately is not an unusual user, they are the fast one.

    **The same window has a second effect, on controls rather than fields.** A `<button type="button">` driven by `onClick` has no native behaviour, so a tap before hydration does nothing at all and says nothing. A `<form>` bound to a server action does not share this: React ships it with `method="POST"` and hidden `$ACTION_REF_*` fields, so it submits natively with no JavaScript. Whether a control works before hydration is therefore decided by how it is built, not by what it does.

    **Resolution, three parts:**

    - **Adopt whatever is already in the DOM on mount** rather than assuming a field starts empty, so keystrokes from the hydration window are picked up instead of overwritten.
    - **Every control that mutates data is a form submit**, not an `onClick` handler, so it works before hydration rather than pretending to.
    - **Any control that genuinely cannot work yet says so**, disabled until hydrated, because a button that ignores a tap in silence is worse than one that admits it is not ready.

    Found while investigating why three separate buttons appeared to ignore clicks. Two of those turned out to be a test-automation artifact and one was this. The distinction matters: the automation problem was noise, and underneath it was a real way to lose a reviewer's work on the one screen whose requirement is that work is never lost.

34. **What FR-3's finality covers. RESOLVED: field identity is frozen at commit, presentation policy is not.** FR-3 says "commit is final", and the implementation read that as the entire mapping surface: `/mapping` renders a card and returns early once `importCommittedAt` is set, and every mapping action refuses server-side as well. The stated reason is that `Applicant.data` still points at the old field ids. That hazard is real, but it only covers some of what got frozen — the rest was frozen because it happened to share a screen.

    **Frozen, and correctly:** `category`, group membership and group role, group creation, split and merge, `displayName`, and `promotedRole`. Each of these changes what an already-written `fieldId` key means, or what §10.7 counts over, across a cohort that already exists. `promotedRole` is the strongest case and is different in kind from the others: the EMAIL and NAME columns' `Field` rows are *deleted* at commit, once their values become `Applicant.email` and `Applicant.displayName`, so there is nothing left to re-designate. Its freeze is a fact about the data rather than a choice about scope.

    **Editable after commit:** `isIncluded`, `visibleToWrittenReviewer` and `visibleToFirstRoundReviewer`, on both `Field` and `FieldGroup`. They key nothing. §6 marks OTHER "configurable" and FR-2 names the mapping table as where it is configured, so freezing them left that capability with nowhere to live. They are also **per-round** controls, and rounds run weeks after an import — so the one window in which an admin could decide what written reviewers see closed before the applicants existed and long before any reviewer signed in. An admin realistically asks "should written reviewers see the major?" while briefing reviewers, not while mapping CSV columns. The only correction FR-3 offered was deleting the instance and importing again, which destroys every applicant, assignment and score to change one boolean.

    **Two consequences, stated rather than left to be discovered.** Un-including a column after commit removes it from FR-10's admin profile as well as from every reviewer surface, since `lib/fields.ts` resolves `isIncluded: false` to invisible for every viewer including ADMIN — and it is reversible, because commit writes every non-promoted column into `Applicant.data` regardless of inclusion. Separately, because category stays frozen, the *set* of columns eligible for a per-round toggle is fixed at commit: decision 18 reads an override only where the resolved category is OTHER. A column mis-marked RESPONSE can still be hidden by un-including it. A column mis-marked DEMOGRAPHIC cannot be shown to written reviewers at all, and that case stays stuck deliberately — unfreezing category would create a two-step route, recategorise and then tick Written, to showing ethnicity to written reviewers, which is the hazard goal 3 exists to close.

    **Audited under §8, and allowed at any time including mid-round.** Audited on decision 31's argument, since it changes who can reach applicant data. Not restricted to the gaps between rounds, because the admin who notices the problem while reviewers are working is precisely the person this decision is about, and a mid-round block would rebuild the same trap one layer in.

    No schema change. All three columns have existed on both tables since Phase 0; §5 is unchanged by this decision.

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

    **Related, and the reason this needed writing down at all:** decision 26 is careful that the dialog is not the guarantee and the mirror is. That makes the mirror the one component whose *absence* is a silent failure and whose *persistence* is a privacy question, and it had neither an owner nor an expiry. Both are now stated. No schema change and no server-side storage — this is entirely browser-local, which is also why §8's retention rules could never have reached it.

38. **Unsaved work at the moment an applicant is returned to the pool. RESOLVED: the return clears that assignment's draft, and does not hold for a save in flight.** Decision 37 named three things that clear the mirror — a confirmed save, signing out, and the 7-day TTL — and returning an applicant is a fourth that it did not anticipate, because return-to-pool did not exist when it was written.

    It is different in kind from the other three, and that is what decides it. After a return the reviewer no longer holds the assignment, so every subsequent write for it is refused: the save path re-checks ownership on each request precisely because an assignment id in a request body is untrusted. A mirror entry for a returned assignment can therefore *never* be flushed. It would sit on the device for seven days as reviewer-authored text about an applicant the reviewer has just recused themselves from — which is the exact exposure decision 37 exists to bound, in its least defensible form.

    **The same reasoning removes the navigation hold.** Decision 26's 1500 ms hold waits for an in-flight save to settle before letting the reviewer leave. Applied to a return it would wait for a save that the return itself has guaranteed will be refused, and then offer *Retry* — so the honest behaviour is to not hold at all. The return submits, the assignment leaves the list, and nothing claims otherwise.

    **What is lost is stated plainly rather than implied: work typed and not yet saved at the moment of return is discarded.** That is the intended reading of the action — the reviewer is saying this applicant is not theirs — and it is bounded, because scores and a note already confirmed are *not* deleted by a return. A reviewer who returns in error and claims the applicant back under decision 28 finds everything the server had acknowledged still there.

    Carries decision 37's caveat unchanged: the clear is a client-side side effect on the submit, so a return tapped before the page hydrates returns the applicant and leaves the draft behind. Clearing browser storage is not something a server action can do, and the TTL remains the backstop. No schema change.

39. **A return reason that nobody can read. RESOLVED: returned rows render on the admin assignments page.** FR-9 requires a reason on return-to-pool and decision 27 made its free text optional on the explicit ground that "the reason category is what an admin acts on". Every query on `/instances/[id]/assignments` filters `status: ACTIVE` — the load table, the short-a-reviewer filter, the per-applicant reviewer list, all of it — so a returned row was written, was correctly preserved through regeneration as an exclusion under decision 23, and was visible to nobody. The one requirement the reason exists to serve had no surface.

    This is decision 29's general form for the third time — *a capability that is correct and unreachable is indistinguishable, from the outside, from one that is missing* — and it is the cheap variety: the data was already stored, already correct, and already loaded on the right page under a different filter.

    Each applicant now shows its returned assignments beneath its active reviewers, dimmed and non-actionable, naming the reviewer, the reason, and the free text where one was written. Non-actionable deliberately: a returned row is the record of a recusal, and an admin who could delete it would be able to let generation re-pair that reviewer with that applicant, which decision 23 forbids. The way to put a reviewer back on an applicant they returned is FR-8's assign.

    **FR-8's assign has to be taught about that row, and this is the second half of the same gap.** `assignReviewer` checks only the applicant's *active* reviewers and then inserts, so assigning a reviewer who had returned that applicant violated `UNIQUE (round, applicantId, reviewerId)` and surfaced as a raw database error. It was unreachable until now for the same reason the missing surface was invisible — nothing could create a returned row before FR-9's return-to-pool existed. It reactivates the row as `MANUAL` instead, clearing the return fields, exactly as decision 28 has a reviewer's own re-claim reactivate it as `CLAIMED_FROM_POOL`. Both are a deliberate person overriding a recusal, and neither is generation.

40. **The written scale runs 0 to `maxPoints`, and the rubric it is meant to express runs 1 to 4. RESOLVED: `RubricCategory` gains a `minPoints` column — and the change is deferred to Phase 4.** `maxPoints` is the only bound in §5, and the floor is hardcoded in `lib/review.ts` as "reject anything below zero", so a 5-point category offers six values. The intended instrument is four: fewer options score faster and agree more often across thirty untrained reviewers, and no submitted answer should be scorable as nothing. Raised by the owner during the Slice 7 board-member run; it is a rubric-design decision rather than a defect, and the screen does exactly what FR-4 currently specifies.

    **Why a column rather than a stated convention**, which was the cheaper option and is the wrong one. A convention — "scales run 1 to `maxPoints`, 0 is never offered" — is a change to validation code, so it applies to every instance that has ever existed. Instances here are per-semester and are kept: a past cycle whose reviewers legitimately recorded a 0 would suddenly hold scores the current scale says cannot exist, which FR-10 would then average and FR-20's export-and-reimport round trip would fail to validate. A column makes the scale *data*, so it travels with the instance that used it and history stays coherent. The cost is honest and accepted: per-category configuration that no admin will ever vary between categories, and a second field on the FR-4 builder, which decision F-01 already finds fiddly.

    **`minPoints Int @default(0)`**, so the migration changes the meaning of no existing row and new rubrics opt in. Invariant `0 ≤ minPoints < maxPoints`, enforced in `validateRubric` beside the existing bounds. `validateScore` takes the floor as a parameter instead of assuming zero; the segmented row and the number-input fallback both render from it. `null` continues to mean *clear this score* and is untouched — **"unscored" is the absence of a `Score` row, not a zero**, which is what makes dropping 0 from the offered values cost nothing semantically. It is also why the obvious shortcut of storing 0–3 and displaying 1–4 is refused: the stored number must be the number the reviewer saw, or FR-10 computes variance over values nobody chose.

    **Why it is deferred, which is the part a later reader will want.** Nothing about it is urgent — no reviewer is blocked and no data is wrong — and the migration would land between the board-member run and its step 8 re-run, which is the gate Phase 3 is actually trying to close. A schema change in that window risks the thing being verified for a change with no deadline. Phase 4 is the natural home: FR-10 is the first requirement that computes on the scale rather than only storing it. **Existing scores need no migration regardless** — FR-4 locks the rubric once any `Score` exists, so changing a scale already requires the reset that discards them.

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

    Neither rule applies to the notes sheet. It has no average, and `InterviewNotes.interviewerName` is nullable because only one interviewer of the pair writes the notes.

61. **`InterviewCategory` ids are preserved across a rubric edit, amending clause 12a-5's "replace-not-diff." RESOLVED:** an edit updates existing rows in place and only adds or removes rows for categories actually added or removed, rather than deleting and recreating the whole set. Same ruling §5 already made for `FieldGroup.key`, and the reason is the same: a staged FR-12 mapping references `InterviewCategory` ids, and regenerating them on every save silently invalidates any in-progress mapping, which is exactly the "Not imported" regression this decision fixes. The rubric page also warns when a scores sheet is staged, naming that changing categories will need the mapping re-done — a real cost of editing after upload, stated rather than discovered.

    Found by the owner clicking through, not by review: a typo in one category name was corrected, and all four columns of an already-staged sheet came back unmapped — the three untouched ones because their ids had changed underneath the mapping, the corrected one because it had never matched. The failure was safe rather than silent (`parseRole` degrades an unknown id to `IGNORED`, `validateMapping` then refuses the commit, and the importer builds category ids from the live rubric rather than from the mapping), so no wrong data was reachable — but a dead end an admin reaches by doing something entirely reasonable is still a defect.

    **A self-healing re-proposal was considered and rejected.** Re-matching a stale id by header text would have hidden this instance and any future one, and the phase's practice is to surface a real problem rather than let a second mechanism quietly mask it. Preserving identity removes the cause; re-proposing would only have removed the symptom.

    The immediate consequence is that reordering can no longer be a wholesale replace: `@@unique([instanceId, ordinal])` is not deferrable, so a save parks the surviving rows on temporary ordinals before writing their final ones.

62. **The first-round dashboard shows a reviewer's vote progress, not required by FR-14's text. RESOLVED: "voted on N of M",** matching the completion count Phase 3 already established for the written round. A first-round reviewer votes on every applicant in the pool with no assignment narrowing it, so the navigational aid FR-9 already gives written reviewers applies at least as much here.

63. **A first-round vote can be changed after submit, up until FR-15's finalize. RESOLVED:** the schema already permits it — `FirstRoundVote` has no immutability, and its `updatedAt` exists for this. FR-17's rule against reopening a vote is scoped to a closed pass, which the first round is not; nothing analogous closes it here before finalize. Resubmitting updates the existing row via the unique constraint rather than creating a second one. Disallowing revision would make a misclick permanent for the rest of the round, which is the exact loss decision 26 already treats as unacceptable in the written round.

64. **"This round is over" and "nothing has reached this round yet" must not read the same. RESOLVED: the first-round reviewer dashboard distinguishes them, using `Instance.currentStage`.** FR-15's finalize moves every applicant out of the pool — advanced to `stageReached = SECOND_ROUND`, rejected to `status = REJECTED` — so the reviewer's list empties itself. That is correct, and the message it produced was not: a reviewer opening the app the morning after the round closed was told "nobody has reached the first round yet", which is what the screen says *before* the round opens. The same empty list means two opposite things and the difference matters to the only person who ever sees it.

    `Instance.currentStage` is what separates them, exactly as decision 43 made it load-bearing for FR-11's read-only `/results`. Past `FIRST_ROUND` means the round is finished; still on `WRITTEN` means it has not started. **This is a second reader for the field decision 43 added**, which is the argument for having moved it rather than inferring the stage from applicant rows.

    Any vote still in flight is refused by the existing pool re-check in the vote action rather than by a new rule — an applicant who has left the round is not votable, whatever the screen was showing when the tab was opened.

65. **`InterviewResult` ids do not survive a re-import. RECORDED as a consequence of decision 47's upsert, not fixed.** A re-committed sheet deletes and re-inserts `InterviewResult` and its `InterviewCategoryScore` rows rather than updating them in place, so the upsert key `(applicantId, interviewerName)` is respected and nothing is duplicated, but the row ids are new. Confirmed against the database after a real second import: twelve results, forty-eight category scores, no duplicates on the key and none after case-folding, and a single shared `createdAt` showing the rows had been replaced.

    **Nothing references these ids today, which is why this is recorded rather than fixed.** Every reader reaches a result through its applicant. The delete-then-insert shape is deliberate — it is what keeps the commit to a fixed number of bulk statements instead of one upsert per row, which is the pattern FR-11's finalize adopted after 150 sequential round trips exceeded Prisma's transaction limit.

    **It is the same instability decision 61 had to fix one table over**, and it is where a future feature breaks. Anything that needs to refer to a particular interview result across a re-upload — a comment thread on an interview, an audit trail of who changed a score, a flag on a disputed number — would silently lose its referent the next time a corrected sheet is imported. The fix, if that day comes, is decision 61's: match existing rows on the upsert key and update them in place. Doing it now would buy nothing and cost the bulk-statement shape.

66. **A reviewer cannot be added to the second round once it has started. RESOLVED.** Second-round pass membership is every reviewer with `SECOND_ROUND` in `rounds` — fixed, not timing-dependent, because the roster cannot change after the round begins. The reviewer roster page must refuse adding `SECOND_ROUND` to a reviewer's `rounds` once `Instance.currentStage` reaches `SECOND_ROUND`. This replaces the "reviewer added mid-round" row in §7.4's edge case table, which described a situation that can no longer occur.

67. **COI-as-skip is computed, never a stored `PassVote` row. RESOLVED.** `PassVote` means a reviewer actually submitted. `lib/passes.ts` computes each reviewer's effective status per applicant per pass from two inputs: actual `PassVote` rows, and the round's `ConflictOfInterest` set. No vote row exists means outstanding, unless the reviewer has an active COI on that applicant, in which case they are SKIP without a row.

68. **Flagging COI on an applicant after already voting on them in the open pass deletes that `PassVote` row. RESOLVED.** The reviewer is SKIP from that point forward, in that pass and any later one. A vote from a reviewer who has since disclosed a conflict cannot be allowed to still count toward unanimity. This is distinct from decision 63 (votes changeable until finalize) — that is the reviewer changing their own mind; this is the system correcting for a known conflict.

69. **A `Decision` row is written at `stage = SECOND_ROUND` the moment an applicant resolves. RESOLVED.** Same table, same pattern as WRITTEN and FIRST_ROUND: `outcome = SPARKLET` or `REJECT`, `actor = SYSTEM` for a pass's own unanimous result, `actor = ADMIN` for a manual reject. This is what FR-20's "decisions by stage" export actually reads for the second round; without it that export has nothing to show.

70. **NEEDS_ADMIN writes no `Decision` row. RESOLVED.** Nothing has been decided yet — that is the entire meaning of NEEDS_ADMIN. A `Decision` row is written only later, whenever an admin actually resolves that applicant, at whatever stage that resolution happens.

71. **Admin's manual reject during an open pass writes `PassApplicant.resolution = REJECTED` on the current pass row immediately, in the same transaction as decision 69's `Decision` row. RESOLVED.** Any other reviewer's vote still in flight on that applicant becomes moot — not blocked, just no longer read by anything, since the applicant is already excluded from future passes.

72. **Closing a pass writes no resolution; an unvoted row stays `NULL`. RESOLVED.** §7.4 says only that closing "leaves unvoted applicants ACTIVE and carried forward" and does not say what the row records. `CARRIED` keeps FR-17's own meaning — a *completed* mixed vote — and `NULL` keeps §5's, "null until the applicant resolves within this pass". Writing `CARRIED` over an applicant nobody voted on would overload one value with two facts and make the word untrue of half the rows carrying it. The distinction is recoverable either way, since FR-19 keeps the underlying votes visible, but only one of the two readings leaves `resolution` meaning one thing.

73. **"Still unresolved", in the close-second-round action, means `NULL` **or** `CARRIED`. RESOLVED.** FR-19 finds its Unresolved group by `resolution = NEEDS_ADMIN` and by nothing else, so a `CARRIED` row on the *final* pass — an applicant whose votes were mixed and who had no next pass to carry into — would otherwise be invisible to the only screen obliged to show them. `SPARKLET` and `REJECTED` are never overwritten, which is also what makes the action idempotent as §7.4 requires: the second run matches no rows.

74. **Second-round reviewers never see other reviewers' pass votes, closed pass or not. RESOLVED.** §6's matrix said "Hidden until pass closes"; §7.4's resolved open decision says counts are never revealed to reviewers. The latter wins, and §6 is amended by decision 77 below. FR-18 is admin-only and is the only vote-visibility surface any requirement describes; a reviewer-facing closed-pass tally would be a screen nothing asks for and an anchoring vector for the pass that follows it.

75. **A submitted pass vote is changeable until that applicant resolves. RESOLVED.** Resubmitting updates the existing row through `UNIQUE (passId, applicantId, reviewerId)`. The window shuts on its own: an applicant resolves only once every eligible reviewer has submitted, and from that point the control is gone. §7.4's rule against reopening is scoped to a closed *pass*, and decision 26's reasoning about misclicks applies here exactly as it did in the written round.

76. **An admin can remove a conflict of interest, audited. RESOLVED.** Reviewer flags stay one-way — FR-16 says "sticky", and decision 68 has already deleted the vote, which does not come back. Removing the flag returns the reviewer to the denominator as *outstanding*, so the applicant needs a vote they did not need a moment ago. This is what makes an all-COI `NEEDS_ADMIN` recoverable inside the open pass rather than only in the next one, and it is why `NEEDS_ADMIN` is recomputed while a pass is open instead of being treated as final. A terminal row is never reopened by it: an applicant who resolved SPARKLET with two conflicts on the board stays SPARKLET when one is removed, the same rule that protects a manual reject. The control lives on FR-18's grid and nowhere else — the grid is the only surface that renders conflicts at all, and it renders them exactly where the question gets asked, on a `skip` cell in a row that will not resolve.

77. **§6's "Other reviewers' scores/votes" row splits in two. RESOLVED.** FR-16 lists "written scores" among what a second-round reviewer sees, and §6's single row hid "other reviewers' scores" from everyone but an admin — the same rows, granted by one sentence and refused by a table two sections above it. The row was carrying two different questions at once. Split, both are answerable: prior-round evidence is visible to a second-round reviewer, and the votes being cast *now* are not. The anchoring risk decision 3 named is about the latter. The existing "Interview scores" and "Interview notes" rows already answer the interview half and are untouched, so nothing in the matrix says two things about one field.

    Two consequences the split settles. **Written review notes are visible**, which FR-16's list omitted: `ReviewNote` holds a written reviewer's reasoning, and "the complete applicant profile" opens that list rather than closing it. And **the scores are attributed, not anonymized.** Both surfaces that already render someone else's evaluation name its author — FR-14 gives a first-round reviewer "the average interview score per interviewer", and FR-11's admin applicant view names the written reviewer beside both their average and their note. An anonymized second-round profile would be the only place in the product that hides a scorer, and the argument for hiding it — social pressure, with the scorer sitting in the room — is the wrong way round for this round specifically. The second round is a deliberation: the value of knowing who gave the 2 is that they are present and can be asked why. Anonymity is the written round's rule, and it protects the applicant, not the reviewer.

78. **A reviewer cannot be withdrawn from the second round once it has started, the symmetric half of decision 66. RESOLVED.** 66 blocks the add and says nothing about the removal, and `removeReviewer(..., SECOND_ROUND)` works today. Withdrawing a reviewer mid-round shrinks the unanimity denominator retroactively and cascade-deletes their `PassVote` rows: an applicant sitting at 10 YES and one outstanding becomes unanimous the instant the outstanding reviewer is withdrawn — silently, from a screen that mentions no passes. Same rule, same page, same reasoning as 66. Removing them from the written or first round is unaffected; those rounds are over and nothing recomputes over them.

79. **Pass creation is blocked against an empty second-round roster. RESOLVED.** §7.4 blocks creation with zero ACTIVE applicants and is silent on zero reviewers. With no electorate, every member has no eligible reviewer, so the pass resolves wholly to `NEEDS_ADMIN` the moment it is created — a pass that decides nothing and flags everyone, which is indistinguishable at a glance from the all-COI case it is not. Blocked, with the same shape of message as the zero-applicant block: name the fix, which is the reviewer roster.

## 11. Out of scope for v1, worth noting for v2

- AI-assisted flagging of likely AI-written applications. The `Scores` sheet already has an `AI Detected?` column, so the club is doing this manually. Automating it is a defensible v2 feature and a strong portfolio addition, but it is a judgment call with real fairness stakes and should not ride along with the core rewrite.
- Reviewer calibration: showing a reviewer their own scoring distribution against the cohort mean.
- Cross-cycle analytics: are high written scorers actually the Sparklets who stay active?
