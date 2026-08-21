# Phase 5 — First round (FR-12, FR-13, FR-14, FR-15)

**Gate (BUILD_PLAN Phase 5):** import a scores file where three names are deliberately wrong and confirm all three land in the unresolved queue rather than being guessed at; confirm yes-percentage excludes skips from both numerator and denominator, and that raw counts display alongside.

---

## Context

Phase 4 ended with the written round finalizable: `Decision` rows at `stage = WRITTEN`, `stageReached → FIRST_ROUND` on the advanced, `Instance.currentStage → FIRST_ROUND`. Every applicant who advanced is now sitting in a state nothing reads. There is no first-round surface at all — no interview rubric, no import, no reviewer dashboard, no results — and `InterviewResult` still carries the Phase-5 TODO comment from Phase 0 (`prisma/schema.prisma:528-531`) saying it needs a category dimension before FR-12's contract can be written.

This phase is where the system finally does the thing it exists to do. The workbook it replaces keys the `1R Notes` sheet on free-text applicant names typed by interviewers, and a typo there silently orphans a record. FR-13 is the machine that makes that impossible. BUILD_PLAN weights the reconciliation cascade the same as the Phase 2 assignment algorithm and the Phase 6 pass state machine, and it gets the same treatment: a pure module with no database access, and a test file whose cases *are* the spec.

Four decisions were settled with the owner before planning:

- **Decision 49's collision key** is the sheet's upsert key, not literal `applicantId` — see the FR-12/49 note below.
- **Commit blocks until every staged row is resolved or explicitly skipped**, which is what makes §5's "deleted at that sheet's commit" true.
- **The seed gains a named first-round cohort** so a committed fixture CSV has stable names to aim at.
- **`InterviewCategory` gets its own page**, `/instances/[id]/interview-rubric` — now written up as FR-12a and decision 54 rather than left as an unnumbered screen the plan invented.

---

## The finding: decision 45's threshold rejects decision 45's own example

This is the first thing to read, because it changes the algorithm and it invalidates one sentence of the PRD's reasoning.

I implemented Jaro-Winkler (standard: matching window `⌊max(|a|,|b|)/2⌋−1`, prefix scale `p = 0.1` capped at 4 characters) and validated it against published reference pairs before trusting any of the numbers below — `MARTHA/MARHTA` 0.961, `DWAYNE/DUANE` 0.840, `DIXON/DICKSONX` 0.813, `CRATE/TRACE` 0.733, all exact. The implementation is not the problem.

Scoring the full normalized name, as decision 45 specifies:

| Pair (normalized) | Whole-string JW | Decision 45 requires |
|---|---|---|
| `cici fang` / `cecilia fang` | **0.842** | clears 0.85 — **it does not** |
| `mia chen` / `nia chen` | **0.917** | scores below 0.85 — **it does not** |
| `cecelia fang` / `cecilia fang` | 0.940 | clears ✓ |
| `meagan woods` / `megan woods` | 0.954 | clears ✓ |
| `meagan woods` / `maegan woods` | 0.975 | clears ✓ |

Both boundary cases fail, in opposite directions. And they fail in an order no threshold can fix: **the pair that must clear scores strictly lower than the pair that must not.** There is no number `t` such that `0.842 ≥ t > 0.917`. Lowering the threshold to admit Cici admits Mia along the way; raising it to exclude Mia excludes Cici by a wider margin than it already does.

The PRD's stated rationale for comparing whole strings is empirically wrong, and it is worth quoting because it is the sentence that has to change:

> "'Cici Fang' against 'Cecilia Fang' is a whole-string near-miss, not a token-level one, which is why this compares the full trimmed, case-folded, whitespace-collapsed name rather than splitting into first and last halves."

Split token-wise, the same pair is a *certainty* on one half and a near-miss on the other: surname `fang` = `fang` exactly, given name `cici`/`cecilia` at JW 0.796. Whole-string scoring takes a half it knows for certain and averages it into a half it does not, which is precisely what pushes the pair below threshold while `mia`/`nia` — three characters, one substitution, riding on an identical surname — floats above it.

### It gets worse, and the worse part is the important part

The reason Cici→Cecilia is hard is not the metric. It is that **a nickname is less similar to its own given name than two different people's names are to each other.** Given-name Jaro-Winkler, surname held identical:

| Given pair | JW | What it is |
|---|---|---|
| `cici` / `cecilia` | 0.796 | must auto-resolve, per decision 45 |
| `jason` / `jasmine` | 0.853 | **two different people** |
| `chris` / `christina` | 0.911 | **two different people** |
| `alexandra` / `alexander` | 0.956 | **two different people** |
| `dan` / `daniel` | 0.883 | same person |
| `steph` / `stephanie` | 0.911 | same person |

No similarity function fixes this ordering, because there is no signal in the strings that separates them. `alexandra`/`alexander` will outscore `cici`/`cecilia` under Jaro-Winkler, Levenshtein ratio, bigram Dice, or anything else, and it always will.

**The conclusion is not "pick a better metric." It is that a single-candidate fuzzy match must not commit without a human tick** — which is what FR-13 already says, in its own words: "fuzzy name match above a similarity threshold **presented for confirmation** … Nothing imports silently under a guessed match." Reading "resolved" in your test cases as *staged as resolved* — `matchedApplicantId` set, `matchTier = FUZZY`, `matchConfidence` recorded, and shown in a confirm list the admin ticks before commit is offered — makes every one of your cases satisfiable and makes the Jason/Jasmine class survivable. Reading it as *auto-committed* makes the phase unshippable on arithmetic, not on opinion.

### What I propose instead (PRD decision 52, amending 45)

Keep Jaro-Winkler. Change what it is scored over, and add one gate:

