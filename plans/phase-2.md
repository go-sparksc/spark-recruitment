# Phase 2 — Reviewer roster and assignment (FR-6 … FR-8)

**Gate (BUILD_PLAN):** every case in both blocks passes and the tests have been read to confirm they assert what was asked. Load distribution printed to console and eyeballed. The feasibility message is one a non-technical successor could act on. A roster paste containing a blank line, a single-word name, and a duplicated name drops the blank and routes the other two to the confirmation queue rather than importing them.

---

## Context

Phase 1 ends with an instance holding 150 applicants whose values are keyed by `Field.id` and whose identity is `Applicant.id`. Nothing yet decides who reads them. This phase builds that: a reviewer roster for a round, and an assignment of reviewers to applicants that satisfies four constraints at once — three reviewers each, at most one Sparklet each, even load, and a 5% pool held open as a conflict-of-interest buffer.

The reason this phase gets a day mostly spent on verification is that those four constraints are jointly unsatisfiable on some rosters, and the failure is silent. An algorithm that quietly drops the one-Sparklet rule produces a plausible-looking assignment; nobody notices until a Sparklet and their own roommate are the two people reviewing an application. So the feasibility precheck is a separate function from generation, it computes against actual assignable slots rather than the "Sparklets ≤ one third" shortcut, and when it fails it hands the admin a choice instead of a compromise.

**No migration.** `Reviewer` and `Assignment` already carry everything FR-6 through FR-8 need — `origin`, `status`, `returnReason`, `rounds`, and `UNIQUE (round, applicantId, reviewerId)`. The pool is derived (an applicant with fewer than `target` ACTIVE assignments has open slots), not a table. The FR-6 confirmation queue is transient state across two server actions, not a staging table: a 30-line paste is four orders of magnitude below the body limit that forced `ImportRow` in Phase 1.

`npm run seed` already builds this phase's primary fixture — 150 applicants, 30 reviewers, 8 Sparklets — which is BUILD_PLAN's first case exactly.

---

## Contradiction check

**Both blocks of BUILD_PLAN Phase 2 cases agree with the PRD. Every number reproduces from §7.2's formulas.** Worked through:

| Case | Reproduces from §7.2 |
|---|---|
| 30/8/150 | `target 3`, `totalSlots 450`, `pool = min(max(floor(22.5),3),150) = 22`, `assigned 428 = 128×3 + 22×2`, `ceiling ceil(450/30) = 15` ✓ |
| 30/15/150 | non-Sparklet capacity `15 × 15 = 225`; minimum `2×128 + 1×22 = 278`; `225 < 278` fails; relaxed `ceil(278/15) = 19`, average 18.5, against 15 ✓ |
| 3/0/10 | `totalSlots 30`, `pool = max(floor(1.5),3) = 3`, `27 = 7×3 + 3×2` ✓ |
| 2 reviewers / 2 applicants | `target min(3,2) = 2`, `totalSlots 4`, `floor(0.2) = 0 → 3 → capped to 2`, one reviewer each ✓ (§7.2: "On instances that small the pool is 2 slots, or fewer") |
| 31/0/150 | `pool 22`, `assigned 428`, `ceiling ceil(450/31) = 15`, 428/31 uneven ✓ |
| Regeneration | FR-8's "consumed capacity, not exclusions" paragraph, clause for clause ✓ |
| All five roster cases | FR-6's paste-parsing paragraph, clause for clause ✓ |

One wording tension, inside the PRD rather than between the two documents, so it is a §7.2 edit and not a decision: FR-7 bullet 2 opens with the flat sentence **"No applicant ever gets fewer than 2 from auto-assignment"** and then, two sentences later, reduces the target on small rosters — under which the 2-reviewer case correctly gives each applicant 1. The invariant that actually holds across every case is *no applicant is short more than one slot below the target*; "never fewer than 2" is that rule specialised to `target = 3`. The sentence gets rewritten to say so.

---

## Decisions taken before planning

