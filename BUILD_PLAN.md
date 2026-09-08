# Build Plan — Spark SC Recruitment Platform

Companion to `PRD.md`. This is the execution plan for building it with Claude Code.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router) + TypeScript | Server components let field visibility be enforced server-side, which §6 of the PRD requires. One deployable unit. |
| Database | Postgres (Neon or Supabase free tier) | JSONB for `Applicant.data`, real constraints for the uniqueness rules that keep votes clean. |
| ORM | Prisma | Schema file doubles as documentation. Migrations are legible to whoever inherits this. |
| Styling | Tailwind + shadcn/ui | The reviewer dashboard needs to be usable on a phone with no training. Do not hand-roll a design system. |
| Auth | Custom, minimal | No provider needed. Instance password + reviewer round code, per PRD §8. |
| Hosting | Vercel | Push to deploy, free tier is sufficient at 160+ applicants and 30 reviewers. |
| Testing | Vitest | Two algorithms carry real logic and need real tests. |

**Set up hosting and database under a club-owned Google account, not your personal one.** This is the single highest-leverage succession decision and it takes ten minutes on day one. Retrofitting it after you graduate is painful.

## 2. Working method with Claude Code

The failure mode on a project this size is not Claude writing bad code. It is Claude writing plausible code for a subtly wrong spec, three phases deep, before anyone notices. The whole method below is aimed at that.

**Vertical slices, not horizontal layers.** Do not build all the models, then all the API routes, then all the UI. Build CSV import end to end and confirm it works before touching reviewer assignment. Each phase below ships something you can click.

**Plan before code, every phase.** Start each phase in plan mode. Ask for the plan to be written to `plans/phase-N.md`, read it, correct it, then implement. Claude's plan surfaces its assumptions where you can catch them, which is much cheaper than catching them in a diff.

**One phase per session.** Run `/clear` between phases. A context window carrying three phases of history produces worse work than a clean one carrying good docs. The docs are what persist; the conversation is not.

**Verify the logic yourself, do not trust the tests it wrote.** For the assignment algorithm and the pass state machine, write the test cases as prose first, hand them over, then read the resulting tests to confirm they check what you said. Claude writing both the implementation and its tests from the same misreading yields green tests and wrong behavior.

**Commit per slice.** Small commits with real messages. When something breaks two phases later, you want to bisect, not archaeologize.

**Real data never enters the repo.** First commit includes the `.gitignore` from PRD §8. Build against a synthetic seed set from the start.

### Useful setup

- `CLAUDE.md` at the repo root, committed. Draft provided separately.
- `/init` in a fresh repo to bootstrap it, then edit by hand. The auto-generated version is a starting point, not the artifact.
- A `plans/` directory, committed. It becomes the design-history record and is genuinely useful in a PM portfolio.
- One custom command is worth it: `.claude/commands/verify.md` running typecheck, lint, and tests in sequence, so "verify" is one word instead of three commands.
- Use a subagent for review at each phase boundary: a fresh instance reviewing the phase diff against `PRD.md` catches spec drift that the implementing context is blind to.

## 3. Phases

Each phase lists what to build, the prompt shape that works, and a verification gate. Do not start a phase until the previous gate passes.

### Phase 0 — Foundation
**Build:** Next.js + TypeScript + Tailwind scaffold. Prisma connected to Postgres. Full schema from PRD §5 as one migration. Seed script generating 150 synthetic applicants, 30 reviewers (8 Sparklets), and a 4-category rubric. `.gitignore`. `CLAUDE.md`.

**Prompt shape:** Paste PRD §5 verbatim. Ask for the Prisma schema with every unique constraint and enum spelled out, plus the seed script. Ask it to explain any place it deviated from the model as written.

**Gate:** `prisma migrate dev` runs clean. Seed populates. You can query a synthetic applicant and see its JSONB `data` with field IDs resolving against the `Field` table.

---

### Phase 1 — CSV import and field mapping
**Build:** FR-1 through FR-5. Instance list, CSV upload, mapping table, preview with duplicate and blank detection, rubric builder, instance save with hashed password.

