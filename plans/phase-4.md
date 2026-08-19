# Phase 4 — Written results and selection (FR-10, FR-11)

**Gate (BUILD_PLAN Phase 4):** ranking matches a hand calculation on ten synthetic applicants; the demographic panel updates live as boxes are checked; finalize produces the right `Decision` rows and the right `status` / `stageReached` split; and the whole thing is walked in a browser, not just typechecked.

---

## Context

Phase 3 ended with thirty reviewers able to score a hundred and fifty applicants on a phone, and nobody able to read the result. Every score in the system is currently write-only: `Score` and `ReviewNote` rows accumulate behind `/r/[instanceId]`, and no admin surface reads either. This phase closes that loop, and BUILD_PLAN calls the result the milestone at which the project becomes shippable — "a working written round beats three half-finished ones."

Three things arrived with PRD v1.7 that shape the phase:

- **Decision 40** — the stored scale runs `0..maxPoints`; the instrument it is meant to express runs 1 to 4. `RubricCategory` gains `minPoints`, deferred out of Phase 3 into here because FR-10 is the first requirement that *computes* on the scale rather than only storing it.
- **Decision 41** — `Applicant.status` loses `ADVANCED`, and FR-11's finalize becomes explicit: a `Decision` row for **every** applicant in the pool, not only the ones who advance.
- **The FR-10 paragraph** now pins variance to *population* variance over each reviewer's own category average, and makes the high-variance threshold admin-set at view time, off by default, not persisted.

### Three corrections to the brief, each of which changes a step

**1. This is not the first schema migration since Phase 0.** `prisma/migrations/` holds six, most recently `20260812060203_rubric_category_description` — Phase 3's decision-32 work, a one-line `ALTER TABLE ... ADD COLUMN` that `minPoints` can be modelled on directly. The `next dev` restart stays exactly as briefed and is a numbered step below, not a reminder.

**2. There is a second pending schema change sitting beside `minPoints`.** Decision 41 resolves that `ADVANCED` leaves `ApplicantStatus`, and `PRD.md:140` already prints the three-state form — but `prisma/schema.prisma:81-86` still carries all four values. Slice 1 lands both, as two migration directories in one slice, so there is one migrate-and-restart cycle rather than two.

**3. The seed writes no `Assignment` rows either, not just no `Score` rows** (`prisma/seed.ts:177-179`). Per the owner's decision, slice 2 now writes both, reusing the pure planner in `lib/assignment.ts` so the seed and FR-7's Generate button cannot disagree about shape. The seed's "deliberately absent" comment scoped itself to "phases 2, 3, and 6"; two of those have shipped, so the rationale has expired for assignments and scores and still holds for passes, votes and decisions.

---

## Clause ledger

CLAUDE.md's mechanical guard, ticked against this plan now and re-ticked against the diff before each commit. FR-10 is a six-clause sentence plus two added paragraphs, and FR-11 is a four-clause sentence — the exact shape that broke twice in Phase 2.

| # | Clause, verbatim | Slice | Ticked by |
|---|---|---|---|
| 10a | "ranked by average score descending, then by variance ascending" | 3 | `rankApplicants` in `lib/results.ts`, plus the `sourceRowIndex` third key from decision 42 |
| 10b | row shows "rank" | 3 | Leftmost column, 1-based, computed after sort |
| 10c | row shows "name" | 3 | `displayName`, admin-visible per §6 and PRD:280 |
| 10d | row shows "average" | 3 | Mean of reviewer averages, 2 dp |
| 10e | row shows "variance" | 3 | Population variance, 3 dp, **every row regardless of filter state** |
| 10f | row shows "review count (2/3, 3/3)" | 3 | `n / targetFor(...)`, numerator = **completed** reviews per PRD:511 |
| 10g | row shows "demographic fields inline" | 3 | DEMOGRAPHIC fields + groups via `visibleFieldIds(..., "ADMIN")` |
| 10h | "Filters for … 'incomplete'" | 3 | URL param `?only=incomplete`, any count under target |
| 10i | "Filters for 'high variance'" | 3 | URL param `?minVar=`, numeric, **empty by default, not persisted** |
| 10j | "Admin can open any applicant to read the full profile" | 3 | `/results/[applicantId]`, all fields, admin viewer |
| 10k | "and all three reviewers' scores and notes" | 3 | Per-reviewer card: per-category scores, that reviewer's average, `ReviewNote` body |
| 10l | count cell "carries a visual marker (not row-level) when under 3/3" | 3 | Marker on the `<TableCell>` only; row styling untouched |
| 10m | threshold "admin-set at view time — a numeric input, off by default" | 3 | Number input in the filter bar; no column, no cookie, no `localStorage` |
| 11a | "Admin checkboxes select applicants to advance" | 4 | Checkbox column on the ranked table |
| 11b | "A live panel shows the demographic breakdown of the current selection against the applicant pool" | 4 | Two columns, selection and pool, recomputed on every check client-side |
| 11c | "Finalizing writes `Decision` records" | 4 | One row per pool applicant, `stage = WRITTEN`, per decision 41 |
| 11d | "and populates the First Round tab" | 4 | `stageReached → FIRST_ROUND` on the advanced, **and nothing more** (PRD:703) |
| 11e | *(added)* once finalized, `/results` is read-only | 4 | Server-side `currentStage !== WRITTEN` gate: no checkbox column, no panel, no finalize; banner in their place. Table, filters and profiles stay |

