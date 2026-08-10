# Phase 0 — Foundation

**Status:** implemented; partially superseded by PRD v1.1
**Gate (BUILD_PLAN):** `prisma migrate dev` runs clean, seed populates, and a synthetic applicant's JSONB `data` resolves against the `Field` table.

> **Superseded by PRD v1.1.** PRD v1.1 resolved open decisions 1–7 after this phase shipped. Three things below are now out of date, and are left as written because this file is a design record rather than a live spec:
>
> - **Judgment call 12** says `InterviewResult` is "deliberately left single-score" with the category dimension optional. Decision 6 is now fully resolved: the interview rubric is an instance-scoped `InterviewCategory` model with `InterviewCategoryScore` children, and `InterviewResult.score` is the imported average, never recomputed. Still Phase 5 work, but no longer an open shape.
> - **`sourceRowIndex` gained a unique constraint** (`20260807000000_applicant_source_row_index_unique`). Decision 4 hides names from written reviewers, who now see "Applicant 47" instead — which makes this column user-facing identity rather than provenance.
> - **The one-hot encoding note** below ("stores the column's own label when checked and `""` when not") is now load-bearing rather than incidental: decision 7's fractional counting depends on it, so PRD §10.7 states the checked/unchecked predicate explicitly.
>
> **Superseded again by PRD v1.2** (Phase 1, migration `20260809120000_field_groups`):
>
> - **`Field.groupKey` and `Field.isMultiSelect` are gone.** Grouping is now a `FieldGroup` table with `Field.groupId` + `Field.groupRole`, and category, inclusion and the §6 visibility toggles are properties of the *group* — so a group cannot end up half hidden and half visible, and §10.7's `1/n` can never run over a partially excluded set. The migration backfills from `groupKey` before dropping it.
> - **Judgment call: the free-text write-in is now IN the group.** The field catalog below records keeping it out as deliberate, on the grounds that including it would make `isMultiSelect` inconsistent within the group. v1.2 answers that with `groupRole`: the write-in is a `FREE_TEXT` member, which is exactly the distinction the aggregations branch on. Membership is what lets FR-19 find it; the role is what keeps it out of the count.
> - **Measured correction.** The table below says 5 headers in `sample-headers.csv` contain embedded newlines. Re-measured against the file, it is **4**. The other figures — 159-char longest, 5 curly apostrophes, 5 trailing-whitespace headers, 37 columns — all hold.

## What this phase built

- Next.js 16 (App Router) + TypeScript + Tailwind v4 + shadcn/ui
- Prisma 7 against Neon Postgres, full PRD §5 schema in one migration
- `prisma/seed.ts` — 150 applicants, 30 reviewers (8 Sparklets), 4 rubric categories, 34 fields
- `prisma/inspect.ts` — the gate check, run with `npm run seed:inspect`
- `.gitignore` rules from PRD §8, which were previously claimed but absent

Nothing from Phases 1–8 is here. No CSV import, no assignment algorithm, no reviewer dashboard.

## The seed is the real deliverable

Phase 1 builds CSV import against these shapes. If the seed is a clean fiction, Phase 1 gets built against a fiction and breaks on the first real export. So the seed reproduces what `fixtures/sample-headers.csv` actually contains.

That file parses to **37 columns**. Measured, not assumed:

| Property | Reality |
|---|---|
| Longest header | 159 chars (`Help us understand your life journey:…`) |
| Embedded newlines | 5 headers, inside quoted fields |
| Curly apostrophes | 5 headers use `’` (U+2019) |
| Trailing whitespace | 5 headers |
| Ethnicity one-hots | exactly 10 columns |

Note the first row: **BUILD_PLAN Phase 1 warns about "200+ character" headers, but the real export tops out at 159.** The seed therefore carries all 37 headers verbatim *plus* one synthetic 241-char prompt, so the length case is exercised without misrepresenting the export.

### Field catalog — 34 rows

Four columns are promoted out of `data` per FR-2 and get no `Field` row: `#` → `sourceRowIndex`, `First Name:` + `Last Name:` → `displayName`, `USC Email Address:` → `email`.

| Columns | n | Category | Notes |
|---|---|---|---|
| `Graduation Date:` … `Minor:` | 6 | OTHER | sparse: `Other Major:` ~88% blank, `Second Major:` ~72%, `Other Second Major:` ~93%, `Minor:` ~65% |
| `How did you hear about Spark SC?` | 1 | OTHER | |
| 5 essay prompts + `Anything else…` | 6 | RESPONSE | verbatim; `Anything else…` ~62% blank |
| synthetic long prompt | 1 | RESPONSE | 241 chars |
| `What are your pronouns?` | 1 | DEMOGRAPHIC | |
| 10 ethnicity one-hots | 10 | DEMOGRAPHIC | `groupKey: "ethnicity"`, `isMultiSelect: true` |
| `Specify your ethnicity…` | 1 | DEMOGRAPHIC | free text, **no** `groupKey` — not a member of the one-hot set |
| `Are you a first-generation…` | 1 | DEMOGRAPHIC | |
| `Start/Stage/Submit Date (UTC)` | 3 | OTHER | |
| `Tags` | 1 | OTHER | ~85% blank |
| `Response Type`, `Network ID`, `Ending` | 3 | OTHER | `isIncluded: false` |

