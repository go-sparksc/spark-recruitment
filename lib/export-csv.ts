// FR-20's per-stage CSVs. Pure — no database, no Prisma client.
//
// "One-click export of the entire instance as JSON, plus per-stage CSVs (all
// applicants with scores, decisions by stage, final class with emails)." The
// JSON is the lossless artifact and the one FR-20's round trip reads back; these
// three are convenience derivatives for a person opening a spreadsheet, and they
// are deliberately outside that round trip — a decision row rendered with an
// applicant's name in it cannot reconstruct a `Decision`.
//
// **Cells are written verbatim, per PRD decision 90.** A cell beginning `=`,
// `+`, `-` or `@` is a formula to Excel and Sheets, and the usual mitigation is
// to prefix it with a tab or apostrophe — which alters the exported value. That
// is refused here: every importer in this system is emphatic that the source
// wins and the tool does not rewrite what a human recorded (FR-12 on a
// disagreeing average, decision 55 on clamping, decision 59 on rounding), and an
// export that mangled an essay to defend a spreadsheet application would be the
// only place in the product that breaks it.

/// One cell, RFC 4180. Quoted when it contains a comma, a quote, or a line
/// break; inner quotes doubled, which is the standard's own escape.
///
/// **None of the three files below currently carries free text** — they are
/// identity, status, scores, decisions and emails — so today the only live case
/// is a name containing a comma or an apostrophe-adjacent quote. The line-break
/// branch is deliberately here anyway: `Applicant.displayName` is whatever a
/// form export contained, the obvious next column anyone adds is a written
/// response, and an unquoted newline does not fail loudly. It ends the record
/// early and shifts every subsequent column into the wrong field, in a file that
/// still opens.
///
/// `null` and `undefined` become an empty cell rather than the strings "null"
/// and "undefined". A blank in a spreadsheet reads as absent, which is what they
/// mean; the words read as data.
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";

  const text = String(value);
  if (text === "") return "";

  // Decision 90: no formula-injection prefixing. The value goes out as it came
  // in, quoted where the format requires quoting and not otherwise.
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export type CsvValue = string | number | boolean | null | undefined;