Resolved with the owner. Each becomes a PRD edit; see *PRD changes*.

1. **`poolSize = 0` when `target < 2`.** On a one-reviewer roster the formula as written withholds whole applicants, which is exactly the model decision 1 rejected. There is no COI buffer to be had from a single reviewer, so there is nothing to withhold.
2. **`CLAIMED_FROM_POOL` is preserved across regeneration on the same footing as `MANUAL`.** Both are deliberate, non-generated rows, and by Phase 3 a claimed slot may already carry scores. FR-8 names only `MANUAL` because claiming did not exist when it was written. The regeneration warning names both counts separately.
3. **Duplicate names are compared against the paste and against every reviewer in the instance — not scoped to the round being staffed.** FR-6 covers only the within-paste case; the likelier accident is re-pasting the same Slack message. Scoping the comparison to the round would have been wrong: `Reviewer` is an instance-scoped row carrying a `rounds` array, so an Alex Kim already serving `FIRST_ROUND` **is the same person**, and a round-scoped comparison would create a second Alex Kim row instead of adding `WRITTEN` to the existing one. Two rows for one human is the identity defect this system exists to remove, reintroduced at the roster. So an instance-level match offers two resolutions — add this round to the existing reviewer (the likely intent), or create a second reviewer because two people really do share a name. A within-paste match offers only the second. Both stay confirm-to-keep; §5 puts no unique constraint on the name.
4. **A `RETURNED_TO_POOL` row is an exclusion, not consumed capacity.** It is the record of a reviewer recusing from that applicant. Generation must never re-pair them, and the row must not count against anyone's load. This is a third input category, distinct from both preserved and generated. No such rows can exist before Phase 3, so it is inert now — but the input shape has to be right before anything is written against it.
5. **A reviewer holding scored work cannot be removed, and an unscored removal names what it destroys.** `Assignment.reviewerId` cascades, so removal silently takes the reviewer's assignments and, from Phase 3, their scores with them. Removal is blocked while any of their assignments carries a `Score` or a `ReviewNote`, naming unassign-or-regenerate as the path; otherwise the confirmation states the assignment count and that those slots return to the pool. Same treatment for unchecking a round, scoped to that round. In Phase 2 no `Score` rows can exist, so the block is written and unit-tested rather than demonstrated — the same posture `saveRubric` already takes toward FR-4's lock.
6. **Load evenness is bounded on both sides, which is an FR-7 edit rather than a test that outruns the spec.** §7.2 states only the ceiling, and a ceiling alone permits 28 reviewers at 15 and two at 4 and 0 across the 428 assigned slots — satisfying the written rule while defeating "as even as possible". So FR-7 gains a floor: no reviewer falls below `floor(assigned_slots / reviewer_count)` unless the one-Sparklet-per-applicant rule leaves them nothing eligible to take. That exemption is what lets relaxed mode hold Sparklets at 10 while non-Sparklets carry 18 or 19.

---

## Slice order

Five commits across the three slices named in the brief. Each pure module ships and is read on its own before the UI that consumes it, because the pure module is the part that can actually be verified.

---

### Slice 0 — Seed corrections, alone in their own commit

Two stale things in the seed, fixed before any feature code and with none alongside, on the Phase 1 Slice 0 precedent: a correction buried in a feature commit is one nobody reads, and both of these are load-bearing documentation.

- `prisma/seed/roster.ts` — the doc comment still cites the pre-v1.4 pool model ("143 assigned, 429 slots, load 14 or 15"), the arithmetic BUILD_PLAN line 74 explicitly retires. It sits directly above the roster this phase's primary fixture comes from, so it is the first thing anyone building against that fixture reads, and every number in it is wrong. Replaced with the v1.4 figures: 450 slots, pool 22, 428 assigned, 128 at three and 22 at two, ceiling 15.
- `prisma/seed.ts` — leaves `importCommittedAt` null on an instance holding 150 committed applicants. That is not merely untidy: it is the flag FR-3 uses to mean "this import is final", the seeded state contradicts it, and any page gated on a finished import would lock the seeded instance out.

