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
| Hosting | Vercel | Push to deploy, free tier is sufficient at 153 applicants and 30 reviewers. |
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

```
30 reviewers, 8 Sparklets, 150 applicants
  → 143 assigned (7 in pool), 429 slots, load 14 or 15, no applicant with 2 Sparklets

30 reviewers, 15 Sparklets, 150 applicants
  → feasibility check FAILS, explains why, does not generate

3 reviewers, 0 Sparklets, 10 applicants
  → every reviewer on every assigned applicant, still respects the 5% pool

31 reviewers, 150 applicants
  → 429 slots / 31 does not divide evenly; loads differ by at most 1

Regeneration after manual overrides exist
  → warns, and preserves MANUAL assignments unless explicitly told otherwise
```

**Prompt shape:** PRD §7.2 plus those cases as the spec. Ask for the algorithm as a pure function with no database access, tested in isolation, and a thin persistence layer around it. Pure functions are the part you can actually verify.

**Gate:** All cases pass, and you have read the tests to confirm they assert what you asked. Load distribution printed to console and eyeballed. Feasibility failure message is one a non-technical successor could act on.

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
  → unresolved, flagged for admin. NOT auto-advanced.

Pass 1 closed with applicant F having 5 of 11 votes
  → F stays ACTIVE, carries to pass 2

Reviewer added between pass 1 and pass 2
  → votes in pass 2 only; pass 1 unaffected

Admin manually rejects G during pass 1
  → REJECTED immediately, absent from pass 2
```

**Prompt shape:** PRD §7.4 in full including the edge case table, plus the cases above. Ask for the resolution logic as a pure function taking a vote set and returning a status, tested independently of the database.

**Gate:** Every case passes and you have read the tests. Run a full simulated second round against seed data: three passes, mixed votes, a COI, a manual rejection. Confirm the pass grid matches what you expect at each step.

---

### Phase 7 — Final dashboard and export
**Build:** FR-19, FR-20. Sparklet and Rejected views with full profiles, funnel demographics across all stages, JSON and CSV export.

**Gate:** Export, delete the database, reimport from the export, confirm the instance is intact. That round trip is the actual test of FR-20.

---

### Phase 8 — Hardening and handoff
**Build:** Rate limiting on password and access code endpoints. Audit logging per PRD §8. Archive-and-purge. `ARCHITECTURE.md`, `ADMIN_GUIDE.md`, `REVIEWER_GUIDE.md` (one page, screenshots, no jargon). Demo instance with synthetic data for training.

**Gate:** A board member who has never used the tool runs a complete mock cycle on the demo instance, start to finish, using only `ADMIN_GUIDE.md`. Every place they get stuck is a documentation bug. This is the real succession test and it is worth doing properly.

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
