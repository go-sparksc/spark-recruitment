# PRD reconciliation pass (before Phase 8 slice 7)

Written in plan mode on 2026-09-06 and approved by the owner in two rounds (the second settling B9); committed alone before any edit it describes, as the phase plans are.

## Context

Two inputs: the owner's read-through of `PRD.md` §1, and a cold audit of `PRD.md`, `lib/assignment.ts` and `lib/passes.ts`. Every audit finding was checked against the code and, where it claimed a behaviour, demonstrated by running the real module (five throwaway scripts in the scratchpad, nothing in the repo touched). Nothing is fixed in this pass. Confirmed behaviour changes become §10 decisions first, per PRD-leads-code; text cleanups are listed with exact wording; contradictions come back as options for the owner.

Verdict counts: **Bucket A** 7 CONFIRMED (one of them new, not in the audit), 3 REFUTED, 3 SPEC AMBIGUOUS. **Bucket B** 7 items as listed, plus 2 the triage surfaced. **Bucket C** 12 items, all with one right answer.

---

## Part 1 — §1 edits (owner's wording, text only)

| Where | Change |
|---|---|
| `PRD.md:11` | "153 applicants" → "160+ applicants" |
| `BUILD_PLAN.md:16` | "free tier is sufficient at 153 applicants and 30 reviewers" → "…at 160+ applicants and 30 reviewers" |
| `PRD.md:17`, second sentence | Replace "There is no mechanism to show a first-round interviewer the scores without also exposing race, first-gen status, and written responses." with "Showing a first-round interviewer the scores without also exposing race, first-gen status, and written responses means manually fine-tuning which columns are visible, which is difficult and error-prone." |
| `PRD.md:20` | Delete "To prevent leaking sensitive information or" so the sentence opens "To prevent someone accidentally breaking the workbook, all reviews…" |

Other occurrences of 153: only `plans/phase-3-test-pass.md:210`, which is a line number in a file path. Not touched. The seed's 150 (`prisma/seed.ts:31`) and decision 97's figures are not touched; 97 is Bucket C item C4.

**Found, out of the requested scope, owner's call:** `README.md:9` ("Roughly 150 applicants and 30 reviewers per cycle"), `ARCHITECTURE.md:14` ("about 150 applicants and 30 reviewers") and CLAUDE.md's "Scale: ~150 applicants" describe real cycle scale, not the seed. If §1 moves to 160+ these three arguably should too. Not changed unless told.

---

## Part 2, Bucket A — code versus spec

### The five investigated first

**A1. Floor repair stops at the first below-floor reviewer — CONFIRMED.**
- Code: `lib/assignment.ts:524` takes the first light reviewer with `reviewers.find`; `:543` returns from the whole repair when *that* reviewer has no swap, without looking at any other light reviewer.
- Demonstrated two ways. (i) Order dependence: 30 reviewers, 15 Sparklets first in the array, 150 applicants, relaxed rule, one non-Sparklet (`rev_15`) blocked from 140 applicants. Same input, reviewer array forward: `rev_15` ends at 10 against a floor of 14. Reversed: `rev_15` ends at 14. (ii) A case where the skipped reviewer's swap is legal on every count, blocked pairs included: 7 reviewers (3 Sparklets first), 27 applicants, relaxed, seed 1. `rev_0` (Sparklet) is at 9 against a floor of 11 with no legal swap; `rev_3` (non-Sparklet) is at 9 with a legal swap; the loop exits at `rev_0`. Two more such cases at seeds 5 and 34 of the same search.
- Why the suite misses it: `assertPlanInvariants` (`lib/assignment.test.ts:117-123`) checks exactly the right predicate, but no case in the suite has a swap-less light reviewer ahead of a repairable one in the array. The 15-Sparklet case has every light reviewer swap-less.
- Disposition: behaviour change → **decision 98** (below), then a slice. Fix shape: iterate every light reviewer and return only when none has a swap; a regression test built from case (ii) plus an order-reversal equivalence test.

**A2. Preserved rows are invisible to the floor rule — SPEC AMBIGUOUS, documentation fix.**
- Code and test agree: `lib/assignment.ts:529` searches `assignments` (generated only) and the test's `improvingSwapExists` (`assignment.test.ts:178`) does the same. FR-8 forbids removing a manual assignment, which is a reason to do this, but FR-7's precise form (`PRD.md:458`) quantifies over "any reviewer `s` assigned to `a`" with no carve-out, and `loadFloor` is measured over the full load including preserved rows (`:138`, `:401-407`), so a reviewer can be reported below a floor generation had no licence to reach.
- Fix (text, in the FR-7 precise-form paragraph): "`s`'s assignment to `a` must be a generated one. MANUAL and CLAIMED_FROM_POOL rows are immovable per FR-8, so a reviewer whose only route up runs through a preserved row is exempt on the same terms as the Sparklet case. The floor itself is still measured over everything a reviewer carries." Fold into decision 98's text so the code comment can cite it.

