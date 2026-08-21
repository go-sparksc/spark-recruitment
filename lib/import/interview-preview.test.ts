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