1. **Surname — the last token after normalization — must be exactly equal.** A fuzzy surname is a different family. It is also the half an interviewer copies off a form rather than recalls, so it is the reliable half, and averaging it into the unreliable one throws away the only certainty in the comparison.
2. **The given-name remainder must share its first character.** A difference at the initial is a different person (`mia`/`nia`, `sam`/`pam`, `jon`/`ron`); a difference after it is a spelling variant (`cecelia`/`cecilia`, `meagan`/`megan`, `cici`/`cecilia`). This is the gate that carries the Mia/Nia case, and it carries it structurally rather than by a threshold that happens to land right.
3. **Jaro-Winkler over the given-name remainder, threshold 0.78.** `matchConfidence` records this number.

Against every case you gave:

| Case | Surname | Initial | Given JW | Outcome |
|---|---|---|---|---|
| `Cici Fang` → `Cecilia Fang` | exact | `c`=`c` | 0.796 | **FUZZY**, confidence 0.796 ✓ |
| `Cecelia Fang` → `Cecilia Fang` | exact | `c`=`c` | 0.894 | **FUZZY** ✓ |
| `Mia Chen` → `Nia Chen` | exact | `m`≠`n` | not scored | **no match** ✓ |
| `Meagan Woods` → `Megan` + `Maegan` | exact | `m`=`m` | 0.902 / 0.950 | **two clear → manual queue, both shown** ✓ |
| `Jordan A. Lee` → `Jordan Lee` | — | — | — | normalizes equal, resolves at **tier 2** ✓ |
| `O'Brien, Casey` → `OBrien, Casey` | — | — | — | normalizes equal, resolves at **tier 2** ✓ |

Your Mia/Nia case says the pair "must score BELOW 0.85." Under this proposal it is never scored at all, which satisfies the requirement's intent — it must not resolve — but not its letter. Saying so rather than quietly reinterpreting it: the raw whole-string JW for that pair is **0.917**, and the calibration signal you attached to it ("if it clears, the threshold needs revisiting") has fired.

**Alternative, recorded and not recommended:** keep whole-string scoring, drop the threshold to 0.84, and add the same first-initial gate token-wise. It satisfies the same cases and preserves decision 45's comparison basis. It is rejected because Cici/Cecilia would clear by 0.002 — one extra character anywhere in either name flips the phase's headline example, and a threshold tuned to two thousandths of margin is a number nobody can maintain.

---

## Clause ledger

CLAUDE.md's mechanical guard. FR-12 and FR-13 are multi-clause requirements and are broken out clause by clause; FR-14 and FR-15 follow. Re-ticked against the diff before each commit, not just against this plan.

### FR-12a — interview rubric builder

New requirement, proposed below and numbered by the owner. Its clauses are ticked separately because Slice 4 was otherwise implementing it with no requirement to cite.

| # | Clause | Slice | Ticked by |
|---|---|---|---|
| 12a-1 | "the instance needs configured `InterviewCategory` rows … not shared with `RubricCategory`" | 1, 4 | Separate model, separate page, no read of `RubricCategory` anywhere in the interview path |
| 12a-2 | "Admin enters number of categories and max points per category" | 4 | Add/remove rows and a per-row max; reuses `validateRubric`'s shape |
| 12a-3 | "on its own page at `/instances/[id]/interview-rubric`" | 4 | That route, plus a hub row |
| 12a-4 | "modelled on FR-4's builder" | 4 | Structure follows `rubric-builder.tsx` and `rubric/actions.ts` |
| 12a-5 | "Store as `InterviewCategory`" | 1, 4 | §5's model as specified |
| 12a-6 | "locks once any `InterviewCategoryScore` exists — a distinct lock condition from FR-4's" | 4 | Lock predicate counts `InterviewCategoryScore`, never `Score`; the two lock states are independent and both are exercised by hand |

### FR-12 — score and notes import

| # | Clause, verbatim | Slice | Ticked by |
|---|---|---|---|
| 12a | "*First Round Scores* — required columns: `Applicant Email` (or `Applicant Name` if email is unavailable)" | 5 | Mapping step requires at least one of the two roles; either alone is sufficient, neither is a blocker |
| 12b | "`Interviewer Name`" required column | 5 | Required role; a blank cell is a per-row blocker (it is half the upsert key) |
| 12c | "one column per configured `InterviewCategory`" | 5 | Every live `InterviewCategory` — the rows FR-12a creates — must be mapped to exactly one column before commit is offered |
| 12d | "and `Average`" | 5 | Required role → `InterviewResult.score` |
| 12e | "Two rows per applicant expected, one per interviewer" | 5 | Expected, not enforced. Preview reports the applicant count with 1 row and with 3+ |
| 12f | "matched to `InterviewCategory` rows by the same mapping table FR-2 uses" | 5 | Header→role/category table modelled on `mapping-controls.tsx`, auto-proposed by exact header text, admin-confirmed |
| 12g | "so a cycle that changes its interview rubric does not need a code change" | 5 | No category count or name is hardcoded anywhere; the layout iterates whatever FR-12a produced |
| 12h | "`Average` imports verbatim into `InterviewResult.score`" | 5 | Parsed to Float, never recomputed |
| 12i | "the category columns become `InterviewCategoryScore` rows" | 5 | One per mapped category per result |
| 12j | "does **not** recompute the average" | 5 | Asserted by a test over a row whose average disagrees |
| 12k | "or reject a row whose average disagrees with its categories" | 5 | Not a blocker, not a per-row error |
| 12l | "but it does flag the disagreement in the preview" | 5 | Non-blocking warning naming the rows and both numbers |
| 12m | "*First Round Notes* — required columns: `Applicant Email` (or `Applicant Name`), `Notes`" | 5 | Second sheet, own mapping, own required roles |
| 12n | "One row per applicant" | 5 | Enforced: a second row for one applicant is decision 49's collision on this sheet |
| 12o | "Each sheet is staged, previewed, and committed on its own schedule" | 5 | Two independent `InterviewImport` rows; neither reads the other's state |
| 12p | "scores and notes need not arrive together" | 5 | No cross-sheet gate anywhere, including on the commit button |
| 12q | "and the dashboard renders whichever half exists" | 6 | FR-14 treats a missing half as absent, not as a blocking empty state |
| 12r | "A sheet accepts repeated uploads" | 5 | A new upload replaces that sheet's staging rows; committed data is untouched until the new commit |
| 12s | "re-committing upserts on `(applicantId, interviewerName)` for scores" | 1, 5 | New `@@unique`, and `upsert` keyed on it |
| 12t | "and on `applicantId` for notes" | 5 | Existing `@@unique([applicantId])` |
| 12u | "rather than refusing a second file the way FR-3 refuses a second applicant CSV" | 5 | No `importCommittedAt` analogue exists for these sheets, deliberately |