**Two clauses added beyond the requirement**, deliberately.

The first, at the owner's direction: the finalize confirmation names the applicants who have zero completed reviews. Nothing in FR-10 or FR-11 asks for it; decision 1 (PRD:511) requires FR-10 warn about under-3 counts, and rejecting someone nobody read is the sharpest form of that warning going unheeded.

The second, clause 11e: after finalize, `/results` becomes a revisit surface rather than a selection surface. FR-11 describes selecting and finalizing and says nothing about what the page is afterwards, which leaves a screen offering to finalize a round that is already finalized — every checkbox pre-cleared, the panel reading zero, and a button whose only honest outcome is an error.

---

## New §10 decisions this plan proposes

CLAUDE.md: a new ambiguity goes to §10 rather than being picked silently. Three, all landing in Slice 0 before any code.

**42. Two applicants tied on both sort keys.** FR-10 names two keys and stops, so an exact tie renders in whatever order Postgres returned and can differ between two loads of the same page. **Proposed: `sourceRowIndex` ascending as the third key.** Stable, already on every applicant, never renumbered (decision 11), and carries no alphabetical bias — sorting by name would systematically advantage applicants early in the alphabet on every exact tie, which is a fairness property nobody chose. Reachable in practice: three reviewers all scoring straight 3s and one reviewer scoring a 3 both produce average 3.0000, variance 0.0000.

**43. Whether finalize moves `Instance.currentStage`.** Decision 41 bounds "populates the First Round tab" to `stageReached` and "nothing more", which is about *applicant* state and leaves the instance-level field unaddressed. `Instance.currentStage` is what `app/page.tsx:111` renders in the instance list and what the hub uses to say where the cycle is. **Proposed: yes, finalize moves it to `FIRST_ROUND`**, because the hub exists (decision 36) to say where the cycle actually is rather than to list links, and an instance whose written round is finalized is not in the written round any more. This is one field on `Instance` and creates no first-round roster or reviewer state, so it stays inside decision 41's boundary. Flagged rather than assumed because "and nothing more" is a sentence written to stop exactly this kind of addition.

> **This decision is load-bearing, not cosmetic, and that is a change from how it was first written above.** Clause 11e reads `currentStage` to decide whether `/results` still offers selection at all. If 43 is rejected and the field never moves, `currentStage` stays `WRITTEN` forever and the read-only gate never fires — so the page keeps offering to finalize a finalized round, which is the exact state 11e exists to remove. Rejecting 43 therefore needs a different signal for "the written round is over" (the simplest being the existence of any `Decision` row at `stage = WRITTEN`), and that substitution has to be made deliberately rather than discovered when the banner never appears.

**44. Applicants with zero completed reviews at finalize.** Resolved by the owner: **finalize proceeds, and the confirmation panel names them.** The count and the names appear above the confirm button — "3 of those 110 have no completed reviews … rejecting them records a decision nobody made." Rejected alternatives recorded with it: blocking finalize (strongest guarantee, but it can hold up a real deadline when a reviewer simply never showed, and the pool exists precisely because that happens), and silence (PRD-literal, and it makes the system do the thing it was built to prevent).

---

## FR-10 arithmetic — worked cases before any code

Per the brief and on the FR-9 precedent: **these cases are the spec.** If the implementation disagrees with the table, the implementation is wrong. All cases assume the post-slice-1 instrument: four rubric categories, each `minPoints = 1`, `maxPoints = 4`.

### The definitions being pinned

