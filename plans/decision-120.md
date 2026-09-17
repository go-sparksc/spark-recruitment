# Decision 120 — Interview transcript and per-interviewer evaluative notes

Provisional. Built to be tested on a throwaway instance and either shipped or
abandoned within the hour. Nothing here touches the live cycle until the owner
says go.

## Context

The F26 cycle is stopped at the interview file-upload step. Two real Google Form
exports are waiting, and neither can be imported by the current FR-12 pipeline.
This plan makes both importable, additively, and renders what they carry.

What the two files actually are (measured, not assumed):

**`F26 1st Round Interview Notes (Responses)`** — 62 data rows, 62 distinct
applicants, exactly one row each. One shared notetaker per interview, recorded in
`Your Name`. Columns 3–11 are nine numbered interview questions: seven prose
(avg 175–499 chars each, max 1363), one Yes/No availability question (Q7), one
fun question (Q8). Q9 is blank for 5 applicants; nothing else is ever blank.
~2,525 chars of transcript per applicant.

**`F26 Spark 1st Round Evaluation (Responses)`** — 123 data rows over the same 62
applicants. 61 have exactly two rows, one per interviewer; Cali Karmis has one.
Per interviewer: four integer scores 1–4, a matching `Notes on <Category>` prose
column for each (blank 25–40 times out of 123), a Yes/No
`Should this applicant move on to 1R Deliberations?` (87 Yes / 36 No), and an
`Additional Notes` column (blank 91/123, max 1993 chars).

Three findings reshaped the original ask:

1. **Scores are already per-interviewer.** `InterviewResult` is keyed
   `@@unique([applicantId, interviewerName])` (`prisma/schema.prisma:711`) — two
   rows per applicant is the designed case, not a workaround. Only
   `InterviewNotes` is one-per-applicant (`applicantId @unique`,
   `schema.prisma:822`). Checked against the real file: **zero applicants whose
   two interviewer names collide**, so both interviewers' rows already land
   separately. The re-keying the ask called for is unnecessary; what is missing is
   a place to put per-category prose.

2. **The transcript is genuinely one-per-applicant.** 62 rows / 62 applicants,
   one notetaker each. Re-keying `InterviewNotes` per-interviewer would model
   something the data does not contain.

3. **Both files are blocked for reasons beyond notes.** The Evaluation file has
   no Average column — `validateMapping` refuses
   (`lib/import/interview-mapping.ts:256`) and `unreadableAverage` would block all
   123 rows (`lib/import/interview-preview.ts:246`). The Notes file has nine
   question columns but `NOTES` is a single-use role and the duplicate-role check
   (`interview-mapping.ts:282`) refuses a second.

### The category-name question, answered as far as it can be

**Neither file's phrasing matches anything configured in the database I can
reach, and the live cycle is not on this machine.** The dev database holds six
instances — `Demo Cycle — my practice run`, `Walkthrough (throwaway, synthetic)`,
`Kai Walkthrough`, `Kai Lincoln Walkthrough`, `Demo Cycle (finished — for
reference)`, `S26 Recruitment (synthetic seed)` — none of them an F26 cycle.
There is no `.vercel` link and no production `DATABASE_URL` here.

Every `InterviewCategory` set that exists in this database is the demo one:

| Instance | ord 0 | ord 1 | ord 2 | ord 3 |
|---|---|---|---|---|
| `demo_reference`, `seed_walk0907` | Communication | Initiative | Collaboration | Interest in Spark |
| `cmtsudx0y0000soliftki0l8z` | Communication | Motivation | Culture Fitness | Problem Solving |

Three instances have no interview categories at all. So the
"`Initiative and Scrappiness`" vs "`Initiative & Scrappiness`" question is moot
against anything here — the live values are a different vocabulary entirely and
must be read off `/instances/<id>/interview-rubric` on the live cycle.

**Actionable corollary:** the interview rubric locks the moment any
`InterviewCategoryScore` exists (`app/instances/[id]/interview-rubric/actions.ts:32`),
and the live cycle has none yet. So the live categories can still be renamed to
the Evaluation file's exact header text, which makes `proposeMapping` auto-match
all four *and* auto-match their four `Notes on <name>` columns. That is one
rename now versus eight dropdowns at import time. Mapping stays hand-confirmable
either way — nothing here guesses.

## Schema

Six changes, all additive. No column changes meaning, no backfill, no unique key
moves. Every existing row reads exactly as it does today.

