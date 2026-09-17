// FR-12's preview for both interview sheets. Pure — no database, no Prisma.
//
// Same job as lib/import/preview.ts does for FR-3, and the same reasoning: this
// is the last cheap moment to catch a bad file. Unlike FR-3 the mistake here is
// recoverable — decision 47 makes a re-upload an upsert rather than a refusal —
// but a wrong interview score that nobody noticed still reaches FR-15's ranking
// looking exactly like a right one.
//
// Everything this module decides is written down in PRD §10:
//
//   decision 51  commit is blocked while any row is unresolved or unconfirmed
//   decision 53  a FUZZY match needs a human tick before it counts as resolved
//   decision 50  collisions are keyed on the sheet's upsert key
//   decision 55  a numeric category score out of range is flagged, not rejected
//   decision 59  a blank, non-numeric or fractional cell writes no row
//
// The one rule underneath all of them: **the sheet is the record of what the
// interviewers decided, and the importer is not entitled to overrule it.** It
// may refuse to store a value it cannot represent, and it must say so — but it
// never rounds, clamps, or recomputes.

import { findBatchCollisions, type BatchCollision } from "@/lib/reconciliation";
import type { CategoryLike, InterviewSheet, MappedColumns } from "@/lib/import/interview-mapping";

/// How a staged row currently stands. Mirrors the InterviewImportRow columns
/// rather than the match outcome, because by preview time the admin has had a
/// chance to change them.
export interface StagedRow {
  rowIndex: number;
  cells: Record<string, string>;
  matchedApplicantId: string | null;
  matchTier: "EMAIL" | "NAME" | "FUZZY" | "MANUAL" | null;
  matchConfidence: number | null;
  skipped: boolean;
  /// A FUZZY row the admin has ticked. Not a database column: `matchTier` moves
  /// to MANUAL on confirmation, which is what records that a human decided.
  /// Kept in the type so the caller can express "confirmed" without the preview
  /// having to infer it.
  confirmed?: boolean;
}

/// PRD decisions 55 and 59. One per unusable or suspect category cell.
export type CellIssue =
  | { kind: "OUT_OF_RANGE"; categoryName: string; raw: string; value: number; maxPoints: number }
  | { kind: "NOT_A_NUMBER"; categoryName: string; raw: string }
  | { kind: "NOT_AN_INTEGER"; categoryName: string; raw: string; value: number }
  | { kind: "BLANK"; categoryName: string };

export interface PreviewRow {
  rowIndex: number;
  skipped: boolean;
  applicantId: string | null;
  matchTier: StagedRow["matchTier"];
  matchConfidence: number | null;
  /// Needs the admin's tick before commit — PRD decision 53.
  awaitingConfirmation: boolean;
  /// Verbatim, for display beside whatever the importer made of it.
  rawEmail: string;
  rawName: string;
  interviewerName: string;
  notes: string;
  /// PRD decision 120, notes sheet. One entry per column mapped as a transcript
  /// question, in the sheet's left-to-right order, which becomes
  /// `InterviewQuestion.ordinal`. `prompt` is the header text verbatim.
  transcript: { columnIndex: number; prompt: string; body: string }[];
  /// PRD decision 120, scores sheet. Only categories that produced BOTH a
  /// storable score and a non-empty note — the note is stored on the score row,
  /// so a note without one has nowhere to go. `notesWithoutScore` counts the
  /// ones dropped that way so the preview can say so.
  categoryNotes: { interviewCategoryId: string; body: string }[];
  notesWithoutScore: string[];
  /// The interviewer's own summing-up. Empty string when unmapped or blank; the
  /// commit stores null rather than "".
  overallNote: string;
  /// PRD decision 120. Null in three situations that deliberately read alike:
  /// unmapped, blank, or a value that is neither yes nor no. None may read NO.
  recommendation: "YES" | "NO" | null;
  rawRecommendation: string;
  /// True when `rawRecommendation` was non-blank and did not parse. Warns; never
  /// blocks — the recommendation is advisory and nothing tallies it.
  unreadableRecommendation: boolean;
  /// Only the cells that produced a storable value. Decision 59: a blank,
  /// non-numeric or fractional cell writes no row, and the row's other
  /// categories still import.
  categoryPoints: { interviewCategoryId: string; points: number }[];
  issues: CellIssue[];
  /// The sheet's own number, parsed but never recomputed. Null when no average
  /// column is mapped at all, which PRD decision 120 permits.
  average: number | null;
  rawAverage: string;
  /// What will actually be stored as `InterviewResult.score`: the sheet's own
  /// number when there is one, otherwise the mean of this row's storable
  /// category cells. Null only when neither is available, which blocks.
  score: number | null;
  /// PRD decision 120. True when `score` is the mean rather than the sheet's own
  /// number, which is stored on the row and labelled at every render. Never let
  /// a computed average pass for a recorded one — that, and not the arithmetic,
  /// is what decision 6 forbids.
  scoreIsComputed: boolean;
  /// `InterviewResult.score` is a non-null Float, so a row that can produce no
  /// score at all cannot become a result. Blocking rather than skipped —
  /// silently dropping an interview is what FR-13's "nothing imports silently"
  /// rules out, and the admin can fix the file or mark the row as not importing.
  ///
  /// **Two distinct causes since decision 120**, which `unreadableAverageCause`
  /// tells apart so the blocker can say what to do. A mapped average column whose
  /// cell will not parse is a typo in one cell. No average column at all, plus a
  /// row with no storable category cell either, is a row with nothing in it.
  ///
  /// Scores sheet only; the notes sheet has no average.
  unreadableAverage: boolean;
  unreadableAverageCause: "STATED" | "COMPUTED" | null;
  /// Clause 12b. Half of `(applicantId, interviewerName)`, which is what makes a
  /// re-upload an upsert rather than a duplicate under decision 47 — a blank one
  /// would silently merge every unnamed interviewer's rows into a single result.
  missingInterviewerName: boolean;
  /// Set only when every configured category produced a storable value and the
  /// stated average disagrees with their mean. See `averageDisagreement`.
  averageDisagrees: { stated: number; computed: number } | null;
}

