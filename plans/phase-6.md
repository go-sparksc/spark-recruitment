# Phase 6 — Second round and passes (FR-16, FR-17, FR-18)

**Gate (BUILD_PLAN Phase 6):** every state-machine case passes and the tests have been read; then a full simulated second round against seed data — three passes, mixed votes, a COI, a manual rejection — with the pass grid matching expectation at each step.

---

## Context

Phase 5 ended with FR-15's finalize: `Decision` rows at `stage = FIRST_ROUND`, the advanced left `ACTIVE` with `stageReached = SECOND_ROUND`, the rest `REJECTED`, and `Instance.currentStage → SECOND_ROUND`. Everything downstream of that moment is unbuilt. A second-round reviewer who signs in today lands on `/r/[id]/list`, which redirects only `FIRST_ROUND` and otherwise renders a written-round assignment list that is empty for them — the same class of dead end decision 64 was written about.

The schema is already complete for this phase: `ConflictOfInterest`, `Pass`, `PassApplicant`, `PassVote` and the `PassResolution` enum have been in `prisma/schema.prisma` since Phase 0 and nothing has ever written to them. One migration is proposed below, and it adds an index rather than a column.

BUILD_PLAN calls the resolution state machine "the hardest thing in the project" and prescribes the Phase 2 discipline: the cases first, a pure function with no database access, tests read before anything is built on top. That is the whole shape of Day 1.

**The split, as instructed:**