**Prompt shape:** Give it PRD §7.1 and a synthetic CSV whose headers mirror the real one in shape (37 columns, several with question-length headers, several mostly empty). Emphasize that email and display name are promoted out of `data` into their own columns.

**Gate:** Upload the synthetic CSV, map fields, set a rubric, save the instance with a password, reopen it with that password. Confirm the password is stored as a hash. Confirm a CSV with two identical emails is caught at preview.

**Watch for:** Header text with newlines, curly quotes, and 200+ characters. The real headers include full essay prompts. Test with those before you trust it.

---

### Phase 2 — Assignment algorithm
**Build:** FR-6 through FR-8. Reviewer roster with bulk paste, auto-assignment, feasibility precheck, manual override.

**This is the phase to slow down on.** Write your test cases first, in prose, before Claude writes anything:

**These cases assume the PRD v1.4 pool definition — 5% of assignment *slots*, not 5% of applicants.** Every applicant is assigned; ~22 of them are short exactly one reviewer. The older "7 applicants held with zero reviewers" model is gone, and any number derived from it is wrong.

```
30 reviewers, 8 Sparklets, 150 applicants
  → 450 total slots, pool = floor(0.05 × 450) = 22 (NOT 23 — floor, not round)
  → all 150 applicants assigned: 128 with 3 reviewers, 22 with 2
  → 428 slots filled, load ceiling ceil(450/30) = 15, no applicant with 2 Sparklets
  → the 22 short applicants are 22 DISTINCT applicants, never one applicant short two

30 reviewers, 15 Sparklets, 150 applicants
  → 15 non-Sparklets × ceil(450/30) = 225 capacity against a 278-slot
    non-Sparklet minimum. 225 < 278, so the check FAILS and does not generate
  → offers "allow uneven Sparklet load" as an ACTION, not just prose (decision 2)
  → taking it generates with the one-Sparklet rule still intact and a relaxed
    ceiling of ceil(278/15) = 19, average 18.5, against the 15 the unrelaxed
    rule would give. Both numbers shown before confirming

3 reviewers, 0 Sparklets, 10 applicants
  → 30 slots, pool = max(floor(1.5), 3) = 3
  → 7 applicants get all 3 reviewers, 3 applicants get 2

2 reviewers, 2 applicants
  → target is min(3, 2) = 2, so 4 slots, floor(0.2) = 0, minimum 3,
    but pool caps at applicant_count = 2
  → the exactly-one-short rule beats the minimum-3 rule; no applicant loses two
  → each applicant ends with 1 reviewer, neither with 0

31 reviewers, 0 Sparklets, 150 applicants
  → 450 total slots, pool = 22, 428 assigned
  → 428 across 31 does not divide evenly. No reviewer exceeds
    ceil(450/31) = 15

Regeneration after manual overrides exist
  → warns, and preserves MANUAL assignments unless explicitly told otherwise
  → a preserved MANUAL assignment counts against its reviewer's load ceiling
    and against the one-Sparklet-per-applicant rule
  → an applicant with 1 MANUAL assignment still receives 2 generated slots;
    it is not excluded from generation
  → preserved MANUAL assignments that already exceed a ceiling, or that already
    put 2 Sparklets on one applicant, are reported and left in place, never
    silently removed to satisfy the constraint
```
The roster is a smaller piece but it is where the round's data starts, so its cases go over too:

```
Roster bulk paste (FR-6)

Paste with trailing blank lines and a line of only spaces
  → those lines dropped, no empty reviewer rows created

"Mary Anne Chen"
  → first name "Mary Anne", last name "Chen". Split on the LAST space, not the first

"Cher"
  → cannot split. Lands in the confirmation queue, does not import with a
    blank last name

"Alex Kim" appearing twice in one paste
  → both import, both flagged for confirmation. Not deduplicated silently;
    two reviewers may share a name and §5 puts no unique constraint on it

A 30-line paste with no Sparklets marked
  → all 30 import as non-Sparklet, scoped to the round being staffed
```

