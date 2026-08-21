import { describe, expect, it } from "vitest";

import {
  encodeRole,
  parseRole,
  proposeMapping,
  resolveMapping,
  validateMapping,
  type CategoryLike,
} from "@/lib/import/interview-mapping";

const CATEGORIES: CategoryLike[] = [
  { id: "cat-comm", name: "Communication", maxPoints: 4 },
  { id: "cat-mot", name: "Motivation", maxPoints: 4 },
];

const KNOWN = new Set(CATEGORIES.map((c) => c.id));

const SCORES_HEADERS = [
  "Applicant Email",
  "Applicant Name",
  "Interviewer Name",
  "Communication",
  "Motivation",
  "Average",
];

describe("parseRole", () => {
  it("round-trips every role through encodeRole", () => {
    for (const role of [
      { kind: "APPLICANT_EMAIL" },
      { kind: "APPLICANT_NAME" },
      { kind: "INTERVIEWER_NAME" },
      { kind: "AVERAGE" },
      { kind: "NOTES" },
      { kind: "IGNORED" },
      { kind: "CATEGORY", interviewCategoryId: "cat-comm" },
    ] as const) {
      expect(parseRole(encodeRole(role), KNOWN)).toEqual(role);
    }
  });

  it("falls back to IGNORED for a category that no longer exists", () => {
    // A stored mapping outlives the rubric it referenced. Throwing here would
    // make the preview unreachable rather than fixable.
    expect(parseRole("CATEGORY:deleted", KNOWN)).toEqual({ kind: "IGNORED" });
  });

  it("falls back to IGNORED for junk rather than throwing", () => {
    expect(parseRole("NONSENSE", KNOWN)).toEqual({ kind: "IGNORED" });
    expect(parseRole(42, KNOWN)).toEqual({ kind: "IGNORED" });
    expect(parseRole(null, KNOWN)).toEqual({ kind: "IGNORED" });
  });
});

describe("proposeMapping", () => {
  it("proposes the fixed roles and the categories by exact header text", () => {
    const mapping = proposeMapping(SCORES_HEADERS, CATEGORIES, "SCORES");

    expect(mapping).toEqual({
      "0": "APPLICANT_EMAIL",
      "1": "APPLICANT_NAME",
      "2": "INTERVIEWER_NAME",
      "3": "CATEGORY:cat-comm",
      "4": "CATEGORY:cat-mot",
      "5": "AVERAGE",
    });
  });

  it("matches headers case-insensitively and ignoring surrounding space", () => {
    const mapping = proposeMapping(["  APPLICANT EMAIL ", "communication"], CATEGORIES, "SCORES");
    expect(mapping["0"]).toBe("APPLICANT_EMAIL");
    expect(mapping["1"]).toBe("CATEGORY:cat-comm");
  });

  it("never matches a header by prefix or substring", () => {
    // The applicant fixture's `Black` / `Black or African American` hazard, in
    // its interview-sheet form: a category called "Communication" must not
    // capture a column called "Communication Notes".
    const mapping = proposeMapping(["Communication Notes", "Average Score"], CATEGORIES, "SCORES");
    expect(mapping).toEqual({ "0": "IGNORED", "1": "IGNORED" });
  });

  it("proposes a fixed role at most once, leaving the duplicate visible", () => {
    const mapping = proposeMapping(["Average", "Average"], CATEGORIES, "SCORES");
    expect(mapping).toEqual({ "0": "AVERAGE", "1": "IGNORED" });
  });

  it("does not propose sheet-inappropriate roles", () => {
    // Categories and Average belong to the scores sheet; Notes to the notes one.
    const notes = proposeMapping(["Average", "Communication", "Notes"], CATEGORIES, "NOTES");
    expect(notes).toEqual({ "0": "IGNORED", "1": "IGNORED", "2": "NOTES" });

    const scores = proposeMapping(["Notes"], CATEGORIES, "SCORES");
    expect(scores).toEqual({ "0": "IGNORED" });
  });

  it("proposes Your Name as the interviewer, which is what the notes sheet calls it", () => {
    expect(proposeMapping(["Your Name"], CATEGORIES, "NOTES")["0"]).toBe("INTERVIEWER_NAME");
  });

  it("leaves every unrecognised column IGNORED rather than guessing", () => {
    expect(proposeMapping(["Timestamp", "Row"], CATEGORIES, "SCORES")).toEqual({
      "0": "IGNORED",
      "1": "IGNORED",
    });
  });
});

