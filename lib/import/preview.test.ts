import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FieldCategory } from "@/generated/prisma/enums";
import type { FieldGroupLike, FieldLike } from "@/lib/fields";
import { parseCsv } from "@/lib/import/parse-csv";
import { buildPreview, normalizeEmail, type PreviewRowInput } from "@/lib/import/preview";

const FIXTURE = path.join(process.cwd(), "prisma", "fixtures", "s26-shape.csv");
const parsed = parseCsv(readFileSync(FIXTURE));

const EMAIL_COLUMN = 0;
const NAME_COLUMNS = [1, 2];

/// The fixture as the preview sees it: staging rows with the designated columns
/// pulled out, exactly as the page assembles them from ImportRow.cells.
function fixtureRows(overrides: { discard?: number[] } = {}): PreviewRowInput[] {
  const discard = new Set(overrides.discard ?? []);
  return parsed.rows.map((row, i) => ({
    rowIndex: i + 1,
    discarded: discard.has(i + 1),
    rawEmail: row[EMAIL_COLUMN],
    rawNameParts: NAME_COLUMNS.map((c) => row[c]),
  }));
}

const field = (overrides: Partial<FieldLike> = {}): FieldLike => ({
  id: "f1",
  category: FieldCategory.OTHER,
  isIncluded: true,
  groupId: null,
  groupRole: null,
  visibleToWrittenReviewer: null,
  visibleToFirstRoundReviewer: null,
  ...overrides,
});

const base = {
  fields: [field({ id: "essay", category: FieldCategory.RESPONSE })],
  groups: [] as FieldGroupLike[],
  unconfirmedProposalCount: 0,
  hasEmailColumn: true,
  hasNameColumn: true,
};

const rowIndexOf = (first: string, last: string) =>
  parsed.rows.findIndex((r) => r[1] === first && r[2] === last) + 1;