### FR-13 — name reconciliation

| # | Clause, verbatim | Slice | Ticked by |
|---|---|---|---|
| 13a | "exact email match first" | 2 | Tier 1, `lib/reconciliation.ts` |
| 13b | "then exact name match" | 2 | Tier 2, on the normalized name |
| 13c | "then fuzzy name match above a similarity threshold" | 2 | Tier 3, decision 52's rule |
| 13d | "presented for confirmation" | 5 | A single fuzzy candidate is staged with tier + confidence and appears in a confirm list; commit is not offered while any fuzzy row is unticked |
| 13e | "then an unresolved queue the admin maps by hand" | 5 | Tier 4, with a search-by-name picker over the scoped pool |
| 13f | "Nothing imports silently under a guessed match" | 5 | 13d + commit blocked while any row is unresolved (decision 51) |
| 13g | "Matching is scoped to applicants who reached first round — `stageReached != WRITTEN`" | 2, 5 | The pool is built by the caller with that predicate; the pure matcher never sees anyone else |
| 13h | "not the full applicant pool" | 2 | Asserted by the test where an out-of-scope exact email match falls through to the queue |
| 13i | Decision 45: ">1 above threshold routes to the manual queue" | 2 | `AMBIGUOUS` outcome, all candidates carried |
| 13j | Decision 45: normalization — trim, collapse, case-fold, strip standalone single letters, strip non-alphanumerics | 2 | `normalizeMatchName`, tested independently of any tier |
| 13k | Decision 48: scoping removes the written-round-rejection false match | 2, 5 | Same as 13g; called out separately because it is the decision's own claim |
| 13l | Decision 49: two rows in one batch on the same applicant are flagged before commit | 2, 5 | `findBatchCollisions`, keyed per decision 50 |

### FR-14 — first-round reviewer dashboard

| # | Clause | Slice | Ticked by |
|---|---|---|---|
| 14a | "Round → First Round, then name" | 6 | Already built — `/r/[instanceId]?round=FIRST_ROUND` and the existing access-code card cover all three rounds |
| 14b | "average interview score per interviewer prominently" | 6 | One line per `InterviewResult`, largest type on the card |
| 14c | "per-category scores collapsed by default and expandable" | 6 | `<details>`, closed on load |
| 14d | "plus the interview notes" | 6 | `InterviewNotes.body`, with the interviewer's name |
| 14e | "category count follows the configured `InterviewCategory` rows … the layout must not assume" four | 6 | Iterated; a 6-category rubric renders without a change |
| 14f | "Demographics and written responses are hidden per §6" | 6 | `buildApplicantView(..., "FIRST_ROUND_REVIEWER")` — server-side projection, existing helper, no new visibility logic |
| 14g | "Reviewer votes YES or NO per applicant" | 6 | Explicit submit, one `FirstRoundVote` row |
| 14h | "No vote recorded means SKIP" | 6 | Absence of a row *is* the skip; no SKIP row is ever written in this round |

### FR-15 — first-round results

| # | Clause | Slice | Ticked by |
|---|---|---|---|
| 15a | "ranked by yes percentage descending, `yes / (yes + no)`, skips excluded from both" | 7 | `firstRoundSummary` in `lib/results.ts` |
| 15b | "Show raw counts alongside the percentage" | 7 | `9/11` beside `82%`, every row |
| 15c | Decision 46: tiebreak = raw non-skip count desc, then `sourceRowIndex` asc | 7 | Comparator, tested |
| 15d | "An applicant with zero non-skip votes … the count cell — not the row — carries a visual marker" | 7 | Marker on the `<TableCell>`, reusing FR-10's treatment; row styling untouched; **not** excluded from the list |
| 15e | "Selection and demographic-breakdown behavior mirrors FR-11's UI" | 7 | `selection-panel.tsx` reused as-is |
| 15f | "for every applicant in the first-round pool (`status = ACTIVE`, `stageReached = FIRST_ROUND`), write one `Decision` row at `stage = FIRST_ROUND`" | 7 | Pool recomputed server-side in the action, never taken from the request |
| 15g | "Selected: `outcome = ADVANCE`, `status` stays `ACTIVE`, `stageReached → SECOND_ROUND`" | 7 | Explicit; `status` deliberately untouched |
| 15h | "Not selected: `outcome = REJECT`, `status → REJECTED`, `stageReached` stays `FIRST_ROUND`" | 7 | Explicit |
| 15i | "Finalizing moves `Instance.currentStage → SECOND_ROUND`" | 7 | One field, and what makes 15j reachable |
| 15j | "load-bearing for this screen's post-finalize read-only state" | 7 | Server-side gate, same shape as clause 11e |
| 15k | "The confirmation panel names any applicant with zero non-skip votes before finalizing" | 7 | By name and count above the confirm button; **literal zero**, not a target shortfall |