1. **A reviewer's category average** is the mean of that reviewer's scores across the live rubric categories.
2. **An applicant's average** is the mean of the *reviewer averages*, not the mean of all raw scores. Given rule 4 the two always coincide; stating it fixes which one is authoritative if rule 4 is ever loosened.
3. **Variance is population variance** over the reviewer averages: `(1/k)·Σ(rᵢ − mean)²`. No `k−1`. The PRD's reasoning: these two or three numbers are the entire set being measured, not a sample standing in for a larger one.
4. **Only a *completed* review contributes** — every live rubric category scored, via `completionOf` from `lib/review.ts:53`. This is not a reading: decision 1 (PRD:511) says FR-10 "must warn on total applicants with fewer than 3 **completed** reviews." A half-scored review would otherwise contribute an average over a different denominator than everyone else's, which is not a comparable number.
5. **Review count** renders `n / target`, where `target` comes from `targetFor` / `planShape` rather than a literal 3, so the results page and the generator cannot disagree. Normally 3; smaller only on a roster too small to reach it.

### The cases

| # | Applicant | Reviewer category averages | Average | Population variance | What it pins |
|---|---|---|---|---|---|
| 1 | E | 4.00, 3.75, 3.75 | **3.8333** | **0.0139** | Rank 1; non-terminating average pins display rounding |
| 2 | C | 3.00, 3.00, 3.00 | **3.0000** | **0.0000** | Perfect agreement; wins the tie on the variance key |
| 3 | A | 3.50, 3.00, 2.50 | **3.0000** | **0.1667** | Ties C on average, loses on variance |
| 4 | B | 4.00, 2.00 | **3.0000** | **1.0000** | **Two reviewers.** Ties on average, ranks last of the three; count cell marked |
| 5 | D | 3.75, 2.50, 2.00 | **2.7500** | **0.5417** | Ordinary mid-table row |
| 6 | F | 3.00 | **3.0000** | **0.0000** | **One reviewer.** Variance is a true zero that reads as agreement |
| 7 | G | none complete | **—** | **—** | Not zero. Em-dash, sorts last, always caught by *incomplete*, never by *high variance* |

**Case 1 longhand.** `4,4,4,4` / `4,4,3,4` / `4,3,4,4` → sums 16, 15, 15 → averages 4.00, 3.75, 3.75. Mean = 11.5 / 3 = 3.83333…. Deviations +0.16667, −0.08333, −0.08333 → squares 0.027778, 0.006944, 0.006944 → sum 0.041667 → ÷3 = **0.013889**.

**Case 3 longhand.** `4,4,3,3` / `3,3,3,3` / `2,3,2,3` → sums 14, 12, 10 → averages 3.50, 3.00, 2.50. Mean = 9.0 / 3 = 3.00. Deviations +0.5, 0, −0.5 → squares 0.25, 0, 0.25 → sum 0.5 → ÷3 = **0.166667**. *Sample* variance would be 0.5 / 2 = 0.25 — the two differ by half, so this case alone distinguishes the required formula from the reflex one.

**Case 4 longhand.** `4,4,4,4` / `2,2,2,2` → averages 4.00, 2.00. Mean = 3.00. Deviations ±1 → squares 1, 1 → sum 2 → ÷2 = **1.0**. Sample variance would be 2.0. The two-reviewer case is where the ÷k versus ÷(k−1) choice is loudest, which is why it is here.

**Case 5 longhand.** `4,4,4,3` / `3,3,2,2` / `2,2,2,2` → sums 15, 10, 8 → averages 3.75, 2.50, 2.00. Mean = 8.25 / 3 = 2.75. Deviations +1.0, −0.25, −0.75 → squares 1.0, 0.0625, 0.5625 → sum 1.625 → ÷3 = **0.541667**.

**Rank order: E, C, F, A, B, D, G** — with C before F by decision 42's `sourceRowIndex` key, since they tie on both stated keys.

### Rules the cases above do not cover, decided here

- **Case 8 — sort on the unrounded value.** Display rounds; sorting uses full precision. Two applicants tie only when the underlying numbers are equal, never when their *displayed* numbers match.
- **Case 9 — the threshold is inclusive.** Variance exactly equal to the typed threshold **is** shown. An admin typing 0.5 means "0.5 and up"; `>` would hide the exact-boundary case, which is the one they typed the number to find.
- **Case 10 — empty threshold means off**, which is the default state. Zero is legal and matches every applicant with a defined variance, including perfect agreement; cheaper than special-casing it.
- **Case 11 — undefined variance never matches any threshold**, including 0. Case 7's applicant is found by the *incomplete* filter, which is the filter that is about them.
- **Case 12 — the two filters compose with AND.** Both narrow.
- **Case 13 — variance is shown regardless of filter state**, explicit in the FR-10 paragraph and easy to lose to an implementation that computes it lazily only when the filter is on.

