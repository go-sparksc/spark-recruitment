# Phase 7 — Final dashboard and export (FR-19, FR-20)

**Gate (BUILD_PLAN Phase 7):** "Export, delete the database, reimport from the export, confirm the instance is intact. That round trip is the actual test of FR-20."

---

## Context

Phase 6 ended with the second round closable: passes, votes, resolutions, the FR-18 grid, and a "Close second round" action that stamps `NEEDS_ADMIN` onto the final pass's undecided rows and moves the instance to `COMPLETE`. Two things were deliberately left for this phase.

**Nothing renders the outcome.** An instance can be `COMPLETE` with no screen naming the Sparklet class. FR-19 is that screen.

**Nothing resolves a `NEEDS_ADMIN` applicant.** `plans/phase-6.md` says so explicitly — "Left to Phase 7: FR-19 renders the Unresolved group, and the admit/reject control belongs beside it. A deferral, not a hole." Decision 70 already fixes what that control writes; what it does *not* fix is how FR-19's grouping behaves afterwards, which is decision 89.

FR-20 is unbuilt in both directions. Nothing exports and nothing reads an export back.

**Phase 7 needs no migration.** Every column FR-19 and FR-20 read has existed since Phase 0 or Phase 4. This is the first phase since 0 where `prisma/schema.prisma` is untouched, which also means CLAUDE.md's restart-`next dev` rule does not apply here.

### What the database actually held when this was planned

Queried before planning, because the gate is written against it:

```
instance seed_s26_demo · currentStage COMPLETE
pass 1 CLOSED   1 REJECTED, 29 NULL
pass 2 CLOSED  29 NEEDS_ADMIN
PassVote rows 0 · ConflictOfInterest rows 1
```

The fixture is real: **29 applicants in `NEEDS_ADMIN` on pass 2** against 29 `NULL` on pass 1, which is exactly the pair a careless export collapses and the pair the round-trip check asserts on. But it covers only two of the three resolution states that matter. There is no `CARRIED` row anywhere, there are zero `SPARKLET` applicants, and there are zero `PassVote` rows — the Phase 6 gate's one vote was deleted by decision 68's COI flag and never recast. FR-19's New Sparklet group and its entire funnel would render empty against it, and `CARRIED` would round-trip untested. Slice 3 is the answer, and decision 91 is why it exists.

---

## The decisions this phase rests on

Recorded in PRD §10 ahead of the code, per the practice Phases 5 and 6 established. Summarised here; §10 is the text.

- **86** — the export carries `Instance.passwordHash` and `RoundAccessCode.codeHash`, a deliberate exception to CLAUDE.md rule 4, which is carved out to name it.
- **87** — FR-20's reimport is a verification script, not a product surface.
- **88** — a restore preserves every id verbatim; three id-bearing non-foreign-key carriers make any remap unsound.
- **89** — an admin-resolved applicant leaves FR-19's Unresolved group without their pass row being rewritten.
- **90** — CSV cells are written verbatim, RFC 4180-quoted, with no formula-injection prefixing.
- **91** — `npm run seed:passes` seeds a complete second round, reversing `prisma/advance.ts`'s stated position for the reason that position was stated.

---

## The round-trip contract

Settled before slices rather than discovered at the gate. This is the whole of FR-20's test.

### What is exported

`lib/instance-io.ts`'s `readSnapshot(prisma, instanceId)` returns one object holding **every row of every table belonging to the instance**, each table an array ordered by `id` ascending. Twenty-four tables, in the write order below. Every column of every row is emitted, **including nulls, emitted explicitly and never omitted**. A `formatVersion`, a `generatedAt`, and the table-and-column manifest the writing code knew about ride at the top level.

Two exclusions, stated rather than assumed:

- **`AuditLog` rows with `instanceId = null`** are out of scope. Those are §8's orphaned instance-deletion records; they belong to no instance by design, and an export claiming them would attach one instance's file to another instance's deletion. The instance's own audit rows are in.
- **The three CSVs are not part of the round trip.** They are lossy, human-facing derivatives — a decision row rendered with a name in it cannot reconstruct a `Decision`. The JSON is the restore format and the only thing the check reads back.

### What "intact" means

The check snapshots, serializes, deletes, restores, snapshots again, and compares **field by field over a fixed column manifest** — not a blind object diff.