**Verify:** `npm run seed && npm run seed:inspect`, then read the diff on its own. Nothing is built against it until that diff has been read.

---

### Slice 1 — `lib/roster.ts`, pure

The FR-6 paste parser. No database, no Prisma, no rounds, no Sparklet flag.

```ts
export type RosterFlag = "UNSPLITTABLE" | "DUPLICATE_IN_PASTE" | "MATCHES_EXISTING_REVIEWER";

export interface RosterEntry {
  lineNumber: number;      // 1-based within the paste; what the queue shows
  raw: string;             // verbatim, so the queue can show what was actually pasted
  firstName: string;
  lastName: string;        // "" only when UNSPLITTABLE
  flags: RosterFlag[];     // a line can be both unsplittable and duplicated
  /// Set with MATCHES_EXISTING_REVIEWER. The queue needs the id to offer
  /// "add this round to them", and the flag to know whether that is a no-op.
  match?: { reviewerId: string; alreadyServesThisRound: boolean };
}

export interface ParsedRoster {
  ready: RosterEntry[];            // unflagged; import on commit
  needsConfirmation: RosterEntry[]; // the queue
  droppedLineCount: number;         // blank and whitespace-only
}

export function parseRoster(
  text: string,
  /// Every reviewer in the INSTANCE, not the round — see decision 3. The caller
  /// resolves round membership to a boolean, which keeps this module free of the
  /// Round enum and free of any opinion about which round is being staffed.
  existing: readonly {
    id: string;
    firstName: string;
    lastName: string;
    servesThisRound: boolean;
  }[],
): ParsedRoster;
```

Parsing rules, in order: split on `\r\n` / `\r` / `\n`; normalize NFC and map non-breaking space to a plain space (Slack pastes carry them, and a name split on a character the admin cannot see is unexplainable); trim; drop if empty; collapse interior whitespace runs; split on the **last** remaining space.

The two queue kinds behave differently and the UI has to reflect that:

- **`UNSPLITTABLE`** is *blocked* — it has no last name and `Reviewer.lastName` is non-null. The admin supplies one or drops the line.
- **`DUPLICATE_IN_PASTE`** is *confirm-to-keep* — both rows import once acknowledged, and the default is to keep both.
- **`MATCHES_EXISTING_REVIEWER`** is a *choice between two different writes*: add the round to `match.reviewerId`, or create a second `Reviewer` row. Neither is a default, because guessing wrong in either direction is bad — one silently merges two people, the other silently splits one.

Comparison for both duplicate kinds is on the trimmed, whitespace-collapsed, case-folded pair.

**Tests assert** (the five BUILD_PLAN cases, then the parsing hazards):

- Trailing blank lines and a line of only spaces are counted in `droppedLineCount` and produce no entry anywhere.
- `"Mary Anne Chen"` → `firstName "Mary Anne"`, `lastName "Chen"`. Last space, not first.
- `"Cher"` → in `needsConfirmation` with `UNSPLITTABLE`, absent from `ready`, `lastName === ""`. It must not import with a blank last name.
- `"Alex Kim"` twice → **both** entries present, both flagged `DUPLICATE_IN_PASTE`, neither dropped and neither merged. `ready` is empty.
- A 30-line paste → 30 entries in `ready`, no flags. `ParsedRoster` carries no `isSparklet` and no round — the type has no field for either, which is what makes "all pasted reviewers arrive as non-Sparklets" impossible to get wrong downstream.
- `"Alex Kim"` against an `existing` Alex Kim who serves **another** round → `MATCHES_EXISTING_REVIEWER`, `match.reviewerId` set, `alreadyServesThisRound === false`. This is decision 3's case: the entry must not land in `ready`, because importing it creates a second row for one person.
- The same against an Alex Kim who **already serves this round** → same flag, `alreadyServesThisRound === true`, so the queue can say the add would do nothing.
- Hazards: CRLF endings; a non-breaking space as the only separator; `"Mary  Anne  Chen"` with doubled interior spaces; `"Chen "` with a trailing space, which must be unsplittable rather than yielding a blank last name.