**Prompt shape:** PRD §7.2 plus the assignment cases above as the spec for lib/assignment.ts, and the roster cases as the spec for lib/roster.ts. Ask for the algorithm as a pure function with no database access, tested in isolation, and a thin persistence layer around it. Pure functions are the part you can actually verify.

Gate: All cases pass, and you have read the tests to confirm they assert what you asked. Load distribution printed to console and eyeballed. Feasibility failure message is one a non-technical successor could act on. Paste a roster containing a blank line, a single-word name, and a duplicated name; confirm the blank is dropped and the other two reach the confirmation queue rather than importing.

---

### Phase 3 — Reviewer dashboard, written round
**Build:** FR-9. Round selection, name selection with access code, assigned list with completion state, applicant detail with rubric alongside, autosave scoring, return-to-pool, claim-from-pool.

**Prompt shape:** Lead with the constraint: this is used by 30 people who have never seen the tool, half on phones, once. Every extra tap is a review that does not get finished. Give it PRD §6 and require server-side field filtering rather than client-side hiding.

**Gate:** Open on your actual phone. Score an applicant. Kill the network mid-review and confirm nothing is lost. Confirm that a request for a hidden demographic field returns nothing from the server, not just nothing on screen. Have one board member who has never seen it complete a review without instructions.

---

### Phase 4 — Written results and selection
**Build:** FR-10, FR-11. Ranked results with variance, high-variance and incomplete filters, admin review of any applicant, selection with live demographic panel, finalize to First Round.

**Prompt shape:** Be explicit that variance is computed across the three reviewer averages, and that applicants with fewer than 3 reviews are flagged rather than silently averaged over 2.

**Gate:** Ranking matches a hand calculation on ten synthetic applicants. Demographic panel updates live as you check boxes. Finalizing writes Decision rows and the First Round tab populates with emails.

**Milestone: this is a shippable product.** If time runs short, a working written round beats three half-finished ones. Deploy it and get feedback from a real reviewer cohort before building further.

---

### Phase 5 — First round
**Build:** FR-12 through FR-15. Two-sheet import with the reconciliation flow, first-round reviewer dashboard, yes/no voting, yes-percentage ranking, selection.

**Prompt shape:** The reconciliation cascade in FR-13 is the whole point of this phase. Spell out all four tiers and require that nothing imports under a fuzzy match without a human confirming it. Give it deliberately messy test data: "Cici Fang" vs "Cecilia Fang", trailing whitespace, a middle initial appearing in one file only.

**Gate:** Import a scores file where three names are deliberately wrong. Confirm all three land in the unresolved queue rather than being guessed at. Confirm yes-percentage excludes skips from both numerator and denominator, and that raw counts display alongside.

**Done.** The gate passed on `prisma/fixtures/s26-1r-scores.csv`: Mia Chen, Cecilia Fong and Bartholomew Quiggleston all landed unresolved with no "did you mean", and `prisma/checks/reconciliation-fixture.ts` asserts that on every run. Built as eight slices, each a commit, with sixteen §10 decisions (50–65) recorded ahead of the code they govern.

Two things the phase found that the requirement did not contain. **Decision 45's fuzzy threshold rejected its own worked example** — whole-string Jaro-Winkler scores `cici fang`/`cecilia fang` at 0.842 and `mia chen`/`nia chen` at 0.917, so the pair that had to match scored *lower* than the pair that must not, and no threshold separates them; decision 52 replaced the comparison basis. And **a nickname is less similar to its own given name than two different people's names are to each other**, which is why decision 53 makes a single fuzzy candidate a proposal rather than a commit.

Three defects reached the owner's browser that neither the suite nor the clause ledger could see: a rubric edit silently unmapping a staged import (decision 61), a collision the UI reported but gave no way to resolve, and an import that replaced twelve rows while saying "Import". All three were correct pure logic assembled into an unusable surface — see the Testing note in `CLAUDE.md`.

---

### Phase 6 — Second round and passes
**Build:** FR-16 through FR-18. Full-profile reviewer view, COI flagging, pass creation, vote submission, resolution state machine, pass grid dashboard.

**The state machine is the hardest thing in the project.** Same discipline as Phase 2: write the cases first.