| | |
|---|---|
| **Compared** | Every column of every row of all twenty-four tables, including `id`, `createdAt`, `updatedAt`, and every other timestamp. Ids are written explicitly (decision 88) and so are `createdAt`/`updatedAt` — both appear in Prisma's create input, verified in `generated/prisma/models/*.ts`, and `@updatedAt` only auto-fills when a value is omitted. |
| **Expected to differ** | **Nothing.** That is the point of decisions 88 and 86: with ids and credential hashes preserved, the round trip is an identity and the comparison needs no exceptions. A comparison carrying expected drift is one a real regression can hide inside. |
| **The one contingency** | If Prisma 7 turns out to overwrite `@updatedAt` on create despite accepting it, that field becomes the single named exception — and the check reports it by table and row count rather than this plan asserting either way in advance. Slice 2's first run settles it. Nothing else is a candidate: there are no database-side defaults beyond `now()` and `cuid()`, and an explicit value suppresses both. |
| **Not a diff of JSON text** | Both snapshots come back through Postgres `jsonb`, which reorders object keys. Comparison canonicalizes first — object keys sorted, arrays ordered by `id` — so key order is never a difference, and the serialized form stays stable enough to `diff` by hand when something does break. |
| **Shape before content** | `parseExport` refuses a file whose table list or column manifest differs from what the running code knows. A column added in Phase 8 and silently dropped by an old restore is exactly the failure this prevents, and it is why nulls are emitted rather than omitted: a missing key is an error, never a default. |

### Write order

Foreign-key dependency order, twenty-four tables. `writeSnapshot` walks this list and nothing else decides ordering.

```
 1  Instance                  ← the CHECK on (importCommittedAt, importProposals)
                                is satisfied because both are written from the export
 2  FieldGroup
 3  Field                     ← groupId → FieldGroup
 4  ImportRow
 5  RubricCategory
 6  InterviewCategory
 7  RoundAccessCode
 8  Reviewer
 9  Applicant                 ← data is JSONB KEYED BY Field.id; step 3 must precede it
10  Assignment                ← Applicant, Reviewer
11  Score                     ← Assignment, RubricCategory
12  ReviewNote                ← Assignment
13  InterviewResult           ← Applicant
14  InterviewCategoryScore    ← InterviewResult, InterviewCategory
15  InterviewNotes            ← Applicant
16  InterviewImport           ← mapping embeds CATEGORY:<interviewCategoryId>; step 6 precedes it
17  InterviewImportRow        ← InterviewImport, Applicant (nullable match)
18  FirstRoundVote            ← Applicant, Reviewer
19  ConflictOfInterest        ← Applicant, Reviewer
20  Pass
21  PassApplicant             ← Pass, Applicant
22  PassVote                  ← Pass, Applicant, Reviewer
23  Decision                  ← Applicant
24  AuditLog                  ← Instance (nullable FK); entityId is a plain string
```

One transaction, `createMany` per table, in this order. Every CHECK and partial unique index in the model — `Field`'s group pairing, `InterviewImportRow`'s three, the one-EMAIL-column index, the one-OPEN-pass index — is satisfied for free, because the rows being written are the rows that already satisfied them.

### The four properties that have to survive, and where each is held

**`FieldGroup.key` survives unchanged.** `key` is an ordinary `String` column with no default, so nothing regenerates it on its own — the hazard is restore code that re-slugs from `displayName`. Two guards: `lib/instance-io.ts` never imports `slugify` or `uniqueSlug` from `lib/fields.ts`, and the check asserts `key` equality group by group. A third covers the class rather than the field: **every key of every applicant's `data` object must resolve to a live `Field.id` in the restored instance.** That is the property `key` immutability (decision 13) and id preservation (decision 88) both exist to protect, and it fails loudly if either slips.

**`PassApplicant.resolution` stays five-valued.** `SPARKLET`, `REJECTED`, `CARRIED`, `NEEDS_ADMIN` and `null` are five distinct outcomes, and `null` is the one an omit-nulls export destroys. The check asserts the **per-pass resolution histogram** before and after, not just row counts. Against the fixture as planned that reads `pass 1: {REJECTED: 1, null: 29}` / `pass 2: {NEEDS_ADMIN: 29}`; after Slice 3 it also carries `SPARKLET` and `CARRIED`. A restore that collapsed `null` into `CARRIED`, or dropped the pass-1 rows for having nothing to say, fails on the histogram before any field comparison runs.

**Ids.** Decision 88. No remapping exists to get wrong.