Encoding decisions that matter downstream:

- **One-hot ethnicity** stores the column's own label when checked and `""` when not, which is what form exports actually emit. ~22% of applicants check two or more, so open decision 7 (multi-select counting) has data to hit rather than a hypothetical.
- **`Ending`** is the same ~180-char templated string on all 150 rows — the shape that makes a column obviously junk.
- **Excluded fields still carry values.** Exclusion is a presentation decision, not a lossy one, so Phase 1 can toggle `isIncluded` without re-importing.
- The seed is **deterministic** (fixed-seed `mulberry32`) and **idempotent** (cascade-deletes its own fixed instance ID, touches nothing else). Two runs produce identical data, so a diff during Phase 1 debugging means something.

**Not seeded:** assignments, scores, votes, passes, decisions. Those belong to Phases 2, 3, and 6. Fabricating them now would let a wrong shape harden before those phases specify it.

## Deviations from PRD §5

PRD §5 has been updated to include items 1–5, so it remains the source of truth. Listed here as the design record.

### Approved additions

1. **`Field.isIncluded`** — §5 described `Field` as "one per *retained* column", which left FR-2's excluded columns nowhere to live and made the include/exclude checkbox unable to round-trip.
2. **`Field.visibleToWrittenReviewer` / `visibleToFirstRoundReviewer`** (nullable) — §6 makes OTHER "configurable, default hidden" per round; §5 had no storage for it. `null` means "use the §6 category default".
3. **`PassApplicant`** — the significant one. FR-17 fixes pass membership at creation, but with only `Applicant.status` you cannot reconstruct who was in pass 1 after statuses change. It is also the only home for the all-COI state, which §7.4 requires be distinguishable from unanimity.
4. **`RoundAccessCode`, `AuditLog`** — both required by §8, neither present in §5.
5. **`Applicant UNIQUE (instanceId, email)`** — makes FR-3's duplicate resolution a database guarantee rather than a UI convention, and makes the FR-12 email join key safe.

### Mechanical

6. §5 writes `status` inline on both `Applicant` and `Assignment`; Prisma needs distinct enum names → `ApplicantStatus` / `AssignmentStatus`.
7. `Instance.currentStage` has a fourth value (`COMPLETE`) that `Assignment.round` must not → `InstanceStage` and `Round` are separate enums.
8. `Reviewer.rounds` is a native Postgres enum array, `Round[]`.

### Judgment calls

9. **`Assignment.returnReason` + `returnedAt`** — FR-9 requires a *reason* on return-to-pool; §5 gave only the status.
10. **`InterviewNotes` modeled 1:1 with `interviewerName`** — only one interviewer of each pair writes the notes, and the source sheet's "Your Name" column records which.
11. **`createdAt` / `updatedAt` on mutable models** — open decision 5 wants a "changed by X at Y" indicator, which is unimplementable later without a migration.
12. **`Score.points` is `Int`, `InterviewResult.score` is `Float`** — see open decision 6, now resolved on the facts: the S26 `1R Scores` sheet carries four categories plus an average per interviewer. `InterviewResult` is deliberately left single-score for now; **Phase 5 must add a category dimension.**

### Constraints deliberately *not* added

- `Field.sourceHeader` is not unique — real form exports do emit duplicate header text, and rejecting an import for that would be wrong.
- `Reviewer` names are not unique — two people can share a name. That is precisely why the system keys on IDs.
- `InterviewResult` has no uniqueness — FR-12 expects two rows per applicant and interviewer names are free text.

## Prisma 7 notes for whoever comes next

Prisma 7 moved things that older tutorials still show in the schema:

- Connection URLs live in **`prisma.config.ts`**, not `schema.prisma`. The datasource block carries only `provider`.
- `.env` is **not** auto-loaded; `prisma.config.ts` does `import "dotenv/config"` explicitly.
- The client generates to **`generated/prisma`** (gitignored), not `node_modules`. Import from `@/generated/prisma/client`.
- `DATABASE_URL` points at Neon's **pooled** endpoint. If `migrate` ever fails on advisory locks or prepared statements, set `DIRECT_URL` to the same URL with `-pooler` removed from the host and add `directUrl` to `prisma.config.ts`.

## Verification

```bash
npx prisma migrate dev --name init
npm run seed          # then run it again; output must be identical
npm run seed:inspect  # the gate
npm run verify        # typecheck, lint, test
npm run dev
```