```prisma
model InterviewResult {
  // ...existing...
  note            String?                  // the sheet's "Additional Notes"
  recommendation  InterviewRecommendation? // "Should this applicant move on…"
  scoreIsComputed Boolean  @default(false) // see "Average", below
}

model InterviewCategoryScore {
  // ...existing...
  note String?  // the sheet's "Notes on <Category>"
}

enum InterviewRecommendation { YES NO }

/// The nine interview questions, instance-scoped. Deliberately the same shape as
/// InterviewCategory — the rubric's questions and the interview's questions are
/// the same kind of thing, configured per cycle.
model InterviewQuestion {
  id         String   @id @default(cuid())
  instanceId String
  instance   Instance @relation(fields: [instanceId], references: [id], onDelete: Cascade)
  ordinal    Int
  prompt     String   // verbatim header text from the notes sheet
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  answers    InterviewAnswer[]
  @@unique([instanceId, ordinal])
}

/// One answer per question per applicant's transcript. Cascades from
/// InterviewNotes, which is what keeps the existing delete-then-insert commit
/// idempotent without a second delete.
model InterviewAnswer {
  id                  String            @id @default(cuid())
  interviewNotesId    String
  interviewNotes      InterviewNotes    @relation(fields: [interviewNotesId], references: [id], onDelete: Cascade)
  interviewQuestionId String
  interviewQuestion   InterviewQuestion @relation(fields: [interviewQuestionId], references: [id], onDelete: Cascade)
  body                String
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  @@unique([interviewNotesId, interviewQuestionId])
  @@index([interviewQuestionId])
}
```

`InterviewNotes` is untouched, including `applicantId @unique`. Its `body` keeps
holding a readable transcript — see "Commit" — so `lib/export.ts`, FR-20 and every
current renderer keep working unchanged. **That is also the fallback path**: if
this decision is abandoned, `body` is exactly the single combined text blob the
fallback plan calls for, already populated.

Update `PRD.md` §5's interview block and add decision **120** to §10 in house
style, before writing the migration — `CLAUDE.md` makes §5 the source of truth and
the schema its implementation.

## Migration

`prisma/migrations/20260917<hhmmss>_interview_transcript/migration.sql`.

Generated with the Prisma 7 flags (`prisma migrate diff --from-config-datasource
--to-schema prisma/schema.prisma --script`), then hand-finished below the
divider comment, following `20260912120000_class_standing` exactly: a header
block citing decision 120, stating "additive only, no backfill", and spelling out
that every existing row keeps its current meaning (`note`/`recommendation` NULL
render nothing; `scoreIsComputed = false` means "verbatim from the sheet", which
is what every existing row is).

Hand-written constraints:

- `InterviewQuestion_ordinal_nonneg` — `CHECK ("ordinal" >= 0)`.
- `InterviewResult_computed_score_provenance` — no constraint; the default is the
  honest value and there is nothing to guard. Noted here so the omission is
  deliberate rather than forgotten.

Then `prisma migrate deploy` locally. **`prisma migrate dev` cannot run here.**

**After migrating: restart `next dev`, and confirm the old process actually
died.** A stale in-memory client will fail with `Unknown field 'note' for select
statement on model 'InterviewCategoryScore'` while `npm run verify` stays green —
the Phase 3 trap. If the stop does not take, check port 3000 is free before
starting another; `taskkill /PID <pid> /F` if not.

## Import pipeline

### Mapping — `lib/import/interview-mapping.ts`

Four new roles on `InterviewRole`:

| Role | Sheet | Repeatable |
|---|---|---|
| `{ kind: "TRANSCRIPT" }` | NOTES | **yes** |
| `{ kind: "CATEGORY_NOTE"; interviewCategoryId }` | SCORES | no (one per category) |
| `{ kind: "OVERALL_NOTE" }` | SCORES | no |
| `{ kind: "RECOMMENDATION" }` | SCORES | no |

`CATEGORY_NOTE` encodes as `CATEGORY_NOTE:<id>`, parsed by the same
known-id-or-`IGNORED` rule `CATEGORY` already uses (`parseRole:52`). `MappedColumns`
gains `transcriptColumns: number[]` (ascending), `categoryNoteColumns: Map<string, number>`,
`overallNoteColumn`, `recommendationColumn`.

`proposeMapping` keeps its exact-match-after-trim-and-case-fold discipline — the
`Black` / `Black or African American` lesson in its header comment stands. Two
additions, both exact matches against a derived key, never a prefix or substring
search:

