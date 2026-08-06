# Spark SC Recruitment Platform — Product Requirements Document

**Owner:** Kai
**Status:** Draft v1, pre-build
**Target:** Replace the S26 recruitment spreadsheet before the next full recruitment cycle

---

## 1. Problem

Spark SC currently runs recruitment out of a single Excel workbook. The S26 file contains 36 sheets, 153 applicants, and roughly 30 reviewers. Every round adds a new layer of manually maintained sheets (`WR Data`, `1RD Voting`, `2RD Vote Backend`, `Sparklet Maker`) that duplicate applicant identity, scores, and demographics.

Concrete failure modes visible in the current file:

- **Applicant identity is re-keyed by name across sheets.** `Decisions` uses `ID` + `Full Name`, `1RD Voting` uses `Name` only, `1R Notes` uses free-text `Applicant Name` typed by interviewers. Any typo silently orphans a record.
- **Voting is a manually maintained reviewer-by-applicant grid.** `Voting Results` has 30 reviewer columns. `2RD Vote` has 11. Adding or removing a reviewer means restructuring a sheet mid-round.
- **Rubric scores and demographics live in the same rows.** There is no mechanism to show a first-round interviewer the scores without also exposing race, first-gen status, and written responses.
- **Aggregations are hand-built.** `Overall Stats` and `WR Data` contain hardcoded counts (`Males 30`, `Females 36`, `Limit 76`, `Curr 67`) that have to be recomputed by hand whenever a decision changes.
- **The workbook is not transferable.** Its logic lives in cell formulas and in the head of whoever built it.

## 2. Goals

1. **One canonical applicant record.** Every score, note, vote, and decision attaches to a stable applicant ID, never a name string.
2. **Near-zero reviewer friction.** A reviewer opens a link, picks a round and their name, and starts grading. No account creation, no download, no spreadsheet training.
3. **Structural bias controls.** Field-level visibility per round, enforced by the system rather than by an admin remembering to hide columns.
4. **Survives succession.** A new Co-President with no context can run a full cycle from documentation alone.
5. **Portfolio-legible.** The data model, the assignment algorithm, and the pass state machine are the three pieces worth talking about in a PM interview. They should be clean enough to explain in five minutes.

## 3. Non-goals (v1)

- Applicant-facing anything. Applicants never log in. Application intake stays in the existing form tool.
- Automated email to applicants. The platform surfaces the email list; sending happens elsewhere.
- Multi-org / multi-tenant SaaS. This is Spark SC's tool. Instances are recruitment cycles, not customers.
- Interview scheduling.
- Mobile-native apps. The reviewer dashboard must work well in a phone browser; that is the requirement.

## 4. Users

| Role | Count per cycle | Access | Needs |
|---|---|---|---|
| Administrator | 2–4 (Co-Presidents, recruitment leads) | Password per instance | Setup, assignment, overrides, decisions, exports |
| Written reviewer | ~30 | Round link + access code + name | Read assigned profiles, score against rubric, return conflicts |
| First-round reviewer | ~15–25 | Same | Read interview scores and notes, vote yes/no |
| Second-round reviewer | ~11–15 | Same | Read full profile, flag conflicts, submit votes per pass |

## 5. Core data model

The single most important design decision: **applicants are identified by a system-generated ID, and CSV columns become typed field definitions rather than ad-hoc column names.**

