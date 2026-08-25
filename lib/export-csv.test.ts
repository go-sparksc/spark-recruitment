// FR-20's CSVs. Light coverage by CLAUDE.md's rule — these are convenience
// derivatives, not the lossless artifact, and the round trip does not read them
// back.
//
// Two things here are not light, and both are about a cell whose content the
// format has to survive rather than sanitize:
//
//   - **Separator characters inside a value.** None of the three files carries
//     free text today, so the live case is a name with a comma in it; the
//     line-break case is covered because the failure is silent rather than loud
//     — an unquoted newline ends the record early, shifts every later column,
//     and still opens.
//   - **Decision 90's verbatim rule.** A cell beginning `=` is a formula in
//     Excel. Pinning that we do NOT prefix it is what stops a future reader
//     "fixing" it and quietly rewriting what a person recorded.

import { describe, expect, it } from "vitest";

import {
  buildApplicantsCsv,
  buildDecisionsCsv,
  buildFinalClassCsv,
  csvCell,
  toCsv,
  type CsvApplicantRow,
} from "@/lib/export-csv";

describe("csvCell", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvCell("Cecilia Fang")).toBe("Cecilia Fang");
    expect(csvCell(4)).toBe("4");
  });

  it("renders null and undefined as an empty cell, not as words", () => {
    // A blank reads as absent, which is what they mean. "null" reads as data.
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes a cell containing a comma", () => {
    expect(csvCell("Fang, Cecilia")).toBe('"Fang, Cecilia"');
  });

  it("quotes and doubles an inner quote", () => {
    expect(csvCell('she said "yes"')).toBe('"she said ""yes"""');
  });

  it("quotes a cell containing a line break", () => {
    // Not reachable through today's three files, and kept because the failure is
    // silent: an unquoted newline ends the record early and shifts every
    // subsequent column, in a file that still opens.
    expect(csvCell("first line\nsecond line")).toBe('"first line\nsecond line"');
    expect(csvCell("first\r\nsecond")).toBe('"first\r\nsecond"');
  });

  it("does NOT prefix a formula-leading cell — decision 90", () => {
    // Excel will evaluate these. That is a property of Excel, and the remedy is
    // to import the CSV as text rather than to rewrite what a person wrote.
    // Changing this test means changing decision 90 first.
    expect(csvCell("=SUM(A1:A2)")).toBe("=SUM(A1:A2)");
    expect(csvCell("+1 (213) 555-0100")).toBe("+1 (213) 555-0100");
    expect(csvCell("-3 is my score")).toBe("-3 is my score");
    expect(csvCell("@everyone")).toBe("@everyone");
  });
});

describe("toCsv", () => {
  it("writes CRLF line endings and closes the last record", () => {
    expect(toCsv(["a", "b"], [[1, 2]])).toBe("a,b\r\n1,2\r\n");
  });

  it("writes a header-only file when there are no rows", () => {
    // An empty class is a real answer — an instance can finish with nobody
    // admitted — and a file with headers says that, where an empty file reads
    // as a failed export.
    expect(toCsv(["Applicant", "Name"], [])).toBe("Applicant,Name\r\n");
  });
});

// ---------------------------------------------------------------------------

const categories = [
  { id: "cat-1", name: "Fit" },
  { id: "cat-2", name: "Initiative" },
];

function applicant(overrides: Partial<CsvApplicantRow> = {}): CsvApplicantRow {
  return {
    sourceRowIndex: 47,
    displayName: "Cecilia Fang",
    email: "fang@usc.edu",
    status: "ACTIVE",
    stageReached: "WRITTEN",
    reviews: [{ points: { "cat-1": 4, "cat-2": 2 } }, { points: { "cat-1": 3, "cat-2": 3 } }],
    ...overrides,
  };
}