- `notes on ${category.name}` → `CATEGORY_NOTE` for that category. This is why
  renaming the live categories to the sheet's text pays for itself twice.
- `additional notes` → `OVERALL_NOTE`;
  `should this applicant move on to 1r deliberations?` → `RECOMMENDATION`.

`TRANSCRIPT` is **never proposed** — nine long prompts have no exact key to match.
Instead `sheet-controls.tsx` gains one bulk control, "Mark the remaining columns
as transcript questions", which is an explicit admin action rather than a guess.
One tap for nine columns.

`validateMapping` changes:

- **`AVERAGE` becomes optional on SCORES** (see below). Drop the
  `"No column is marked as the Average."` blocker.
- NOTES now requires `notesColumn !== null` **or** `transcriptColumns.length > 0`,
  with a sentence naming both ways to satisfy it.
- The duplicate-role check exempts `TRANSCRIPT`. Everything else still refuses a
  duplicate, so `CATEGORY_NOTE` for one category twice is still a blocker.

### The Average — amending decision 6 / clause 12h

`AVERAGE` becomes optional. When the column is absent, `InterviewResult.score` is
the mean of that row's mapped category cells and `scoreIsComputed` is set true.
When present, behaviour is exactly as today: verbatim, never recomputed,
`scoreIsComputed` false.

This narrows rather than reverses decision 6. Its rule was *the importer may not
overrule the sheet*; a sheet with no average has nothing to overrule. The
provenance flag is what keeps that honest — a computed number is never
indistinguishable from a recorded one, at import (`preview` labels it) or at
render ("3.5 (computed)"). PRD §10 decision 120 records this as an amendment to
decision 6 and clause 12h explicitly.

Knock-on in `lib/import/interview-preview.ts`:

- `unreadableAverage` becomes true only when an average column *is* mapped and its
  cell will not parse. With no column mapped, a row whose categories are all
  unreadable has no computable score — that is the new blocking case, and its
  sentence must say so rather than reusing the old "fix the file" wording.
- `averageDisagreement` is skipped entirely when the score was computed. It cannot
  disagree with itself, and reporting it would be noise on all 123 rows.

### Preview — new per-row fields

`PreviewRow` gains `categoryNotes: { interviewCategoryId, body }[]`,
`overallNote: string`, `recommendation: "YES" | "NO" | null`,
`rawRecommendation: string`, `transcript: { columnIndex, prompt, body }[]`,
`scoreIsComputed: boolean`.

Recommendation parsing is case-insensitive `yes`/`no` after trim; anything else
reads `null` and raises a **warning, never a blocker** — it is not load-bearing for
any downstream decision, and refusing an import over an unparsed advisory column
would be the importer overruling the sheet in the other direction.

Notes cells are stored verbatim; a blank note is `null`, not `""`, so "no note"
and "an empty note" stay distinguishable at render.

### Commit — `app/instances/[id]/interviews/actions.ts`