---

## Slices

Six commits: four build slices as briefed, a PRD-only Slice 0 leading them per CLAUDE.md's PRD-leads-code rule, and the status line last on the Phase 3 precedent.

### Slice 0 — PRD §10 decisions 42, 43, 44, alone in its own commit

`PRD.md` only. Adds the three decisions above; adds one sentence to FR-10 naming the third sort key; adds one sentence to FR-11 naming the zero-review warning. No renumbering of 1–41.

**Verify:** read the diff.

---

### Slice 1 — decision 40's `minPoints`, and decision 41's enum

Two migration directories, one slice, one restart.

**Schema.** `RubricCategory` gains `minPoints Int @default(0)` — the default is what makes the migration change the meaning of no existing row. `ApplicantStatus` loses `ADVANCED`. Nothing has ever written `ADVANCED` (grep confirms: it appears only in the schema and the PRD), but the migration asserts `SELECT count(*) FROM "Applicant" WHERE status = 'ADVANCED'` is zero before the type is recreated, because a Postgres enum-value drop fails loudly on a bound row and failing loudly with a reason beats failing loudly without one.

**`lib/rubric.ts`** — `RubricCategoryInput` gains `minPoints: number`. `validateRubric` gains the decision-40 invariant beside the existing bounds: `minPoints` must be a whole number, `>= 0`, and strictly `< maxPoints`. `rubricTotal` becomes a range — a rubric with a floor has a minimum awardable total as well as a maximum, and the builder's "20 points per reviewer" line becomes "4–16 points per reviewer".

**`lib/review.ts`** — `validateScore(points, minPoints, maxPoints)`. The hardcoded `points < 0` at line 109 becomes `points < minPoints`, and its message names the floor. `null` is untouched: it means *clear this score*, and "unscored" remains the absence of a `Score` row, which is what makes dropping 0 from the offered values cost nothing.

**FR-4's builder collects both bounds.** `rubric-builder.tsx` — `RubricRow` gains `minPoints`; the two `{ name: "", maxPoints: 5 }` defaults at lines 28 and 166 become `{ name: "", minPoints: 1, maxPoints: 4 }`, so a new rubric starts on the instrument decision 40 actually wants; a second numeric `Input` sits beside Max points in the existing `flex flex-wrap items-end gap-3` row. `rubric/actions.ts:43-51`'s `cleaned` and `rubric/page.tsx:47-53`'s `initial` both pass it through.

**Both score controls render from the floor.** In `score-card.tsx`: `RubricRow` gains `minPoints`; the segmented iteration at line 413 becomes `length: maxPoints − minPoints + 1` with `value + minPoints`; `min={0}` at line 430 becomes `min={row.minPoints}`; the `SEGMENTED_LIMIT` test at 354 measures the **span** rather than the maximum, since a 90–100 category has eleven buttons and not a hundred; the two `out of ${maxPoints}` aria-labels become `${minPoints} to ${maxPoints}`. The `—` clear button stays.

**Two explicit `select` clauses must be widened or the new column never arrives**: `app/r/[instanceId]/actions.ts:144` and `app/r/[instanceId]/a/[assignmentId]/page.tsx:97`. This is the exact failure CLAUDE.md records from Phase 3 — `npm run verify` reads the regenerated client from disk and goes green while the app throws `Unknown field` at runtime.

**Steps, in order, one command per shell call:**

1. Edit `prisma/schema.prisma`.
2. `npx prisma migrate dev --name rubric_category_min_points`
3. `npx prisma migrate dev --name drop_applicant_status_advanced`
4. **Restart `next dev`.** Not a reminder — a step. The generated client is new on disk and the running server holds the old one in memory. If anything then fails, read the dev server log first: the untruncated Prisma error names the exact field, and it is in that output the whole time.
5. `npm run verify`
6. Re-run `prisma/checks/unique-constraints.ts` by hand against a seeded database, per CLAUDE.md.

**Walkthrough:** open `/instances/[id]/rubric` on the seeded instance — it is locked, since scores exist after slice 2, so do this *before* slice 2 or on a fresh instance. Set a category to 1–4, save, then open a reviewer scoring screen and confirm the segmented row draws `— 1 2 3 4` and no 0. Then, with the browser devtools, POST a `points=0` to `saveScore` and confirm the server refuses it — the control not drawing a 0 is not a constraint on what arrives.