```
Pass 1, 11 reviewers, applicant A: 11 YES submitted
  → SPARKLET, absent from pass 2

Pass 1, applicant B: 11 NO
  → REJECTED, absent from pass 2

Pass 1, applicant C: 7 YES, 4 NO
  → stays ACTIVE, appears in pass 2 with votes cleared

Applicant D: 2 reviewers have COI, other 9 all YES
  → SPARKLET (COI counts as SKIP, excluded from unanimity)

Applicant E: all 11 reviewers have COI
  → pass 1 resolution = NEEDS_ADMIN, flagged for admin. NOT auto-advanced.
  → E stays ACTIVE and DOES appear in pass 2. NEEDS_ADMIN describes the pass,
    not the applicant; membership is recomputed from status at each creation.

Pass 1 closed with applicant F having 5 of 11 votes
  → F stays ACTIVE, carries to pass 2

Reviewer added between pass 1 and pass 2
  → votes in pass 2 only; pass 1 unaffected

Admin manually rejects G during pass 1
  → REJECTED immediately, absent from pass 2

"Close second round" with H unresolved in the final pass
  → writes NEEDS_ADMIN on H's FINAL pass row; H's status stays ACTIVE
  → H appears in FR-19's Unresolved group, found by that row and never by status
  → running the close twice changes nothing the second time

"Close second round" when no pass was ever created
  → blocked. Otherwise every applicant is unresolved with no pass row to
    find them by, and FR-19 renders an empty group over a live pool.
```

**Prompt shape:** PRD §7.4 in full including the edge case table, plus the cases above. Ask for the resolution logic as a pure function taking a vote set and returning a status, tested independently of the database.

**Gate:** Every case passes and you have read the tests. Run a full simulated second round against seed data: three passes, mixed votes, a COI, a manual rejection. Confirm the pass grid matches what you expect at each step.

**Done.** The gate ran against the advanced seed — two passes rather than three, because the second closed the round with 29 applicants still undecided and a third would have decided nothing new. Verified by clicking: pass creation fixing membership at 30, a vote landing in the open pass, a COI flagged *after* that vote deleting it (the row went `Yes 1/0/0` → `Skip 0/0/1`), an admin lifting that COI and the reviewer returning **blank rather than to their old Yes**, a manual reject removing one applicant from the pool, pass 2 opening with 29, and the close stamping `NEEDS_ADMIN` on the final pass only — pass 1's nulls untouched. Built as twelve slices with twenty §10 decisions (66–85).

**What §7.4 turned out not to say.** Decisions 66–85 are all answers to questions the requirement raised and left open; the ones that changed the build rather than merely recording it were **72** (a close writes no resolution), **73** (`NULL` *or* `CARRIED` at close-round, or a mixed final row is invisible to FR-19), **83** (the vote response names no outcome — an applicant resolves only when every eligible reviewer has submitted, so "this applicant is now a Sparklet" tells the last voter how all the others voted), and **84**, which is the one the requirement actively got wrong: locking the second-round roster at `currentStage` created a state with no way out, since FR-15's finalize sets that stage without requiring a roster, and decision 79 then blocked the pass that decision 66 blocked the reviewers for. Moving the lock to first-pass-creation closed it.

**Five defects reached the browser that neither the suite nor the clause ledger could see**, all in surfaces rather than logic — the same pattern Phase 5 recorded. The reviewer list told reviewers voting had not opened while a pass was open, because the sentence was a fixed string and the list had never learned passes exist. Two applicants named "Diego Hoffmann" were indistinguishable on the grid and the reject confirm — the spreadsheet's core defect arriving at the presentation layer *after* the data model correctly refused it, fixed by rendering the written round's `Applicant N` handle beside the name. And two confirms outlived what they confirmed: closing pass 1 then creating pass 2 came back with "Close pass 2?" already expanded, one stray click from closing a pass just created, and the grid's removal panel stayed open offering to remove a conflict it had already removed. Both were one root cause — confirm state that survives a revalidation and is never reconciled against the fresh props.