describe("resolveMapping", () => {
  it("resolves a proposed mapping into columns", () => {
    const columns = resolveMapping(proposeMapping(SCORES_HEADERS, CATEGORIES, "SCORES"), KNOWN);

    expect(columns.emailColumn).toBe(0);
    expect(columns.nameColumn).toBe(1);
    expect(columns.interviewerColumn).toBe(2);
    expect(columns.averageColumn).toBe(5);
    expect(columns.categoryColumns.get("cat-comm")).toBe(3);
    expect(columns.categoryColumns.get("cat-mot")).toBe(4);
  });

  it("ignores non-numeric and negative keys", () => {
    const columns = resolveMapping({ x: "AVERAGE", "-1": "APPLICANT_EMAIL" }, KNOWN);
    expect(columns.averageColumn).toBeNull();
    expect(columns.emailColumn).toBeNull();
  });
});

describe("validateMapping", () => {
  const valid = () => proposeMapping(SCORES_HEADERS, CATEGORIES, "SCORES");

  it("accepts a complete scores mapping", () => {
    expect(validateMapping(valid(), SCORES_HEADERS, CATEGORIES, "SCORES")).toEqual([]);
  });

  it("accepts email alone, and name alone — clause 12a", () => {
    const emailOnly = { ...valid(), "1": "IGNORED" };
    const nameOnly = { ...valid(), "0": "IGNORED" };
    expect(validateMapping(emailOnly, SCORES_HEADERS, CATEGORIES, "SCORES")).toEqual([]);
    expect(validateMapping(nameOnly, SCORES_HEADERS, CATEGORIES, "SCORES")).toEqual([]);
  });

  it("refuses a mapping with neither email nor name", () => {
    const neither = { ...valid(), "0": "IGNORED", "1": "IGNORED" };
    expect(validateMapping(neither, SCORES_HEADERS, CATEGORIES, "SCORES")).toHaveLength(1);
  });

  it("refuses a scores mapping missing the interviewer, the average, or a category", () => {
    // Clauses 12b, 12d, 12c.
    expect(
      validateMapping({ ...valid(), "2": "IGNORED" }, SCORES_HEADERS, CATEGORIES, "SCORES"),
    ).toHaveLength(1);
    expect(
      validateMapping({ ...valid(), "5": "IGNORED" }, SCORES_HEADERS, CATEGORIES, "SCORES"),
    ).toHaveLength(1);

    const missingCategory = validateMapping(
      { ...valid(), "4": "IGNORED" },
      SCORES_HEADERS,
      CATEGORIES,
      "SCORES",
    );
    expect(missingCategory).toHaveLength(1);
    expect(missingCategory[0]).toContain("Motivation");
  });

  it("names every unmapped category, not just the first", () => {
    const none = validateMapping(
      { ...valid(), "3": "IGNORED", "4": "IGNORED" },
      SCORES_HEADERS,
      CATEGORIES,
      "SCORES",
    );
    expect(none[0]).toContain("Communication");
    expect(none[0]).toContain("Motivation");
  });

  it("refuses a role used by two columns rather than resolving it silently", () => {
    const headers = [...SCORES_HEADERS, "Average"];
    const twice = { ...valid(), "6": "AVERAGE" };
    const errors = validateMapping(twice, headers, CATEGORIES, "SCORES");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("More than one column is marked as average");
    // Both offending columns named, not just the second — the admin is choosing
    // between them.
    expect(errors[0]).toContain("“Average” and “Average”");
  });

  it("refuses one category mapped to two columns, naming it", () => {
    const headers = [...SCORES_HEADERS, "Communication (again)"];
    const twice = { ...valid(), "6": "CATEGORY:cat-comm" };
    const errors = validateMapping(twice, headers, CATEGORIES, "SCORES");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Communication");
  });

  it("requires a notes column on the notes sheet, and no categories", () => {
    const headers = ["Applicant Email", "Your Name", "Notes"];
    const mapping = proposeMapping(headers, CATEGORIES, "NOTES");

    expect(validateMapping(mapping, headers, CATEGORIES, "NOTES")).toEqual([]);
    expect(
      validateMapping({ ...mapping, "2": "IGNORED" }, headers, CATEGORIES, "NOTES"),
    ).toHaveLength(1);
  });

  it("does not require an interviewer name on the notes sheet", () => {
    // InterviewNotes.interviewerName is nullable: only one interviewer of the
    // pair writes the notes, and the column records which — when it is there.
    const headers = ["Applicant Email", "Notes"];
    const mapping = proposeMapping(headers, CATEGORIES, "NOTES");
    expect(validateMapping(mapping, headers, CATEGORIES, "NOTES")).toEqual([]);
  });
});
