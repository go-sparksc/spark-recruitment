import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkedCount, type GroupMember } from "@/lib/field-groups";
import { detectGroups } from "@/lib/import/detect-groups";
import { CsvParseError, duplicateHeaders, parseCsv } from "@/lib/import/parse-csv";
import { FieldGroupRole } from "@/generated/prisma/enums";

// The fixture's README enumerates every hazard in it deliberately. These are
// those checklists made executable, so a future edit that destroys one fails
// here rather than in Phase 3 in front of thirty reviewers.
const FIXTURE = path.join(process.cwd(), "prisma", "fixtures", "s26-shape.csv");
const parsed = parseCsv(readFileSync(FIXTURE));

const ETHNICITY_COLUMNS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // 0-based; columns 4-13
const WRITE_IN_COLUMN = 13; // column 14

const rowByName = (first: string, last: string) =>
  parsed.rows.find((row) => row[1] === first && row[2] === last)!;

describe("parseCsv against the fixture", () => {
  it("reads 29 columns and 28 records from more physical lines than that", () => {
    expect(parsed.headers).toHaveLength(29);
    expect(parsed.rows).toHaveLength(28);

    // Two fields carry embedded newlines, so a line-per-record reader
    // mis-parses this file. That is the point of the file.
    const physicalLines = readFileSync(FIXTURE, "utf8").split("\n").length;
    expect(physicalLines).toBeGreaterThan(parsed.rows.length + 1);
  });

  it("gives every record the same width as the header", () => {
    expect([...new Set(parsed.rows.map((row) => row.length))]).toEqual([29]);
  });

  it("keeps the header hazards verbatim", () => {
    expect(parsed.headers[18]).toHaveLength(261); // over 200 chars
    expect(parsed.headers[20]).toContain("\n"); // embedded newline
    expect(parsed.headers[22].endsWith(" ")).toBe(true); // trailing space
    expect(/[‘’]/.test(parsed.headers[19])).toBe(true); // curly apostrophe
    expect(/[“”]/.test(parsed.headers[19])).toBe(true); // curly double quotes
    expect(parsed.headers[13]).toContain(","); // comma inside a quoted header
  });

  it("keeps Black and Black or African American distinct", () => {
    // Exact comparison is the only thing that separates a strict prefix from
    // the string it prefixes.
    expect(parsed.headers[4]).toBe("Black");
    expect(parsed.headers[5]).toBe("Black or African American");
    expect(rowByName("Fen", "Dummy")[4]).toBe("Black");
    expect(rowByName("Fen", "Dummy")[5]).toBe("");
    expect(rowByName("Gale", "Synthetic")[4]).toBe("");
    expect(rowByName("Harper", "Lorem")[4]).toBe("Black");
    expect(rowByName("Harper", "Lorem")[5]).toBe("Black or African American");
  });

  it("does not trim cell values", () => {
    // Quinn's padded email must reach the preview intact so the admin is told
    // it was trimmed rather than the importer silently fixing it.
    expect(rowByName("Quinn", "Spacey")[0]).toBe("  quinn.sample@example.com  ");
  });

  it("decodes doubled quotes and embedded newlines in cells", () => {
    expect(rowByName("Devi", "Stubbs")[19]).toContain('"the spreadsheet era"');
    expect(rowByName("Gale", "Synthetic")[20]).toContain("\n");
  });

  it("reports no duplicate headers in this file", () => {
    // Duplicates are legal and Field.sourceHeader is not unique, but this
    // fixture has none — so a failure here means a header was accidentally
    // altered into a collision.
    expect(duplicateHeaders(parsed.headers)).toEqual([]);
  });
});

describe("parseCsv error handling", () => {
  it("refuses an empty file", () => {
    expect(() => parseCsv("")).toThrow(CsvParseError);
  });

  it("refuses a header row with no applicants", () => {
    expect(() => parseCsv("a,b,c\r\n")).toThrow(/no applicants/);
  });

  it("refuses a ragged row rather than importing shifted columns", () => {
    expect(() => parseCsv("a,b,c\r\n1,2\r\n")).toThrow(CsvParseError);
  });

  it("strips a BOM so the first header matches its own name", () => {
    const { headers } = parseCsv("﻿Email Address,First Name\r\nx@example.com,Ada\r\n");
    expect(headers[0]).toBe("Email Address");
  });
});