SCORES, inside the existing transaction and keeping the bulk-statement shape
(the P2028 lesson in the function's header comment stands):

- `interviewResult.createMany` carries `note`, `recommendation`, `scoreIsComputed`.
- `interviewCategoryScore.createMany` carries `note`. Decision 59 still governs
  `points`: a blank score cell writes no row — **and therefore no note either,
  since the note lives on that row.** Where a category has a note but no readable
  score, write the row with the note and no points is not expressible (`points` is
  non-null Int). Preview must surface this: a warning naming the affected rows,
  saying the note will not import because the score did not. Measured against the
  real file: check this count at preview; the four note columns are blank 25–40
  times but the score columns are never blank, so the expected count is zero.

NOTES, inside the existing transaction:

- `InterviewQuestion` rows are **upserted by `(instanceId, ordinal)`**, ordinal
  ascending over `transcriptColumns`, `prompt` = the column's header verbatim.
  Never deleted — deleting would cascade away answers belonging to applicants this
  batch never touched.
- `InterviewNotes` keeps its existing `deleteMany` + `createMany`; `InterviewAnswer`
  rows are created against the ids `createMany` already generates client-side. The
  cascade means the existing delete cleans the previous answers for exactly these
  applicants, so re-commit stays idempotent with no second delete.
- `InterviewNotes.body` is set to the assembled transcript — each prompt followed
  by its answer, blank-line separated — when transcript columns are mapped, and to
  the `NOTES` column as today when they are not. One pure function,
  `flattenTranscript`, shared by the commit and by nothing else; tested.

## Rendering

The transform goes in `lib/` and the pages keep only the query — `lib/first-round.ts`
is the worked example, and the Phase 5 lesson behind it.

`lib/second-round.ts`:

- `InterviewResultSource` / `InterviewCard` gain `note`, `recommendation`,
  `scoreIsComputed`, and `categoryNotes: (string | null)[]` aligned to
  `categoryIds` the same way `points` already is (`buildInterviewCards:212`).
- New `buildTranscript(notes, questions): TranscriptSection[]` — pairs answers to
  questions by id, orders by `ordinal`, drops empty bodies.
- New `shortenPrompt(prompt): string` — strips a leading `N. `, cuts at the first
  sentence end or newline, caps ~80 chars. Pure, tested, and the reason the nine
  `<summary>` lines stay one line each when the raw prompts run to 300 chars.

Three call sites, one transform:

| Page | File |
|---|---|
| Second-round profile (FR-16) | `app/r/[instanceId]/second-round/[applicantId]/page.tsx:228-276` |
| First-round profile (FR-14) | `app/r/[instanceId]/first-round/[applicantId]/page.tsx:190` |
| Admin results | `app/instances/[id]/results/[applicantId]/page.tsx` |

Markup follows the conventions already in these files — native `<details>`/`<summary>`
for disclosure (used at `second-round/[applicantId]/page.tsx:243` and `:316`),
`whitespace-pre-line` for prose on the `/r/` pages and `whitespace-pre-wrap` on the
admin one, and **no truncation**, which `results-table.tsx:320` records as a
deliberate reversal.

Per interviewer card: `{interviewerName}` · `{score}` (with `(computed)` when
`scoreIsComputed`) · the Yes/No recommendation. The existing
`<details><summary>Per-category scores</summary>` disclosure gains each category's
note under its points. The `Additional Notes` body renders under the card, styled
as the written-review note already is.

Transcript: a new `<h3>Interview transcript — {notetaker}</h3>` under the interview
cards, then one `<details>` per question with `shortenPrompt` as the summary, the
full prompt and the answer inside. Nine collapsed rows, not ~2,500 characters of
prose dropped into the page above the vote buttons.

**The notetaker label will not match either interview card for 7 of 62
applicants** — `bona` vs `bona suh`, `cici` vs `cici fang`, `hansika reddy
kondapally` vs `hansika kondapally`, `sonali dhruva` vs `sonali`, `paolo` vs
`paolo velasco`. That is the pre-existing free-text interviewer identity gap
(`InterviewResult.interviewerName` is documented as "never a Reviewer id",
`schema.prisma:686`), and decision 47 already records it as an accepted cost.
**Out of scope here** — flagged so the owner sees it during the test rather than
after, and so it is not mistaken for a bug this change introduced.

## Tests

`lib/` stays pure and gets real tests, per `CLAUDE.md`'s four-things rule:

- `lib/import/interview-mapping.test.ts` — the four new roles round-trip through
  `encodeRole`/`parseRole`; `TRANSCRIPT` repeats without tripping the duplicate
  check while `CATEGORY_NOTE` still does; `AVERAGE` absent is no longer a blocker;
  NOTES satisfied by transcript columns alone; `notes on <name>` proposes against
  a category, and does **not** propose against a near-miss name.
- `lib/import/interview-preview.test.ts` — computed average and its flag; the
  no-column-and-no-readable-categories blocker; `averageDisagrees` suppressed when
  computed; unparsed recommendation warns rather than blocks; a note on a category
  whose score did not parse is reported.
- `lib/second-round.test.ts` — `buildTranscript` ordering and gap handling;
  `shortenPrompt` against all nine real prompt shapes; `categoryNotes` alignment
  when a category has points but no note and vice versa.
- `flattenTranscript` round-trip.

`prisma/checks/interview-transcript.ts`, following the `field-groups.ts` house
pattern — header comment saying why it is load-bearing and how to run it, raw-SQL
probes asserting 23505 on `InterviewQuestion(instanceId, ordinal)` and
`InterviewAnswer(interviewNotesId, interviewQuestionId)` and 23514 on the ordinal
CHECK, `cleanup()` in `.finally()`, and `confirmRestored()` re-querying to prove no
probe rows remain. **Its fixtures use `check_`-prefixed ids inside a throwaway
instance it creates**, per the archive-purge lesson: a check's own fixtures must sit
outside the range of anything real.

Re-run `prisma/checks/unique-constraints.ts` and `prisma/checks/interview-import.ts`
by hand after the migration.

## Throwaway test instance

New `prisma/throwaway.ts`, script `seed:throwaway`, invoked:

```
SEED_INSTANCE_ID=throwaway_f26_shape npm run seed:throwaway -- \
  --notes="C:\Users\theka\Downloads\F26 1st Round Interview Notes (Responses) - Form Responses 1.csv" \
  --scores="C:\Users\theka\Downloads\F26 Spark 1st Round Evaluation (Responses) - Form Responses 1.csv"
```

It reads both CSVs **at the paths given, at runtime** and creates:

- an instance named `F26 shape test (throwaway)`, password printed to stdout;
- four `InterviewCategory` rows named **exactly** from the Evaluation file's score
  headers, `maxPoints` 4 — so the throwaway reproduces the auto-match case, and the
  live cycle's real names (once read off the rubric page) can be tested against it
  by renaming;
- one `Applicant` per distinct `Applicant Name` in the Notes file,
  `stageReached = FIRST_ROUND`, `status = ACTIVE`, with **synthetic** application
  data and emails;
- a reviewer roster large enough to open the first-round dashboard.

It does **not** import the interview data. The two CSVs are uploaded through the
real admin UI — that is the end-to-end test, and pre-importing them would test a
second copy of the code under test.

**This is how rule 3 is kept.** Real applicant names are read from `~/Downloads` at
runtime and never written to a repo file; `*.csv`, `*.xlsx`, `/data` and `/uploads`
are already gitignored, and nothing this script produces is committed. "Rows shaped
exactly like the real CSVs" is satisfied by real shape and real names in the
database, with no real content in the repo.

Two guards, because this script deletes and recreates whatever `SEED_INSTANCE_ID`
names and `prisma/seed/client.ts:` warns in plain terms that pointing it at a real
instance would destroy it:

- refuse to run unless `SEED_INSTANCE_ID` starts with `throwaway_`;
- refuse if the target instance holds any `InterviewResult` or committed import.

## Verification

1. `npm run verify` — typecheck, lint, test.
2. **`npm run build`** — this slice touches `"use server"` action files, adds props
   crossing into `sheet-controls.tsx` (`"use client"`), and `verify` never invokes
   the Next compiler. The `ROUND_PREREQUISITES` failure in Phase 9.4 had 878 tests
   green at the time.
3. `npx tsx prisma/checks/interview-transcript.ts`, plus the two existing interview
   checks re-run.
4. Restart `next dev` after `prisma generate` / `migrate deploy`; **verify the old
   process is gone and port 3000 is free** before assuming the restart took.
5. Seed the throwaway, then end-to-end in the browser:
   - upload the Evaluation CSV → four category columns and four `Notes on …`
     columns auto-map → `Additional Notes` and the deliberations question auto-map
     → no Average blocker → preview shows 123 rows, 62 applicants, scores computed
     and labelled → commit;
   - upload the Notes CSV → `Your Name` and `Applicant Name` auto-map → one tap on
     "mark the remaining columns as transcript questions" → preview shows 62 rows →
     commit;
   - open a second-round profile: two interviewer cards with per-category notes and
     Yes/No, the Additional Notes body, and nine collapsible transcript sections;
   - open a first-round profile and the admin results page for the same applicant
     and confirm all three agree;
   - **re-upload both files unchanged and re-commit** — row counts must not double.
     That is decision 47's upsert, and the new answer and note rows are the part
     most likely to break it.

## Explicitly not in this plan

- **Interviewer identity reconciliation.** 12 name variants across the two files;
  7 applicants whose notetaker label matches neither interview card. Pre-existing
  (decision 47), unchanged by this work, worth its own decision if deliberation
  trips over it.
- Re-keying `InterviewNotes`, per the finding above.
- Any admin screen for editing interview questions — they come from the sheet.

## Live-cycle guard

**Work stays on a branch and is not pushed.** `vercel.json` runs
`prisma migrate deploy && next build`, so a push to `main` migrates production,
and — per `CLAUDE.md` — *every* build migrates, preview builds included, against
whatever `DATABASE_URL` that environment holds. Pushing the branch is therefore
not automatically safe either. Nothing reaches any deployed environment until the
throwaway test passes and the owner says go.

The migration is additive and the live cycle has no interview data yet, so the
fallback costs nothing: abandon the branch, and importing a single combined text
blob into `InterviewNotes.body` works exactly as it does today.

---

## What building it found

Appended after the slice was built. Everything above is the plan as approved;
this is what changed under it.

**Three surfaces became one component, not three copies of markup.** The plan
said "one shared transform, three call sites", meaning the `lib/` function. That
was not enough. An interview stopped being a score, four points and one note and
became two interviewers' per-category prose, two overall notes, two
recommendations, a provenance flag per score and a nine-part transcript, and
three hand-written copies of *that* is three chances for one screen to omit
something the other two show. The markup moved into
`components/interview-section.tsx` as two server components. The admin results
view gave up its own `dl` grid to use them, which is a small visual change to
that page and the reason it now agrees with the other two by construction.

**The bulk transcript sweep marked `Timestamp` as question one.** Found by running
the real notes sheet through the importer: ten questions, not nine. The cause is
that `IGNORED` means two things — the mapping module's own doc says it is "a real
answer, not the absence of one … an interview sheet carries timestamps and row
numbers that nothing should import" — and a sweep over IGNORED columns cannot
tell a column the admin dismissed from one nobody reached. Fixed with
`isBulkTranscriptCandidate` and a six-entry exact-match exclusion list, shared by
the action and by the button's own count so the two cannot disagree. Regression
test pins the real F26 header row.

**The nine question upserts became a constant number of statements.** The plan
said to upsert `InterviewQuestion` on `(instanceId, ordinal)`, and the obvious
shape is a loop — nine round trips, which looks harmless beside the 150 that made
FR-11's finalize exceed Prisma's limit. It is not harmless on this deployment:
iad1 to Neon in us-west-2, one cross-country round trip per statement, and
`commitImport` has already failed in production on a 197-row transaction for
exactly that reason. Measured at 42 ms per round trip from a machine on the
database's own coast. Now: read, `createMany` what is missing, update only the
prompts that actually changed — two statements when re-importing the same sheet,
which is the case decision 47 is about. The transaction's timeout was raised to
`commitImport`'s 60 s for the same link, not for the work.

**FR-20's export would have silently dropped all of it.** `lib/export.test.ts`
caught the two new tables and four new columns on the first test run, and
`lib/instance-io.ts`'s exhaustive `TableReader` type caught the missing readers at
the next typecheck. Both are exactly the tripwires their comments claim to be.
Worth recording because nothing in this plan mentioned FR-20 at all.

**What was not done.** The plan's `InterviewQuestion_ordinal_nonneg` CHECK exists
and is verified; the second constraint the plan floated was deliberately dropped
and the migration says why.

## Verification actually run

- `npm run verify` — 1047 tests, 31 files, clean. (987 before this slice.)
- `npm run build` — clean. Required: this touched a `"use server"` module, added
  a new export to a `"use client"` file, and added two server components.
- `npx tsx --conditions=react-server prisma/checks/interview-transcript.ts` — six
  probes, all passing against the real database: both unique keys as 23505, the
  ordinal CHECK as 23514, the `InterviewAnswer` cascade firing, and
  `InterviewQuestion` surviving it.
- `prisma/checks/interview-import.ts`, `prisma/checks/unique-constraints.ts` —
  pass.
- `npm run check:round-trip` — 12 tables, 2892 rows, clean.
- Throwaway instance seeded from the two real CSVs: 62 applicants, 4 categories
  named exactly as the evaluation sheet spells them, 38 reviewers. Both guards
  confirmed to refuse — a non-`throwaway_` id, and missing file arguments.
- Both real sheets driven through `proposeMapping` → `validateMapping` →
  `matchRow` → `buildInterviewPreview` against that instance's pool:

  | | notes sheet | evaluation sheet |
  |---|---|---|
  | rows | 62 | 123 |
  | resolved | 62 (all NAME tier) | 123 (all NAME tier) |
  | unresolved | 0 | 0 |
  | awaiting fuzzy | 0 | 0 |
  | can commit | yes | yes |
  | manual steps | one tap | none |

  The evaluation sheet auto-mapped every column — four categories, four
  `Notes on …`, the recommendation and `Additional Notes` — with no dropdown
  touched, because the throwaway's rubric is named as the sheet spells it. All
  123 scores computed and labelled; 103 rows carry category notes, 123 a
  recommendation, 32 an overall note. Two warnings, both correct: the computed
  scores, and Cali Karmis having one interviewer rather than two.

**The one thing not executed: `commitInterviewSheet` itself.** It is a server
action behind `requireInstance`, and the admin password is an argon2id hash.
Forging a session token to get past it is what happened during Phase 7 testing
and is why `SESSION_SECRET` was rotated on 2026-08-25 — so it was not done again.
The commit is the first thing the browser test exercises.