export interface InterviewPreviewFindings {
  rows: PreviewRow[];

  resolvedCount: number;
  skippedCount: number;
  /// Unresolved and not skipped. Decision 51 blocks on these.
  unresolvedCount: number;
  /// Matched at FUZZY and not yet ticked. Decision 53 blocks on these.
  awaitingConfirmationCount: number;

  collisions: BatchCollision[];
  /// Applicants whose row count is not the two FR-12 expects. Reported, never
  /// blocking — clause 12e says "expected", not "required".
  rowCountOutliers: { applicantId: string; rowCount: number }[];

  blockers: string[];
  warnings: string[];
  canCommit: boolean;
}

export interface InterviewPreviewInput {
  sheet: InterviewSheet;
  rows: readonly StagedRow[];
  columns: MappedColumns;
  categories: readonly CategoryLike[];
  /// Blockers from `validateMapping`, threaded through so the commit gate is one
  /// list rather than two the caller has to remember to check together.
  mappingErrors: readonly string[];
  /// For naming applicants in collision warnings. Missing ids fall back to the
  /// id, which is ugly and correct — better than a blank where a name goes.
  applicantNames: ReadonlyMap<string, string>;
  /// The source file's header row. PRD decision 120 needs it because a transcript
  /// question's prompt IS its header text — there is no other place the question
  /// is written down, and no builder screen where someone typed it.
  headers: readonly string[];
}

const cell = (row: StagedRow, column: number | null): string =>
  column === null ? "" : (row.cells[String(column)] ?? "");

/// Parse a category cell into a storable value, or into the reason it is not
/// one. PRD decisions 55 and 59 in one function, because they are one question
/// asked of one cell and splitting them would let the two answers drift.
///
/// **The order matters.** Blank is checked before "is it a number", because
/// `Number("")` is 0 and an empty cell must never import as a zero — the written
/// round's rule that an unscored category is the absence of a row, never a zero,
/// is exactly the rule decision 59 carries over.
/// **A cell can produce both a value and an issue, and that is the whole point
/// of decision 55.** An out-of-range score is flagged AND stored; a non-numeric
/// one is flagged and stored nowhere. Two independent optional fields say that;
/// a discriminated union would force the two decisions to share one answer and
/// is what pushed an earlier draft of this into a type cast.
interface CellReading {
  /// Absent when nothing storable was read. Never confuse with 0, which is a
  /// legal score — check `undefined`, not falsiness.
  points?: number;
  issue?: CellIssue;
}