**Three things the gate could not reach, stated rather than implied.** The all-COI carry-forward (17o, 17v) needs twelve reviewer sign-ins to produce through the UI; `lib/passes.test.ts` case E already covers the resolution itself, so only the wiring was checked at the database — a real `NEEDS_ADMIN` row, the exact query `createPass` builds membership from, and a rejected applicant as the negative control. Close-round idempotency (17r) is reachable only from a stale tab, and the browser re-renders fresh; what was verified is the mechanism — after the first run, zero rows match `UNRESOLVED_AT_CLOSE`, one audit row exists, and no `OPEN` pass remains in a `COMPLETE` instance. And **decisions 84 and 85 were verified logically but never clicked**: both govern the window before the first pass exists, and that window closed the moment the gate created pass 1. Reopening it would have meant destroying the pass, which is worse than the gap.

**One correction to decision 83, recorded as 83a.** It said a resolved applicant "simply leaves their list". That holds for `SPARKLET` and `REJECTED` — the rejected applicant vanished from the reviewer's list on the spot. It does **not** hold for `CARRIED`: that applicant stays `ACTIVE`, stays on the list, and their vote control reads settled. Confirmed by setting a row to `CARRIED` and looking. 83a keeps 83's reasoning intact — settled-but-still-present reveals that a mixed result occurred and nothing about who voted which way, which is the boundary 83 was protecting — and narrows only the overclaim of uniform disappearance.

---

### Phase 7 — Final dashboard and export
**Build:** FR-19, FR-20. Sparklet and Rejected views with full profiles, funnel demographics across all stages, JSON and CSV export.

**Gate:** Export, delete the database, reimport from the export, confirm the instance is intact. That round trip is the actual test of FR-20.

**Done.** The gate ran in its strong form: the whole `public` schema dropped and re-migrated, not one instance deleted, then restored from the exported file alone. Zero differences across all twenty-four tables, and `S26 Gate Run` — the second instance that had been sitting beside the seed — was gone afterwards, which is what actually proves the export depends on nothing outside its own instance. The restored instance opened with its original password and its original round access codes, both of which exist in the file only because decision 86 put them there. Built as nine slices with six §10 decisions (86–91).

**The export needed a contract before it needed code**, and settling it first is what kept the phase short. Four properties, each carrying a decision: every id written back verbatim (**88**), because `Applicant.data` is keyed by `Field.id`, `InterviewImport.mapping` embeds `InterviewCategory` ids in its role strings, and `AuditLog.entityId` holds ids from every table with no foreign key to follow — the third of those is unremappable, which is what makes new-ids unsound rather than merely expensive. Every column emitted with nulls explicit, so `PassApplicant.resolution` stays five-valued and `NEEDS_ADMIN`, `CARRIED` and `NULL` cannot collapse. Credential hashes included (**86**), a deliberate exception to CLAUDE.md rule 4 that the rule now names. And reimport as a verification script rather than a product surface (**87**). With ids and timestamps written explicitly, *nothing* is expected to differ — so "intact" is an exact comparison with no exception list, which is the only kind a real regression cannot hide inside.

**Two guards in `lib/export.test.ts` are worth more than the round-trip cases.** `EXPORT_TABLES` is asserted column-for-column against the generated client's `<Model>ScalarFieldEnum` **in both directions** — the reverse direction is the one that bites, because a test that only walks tables the manifest knows is blind to a model added to the schema, and that model would export as nothing while the round trip still passed. The write order is separately asserted against the foreign-key graph, including the three edges no foreign key expresses.

**What FR-19 and FR-20 turned out not to say.** FR-19 defines Unresolved by the final pass row "never by `Applicant.status`", and decision 70 has an admin write a `Decision` row when they resolve one of them — read together those contradict, because an admitted applicant then satisfies both the Sparklet predicate and the Unresolved one and appears twice. **Decision 89** adds the missing clause: the group is `NEEDS_ADMIN` on the final pass **and** no `Decision` at `stage = SECOND_ROUND`, and the pass row is deliberately left alone, because the pass genuinely failed to decide them and a later admin decision is not a correction of that. The gate's last round trip carried two applicants in exactly that state — `SPARKLET` status, `NEEDS_ADMIN` pass row — and restored both intact. FR-19 also named no surface for that decision at all; `plans/phase-6.md` had deferred it here, and it would otherwise have been a requirement with a group nobody could empty.