---

### Slice 2 — the seed produces assignments and scores

`prisma/seed.ts` plus a new `prisma/seed/reviews.ts`. Passes, votes and decisions stay deliberately absent, and the comment at `seed.ts:177-179` is rewritten to say so rather than deleted.

**Rubric first.** `prisma/seed/roster.ts`'s `RUBRIC_CATEGORIES` moves to `minPoints: 1, maxPoints: 4`. The four seeded descriptions currently read "A 5 has started something unprompted…" and must be reworded to the new top of scale — a description that names a value the control no longer offers is worse than no description, and these are what a written reviewer scores against.

**Assignments** come from `planShape` / `prepare` in `lib/assignment.ts`, seeded through `createRng` so the fixture is byte-identical run to run. This reproduces the documented shape at `prisma/seed/roster.ts:19-38`: 450 slots, pool 22, **428 assignments across 128 applicants at three reviewers and 22 at two**, load ceiling 15. Persisted as `origin: AUTO`, matching what FR-7's Generate writes.

**Scores** are two populations, and the split is the point:

- **A hand-authored fixture block** reproducing cases 1–7 above verbatim on the ten lowest `sourceRowIndex` applicants. This is what makes the BUILD_PLAN gate — "ranking matches a hand calculation on ten synthetic applicants" — a check somebody can actually perform, rather than a recomputation of the same arithmetic by the same code.
- **Seeded-random scores** for the rest, drawn so the results page is exercised rather than merely populated: a spread of averages across the full 1–4 range, some applicants where three reviewers agree closely and some where they disagree by two whole points, most assignments complete, a deliberate handful left partially scored, and at least one applicant with **zero** completed reviews so decision 44's warning has something to warn about.

**A caution the seed's own header implies.** One `rng` instance threads through applicant generation and then reviewer generation, so reviewer names depend on applicants having consumed exactly the same number of draws. Assignment and score generation must therefore draw *after* both, or every reviewer in every screenshot and bookmark from Phase 3 changes name.

`prisma/inspect.ts` gains a scores section — count, complete/partial/absent assignment split, and the review-count histogram — so the fixture can be checked without the UI. Its line 223 rubric printout becomes `name (min–max)`.

**Walkthrough:** `npm run seed`, then `npm run seed:inspect`, then re-run it and diff the two outputs to confirm byte-identical determinism.

---

### Slice 3 — FR-10, the ranked results table

**`lib/results.ts`, pure, with `lib/results.test.ts` carrying cases 1–13 above.** No database and no Prisma client, matching `lib/assignment.ts`, `lib/passes.ts`, `lib/roster.ts` and `lib/review.ts`. This is the piece of the phase a test can hold still.

```ts
/// One reviewer's contribution. `null` where the review is not complete —
/// PRD:511's "completed reviews", not "reviews".
export function reviewerAverage(
  points: readonly number[], categoryCount: number
): number | null;

/// FR-10's two numbers. `null` for both where no review is complete: an
/// applicant nobody finished has no average, and 0.00 would be a lie the
/// high-variance filter would then read as agreement.
export function scoreSummary(
  reviewerAverages: readonly number[]
): { average: number | null; variance: number | null; completedCount: number };

/// FR-10's ranking, including decision 42's third key.
export function rankApplicants<T extends RankableApplicant>(rows: readonly T[]): T[];

/// FR-10's two filters, composed with AND. `minVariance: null` means off.
export function applyResultFilters<T extends RankableApplicant>(
  rows: readonly T[],
  filters: { incompleteOnly: boolean; minVariance: number | null },
): T[];
```

**`app/instances/[id]/results/page.tsx`** — server component, `requireInstance`, `InstanceCrumbs`, the `mx-auto w-full max-w-4xl px-6 py-12` shell. Loads applicants with their active assignments, each assignment's scores, and the live rubric; maps to flat DTOs before anything crosses to the client, per the `assignments/page.tsx` convention. Demographic columns come from `visibleFieldIds(fields, groups, "ADMIN")` and `projectApplicantData` in `lib/fields.ts` — the §6 helper, not a second derivation.

**Deliberately not paginated**, unlike `/assignments`. 150 rows is a scroll, and slice 4's selection has to span the whole pool — a checkbox state that resets when the admin turns the page is a selection defect, not a pagination convenience.