describe("normalizeEmail", () => {
  it("trims, lowercases and NFC-normalizes", () => {
    expect(normalizeEmail("  Bex.Placeholder@Example.COM  ")).toBe("bex.placeholder@example.com");
  });

  it("treats blank and whitespace-only as no address", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe("buildPreview against the fixture", () => {
  const findings = buildPreview({ ...base, rows: fixtureRows() });

  it("finds both duplicate pairs, including the case-only one", () => {
    // The whole reason the Bex row exists. A verbatim comparison sees two
    // distinct addresses and lets this through to fail at commit.
    expect(findings.duplicates).toHaveLength(2);
    expect(findings.duplicates.map((d) => d.email).sort()).toEqual([
      "avery.fixture@example.com",
      "bex.placeholder@example.com",
    ]);
  });

  it("pairs the right rows together", () => {
    const bex = findings.duplicates.find((d) => d.email === "bex.placeholder@example.com")!;
    expect(bex.rowIndexes).toEqual([
      rowIndexOf("Bex", "Placeholder"),
      rowIndexOf("Bex", "Casedupe"),
    ]);
  });

  it("blocks commit while duplicates remain", () => {
    expect(findings.canCommit).toBe(false);
    expect(findings.blockers.join(" ")).toMatch(/more than one row/);
  });

  it("reports Emory's blank email as a warning, not a blocker", () => {
    // email is nullable and Postgres permits many nulls, so this is a real
    // state rather than a defect.
    expect(findings.blankEmailRowIndexes).toEqual([rowIndexOf("Emory", "Noemail")]);
    expect(findings.warnings.join(" ")).toMatch(/no email address/);

    // The blockers here are about DUPLICATE addresses, which legitimately
    // mention email. What matters is that a blank one contributes none — proved
    // by resolving the duplicates and finding Emory still imports.
    const resolved = buildPreview({
      ...base,
      rows: fixtureRows({
        discard: [rowIndexOf("Avery", "Duplicate"), rowIndexOf("Bex", "Casedupe")],
      }),
    });
    expect(resolved.blankEmailRowIndexes).toEqual([rowIndexOf("Emory", "Noemail")]);
    expect(resolved.canCommit).toBe(true);
  });

  it("reports Quinn's padded email and trims it", () => {
    const quinn = findings.rows.find((r) => r.rowIndex === rowIndexOf("Quinn", "Spacey"))!;
    expect(quinn.emailWasPadded).toBe(true);
    expect(quinn.email).toBe("quinn.sample@example.com");
    expect(quinn.rawEmail).toBe("  quinn.sample@example.com  ");
    expect(findings.warnings.join(" ")).toMatch(/surrounding spaces/);
  });

  it("does NOT flag Indigo, who has a first name and no last name", () => {
    // The trap: a blank last-name cell is not a blank name.
    const indigo = findings.rows.find((r) => r.rowIndex === rowIndexOf("Indigo", ""))!;
    expect(indigo.displayName).toBe("Indigo");
    expect(findings.blankNameRowIndexes).toEqual([]);
  });

  it("counts all 28 rows as kept when nothing is discarded", () => {
    expect(findings.keptCount).toBe(28);
    expect(findings.discardedCount).toBe(0);
  });
});

describe("resolving the duplicates", () => {
  it("clears both blockers once one row of each pair is discarded", () => {
    const findings = buildPreview({
      ...base,
      rows: fixtureRows({ discard: [rowIndexOf("Avery", "Duplicate"), rowIndexOf("Bex", "Casedupe")] }),
    });

    expect(findings.duplicates).toEqual([]);
    expect(findings.keptCount).toBe(26);
    expect(findings.discardedCount).toBe(2);
    expect(findings.canCommit).toBe(true);
  });

  it("ignores a discarded row entirely when pairing", () => {
    const findings = buildPreview({
      ...base,
      rows: fixtureRows({ discard: [rowIndexOf("Avery", "Sampleton")] }),
    });

    expect(findings.duplicates.map((d) => d.email)).toEqual(["bex.placeholder@example.com"]);
  });
});

describe("blockers", () => {
  const rows: PreviewRowInput[] = [
    { rowIndex: 1, discarded: false, rawEmail: "a@example.com", rawNameParts: ["Ada", "Lovelace"] },
  ];

  it("blocks when no email column is designated", () => {
    const findings = buildPreview({ ...base, rows, hasEmailColumn: false });
    expect(findings.canCommit).toBe(false);
    expect(findings.blockers.join(" ")).toMatch(/No email column/);
  });

  it("blocks when no name column is designated", () => {
    const findings = buildPreview({ ...base, rows, hasNameColumn: false });
    expect(findings.canCommit).toBe(false);
    expect(findings.blockers.join(" ")).toMatch(/No name column/);
  });

  it("blocks a row with no name at all", () => {
    const findings = buildPreview({
      ...base,
      rows: [{ rowIndex: 1, discarded: false, rawEmail: "a@example.com", rawNameParts: ["", "  "] }],
    });
    expect(findings.blankNameRowIndexes).toEqual([1]);
    expect(findings.canCommit).toBe(false);
  });

  it("blocks when every row is discarded", () => {
    const findings = buildPreview({
      ...base,
      rows: rows.map((r) => ({ ...r, discarded: true })),
    });
    expect(findings.canCommit).toBe(false);
    expect(findings.blockers.join(" ")).toMatch(/Every row is discarded/);
  });

  it("does not treat two blank emails as duplicates of each other", () => {
    // Postgres permits many nulls in the unique index, so this must import.
    const findings = buildPreview({
      ...base,
      rows: [
        { rowIndex: 1, discarded: false, rawEmail: "", rawNameParts: ["Ada"] },
        { rowIndex: 2, discarded: false, rawEmail: "   ", rawNameParts: ["Grace"] },
      ],
    });
    expect(findings.duplicates).toEqual([]);
    expect(findings.canCommit).toBe(true);
  });
});

describe("warnings — plausible instances the system should not overrule", () => {
  const rows: PreviewRowInput[] = [
    { rowIndex: 1, discarded: false, rawEmail: "a@example.com", rawNameParts: ["Ada"] },
  ];

  it("warns but does not block when no included field resolves to RESPONSE", () => {
    const findings = buildPreview({
      ...base,
      rows,
      fields: [field({ id: "x", category: FieldCategory.OTHER })],
    });

    expect(findings.hasIncludedResponseField).toBe(false);
    expect(findings.warnings.join(" ")).toMatch(/every profile in the written round will be empty/i);
    expect(findings.canCommit).toBe(true);
  });

  it("counts a RESPONSE group, not just an ungrouped column", () => {
    // Resolved through the shared helper, so the preview cannot disagree with
    // what a written reviewer actually gets.
    const findings = buildPreview({
      ...base,
      rows,
      fields: [field({ id: "m", category: FieldCategory.OTHER, groupId: "g1", groupRole: "OPTION" })],
      groups: [
        {
          id: "g1",
          category: FieldCategory.RESPONSE,
          isIncluded: true,
          visibleToWrittenReviewer: null,
          visibleToFirstRoundReviewer: null,
        },
      ],
    });

    expect(findings.hasIncludedResponseField).toBe(true);
  });

  it("does not count an EXCLUDED response field", () => {
    const findings = buildPreview({
      ...base,
      rows,
      fields: [field({ id: "x", category: FieldCategory.RESPONSE, isIncluded: false })],
    });

    expect(findings.hasIncludedResponseField).toBe(false);
  });

  it("warns but does not block on an unconfirmed proposal", () => {
    const findings = buildPreview({ ...base, rows, unconfirmedProposalCount: 1 });

    expect(findings.warnings.join(" ")).toMatch(/not been named or dismissed/);
    expect(findings.canCommit).toBe(true);
  });
});