**A3. Generation under-fills and reports nothing — CONFIRMED.**
- Code: `lib/assignment.ts:455` breaks out of the fill when no candidate exists. `AssignmentPlan` and `FeasibilityReport` have no shortfall field (the report's keys were listed at runtime: none).
- Demonstrated: 3 reviewers, 10 applicants, applicant `a0` returned to pool by all three (three blocked pairs). Precheck: `feasible: true`, `message: null`. Plan: `a0` ends with **0** reviewers, 24 placed against `assignedSlots` 27. Nothing in the returned plan says so; the action's success message (`app/instances/[id]/assignments/actions.ts:244-245`) would read normally. The random search in A1 produced the same shape at every hit (e.g. 69 placed of 77).
- Cause: the precheck is capacity arithmetic and ignores blocked pairs entirely; the greedy fill has no guarantee even when the precheck passes. The zero-reviewer degenerate case the audit names is real (`feasible: true`, no message, 0 assignments) but the suite treats it as intended ("no reviewers: nothing to do, and no crash", `assignment.test.ts:642`) and the page presumably says so; low priority.
- Disposition: behaviour change → **decision 99**. Report, never auto-correct: the plan gains a `shortfall` list (applicant id, wanted, got) and the action surfaces it in the result and the log line. Whether a plan with a shortfall is *placed* or *refused* is the owner's choice inside the decision; recommendation below.

**A4. `shortApplicantCount` fixed to `poolSize` when the short set is smaller — CONFIRMED.**
- Code: `planShape` (`lib/assignment.ts:139-140`) sets both counts from `poolSize`; `prepare` (`:231-232`) can select fewer. The doc comment at `:69` ("Always `poolSize` distinct applicants") is false.
- Demonstrated: 3 reviewers, 10 applicants, 8 applicants fully preserved. Report: `poolSize 3`, `shortApplicantCount 3`, `fullApplicantCount 7`, `assignedSlots 27`. Plan: `pooledApplicantIds.length 2`, actual assigned 28. The admin-facing message at `assignments/actions.ts:245` renders the report's 3.
- Disposition: behaviour change to the *report* → folded into **decision 99** (same slice: the report carries the counts derived from the chosen short set, and FR-7's "exactly" sentence gains "or as many as the preserved rows leave shortable").

**A5. Conflicts applied retroactively to closed passes — CONFIRMED at the read layer, REFUTED at the write layer.**
- Read layer: FR-18's page loads the round's whole conflict set for any pass, open or closed (`app/instances/[id]/passes/[passId]/page.tsx:72-78`) and FR-19's loader does the same for the final pass (`app/instances/[id]/final/load.ts:149-152`). `buildPassGrid` renders each cell through `effectiveVote`, where a conflict beats a stored vote (`lib/passes.ts:86`; demonstrated by the existing test `passes.test.ts:252`, "a conflict beats a vote row on the same reviewer"). So a YES cast in pass 1 by a reviewer who flags a conflict during pass 3 renders as SKIP on pass 1's grid, and pass 1's tally and `computed` shift. `resolution` renders `stored ?? computed`, so a row that stored a value is labelled correctly; a closed pass's `NULL` rows (decision 72) render `computed`, which moves.
- Write layer: no stored resolution is rewritten. `flagConflict` deletes votes only in OPEN passes (`app/r/[instanceId]/second-round/actions.ts:110-116`, with a comment saying why) and `removeConflict` recomputes only the open pass (`app/instances/[id]/passes/actions.ts:579-609`).
- Two consequences the audit did not name. FR-19's "why unresolved" phrase (`lib/final.ts:242-255`) is computed from that same round-wide tally, so a later conflict can turn an INCOMPLETE reason into ALL_RECUSED. And `flagConflict` checks only that the applicant is ACTIVE, not the stage; a COMPLETE instance's unresolved applicants are still ACTIVE and still listed with links (`second-round/page.tsx:77-145`), so a reviewer with a live session can flag a conflict *after* the round closed and change what FR-19 shows.
- The comment at `lib/passes.ts:74-76` ("in practice the two never coexist") is false for any closed pass.
- Disposition: → **decision 100**. Both columns needed for a time-scoped read already exist (`ConflictOfInterest.createdAt`, `Pass.closedAt`).

**A6. SETTLED hands the resolution to a reviewer surface — CONFIRMED as a payload leak, not a rendered one.**
- Rendered: no. `vote-buttons.tsx:62-70` prints a fixed sentence and never reads `.resolution`; the action's SETTLED refusal is fixed text (`second-round/actions.ts:221-224`).
- Sent: yes. `VoteButtons` is a client component and receives the whole `availability` object as a prop (`[applicantId]/page.tsx:362-366`), so `{ kind: "SETTLED", resolution }` is serialised into the RSC payload and readable in devtools. The page's own comment ("Not fetched and hidden: not fetched") is the rule it breaks.
- What can actually arrive there: only `CARRIED`. SPARKLET and REJECTED change `Applicant.status`, and the profile query filters by `SECOND_ROUND_POOL` (`page.tsx:45`), so those applicants 404. 83a already accepts that "a mixed result occurred" is revealed, so the content is harmless today; the shape is wrong and would leak if a future resolution left status ACTIVE.
- Disposition: no behaviour change, no decision. Small code slice: drop `resolution` from the SETTLED variant, add a test that SETTLED carries nothing but its kind, and cite 83/83a in the file (it currently cites 74 and 75 only).

### The rest of Part A

**A7. Nonexistent FR-7 quotation (`lib/assignment.ts:495-496`) — CONFIRMED, Bucket C item C9.** FR-7's actual sentence is at `PRD.md:456`.

**A8. Decision 21's two counts — REFUTED.** The page derives them: `assignments/actions.ts:116-117` counts MANUAL and CLAIMED_FROM_POOL separately and `assignment-controls.tsx:152` renders "N manual overrides and M claimed slots". The module's single `preservedCount` in the failure message is a different sentence and is labelled as the sum.

**A9. Ceiling still binds Sparklets under the relaxed rule — SPEC AMBIGUOUS, not live.** With no preserved rows the two conditions cannot co-occur: the precheck fails only when `(R−S)·ceil(3N/R) < assigned − N`, and the ceiling binds Sparklets only when `S·ceil(3N/R) < N`; adding them gives `R·ceil(3N/R) < assigned`, impossible since `assigned < 3N ≤ R·ceil(3N/R)`. With preserved rows it is theoretically reachable. One sentence in FR-7's relaxed paragraph settles it ("Sparklets stay under the ordinary ceiling; only the one-per-applicant rule is meant to bound them and in practice it binds first"). Fold into decision 98.

**A10. Manual reject blocks other votes (71 says "not blocked") — REFUTED.** A manual reject sets `status = REJECTED`; a late vote hits the pool check first (`second-round/actions.ts:161-176`) and gets a non-error message, "This applicant has already been decided. Nothing was recorded", with a comment naming 71's "moot, not blocked". SETTLED-for-REJECTED is unreachable through the product (see A6). This is the fact Bucket B item B1 is decided against.

**A11. CARRIED is immutable but not terminal; 76 protects terminal rows only — SPEC AMBIGUOUS.** `isMutableResolution(CARRIED)` is false (`lib/passes.ts:248-250`) and `removeConflict` returns before recomputing (`passes/actions.ts:609`), so lifting a conflict on a CARRIED row in the open pass leaves it CARRIED and the reinstated reviewer sees SETTLED; they vote in the next pass, which the applicant carries into. Decision 76's "returns the reviewer to the denominator as outstanding" would instead reopen the row. Both defensible; the module chose. → Bucket B item B8.

**A12. No predicate distinguishes an admin write from a recount — REFUTED.** `manuallyReject` gates on `isTerminal` (`passes/actions.ts:334`), not `isMutableResolution`, and its comment (`:284-290`) says CARRIED and NEEDS_ADMIN rows are rejectable, which is 17l's "any applicant". The module does export the predicate the write needs; it is `isTerminal`.

**A13. FR-17's "automatically set to SKIP" — code is right, text stale. Bucket C item C7.**

**A14. "Unresolved" collision — CONFIRMED, Bucket C item C10.** `resolutionLabel(null)` renders on the pass grid (`[passId]/page.tsx:121` → `pass-grid.tsx:145`), the member list (`page.tsx:211`) and the applicant's pass history (`results/[applicantId]/page.tsx:372`); FR-19's group of the same name is a different predicate (`lib/final.ts:83`).

**A15. Stale citations to 66 and 78 — CONFIRMED, Bucket C item C8.**

**A16. "Nothing in the product makes a REJECTED applicant ACTIVE again" versus §5/§8's decision reversal — the comment is true and the PRD is the problem.** No code path writes `status: ACTIVE` (the only matches are pool filters). §5's `Decision` comment ("a reversal updates the row and is audited"), §8's audit list ("decision reversal") and the audit page's copy (`audit/page.tsx:92`) all describe an override that has no surface. FR-19's admit/reject is one-way. → Bucket B item B9; not a code defect.

**A17. Clause identifiers 17b…17z exist only in `plans/phase-6.md` — CONFIRMED, Bucket C item C11.** Roughly sixty citation sites across `lib/`, `app/`, `prisma/`.

**A18 (new, not in the audit). The floor repair re-creates RETURNED_TO_POOL pairs — CONFIRMED.**
- Code: the swap search (`lib/assignment.ts:529-539`) checks `onApplicant` but never `placed`, which is where forbidden pairs live. A returned pair is blocked from the greedy fill (`:448`) and then reintroduced by the repair.
- Demonstrated: 3 reviewers, 10 applicants, `r0` returned `a0…a6`. The plan contains `r0` on `a1`, `a2`, `a4`, `a5`. In the A1 order-reversal run the reversed plan created four blocked pairs the same way. This violates decision 23 and FR-8's "generation must never re-create that pair". The suite's blocked-pair assertion (`assignment.test.ts:77-80`) is right; its only blocked case (`:615`) is a 150/30 roster where the repair never fires. What the persistence layer does when handed such a pair (the RETURNED_TO_POOL row still exists under the same unique key) is unverified and is the first thing the fix slice checks.
- Disposition: same function and same slice as A1 → **decision 98**.

### Draft decision text for the confirmed behaviour changes

Numbering assumes 98 onward; adjust if Bucket B decisions are approved first. Drafts are for the owner to edit; nothing is written until approved.

**98. FR-7's floor repair: every light reviewer, no forbidden pair, preserved rows immovable. RESOLVED.** Three defects in `evenOutToFloor`, found by a cold audit of the module and confirmed by running it. (1) It took the first reviewer below the floor and abandoned the repair when *that* reviewer had no legal swap, so whether a later reviewer was evened out depended on array order: the same input with the roster reversed changed one reviewer's load from 10 to 14 against a floor of 14. FR-7 says the exemption "is a property of the assignment, not of the reviewer"; array position is neither. The loop now visits every light reviewer and stops only when none has a swap. (2) The swap search never consulted the forbidden set, so it re-created RETURNED_TO_POOL pairs that the fill had correctly refused, against decision 23. It now does. (3) FR-7's precise form quantified over "any reviewer `s` assigned to `a`", and the code and its test only ever considered generated rows, because FR-8 forbids removing a manual assignment. That was the right reading and is now the text: `s`'s assignment must be a generated one, and a reviewer whose only route up runs through a preserved row is exempt on the same terms as the Sparklet case. Also recorded: under the relaxed rule Sparklets stay under the ordinary ceiling; only the one-per-applicant rule is meant to bound them and in practice it binds first. Two regression tests pin the order-independence and the no-forbidden-pair property.

**99. Generation reports what it could not place. RESOLVED.** `generateAssignments` breaks out of the fill when no candidate remains and returned nothing to say so; the precheck is capacity arithmetic and does not see returned pairs or the fill order, so `feasible: true` is not a guarantee. Demonstrated: an applicant returned by every reviewer on a three-reviewer roster ends with zero reviewers, the plan is three slots light, and the success message reads normally. FR-7's "the system must not silently violate a constraint" is exactly this case. The plan gains a `shortfall` list (applicant, wanted, got); the action names the applicants and the count in its result and refuses to call the run a success when the list is non-empty. **[Owner's choice, recommendation first]** (a) *Place the plan and report the shortfall.* Pro: the admin gets 424 correct assignments and a named list to fix by hand through FR-8, which is what they would do anyway. Con: a plan that violates FR-7's invariant exists in the database for a while. (b) *Refuse the plan as the precheck refuses an infeasible roster.* Pro: FR-7's invariant never holds false in the database. Con: an applicant nobody can be assigned to blocks the whole round, with no in-product fix except assigning by hand and regenerating. Same slice: the report's `shortApplicantCount` and `fullApplicantCount` are derived from the short set actually chosen, not from `poolSize`, and FR-7's "exactly" sentence gains "or as many applicants as the preserved rows leave shortable, when that is fewer".

**100. A closed pass is read with the conflicts that existed when it closed. RESOLVED.** Conflicts are round-scoped and sticky (FR-16, decision 68), and every reader passed the round's whole set to every pass. A conflict flagged in pass 3 therefore rendered as SKIP over a YES stored in pass 1, moved pass 1's tally, moved FR-19's "why unresolved" phrase, and could be flagged after the round had closed because the flag action checked only that the applicant was ACTIVE. No stored resolution was rewritten, which is why nothing was decided wrongly; what was shown was. **[Owner's choice, recommendation first]** (a) *Time-scope at read.* FR-18 and FR-19 read conflicts with `createdAt ≤ pass.closedAt` for a closed pass and the full set for the open one, through one helper in `lib/passes.ts` so the two surfaces cannot disagree; `flagConflict` refuses once the instance is COMPLETE. Pro: no schema change, both columns exist, closed passes become a stable record. Con: a conflict removed by an admin (decision 76) leaves no row, so a closed pass whose conflict was later lifted renders as if it never existed; acceptable because 76 already forbids reopening terminal rows and the audit row records the removal. (b) *Freeze per pass at close.* Write a `PassApplicant`-level or `PassVote`-level SKIP record at close. Pro: exact. Con: a schema change, a new write in the close path, and a stored SKIP row of exactly the kind decision 67 forbids. (c) *Accept and document*, keeping `computed` beside `stored` as the grid already does. Pro: nothing to build. Con: FR-19's Unresolved reason and a closed pass's NULL rows remain movable by a later action, and the post-close flag stays reachable.