function readCategoryCell(raw: string, category: CategoryLike): CellReading {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return { issue: { kind: "BLANK", categoryName: category.name } };
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { issue: { kind: "NOT_A_NUMBER", categoryName: category.name, raw } };
  }

  // Decision 59: flagged rather than rounded. `points` is an Int and rounding
  // would rewrite what the interviewer recorded — the same objection decision 55
  // makes to clamping.
  if (!Number.isInteger(value)) {
    return { issue: { kind: "NOT_AN_INTEGER", categoryName: category.name, raw, value } };
  }

  // Decision 55: flagged and STORED, which is why both fields are set here and
  // only here. Two-directional, and 0 is not flagged — there is no floor, and 0
  // is a real thing for an interviewer to award.
  if (value < 0 || value > category.maxPoints) {
    return {
      points: value,
      issue: {
        kind: "OUT_OF_RANGE",
        categoryName: category.name,
        raw,
        value,
        maxPoints: category.maxPoints,
      },
    };
  }

  return { points: value };
}

/// Whether the sheet's average disagrees with its own categories.
///
/// **Only compared when every configured category produced a storable value.**
/// A mean over three of four categories is a different quantity from the one the
/// interviewer wrote down, and reporting it as a disagreement would blame the
/// average for a missing cell that is already flagged in its own right.
///
/// Rounded to four decimals before comparing: the sheet carries 3.75 and the
/// mean of 4, 4, 3, 4 is 3.75, and floating point should not make that a finding.
function averageDisagreement(
  stated: number | null,
  points: readonly number[],
  categoryCount: number,
): { stated: number; computed: number } | null {
  if (stated === null || categoryCount === 0 || points.length !== categoryCount) return null;

  const computed = points.reduce((sum, value) => sum + value, 0) / categoryCount;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return round(stated) === round(computed) ? null : { stated, computed };
}

/// PRD decision 120's fallback score: the mean of whatever this row produced.
///
/// **Over the cells that were storable, not over the configured categories.** A
/// row with three readable scores out of four averages those three. Dividing by
/// four instead would silently treat the fourth as a zero, which is the "unscored
/// is not a zero" rule decision 59 exists to hold, arriving from a third side.
/// The missing cell is separately flagged, so the admin is not being told a
/// half-truth — they are told the cell is missing and shown what the rest average
/// to.
///
/// Null over an empty list rather than NaN: no cells means no score, and a NaN
/// reaching `InterviewResult.score` would be a non-null Float column holding
/// something Postgres will take and nothing can render.
function computeAverage(points: readonly number[]): number | null {
  if (points.length === 0) return null;
  return points.reduce((sum, value) => sum + value, 0) / points.length;
}

/// PRD decision 120. Case-insensitive, trimmed, whole-string.
///
/// **Anything else is null, never NO.** A sheet that wrote "maybe", "y", or a
/// timestamp recorded no recommendation, and reading an unparsed value as a
/// rejection would invent a judgement the interviewer did not make. The caller
/// warns about it instead.
function readRecommendation(raw: string): "YES" | "NO" | null {
  const key = raw.trim().toLowerCase();
  if (key === "yes") return "YES";
  if (key === "no") return "NO";
  return null;
}

