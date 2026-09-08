# Phase 9 — what using it found

Companion to PRD §10 decisions 110–118. The reasoning for each decision lives in
the PRD; this file is the execution record — what each slice touches, what its
gate is, and what the gate found.

Everything in this phase came from the owner clicking through a built product
rather than from review. That is the fourth phase in a row where that is true
(3, 5, 6, 7 each recorded it), and it is why the gates below are all "open it in
a browser" rather than "the suite is green".

---

## Slice 9.0 — the decisions — **DONE**

PRD §10 gains 110–118. FR text amended in §5, §6, §10.7, FR-2, FR-3, FR-4, FR-6,
FR-8, FR-9, FR-10, FR-14, FR-16 and §7.4's clause index. Forward pointers on
decisions 22, 27, 32, 34, 39, 40, 62, 74, 80, 82, 83, 83a, 84 and 108.

**Gate:** owner read and approved. Confirmed one premise by hand — decision 111
rests on the second round being one deliberation in one room, and the owner
confirmed that has been true of every cycle.

**Census taken before writing 114's migration rule**, not after:
`RubricCategory.description` is non-null on 17 of 18 rows across six instances,
none whitespace-only. But 12 are the same four strings `prisma/seed/` writes and
regenerates, and 4 are keyboard mash on a walkthrough instance. **One row holds
prose a person wrote for its purpose** — "Initiative" on *Demo Cycle — my
practice run*, whose text names what a 4 means, which is the one case where
migrating into the top value is right rather than least-wrong. Every category on
every instance runs 1–4, so 114's scale-width cap binds on nothing that exists.

---

## Slice 9.1 — the second round becomes visible

Decisions 111 and 112, the resolving-vote 404, and FR-18's grid colour. One
slice because they are one fact reaching four surfaces.

**The two predicates, which is the part to get right.** `SECOND_ROUND_POOL`
(`status = ACTIVE`) is FR-17 clause 17b's pass membership and does not move.
`SECOND_ROUND_COHORT` (`stageReached = SECOND_ROUND`) is new and is what a
reviewer reads. They were one constant only because the sets coincided; widening
the shared one would have created passes over resolved applicants, and leaving it
alone would have kept resolved applicants off the list. One of the two surfaces
had to be wrong and neither would have looked it.

**Read widened, write unchanged.** `flagConflict` and `submitPassVote` keep the
ACTIVE predicate. A resolved applicant is reachable and not votable.

**The 404, and what the reversal did and did not fix.** Root cause:
`second-round/[applicantId]/page.tsx` queried with `SECOND_ROUND_POOL` and called
`notFound()`; `submitPassVote` revalidates that same route, so the reviewer whose
own vote completed unanimity was re-rendered through a query that no longer
matched. No redirect was involved — the redirect logic was never broken. Decision
112 fixes it, but **only because the profile's predicate moved too**; widening
the list alone would have left it exactly in place. Not fixed by the reversal and
done anyway: there was no `not-found.tsx` anywhere under `app/`, so every
reviewer-side 404 was Next's stock page with no way back. Added at
`app/r/[instanceId]/not-found.tsx`, deriving the instance id from the pathname
because the file convention is not given params.

**Files:** `lib/labels.ts` (`Outcome`, `OUTCOME_TONE`, the two mappers),
`lib/passes.ts` (`SECOND_ROUND_COHORT`, `voteAvailability`'s `RESOLVED` state),
`lib/second-round.ts` (`outcome` on the row, `undecidedCount`),
`app/r/[instanceId]/second-round/{load.ts,page.tsx,actions.ts}` and
`[applicantId]/{page.tsx,vote-buttons.tsx}`,
`app/r/[instanceId]/not-found.tsx`,
`app/instances/[id]/passes/[passId]/{page.tsx,pass-grid.tsx}`.

**Two things that would have broken quietly**, both caught by working the clause
list rather than the diff:

1. **The conflict control on a resolved row.** `flagConflict` refuses a resolved
   applicant, so keeping the row without hiding the control would have put a
   working-looking control on every green and red row that the action then
   refuses — the offered-and-refused shape decision 100 exists to prevent.
   Hidden on both the list row and the profile section.
2. **The list's third empty state.** "Every applicant has been decided" used to
   be what an empty `status = ACTIVE` list meant. Under the cohort predicate that
   is unreachable, and the branch would have gone on claiming to handle a case it
   could never see. The sentence moved into the header, derived from
   `undecidedCount`; the empty branch now says the true remaining thing, which is
   that the first round advanced nobody.

**FR-18's colour comes from `PassApplicant.resolution`, never from
`Applicant.status`.** §7.4 is explicit that a pass row records what happened *in
that pass*, so an applicant rejected in pass 3 was genuinely carried by pass 1 and
pass 1's grid has to keep saying so.

**Gate — in a browser, not curl** (Phase 7's process failure was hand-minted
tokens behind "renders correctly" claims). **PASSED.**

- [x] Cast the vote that completes unanimity. Land on a green profile, not a 404.
- [x] The list shows red and green, and the row keeps its place in source order.
- [x] A `CARRIED` applicant is present, settled, and **uncoloured**.
- [x] A resolved row offers no conflict control, on the list and on the profile.
- [x] Pass 1's grid still shows pass 1's resolutions after pass 2 exists.
- [x] No other reviewer's vote is in the RSC payload (decision 74, clause 17z).
- [x] A bad applicant id under `/r/` renders the new not-found with a way back.

**How the first one was reached, since it needed a state the seed does not
contain.** No applicant anywhere was one vote from resolving, so the transition
was staged on `seed_walk0907` — the instance named throwaway — by creating pass 1
and writing YES votes for 11 of its 12 eligible second-round reviewers. The
twelfth vote was cast by hand in the browser, signed in as that reviewer.

Before: "Your vote", Yes / No / Submit, and a conflict control. After submitting:
the same URL, no navigation, no 404 — the section became "Outcome" carrying the
green "This applicant is now a Sparklet", and the conflict section was gone. The
list went from "30 still to decide" to 29, with the green badge on Applicant 1
holding its place in source order.

The database recorded all four writes FR-17 requires: 12 `PassVote` rows,
`PassApplicant.resolution = SPARKLET` with `resolvedAt`, `Applicant.status =
SPARKLET`, and a `Decision` at `stage = SECOND_ROUND` with `actor = SYSTEM`
(decision 69).

**The staging and teardown scripts were scratch, not committed**, and the
teardown asserted its own result rather than assuming it: 1 pass, 12 votes, 1
decision and 1 resolved applicant removed, all four counts back to zero, and
`seed_walk0907` confirmed back at 30 active with no pass. That check matters more
here than it usually would — `CLAUDE.md`'s security note is about a fixture that
destroyed rows the script had never created, so a script that writes votes into a
real instance is exactly the shape that goes wrong. It was guarded three ways:
the instance id hardcoded, the instance *name* required to still contain
"throwaway", and a refusal if any pass already existed.

**Decision 74's payload check is a code reading, not a byte inspection**: the
profile's only `passVote` query is a `findUnique` scoped to the signed-in
reviewer, unchanged by this slice. Said plainly because "verified" should not
cover two different strengths of evidence.

---

## Slices 9.2 – 9.5

Scope is in `BUILD_PLAN.md`'s Phase 9 section; each is written up here as it is
built.