```
Instance
  id, name, passwordHash, createdAt, archivedAt
  currentStage: WRITTEN | FIRST_ROUND | SECOND_ROUND | COMPLETE

Field                          // one per retained CSV column
  id, instanceId
  sourceHeader                 // exact header text from the CSV
  displayName                  // admin-editable
  category: DEMOGRAPHIC | RESPONSE | OTHER
  groupKey                     // nullable; several columns sharing one question, e.g. "ethnicity"
  isMultiSelect                // bool; true when multiple columns in a group can be set at once
  ordinal

Applicant
  id, instanceId
  sourceRowIndex
  email                        // promoted out of data for matching
  displayName                  // promoted out of data for display
  data: jsonb                  // { fieldId: value }
  status: ACTIVE | ADVANCED | REJECTED | SPARKLET
  stageReached: WRITTEN | FIRST_ROUND | SECOND_ROUND

RubricCategory
  id, instanceId, name, maxPoints, ordinal

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

InterviewResult                // first round, imported
  id, applicantId
  interviewerName, score
InterviewNotes
  id, applicantId, body

FirstRoundVote
  id, applicantId, reviewerId, value: YES | NO | SKIP
  UNIQUE (applicantId, reviewerId)

ConflictOfInterest
  id, round, applicantId, reviewerId
  UNIQUE (round, applicantId, reviewerId)

Pass                           // second round
  id, instanceId, ordinal, openedAt, closedAt
  status: OPEN | CLOSED

PassVote
  id, passId, applicantId, reviewerId
  value: YES | NO | SKIP
  submittedAt
  UNIQUE (passId, applicantId, reviewerId)

Decision
  id, applicantId, stage, outcome: ADVANCE | REJECT | SPARKLET
  actor: SYSTEM | ADMIN
  decidedAt
```

Three notes on this model:

- `Applicant.data` as JSONB rather than a key-value table. CSV columns vary cycle to cycle, so the schema cannot be fixed, but Postgres can still index and query inside JSONB. A separate `Field` table carries the human-facing metadata. This is meaningfully simpler than entity-attribute-value and just as flexible.
- **Every score, vote, and note references `applicantId`, never a name.** This is the fix for the current workbook's core problem.
- The source export uses one-hot columns for ethnicity: ten separate columns, any number of which an applicant may check. `groupKey` ties them back to a single logical question and `isMultiSelect` tells the UI and the demographic aggregations to treat them as one field rather than ten independent ones.

## 6. Field visibility matrix

Enforced server-side. A reviewer request for a hidden field returns nothing, rather than the client hiding it.

| Field category | Written reviewer | First-round reviewer | Second-round reviewer | Admin |
|---|---|---|---|---|
| Applicant name | Visible | Visible | Visible | Visible |
| DEMOGRAPHIC | Hidden | Hidden | Visible | Visible |
| RESPONSE | Visible | **Hidden** | Visible | Visible |
| OTHER | Configurable, default hidden | Configurable, default hidden | Visible | Visible |
| Interview scores | Hidden | Visible | Visible | Visible |
| Interview notes | Hidden | Visible | Visible | Visible |
| Other reviewers' scores/votes | Hidden | Hidden | Hidden until pass closes | Visible |

The written-reviewer row is a deliberate change from the current spreadsheet, where reviewers see whatever columns are in front of them. Written reviewers grading essays have no need for ethnicity or first-gen status, and hiding them removes a bias vector at no cost.

## 7. Functional requirements

### 7.1 Instance setup

**FR-1 Dashboard.** Landing page lists existing instances by name with created date and stage. Also offers "New instance from CSV."

**FR-2 CSV import.** Accept the applicant CSV. Parse headers. Show a mapping table with one row per column:

- Detected header (read-only)
- Editable display name (defaults to a cleaned version of the header)
- Include/exclude checkbox (default on)
- Category selector: Demographics / Responses / Other

Two columns require explicit designation and cannot be excluded: **email** (used as the join key for later imports) and **display name** (first + last, or a single name column).

**FR-3 Import preview and commit.** Show row count, detected duplicates by email, and rows with a blank email or name. Admin resolves or discards these before commit. On commit, create one Applicant per row.

**FR-4 Rubric builder.** Admin enters number of categories and max points per category. System generates the grid for naming each category. Store as `RubricCategory`. Rubric is locked once any Score exists; changing it after grading has started requires an explicit "reset written scores" action with a confirmation.

**FR-5 Instance save.** Admin sets an instance name and password. Password is hashed (argon2id or bcrypt, cost ≥ 12). Never stored or logged in plaintext. Never recoverable; recovery means an admin with app-level access resets it.

### 7.2 Written round

**FR-6 Reviewer roster.** Admin adds reviewers by first and last name with a Sparklet checkbox. Bulk paste from a newline-separated list is supported, since the current process starts from a Slack message.

**FR-7 Auto-assignment.** Generate assignments subject to:

- Exactly 3 reviewers per assigned applicant
- At most 1 Sparklet per applicant
- Reviewer load as even as possible: no reviewer exceeds `ceil(total_slots / reviewer_count)`
- 5% of applicants (rounded, minimum 1) held in an **unassigned pool** with 0 reviewers

**Feasibility constraint.** With 3 slots per applicant and at most 1 Sparklet each, non-Sparklets must fill at least 2 of every 3 slots. If Sparklets make up more than one third of the roster, even load and the Sparklet constraint are mutually unsatisfiable. The system must detect this before generating and tell the admin plainly: "You have 14 Sparklets among 30 reviewers. Even distribution is not possible under the one-Sparklet-per-applicant rule. Options: add non-Sparklet reviewers, or allow Sparklet load to be lighter than average." Silently violating one of the constraints is the wrong behavior.

**FR-8 Manual assignment override.** Admin can assign, unassign, or swap any reviewer on any applicant. Overrides are marked `origin: MANUAL` so a later regeneration does not clobber them without warning.

**FR-9 Reviewer dashboard, written.** Reviewer selects Round → Written, then their name from a dropdown. They see:

- Their assigned applicants as a list with completion state (0/4 scored, 4/4 scored)
- An applicant detail view: display name, all RESPONSE fields, rubric always visible alongside
- Score inputs per rubric category, plus a free-text note
- Autosave on every change. A dropped connection mid-review must not lose work.
- "Return to pool" on any applicant, with a required reason (conflict of interest / other)
- "Claim from pool," showing unassigned applicants that still need coverage

**FR-10 Written results dashboard.** Applicants ranked by average score descending, then by variance ascending. Each row shows: rank, name, average, variance, review count (2/3, 3/3), and demographic fields inline. Filters for "high variance" and "incomplete." Admin can open any applicant to read the full profile and all three reviewers' scores and notes.

**FR-11 Selection.** Admin checkboxes select applicants to advance. A live panel shows the demographic breakdown of the current selection against the applicant pool, so composition is visible during selection rather than audited after. Finalizing writes `Decision` records and populates the First Round tab.

### 7.3 First round

**FR-12 Score and notes import.** Two uploads with a defined contract:

*First Round Scores* — required columns: `Applicant Email` (or `Applicant Name` if email is unavailable), `Interviewer Name`, `Score`. Two rows per applicant expected.

*First Round Notes* — required columns: `Applicant Email` (or `Applicant Name`), `Notes`. One row per applicant.

**FR-13 Name reconciliation.** The current `1R Notes` sheet keys on free-text applicant names typed by interviewers, which will not match cleanly. On import: exact email match first, then exact name match, then fuzzy name match above a similarity threshold presented for confirmation, then an unresolved queue the admin maps by hand. Nothing imports silently under a guessed match.

> **Process recommendation:** add an email field to the interview scoring form. This eliminates the entire class of problem and costs one form field.

**FR-14 First-round reviewer dashboard.** Round → First Round, then name. Reviewer sees each applicant's interview scores (with interviewer names) and notes. Demographics and written responses are hidden per §6. Reviewer votes YES or NO per applicant. No vote recorded means SKIP.

**FR-15 First-round results.** Applicants ranked by yes percentage descending, where `yes% = yes / (yes + no)`, skips excluded from both numerator and denominator. Show raw counts alongside the percentage; 2/2 and 14/14 are not the same signal. Selection and demographic-breakdown behavior mirrors FR-11.

### 7.4 Second round and passes

**FR-16 Second-round reviewer dashboard.** Round → Second Round, then name. Reviewer sees the complete applicant profile: demographics, written responses, written scores, interview scores, interview notes. Reviewer can flag conflict of interest per applicant, which is sticky across all passes.

**FR-17 Passes.** The admin creates sequential passes. This is the most intricate piece of the system, so the state machine is specified explicitly:

- A pass is created by an admin. Its membership is fixed at creation: every applicant with `status = ACTIVE`.
- Exactly one pass is OPEN at a time. A submitted vote lands in the currently open pass.
- A reviewer with an active COI on an applicant has their vote in that pass automatically set to SKIP and cannot vote on that applicant.
- A vote requires an explicit submit action. Selecting yes/no without submitting records nothing.
- An applicant is **resolved** within a pass when every non-SKIP reviewer has submitted:
  - All YES → `status = SPARKLET`, excluded from future passes
  - All NO → `status = REJECTED`, excluded from future passes
  - Mixed → stays ACTIVE, carries into the next pass