export function buildInterviewPreview(
  input: InterviewPreviewInput,
): InterviewPreviewFindings {
  const { sheet, columns, categories } = input;

  const rows: PreviewRow[] = input.rows.map((row) => {
    const categoryPoints: PreviewRow["categoryPoints"] = [];
    const categoryNotes: PreviewRow["categoryNotes"] = [];
    const notesWithoutScore: string[] = [];
    const issues: CellIssue[] = [];

    if (sheet === "SCORES") {
      for (const category of categories) {
        const column = columns.categoryColumns.get(category.id) ?? null;
        const result = readCategoryCell(cell(row, column), category);
        if (result.issue !== undefined) issues.push(result.issue);
        // `!== undefined`, never truthiness: 0 is a legal score and would be
        // dropped by a falsy check, which is the same "unscored is not a zero"
        // confusion decision 59 exists to prevent, arriving from the other side.
        if (result.points !== undefined) {
          categoryPoints.push({ interviewCategoryId: category.id, points: result.points });
        }

        // PRD decision 120. The note is a column on InterviewCategoryScore, so
        // it can only be stored if that row exists — and decision 59 means it
        // does not exist when the score cell was blank or unreadable. Recorded
        // as dropped rather than rescued onto InterviewResult, which would put
        // a judgement about one category somewhere that does not say which.
        const noteColumn = columns.categoryNoteColumns.get(category.id) ?? null;
        const noteBody = cell(row, noteColumn).trim();
        if (noteBody !== "") {
          if (result.points !== undefined) {
            categoryNotes.push({ interviewCategoryId: category.id, body: noteBody });
          } else {
            notesWithoutScore.push(category.name);
          }
        }
      }
    }

    const rawAverage = cell(row, columns.averageColumn);
    const parsedAverage = rawAverage.trim() === "" ? Number.NaN : Number(rawAverage.trim());
    const average = Number.isFinite(parsedAverage) ? parsedAverage : null;

    // PRD decision 120. The mapping decides which of the two rules applies, not
    // the cell: a mapped column that will not parse is an error to fix, while no
    // column at all is a sheet that never offered one.
    const hasAverageColumn = columns.averageColumn !== null;
    const computed = computeAverage(categoryPoints.map((p) => p.points));
    const score = hasAverageColumn ? average : computed;
    const scoreIsComputed = sheet === "SCORES" && !hasAverageColumn && score !== null;

    const rawRecommendation = cell(row, columns.recommendationColumn);
    const recommendation = readRecommendation(rawRecommendation);

    return {
      rowIndex: row.rowIndex,
      skipped: row.skipped,
      applicantId: row.matchedApplicantId,
      matchTier: row.matchTier,
      matchConfidence: row.matchConfidence,
      // A FUZZY row is a proposal until a human ticks it. Confirmation moves the
      // tier to MANUAL, so a row still reading FUZZY has not been ticked.
      awaitingConfirmation: row.matchTier === "FUZZY" && row.confirmed !== true,
      rawEmail: cell(row, columns.emailColumn),
      rawName: cell(row, columns.nameColumn),
      interviewerName: cell(row, columns.interviewerColumn),
      notes: cell(row, columns.notesColumn),
      transcript: columns.transcriptColumns.map((columnIndex) => ({
        columnIndex,
        prompt: input.headers[columnIndex] ?? `Column ${columnIndex + 1}`,
        body: cell(row, columnIndex),
      })),
      categoryNotes,
      notesWithoutScore,
      overallNote: cell(row, columns.overallNoteColumn).trim(),
      recommendation,
      rawRecommendation,
      unreadableRecommendation: rawRecommendation.trim() !== "" && recommendation === null,
      categoryPoints,
      issues,
      average,
      rawAverage,
      score,
      scoreIsComputed,
      unreadableAverage: sheet === "SCORES" && score === null,
      unreadableAverageCause:
        sheet === "SCORES" && score === null ? (hasAverageColumn ? "STATED" : "COMPUTED") : null,
      missingInterviewerName:
        sheet === "SCORES" && cell(row, columns.interviewerColumn).trim() === "",
      // Suppressed when the score was computed: a mean cannot disagree with
      // itself, and reporting it would fire on every row of a sheet with no
      // average column — 123 of them, in the file this decision was built for.
      averageDisagrees: scoreIsComputed
        ? null
        : averageDisagreement(
            average,
            categoryPoints.map((p) => p.points),
            categories.length,
          ),
    };
  });

  const live = rows.filter((row) => !row.skipped);
  const resolved = live.filter((row) => row.applicantId !== null);
  const unresolved = live.filter((row) => row.applicantId === null);
  const awaiting = live.filter((row) => row.awaitingConfirmation);

  const collisions = findBatchCollisions(
    resolved
      .filter((row) => !row.awaitingConfirmation)
      .map((row) => ({
        rowIndex: row.rowIndex,
        applicantId: row.applicantId as string,
        interviewerName: row.interviewerName,
      })),
    sheet,
  );

  // Clause 12e: "Two rows per applicant expected, one per interviewer."
  const perApplicant = new Map<string, number>();
  for (const row of resolved) {
    perApplicant.set(row.applicantId as string, (perApplicant.get(row.applicantId as string) ?? 0) + 1);
  }
  const rowCountOutliers =
    sheet === "SCORES"
      ? [...perApplicant]
          .filter(([, count]) => count !== 2)
          .map(([applicantId, rowCount]) => ({ applicantId, rowCount }))
          .sort((a, b) => a.rowCount - b.rowCount)
      : [];

  const name = (applicantId: string) => input.applicantNames.get(applicantId) ?? applicantId;

  const blockers: string[] = [...input.mappingErrors];

  if (live.length === 0) {
    blockers.push("Every row is skipped. There would be nothing to import.");
  }

  // Decision 51. The escape hatch is in the sentence, because a blocker that
  // does not say what to do is a dead end.
  if (unresolved.length > 0) {
    blockers.push(
      `${unresolved.length} row${unresolved.length === 1 ? "" : "s"} ${
        unresolved.length === 1 ? "is" : "are"
      } not matched to an applicant. Map each one by hand, or mark it as not an applicant in ` +
        `this pool.`,
    );
  }

  // Two per-row blockers the schema forces rather than the requirement choosing.
  // Both name the row, because "some row is wrong" in a 160-row file is not
  // something an admin can act on.
  // Two causes, two sentences. PRD decision 120 split what used to be one
  // blocker, because "fix the Average column" is useless advice on a sheet that
  // has no Average column — and that is now a supported sheet, not a broken one.
  const statedUnreadable = live.filter((row) => row.unreadableAverageCause === "STATED");
  if (statedUnreadable.length > 0) {
    blockers.push(
      `${statedUnreadable.length} row${statedUnreadable.length === 1 ? "" : "s"} ${
        statedUnreadable.length === 1 ? "has" : "have"
      } no readable Average (row${statedUnreadable.length === 1 ? "" : "s"} ` +
        `${statedUnreadable.map((r) => r.rowIndex).join(", ")}). The average is imported as the ` +
        `sheet states it and is never recomputed from the categories, so a row without one ` +
        `cannot be imported. Fix the file and upload it again, or mark those rows as not ` +
        `importing.`,
    );
  }

  const computedUnreadable = live.filter((row) => row.unreadableAverageCause === "COMPUTED");
  if (computedUnreadable.length > 0) {
    blockers.push(
      `${computedUnreadable.length} row${computedUnreadable.length === 1 ? "" : "s"} ${
        computedUnreadable.length === 1 ? "has" : "have"
      } no category score that could be read (row${computedUnreadable.length === 1 ? "" : "s"} ` +
        `${computedUnreadable.map((r) => r.rowIndex).join(", ")}). This sheet has no Average ` +
        `column, so each interview's score is the average of its categories — and ${
          computedUnreadable.length === 1 ? "this row has" : "these rows have"
        } none to average. Fix the file and upload it again, or mark ${
          computedUnreadable.length === 1 ? "that row" : "those rows"
        } as not importing.`,
    );
  }

  const noInterviewer = live.filter((row) => row.missingInterviewerName);
  if (noInterviewer.length > 0) {
    blockers.push(
      `${noInterviewer.length} row${noInterviewer.length === 1 ? "" : "s"} ${
        noInterviewer.length === 1 ? "has" : "have"
      } no interviewer name (row${noInterviewer.length === 1 ? "" : "s"} ` +
        `${noInterviewer.map((r) => r.rowIndex).join(", ")}). It is half of what keeps two ` +
        `interviewers' scores for one applicant apart.`,
    );
  }

  // Decision 53. Stated as the tick it is, not as an error.
  if (awaiting.length > 0) {
    blockers.push(
      `${awaiting.length} fuzzy match${awaiting.length === 1 ? "" : "es"} ${
        awaiting.length === 1 ? "has" : "have"
      } not been confirmed. A close name match is a suggestion until someone agrees with it.`,
    );
  }

  // Decisions 49 and 50. Blocking, the same posture FR-3 takes toward duplicate
  // emails: committing would let the second row overwrite the first with nothing
  // saying it happened. Skipping one side resolves it, which is why the sentence
  // says so.
  if (collisions.length > 0) {
    blockers.push(
      `${collisions.length} applicant${collisions.length === 1 ? "" : "s"} ${
        collisions.length === 1 ? "has" : "have"
      } more than one row that would be saved to the same place: ` +
        collisions
          .map(
            (c) =>
              `${name(c.applicantId)}${
                c.interviewerName === null ? "" : ` (${c.interviewerName})`
              } on rows ${c.rowIndexes.join(" and ")}`,
          )
          .join("; ") +
        ". Skip the row you do not want, or fix the file and upload it again.",
    );
  }

  const warnings: string[] = [];

  const disagreeing = live.filter((row) => row.averageDisagrees !== null);
  if (disagreeing.length > 0) {
    // Clause 12l. FR-12 is explicit that this does not block: "interviewers
    // sometimes adjust it deliberately".
    warnings.push(
      `${disagreeing.length} row${disagreeing.length === 1 ? "'s" : "s'"} Average disagrees with ` +
        `the mean of its categories — ` +
        disagreeing
          .slice(0, 5)
          .map(
            (row) =>
              `row ${row.rowIndex} states ${row.averageDisagrees?.stated} against ${row.averageDisagrees?.computed.toFixed(2)}`,
          )
          .join(", ") +
        `${disagreeing.length > 5 ? ", and others" : ""}. The sheet's number is imported as it stands.`,
    );
  }

  const issueCount = (kind: CellIssue["kind"]) =>
    live.reduce((total, row) => total + row.issues.filter((i) => i.kind === kind).length, 0);

  const outOfRange = issueCount("OUT_OF_RANGE");
  if (outOfRange > 0) {
    // Decision 55: imported anyway. Saying so is the point — a warning that
    // reads like a refusal makes the admin hunt for data that is already there.
    warnings.push(
      `${outOfRange} category score${outOfRange === 1 ? " is" : "s are"} outside the range that ` +
        `category is scored out of. They are imported as they stand.`,
    );
  }

  const unreadable = issueCount("NOT_A_NUMBER") + issueCount("NOT_AN_INTEGER");
  if (unreadable > 0) {
    // Decision 59: no row written, and the rest of the interview still imports.
    warnings.push(
      `${unreadable} category cell${unreadable === 1 ? "" : "s"} could not be read as a whole ` +
        `number. Those categories are left unscored; the rest of each interview imports normally.`,
    );
  }

  const blank = issueCount("BLANK");
  if (blank > 0) {
    warnings.push(
      `${blank} category cell${blank === 1 ? " is" : "s are"} empty. Those categories are left ` +
        `unscored rather than imported as a zero.`,
    );
  }

  // PRD decision 120. Said plainly and up front, because a score the reader
  // takes for the interviewers' own number is exactly what decision 6 forbids,
  // and the preview is where they first meet it.
  const computedScores = live.filter((row) => row.scoreIsComputed).length;
  if (computedScores > 0) {
    warnings.push(
      `This sheet has no Average column, so ${computedScores} interview score${
        computedScores === 1 ? " is" : "s are"
      } the average of ${computedScores === 1 ? "its" : "their"} own categories rather than a ` +
        `number the sheet states. They are labelled as computed everywhere they appear.`,
    );
  }

  // Decision 55's posture: reported, with what happens to the data said out
  // loud, rather than a refusal the admin has to reverse-engineer.
  const droppedNotes = live.reduce((total, row) => total + row.notesWithoutScore.length, 0);
  if (droppedNotes > 0) {
    const affected = live.filter((row) => row.notesWithoutScore.length > 0);
    warnings.push(
      `${droppedNotes} category note${droppedNotes === 1 ? "" : "s"} sit${
        droppedNotes === 1 ? "s" : ""
      } beside a score that could not be read, on row${affected.length === 1 ? "" : "s"} ` +
        `${affected.slice(0, 5).map((r) => r.rowIndex).join(", ")}${
          affected.length > 5 ? ", and others" : ""
        }. A category's note is stored on its score, so ${
          droppedNotes === 1 ? "it will" : "those will"
        } not import. The rest of each interview imports normally.`,
    );
  }

  const unreadableRecommendations = live.filter((row) => row.unreadableRecommendation);
  if (unreadableRecommendations.length > 0) {
    warnings.push(
      `${unreadableRecommendations.length} recommendation${
        unreadableRecommendations.length === 1 ? "" : "s"
      } could not be read as yes or no (row${unreadableRecommendations.length === 1 ? "" : "s"} ` +
        `${unreadableRecommendations.slice(0, 5).map((r) => r.rowIndex).join(", ")}${
          unreadableRecommendations.length > 5 ? ", and others" : ""
        }). ${
          unreadableRecommendations.length === 1 ? "It is" : "They are"
        } imported as no recommendation rather than as a No, and nothing counts them either way.`,
    );
  }

  if (rowCountOutliers.length > 0) {
    const one = rowCountOutliers.filter((o) => o.rowCount === 1).length;
    const many = rowCountOutliers.length - one;
    warnings.push(
      `FR-12 expects two rows per applicant, one per interviewer. ` +
        [
          one > 0 ? `${one} applicant${one === 1 ? " has" : "s have"} only one` : null,
          many > 0 ? `${many} ${many === 1 ? "has" : "have"} more than two` : null,
        ]
          .filter((part) => part !== null)
          .join(", and ") +
        ".",
    );
  }

  return {
    rows,
    resolvedCount: resolved.length,
    skippedCount: rows.length - live.length,
    unresolvedCount: unresolved.length,
    awaitingConfirmationCount: awaiting.length,
    collisions,
    rowCountOutliers,
    blockers,
    warnings,
    canCommit: blockers.length === 0,
  };
}