---

## Part 2, Bucket B — decisions that contradict each other (owner's call)

Every fix here is a new decision with forward pointers on the originals, per correct-from-below, except where noted that the text is FR prose rather than a decision.

**B1. 71 versus 75.** Fact from the code (A10): a manual reject removes the applicant from the reviewer's list and profile; a submit already in flight is answered with "already decided, nothing recorded", not an error, and nothing is stored. So 71's "not blocked" is true of the submit and 75's "the control is gone" is true of the page.
- (a) New decision reconciling both: a manual reject closes 75's window the same way a resolution does; 71's "not blocked" means an in-flight submit is answered rather than refused. Forward pointers on 71 and 75. Pro: records what shipped. Con: none.
- (b) Amend 71 in place. Con: breaks correct-from-below.
- Recommendation: (a).

**B2. 73 versus 72 and 89.** Facts: the close writes NEEDS_ADMIN over CARRIED on the final pass (`passes/actions.ts:451-473`); the close's audit row carries counts only (`:488`), so the per-row CARRIED→NEEDS_ADMIN transition is not recoverable from the audit log; it *is* recoverable from the votes, and `unresolvedReason` already derives MIXED from them (`lib/final.ts:252-254`).
- (a) Keep 73, add a decision that states why it is not the correction 89 forbids: the close is the pass's own terminal state, not a decision about the applicant; a CARRIED row on a pass with no successor has nothing to carry into; the mixed vote survives in the votes and FR-19 renders it as MIXED. Pro: no code, shipped and gate-verified. Con: 72's "one value, one meaning" is bent once, on purpose.
- (b) Close writes NEEDS_ADMIN over NULL only; FR-19 reads `NEEDS_ADMIN or CARRIED on the final pass`. Pro: 72 and 89 hold literally. Con: changes `UNRESOLVED_AT_CLOSE`, `needsAdminAtClose`, `isUnresolved`, their pinned tests, the seed's pass script, and FR-17/FR-19 text; two predicates now define one group.
- (c) Close writes nothing; FR-19 reads `NULL or CARRIED on the final pass of a COMPLETE instance`. Pro: most principled. Con: largest change, and 17q/17r/17s are built around the write.
- Recommendation: (a). The information 89 protects is not lost.