- **Day 1** — FR-16 (full-profile reviewer dashboard, COI flagging including decision 68's vote deletion) and `lib/passes.ts` as a pure function, tested against every BUILD_PLAN case and decisions 66–71. Nothing in Day 2 is built until those tests are read.
- **Day 2** — FR-17 (pass creation, vote submission wired to `lib/passes.ts`, manual reject per decision 71, close-round per decisions 69–70) and FR-18 (admin-only grid, reading `lib/passes.ts`'s output).

---

## Four ambiguities, settled with the owner before planning

These become PRD §10 decisions 72–75, written in Slice 0 ahead of the code they govern — the practice Phase 5 established.

**72. A pass close writes no resolution. RESOLVED: an unvoted row stays `NULL`.** §7.4 says only that closing "leaves unvoted applicants ACTIVE and carried forward" and does not say what the row records. `CARRIED` keeps FR-17's own meaning — a *completed* mixed vote — and `NULL` keeps §5's ("null until the applicant resolves within this pass"). Writing `CARRIED` over an applicant nobody voted on would overload one value with two facts and make the word untrue of half the rows carrying it.

**73. "Still unresolved" at close-second-round means `NULL` **or** `CARRIED`. RESOLVED.** FR-19 finds its Unresolved group by `resolution = NEEDS_ADMIN` and by nothing else, so a `CARRIED` row on the *final* pass — an applicant whose votes were mixed and who had no next pass to carry into — would otherwise be invisible to the only screen that must show them. `SPARKLET` and `REJECTED` are never overwritten, which is also what makes the action idempotent: the second run matches no rows.

**74. Second-round reviewers never see other reviewers' pass votes, closed pass or not. RESOLVED, and §6's matrix is amended.** §6's last row reads "Hidden until pass closes"; §7.4's resolved open decision reads "counts are never revealed to reviewers." The latter wins. FR-18 is admin-only and is the only vote-visibility surface any requirement describes; a reviewer-facing closed-pass tally would be a screen nothing asks for.

**75. A submitted pass vote is changeable until the applicant resolves. RESOLVED.** Upsert on `(passId, applicantId, reviewerId)`. The window shuts on its own: an applicant resolves only when every eligible reviewer has submitted, and the control is gone from that point. §7.4's no-reopening rule is about a closed *pass*, and decision 26's reasoning about misclicks applies here exactly as it did in the written round.

**A fifth, from the same conversation — 76. An admin can remove a conflict of interest, audited. RESOLVED.** Reviewer flags stay one-way (FR-16 says "sticky"), and decision 68 has already deleted the vote, which does not come back. Removing the flag returns the reviewer to the denominator as *outstanding*. This is what makes an all-COI `NEEDS_ADMIN` recoverable inside an open pass rather than only in the next one, and it is why the persistence layer below recomputes `NEEDS_ADMIN` rows instead of treating them as final. **Built in Slice 11**, on the FR-18 grid, against the `skip` cell that shows the conflict — clause 18f.

---

## Three more decisions, approved before planning finished

**77. §6's "Other reviewers' scores/votes" row splits in two.** FR-16 lists "written scores" among what a second-round reviewer sees, and §6's single row hides "other reviewers' scores" from everyone but an admin — the same rows, granted by one sentence and refused by a table two sections above it. The row was carrying two different questions at once. Split, they are both answerable:

| Field category | Written reviewer | First-round reviewer | Second-round reviewer | Admin |
|---|---|---|---|---|
| Written rubric scores and review notes, from other reviewers | Hidden | Hidden | **Visible** | Visible |
| Round votes — first-round votes and pass votes | Hidden | Hidden | **Hidden** | Visible |

Prior-round evidence is the entire basis on which a deliberation happens, and the anchoring risk decision 3 named is about the votes being cast *now*. The existing "Interview scores" and "Interview notes" rows already answer the interview half and are untouched, so nothing in the matrix says two things about one field.

The first row also settles what FR-16's list left out: **written review notes are visible.** `ReviewNote` holds a written reviewer's reasoning, FR-16 enumerates scores without mentioning it, and "the complete applicant profile" opens that list rather than closing it. Clause 16k.

**And the scores are attributed, not anonymized.** Both surfaces that already render someone else's evaluation name its author: FR-14 gives a first-round reviewer "the average interview score **per interviewer**", and FR-11's admin applicant view names the written reviewer beside both their average and their note (`app/instances/[id]/results/[applicantId]/page.tsx`). An anonymized second-round profile would be the only place in the product that hides a scorer, and the argument for hiding — social pressure, with the scorer sitting in the room — is the wrong way round for this round specifically. The second round is a *deliberation*: the value of knowing who gave the 2 is that they are present and can be asked why, which is the one thing the spreadsheet's group session was always for. Anonymity is the written round's rule, and it protects the **applicant**, not the reviewer.

**78. A reviewer cannot be withdrawn from the second round once it has started, the symmetric half of decision 66.** 66 blocks the add and says nothing about the removal, and `removeReviewer(..., SECOND_ROUND)` works today. Withdrawing a reviewer mid-round shrinks the unanimity denominator retroactively and cascade-deletes their `PassVote` rows: an applicant sitting at 10 YES and one outstanding becomes unanimous the instant the outstanding reviewer is withdrawn — silently, from a screen that mentions no passes. Same rule, same page, same reasoning as 66.

**79. Pass creation is blocked against an empty second-round roster.** §7.4 blocks creation with zero ACTIVE applicants and is silent on zero reviewers. With no electorate every member has no eligible reviewer, so the pass resolves wholly to `NEEDS_ADMIN` the moment it is created — a pass that decides nothing and flags everyone. Blocked, with the same shape of message as the zero-applicant block.

---

## Stated rather than decided

Neither is ambiguous enough to need a decision number; both are written down so the reading is visible in review rather than inferred from a diff.

**Nothing in FR-17 or FR-18 resolves a `NEEDS_ADMIN` applicant.** Decision 70 says a `Decision` row is written "whenever an admin actually resolves that applicant", and no surface in this phase does that. Left to Phase 7: FR-19 renders the Unresolved group, and the admit/reject control belongs beside it. A deferral, not a hole.

**A manually rejected applicant, and votes still in flight on them.** Decision 71 says those votes become "moot — not blocked". The vote action stays permissive (a reviewer mid-tap gets no error), the row renders as resolved with the vote control gone, and nothing downstream reads the vote. Both halves of 71 built, visibly.

---

## `lib/passes.ts` — the contract

Pure. No Prisma client, no `server-only`, no database access — the rule CLAUDE.md puts on `assignment.ts`, `roster.ts` and this file. Everything below is derived from `PassVote` rows and the round's `ConflictOfInterest` set, per decision 67, and from nothing else.

```ts
/// FR-17: "every applicant with status = ACTIVE". No round qualifier —
/// decision 41 dropped ADVANCED from the enum precisely so this predicate
/// could stay this simple. One constant, read by pass creation and by the
/// close-second-round action.
export const SECOND_ROUND_POOL = { status: ApplicantStatus.ACTIVE } as const;

export type EffectiveVote = "YES" | "NO" | "SKIP" | "OUTSTANDING";

export interface PassInput {
  /// The electorate. Fixed for the whole round per decision 66, so it is
  /// derived from `Reviewer.rounds`, not stored per pass.
  reviewerIds: readonly string[];
  /// PassApplicant membership, fixed at creation.
  applicantIds: readonly string[];
  votes: readonly { applicantId: string; reviewerId: string; value: VoteValue }[];
  conflicts: readonly { applicantId: string; reviewerId: string }[];
}

export interface PassTally { yes: number; no: number; skip: number; outstanding: number; eligible: number }
export interface ApplicantResolution {
  applicantId: string;
  tally: PassTally;
  /// Null means unresolved *so far in this pass* — not a terminal state.
  resolution: PassResolution | null;
}

export function effectiveVote(...): EffectiveVote;
export function resolveApplicant(...): ApplicantResolution;
export function resolvePass(input: PassInput): ApplicantResolution[];
export function buildPassGrid(input: PassInput, order: ...): PassGrid;  // FR-18
```

**Effective status, per reviewer per applicant** (decision 67):

| Condition | Effective |
|---|---|
| Active COI on `(applicant, reviewer)` | `SKIP` — computed, never a stored row |
| A `PassVote` row exists with `YES` / `NO` | that value |
| A `PassVote` row exists with `SKIP` | `SKIP` — nothing writes one, and the enum permits it, so it has a defined answer rather than an assertion hiding it |
| No row, no COI | `OUTSTANDING` |

**Resolution, in order.** The eligible set is every reviewer whose effective status is not `SKIP`.

1. Eligible set empty → **`NEEDS_ADMIN`**. This is the all-COI case, and it must not read as unanimous.
2. Any eligible reviewer `OUTSTANDING` → **`null`**. Not resolved yet.
3. All eligible `YES` → **`SPARKLET`**.
4. All eligible `NO` → **`REJECTED`**.
5. Otherwise → **`CARRIED`**.

**What the persistence layer does with that** (Day 2, deliberately thin):

- Recomputed on three events: a vote submit, a COI change (flag or admin removal), and pass creation.
- `SPARKLET` / `REJECTED` are **terminal and never recomputed** — the applicant is no longer `ACTIVE`, so no later pass contains them, and a manual reject (decision 71) is protected by the same rule.
- `NEEDS_ADMIN` written by the all-COI branch **is** recomputed while the pass is open, because decision 76 lets an admin remove a COI. `NEEDS_ADMIN` written by close-second-round is on a closed pass in a `COMPLETE` instance and is never revisited.
- A terminal resolution writes, in one transaction: `PassApplicant.resolution` + `resolvedAt`, `Applicant.status`, and a `Decision` row at `stage = SECOND_ROUND` with `actor = SYSTEM` (decision 69). `CARRIED` and `NEEDS_ADMIN` write **no** `Decision` row (decision 70).

---

## Test cases — these are the spec

`lib/passes.test.ts`. BUILD_PLAN's nine cases first, verbatim in intent, then the decisions. If a test contradicts this table, the test is wrong.

| # | Case | Expected |
|---|---|---|
| 1 | 11 reviewers, applicant A: 11 YES | `SPARKLET` |
| 2 | Applicant B: 11 NO | `REJECTED` |
| 3 | Applicant C: 7 YES, 4 NO | `CARRIED` |
| 4 | Applicant D: 2 COI, other 9 all YES | `SPARKLET` — COI is skip, excluded from unanimity |
| 5 | Applicant E: all 11 COI | `NEEDS_ADMIN`, never `SPARKLET`, never `REJECTED` |
| 6 | Applicant F: 5 of 11 votes in | `null` — and closing the pass leaves it `null` (decision 72) |
| 7 | Reviewer added between passes | Pass 1's input carries the pass-1 electorate; adding to pass 2's changes nothing about pass 1 |
| 8 | Applicant G manually rejected | Not a computed outcome — asserted at the persistence layer, and the pure function is asserted never to overwrite a terminal row |
| 9 | Close-round with H unresolved | `null` → `NEEDS_ADMIN`; re-run changes nothing |
| 10 | Close-round with no pass | Blocked (persistence layer) |
| 11 | 2 COI + 9 outstanding | `null`, not `NEEDS_ADMIN` — eligible set is non-empty |
| 12 | 10 COI + 1 YES | `SPARKLET`. One eligible reviewer is unanimity |
| 13 | 10 COI + 1 outstanding | `null` |
| 14 | Empty electorate | `NEEDS_ADMIN` for every member (see F4) |
| 15 | A stored `SKIP` row | Counted as skip, excluded from unanimity, same as a COI |
| 16 | Every eligible reviewer stored `SKIP` | `NEEDS_ADMIN` — indistinguishable from all-COI by design |
| 17 | Vote from a reviewer *not* in `reviewerIds` | Ignored. A withdrawn reviewer's orphan row cannot swing unanimity |
| 18 | COI on a reviewer who also has a vote row | `SKIP` wins — decision 68's invariant, asserted here as well as enforced by the deletion |
| 19 | Mixed with skips: 6 YES, 3 NO, 2 COI | `CARRIED`, tally reports `skip: 2` |
| 20 | `buildPassGrid` over cases 1–6 | Cell values `blank / yes / no / skip` per FR-18, totals matching the tallies, resolution per row |
| 21 | Case 5 with one conflict dropped (decision 76) | `NEEDS_ADMIN` → `null`, that reviewer `OUTSTANDING`. The pure half of the admin's un-flag; the persistence half is that a *terminal* row is never recomputed |

Cases 7–10 have a persistence half that Day 2 exercises against the database; the rows above are the pure half.

---

## Clause ledger

CLAUDE.md's mechanical guard, re-ticked against the diff before each commit. FR-17 is a nine-bullet requirement plus a six-row table and will break the way FR-9 did if it is not itemized.

### FR-16 — second-round reviewer dashboard

| # | Clause, verbatim | Slice | Ticked by |
|---|---|---|---|
| 16a | "Round → Second Round, then name" | 4 | Existing sign-in covers all three rounds; `/list` gains the `SECOND_ROUND` redirect |
| 16b | "the complete applicant profile: demographics" | 3 | `buildApplicantView(..., "SECOND_ROUND_REVIEWER")` — server-side, existing helper, no new visibility logic |
| 16c | "written responses" | 3 | Same projection; RESPONSE is visible to this viewer under §6 |
| 16d | "written scores" | 3 | Per-reviewer averages + the FR-10 aggregate, visible under decision 77's first row |
| 16e | "interview scores" | 3 | The FR-14 card, reused |
| 16f | "interview notes" | 3 | `InterviewNotes.body` |
| 16g | "Reviewer can flag conflict of interest per applicant" | 3 | One `ConflictOfInterest` row at `round = SECOND_ROUND` |
| 16h | "which is sticky across all passes" | 3 | Keyed on `(round, applicantId, reviewerId)`, never on a pass |
| 16i | Decision 68: flagging after voting deletes that `PassVote` row | 3 | Same transaction as the insert; asserted against the database |
| 16j | Decision 68: "SKIP from that point forward, in that pass and any later one" | 3 | Falls out of 16h — no pass dimension exists to scope it to |
| 16k | Decision 77: written review notes ride with written scores | 3 | `ReviewNote` bodies rendered beside 16d, each attributed to the reviewer who wrote it |

### FR-17 — passes

| # | Clause, verbatim | Slice | Ticked by |
|---|---|---|---|
| 17a | "A pass is created by an admin" | 7 | `/instances/[id]/passes`, behind `requireInstance` |
| 17b | "membership is fixed at creation: every applicant with `status = ACTIVE`" | 7 | `SECOND_ROUND_POOL`, computed server-side, `PassApplicant` rows written in the creating transaction |
| 17c | "Exactly one pass is OPEN at a time" | 6, 7 | Partial unique index in SQL **and** a guard in the action |
| 17d | "A submitted vote lands in the currently open pass" | 8 | The action resolves the open pass itself; no pass id from the request |
| 17e | "A reviewer with an active COI … automatically set to SKIP" | 3, 8 | Computed per decision 67, never a row |
| 17f | "and cannot vote on that applicant" | 8 | Control absent, and the action refuses |
| 17g | "A vote requires an explicit submit action" | 8 | One button, one row; nothing autosaves |
| 17h | "resolved … when every non-SKIP reviewer has submitted" | 2, 8 | `resolveApplicant` step 2 |
| 17i | "All YES → `resolution = SPARKLET`, `status = SPARKLET`, excluded from future passes" | 2, 8 | All three writes in one transaction; exclusion falls out of 17b |
| 17j | "All NO → `REJECTED` … excluded" | 2, 8 | As above |
| 17k | "Mixed → `CARRIED`, stays ACTIVE, carries into the next pass" | 2, 8 | Status untouched; membership recomputed at the next creation |
| 17l | "An admin can manually reject any applicant within a pass" | 9 | Decision 71: pass row + `Decision(ADMIN)` + audit, one transaction |
| 17m | "excluding them from future passes" | 9 | `status = REJECTED` |
| 17n | "Closing a pass without full votes leaves unvoted applicants ACTIVE and carried forward" | 7 | Decision 72: close writes no resolution and touches no applicant |
| 17o | "`PassApplicant.resolution` … does not control membership in the next one" | 7 | Membership reads `Applicant.status` only; asserted by carrying a `NEEDS_ADMIN` applicant into pass 2 |
| 17p | "Close second round … moves `currentStage` to `COMPLETE`" | 10 | One field |
| 17q | "writes `NEEDS_ADMIN` onto the final pass's rows for every applicant still unresolved" | 10 | Decision 73: `NULL` or `CARRIED`, final pass only |
| 17r | "Idempotent" | 10 | `updateMany` matches nothing on the second run; no second audit row |
| 17s | "Blocked when no pass exists" | 10 | Guard, with a message naming the fix |
| 17t | "Audited, per §8" | 9, 10 | `AuditLog` inside the transaction, counts only, no applicant names |
| 17u | "`Applicant.status` stays ACTIVE for these applicants" | 10 | Deliberately untouched by the close |
| 17v | Table: all-COI → `NEEDS_ADMIN`, stays ACTIVE, **carries into the next pass** | 2, 7 | Case 5, plus a database exercise that creates pass 2 and finds them in it |
| 17w | Table: zero ACTIVE applicants → block creation | 7 | Guard, message says the pool is resolved |
| 17x | Table: reviewer added mid-round | 4 | Decision 66 replaces this row: the roster refuses the add |
| 17y | Table: admin reopens a closed pass → not supported | 7 | No reopen action exists; corrections go through 17l |
| 17z | "counts are never revealed to reviewers" | 3, 8 | Decision 74. No reviewer query loads another reviewer's `PassVote` |

### FR-18 — pass dashboard

| # | Clause | Slice | Ticked by |
|---|---|---|---|
| 18a | "Per pass: a reviewer-by-applicant grid" | 11 | `/instances/[id]/passes/[passId]` |
| 18b | "showing blank / yes / no / skip" | 11 | `buildPassGrid`'s four cell values, one per §7.4's list |
| 18c | "with per-applicant totals" | 11 | The `PassTally`, rendered |
| 18d | "and resolution state" | 11 | The stored resolution, and the computed one where the pass is open |
| 18e | "only accessible by admin" | 11 | `requireInstance`; no reviewer route reaches it |
| 18f | Decision 76: an admin can remove a conflict of interest, audited | 11 | Control on the `skip` cell that shows the conflict; deletes the `ConflictOfInterest` row, writes `AuditLog`, and recomputes that applicant's resolution — all one transaction |

---

## Day 1 — FR-16 and the state machine

**Slice 0 — PRD first.** §10 decisions 72–79, all approved above; §7.4's edge-case table loses the "reviewer added mid-round" row to decision 66 and gains the close-round semantics; §6's "Other reviewers' scores/votes" row is replaced by decision 77's two rows. `plans/phase-6.md` committed. No code.

**Slice 1 — seed a second round.** `prisma/seed/second-round.ts`, pure, plus a `npm run seed:advance` entry point. Creates four `InterviewCategory` rows, `InterviewResult` + `InterviewCategoryScore` for the first-round cohort (two interviewers each), `InterviewNotes` for most but deliberately not all of them, `FirstRoundVote` rows from the first-round roster, then performs FR-15's finalize *exactly as `finalizeFirstRound` performs it* — the posture `prisma/seed/first-round.ts` already takes, and for its stated reason.

**Deliberately a separate command, not part of `npm run seed`.** The default seed must keep leaving the instance at `FIRST_ROUND` with nothing imported, or Phase 5's gate and `prisma/checks/reconciliation-fixture.ts` are exercising a state the phase they belong to never produces.

**Slice 2 — `lib/passes.ts` and `lib/passes.test.ts`.** The contract above and the twenty cases. Nothing else in the phase is written until these are read. This is the slice BUILD_PLAN says to slow down on.

**Slice 3 — FR-16's dashboard.** `/r/[instanceId]/second-round` (list) and `/second-round/[applicantId]` (profile), with `load.ts` shaping the query result in `lib/` per CLAUDE.md's Phase 5 lesson. COI flag as a server action with a confirm step naming the consequence, and decision 68's `PassVote` deletion in the same transaction as the insert. No vote control yet — the empty state says voting opens when an admin starts a pass, and distinguishes that from a round that has closed (decision 64's lesson, applied before it can bite).

**Slice 4 — decisions 66 and 78, and the entry point.** `addReviewer`, `addRound` and the bulk-paste resolution path refuse `SECOND_ROUND` once `currentStage` is `SECOND_ROUND`; `removeReviewer` refuses the withdrawal, per decision 78. The roster page says so rather than offering controls that fail. `/r/[instanceId]/list` redirects `SECOND_ROUND` the way it redirects `FIRST_ROUND`.

**Slice 5 — hub row and docs.** A "Second round" row on `/instances/[id]` reading real state; CLAUDE.md's `lib/passes.ts` line stops describing a file that does not exist.

---

## Day 2 — FR-17 and FR-18

**Slice 6 — the one-open-pass index.** Migration adding `CREATE UNIQUE INDEX "Pass_one_open_per_instance" ON "Pass"("instanceId") WHERE "status" = 'OPEN'`, hand-finished SQL via `prisma migrate diff --from-config-datasource`, then `migrate deploy`. §5 gains the index beside the model. `prisma/checks/passes.ts` asserts it bites through raw SQL and comes back as SQLSTATE 23505 naming the index. **Restart `next dev` after the generate.**

**Slice 7 — pass creation and close.** `/instances/[id]/passes`: create (guards 17c, 17w, and decision 79's empty roster; membership per 17b; immediate `resolvePass` so an all-COI applicant carries `NEEDS_ADMIN` from the start), and close (17n — status and `closedAt`, nothing else).

**Slice 8 — vote submission.** The vote control on both FR-16 surfaces, the action resolving the open pass server-side, recompute-and-persist through `lib/passes.ts` in the submitting transaction. Decision 75's upsert. Decision 69's `Decision` row on a terminal resolution and decision 70's silence on `NEEDS_ADMIN`.

**Slice 9 — manual reject.** Decision 71: pass row, applicant status, `Decision(ADMIN)` and `AuditLog`, one transaction. Plus the permissive vote path stated above — a reviewer mid-tap on a just-rejected applicant gets no error, and their vote is read by nothing.

**Slice 10 — close second round.** Decisions 73 and 17p–17u. Blocked with no pass; idempotent; closes the final pass if it is still open, so a `COMPLETE` instance cannot hold an `OPEN` one.

**Slice 11 — FR-18's grid, and decision 76's control.** `/instances/[id]/passes/[passId]`, admin-only, rendering `buildPassGrid`. Horizontal scroll inside its own container — eleven reviewers against forty applicants does not fit a phone, and the page body must not be what scrolls.

The COI removal lives here, in `coi-cell.tsx`, rather than on the roster or the reviewer's own screen: the grid is the only surface that shows conflicts at all, and it shows them exactly where the question gets asked — a `skip` cell in a row that will not resolve. Three things it has to say and do:

- **It is a round-wide removal shown on a per-pass screen.** `ConflictOfInterest` is keyed `(round, applicantId, reviewerId)`, so removing one from pass 3's grid removes it from every pass. The confirm says so.
- **The deleted vote does not come back.** Decision 68 destroyed it at flag time; the reviewer returns as `OUTSTANDING`, which is a row that now needs a vote it did not need a moment ago.
- **A terminal row is never reopened.** An applicant who resolved `SPARKLET` with two conflicts on the board stays `SPARKLET` when one is removed — the recompute skips any row already terminal, the same rule that protects a manual reject. Only `NEEDS_ADMIN` and `null` move.

**The grid is the only place this control appears.** Not the roster page, not the reviewer's own screen: an admin fixing a mis-tap has to open a pass to do it, which is a cost, and the alternative is a second surface for one action that nothing else on the roster page is about. One control, one place.

Delete, `AuditLog`, and recompute in one transaction, per 18f.

**Slice 12 — the gate and the phase record.** Three passes against the advanced seed, mixed votes, a COI flagged after a vote, an admin removal of a COI, a manual rejection; grid checked at each step; `npm run verify`; `prisma/checks/passes.ts` re-run.

**BUILD_PLAN.md's edit is this slice's last act, and it is not bookkeeping.** Phase 5's section carries a "**Done.**" paragraph recording what the phase found that the requirement did not contain — decision 45's threshold rejecting its own example, three correct-logic-wrong-surface defects — and that paragraph is why CLAUDE.md's testing rules exist in the form they do. Phase 6 gets the same: what the gate exercised, and what §7.4 turned out not to say (decisions 72–79 are all answers to questions the requirement raised and did not close). A phase that passes its gate and records nothing leaves the next maintainer with a spec that still reads as complete.

---

## Files

**New:** `lib/passes.ts`, `lib/passes.test.ts`, `prisma/seed/second-round.ts`, `prisma/advance.ts`, `prisma/checks/passes.ts`, `prisma/migrations/<ts>_pass_one_open/migration.sql`, `app/r/[instanceId]/second-round/{page.tsx,load.ts,actions.ts,coi-control.tsx,vote-buttons.tsx}`, `app/r/[instanceId]/second-round/[applicantId]/page.tsx`, `app/instances/[id]/passes/{page.tsx,actions.ts,pass-controls.tsx}`, `app/instances/[id]/passes/[passId]/{page.tsx,coi-cell.tsx}`, `plans/phase-6.md`.

**Modified:** `PRD.md` (§5, §6, §7.4, §10), `prisma/schema.prisma` (index only), `app/r/[instanceId]/list/page.tsx`, `app/instances/[id]/reviewers/actions.ts`, `app/instances/[id]/reviewers/page.tsx`, `app/instances/[id]/page.tsx`, `prisma/seed.ts`, `package.json`, `CLAUDE.md`, `BUILD_PLAN.md`.

**Reused rather than rewritten:** `buildApplicantView` and `lib/fields.ts` for §6 (`SECOND_ROUND_REVIEWER` already exists in the `Viewer` union and the matrix); `lib/results.ts` for the written-score aggregate; `requireReviewerOnRoster` and `requireInstance` for both gates; the FR-14 interview card's structure; `components/ui/table.tsx` for FR-18.

---

## Verification

- `npm run verify` — typecheck, lint, and the twenty pure cases.
- `npx tsx prisma/checks/passes.ts` after the migration: the partial index bites at the database, and decision 68's deletion leaves no `PassVote` behind a COI.
- `npm run seed && npm run seed:advance`, then the gate by hand: sign in as a second-round reviewer on a phone-width window, flag a COI on an applicant already voted on and confirm the vote is gone from the grid; run three passes with a manual rejection in the second; confirm a `NEEDS_ADMIN` applicant from pass 1 appears in pass 2; close the round twice and confirm the second run changes nothing.
- **Decision 76 end to end, since it is the one control with no analogue anywhere else in the app:** flag conflicts from every second-round reviewer onto one applicant mid-pass, confirm the row reads `NEEDS_ADMIN` and the pass will not resolve; remove one conflict from the grid; confirm the row falls back to unresolved with that reviewer `OUTSTANDING`, that reviewer can now vote, and the applicant resolves on their vote. Then remove a conflict from an applicant who already resolved `SPARKLET` and confirm nothing about them moves. Check the `AuditLog` row exists and carries no applicant name.
- Confirm server-side §6: a request for a hidden field returns no data, checked in the RSC payload rather than on screen.
- Read `lib/passes.test.ts` against the table above before Day 2 begins. BUILD_PLAN: "do not trust the tests it wrote."