**Verify:** `npm run test lib/roster` and read the test file against the five cases above.

---

### Slice 2 — Roster UI and persistence

`app/instances/[id]/reviewers/` — page, `actions.ts`, and a client `roster-controls.tsx`, following the `mapping/` shape: server component reads, client component holds edit state, server actions `revalidatePath`.

The page is **round-scoped** — FR-6 says pasted reviewers are "members of the round being staffed" — with a round selector defaulting to `WRITTEN`. Two server actions rather than one, so the queue exists:

- `previewPaste(instanceId, round, text)` — reads **every** reviewer in the instance, resolves `servesThisRound` per row, calls `parseRoster`, returns `ParsedRoster`. Writes nothing.
- `commitPaste(instanceId, round, resolutions)` — one transaction. New rows get `isSparklet: false`, `rounds: [round]`; an "add the round" resolution appends `round` to that reviewer's existing array instead. Re-runs `parseRoster` server-side and refuses any entry still carrying `UNSPLITTABLE` or an unresolved `MATCHES_EXISTING_REVIEWER`; the client is not trusted to have cleared the queue.

Below the paste box, the roster grid: first name, last name, Sparklet checkbox, a checkbox per round, remove. This is where the Sparklet flag and additional rounds are set, per FR-6 — one paste box stays one paste box.

**Removal, per decision 5.** `Assignment.reviewerId` is `onDelete: Cascade`, so removing a reviewer takes their assignments and — from Phase 3 — the scores hanging off them. So `removeReviewer` counts the reviewer's `Score` and `ReviewNote` rows first and **refuses** when either is non-zero:

> Priya Raman has scored 4 of 15 assigned applicants. Removing them now would delete those scores. Unassign them from those applicants first, or regenerate the assignments.

With no scored work, the confirmation states the count plainly — *"Removes 15 assignments. Those applicants drop to open slots that any reviewer can claim."* — and proceeds. Unchecking a round is the same rule scoped to that round's assignments. No `Score` row can exist in Phase 2, so the refusal is unit-tested rather than demonstrated, the same posture `saveRubric` already takes toward FR-4's lock.

**Verify:** `npm run seed`, open `/instances/<id>/reviewers`, confirm 30 reviewers and 8 Sparklets. Then paste:

```
Mary Anne Chen
Cher

   
Alex Kim
Alex Kim
```

Expect: one dropped blank plus one dropped whitespace line reported, Mary Anne Chen ready, Cher blocked in the queue, both Alex Kims flagged and both keepable. Give Cher a last name; commit; the roster grows by four. Paste `Mary Anne Chen` again and confirm the match offers both "add this round" and "create a second reviewer". Switch the selector to `FIRST_ROUND`, paste her a third time, take "add this round", and confirm **one** row now serving both rounds rather than two rows. Then try removing a reviewer who holds assignments and read what the confirmation says it will destroy.

---

### Slice 3 — `lib/assignment.ts`, pure

Two exported functions. **The precheck never generates**, so its failure message can be tested without producing an assignment.

```ts
export interface ReviewerInput { id: string; isSparklet: boolean }
export interface Pair { applicantId: string; reviewerId: string }

export interface AssignmentInput {
  applicantIds: readonly string[];      // stable order; the caller decides scope
  reviewers: readonly ReviewerInput[];  // the round's roster only
  preserved: readonly Pair[];           // MANUAL + CLAIMED_FROM_POOL kept across a regeneration
  blocked: readonly Pair[];             // RETURNED_TO_POOL: never re-pair, costs no capacity
  relaxSparkletLoad: boolean;
  seed: number;                         // reuses createRng from prisma/seed/rng.ts
}

export function checkFeasibility(input: AssignmentInput): FeasibilityReport;
export function generateAssignments(input: AssignmentInput): AssignmentPlan;
```