**B3. 85 versus 76.** Facts: withdrawal deletes the round's conflicts in the removal transaction (`reviewers/actions.ts:525`) and the removal's audit row records `deletedConflictCount` (`:501`). So the deletion is audited, by count, on the withdrawal row. 84 confines withdrawal to before pass 1, when no vote depends on any conflict.
- (a) New decision amending 76's "nowhere else": the grid is the only *control*; withdrawal removes conflicts as a consequence and the withdrawal's audit row carries the count. Forward pointers on 76 and 85. Pro: matches what shipped. Con: none.
- (b) Also record the deleted `(applicantId, reviewerId)` pairs, not just the count, in the withdrawal's `previousValue`. Pro: an admin can later answer "which conflicts vanished". Con: small code change in a Phase 6 action.
- Recommendation: (a), with (b) if the owner wants the pairs.

**B4. 40 versus FR-4 on the default floor.** Facts: the column default is 0 (`prisma/schema.prisma:387`); the builder's new-row default is 1–4 (`app/instances/[id]/rubric/rubric-builder.tsx:21`). Both sentences are true at different layers, so **this is a documentation fix, not a contradiction**. Proposed text, added to 40 as a clarifying sentence (no pointer needed, nothing supersedes): "The database default is 0 so the migration changes no existing row; the builder offers 1–4 for a new category, which is what FR-4 means by 'starts at'." And "decision F-01" → "finding F-01 in `plans/phase-3-test-pass.md`" (C5). Owner to confirm this is not a decision.

