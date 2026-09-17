import { describe, expect, it } from "vitest";

import {
  encodeRole,
  isBulkTranscriptCandidate,
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

  it("refuses a scores mapping missing the interviewer or a category", () => {
    // Clauses 12b and 12c. 12d is no longer here — see the test below.
    expect(
      validateMapping({ ...valid(), "2": "IGNORED" }, SCORES_HEADERS, CATEGORIES, "SCORES"),
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

// ---------------------------------------------------------------------------
// PRD decision 120 — transcript questions, per-category notes, recommendation
// ---------------------------------------------------------------------------

/// F26's real evaluation header row, which is what this decision was built for.
/// The four category names here are the sheet's own spelling; the point of the
/// cases below is that a rubric configured with those names auto-maps both the
/// score column and its note column, which is worth eight dropdowns at import.
const F26_CATEGORIES: CategoryLike[] = [
  { id: "cat-init", name: "Initiative and Scrappiness", maxPoints: 4 },
  { id: "cat-exec", name: "Execution and Drive", maxPoints: 4 },
  { id: "cat-creative", name: "Creative Thinking and Problem Solving", maxPoints: 4 },
  { id: "cat-impact", name: "Spark Impact", maxPoints: 4 },
];

const F26_SCORES_HEADERS = [
  "Timestamp",
  "Your Name",
  "Applicant Name",
  "Initiative and Scrappiness",
  "Notes on Initiative and Scrappiness",
  "Execution and Drive",
  "Notes on Execution and Drive",
  "Creative Thinking and Problem Solving",
  "Notes on Creative Thinking and Problem Solving",
  "Spark Impact",
  "Notes on Spark Impact",
  "Should this applicant move on to 1R Deliberations?",
  "Additional Notes",
];

describe("decision 120 roles", () => {
  it("round-trips the four new roles through encodeRole", () => {
    for (const role of [
      { kind: "OVERALL_NOTE" },
      { kind: "RECOMMENDATION" },
      { kind: "TRANSCRIPT" },
      { kind: "CATEGORY_NOTE", interviewCategoryId: "cat-comm" },
    ] as const) {
      expect(parseRole(encodeRole(role), KNOWN)).toEqual(role);
    }
  });

  it("does not confuse CATEGORY with CATEGORY_NOTE", () => {
    // The two prefixes diverge at their ninth character. If a later edit ever
    // made one a prefix of the other, a category note would import as a category
    // score — prose, into an Int column, for the wrong thing.
    expect(parseRole("CATEGORY:cat-comm", KNOWN)).toEqual({
      kind: "CATEGORY",
      interviewCategoryId: "cat-comm",
    });
    expect(parseRole("CATEGORY_NOTE:cat-comm", KNOWN)).toEqual({
      kind: "CATEGORY_NOTE",
      interviewCategoryId: "cat-comm",
    });
  });

  it("ignores a category note naming a category that no longer exists", () => {
    // Same rule CATEGORY already follows: fail to IGNORED so the admin gets a
    // screen they can fix, rather than a foreign key violation at commit.
    expect(parseRole("CATEGORY_NOTE:deleted", KNOWN)).toEqual({ kind: "IGNORED" });
  });

  it("collects transcript columns in the sheet's order, not the mapping's", () => {
    // Object key order follows insertion, and a mapping edited one column at a
    // time arrives in the order the admin clicked. Ordinal must be the sheet's
    // left-to-right order, because it is the order the transcript renders in.
    const columns = resolveMapping({ "7": "TRANSCRIPT", "3": "TRANSCRIPT", "5": "TRANSCRIPT" }, KNOWN);
    expect(columns.transcriptColumns).toEqual([3, 5, 7]);
  });
});

describe("decision 120 proposals", () => {
  it("auto-maps every column of the real F26 evaluation header", () => {
    const mapping = proposeMapping(F26_SCORES_HEADERS, F26_CATEGORIES, "SCORES");
    const columns = resolveMapping(mapping, new Set(F26_CATEGORIES.map((c) => c.id)));

    expect(columns.nameColumn).toBe(2);
    expect(columns.interviewerColumn).toBe(1);
    // The file carries none, which decision 120 is what makes importable.
    expect(columns.averageColumn).toBeNull();
    expect(columns.recommendationColumn).toBe(11);
    expect(columns.overallNoteColumn).toBe(12);
    expect([...columns.categoryColumns.values()].sort((a, b) => a - b)).toEqual([3, 5, 7, 9]);
    expect([...columns.categoryNoteColumns.values()].sort((a, b) => a - b)).toEqual([4, 6, 8, 10]);

    expect(validateMapping(mapping, F26_SCORES_HEADERS, F26_CATEGORIES, "SCORES")).toEqual([]);
  });

  it("does not propose a category note on a near-miss name", () => {
    // The whole point of building the key from the configured name and comparing
    // whole strings. "Notes on Initiative" is not "Notes on Initiative and
    // Scrappiness", and a substring match would have made it one.
    const headers = [
      "Applicant Name",
      "Your Name",
      "Initiative and Scrappiness",
      "Notes on Initiative",
    ];
    const mapping = proposeMapping(headers, [F26_CATEGORIES[0]], "SCORES");
    expect(mapping["3"]).toBe("IGNORED");
  });

  it("never proposes TRANSCRIPT", () => {
    // Nine long prompts have no exact key to match against. The admin marks them
    // with one bulk control instead; nothing here guesses.
    const headers = [
      "Timestamp",
      "Your Name",
      "Applicant Name",
      "1. Tell us a bit about yourself. (1-2 minutes)",
      "2. Why do YOU want to be a part of Spark SC? (2-3 min)",
    ];
    const mapping = proposeMapping(headers, CATEGORIES, "NOTES");
    expect(Object.values(mapping)).not.toContain("TRANSCRIPT");
    expect(mapping["3"]).toBe("IGNORED");
    expect(mapping["4"]).toBe("IGNORED");
  });

  it("proposes no scores-sheet role on the notes sheet", () => {
    const headers = ["Applicant Name", "Additional Notes", "Notes on Communication"];
    const mapping = proposeMapping(headers, CATEGORIES, "NOTES");
    expect(mapping["1"]).toBe("IGNORED");
    expect(mapping["2"]).toBe("IGNORED");
  });
});

describe("decision 120 validation", () => {
  const notesHeaders = ["Applicant Name", "Your Name", "Q1", "Q2"];

  it("accepts a scores mapping with no Average column", () => {
    // Clause 12d, withdrawn. The sheet states no average, so there is nothing to
    // refuse — the score is computed and labelled as computed.
    const noAverage = {
      "0": "APPLICANT_NAME",
      "2": "INTERVIEWER_NAME",
      "3": "CATEGORY:cat-comm",
      "4": "CATEGORY:cat-mot",
    };
    expect(validateMapping(noAverage, SCORES_HEADERS, CATEGORIES, "SCORES")).toEqual([]);
  });

  it("accepts a notes sheet satisfied by transcript columns alone", () => {
    const mapping = {
      "0": "APPLICANT_NAME",
      "1": "INTERVIEWER_NAME",
      "2": "TRANSCRIPT",
      "3": "TRANSCRIPT",
    };
    expect(validateMapping(mapping, notesHeaders, CATEGORIES, "NOTES")).toEqual([]);
  });

  it("refuses a notes sheet with neither a Notes column nor any question", () => {
    const mapping = { "0": "APPLICANT_NAME", "1": "INTERVIEWER_NAME" };
    const errors = validateMapping(mapping, notesHeaders, CATEGORIES, "NOTES");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("transcript question");
  });

  it("allows TRANSCRIPT twice, and still refuses every other role twice", () => {
    const repeated = {
      "0": "APPLICANT_NAME",
      "1": "INTERVIEWER_NAME",
      "2": "TRANSCRIPT",
      "3": "TRANSCRIPT",
    };
    expect(validateMapping(repeated, notesHeaders, CATEGORIES, "NOTES")).toEqual([]);

    const duplicatedName = { ...repeated, "1": "APPLICANT_NAME" };
    const errors = validateMapping(duplicatedName, notesHeaders, CATEGORIES, "NOTES");
    expect(errors.some((e) => e.includes("applicant name"))).toBe(true);
  });

  it("refuses the same category's note column twice, naming it readably", () => {
    const headers = [...SCORES_HEADERS, "Notes on Communication", "Notes on Communication"];
    const mapping = {
      "0": "APPLICANT_NAME",
      "2": "INTERVIEWER_NAME",
      "3": "CATEGORY:cat-comm",
      "4": "CATEGORY:cat-mot",
      "6": "CATEGORY_NOTE:cat-comm",
      "7": "CATEGORY_NOTE:cat-comm",
    };
    const errors = validateMapping(mapping, headers, CATEGORIES, "SCORES");
    expect(errors).toHaveLength(1);
    // Not "category note:cat-comm", which is what the generic label would give.
    expect(errors[0]).toContain("notes on Communication");
  });

  it("refuses a category note whose category has no score column", () => {
    // The note is stored on the score row, and decision 59 writes no score row
    // without a readable score. A note column with no score column at all would
    // therefore import nowhere.
    const mapping = {
      "0": "APPLICANT_NAME",
      "2": "INTERVIEWER_NAME",
      "3": "IGNORED",
      "4": "CATEGORY:cat-mot",
      "5": "CATEGORY_NOTE:cat-comm",
    };
    const errors = validateMapping(mapping, SCORES_HEADERS, CATEGORIES, "SCORES");
    expect(errors.some((e) => e.includes("notes column but no score column"))).toBe(true);
  });
});

describe("decision 120: the bulk transcript sweep", () => {
  // Regression, not behaviour. Running the real F26 notes sheet through the
  // importer produced TEN questions, the first of which was "Timestamp" — every
  // Google Forms export opens with that column, and the sweep could not tell a
  // column the admin had deliberately ignored from one nobody had reached,
  // because IGNORED is the same stored value for both.
  const F26_NOTES_HEADERS = [
    "Timestamp",
    "Your Name",
    "Applicant Name",
    "1. Tell us a bit about yourself. (1-2 minutes)\nLast opportunity to give background on yourself.",
    "2. Why do YOU want to be a part of Spark SC? (2-3 min)",
    "3. What’s a project or pursuit that kept you up at night, where has that taken you? (2-3 min)",
  ];

  it("leaves Timestamp alone while taking every real question", () => {
    const mapping = proposeMapping(F26_NOTES_HEADERS, CATEGORIES, "NOTES");
    const swept = F26_NOTES_HEADERS.filter((header, index) =>
      isBulkTranscriptCandidate(header, mapping[String(index)]),
    );

    expect(swept).toEqual([
      "1. Tell us a bit about yourself. (1-2 minutes)\nLast opportunity to give background on yourself.",
      "2. Why do YOU want to be a part of Spark SC? (2-3 min)",
      "3. What’s a project or pursuit that kept you up at night, where has that taken you? (2-3 min)",
    ]);
  });

  it("never touches a column that already has a role", () => {
    // The one thing a bulk control must not do. "Your Name" and "Applicant Name"
    // are auto-mapped, and a sweep that overwrote them would break matching on
    // every row while looking like it had helped.
    expect(isBulkTranscriptCandidate("Your Name", "INTERVIEWER_NAME")).toBe(false);
    expect(isBulkTranscriptCandidate("Applicant Name", "APPLICANT_NAME")).toBe(false);
    expect(isBulkTranscriptCandidate("Notes", "NOTES")).toBe(false);
    // Including one already swept, so pressing twice is a no-op.
    expect(isBulkTranscriptCandidate("1. A question", "TRANSCRIPT")).toBe(false);
  });

  it("skips the known spreadsheet artifacts, case-insensitively", () => {
    for (const header of ["Timestamp", "  timestamp ", "Row", "ID", "Submission ID"]) {
      expect(isBulkTranscriptCandidate(header, undefined)).toBe(false);
    }
  });

  it("skips a column with no heading at all", () => {
    expect(isBulkTranscriptCandidate("", undefined)).toBe(false);
    expect(isBulkTranscriptCandidate("   ", "IGNORED")).toBe(false);
  });

  it("treats an absent mapping entry as unmapped, not as mapped", () => {
    // A column can be missing from the stored mapping entirely. That is unmapped
    // in exactly the sense this sweep is about, and reading only the mapping's
    // own keys would skip it.
    expect(isBulkTranscriptCandidate("4. A real question", undefined)).toBe(true);
    expect(isBulkTranscriptCandidate("4. A real question", "IGNORED")).toBe(true);
  });
});