**The export is the whole instance.** The write order above is the full foreign-key graph, not the second-round tables. `Score`, `ReviewNote`, `Assignment` and the `WRITTEN` `Decision` rows are in it, as are the interview tables and any staging rows still in flight when the export is taken.

---

## Clause ledger

CLAUDE.md's mechanical guard, re-ticked against the diff before each commit.

### FR-19 — final dashboard

| # | Clause, verbatim | Slice | Ticked by |
|---|---|---|---|
| 19a | "All second-round applicants sorted into New Sparklet, Rejected, and Unresolved" | 5 | Pool is `stageReached = SECOND_ROUND`; three groups, all three rendered even when empty |
| 19b | "with full profiles accessible" | 5, 6 | Each row links to the admin applicant profile, extended in slice 6 with interview and pass evidence |
| 19c | "Unresolved is every applicant whose row in the final pass carries `resolution = NEEDS_ADMIN`" | 5 | `lib/final.ts`, reading the highest-ordinal pass only |
| 19d | "covers both … every reviewer recused from and one who simply never reached a unanimous result" | 5 | Both land in one group; 19f is what tells them apart |
| 19e | "identified by that pass row, never by `Applicant.status`" | 5 | The query never filters Unresolved on status, and a test asserts an `ACTIVE` applicant with no `NEEDS_ADMIN` row is absent |
| 19f | "The underlying votes remain visible … eleven skips reads very differently from 7–4" | 5 | The `PassTally` from `lib/passes.ts` rendered inline per Unresolved row, plus a link to that pass's FR-18 grid |
| 19g | "Demographic breakdown of the Sparklet class against each preceding stage" | 7 | `lib/funnel.ts` over four cohorts, through the existing §10.7 `tallySelections` |
| 19h | Decision 70 / phase-6's deferral: an admin resolves a `NEEDS_ADMIN` applicant | 8 | Admit / reject on the Unresolved group; `Decision(ADMIN)` + status + `AuditLog`, one transaction |
| 19i | Decision 89: a resolved applicant leaves Unresolved without the pass row being rewritten | 8 | Predicate gains "and no `SECOND_ROUND` `Decision` row"; the pass row is untouched, and asserted so |

### FR-20 — export

| # | Clause, verbatim | Slice | Ticked by |
|---|---|---|---|
| 20a | "One-click export of the entire instance as JSON" | 1 | `/instances/[id]/export`, one primary download; "entire" is the twenty-four-table manifest |
| 20b | "plus per-stage CSVs" | 4 | Three further downloads on the same page |
| 20c | "(all applicants with scores" | 4 | One row per applicant, rubric categories as columns, per-reviewer averages and the aggregate |
| 20d | "decisions by stage" | 4 | One row per `Decision`, stage / outcome / actor / decidedAt, applicant named |
| 20e | "final class with emails)" | 4 | `status = SPARKLET`, name and email — the list FR-19's group renders, in the form the club mails from |
| 20f | "the club must never be locked into this tool" | 2, 3 | The round trip, which is the only evidence the JSON is actually complete |
| 20g | Decision 86: the file carries credential hashes, and rule 4 is carved out for it | 1 | Stated on the export page beside the download, not only in a comment |
| 20h | Decision 8's lesson: the export is a Route Handler, not a server action | 1 | A 150-applicant instance with five essays each exceeds Next's 1 MB server-action body limit — the same measurement that put `ImportRow` in the database |

---

## Slices

**Slice 0 — PRD first, no code.** §10 gains decisions 87–91, one commit each, with 86 landed ahead of them alongside its CLAUDE.md rule-4 carve-out. §7.5's FR-19 paragraph gains decision 89's predicate and names the resolve control; its FR-20 paragraph gains the round-trip contract. The Status line moves to Phases 0-6 complete. This file committed.

**Slice 1 — read and serialize.** `lib/export.ts` (pure: the table/column manifest, `canonicalize`, `serializeExport`, `parseExport`, `diffSnapshots`) with its tests; `lib/instance-io.ts`'s `readSnapshot`; the Route Handler at `app/instances/[id]/export/[artifact]/route.ts` serving `instance.json`; the `/instances/[id]/export` page and a hub row. Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` before writing the handler, and confirm `requireInstance` behaves in a Route Handler as it does in a page.

> **First act after this slice lands, before anything else in the phase:** download `instance.json` for `seed_s26_demo`. The database holds the Phase 6 gate's end state, it exists nowhere else, and Slice 3 overwrites it.

