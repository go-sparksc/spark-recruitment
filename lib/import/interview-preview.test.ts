// FR-12's preview, and the PRD decisions it implements. These cases are the
// spec for decisions 55 and 59 in particular: both are about what the importer
// does with a cell it cannot take at face value, and neither is observable
// anywhere else until Slice 5's screen exists.

import { describe, expect, it } from "vitest";

import { proposeMapping, resolveMapping, type CategoryLike } from "@/lib/import/interview-mapping";
import {
  buildInterviewPreview,
  type StagedRow,
} from "@/lib/import/interview-preview";

const CATEGORIES: CategoryLike[] = [
  { id: "cat-a", name: "Communication", maxPoints: 4 },
  { id: "cat-b", name: "Motivation", maxPoints: 4 },
];

const HEADERS = [
  "Applicant Email",
  "Applicant Name",
  "Interviewer Name",
  "Communication",
  "Motivation",
  "Average",
];

const COLUMNS = resolveMapping(
  proposeMapping(HEADERS, CATEGORIES, "SCORES"),
  new Set(CATEGORIES.map((c) => c.id)),
);

const NAMES = new Map([
  ["app-1", "Cecilia Fang"],
  ["app-2", "Jordan Lee"],
]);
/// A resolved scores row. Defaults describe the ordinary case — matched by
/// email, both categories scored, average agreeing — so each test changes only
/// the thing it is about.
function row(overrides: Partial<StagedRow> & { cells?: Partial<Record<string, string>> } = {}): StagedRow {
  const { cells, ...rest } = overrides;
  return {
    rowIndex: 1,
    cells: {
      "0": "cecilia.fang@example.com",
      "1": "Cecilia Fang",
      "2": "Alex Kim",
      "3": "4",
      "4": "3",
      "5": "3.5",
      ...cells,
    },
    matchedApplicantId: "app-1",
    matchTier: "EMAIL",
    matchConfidence: null,
    skipped: false,
    ...rest,
  };
}

function preview(rows: StagedRow[], mappingErrors: string[] = []) {
  return buildInterviewPreview({
    sheet: "SCORES",
    rows,
    columns: COLUMNS,
    categories: CATEGORIES,
    mappingErrors,
    applicantNames: NAMES,
    headers: HEADERS,
  });
}

// ---------------------------------------------------------------------------
// Decision 55 — a numeric score out of range
// ---------------------------------------------------------------------------

describe("decision 55: out-of-range category scores", () => {
  it("stores the value AND flags it", () => {
    // The heart of the decision: flagged, not rejected, not clamped. A 5 in a
    // column scored out of 4 imports as a 5.
    const findings = preview([row({ cells: { "3": "5" } })]);

    expect(findings.rows[0].categoryPoints).toContainEqual({
      interviewCategoryId: "cat-a",
      points: 5,
    });
    expect(findings.rows[0].issues).toContainEqual({
      kind: "OUT_OF_RANGE",
      categoryName: "Communication",
      raw: "5",
      value: 5,
      maxPoints: 4,
    });
  });

  it("flags below zero as well as above the maximum", () => {
    const findings = preview([row({ cells: { "3": "-1" } })]);
    expect(findings.rows[0].issues[0].kind).toBe("OUT_OF_RANGE");
    expect(findings.rows[0].categoryPoints).toContainEqual({
      interviewCategoryId: "cat-a",
      points: -1,
    });
  });

  it("does NOT flag zero", () => {
    // There is no floor — FR-12a asks only for max points — and 0 is a real
    // thing for an interviewer to award.
    const findings = preview([row({ cells: { "3": "0", "5": "1.5" } })]);
    expect(findings.rows[0].issues).toEqual([]);
    expect(findings.rows[0].categoryPoints).toContainEqual({
      interviewCategoryId: "cat-a",
      points: 0,
    });
  });

  it("does not block the commit", () => {
    // Unlike an unresolved row under decision 51: an out-of-range score is a
    // fact about the file, not a question only the admin can answer.
    const findings = preview([
      row({ cells: { "3": "9" } }),
      row({ rowIndex: 2, cells: { "2": "Robin Diaz" } }),
    ]);

    expect(findings.canCommit).toBe(true);
    expect(findings.warnings.join(" ")).toContain("imported as they stand");
  });
});