**Filters live in the URL** (`?only=incomplete`, `?minVar=0.5`) as a plain GET form and toggle chips, copying `assignment-controls.tsx:259-305`. That survives the revalidate that follows finalize, and it is linkable. It does **not** contradict "not persisted": the URL is view state the admin typed, and nothing writes it to the instance, a cookie, or `localStorage`.

**The under-target marker goes on the count `<TableCell>` and nowhere else** — clause 10l is explicit that it is not row-level, and `TableRow` already carries `hover:bg-muted/50` and a `data-[state=selected]` hook that slice 4 wants left alone.

**`app/instances/[id]/results/[applicantId]/page.tsx`** — clauses 10j and 10k. Full profile via `buildApplicantView` with the `ADMIN` viewer, then one card per active assignment: reviewer name, each category's score against its own `min–max`, that reviewer's average, and the `ReviewNote` body. Returned assignments render dimmed beneath with their reason, matching what decision 39 established on the assignments page.

**Hub row** added to `app/instances/[id]/page.tsx`'s `rows` array between Assignments and Settings, with a `state` computed from a real count — "150 ranked · 3 incomplete" — since the hub exists to say where the cycle is, and `waiting: true` when no score exists yet.

**Walkthrough:** `/results` on the seeded instance. Check the top ten rows against the table in this document by hand. Toggle *incomplete* and confirm the 22 two-reviewer applicants and the partial ones appear and nobody else. Type 0.5 into the threshold, confirm inclusivity at exactly 0.5, clear it, confirm the column is still populated. Open one applicant and read three reviewers' scores and notes.

---

### Slice 4 — FR-11, selection and finalize

Same page, per the owner's decision. A checkbox column joins the ranked table, the panel sits above it, and finalize sits below.

**`lib/demographics.ts`, pure, with tests.** §10.7's fractional counting has no implementation anywhere — `lib/field-groups.ts` provides the checked predicate and `checkedCount` returns the `n` in `1/n`, but nothing weights or aggregates. This is that function, built on those helpers rather than beside them:

```ts
/// PRD §10.7. Each applicant checking n options contributes 1/n to each;
/// n = 0 goes whole to "Not specified".
export function demographicBreakdown(
  applicants: readonly { data: ApplicantData }[],
  members: readonly GroupMember[],
): { label: string; weighted: number; headcount: number }[];
```

The test that matters most is §10.7's stated invariant: **weighted totals sum to the headcount**, asserted over a set containing single-checkers, multi-checkers and non-responders together. Display follows §10.7 verbatim — "East Asian: 12.5 weighted / 18 checked", one decimal — because a panel showing fractional people without explanation reads as a bug to a successor.

**The panel** renders two columns, current selection and full pool, in the `<dl>` stat-grid idiom from `assignment-controls.tsx:81-94`, and recomputes on every check. It is computed client-side from data already in the page payload, which is what makes "live" true without a round trip; demographics are admin-visible under §6, so nothing crosses a visibility boundary that was not already crossed to render clause 10g.

**Selection is client state**, a `Set` of applicant ids, not URL state — 40 cuids do not belong in a query string.

**Finalize uses a two-step confirmation panel, not FR-3's typed gate. The reasoning, written down because this is the kind of choice that otherwise gets made silently:**

The typed gate exists once in this codebase, on instance deletion, and `preview/page.tsx:192-200` states its own boundary: the typed form is for what is "rare and destroys work that exists," while the lighter two-step is for what is "on the path every instance takes." Finalize is squarely the second. It is a step every cycle performs exactly once, it creates rows rather than destroying them, and `Decision`'s own schema comment says a reversal updates the row and lands the previous value in `AuditLog` — so it is a recorded, reversible decision, not a deletion.

More to the point, **typing an instance name would not guard the thing that can actually go wrong here.** The error finalize is exposed to is not "I meant to click elsewhere," it is "I finalized the wrong selection." A name is orthogonal to that; an enumerated consequence list is not. So the panel spells out the advance count, the reject count, and decision 44's zero-review names, which is the guard that matches the risk.

**One honest deviation from FR-3's shape.** FR-3 made both steps server-rendered so neither is a dead tap before hydration. Selection is inherently client state, so the panel here is client-rendered — the checkboxes themselves do not work without JavaScript, and there is no version of this screen that does. The submit is still a real `<form action={formAction}>` with hidden inputs and `useActionState`, matching `CommitForm`, so the POST is a genuine form submission rather than an `onClick`.

**The server action, `finalizeWritten`:**