`FeasibilityReport` carries every derived number so the UI can show its work rather than restating the arithmetic: `target`, `totalSlots`, `poolSize`, `assignedSlots`, `fullApplicantCount`, `shortApplicantCount`, `loadCeiling`, `nonSparkletMinimum`, `nonSparkletCapacity`, `relaxedNonSparkletCeiling`, `feasible`, `message`, and `preexistingViolations`.

**The arithmetic, in one place:**

```
target        = min(3, reviewerCount)
totalSlots    = applicantCount × target
loadCeiling   = ceil(totalSlots / reviewerCount)
poolSize      = target < 2 ? 0 : min(max(floor(0.05 × totalSlots), 3), applicantCount)
assignedSlots = totalSlots − poolSize

nonSparkletMinimum  = Σ over applicants  max(0, need(a) − sparkletHeadroom(a))
nonSparkletCapacity = Σ over non-Sparklets  max(0, loadCeiling − preservedLoad(r))
feasible            = nonSparkletCapacity ≥ nonSparkletMinimum

relaxedNonSparkletCeiling = ceil(nonSparkletMinimum / nonSparkletCount)
```

`sparkletHeadroom(a)` is 1 unless a preserved Sparklet already occupies the applicant's one slot. With no preserved rows, `nonSparkletMinimum` collapses to `assignedSlots − applicantCount` — which is 428 − 150 = 278, the same number §7.2 derives as `2×128 + 1×22`. The two formulations agree because "at most one Sparklet per applicant" means each applicant absorbs at most one Sparklet slot, whatever their slot count.

`generateAssignments` refuses when `!feasible && !relaxSparkletLoad`, returning the report rather than a plan. Fill order is most-constrained applicant first; within a slot, the eligible reviewer with the lowest current load, ties broken by seeded shuffle. Eligible means: capacity remaining, not already on this applicant, not `blocked` with them, and not a second Sparklet. Under `relaxSparkletLoad` the Sparklets are saturated first — one per applicant, evenly spread at `ceil(sparkletSlots / sparkletCount)` — and non-Sparklets absorb the remainder up to `relaxedNonSparkletCeiling`. **The one-Sparklet rule is never the thing that gives**, in either mode.

**Tests assert.** A shared `assertPlanInvariants` helper runs on every generated plan: each applicant's count is `target` or `target − 1`; exactly `poolSize` applicants are short and they are distinct; no applicant has two Sparklets; no duplicate pair; total equals `assignedSlots`; no reviewer over the applicable ceiling; and, per decision 6, no reviewer under `floor(assignedSlots / reviewerCount)` except where the one-Sparklet rule caps them. Then per case:

- **30/8/150** — pool exactly 22, never 23. 128 at three and 22 at two. 428 placed. Max load ≤ 15.
- **30/15/150** — `checkFeasibility` alone: `feasible === false`, `nonSparkletCapacity === 225`, `nonSparkletMinimum === 278`, `relaxedNonSparkletCeiling === 19`, and `message` contains both 15 and 19. Asserted **without calling `generateAssignments`**. Then `generateAssignments` with `relaxSparkletLoad: false` refuses; with `true` it produces a full plan whose Sparklet count per applicant is still ≤ 1 and whose non-Sparklet max load is ≤ 19.
- **3/0/10** — pool 3 by the minimum-3 rule, 7 at three and 3 at two.
- **2 reviewers / 2 applicants** — target 2, pool capped to 2, one reviewer each, **neither applicant at zero**. The cap beating the minimum is the assertion.
- **31/0/150** — pool 22, 428 placed, every reviewer in `[floor(428/31), 15]` = `[13, 15]`, which lands as 25 at 14 and 6 at 13.
- **Regeneration**, with `preserved` populated: a preserved row counts against its reviewer's ceiling; a preserved Sparklet blocks a second Sparklet on that applicant; an applicant with one preserved row still receives two generated slots and is **not** excluded; a preserved set that already exceeds a ceiling or already carries two Sparklets appears in `preexistingViolations` and is still present, unmodified, in the plan.
- **Degenerate guards:** 0 reviewers, 0 applicants, all reviewers Sparklets (relaxed mode is not offered — it cannot fill anything), one reviewer (`poolSize === 0`, every applicant gets their one).