---

## Proposed PRD changes

CLAUDE.md: a new ambiguity goes to §10 rather than being picked silently, and §5 changes before the schema does. All of this lands in Slice 0, alone, before any code.

### §7.3 — one new requirement, immediately before FR-12

> **FR-12a Interview rubric builder.** Before FR-12's score sheet can be mapped, the instance needs configured `InterviewCategory` rows — the interview rubric is its own instrument per decision 6, not shared with `RubricCategory`. Admin enters number of categories and max points per category, on its own page at `/instances/[id]/interview-rubric`, modelled on FR-4's builder. Store as `InterviewCategory`. The rubric locks once any `InterviewCategoryScore` exists — a distinct lock condition from FR-4's, since the two rubrics are different instruments scored at different times.

This closes a gap the plan had been filling without a citation: FR-12 presupposes configured categories and named no surface that creates them, so Slice 4 was building a screen no requirement asked for. It is now numbered work with its own clause ledger above.

### §10 — five new decisions

**50. Decision 49's collision key is the sheet's upsert key, not `applicantId`.** Read literally, 49 flags "any applicant with more than one resolved row in the batch" — but FR-12 *expects* two scores rows per applicant, one per interviewer, so the literal reading fires on every correctly imported applicant and the warning gets clicked through. **Resolved: the flagged set is exactly the set where a second row would overwrite a first** — `(applicantId, interviewerName)` on the scores sheet, `applicantId` on the notes sheet. That is 49's own stated reasoning ("the second row overwriting the first with nothing telling the admin it happened") applied to the key the upsert actually uses.

**51. Unresolved rows at commit. Resolved: commit is blocked until every staged row is either matched or explicitly skipped.** §5 says `InterviewImportRow` "is deleted at that sheet's commit," which is only true if nothing is left in the queue at that moment. This adds one outcome to the reconciliation UI — *not an applicant in this pool, skip this row* — for the rows that legitimately match nobody: an interviewer's own header row pasted twice, a candidate who withdrew, a written-round rejection who appears by mistake. A skipped row is a decision the admin made and a state the schema records, which is what distinguishes it from a row silently dropped.

**52. The fuzzy tier's comparison basis and threshold, amending 45.** Everything in the finding above. Decision 45's threshold rejects decision 45's own example (0.842 against 0.85) while admitting the example it names as a counter-case (0.917), and the two cannot be separated by any threshold on whole-string Jaro-Winkler because the required match scores strictly lower than the required non-match. **Resolved: exact normalized surname, matching given-name initial, Jaro-Winkler ≥ 0.78 on the given-name remainder.** The paragraph of 45 arguing for whole-string comparison is replaced, with the numbers, rather than left standing beside a rule that contradicts it.

**53. A single fuzzy candidate is confirmed by the admin, not auto-committed.** FR-13 already says "presented for confirmation," and 45 says nothing about what happens to a *single* match above threshold — only that multiple matches route to the queue. This makes the single-match path explicit, because the arithmetic leaves no alternative: `alexandra`/`alexander` (0.956) and `jason`/`jasmine` (0.853) both outscore `cici`/`cecilia` (0.796), so any rule that auto-commits the case the PRD wants auto-committed also auto-commits two different people onto one applicant record. A tick box is the whole cost of never doing that.

**54. Where the interview rubric builder lives. RESOLVED: its own page, `/instances/[id]/interview-rubric`, not a second section of `/rubric`.** FR-12 presupposes configured `InterviewCategory` rows and named no surface for them. A second section on the existing rubric page would put two instruments, two lock rules, and two "once any score exists" conditions on one screen — decision 6 already treats the written and interview rubrics as separate instruments precisely so they don't tangle, and a shared page reintroduces the tangle at the UI layer. Its own page, modelled on the existing builder and reusing `validateRubric`'s shape, keeps FR-4's lock semantics separate from the interview instrument's, which locks on `InterviewCategoryScore` rows rather than `Score` rows.

### §5 — data model additions

Three of these are already specified and only need implementing; two are new and need §5 changed first.

Already in §5, to be implemented in Slice 1: `InterviewCategory`, `InterviewCategoryScore`, `InterviewImportRow`, and `InterviewResult`'s `UNIQUE (applicantId, interviewerName)`.

**New — `InterviewImport`**, one row per instance per sheet:

```
InterviewImport                // FR-12 staging header. One per sheet, deleted at
  id, instanceId               //   that sheet's commit, taking its rows with it.
  sheet: SCORES | NOTES
  headers: jsonb               // the source file's header row, verbatim
  mapping: jsonb               // { columnIndex: role }, role being APPLICANT_EMAIL |
                               //   APPLICANT_NAME | INTERVIEWER_NAME | AVERAGE |
                               //   NOTES | CATEGORY:<interviewCategoryId> | IGNORED
  uploadedAt
  UNIQUE (instanceId, sheet)   // a re-upload replaces this row and cascades its
                               //   staged rows away, which is FR-12's "accepts
                               //   repeated uploads" without a second staging set
```

Why a table rather than a column on `Instance`: the two sheets have genuinely independent lifecycles under decision 47, and row existence is then the answer to "is this sheet staged?" — the same question `importCommittedAt` answers for FR-3, without a second nullable jsonb that two commits have to clear without stepping on each other. `InterviewImportRow` gains `importId` and keeps `instanceId` and `sheet` as §5 specifies, so its unique constraint is unchanged.