**Slice 2 — write and compare.** `lib/instance-io.ts`'s `writeSnapshot` in the order above, and `prisma/checks/round-trip.ts`: snapshot → serialize → delete the instance → parse → restore → snapshot → diff, asserting an empty diff, the per-pass resolution histogram, and every `Applicant.data` key resolving to a live `Field.id`. Same posture as the other checks — needs a seeded database, writes to it, cleans up after itself, not part of `npm run verify`. This is the slice that settles the `updatedAt` contingency.

**Slice 3 — a complete second round to test against.** Two files, splitting the way `npm run seed:advance` already splits. `prisma/seed/passes.ts` holds the pure builders — which applicants vote which way, where the COI and the all-COI applicant land, who is manually rejected — with no Prisma client, exactly as `prisma/seed/second-round.ts` does. `prisma/passes.ts` is the runnable entry point behind `npm run seed:passes`, holding the client, the transaction and the what-actually-landed summary, exactly as `prisma/advance.ts` does. The split keeps the fixture's shape testable without a database and the script the thin half.

Together they write what the FR-17 actions write: pass 1 with unanimous-yes applicants, unanimous-no applicants, a mixed set, a flagged COI and one all-COI applicant, plus a manual reject; then pass 2 over the survivors; then the close-round stamp. Yields all four `PassResolution` values, `NULL` rows, both `Decision` actors at `SECOND_ROUND`, and a non-empty Sparklet class. `advance.ts`'s comment updated per decision 91. Re-run Slice 2's check against it — the first run that covers `CARRIED` and `SPARKLET`.

**Slice 4 — the three CSVs.** `lib/export-csv.ts`: an RFC 4180 quoter (commas, quotes, and the newlines essays actually contain) and the three row builders, all pure and tested, served through the same Route Handler. Decision 90's verbatim rule asserted by a test over a cell beginning `=`. No new dependency — `csv-parse` is a parser, and the writer is twenty lines.

**Slice 5 — FR-19's three groups.** `lib/final.ts`, pure, taking query results and returning the three groups with their tallies, per CLAUDE.md's rule that a page's transformation belongs in `lib/` where it can be tested. `/instances/[id]/final`, admin-only, each row linking to the applicant profile, each Unresolved row carrying its tally and a link to the pass grid.

**Slice 6 — the admin profile, extended.** `/instances/[id]/results/[applicantId]` gains interview results, interview notes, and this applicant's pass votes across every pass — rendered only where the data exists, so the page stays correct for a written-round-only instance. One admin profile rather than two: §6 gives ADMIN everything including round votes, and a second page differing only in what it happens to load is how two surfaces come to disagree.

**Slice 7 — the funnel.** `lib/funnel.ts` over four cohorts — every applicant imported, those who reached first round, those who reached second round, the Sparklet class — reusing `demographicColumns`, `applicantDemographics`, `columnLabels` and `tallySelections`. `tallySelections`'s own docstring anticipates this: "keeping it that way means FR-19's funnel breakdown can reuse it." Weighted and headcount side by side per §10.7, with the "Not specified" bucket and the write-in values beneath.

**Slice 8 — resolving the Unresolved.** Decisions 70 and 89: admit or reject, writing `Decision(SECOND_ROUND, ADMIN)`, `Applicant.status` and an `AuditLog` row in one transaction, leaving `PassApplicant.resolution` untouched. Confirmation names the applicant with their `Applicant N` handle beside the name — Phase 6's two-Diego-Hoffmanns defect, which the data model refused and the presentation layer let through.

**Slice 9 — the gate and the phase record.** The verification below, then BUILD_PLAN's Phase 7 section gets the "**Done.**" paragraph Phases 5 and 6 both carry: what the gate exercised, and what FR-19 and FR-20 turned out not to say.

---

## Files

**New:** `lib/export.ts`, `lib/export.test.ts`, `lib/export-csv.ts`, `lib/export-csv.test.ts`, `lib/instance-io.ts`, `lib/final.ts`, `lib/final.test.ts`, `lib/funnel.ts`, `lib/funnel.test.ts`, `prisma/checks/round-trip.ts`, `prisma/seed/passes.ts` (pure builders) and `prisma/passes.ts` (the `npm run seed:passes` entry point — the same split as `prisma/seed/second-round.ts` and `prisma/advance.ts`), `app/instances/[id]/export/{page.tsx,[artifact]/route.ts}`, `app/instances/[id]/final/{page.tsx,actions.ts,resolve-control.tsx}`, `plans/phase-7.md`.