// ---------------------------------------------------------------------------
// Decision 59 — blank, non-numeric, fractional
// ---------------------------------------------------------------------------

describe("decision 59: unreadable category cells", () => {
  it("writes no row for a blank cell, and never a zero", () => {
    const findings = preview([row({ cells: { "3": "" } })]);

    expect(findings.rows[0].categoryPoints.map((p) => p.interviewCategoryId)).toEqual(["cat-b"]);
    expect(findings.rows[0].issues).toContainEqual({ kind: "BLANK", categoryName: "Communication" });
  });

  it("treats a whitespace-only cell as blank", () => {
    const findings = preview([row({ cells: { "3": "   " } })]);
    expect(findings.rows[0].issues[0].kind).toBe("BLANK");
  });

  it("writes no row for non-numeric text, and flags it", () => {
    const findings = preview([row({ cells: { "3": "n/a" } })]);

    expect(findings.rows[0].categoryPoints.map((p) => p.interviewCategoryId)).toEqual(["cat-b"]);
    expect(findings.rows[0].issues).toContainEqual({
      kind: "NOT_A_NUMBER",
      categoryName: "Communication",
      raw: "n/a",
    });
  });

  it("flags a decimal rather than rounding it", () => {
    // `points` is an Int. Rounding 3.5 to 4 would rewrite what the interviewer
    // recorded — decision 55's objection to clamping, from the other direction.
    const findings = preview([row({ cells: { "3": "3.5" } })]);

    expect(findings.rows[0].categoryPoints.map((p) => p.interviewCategoryId)).toEqual(["cat-b"]);
    expect(findings.rows[0].issues).toContainEqual({
      kind: "NOT_AN_INTEGER",
      categoryName: "Communication",
      raw: "3.5",
      value: 3.5,
    });
  });

  it("costs the category, never the interview", () => {
    // The property all three readings share: one unreadable cell leaves the rest
    // of the row importing normally.
    const findings = preview([row({ cells: { "3": "" } })]);
    expect(findings.rows[0].categoryPoints).toHaveLength(1);
    expect(findings.canCommit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Clause 12j / 12k / 12l — the average
// ---------------------------------------------------------------------------

describe("the average", () => {
  it("imports the sheet's number verbatim and never recomputes it", () => {
    const findings = preview([row({ cells: { "5": "4.9" } })]);
    expect(findings.rows[0].average).toBe(4.9);
  });

  it("flags a disagreement without blocking", () => {
    // 4 and 3 average 3.5; the sheet says 4.5.
    const findings = preview([row({ cells: { "5": "4.5" } })]);

    expect(findings.rows[0].averageDisagrees).toEqual({ stated: 4.5, computed: 3.5 });
    expect(findings.canCommit).toBe(true);
    expect(findings.warnings.join(" ")).toContain("imported as it stands");
  });

  it("does not report a disagreement when the numbers agree", () => {
    expect(preview([row()]).rows[0].averageDisagrees).toBeNull();
  });

  it("does not compare when a category did not produce a value", () => {
    // A mean over one of two categories is a different quantity from the one the
    // interviewer wrote down. Blaming the average for a missing cell would
    // report the same problem twice and misattribute it once.
    const findings = preview([row({ cells: { "3": "" } })]);
    expect(findings.rows[0].averageDisagrees).toBeNull();
  });

  it("tolerates floating-point representation", () => {
    // 4 and 3 -> 3.5 exactly; but a rubric of three categories averaging to
    // 3.3333… must not read as a disagreement against a sheet saying 3.3333.
    const three: CategoryLike[] = [...CATEGORIES, { id: "cat-c", name: "Fit", maxPoints: 4 }];
    const columns = resolveMapping(
      { "0": "APPLICANT_EMAIL", "2": "INTERVIEWER_NAME", "3": "CATEGORY:cat-a", "4": "CATEGORY:cat-b", "5": "AVERAGE", "6": "CATEGORY:cat-c" },
      new Set(three.map((c) => c.id)),
    );

    const findings = buildInterviewPreview({
      sheet: "SCORES",
      rows: [row({ cells: { "3": "4", "4": "3", "6": "3", "5": "3.3333" } })],
      columns,
      categories: three,
      mappingErrors: [],
      applicantNames: NAMES,
      headers: HEADERS,
    });

    expect(findings.rows[0].averageDisagrees).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Decisions 51 and 53 — what blocks the commit
// ---------------------------------------------------------------------------

describe("commit gate", () => {
  it("blocks on an unresolved row and says how to clear it", () => {
    const findings = preview([row({ matchedApplicantId: null, matchTier: null })]);

    expect(findings.canCommit).toBe(false);
    expect(findings.unresolvedCount).toBe(1);
    expect(findings.blockers.join(" ")).toContain("not an applicant in this pool");
  });

  it("does not block on a skipped row", () => {
    // Decision 51's escape hatch: skipping is a decision the admin made.
    const findings = preview([
      row({ matchedApplicantId: null, matchTier: null, skipped: true }),
      row({ rowIndex: 2, cells: { "2": "Robin Diaz" } }),
    ]);

    expect(findings.canCommit).toBe(true);
    expect(findings.skippedCount).toBe(1);
  });

  it("blocks on an unconfirmed fuzzy match — decision 53", () => {
    const findings = preview([row({ matchTier: "FUZZY", matchConfidence: 0.796 })]);

    expect(findings.canCommit).toBe(false);
    expect(findings.awaitingConfirmationCount).toBe(1);
    expect(findings.blockers.join(" ")).toContain("suggestion until someone agrees");
  });

  it("clears once the fuzzy match is confirmed", () => {
    const findings = preview([
      row({ matchTier: "FUZZY", matchConfidence: 0.796, confirmed: true }),
      row({ rowIndex: 2, cells: { "2": "Robin Diaz" } }),
    ]);

    expect(findings.canCommit).toBe(true);
    expect(findings.awaitingConfirmationCount).toBe(0);
  });

  it("blocks when every row is skipped", () => {
    expect(preview([row({ skipped: true })]).canCommit).toBe(false);
  });

  it("carries mapping errors through as blockers", () => {
    const findings = preview([row()], ["No column is marked as the Average."]);
    expect(findings.canCommit).toBe(false);
    expect(findings.blockers).toContain("No column is marked as the Average.");
  });
});

// ---------------------------------------------------------------------------
// Decisions 49 and 50 — batch collisions
// ---------------------------------------------------------------------------

describe("batch collisions", () => {
  it("does not flag two interviewers on one applicant", () => {
    // FR-12's expected shape. This is the case decision 49 read literally would
    // have fired on.
    const findings = preview([
      row({ rowIndex: 1, cells: { "2": "Alex Kim" } }),
      row({ rowIndex: 2, cells: { "2": "Robin Diaz" } }),
    ]);

    expect(findings.collisions).toEqual([]);
    expect(findings.canCommit).toBe(true);
  });

  it("blocks on two rows that would overwrite each other, naming the applicant", () => {
    const findings = preview([
      row({ rowIndex: 1, cells: { "2": "Alex Kim" } }),
      row({ rowIndex: 2, cells: { "2": "Alex Kim" } }),
    ]);

    expect(findings.canCommit).toBe(false);
    expect(findings.blockers.join(" ")).toContain("Cecilia Fang");
    expect(findings.blockers.join(" ")).toContain("rows 1 and 2");
  });

  it("lets a skip resolve a collision", () => {
    const findings = preview([
      row({ rowIndex: 1, cells: { "2": "Alex Kim" } }),
      row({ rowIndex: 2, cells: { "2": "Alex Kim" }, skipped: true }),
      row({ rowIndex: 3, cells: { "2": "Robin Diaz" } }),
    ]);

    expect(findings.collisions).toEqual([]);
    expect(findings.canCommit).toBe(true);
  });

  it("does not count an unconfirmed fuzzy row as a collision yet", () => {
    // It is already blocking for its own reason; reporting it twice would send
    // the admin to fix a duplicate that confirming may not create.
    const findings = preview([
      row({ rowIndex: 1, cells: { "2": "Alex Kim" } }),
      row({ rowIndex: 2, cells: { "2": "Alex Kim" }, matchTier: "FUZZY", matchConfidence: 0.8 }),
    ]);

    expect(findings.collisions).toEqual([]);
    expect(findings.awaitingConfirmationCount).toBe(1);
    expect(findings.canCommit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clause 12e — two rows per applicant expected
// ---------------------------------------------------------------------------

describe("row counts per applicant", () => {
  it("reports an applicant with only one row, without blocking", () => {
    const findings = preview([row()]);

    expect(findings.rowCountOutliers).toEqual([{ applicantId: "app-1", rowCount: 1 }]);
    expect(findings.canCommit).toBe(true);
    expect(findings.warnings.join(" ")).toContain("two rows per applicant");
  });

  it("reports nothing when every applicant has exactly two", () => {
    const findings = preview([
      row({ rowIndex: 1, cells: { "2": "Alex Kim" } }),
      row({ rowIndex: 2, cells: { "2": "Robin Diaz" } }),
    ]);

    expect(findings.rowCountOutliers).toEqual([]);
  });

  it("reports an applicant with three", () => {
    const findings = preview([
      row({ rowIndex: 1, cells: { "2": "Alex Kim" } }),
      row({ rowIndex: 2, cells: { "2": "Robin Diaz" } }),
      row({ rowIndex: 3, cells: { "2": "Sam Patel" } }),
    ]);

    expect(findings.rowCountOutliers).toEqual([{ applicantId: "app-1", rowCount: 3 }]);
    expect(findings.canCommit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The notes sheet
// ---------------------------------------------------------------------------

describe("the notes sheet", () => {
  const notesHeaders = ["Applicant Email", "Your Name", "Notes"];
  const notesColumns = resolveMapping(
    proposeMapping(notesHeaders, CATEGORIES, "NOTES"),
    new Set(CATEGORIES.map((c) => c.id)),
  );

  const notesRow = (overrides: Partial<StagedRow> = {}): StagedRow => ({
    rowIndex: 1,
    cells: { "0": "cecilia.fang@example.com", "1": "Alex Kim", "2": "SYNTHETIC: good interview." },
    matchedApplicantId: "app-1",
    matchTier: "EMAIL",
    matchConfidence: null,
    skipped: false,
    ...overrides,
  });

  const notesPreview = (rows: StagedRow[]) =>
    buildInterviewPreview({
      sheet: "NOTES",
      rows,
      columns: notesColumns,
      categories: CATEGORIES,
      mappingErrors: [],
      applicantNames: NAMES,
      headers: HEADERS,
    });

  it("reads no category scores and reports no row-count outliers", () => {
    // Clause 12m: one row per applicant, and no categories on this sheet.
    const findings = notesPreview([notesRow()]);

    expect(findings.rows[0].categoryPoints).toEqual([]);
    expect(findings.rows[0].issues).toEqual([]);
    expect(findings.rowCountOutliers).toEqual([]);
    expect(findings.canCommit).toBe(true);
  });

  it("collides on the applicant alone, whatever the interviewer", () => {
    const findings = notesPreview([
      notesRow({ rowIndex: 1, cells: { "0": "cecilia.fang@example.com", "1": "Alex Kim", "2": "a" } }),
      notesRow({ rowIndex: 2, cells: { "0": "cecilia.fang@example.com", "1": "Robin Diaz", "2": "b" } }),
    ]);

    expect(findings.collisions).toHaveLength(1);
    expect(findings.canCommit).toBe(false);
  });

  it("carries the notes body through", () => {
    expect(notesPreview([notesRow()]).rows[0].notes).toBe("SYNTHETIC: good interview.");
  });
});

// ---------------------------------------------------------------------------
// Blockers the schema forces rather than the requirement choosing
// ---------------------------------------------------------------------------

describe("rows that cannot become an InterviewResult", () => {
  it("blocks a row with no readable Average, naming it", () => {
    // InterviewResult.score is a non-null Float and FR-12 forbids recomputing
    // the average from the categories, so there is nothing to store. Blocking
    // rather than skipping: silently dropping an interview is what FR-13's
    // "nothing imports silently" rules out.
    const findings = preview([row({ rowIndex: 4, cells: { "5": "" } })]);

    expect(findings.rows[0].unreadableAverage).toBe(true);
    expect(findings.canCommit).toBe(false);
    expect(findings.blockers.join(" ")).toContain("row 4");
    expect(findings.blockers.join(" ")).toContain("never recomputed");
  });

  it("blocks a non-numeric Average too", () => {
    expect(preview([row({ cells: { "5": "n/a" } })]).canCommit).toBe(false);
  });

  it("blocks a row with no interviewer name — clause 12b", () => {
    // Half of (applicantId, interviewerName). A blank one would merge every
    // unnamed interviewer's rows into a single result at commit.
    const findings = preview([row({ rowIndex: 7, cells: { "2": "  " } })]);

    expect(findings.rows[0].missingInterviewerName).toBe(true);
    expect(findings.canCommit).toBe(false);
    expect(findings.blockers.join(" ")).toContain("row 7");
  });

  it("does not block on either when the row is skipped", () => {
    const findings = preview([
      row({ rowIndex: 1, cells: { "5": "", "2": "" }, skipped: true }),
      row({ rowIndex: 2, cells: { "2": "Alex Kim" } }),
      row({ rowIndex: 3, cells: { "2": "Robin Diaz" } }),
    ]);

    expect(findings.canCommit).toBe(true);
  });

  it("does not apply either rule to the notes sheet", () => {
    // No average, and InterviewNotes.interviewerName is nullable — only one
    // interviewer of the pair writes them.
    const headers = ["Applicant Email", "Notes"];
    const columns = resolveMapping(
      proposeMapping(headers, CATEGORIES, "NOTES"),
      new Set(CATEGORIES.map((c) => c.id)),
    );

    const findings = buildInterviewPreview({
      sheet: "NOTES",
      rows: [
        {
          rowIndex: 1,
          cells: { "0": "cecilia.fang@example.com", "1": "SYNTHETIC: note." },
          matchedApplicantId: "app-1",
          matchTier: "EMAIL",
          matchConfidence: null,
          skipped: false,
        },
      ],
      columns,
      categories: CATEGORIES,
      mappingErrors: [],
      applicantNames: NAMES,
      headers: HEADERS,
    });

    expect(findings.rows[0].unreadableAverage).toBe(false);
    expect(findings.rows[0].missingInterviewerName).toBe(false);
    expect(findings.canCommit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PRD decision 120 — computed averages, category notes, recommendation, transcript
// ---------------------------------------------------------------------------

describe("decision 120: a scores sheet with no Average column", () => {
  /// Same two categories as everything above, but no column 5. This is F26's
  /// actual shape: the Google Form exports the four scores and never an average.
  const NO_AVERAGE = resolveMapping(
    {
      "0": "APPLICANT_EMAIL",
      "2": "INTERVIEWER_NAME",
      "3": "CATEGORY:cat-a",
      "4": "CATEGORY:cat-b",
    },
    new Set(["cat-a", "cat-b"]),
  );

  const previewNoAverage = (rows: StagedRow[]) =>
    buildInterviewPreview({
      sheet: "SCORES",
      rows,
      columns: NO_AVERAGE,
      categories: CATEGORIES,
      mappingErrors: [],
      applicantNames: NAMES,
      headers: HEADERS,
    });

  it("computes the score from the categories and says that it did", () => {
    const findings = previewNoAverage([row({ cells: { "3": "4", "4": "3" } })]);

    expect(findings.rows[0].score).toBe(3.5);
    expect(findings.rows[0].scoreIsComputed).toBe(true);
    expect(findings.rows[0].average).toBeNull();
    expect(findings.canCommit).toBe(true);
  });

  it("warns that the scores are computed, so nobody reads them as the sheet's", () => {
    const findings = previewNoAverage([row({ cells: { "3": "4", "4": "3" } })]);
    expect(findings.warnings.some((w) => w.includes("no Average column"))).toBe(true);
    expect(findings.blockers).toEqual([]);
  });

  it("averages only the cells that were readable, never treating a gap as zero", () => {
    // Decision 59's rule, arriving from a third side. Three of four readable
    // means the mean of three — dividing by four would import a silent zero.
    const findings = previewNoAverage([row({ cells: { "3": "4", "4": "" } })]);

    expect(findings.rows[0].score).toBe(4);
    expect(findings.rows[0].issues.some((i) => i.kind === "BLANK")).toBe(true);
  });

  it("blocks a row with no readable category at all, and says why", () => {
    const findings = previewNoAverage([row({ cells: { "3": "", "4": "" } })]);

    expect(findings.rows[0].score).toBeNull();
    expect(findings.rows[0].unreadableAverage).toBe(true);
    expect(findings.rows[0].unreadableAverageCause).toBe("COMPUTED");
    expect(findings.canCommit).toBe(false);
    // The old sentence told the admin to fix the Average column. This sheet has
    // no Average column, so that advice would send them looking for nothing.
    const blocker = findings.blockers.find((b) => b.includes("no category score"));
    expect(blocker).toBeDefined();
    expect(blocker).toContain("no Average column");
  });

  it("never reports an average disagreement, because a mean cannot disagree with itself", () => {
    // Left unsuppressed, this fires on every row of the sheet — 123 of them in
    // the file this decision was built for.
    const findings = previewNoAverage([
      row({ cells: { "3": "4", "4": "3" } }),
      row({ rowIndex: 3, cells: { "3": "2", "4": "1" } }),
    ]);

    expect(findings.rows.every((r) => r.averageDisagrees === null)).toBe(true);
    expect(findings.warnings.some((w) => w.includes("disagrees"))).toBe(false);
  });
});

describe("decision 120: a mapped Average column still behaves exactly as before", () => {
  it("imports the stated number verbatim and does not mark it computed", () => {
    // The COLUMNS fixture maps column 5 as AVERAGE. 3.5 is stated; the mean of
    // 4 and 3 is also 3.5, so this isolates provenance from arithmetic.
    const findings = preview([row({ cells: { "3": "4", "4": "3", "5": "3.5" } })]);

    expect(findings.rows[0].score).toBe(3.5);
    expect(findings.rows[0].scoreIsComputed).toBe(false);
  });

  it("still blocks an unreadable stated average, with the original advice", () => {
    const findings = preview([row({ cells: { "5": "n/a" } })]);

    expect(findings.rows[0].unreadableAverageCause).toBe("STATED");
    expect(findings.blockers.some((b) => b.includes("no readable Average"))).toBe(true);
  });

  it("prefers the stated number over the categories even when they disagree", () => {
    // Clause 12h, untouched: interviewers sometimes adjust the average
    // deliberately, and the sheet wins.
    const findings = preview([row({ cells: { "3": "4", "4": "4", "5": "2" } })]);

    expect(findings.rows[0].score).toBe(2);
    expect(findings.rows[0].scoreIsComputed).toBe(false);
    expect(findings.rows[0].averageDisagrees).toEqual({ stated: 2, computed: 4 });
  });
});

describe("decision 120: per-category notes", () => {
  const WITH_NOTES = resolveMapping(
    {
      "0": "APPLICANT_EMAIL",
      "2": "INTERVIEWER_NAME",
      "3": "CATEGORY:cat-a",
      "4": "CATEGORY:cat-b",
      "5": "AVERAGE",
      "6": "CATEGORY_NOTE:cat-a",
      "7": "CATEGORY_NOTE:cat-b",
    },
    new Set(["cat-a", "cat-b"]),
  );

  const previewWithNotes = (rows: StagedRow[]) =>
    buildInterviewPreview({
      sheet: "SCORES",
      rows,
      columns: WITH_NOTES,
      categories: CATEGORIES,
      mappingErrors: [],
      applicantNames: NAMES,
      headers: HEADERS,
    });

  it("attaches each note to its own category", () => {
    const findings = previewWithNotes([
      row({ cells: { "3": "4", "4": "3", "5": "3.5", "6": "strong start", "7": "less sure" } }),
    ]);

    expect(findings.rows[0].categoryNotes).toEqual([
      { interviewCategoryId: "cat-a", body: "strong start" },
      { interviewCategoryId: "cat-b", body: "less sure" },
    ]);
    expect(findings.rows[0].notesWithoutScore).toEqual([]);
  });

  it("drops a blank note rather than storing an empty string", () => {
    const findings = previewWithNotes([
      row({ cells: { "3": "4", "4": "3", "5": "3.5", "6": "   ", "7": "kept" } }),
    ]);

    expect(findings.rows[0].categoryNotes).toEqual([
      { interviewCategoryId: "cat-b", body: "kept" },
    ]);
  });

  it("reports a note whose score did not parse, and does not import it", () => {
    // The note is a column on InterviewCategoryScore, and decision 59 writes no
    // such row for a blank score. So there is nowhere to put it.
    const findings = previewWithNotes([
      row({ cells: { "3": "", "4": "3", "5": "3", "6": "orphaned", "7": "" } }),
    ]);

    expect(findings.rows[0].categoryNotes).toEqual([]);
    expect(findings.rows[0].notesWithoutScore).toEqual(["Communication"]);
    expect(findings.warnings.some((w) => w.includes("could not be read"))).toBe(true);
    // Reported, never refused — the missing score is the problem, and it is
    // already flagged in its own right.
    expect(findings.canCommit).toBe(true);
  });
});

describe("decision 120: the recommendation", () => {
  const WITH_RECOMMENDATION = resolveMapping(
    {
      "0": "APPLICANT_EMAIL",
      "2": "INTERVIEWER_NAME",
      "3": "CATEGORY:cat-a",
      "4": "CATEGORY:cat-b",
      "5": "AVERAGE",
      "6": "RECOMMENDATION",
      "7": "OVERALL_NOTE",
    },
    new Set(["cat-a", "cat-b"]),
  );

  const previewRec = (cells: Record<string, string>) =>
    buildInterviewPreview({
      sheet: "SCORES",
      rows: [row({ cells: { "3": "4", "4": "3", "5": "3.5", ...cells } })],
      columns: WITH_RECOMMENDATION,
      categories: CATEGORIES,
      mappingErrors: [],
      applicantNames: NAMES,
      headers: HEADERS,
    });

  it("reads yes and no in any case, trimmed", () => {
    expect(previewRec({ "6": "Yes" }).rows[0].recommendation).toBe("YES");
    expect(previewRec({ "6": " no " }).rows[0].recommendation).toBe("NO");
    expect(previewRec({ "6": "YES" }).rows[0].recommendation).toBe("YES");
  });

  it("reads a blank as absent, not as a No", () => {
    const findings = previewRec({ "6": "" });
    expect(findings.rows[0].recommendation).toBeNull();
    expect(findings.rows[0].unreadableRecommendation).toBe(false);
    expect(findings.warnings.some((w) => w.includes("recommendation"))).toBe(false);
  });

  it("reads anything else as absent and warns, rather than blocking or inventing a No", () => {
    // A rejection the interviewer did not write is worse than no recommendation,
    // and the column is advisory — nothing tallies it, so nothing needs it.
    const findings = previewRec({ "6": "maybe" });

    expect(findings.rows[0].recommendation).toBeNull();
    expect(findings.rows[0].unreadableRecommendation).toBe(true);
    expect(findings.canCommit).toBe(true);
    const warning = findings.warnings.find((w) => w.includes("recommendation"));
    expect(warning).toContain("rather than as a No");
  });

  it("trims the overall note and reports a blank one as empty", () => {
    expect(previewRec({ "7": "  sat well  " }).rows[0].overallNote).toBe("sat well");
    expect(previewRec({ "7": "   " }).rows[0].overallNote).toBe("");
  });
});

describe("decision 120: the transcript", () => {
  const QUESTION_HEADERS = [
    "Timestamp",
    "Your Name",
    "Applicant Name",
    "1. Tell us a bit about yourself. (1-2 minutes)",
    "2. Why do YOU want to be a part of Spark SC? (2-3 min)",
  ];

  const TRANSCRIPT_COLUMNS = resolveMapping(
    { "1": "INTERVIEWER_NAME", "2": "APPLICANT_NAME", "3": "TRANSCRIPT", "4": "TRANSCRIPT" },
    new Set(),
  );

  const previewNotes = (cells: Record<string, string>) =>
    buildInterviewPreview({
      sheet: "NOTES",
      rows: [
        {
          rowIndex: 2,
          cells: { "1": "Nandini", "2": "Jordan Lee", ...cells },
          matchedApplicantId: "app-2",
          matchTier: "NAME" as const,
          matchConfidence: null,
          skipped: false,
        },
      ],
      columns: TRANSCRIPT_COLUMNS,
      categories: [],
      mappingErrors: [],
      applicantNames: NAMES,
      headers: QUESTION_HEADERS,
    });

  it("carries each question's header text as its prompt, verbatim", () => {
    // There is no builder screen and no other place the question is written
    // down, so the header IS the prompt. Verbatim matters: shortening happens at
    // render, over the stored full text.
    const findings = previewNotes({ "3": "first gen, transferred", "4": "project launch" });

    expect(findings.rows[0].transcript).toEqual([
      {
        columnIndex: 3,
        prompt: "1. Tell us a bit about yourself. (1-2 minutes)",
        body: "first gen, transferred",
      },
      {
        columnIndex: 4,
        prompt: "2. Why do YOU want to be a part of Spark SC? (2-3 min)",
        body: "project launch",
      },
    ]);
    expect(findings.canCommit).toBe(true);
  });

  it("keeps an unanswered question in the row, for the commit to drop", () => {
    // The preview reports what the sheet holds. Which blanks become rows is the
    // commit's decision, and it is tested where it is made.
    const findings = previewNotes({ "3": "answered", "4": "" });
    expect(findings.rows[0].transcript.map((t) => t.body)).toEqual(["answered", ""]);
  });

  it("does not compute a score or flag an average on the notes sheet", () => {
    const findings = previewNotes({ "3": "a", "4": "b" });

    expect(findings.rows[0].scoreIsComputed).toBe(false);
    expect(findings.rows[0].unreadableAverage).toBe(false);
    expect(findings.rows[0].unreadableAverageCause).toBeNull();
    expect(findings.blockers).toEqual([]);
  });
});