- `requireInstance` at the top, per `lib/auth.ts:3-12` — the proxy is not an authorization boundary.
- Re-reads the pool server-side rather than trusting the submitted ids for anything but membership: the pool is every `ACTIVE` applicant with `stageReached = WRITTEN` in this instance, computed on the server, and a submitted id not in it is refused rather than ignored.
- One `$transaction`. For every applicant in the pool, an `upsert` on `UNIQUE (applicantId, stage)` with `stage: Round.WRITTEN` and `actor: DecisionActor.ADMIN`. Selected: `outcome: ADVANCE`, `status` untouched at `ACTIVE`, `stageReached → FIRST_ROUND`. Not selected: `outcome: REJECT`, `status → REJECTED`, `stageReached` untouched at `WRITTEN`. Upsert rather than create so a retried submit after a dropped connection is idempotent rather than a unique-constraint error.
- An `AuditLog` row inside the same transaction, before the writes, carrying the counts and the instance — §8 lists decision reversal as audited, and the first write of a decision is not less significant than its reversal.
- `Instance.currentStage → FIRST_ROUND` per proposed decision 43.
- `revalidatePath` on both the results path and `"/"`, since `app/page.tsx:111` renders `currentStage`.

**A checkbox component does not exist.** `components/ui/` holds exactly six files and none is a checkbox. Following the codebase's own habit — raw styled inputs rather than new primitives — this is a plain `<input type="checkbox">` with the existing `border-input` styling, wired to `TableRow`'s free `data-[state=selected]` hook.

#### Clause 11e — `/results` after the round is finalized

Once `Instance.currentStage` is past `WRITTEN`, `/results` stops being a selection surface and becomes a revisit surface. **The checkbox column, the demographic panel and the entire finalize control disappear**, replaced by a plain "Written round finalized" banner in their place. **The ranked table, both filters, the variance and count columns, and `/results/[applicantId]` all stay exactly as they were** — the reason to come back to this page after finalizing is to read it, and an admin checking why someone was cut should not have to reconstruct the ranking from a database.

**Determined server-side, in `results/page.tsx`, from the same `currentStage` read the hub row already performs.** Not a client-side conditional: the client's copy of the stage is whatever was true when the payload was built, so a second tab left open across a finalize would keep offering checkboxes over stale state. The page decides, and the client component receives a `selectable: boolean` it cannot override — the checkbox column is not rendered rather than rendered-and-disabled, so there is no disabled control to re-enable in devtools and no selection state to submit.

**`finalizeWritten` re-checks it too, and refuses.** The same doctrine as `validateScore` and `openDraft`: a server action is a POST endpoint reachable without the form, and "the page did not render the button" is not a constraint on what arrives. The check mirrors `preview/actions.ts:19-32`'s `openDraft`, which refuses a commit on an instance whose `importCommittedAt` is already set — same shape, same reason. The refusal is a returned error naming the state, not a thrown one, since a second tab submitting a stale form is a user-reachable situation rather than an impossible one.

**Which stage values count as "past WRITTEN" is stated rather than inferred.** `InstanceStage` has four values (`WRITTEN`, `FIRST_ROUND`, `SECOND_ROUND`, `COMPLETE`), and the gate is `currentStage !== WRITTEN` rather than an ordering comparison — an enum is not an ordered type in TypeScript, and a `>` over string values would work by alphabetical accident and break the first time a value is added.

**Walkthrough:** after finalizing in the step below, reload `/results`. Confirm the checkboxes, the panel and the finalize control are gone and the banner is in their place; confirm the ranking, both filters and an applicant profile all still work. Then open a second tab *before* finalizing, finalize in the first, and submit the stale form in the second — it must be refused with a message, not throw and not write a second set of `Decision` rows.

**Walkthrough (selection, before the above):** check five applicants and watch the panel move; confirm the weighted column sums to the headcount in both columns. Check an applicant who selected two ethnicities and confirm 0.5 lands in each. Open the confirm panel, read the counts, confirm the zero-review applicant is named. Cancel. Finalize. Then verify in the database: `Decision` count equals the pool count, advanced applicants are `ACTIVE` / `FIRST_ROUND`, everyone else `REJECTED` / `WRITTEN`, and one `AuditLog` row exists. Then run finalize again and confirm the upsert makes it a no-op rather than an error.

---

### Slice 5 — PRD status line

`v1.7, Phase 0-3 complete, Phase 4 next` becomes Phase 4 complete, in its own final commit, and only after the whole BUILD_PLAN gate has passed by hand. A status line claiming an unverified phase is the one PRD edit that must not lead the code.

---

## Files