/// A whole file: a header row and its rows, CRLF-delimited.
///
/// **CRLF, not LF.** RFC 4180 specifies it, and Excel on Windows is the tool
/// these are actually opened in. A trailing newline closes the last record.
export function toCsv(headers: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/// How a number renders in a cell. Fixed to two places for the score columns so
/// a column of averages lines up when read, and blank rather than 0 where there
/// is nothing — an unscored applicant is not a zero-scoring one, which is the
/// same distinction `scoreSummary` protects by returning null.
function decimal(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

/// The anonymous label a written reviewer sees, and the handle Phase 6 learned
/// to render beside a name after two applicants called "Diego Hoffmann" proved
/// indistinguishable on the FR-18 grid.
function handle(sourceRowIndex: number): string {
  return `Applicant ${sourceRowIndex}`;
}

// ---------------------------------------------------------------------------
// All applicants with scores
// ---------------------------------------------------------------------------

/// One reviewer's complete scores for one applicant, already narrowed to the
/// live rubric by the caller.
export interface CsvReviewerScores {
  /// `{ rubricCategoryId: points }` for every category this reviewer scored.
  points: Readonly<Record<string, number>>;
}

export interface CsvApplicantRow {
  sourceRowIndex: number;
  displayName: string;
  email: string | null;
  status: string;
  stageReached: string;
  reviews: readonly CsvReviewerScores[];
}

export interface CsvRubricCategory {
  id: string;
  name: string;
}

/// "All applicants with scores."
///
/// One row per applicant, one column per rubric category, plus FR-10's two
/// numbers. **The per-category cell is the mean across reviewers**, and the
/// Average column is the mean of the reviewer averages rather than of the raw
/// cells — `scoreSummary` is explicit that the former is authoritative, and
/// deriving the headline number a second way here is how two surfaces come to
/// disagree about one applicant.
///
/// Only complete reviews count, which is decision 1's sense of the word and the
/// reason "Reviews" can read 2 where three reviewers were assigned.
export function buildApplicantsCsv(
  applicants: readonly CsvApplicantRow[],
  categories: readonly CsvRubricCategory[],
): string {
  const headers = [
    "Applicant",
    "Name",
    "Email",
    "Status",
    "Stage reached",
    "Reviews",
    ...categories.map((category) => category.name),
    "Average",
    "Variance",
  ];

  const rows = applicants.map((applicant) => {
    // **Only complete reviews count**, which is `reviewerAverage`'s own contract
    // and decision 1's sense of the word: a reviewer who scored two of four
    // categories has an average over a different denominator than everyone
    // else's, so including it would make one applicant's number incomparable
    // with the next one's while looking exactly as authoritative.
    const complete = applicant.reviews.filter((review) =>
      categories.every((category) => review.points[category.id] !== undefined),
    );

    const reviewerAverages = complete.map(
      (review) =>
        categories.reduce((sum, category) => sum + (review.points[category.id] ?? 0), 0) /
        categories.length,
    );

    const completedCount = reviewerAverages.length;
    const average =
      completedCount === 0
        ? null
        : reviewerAverages.reduce((sum, value) => sum + value, 0) / completedCount;
    const variance =
      average === null
        ? null
        : reviewerAverages.reduce((sum, value) => sum + (value - average) ** 2, 0) / completedCount;

    const perCategory = categories.map((category) => {
      if (completedCount === 0) return "";
      const total = complete.reduce((sum, review) => sum + (review.points[category.id] ?? 0), 0);
      return decimal(total / completedCount);
    });

    return [
      handle(applicant.sourceRowIndex),
      applicant.displayName,
      applicant.email,
      applicant.status,
      applicant.stageReached,
      completedCount,
      ...perCategory,
      decimal(average),
      decimal(variance),
    ];
  });

  return toCsv(headers, rows);
}

// ---------------------------------------------------------------------------
// Decisions by stage
// ---------------------------------------------------------------------------

export interface CsvDecisionRow {
  sourceRowIndex: number;
  displayName: string;
  email: string | null;
  stage: string;
  outcome: string;
  actor: string;
  decidedAt: Date | string;
}

/// "Decisions by stage."
///
/// One row per `Decision`, which is one per applicant per stage — the shape
/// `UNIQUE (applicantId, stage)` already guarantees. Decision 41 is why a
/// rejection is here as well as an advance: "the record of 'we reviewed X and
/// passed on them' is as real as the record of advancing someone."
///
/// **`actor` is a column rather than being dropped**, because SYSTEM and ADMIN
/// mean genuinely different things at `stage = SECOND_ROUND` — a pass's own
/// unanimous result versus a person overriding it (decisions 69 and 71) — and
/// that difference is exactly what a successor reconstructing a cycle needs.
export function buildDecisionsCsv(decisions: readonly CsvDecisionRow[]): string {
  const headers = ["Applicant", "Name", "Email", "Stage", "Outcome", "Decided by", "Decided at"];

  const rows = decisions.map((decision) => [
    handle(decision.sourceRowIndex),
    decision.displayName,
    decision.email,
    decision.stage,
    decision.outcome,
    decision.actor,
    decision.decidedAt instanceof Date ? decision.decidedAt.toISOString() : decision.decidedAt,
  ]);

  return toCsv(headers, rows);
}

// ---------------------------------------------------------------------------
// Final class with emails
// ---------------------------------------------------------------------------

export interface CsvFinalClassRow {
  sourceRowIndex: number;
  displayName: string;
  email: string | null;
}

/// "Final class with emails."
///
/// The new Sparklets, in the form the club actually mails from. Deliberately
/// narrow: name, email, and the handle that tells two people with the same name
/// apart. Everything else about them is in the JSON and in the applicants CSV,
/// and a mailing list with twelve extra columns is a mailing list someone has to
/// edit before using.
export function buildFinalClassCsv(sparklets: readonly CsvFinalClassRow[]): string {
  const headers = ["Applicant", "Name", "Email"];
  const rows = sparklets.map((sparklet) => [
    handle(sparklet.sourceRowIndex),
    sparklet.displayName,
    sparklet.email,
  ]);
  return toCsv(headers, rows);
}