**New — `InterviewImportRow.skipped`**, a boolean carrying decision 51's third outcome, with raw-SQL CHECKs (Prisma cannot express them, same posture as `field-groups.ts`):

- `CHECK ((matchedApplicantId IS NULL) = (matchTier IS NULL))` — resolved means both or neither
- `CHECK ((matchTier = 'FUZZY') = (matchConfidence IS NOT NULL))` — §5 already says confidence is set only for FUZZY; this makes it a database guarantee
- `CHECK (NOT (skipped AND matchedApplicantId IS NOT NULL))` — a skipped row is not also a matched one

---

## `lib/reconciliation.ts` — the contract

Pure. No Prisma import, no database access, no `Round` enum. The caller does the `stageReached != WRITTEN` query and hands in plain strings; this module compares and scores and hands back a tier. Same posture as `lib/assignment.ts`, `lib/passes.ts` and `lib/roster.ts`.

```ts
export type MatchTier = "EMAIL" | "NAME" | "FUZZY";

/// One applicant in the scoped pool. Built by the caller from
/// `stageReached != WRITTEN`; this module has no opinion about who is eligible.
export interface Candidate { applicantId: string; email: string | null; displayName: string }

/// One staged row's identity columns, verbatim. Undefined where the sheet has
/// no such column at all, which is not the same as a blank cell — both are
/// treated as absent, and both are tested.
export interface RowIdentity { email?: string | null; name?: string | null }

export type MatchOutcome =
  | { kind: "MATCHED"; applicantId: string; tier: MatchTier; confidence: number | null }
  | { kind: "AMBIGUOUS"; tier: MatchTier; candidates: { applicantId: string; confidence: number | null }[] }
  | { kind: "UNRESOLVED"; reason: "NO_IDENTITY" | "NO_CANDIDATES" };

export function normalizeMatchName(raw: string | null | undefined): string;
export function jaroWinkler(a: string, b: string): number;
export function matchRow(row: RowIdentity, pool: readonly Candidate[]): MatchOutcome;

/// Decision 49, keyed per decision 50. Pure; the caller supplies the resolved
/// rows and which sheet they came from.
export function findBatchCollisions(
  rows: readonly { rowIndex: number; applicantId: string; interviewerName?: string | null }[],
  sheet: "SCORES" | "NOTES",
): { applicantId: string; key: string; rowIndexes: number[] }[];
```

`normalizeMatchEmail` is **not** added here — `normalizeEmail` in `lib/import/preview.ts:17` already does trim, NFC, lowercase, blank→null, and its own comment names FR-12/FR-13 as the reason it exists. Reconciliation imports it. Two normalizers for the join key is exactly how the preview and the commit end up disagreeing.

### Normalization, in order

NFC → lowercase → delete non-alphanumeric characters, **keeping whitespace** → collapse whitespace runs → trim → drop tokens of length 1 → rejoin with single spaces.

Deleting punctuation rather than replacing it with a space is load-bearing and got caught by running it: replacing turns `O'Brien` into `o brien`, whose leading `o` is then eaten by the single-letter rule, leaving `brien`. Deleting gives `obrien`, which is what the case requires.

Dropping single-letter tokens *after* punctuation is deleted handles `A.` and `A` in one rule rather than two.

### Cascade

1. **Tier 1 — email.** Row email normalized; blank or absent skips the tier. Exactly one pool candidate with that email → `MATCHED/EMAIL`. `UNIQUE (instanceId, email)` makes a two-candidate outcome unreachable through the app, but the ambiguity branch exists and is tested anyway — the constraint is instance-scoped and this pool is a subset, so nothing here should depend on that reasoning holding.
2. **Tier 2 — exact name.** Normalized row name against normalized `displayName`. Blank-after-normalization skips the tier. One → `MATCHED/NAME`. More than one → `AMBIGUOUS/NAME`.
3. **Tier 3 — fuzzy.** Decision 52's rule over the same normalized names. One above threshold → `MATCHED/FUZZY` with confidence. More than one → `AMBIGUOUS/FUZZY` with every candidate and its score.
4. **Tier 4.** No email and no name after normalization → `UNRESOLVED/NO_IDENTITY`. Had something to compare and nothing matched → `UNRESOLVED/NO_CANDIDATES`.

A row that reaches `UNRESOLVED/NO_CANDIDATES` carries **no** "did you mean" list. The manual queue offers a search over the whole scoped pool instead, which is a different affordance from a ranked guess and reads as one.

### Test cases — these are the spec

`lib/reconciliation.test.ts`. If a test disagrees with this list, the test is wrong.

**Normalization, tested without any tier:**
1. `"  Jordan   Lee  "` → `"jordan lee"`
2. `"Jordan A. Lee"` → `"jordan lee"`; `"Jordan A Lee"` → `"jordan lee"`
3. `"O'Brien, Casey"` → `"obrien casey"`; `"OBrien, Casey"` → `"obrien casey"` (equal)
4. `"Mary-Jane Smith"` → `"maryjane smith"` — and a note in the test that `"Mary Jane Smith"` does **not** normalize to the same string; the fuzzy tier is what covers that pair
5. `"..."` and `"  "` → `""`, and `""` is treated as absent, never fed to the comparison
6. NFC: a decomposed `é` and a composed `é` normalize equal

**Jaro-Winkler, pinned to published reference values** so a future refactor cannot silently change the metric: `MARTHA/MARHTA` 0.961, `DWAYNE/DUANE` 0.840, `DIXON/DICKSONX` 0.813, `CRATE/TRACE` 0.733, identical strings 1.0, either side empty 0.0.