describe("buildApplicantsCsv", () => {
  it("puts one column per rubric category, named", () => {
    const [header] = buildApplicantsCsv([applicant()], categories).split("\r\n");
    expect(header).toBe("Applicant,Name,Email,Status,Stage reached,Reviews,Fit,Initiative,Average,Variance");
  });

  it("averages each category across reviewers and reports FR-10's two numbers", () => {
    // Reviewer averages are 3.00 and 3.00, so average 3.00 and variance 0.00.
    // Category means are 3.50 and 2.50.
    const [, row] = buildApplicantsCsv([applicant()], categories).split("\r\n");
    expect(row).toBe("Applicant 47,Cecilia Fang,fang@usc.edu,ACTIVE,WRITTEN,2,3.50,2.50,3.00,0.00");
  });

  it("leaves the score columns blank for an applicant nobody reviewed", () => {
    // Not zero. A zero average sorts and reads like a real low score, which is
    // the distinction scoreSummary returns null to protect.
    const [, row] = buildApplicantsCsv([applicant({ reviews: [] })], categories).split("\r\n");
    expect(row).toBe("Applicant 47,Cecilia Fang,fang@usc.edu,ACTIVE,WRITTEN,0,,,,");
  });

  it("leaves a blank email blank", () => {
    const [, row] = buildApplicantsCsv([applicant({ email: null })], categories).split("\r\n");
    expect(row).toContain("Applicant 47,Cecilia Fang,,ACTIVE");
  });

  it("quotes a name containing a comma rather than shifting the columns", () => {
    const csv = buildApplicantsCsv([applicant({ displayName: "Fang, Cecilia" })], categories);
    expect(csv).toContain('"Fang, Cecilia"');
  });

  it("ignores a review that did not cover every category", () => {
    // reviewerAverage's contract, and decision 1's sense of "completed": a
    // reviewer who scored two of four has an average over a different
    // denominator, and counting it makes one applicant's number incomparable
    // with the next one's while looking just as authoritative.
    const partial = applicant({
      reviews: [{ points: { "cat-1": 4, "cat-2": 2 } }, { points: { "cat-1": 1 } }],
    });
    const [, row] = buildApplicantsCsv([partial], categories).split("\r\n");
    // One complete review: averages 3.00, variance 0.00, categories 4.00 / 2.00.
    expect(row).toBe("Applicant 47,Cecilia Fang,fang@usc.edu,ACTIVE,WRITTEN,1,4.00,2.00,3.00,0.00");
  });

  it("reports nothing when every review is incomplete", () => {
    const none = applicant({ reviews: [{ points: { "cat-1": 3 } }] });
    const [, row] = buildApplicantsCsv([none], categories).split("\r\n");
    expect(row.endsWith(",0,,,,")).toBe(true);
  });

  it("reports variance over the reviewers who disagreed", () => {
    const split = applicant({
      reviews: [{ points: { "cat-1": 4, "cat-2": 4 } }, { points: { "cat-1": 2, "cat-2": 2 } }],
    });
    // Reviewer averages 4 and 2 → mean 3, population variance ((1)+(1))/2 = 1.
    const [, row] = buildApplicantsCsv([split], categories).split("\r\n");
    expect(row.endsWith("3.00,1.00")).toBe(true);
  });
});

describe("buildDecisionsCsv", () => {
  it("names the actor, because SYSTEM and ADMIN mean different things", () => {
    const csv = buildDecisionsCsv([
      {
        sourceRowIndex: 47,
        displayName: "Cecilia Fang",
        email: "fang@usc.edu",
        stage: "SECOND_ROUND",
        outcome: "SPARKLET",
        actor: "SYSTEM",
        decidedAt: new Date("2026-08-20T10:00:00.000Z"),
      },
    ]);
    expect(csv).toBe(
      "Applicant,Name,Email,Stage,Outcome,Decided by,Decided at\r\n" +
        "Applicant 47,Cecilia Fang,fang@usc.edu,SECOND_ROUND,SPARKLET,SYSTEM,2026-08-20T10:00:00.000Z\r\n",
    );
  });

  it("accepts a date that has already been serialized", () => {
    const csv = buildDecisionsCsv([
      {
        sourceRowIndex: 1,
        displayName: "A",
        email: null,
        stage: "WRITTEN",
        outcome: "REJECT",
        actor: "ADMIN",
        decidedAt: "2026-08-20T10:00:00.000Z",
      },
    ]);
    expect(csv).toContain("2026-08-20T10:00:00.000Z");
  });
});

describe("buildFinalClassCsv", () => {
  it("is the mailing list and nothing more", () => {
    const csv = buildFinalClassCsv([
      { sourceRowIndex: 47, displayName: "Cecilia Fang", email: "fang@usc.edu" },
    ]);
    expect(csv).toBe("Applicant,Name,Email\r\nApplicant 47,Cecilia Fang,fang@usc.edu\r\n");
  });

  it("carries the handle, so two people with one name stay apart", () => {
    // Phase 6's two Diego Hoffmanns, arriving at the presentation layer after
    // the data model correctly refused to conflate them.
    const csv = buildFinalClassCsv([
      { sourceRowIndex: 12, displayName: "Diego Hoffmann", email: "d1@usc.edu" },
      { sourceRowIndex: 89, displayName: "Diego Hoffmann", email: "d2@usc.edu" },
    ]);
    expect(csv).toContain("Applicant 12,Diego Hoffmann");
    expect(csv).toContain("Applicant 89,Diego Hoffmann");
  });

  it("writes headers for an empty class", () => {
    expect(buildFinalClassCsv([])).toBe("Applicant,Name,Email\r\n");
  });
});