describe("detectGroups against the fixture", () => {
  const proposals = detectGroups(parsed.headers, parsed.rows);

  it("proposes exactly one group: the ten one-hot ethnicity columns", () => {
    expect(proposals).toHaveLength(1);
    expect(proposals[0].columnIndexes).toEqual(ETHNICITY_COLUMNS);
    expect(proposals[0].isMultiSelect).toBe(true);
  });

  it("does not detect the free-text write-in", () => {
    // Its values vary by definition, so no value-signature rule can reach it.
    // Attaching it is a manual step, which is why FR-2 has to support one.
    expect(proposals[0].columnIndexes).not.toContain(WRITE_IN_COLUMN);
  });

  it("does not group the entirely empty columns", () => {
    // Other Major: (23) and Tags (26) are empty across all 28 rows. "Every
    // non-empty value is the same literal" is vacuously true over nothing.
    const grouped = new Set(proposals.flatMap((p) => p.columnIndexes));
    expect(grouped.has(23)).toBe(false);
    expect(grouped.has(26)).toBe(false);
  });

  it("does not group a column that is single-valued by accident", () => {
    // Anything else… (25) has exactly one non-empty value in the fixture.
    const grouped = new Set(proposals.flatMap((p) => p.columnIndexes));
    expect(grouped.has(25)).toBe(false);
  });

  it("does not group the first-generation column", () => {
    // Yes / No / Prefer not to say — several distinct values, and none equal to
    // the header.
    const grouped = new Set(proposals.flatMap((p) => p.columnIndexes));
    expect(grouped.has(14)).toBe(false);
  });
});

describe("detectGroups guards, in isolation", () => {
  it("requires the value to equal the column's own header", () => {
    // A column of all "Yes" is single-valued and is not a checkbox.
    const headers = ["Opt A", "Opt B"];
    const rows = [
      ["Yes", "Yes"],
      ["", "Yes"],
    ];
    expect(detectGroups(headers, rows)).toEqual([]);
  });

  it("requires a run of at least two", () => {
    const headers = ["Alone", "Something else"];
    const rows = [["Alone", "free text"]];
    expect(detectGroups(headers, rows)).toEqual([]);
  });

  it("requires at least one non-empty value", () => {
    const headers = ["Empty A", "Empty B"];
    const rows = [
      ["", ""],
      ["", ""],
    ];
    expect(detectGroups(headers, rows)).toEqual([]);
  });

  it("stops a run at the first non-candidate rather than spanning it", () => {
    const headers = ["A", "B", "gap", "C", "D"];
    const rows = [
      ["A", "B", "anything", "C", "D"],
      ["A", "", "else", "", "D"],
    ];
    const proposals = detectGroups(headers, rows);

    expect(proposals).toHaveLength(2);
    expect(proposals[0].columnIndexes).toEqual([0, 1]);
    expect(proposals[1].columnIndexes).toEqual([3, 4]);
  });

  it("detects nothing when a form exports Y/TRUE/1 instead of the label", () => {
    // The documented safe failure: no detection costs the admin a minute of
    // manual grouping, a wrong silent detection costs a cycle.
    const headers = ["Black", "White"];
    const rows = [
      ["Y", ""],
      ["", "Y"],
    ];
    expect(detectGroups(headers, rows)).toEqual([]);
  });
});

describe("the fixture's counting cases, end to end", () => {
  // Slice 1 pinned these against inline data. Now they run against the real
  // file, through the real parser.
  const members: GroupMember[] = [
    ...ETHNICITY_COLUMNS.map((index) => ({
      id: String(index),
      displayName: parsed.headers[index],
      groupRole: FieldGroupRole.OPTION,
    })),
    {
      id: String(WRITE_IN_COLUMN),
      displayName: parsed.headers[WRITE_IN_COLUMN],
      groupRole: FieldGroupRole.FREE_TEXT,
    },
  ];

  const dataFor = (first: string, last: string) => {
    const row = rowByName(first, last);
    return Object.fromEntries(row.map((value, index) => [String(index), value]));
  };

  it("Rowan Fixture checks three boxes", () => {
    expect(checkedCount(dataFor("Rowan", "Fixture"), members)).toBe(3);
  });

  it("Pax Writein checks none despite a filled write-in", () => {
    expect(checkedCount(dataFor("Pax", "Writein"), members)).toBe(0);
    expect(rowByName("Pax", "Writein")[WRITE_IN_COLUMN]).not.toBe("");
  });

  it("Tobin Blankethnicity checks none with an empty write-in", () => {
    expect(checkedCount(dataFor("Tobin", "Blankethnicity"), members)).toBe(0);
    expect(rowByName("Tobin", "Blankethnicity")[WRITE_IN_COLUMN]).toBe("");
  });
});