**The floor is asserted because FR-7 gains it, not because the test wants it.** Order matters here: the PRD edit in decision 6 lands before this slice, so the assertion is checking a stated rule rather than outrunning one. Worked through the cases, the floor is `14` at 30 reviewers, `13` at 31, `9` at 3 reviewers and 10 applicants, and `1` at the 2×2 case — all satisfiable, and all satisfied by the same lowest-load-first fill that the ceiling already drives. In relaxed mode the exemption carries the Sparklets: held to 10 each by one-per-applicant, below the 14 floor, and correctly so.

**Verify:** `npm run test lib/assignment`, then read the tests against the six blocks above.

---

### Slice 4 — Assignment persistence and admin UI

`app/instances/[id]/assignments/` — page, `actions.ts`, client controls. Gated on the instance having applicants; a draft instance is told to finish its import first.

**The generate flow is three distinct steps, because FR-7 makes the middle one a decision point.**

1. **Precheck** renders on page load, before anything is generated: roster size, Sparklet count, target, pool size, ceiling, and the split of full versus short applicants.
2. **On failure**, FR-7's message with real numbers, and two actions rather than prose — "Add non-Sparklet reviewers" links back to the roster, "Allow uneven Sparklet load" is a button. The relaxed confirmation shows **both** load numbers before committing to it: *"Sparklets take at most one applicant each. Non-Sparklets would carry about 18.5 assignments, capped at 19, against the 15 an even split would give. The one-Sparklet-per-applicant rule still holds."*
3. **On regeneration with preserved rows**, a warning naming the counts separately — *N* manual overrides and *M* claimed slots — with two buttons: keep them (the default, consumed as capacity) or discard them too. FR-8's "does not clobber them without warning" is the warning; "unless explicitly told otherwise" is the second button.

`generateAssignments` server action, one transaction: delete this round's `AUTO` rows, insert the plan, write an `AuditLog` row. Preserved rows are re-read inside the transaction rather than trusted from the client. Any `preexistingViolations` are reported on the page afterwards and **never corrected** by removing a manual assignment.

Below that, the load distribution table — per reviewer, count and Sparklet flag, sorted — and the same distribution printed to the server console on generate, which is what the gate asks to eyeball.

**FR-8 manual override.** An applicant list with each applicant's current reviewers; assign, unassign, and swap. Each writes `origin: MANUAL` and an `AuditLog` row with the previous value, per §8. Assign refuses a second Sparklet and refuses a reviewer already on that applicant, naming the rule rather than failing on the unique index.

**Verify, by hand on the seeded instance:**

1. `/instances/<id>/assignments` → precheck passes, 22 pooled slots, ceiling 15.
2. Generate. Confirm 150 applicants, 128 at three and 22 at two, 428 rows, no reviewer above 15, no applicant with two Sparklets. Console shows the distribution.
3. Manually swap a reviewer on one applicant; confirm the row is `MANUAL` and an `AuditLog` row carries the previous reviewer.
4. Regenerate. Confirm the warning names one manual override, that keeping it leaves that pair intact, and that the applicant still ends with three reviewers total.
5. On the roster page, flag seven more Sparklets to reach 15. Return to assignments: the precheck now fails with the FR-7 message. Confirm it names 225 against 278 and offers both actions.
6. Take "Allow uneven Sparklet load". Confirm the confirmation shows 15 and 19, then that the generated plan still has no applicant with two Sparklets.
7. Unflag them, regenerate clean.

---

## The three call-outs

### How MANUAL lands in the pure function's inputs

**As `preserved: Pair[]` — an input that consumes capacity, and never a filter on `applicantIds`.** Concretely, a preserved row does five things and one thing it deliberately does not:

1. Reduces its reviewer's remaining capacity: `max(0, loadCeiling − preservedLoad(r))`.
2. Reduces its applicant's remaining need. An applicant with one preserved row and a target of 3 still appears in generation, asking for two more.
3. If the reviewer is a Sparklet, sets `sparkletHeadroom(applicant) = 0`, so generation cannot add a second.
4. Removes that exact pair from the candidate set — `UNIQUE (round, applicantId, reviewerId)` would reject it anyway, and finding out at the insert is finding out too late.
5. Feeds `checkFeasibility` through the same reductions, so the precheck answers the question actually being asked: can the *remaining* slots be filled, given what is already fixed.

What it does **not** do is move `target`, `totalSlots`, `poolSize`, or `loadCeiling`. Those come from the full grid. §7.2 already gives the reason for the ceiling — "using the full grid keeps the bound stable as returns add slots back to the pool mid-round" — and the same argument applies with more force here: a ceiling that shifts every time an admin adds one override is not a bound, it is a moving target that makes two regenerations incomparable.

The excluding alternative — drop an applicant with any manual assignment out of generation — is what FR-8 rules out, and the reason is load evenness, not fairness to that applicant. Six manual overrides on six applicants would remove twelve slots from the grid the algorithm balances over, and the imbalance would be invisible because the numbers would still add up.

Pre-existing violations get their own return field. A preserved set that already breaks a rule is reported in `preexistingViolations` and left exactly as it is; the algorithm's job is to not make things worse, not to overrule an admin who had a reason.

### What the pool cap and reduced target do under 3 reviewers

`target = min(3, reviewerCount)` and `totalSlots = applicantCount × target`, so **everything downstream is computed against the reduced target, not against 3**. The pool is `min(max(floor(0.05 × totalSlots), 3), applicantCount)` with the cap applied last, and the cap wins over the minimum. Three consequences, one per boundary:

- **2 reviewers, 2 applicants.** `target 2`, `totalSlots 4`, `floor(0.2) = 0` raised to the minimum 3, then capped to `applicantCount = 2`. Each applicant is short one and ends with one reviewer. The cap has to be last: a 3-slot pool over 2 applicants would put somebody short two, and "each pooled slot comes off a different applicant" is the rule that makes the pool cost an applicant one opinion rather than all of them.
- **3 reviewers, 10 applicants.** `floor(1.5) = 1` raised to 3, under the cap of 10, so 3. Seven applicants at three and three at two. The minimum exists so a tiny instance still has a COI buffer at all.
- **1 reviewer.** `target 1`, and by decision 1 above `poolSize = 0`. Applying the formula would withhold whole applicants, which is the model §10.1 rejected. Nothing to buffer with one reviewer, so nothing is held back.

The invariant across all of them: **no applicant is ever short more than one slot below the applicable target, and no applicant is ever left with zero.** "Never fewer than 2" is that rule at `target = 3`.

### Ambiguities in §7.2 → PRD §10

Five things §7.2 does not say. Each becomes a numbered decision rather than a choice made in the code, and **every one is resolved in this phase** — nothing carries forward as OPEN, because Phase 2 ships the surface that would suffer from each.