**The finding that justifies the whole gate is the one no automated check could reach.** The CSV bytes were valid UTF-8 from the builder through the round trip — `Róisín` was `C3 B3` at every layer, 786 unit tests passed, and the HTTP response carried `charset=utf-8`. Excel opened the file and showed `RÃ³isÃ­n`. The charset parameter governs the browser and does not survive the file being written to disk, so Excel falls back to the system codepage; a UTF-8 BOM is the only in-band signal it honours. **Nothing short of opening the artifact in the application the club actually uses would have found it**, which is precisely what BUILD_PLAN's gates are for and precisely what an owner clicking through catches that a suite does not. The fixture now seeds one applicant named `Róisín "Ro" O'Brien, Jr.` — a comma, a doubled quote, an apostrophe and a non-ASCII character — so the quoting and the encoding are both permanently exercised rather than assumed.

**Three gate steps named things that did not exist, and each correction is recorded in `plans/phase-7.md` rather than quietly fixed.** The step asking for essays with embedded newlines in the CSVs: there are none, because those files carry identity, status, scores, decisions and emails and no free text. Its replacement, which said to rename an applicant on `/results/[applicantId]`: there is no applicant rename control anywhere in the application. And `prisma migrate reset --skip-seed`: no such flag exists in Prisma 7, and since `prisma.config.ts` declares a seed, a reset would have recreated the instance and the restore would have collided with it under decision 88's no-merge rule — the gate would have proven nothing while appearing to pass.

**One process failure worth recording, because it is about method rather than code.** From slice 4 onward the rendering checks were run with a session token minted by hand from `SESSION_SECRET`, rather than through a browser, and without saying so. The server responses were genuine, but curl runs no JavaScript and paints nothing — so every "renders correctly" claim in slices 4 through 7 covered server-generated HTML and nothing else, and a real credential sat in the transcript for hours. It was also the second failure of the same kind: the earlier claim that "the route is live on your server" came from cookieless curl probes that `proxy.ts` short-circuited before routing, so they could not have shown that and a known-absent route returned the identical 307. **A check that cannot fail is not a check**, and the browser is not an optional instrument for a requirement whose artifacts are opened by people. `SESSION_SECRET` was rotated; the mojibake was found the moment a human opened the file.

---

### Phase 8 — Hardening and handoff
**Build:** Rate limiting on password and access code endpoints. Audit logging per PRD §8. ~~Archive-and-purge~~ — built, then removed by decision 109, which withdrew §8's retention requirement. `ARCHITECTURE.md`, `ADMIN_GUIDE.md`, `REVIEWER_GUIDE.md` (one page, screenshots, no jargon). Demo instance with synthetic data for training.

**Gate:** A board member who has never used the tool runs a complete mock cycle on the demo instance, start to finish, using only `ADMIN_GUIDE.md`. Every place they get stuck is a documentation bug. This is the real succession test and it is worth doing properly.

---

### Phase 9 — what using it found
**Build:** PRD decisions 110–118, then the changes they specify. Four of them reverse or amend standing requirements, four settle questions nothing had asked, and five small defects ride along without a §10 entry. Everything here came from the owner clicking through a built product rather than from review — which is the pattern Phases 3, 5, 6 and 7 each recorded separately and which this phase exists because of.

**Slices, one per session:**

- **9.0 — the decisions, no code.** §10 gains 110–118. FR text amended in §5, §6, §10.7, FR-2, FR-3, FR-4, FR-6, FR-8, FR-9, FR-10, FR-14, FR-16 and §7.4's clause index. Forward pointers on decisions 22, 27, 32, 34, 39, 40, 62, 74, 80, 82, 83, 83a, 84 and 108. **Gate:** the owner reads them and approves. Nothing is built until they do, because four of them reverse reasoning that is currently correct in the code.
- **9.1 — the second round becomes visible.** Decisions 111 and 112, the resolving-vote 404, and red/green on FR-18's grids. The 404 and the reversal are one root cause: the profile queries with `SECOND_ROUND_POOL` and 404s when the vote the reviewer just cast removes them from it. Widening the *list* alone leaves the bug in place. `SECOND_ROUND_POOL` itself does not move — it is clause 17b's pass-membership predicate and the reviewer's cohort is a different question.
- **9.2 — first-round voting moves to the page.** Decision 113, plus a search box, plus folding the hand-inlined pool predicate in `first-round/actions.ts` back onto `FIRST_ROUND_POOL`.
- **9.3 — two schema changes.** Decisions 114 (`RubricLevel`, dropping `RubricCategory.description`) and 116 (`Assignment.suspectedAiUse`). Two migrations. **Restart `next dev` after each, and confirm the port actually freed** — the Phase 3 trap and its `taskkill` corollary both apply here, and `npm run verify` stays green through either failure.
- **9.4 — roster and pool.** Decisions 115 and 117. Two guards on the roster page that must stay distinct, and a fourth verb on FR-8 that must not become a second unassign.
- **9.5 — admin surfaces.** Decision 118, the moved-on filter on both results pages, the mapping screen's two tweaks, a real back button, and the ethnicity truncation.

**Gate:** each slice has its own, listed in `plans/phase-9.md`. The phase gate is that the two guides are brought back into line with the screens — `REVIEWER_GUIDE.md`'s screenshots r4–r8 were taken from the first- and second-round surfaces this phase rewrites.

**Sequencing against Phase 8.** Slice 7 of Phase 8 — a board member running a full mock cycle from `ADMIN_GUIDE.md` alone — is still open, and it should run **after** Phase 9, not before. Running it first would test the tool against documentation Phase 9 then invalidates, and would spend the one genuinely scarce resource in this project (a board member who has never seen it) on screens that are about to change.

**One census worth keeping.** Before decision 114's migration was written, `RubricCategory.description` was counted across every instance: 17 of 18 rows non-null, none whitespace-only. But 12 were the same four strings the seed writes and regenerates, and 4 more were keyboard mash on a walkthrough instance. **One row held prose a person wrote for its purpose.** The backfill-into-the-top-value rule is kept anyway, because the next cycle's admin will write descriptions that are real — but the number is recorded here so nobody later mistakes a careful migration rule for evidence that a lot was at stake.

## 4. Sequencing and time

Phases 0 through 4 are the shippable core. Phases 5 through 7 extend it. Phase 8 is what makes it survive you.

If the next recruitment cycle is close, ship through Phase 4 and run the written round on the platform while first and second rounds stay on the spreadsheet for one more cycle. A partial migration that works beats a full migration that is not ready. It also gives you a real usage signal before you build the harder half.

Rough effort, assuming you are reviewing carefully rather than accepting diffs: Phase 0 half a day, Phase 1 a day, Phase 2 a day (mostly verification), Phase 3 a day and a half, Phase 4 a day, Phase 5 a day and a half, Phase 6 two days, Phase 7 half a day, Phase 8 a day.

## 5. What makes this a portfolio project

The code is not the interesting part; a hiring manager will not read it. Three things are worth documenting as you go:

**The identity problem.** "The previous system keyed applicant records by name across eight sheets. Any typo silently orphaned a record and no one could tell. I moved to system-generated IDs with a reconciliation flow at every import boundary." That is a data-modeling instinct and it reads well.

**The feasibility constraint.** The Sparklet assignment rule is genuinely unsatisfiable under some rosters. Detecting that and surfacing a choice to the admin, rather than silently violating a constraint, is exactly the kind of judgment call PM interviews probe for. Write down how you found it.

**The bias controls.** Field-level visibility per round, variance-based flagging for re-review, demographic composition shown live during selection rather than audited after. These are product decisions with a rationale, not features.

Also worth keeping: your baseline measurements from §9 of the PRD, the `plans/` directory as design history, and the open-decisions list as evidence you identified ambiguity before building rather than after.