**Modified:** `PRD.md` (§7.5, §10, Status), `CLAUDE.md` (rule 4, and the new pure modules), `BUILD_PLAN.md`, `package.json`, `prisma/advance.ts` (the comment), `app/instances/[id]/page.tsx` (two hub rows), `app/instances/[id]/results/[applicantId]/page.tsx`.

**Untouched:** `prisma/schema.prisma`. No migration this phase.

**Reused rather than rewritten:** `tallySelections` / `demographicColumns` / `applicantDemographics` / `columnLabels` (`lib/demographics.ts`) for the funnel; `buildPassGrid`, `resolvePass`, `PassTally` and `RESOLUTION_LABEL` (`lib/passes.ts`) for 19f; `buildApplicantView` (`lib/review.ts`) and `resolveField` (`lib/fields.ts`) for the profile; `buildWrittenReviews` / `buildInterviewCards` (`lib/second-round.ts`) for slice 6; `reviewerAverage` / `scoreSummary` (`lib/results.ts`) for the applicants CSV; `requireInstance` for every gate.

---

## Verification

- `npm run verify` — typecheck, lint, and the five new pure suites.
- `npx tsx prisma/checks/round-trip.ts` — after Slice 2 against the existing fixture, and again after Slice 3 against the complete one.
- **The gate, in order:**
  1. Download `instance.json` for the current database **before running any seed command**. It is the only copy of the Phase 6 gate state.
  2. `npm run seed && npm run seed:advance && npm run seed:passes`.
  3. Open `/instances/seed_s26_demo/final`. All three groups non-empty. Unresolved rows show their tallies, and an all-COI row reads visibly differently from a 7–4 one (19d, 19f). The funnel renders four cohorts and each column's weighted total sums to that cohort's headcount.
  4. Download all four artifacts and open the CSVs in Excel. **Re-scoped twice, and both times because the step named something that did not exist.** First: none of the three CSVs carries free text — they are identity, status, scores, decisions and emails — so there are no essays in them to check, and response columns are deliberately not being added. Second: the replacement said to rename an applicant on `/results/[applicantId]`, and **no applicant rename control exists anywhere in the application**. The punctuation now lives in the fixture instead — `prisma/seed/applicants.ts` gives row 1 the name `Róisín "Ro" O'Brien, Jr.`, which carries a comma, a doubled quote, an apostrophe and a non-ASCII character. Confirm in Excel that row 1's columns line up in `applicants.csv` and `final-class.csv`, that the name reads correctly rather than as mojibake, and that a formula-leading cell renders as decision 90 says it will — Excel evaluating `=…` is the documented consequence, not a defect. The line-break branch of the quoter stays covered by `lib/export-csv.test.ts` rather than by the gate, since no file can reach it today.
  5. Run the check. Then the stronger form BUILD_PLAN actually asks for: **drop and re-migrate the whole database** rather than deleting one instance, then restore from the exported file alone. Deleting one instance proves the cascade; dropping the database proves the export depends on nothing outside it — which on this database means proving the restored instance comes back with `S26 Gate Run` absent.

     **`prisma migrate reset --skip-seed` is not the way, and the flag does not exist.** Prisma 7's `migrate reset` offers only `--force`, and `prisma.config.ts` declares a seed — so a reset would recreate `seed_s26_demo` from the seed script, the restore would collide with it under decision 88's no-merge rule, and the gate would be testing nothing. Drop the schema directly instead, which is also closer to BUILD_PLAN's own wording:

     ```
     DROP SCHEMA public CASCADE;  CREATE SCHEMA public;   -- via $executeRawUnsafe
     npx prisma migrate deploy
     ```

     Then restore by reading the file from disk through `parseExport` and `writeSnapshot`. Reading the file rather than an in-memory snapshot is the point: the club has a file, and the file has to be enough.
  6. Confirm the restored instance opens with the **original instance password** (decision 86) and that a reviewer round link still accepts the original access code.
  7. Resolve two Unresolved applicants, one each way. Confirm they move to the correct group, that `PassApplicant.resolution` still reads `NEEDS_ADMIN` on the final pass, and that the `AuditLog` row carries no applicant name.
  8. Re-run the round trip after step 7, so the export is proven over an instance carrying admin resolutions as well as system ones.
- Read the tests against the contract table above before Slice 3 begins. BUILD_PLAN: "do not trust the tests it wrote."