- **20. Pool and target on a one- or two-reviewer roster.** RESOLVED: `poolSize = 0` when `target < 2`.
- **21. `CLAIMED_FROM_POOL` across a regeneration.** RESOLVED: preserved alongside `MANUAL`.
- **22. Duplicate-name scope on paste.** RESOLVED: compared against the paste and against every reviewer in the **instance**, not the round. `Reviewer` is instance-scoped with a `rounds` array, so a round-scoped comparison would answer "is this a new person?" with "is this person already staffed here?" — two different questions, and getting them confused produces a second row for one human. An instance match offers "add this round" or "create a second reviewer"; neither is the default.
- **23. `RETURNED_TO_POOL` rows during regeneration.** RESOLVED: an exclusion, not consumed capacity — the pair is never recreated and the row counts against nobody's load. Inert until Phase 3.
- **24. Removing a reviewer, or unchecking a round, with live assignments.** RESOLVED: blocked while any of their assignments carries a `Score` or `ReviewNote`; otherwise the confirmation names the assignment count and the slots return to the pool. Leaving this open was wrong — Phase 2 ships the remove control, so Phase 2 ships the loss, and an OPEN decision does not stop a cascade.
- **Also FR-7 itself, not a §10 entry:** the load bound is stated only as a ceiling, which permits a badly skewed assignment that still passes. Decision 6 adds the floor. This is a §7.2 edit rather than an open question because the intent — "as even as possible" — is already written down; only the bound implementing it is missing.

---

## Files

**New**
- `lib/roster.ts`, `lib/roster.test.ts`
- `lib/assignment.ts`, `lib/assignment.test.ts`
- `app/instances/[id]/reviewers/` — `page.tsx`, `actions.ts`, `roster-controls.tsx`
- `app/instances/[id]/assignments/` — `page.tsx`, `actions.ts`, `assignment-controls.tsx`

**Modified**
- `prisma/seed/roster.ts`, `prisma/seed.ts` — **Slice 0, their own commit, no code alongside**. Details there.
- `app/instances/[id]/page.tsx` — the redirect gains the two new destinations for a committed instance
- `PRD.md` — §7.2 and §10, below

**Reused rather than rewritten:** `createRng` (`prisma/seed/rng.ts`, moving to `lib/rng.ts` so `lib/` does not import from `prisma/`), `requireInstance` (`lib/auth.ts`), `prisma` (`lib/prisma.ts`), the `AuditLog` write shape from `app/instances/[id]/rubric/actions.ts`, the shadcn primitives in `components/ui/`. No new dependency.

**No migration, no schema change.**

## PRD changes

Made before the code, per CLAUDE.md — the PRD leads and the implementation follows.

- **FR-6** — duplicate comparison covers every reviewer in the instance, not only the paste, and an instance match resolves to either adding the round or creating a second reviewer. State that removing a reviewer is blocked while they hold scored work.
- **FR-7** — three edits:
  - Replace "No applicant ever gets fewer than 2 from auto-assignment" with the invariant that actually holds: no applicant is short more than one slot below the target, and no applicant is ever left with zero. The existing sentence is true only at `target = 3` and contradicts the reduced-target sentence two lines below it.
  - Add the evenness **floor** beside the ceiling: no reviewer below `floor(assigned_slots / reviewer_count)` unless the one-Sparklet-per-applicant rule leaves them nothing eligible. With the reason, since the gap is not obvious — the ceiling alone admits 28 reviewers at 15 and two at 4 and 0.
  - Note that `reviewer_count` means the round's roster, and that `poolSize = 0` at `target < 2`.
- **FR-8** — extend the preservation paragraph to `CLAIMED_FROM_POOL`, and state that a `RETURNED_TO_POOL` row is an exclusion that consumes no capacity.
- **§10** — new entries 20 through 24 as worded above, all RESOLVED.

**Status line last.** `v1.4, Phase 0-1 complete, Phase 2 in progress` is accurate right now and stays that way until the BUILD_PLAN gate passes by hand. It moves to Phase 2 complete in the final commit of the phase, not the first — a status line claiming a phase that has not been verified is the one kind of PRD edit that must not lead the code.

## Verification

```bash
npm run verify                      # typecheck, lint, test
npm run seed && npm run seed:inspect
npm run dev
```

Then the by-hand passes at the end of Slices 0, 2 and 4, in that order. The gate's own wording is the acceptance test: read `lib/roster.test.ts` and `lib/assignment.test.ts` against the two BUILD_PLAN blocks and confirm each case is asserted rather than approximated, and read the feasibility message on screen as though you had never seen this codebase.

Only once all of that has passed does the PRD status line move to Phase 2 complete, as its own final commit.