**Tier 1 — exact email:**
7. `"jordan.lee@usc.edu"` against the same → `MATCHED/EMAIL`, cascade stops (asserted by a pool where the name would have matched someone else)
8. `"  Jordan.Lee@USC.EDU  "` → `MATCHED/EMAIL`
9. Email matches an applicant **not in the pool** (`stageReached = WRITTEN`, so the caller excluded them) → falls through, and with no name match ends `UNRESOLVED/NO_CANDIDATES`
10. Row email blank, and row email absent → tier 1 skipped, tier 2 runs
11. Two pool candidates share an email → `AMBIGUOUS/EMAIL`

**Tier 2 — exact name:**
12. `"Jordan Lee"` → `"Jordan Lee"`, no email on row → `MATCHED/NAME`
13. Two pool candidates both `"Jordan Lee"` → `AMBIGUOUS/NAME`, both carried — **ambiguity queues at any tier, not only the fuzzy one**
14. `"Jordan A. Lee"` → `"Jordan Lee"` → `MATCHED/NAME`, **tier 2 not tier 3**, asserted on the tier field
15. `"O'Brien, Casey"` → `"OBrien, Casey"` → `MATCHED/NAME`, asserted on the tier field so the case cannot silently start passing via the fuzzy threshold

**Tier 3 — fuzzy:**
16. `"Cici Fang"` → pool `"Cecilia Fang"` alone → `MATCHED/FUZZY`, confidence ≈ 0.796
17. `"Cecelia Fang"` → `"Cecilia Fang"` → `MATCHED/FUZZY`, confidence ≈ 0.894
18. `"Mia Chen"` → pool `"Nia Chen"` alone → **not matched** (initial gate) → `UNRESOLVED/NO_CANDIDATES`
19. `"Meagan Woods"` → pool has both `"Megan Woods"` and `"Maegan Woods"` → `AMBIGUOUS/FUZZY`, **both** candidates with their scores
20. `"Cici Fang"` → pool `"Cecilia Fong"` → not matched; the surname must be exact
21. `"Sam Park"` → pool `"Pam Park"` → not matched (initial gate)
22. Regression guard on the finding: assert `jaroWinkler("cici fang","cecilia fang") < 0.85` and `jaroWinkler("mia chen","nia chen") > 0.85`, with a comment naming decision 52. If someone reverts to whole-string scoring, this test tells them why they cannot.

**Tier 4:**
23. No email and no name at all → `UNRESOLVED/NO_IDENTITY`
24. Name present, nothing matches → `UNRESOLVED/NO_CANDIDATES` — a distinct reason, and no candidate list
25. Name normalizes to `""` (e.g. `"."`, `"J."`) → treated as blank → `UNRESOLVED/NO_IDENTITY`, never compared as an empty string
26. Empty pool → `UNRESOLVED/NO_CANDIDATES`, not a crash

**Cross-cutting:**
27. Two rows, same applicant: one carries the correct email, the other a typo'd email and a good name. Row A → `MATCHED/EMAIL`, row B → falls through tier 1 and lands `MATCHED/NAME`. **Same `applicantId` from both**, asserted directly.
28. `findBatchCollisions`, SCORES: two rows, same applicant, different interviewer names → **no collision**
29. `findBatchCollisions`, SCORES: two rows, same applicant, same interviewer name → collision, both `rowIndexes`
30. `findBatchCollisions`, NOTES: two rows, same applicant → collision regardless of interviewer name
31. `findBatchCollisions`: interviewer name compared case- and whitespace-insensitively, so `"Alex Kim"` and `"alex  kim"` collide

---

## Slices

Each is a commit. `npm run verify` before every one; the clause ledger re-ticked against the diff, not against this document.

### Slice 0 — PRD §7.3 FR-12a, §10 decisions 50–54, and the §5 additions, alone

**Doc-only. No code, no schema, no migration.** Four edits to `PRD.md`:

1. **§7.3** — FR-12a inserted immediately before FR-12, verbatim as written above.
2. **§10** — decisions 50, 51, 52, 53, 54, in that order, after decision 49.
3. **§5** — the `InterviewImport` model, `InterviewImportRow.skipped`, and the three CHECK constraints.
4. Status line and version bump.

`plans/phase-5.md` lands in the same commit. Decision 52 carries the measured numbers, because a threshold change with no evidence in front of it is the kind of thing a successor reverts.

**This is where I stop.** The diff gets read before Slice 1 touches the schema.

### Slice 1 — schema and migration

`InterviewCategory`, `InterviewCategoryScore`, `InterviewImport`, `InterviewImportRow` (+ `skipped`), `InterviewResult`'s new `@@unique`, and the `ImportSheet` / `MatchTier` / `InterviewImportRole` enums. The three CHECKs go in raw migration SQL. The Phase-0 TODO comment on `InterviewResult` (`prisma/schema.prisma:528-531`) is deleted — open decision 6 is answered by this slice.

Then, and this is a numbered step rather than a reminder: **restart `next dev`.** CLAUDE.md's Phase 3 lesson — `npm run verify` reads the regenerated client off disk and passes completely while the running server serves the old one.

`prisma/checks/unique-constraints.ts` gains the new constraints, asserted through raw SQL as SQLSTATE 23505 naming the index, since Prisma will reject a duplicate client-side without the statement reaching Postgres. Re-run by hand after the migrate; they are not part of `verify`.

### Slice 2 — `lib/reconciliation.ts`, pure

The module and its 31 cases. No UI, no database, nothing importing it yet. This is the slice the phase is judged on.

### Slice 3 — seed cohort and fixtures