**New**
- `lib/results.ts`, `lib/results.test.ts` — FR-10's arithmetic and cases 1–13
- `lib/demographics.ts`, `lib/demographics.test.ts` — §10.7 fractional counting
- `prisma/seed/reviews.ts` — assignment and score generation
- `prisma/migrations/<ts>_rubric_category_min_points/migration.sql`
- `prisma/migrations/<ts>_drop_applicant_status_advanced/migration.sql`
- `app/instances/[id]/results/` — `page.tsx`, `results-table.tsx` (client), `actions.ts`
- `app/instances/[id]/results/[applicantId]/page.tsx`

**Modified**
- `prisma/schema.prisma` — `RubricCategory.minPoints`, `ApplicantStatus`
- `lib/rubric.ts` + test — `minPoints` on the input type, the invariant, `rubricTotal` as a range
- `lib/review.ts` + test — `validateScore` takes the floor
- `app/instances/[id]/rubric/` — `page.tsx`, `rubric-builder.tsx`, `actions.ts`
- `app/r/[instanceId]/actions.ts` (line 144's select), `a/[assignmentId]/page.tsx` (line 97's select), `a/[assignmentId]/score-card.tsx`
- `app/instances/[id]/page.tsx` — the hub row
- `prisma/seed.ts`, `prisma/seed/roster.ts` (rubric to 1–4, descriptions reworded), `prisma/inspect.ts`
- `PRD.md` — §5's `RubricCategory` block loses its PLANNED comment; §10 decisions 42–44; FR-10 and FR-11 sentences; status line last

**Reused rather than rewritten:** `completionOf` (`lib/review.ts:53`), `planShape` / `prepare` / `targetFor` (`lib/assignment.ts`), `isChecked` / `checkedOptions` / `checkedCount` / `freeTextValues` (`lib/field-groups.ts`), `visibleFieldIds` / `projectApplicantData` / `resolveField` / `buildApplicantView` (`lib/fields.ts`, `lib/review.ts`), `createRng` (`lib/rng.ts`), `requireInstance` (`lib/auth.ts`), the `AuditLog` write shape from `rubric/actions.ts:77-86`, the `CommitForm` / `useActionState` shape from `preview-controls.tsx:71-103`, the URL-filter and chip idiom from `assignment-controls.tsx:259-305`, the `<Table>` primitives and the `<dl>` stat grid. **No new dependency.** Note that Zod is not in this project and validation lives in tested `lib/` modules — `lib/results.ts` and `lib/demographics.ts` follow that.

**One optional cleanup, flagged rather than folded in:** `prisma/inspect.ts:149` re-derives the checked predicate inline as `(row[member.id] ?? "") !== ""`, which accepts whitespace-only where `isChecked` rejects it — the exact drift §10.7 requires a single shared helper to prevent. It is a diagnostic script, not a surface, so it is a one-line fix in slice 2 if you want it and a deliberate omission if not.

---

## Verification

```bash
npx prisma migrate dev --name rubric_category_min_points
npx prisma migrate dev --name drop_applicant_status_advanced
# restart next dev here — step 4 of slice 1, not a footnote
npm run verify
npm run seed
npm run seed:inspect
npx tsx prisma/checks/unique-constraints.ts
npm run dev
```

Then the four walkthroughs at the end of slices 1–4, in order, in a browser. Four gate steps that cannot be satisfied by reading the page, called out because they are the ones most likely to be skipped:

1. **The hand calculation** (slice 3). Check the ten fixture applicants against the table in this document, on paper. Recomputing them with the same code is not the check BUILD_PLAN asked for.
2. **A `points=0` POST to `saveScore` after the migration** (slice 1). The segmented row not drawing a 0 says nothing about what a POST can carry, and decision 40's whole point is that the stored number must be one the reviewer could have chosen.
3. **The weighted-sums-to-headcount invariant, read off the live panel** (slice 4), on a selection containing a multi-checker and a non-responder. The unit test asserts it on plain objects; this confirms the page feeds it the right objects.
4. **Submitting finalize a second time** (slice 4), in both of its forms, because they exercise different guards. A retried submit *within* the same finalize is what the `upsert` makes idempotent — the `UNIQUE (applicantId, stage)` constraint is what decision 41 says is "there to hold one of", and a flaky connection is how a real admin meets it. A submit from a **stale second tab opened before the round was finalized** is what clause 11e's server-side re-check refuses, and it is the only way to reach that path once the page stops rendering the button.

Before each commit, re-read the clauses that slice claims and tick them against the diff — the ledger at the top of this file, not a paraphrase of it.