**B5. 82 versus 83a on where the settled state renders.** Facts: the list renders no vote state at all (`second-round/page.tsx:107-145`; the row type in `lib/second-round.ts:19-30` has no vote field); the settled control is the profile's (`vote-buttons.tsx:62-70`). 82's cost statement is true. **Documentation fix**: 83a gains "on the profile, per decision 82; the list is unchanged". Owner to confirm.

**B6. §7.4's edge-case table versus 84.** Facts: the all-COI row's recovery ("a reviewer without a conflict may yet be added") is dead under 84; the real recoveries are decision 76 (lift a conflict in the open pass) and FR-19's admin decision at close. The roster row cites 66 and 78 with the pre-84 trigger. These are FR table cells, and FR text has been amended in place before (FR-17's bullets carry "per decision 72", "per decision 75").
- (a) Rewrite the two cells in place, citing 76, 84 and 89. Pro: the table is read by whoever builds against §7.4 and should be right where it is read. Con: none, if the owner accepts that correct-from-below applies to §10 entries and not to FR prose.
- (b) Leave the cells and add a decision. Con: a reader of the table gets a wrong recovery path.
- Recommendation: (a). Proposed cells: all-COI → "Cannot resolve. `resolution = NEEDS_ADMIN` on that pass. Do not treat as unanimous. The applicant stays ACTIVE and carries into the next pass. Recovery is an admin lifting a conflict on FR-18's grid (decision 76) while a pass is open, or the admin decision FR-19 requires once the round closes; the roster cannot be changed after pass 1 (decision 84)." Roster row → "Cannot happen. Decision 84 fixes the second-round roster, adds and removals alike, from the moment the first pass is created; 66 and 78 as amended."