- `prisma/seed/first-round.ts`: writes `Decision` rows at `stage = WRITTEN` and `stageReached = FIRST_ROUND` for a deterministic cohort, and moves `Instance.currentStage` to `FIRST_ROUND` — the same end state `finalizeWritten` produces, so dev and production cannot diverge on what "advanced" means.
- Appends ~8 applicants at fixed `sourceRowIndex` values above the existing 150, with pinned names: Cecilia Fang, Megan Woods, Maegan Woods, Casey O'Brien, Nia Chen, Jordan Lee, and two more. Rows 1–150 and their ids are untouched, so existing screenshots, bookmarks and `Applicant.data` keys survive.
- `prisma/fixtures/s26-1r-scores.csv` and `s26-1r-notes.csv`, synthetic, `example.com` addresses, every free-text cell prefixed `SYNTHETIC`, plus a `.gitignore` exception in the same shape the existing fixture has.
- A hazard checklist in `prisma/fixtures/README.md` matching the existing one's discipline: the Cici/Cecilia pair, a trailing-whitespace email, a middle initial present in one file only, `O'Brien, Casey` against `OBrien, Casey`, the Meagan/Megan/Maegan triple, a `Mia Chen` row against a pool holding only `Nia Chen`, **three deliberately wrong names** for BUILD_PLAN's gate, a row whose average disagrees with its categories, a duplicated `(applicant, interviewer)` pair for decision 49, and a row with neither email nor name.

### Slice 4 — FR-12a: the interview rubric builder

Ticked against clauses 12a-1 to 12a-6. `/instances/[id]/interview-rubric`, modelled on `rubric-builder.tsx` and reusing `validateRubric`'s shape. Its lock is `InterviewCategoryScore` rows, not `Score` rows — a different instrument with a different lock condition, which is decision 54's reason for it not being a section of `/rubric`. Hub row added. Both lock states get exercised by hand: a written rubric locked while the interview rubric is still open, and the reverse.

### Slice 5 — FR-12 and FR-13: upload → map → reconcile → commit

**Opens with a PRD decision, before any code.** Decision 55: a category score outside `0..maxPoints` is flagged at preview and imported anyway, never rejected — the owner's call, agreed at the end of Slice 1, consistent with FR-12's stance on an average that disagrees with its categories. It arises because `InterviewCategory` has no `minPoints` (FR-12a asks only for max points, and decision 40's floor exists for FR-4's *input* control, whereas these numbers arrive from a file). Written into §10 and read before it is implemented, same as 50–54.

The largest slice, and the one clause 12a–12u is ticked against. Four steps per sheet, both sheets sharing every component and differing only in their required roles:

1. **Upload** — `parseCsv` (`lib/import/parse-csv.ts`, already handles BOM, CRLF, quoted newlines, ragged rejection), then `InterviewImport` + `InterviewImportRow` rows. A re-upload replaces the `InterviewImport` row and cascades.
2. **Map** — headers to roles, auto-proposed by exact header text against the live `InterviewCategory` names, admin-confirmed. Exact comparison only; the existing fixture's `Black` / `Black or African American` hazard is the standing reminder of why `startsWith` is not acceptable here.
3. **Reconcile** — every row through `matchRow` against the scoped pool. Four lists: resolved (email/name), fuzzy-awaiting-tick, ambiguous, unresolved. The fuzzy list shows the row's name, the candidate's name, and the confidence. The unresolved list offers a pool search and a *skip* control.
4. **Preview and commit** — the disagreement warning (12l), the 12e row-count report, decision 49's collisions, and the blocker list. Commit is offered only when every row is matched or skipped (decision 51). One transaction, upserting on the sheet's key, then deleting the `InterviewImport` row.

The commit transaction follows `finalizeWritten`'s hard-won shape: **bulk statements, not a loop of upserts.** 150 sequential round trips blew Prisma's 5000 ms interactive-transaction limit in Phase 4 and failed with P2028 on a realistic cohort; ~80 interview rows is smaller but the same failure mode, and the fix is fewer statements rather than a longer timeout.

### Slice 6 — FR-14: first-round reviewer dashboard

`/r/[instanceId]/list` branches on `session.rd`. The first-round branch lists every applicant with `status = ACTIVE` and `stageReached = FIRST_ROUND` — no `Assignment` rows, because FR-14 and `FirstRoundVote` describe every first-round reviewer voting on every applicant, and neither mentions assignment. Detail view via `buildApplicantView(..., "FIRST_ROUND_REVIEWER")`, which already gives §6's answer server-side. Vote submit is explicit; no row means SKIP, and no SKIP row is ever written.

Same phone-first constraints as Phase 3: full-width tap targets at `min-h-14`, `active:` alongside `hover:` because hover never fires on touch.

### Slice 7 — FR-15: results, selection, finalize

`/instances/[id]/first-round-results`. `firstRoundSummary` and its comparator join `lib/results.ts` beside `scoreSummary` and `rankApplicants` — the module's own header already anticipates this ("FR-15 already says first-round results mirror this behaviour, so there will be a second surface"). `selection-panel.tsx` and the demographic helpers are reused unchanged. `finalizeFirstRound` mirrors `finalizeWritten` structurally — stage guard, server-recomputed pool, unknown-id refusal, audit row inside the transaction, bulk delete-then-insert, `timeout: 20000` — with 15f–15j's semantics, which are spelled out in the PRD and are built exactly as stated rather than by analogy to FR-11.

### Slice 8 — hub, CLAUDE.md, PRD status

**Owed: a §10 decision on `InterviewResult` id instability.** A re-import deletes and re-inserts `InterviewResult` and `InterviewCategoryScore` rows rather than updating them in place, so their ids do not survive a re-upload even though decision 47's upsert key is respected and nothing is duplicated. Confirmed against the database after the owner's second import: twelve results, forty-eight category scores, no duplicates, and a single shared `createdAt` showing the rows had been replaced.

Nothing references these ids today, so this is a recorded consequence rather than a defect — but it is the same shape as the `InterviewCategory` instability decision 61 had to fix, and it is where a future feature would break. If anything ever needs to reference an `InterviewResult` id across a re-import — a comment thread on an interview, an audit trail of who changed a score — that reference is what fails, silently, the next time a corrected sheet is uploaded. Write it up so the next person meets it in §10 rather than in production.

Hub rows for the interview rubric, the two imports, and first-round results, each reporting real state in the decision-36 idiom. The CLAUDE.md Testing addition below. PRD status line and version bump.

---

## The CLAUDE.md addition

Into the Testing section's list, after `lib/roster.ts`:

```markdown
- **`lib/reconciliation.ts`** — FR-13's four-tier cascade: exact email, exact name,
  fuzzy name, unresolved. Normalization (single-letter tokens, non-alphanumerics,
  NFC, case) is tested on its own, before any tier, because every tier depends on
  it. Jaro-Winkler is pinned to published reference pairs so a refactor cannot
  quietly change the metric. Two cases are regression guards rather than
  behaviour: `cici fang`/`cecilia fang` scores **below** 0.85 whole-string and
  `mia chen`/`nia chen` scores **above** it, which is why decision 52 scores the
  given name against an exact surname instead. Ambiguity queues at *every* tier,
  not only the fuzzy one, and a single fuzzy candidate is confirmed by a human
  before commit — the nickname the PRD wants matched is less similar to its own
  given name than two different people's names are to each other, and no
  threshold fixes that.