- An admin can manually reject any applicant within a pass, excluding them from future passes.
- Closing a pass without full votes leaves unvoted applicants ACTIVE and carried forward.

**Edge cases that must be handled explicitly, not left to inference:**

| Case | Required behavior |
|---|---|
| All reviewers have COI on an applicant | Cannot resolve. Flag to admin for manual decision. Do not treat as unanimous. |
| Pass created with zero ACTIVE applicants | Block creation, tell the admin the pool is resolved. |
| A reviewer is added mid-round | They vote only in passes created after they are added. Existing open pass treats them as SKIP. |
| Admin reopens a closed pass | Not supported in v1. Corrections happen via manual override on the applicant. |

**Open decision:** should reviewers see live vote counts during an open pass? Recommendation is no, to prevent anchoring, with counts revealed to everyone at pass close. This is a values call for the club, not a technical one.

**FR-18 Pass dashboard.** Per pass: a reviewer-by-applicant grid showing blank / yes / no / skip, with per-applicant totals and resolution state. This is the direct replacement for the `2RD Vote` sheet, generated instead of hand-maintained.

### 7.5 Final and export

**FR-19 Final dashboard.** All second-round applicants sorted into New Sparklet and Rejected, with full profiles accessible. Demographic breakdown of the Sparklet class against each preceding stage, replacing the manual `Overall Stats` sheet.

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

## 9. Success metrics

| Metric | Current (S26) | Target |
|---|---|---|
| Admin hours per cycle on spreadsheet maintenance | Estimate before you build; you have the data | −60% |
| Reviewer completion rate (assigned reviews finished on time) | Derive from `Scores` sheet | ≥ 95% |
| Applicant records orphaned by name mismatch | Nonzero, unmeasured | 0 |
| Time from written round close to first-round list published | Estimate | < 1 hour |
| New admin able to run a cycle from docs alone | No | Yes, validated by a dry run with a board member |

Capture the baselines from the S26 cycle before you start building. A before/after number is what makes this a portfolio project rather than a description of a tool.

## 10. Open decisions

These need answers before or during the relevant build phase. They are the places where an unstated assumption would produce the wrong system.

1. **Unassigned pool definition.** 5% of applicants held with zero reviewers, or 5% of assignment slots left open across many applicants? Recommendation: 5% of applicants fully unassigned, since reviewers "pick up additional applicants," which implies whole applicants. Consequence: the pool must be drained before the round closes, so the results dashboard needs an incomplete-coverage warning.
2. **Sparklet-heavy roster handling.** When the feasibility check fails, does the club prefer uneven Sparklet load or relaxing the one-Sparklet rule?
3. **Live vote visibility in passes.** See FR-17.
4. **Blind written review.** Should written reviewers see applicant names at all? Hiding them is a small change now and a much larger one later.
5. **Multiple concurrent admins.** Two admins editing assignments simultaneously. v1 recommendation: last-write-wins with a visible "changed by X at Y" indicator rather than locking.
6. **Interview score scale.** The `1R Scores` sheet has four categories plus an average. FR-12 assumes a single score per interviewer. Confirm which the imported sheet will actually carry.
7. **Multi-select demographic counting.** An applicant checking both "East Asian" and "White" needs a defined counting rule for the demographic breakdowns in FR-11 and FR-19. Count them once in each category (totals exceed 100%), count them in a separate "Multiracial" bucket, or report both views. Club decision, not technical. The current spreadsheet concatenates the values into a single string ("South AsianIndian"), which is not countable.

## 11. Out of scope for v1, worth noting for v2

- AI-assisted flagging of likely AI-written applications. The `Scores` sheet already has an `AI Detected?` column, so the club is doing this manually. Automating it is a defensible v2 feature and a strong portfolio addition, but it is a judgment call with real fairness stakes and should not ride along with the core rewrite.
- Reviewer calibration: showing a reviewer their own scoring distribution against the cohort mean.
- Cross-cycle analytics: are high written scorers actually the Sparklets who stay active?