**B7. 5 versus 16.** Facts: no "changed by X at Y" indicator exists anywhere (no match for the phrase in `app/`, and the assignments surface renders no timestamps). Last-write-wins is the de facto behaviour, and before Phase 8 there was no identity to name. Decision 93's `actorName` now makes an indicator possible.
- (a) New decision: the indicator never shipped; last-write-wins is the v1 behaviour; `AuditLog.actorName` is what an indicator would read; recorded as a v2 candidate. Pointers on 5 and 16. Pro: honest, no build. Con: 5 stays partly unmet.
- (b) Build the indicator now on the assignments page (last audit row's `actorName` and time). Pro: closes 5. Con: a Phase 8 feature slice nobody asked for at this point.
- Recommendation: (a).

**B8 (surfaced by A11). CARRIED and decision 76.** Should lifting a conflict on a CARRIED row in the open pass reopen it?
- (a) Keep the code: CARRIED is a completed vote, 75's window is shut, the reinstated reviewer votes in the next pass. Amend 76 by a new decision: "a CARRIED row is not reopened either; the reviewer's first vote on that applicant lands in the next pass". Pro: no code, one meaning for CARRIED (decision 72's principle). Con: a pass can end with a reviewer who never got to vote on an applicant they were eligible for.
- (b) Make CARRIED mutable in the open pass while the applicant is still a member. Pro: 76's sentence holds literally. Con: `isMutableResolution` gains a fourth case, the vote action's terminal guard changes, and a CARRIED row can flip to SPARKLET or REJECTED after everyone thought the pass had spoken.
- Recommendation: (a).

**B9 (surfaced by A16). Decision reversal is promised and does not exist.** §5's `Decision` comment, §8's audit list and the audit page's copy describe an audited reversal; no surface writes `status = ACTIVE` or rewrites a `Decision` row except the pass-vote and manual-reject upserts.

*Owner's two questions, answered from the code:*
- **Does `manuallyReject` have a confirmation step?** Yes. `reject-control.tsx:45-65` renders a confirm naming the applicant and their `Applicant N` handle, with the consequence spelled out, before the form submits. Its own doc comment (`:11-16`) says "the only route back is an override on a later surface". That surface is the thing B9 is about: it does not exist.
- **Would FR-3's re-import path work on a cycle with real second-round data?** No. FR-3's sentence (`PRD.md:402`) names two correction paths. "Deleting the instance and importing again" runs `deleteInstance` (`settings/actions.ts:80`, typed-name gate) and every model cascades from `Instance`, so it destroys every score, note, interview import, vote, pass, conflict and decision in the cycle, not the one wrong row. "Editing an applicant's fields directly" has no surface at all: the only `applicant.update` calls in `app/` write `status` (`second-round/actions.ts:301`, `final/actions.ts:124`, `passes/actions.ts:355`, `:645`), and `plans/phase-7.md` already records that no applicant edit control exists. So the honest statement is: **in v1 a wrong manual reject, or a wrong finalize, has no recovery short of destroying the cycle.** My earlier draft of option (a) was wrong to describe re-import as a correction path.

Revised options:
- (a) Record it. New decision stating that v1 has no reversal; a wrong second-round manual reject is final; the confirm on the reject control is the only guard; §5's `Decision` comment, §8's audit list and `audit/page.tsx:92` are amended to say reversal is reserved for v2; FR-3's "editing an applicant's fields directly" is deleted because no such surface exists. Pro: the PRD stops promising two controls that are not there (decision 29's lesson), and the reject control's comment stops pointing at one. Con: the exposure stays. The reject is confirmed and names the handle, so the realistic failure is an admin changing their mind, not a mis-tap.
- (b) Build the narrowest reversal that closes the live exposure: on FR-18's grid, an admin can reverse *a manual reject made in the open pass* (row still `REJECTED`, `Decision.actor = ADMIN`, pass still open). It sets `status` back to ACTIVE, clears the pass row to `NULL`, deletes the `Decision` row, and writes an audit row carrying the previous values. Scope excludes vote-driven resolutions and earlier stages. Pro: covers the one action an admin takes alone and can regret, inside the pass it happened in, with no membership consequence (the applicant is still a member). Con: a new mutation on a Phase 6 surface; `isMutableResolution`'s "REJECTED never moves" doc comment needs a stated exception; a slice of its own.
- (c) Build a general reversal on `/results/[applicantId]` across all three stages. Pro: fulfils §8 as written. Con: reversing a first-round or written reject re-enters an applicant into rounds that have run, with roster, assignment and pass-membership consequences nobody has specified. Not recommended for this pass.
- Recommendation: (a) now, with (b) recorded inside it as the v2 candidate, unless the owner wants (b) as a fifth slice in this pass. Owner to choose.

---

## Part 2, Bucket C — text cleanup, one right answer

| # | Where | Fix |
|---|---|---|
| C1 | `PRD.md:624`, decision 2 | Delete the trailing question. New text: "**Sparklet-heavy roster handling. RESOLVED: uneven Sparklet load.** Offered as an action on the feasibility failure, per FR-7's relaxed rule; the one-Sparklet-per-applicant rule is never relaxed." |
| C2 | `PRD.md:632`, decision 6 | Replace "This is Phase 5 schema work and is not in the current migration." with "Shipped in Phase 5; decisions 47–65 record what the build found." Also `PRD.md:194` "See open decision 6" → "See decision 6". |
| C3 | `PRD.md:570` | "**Open decision:**" → "**Live vote visibility (decision 3, resolved):**" |
| C4 | `PRD.md:1144`, decision 97 | "150 applicants, 30 reviewers" → "150 generated applicants plus the eight pinned reconciliation identities, 158 in all, and 30 reviewers". Source: `prisma/seed.ts:31` (`APPLICANT_COUNT = 150`) plus `RECONCILIATION_COHORT` of 8 in `prisma/seed/first-round.ts:41`; `prisma/fixtures/README.md:230` confirms rows 151–158. `ARCHITECTURE.md:184` and `ADMIN_GUIDE.md:351` already say 158. |
| C5 | `PRD.md:813`, decision 40 | "which decision F-01 already finds fiddly" → "which finding F-01 in `plans/phase-3-test-pass.md` already finds fiddly". F-01 is a test-pass finding, not a §10 entry. |
| C6 | `PRD.md:697`, decision 26 | Append to the heading paragraph: "**Amended by decision 37** (also cleared on sign-out and by a 7-day TTL) **and decision 38** (a return to pool clears that draft and does not hold for a save in flight)." Matches the note pattern on 45, 66, 78. |
| C7 | `PRD.md:538`, FR-17 third bullet | "A reviewer with an active COI on an applicant has their vote in that pass automatically set to SKIP and cannot vote on that applicant." → "A reviewer with an active COI on an applicant is counted as SKIP in that pass — computed from the conflict, never a stored vote, per decision 67 — and cannot vote on that applicant." Add to §5 `PassVote.value` a comment: "SKIP is permitted by the shared `VoteValue` type and written by nothing in the product; `lib/passes.ts` honours one if it exists. See decision 67." |
| C8 | `lib/passes.ts:118-121`, `:168-171`; `app/r/[instanceId]/second-round/actions.ts:279`; `lib/passes.test.ts:140`, `:240` | Cite "decisions 66 and 78 as amended by 84" and, where the reasoning is the roster lock, say "first-pass creation" rather than the round. `[passId]/page.tsx:59` is already in this form. Comment-only. |
| C9 | `lib/assignment.ts:493-496` | Replace the invented quotation with FR-7's actual sentence from `PRD.md:456`: "nobody is left light while someone else is carrying two more than they are, unless moving one of that person's applicants across would put two Sparklets on it." Keep the paraphrase as prose below it. Lands with decision 98's slice, since that comment block is being rewritten anyway. |
| C10 | `lib/passes.ts:589-590`, test `:669-672`, and the doc at `:586-588` | `resolutionLabel(null)` → "No resolution" (§5's own words: "null until resolved"). Alternative if the owner prefers plain language: "Awaiting votes", which reads wrongly on a closed pass's NULL row. Preference: "No resolution". `PassSummary.unresolved` (`lib/passes.ts:468`) can keep its name; it is internal, but renaming to `noResolution` in the same commit keeps the vocabulary consistent. FR-19's "Unresolved" is untouched. |
| C11 | FR-17 clause identifiers | **Preferred: an appendix, not inline markers and not a citation rewrite.** Add "FR-17 clause index" directly under FR-17's edge-case table in the PRD, carrying the first two columns of the ledger at `plans/phase-6.md:186-213` (17a–17z, clause verbatim). Every existing citation becomes resolvable from `PRD.md` alone, with no inline noise in the bullets and no touch to ~60 code sites. Inline numbering was rejected because the letters do not map one-to-one onto bullets (17a–17k split eight bullets into eleven clauses; 17p–17u are the close paragraph; 17v–17y are table rows; 17z is the resolved decision-3 paragraph). Replacing citations was rejected as churn that loses precision. Same problem exists for 11e, 12a-4, 12q, 14e, 16i–16k, 18f citations from other phase ledgers; out of scope here, worth a general appendix later. |
| C12 | §5 versus `prisma/schema.prisma` | **The schema is right; §5 is behind in four places and follows its own convention in one.** (i) `Assignment` gains `returnReason: CONFLICT_OF_INTEREST \| OTHER`, `returnNote`, `returnedAt` (all nullable; schema `:529-531`; named by decisions 27, 28, 39). (ii) `PassApplicant` gains `resolvedAt` (schema `:824`; named by no decision, so add a one-line comment). (iii) `InterviewNotes.interviewerName` gets "nullable, per decision 60" (schema `:747`). (iv) Decisions 27, 39 and 60 each gain a "§5 amended" sentence, the pattern decision 34 uses. (v) `FirstRoundVote.updatedAt`: §5 lists no `updatedAt` on any model and no `createdAt` except `Instance` (it shows `submittedAt` and `decidedAt` where those are the meaningful stamp), so its absence is convention, not drift; decision 63's "its `updatedAt` exists for this" stands as is. |

---

## Flagged: audit and code agree, the PRD sentence is unclear

Documentation fixes, no decision: A2 (preserved rows and the floor predicate), A9 (Sparklet ceiling under the relaxed rule), B4 (40 versus FR-4), B5 (82 versus 83a). A6's SETTLED variant is a code tidy with no behaviour change.

---

## Owner's decisions (first review)

- Decision 99: option (a), place the plan and report the shortfall.
- Decision 100: option (a), time-scoped read plus post-close flag refusal.
- B1 → decision 101 (71 and 75 reconciled). B2 → decision 102 (73 kept, reasoning against 72 and 89 stated). B3 → decision 103 (76's "nowhere else" narrowed to the control; withdrawal's audit row already carries the count). B4 and B5: clarifying sentences on 40 and 83a, no decision. B6: the two table cells rewritten in place. B7 → decision 104 (indicator never shipped; `actorName` is what one would read; v2 candidate). B8 → decision 105 (CARRIED is not reopened by a lifted conflict).
- B9 → decision 106, option (a): v1 has no reversal; the reject confirm naming the applicant is the only guard; FR-3's nonexistent "editing an applicant's fields directly" sentence is deleted. The decision text records option (b), a narrow reversal scoped to a manual reject in the still-open pass, as a near-term priority to build before the next live cycle runs rather than an indefinite v2 item, because second-round deliberation is exactly where a board reconsiders a call.

## Execution order

0. Copy this plan to `plans/prd-reconciliation.md`; commit alone.
1. Part 1 edits and Bucket C items C1–C7, C11, C12, plus B4, B5, B6 text (PRD and BUILD_PLAN only); one commit. PRD version bump and header line.
2. Decisions 98–106 written as approved, with forward pointers on 5, 16, 71, 73, 75, 76, 85; one commit. No code.
3. Slice: decision 98 (`evenOutToFloor`, C9's comment, two regression tests, first checking what the persistence layer does with a re-created returned pair). `npm run verify`.
4. Slice: decision 99 (shortfall reporting, report counts from the chosen short set, FR-7 "exactly" clause, action message). `npm run verify`.
5. Slice: decision 100 (time-scoped conflict read helper in `lib/passes.ts`, FR-18 and FR-19 readers, post-close flag refusal, fix the `:74-76` comment). `npm run verify`, and a database check that a closed pass's grid does not move when a conflict is flagged afterwards.
6. Slice: A6 (SETTLED carries no resolution) and C8, C10 (comments and the null label). `npm run verify`.
7. Decision 106's narrow reversal is not in this pass; it is planned separately, before the next live cycle.

Each slice follows the clause-ticking rule against its decision text before commit. Slice 7 of Phase 8 does not start until the owner says so.

## Verification

- Text slices: `git diff` read against this table, line by line; `grep -n 153 PRD.md BUILD_PLAN.md` returns nothing.
- Decision 98: the A1 case (7 reviewers, 3 Sparklets, 27 applicants, relaxed, seed 1, `rev_3` blocked as in the search) leaves no below-floor reviewer with a legal swap; forward and reversed rosters produce identical load multisets; the A18 case (3 reviewers, 10 applicants, `r0` returned `a0…a6`) contains no blocked pair. Both as tests in `lib/assignment.test.ts`.
- Decision 99: the A3 case returns `shortfall` naming `a0` with `got: 0`; the A4 case reports `shortApplicantCount 2` and `assignedSlots 28`; the action's message names the shortfall. Existing suite green.
- Decision 100: a `buildPassGrid` test where a conflict newer than `closedAt` is excluded for a closed pass and included for the open one; a database exercise flagging a conflict after close and reading FR-18 and FR-19 before and after.
- `npm run verify` after every slice; `prisma/checks/passes.ts` re-run after slice 6 since it touches the close path's neighbours.

## Outcome (2026-09-06)

Eight commits, in the order above. `npm run verify` green after every slice; 839 tests before the pass, 856 after.

- **Steps 0–2.** Plan, §1 and Bucket C text, decisions 98–106 with forward pointers. PRD v1.25.
- **Slice 3, decision 98.** `evenOutToFloor` scans every light reviewer and honours the forbidden set. Three regression tests built from the demonstrating inputs; all three failed against the previous implementation before the fix was written. The persistence question A18 left open is answered: the regeneration deletes only ACTIVE rows before `createMany`, so a re-created returned pair collided with the surviving row's unique index and the regeneration failed outright. Decision 98's text records it.
- **Slice 4, decision 99.** `shortfall` on the plan; the action names under-staffed applicants by handle in its result, log line and audit row and does not call the run a success; the page shows FR-7's standing invariant through `understaffed` (pure, tested) until an admin closes the gap. Report counts follow the short set actually chosen.
- **Slice 5, decision 100.** `conflictsInForce` in `lib/passes.ts`, read by FR-18, FR-19 and the pass history; `flagConflict` refuses on COMPLETE and the list hides the control. `prisma/checks/closed-pass-conflicts.ts` (new, `npm run check:closed-pass-conflicts`) reads FR-19 through `loadFinalPage` before and after a post-close conflict on the seeded instance: tally unchanged at 12 eligible, and the negative control's unscoped read moved to 11. Passed; probe row removed and verified.
- **Slice 6.** SETTLED carries no outcome (strict test), `resolutionLabel(null)` is "No resolution" on every surface that rendered it, 66/78 citations follow 84, the audit page stops promising decision reversals.

**Not done here, on purpose.** `prisma/checks/passes.ts` was not re-run: slice 6 touched only copy in the close path, not the index or the write. Decision 106's narrow reversal is its own slice, before the next live cycle. `README.md:9`, `ARCHITECTURE.md:14` and CLAUDE.md's "~150 applicants" still describe cycle scale at 150; §1 now says 160+, and those three are the owner's call. `PassSummary.unresolved` keeps its internal name.