```

And the paragraph beneath the list gains `lib/reconciliation.test.ts` alongside BUILD_PLAN phases 2 and 6 as a place where the cases are the spec.

---

## Files

**New:** `lib/reconciliation.ts`, `lib/reconciliation.test.ts`; `prisma/seed/first-round.ts`; `prisma/fixtures/s26-1r-scores.csv`, `s26-1r-notes.csv`; `app/instances/[id]/interview-rubric/` (page, actions, builder); `app/instances/[id]/interviews/` (upload, mapping, reconcile, preview, actions — both sheets); `app/instances/[id]/first-round-results/` (page, table, actions); `app/r/[instanceId]/first-round/` (list, detail, vote actions); one migration directory.

**Modified:** `prisma/schema.prisma`; `prisma/checks/unique-constraints.ts`; `prisma/seed.ts`, `prisma/fixtures/README.md`, `.gitignore`; `lib/results.ts` (+ its test); `app/r/[instanceId]/list/page.tsx` (round branch); `app/instances/[id]/page.tsx` (hub rows); `PRD.md`; `CLAUDE.md`; `plans/phase-5.md`.

**Reused unchanged:** `lib/import/parse-csv.ts`, `normalizeEmail` from `lib/import/preview.ts`, `lib/fields.ts`, `buildApplicantView` from `lib/review.ts`, `lib/demographics.ts`, `selection-panel.tsx`, `lib/reviewer-auth.ts`, the reviewers page's access-code card.

---

## Verification

**Automated** — `npm run verify` at every slice; `prisma/checks/unique-constraints.ts` by hand after Slice 1's migrate.

**By hand, in a browser, which is what has actually caught things in this project:**

1. Re-seed. Confirm the first-round cohort exists and `/instances/[id]` reports first round.
2. Build a 4-category interview rubric; then a 6-category one, and confirm nothing in the import or the dashboard assumed four.
3. Upload `s26-1r-scores.csv`. Walk the mapping table. Confirm the Cici/Cecilia row lands in the **fuzzy confirm** list with its score visible and not committed; the Meagan row in the **ambiguous** list with both candidates; the Mia Chen row in the **unresolved** queue with no "did you mean"; and **all three deliberately wrong names** in the unresolved queue. That is BUILD_PLAN's gate.
4. Confirm commit is refused while anything is unresolved. Skip one row, map another by hand, commit.
5. Re-upload the same file. Confirm it stages rather than being refused, and that committing again upserts rather than duplicating — row count unchanged.
6. Upload the notes sheet **without** having committed scores, and confirm it works alone. Then check the dashboard renders with only one half present.
7. Confirm the row whose average disagrees with its categories is flagged in the preview and imported anyway, with `score` matching the sheet.
8. On a phone: sign in for the first round, read an applicant, expand the categories, vote, confirm the vote sticks.
9. Results: hand-check yes% on three applicants including one with skips, confirm raw counts sit beside the percentage, confirm a zero-vote applicant is **listed** with a marked count cell.
10. Finalize. Check `Decision` rows at `stage = FIRST_ROUND` for the whole pool, the `status`/`stageReached` split on both sides, `currentStage = SECOND_ROUND`, the page gone read-only, and an `AuditLog` row. Then reload a second tab left open across the finalize and confirm it is refused with a sentence rather than a stack trace.

---

## Two things I am flagging rather than building

**Comma-inverted names.** `"Lee, Jordan"` against a pool `"Jordan Lee"` fails tier 2 (token order differs) and fails decision 52 (the last token is `jordan`, not `lee`), so it lands in the manual queue. That is safe but it queues a whole category of rows if an interviewer's sheet uses `Last, First` throughout. Comparing token *sets* would fix it and would also match a genuine `Lee Jordan` to `Jordan Lee`, which is the failure this system exists to prevent. Left in the queue deliberately; worth revisiting with real S26 data in hand rather than guessed at now.

**The process fix still beats all of this.** FR-13's own note: adding an email field to the interview scoring form eliminates the entire class of problem for one form field. Everything above exists because that field was missing in S26, and it should be said out loud to whoever runs the next cycle before they run it.
