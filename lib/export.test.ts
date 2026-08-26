// The FR-20 export format. These cases are the spec for what "the entire
// instance" and "intact" mean; PRD decisions 86-88 and 90 are the prose.
//
// Two of them are structural guards rather than behaviour, and they are the
// reason this file is worth more than its line count:
//
//   - **The manifest is checked against the generated Prisma client.** A column
//     added to prisma/schema.prisma and not added to EXPORT_TABLES fails here,
//     rather than being silently dropped by a restore months later. That is the
//     failure the format is least able to detect on its own, because an export
//     that never knew about a column produces a file that looks complete.
//   - **The write order is checked against the foreign-key graph.** The order in
//     EXPORT_TABLES is load-bearing, and a reordering that broke it would only
//     show up as a constraint violation at restore time against real data.

import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import {
  DATE_COLUMNS,
  NULLABLE_JSON_COLUMNS,
  canonicalValue,
  canonicalizeSnapshot,
  diffSnapshots,
  EXPORT_FORMAT_VERSION,
  EXPORT_TABLES,
  EXPORT_TABLE_NAMES,
  ExportFormatError,
  parseExport,
  rowCounts,
  serializeExport,
  type ExportRow,
  type InstanceSnapshot,
} from "@/lib/export";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A snapshot with every table present and empty, which is the shape the format
/// requires — an absent table and an empty table are different claims.
function emptySnapshot(overrides: Partial<InstanceSnapshot> = {}): InstanceSnapshot {
  const tables: Record<string, ExportRow[]> = {};
  for (const table of EXPORT_TABLE_NAMES) tables[table] = [];
  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: "2026-08-25T12:00:00.000Z",
    instanceId: "seed_s26_demo",
    tables,
    ...overrides,
  };
}

function withRows(table: string, rows: ExportRow[]): InstanceSnapshot {
  const snapshot = emptySnapshot();
  snapshot.tables[table] = rows;
  return snapshot;
}

/// A PassApplicant row, the table whose null handling decision 88 singles out.
function passApplicant(id: string, resolution: string | null): ExportRow {
  return {
    id,
    passId: "pass-2",
    applicantId: `applicant-${id}`,
    resolution,
    resolvedAt: resolution === null ? null : "2026-08-20T00:00:00.000Z",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// The manifest, against the schema
// ---------------------------------------------------------------------------

describe("EXPORT_TABLES covers the schema", () => {
  it("names every column of every table it claims, in schema order", () => {
    // Prisma generates a <Model>ScalarFieldEnum per model holding exactly its
    // scalar columns. Comparing against it is what makes this manifest
    // self-verifying: the generated client is regenerated from the schema, so
    // this test reads the schema at one remove.
    const namespace = Prisma as unknown as Record<string, Record<string, string> | undefined>;

    for (const { table, columns } of EXPORT_TABLES) {
      const scalarFields = namespace[`${table}ScalarFieldEnum`];
      expect(scalarFields, `${table}ScalarFieldEnum is missing — is ${table} still a model?`).toBeDefined();
      expect(Object.values(scalarFields!), `${table} columns`).toEqual([...columns]);
    }
  });

  it("covers every model in the schema, so no table is quietly left out of the export", () => {
    // The other direction, and the one that actually bites: a model ADDED to the
    // schema is invisible to the test above, because that test only walks tables
    // the manifest already knows. Without this case a new table would export as
    // nothing at all and the round trip would still pass.
    const namespace = Prisma as unknown as Record<string, unknown>;
    const modelsInClient = Object.keys(namespace)
      .filter((key) => key.endsWith("ScalarFieldEnum"))
      .map((key) => key.slice(0, -"ScalarFieldEnum".length))
      .sort();

    expect(modelsInClient).toEqual([...EXPORT_TABLE_NAMES].sort());
  });

  it("has no duplicate tables", () => {
    expect(new Set(EXPORT_TABLE_NAMES).size).toBe(EXPORT_TABLE_NAMES.length);
  });

  it("names only real columns in DATE_COLUMNS and NULLABLE_JSON_COLUMNS", () => {
    // These two maps drive the restore's only type conversions. A wrong type is
    // caught loudly by Prisma at insert; a **typo** is not — the column simply
    // never converts, and a timestamp goes in as a string or a JSON null goes in
    // as a bare null. Both are the restore silently doing the wrong thing, so
    // the names are pinned to the manifest here.
    const columnsByTable = new Map<string, ReadonlySet<string>>(
      EXPORT_TABLES.map((entry) => [entry.table, new Set<string>(entry.columns)]),
    );

    for (const [table, dateColumns] of Object.entries(DATE_COLUMNS)) {
      for (const column of dateColumns) {
        expect(columnsByTable.get(table)?.has(column), `${table}.${column}`).toBe(true);
      }
    }
    for (const [table, jsonColumns] of Object.entries(NULLABLE_JSON_COLUMNS)) {
      for (const column of jsonColumns ?? []) {
        expect(columnsByTable.get(table)?.has(column), `${table}.${column}`).toBe(true);
      }
    }
  });

  it("declares a DATE_COLUMNS entry for every table, so a new table cannot be forgotten", () => {
    expect(Object.keys(DATE_COLUMNS).sort()).toEqual([...EXPORT_TABLE_NAMES].sort());
  });
});

describe("EXPORT_TABLES is in foreign-key dependency order", () => {
  it("writes every referenced table before the table that references it", () => {
    // The edges as prisma/schema.prisma declares them, plus the three that no
    // foreign key expresses and that decision 88 is about: Applicant.data is
    // keyed by Field.id, InterviewImport.mapping embeds InterviewCategory ids,
    // and AuditLog.entityId holds ids from every table as plain strings.
    const dependsOn: Record<string, readonly string[]> = {
      FieldGroup: ["Instance"],
      Field: ["Instance", "FieldGroup"],
      ImportRow: ["Instance"],
      RubricCategory: ["Instance"],
      InterviewCategory: ["Instance"],
      RoundAccessCode: ["Instance"],
      Reviewer: ["Instance"],
      Applicant: ["Instance", "Field"],
      Assignment: ["Instance", "Applicant", "Reviewer"],
      Score: ["Assignment", "RubricCategory"],
      ReviewNote: ["Assignment"],
      InterviewResult: ["Applicant"],
      InterviewCategoryScore: ["InterviewResult", "InterviewCategory"],
      InterviewNotes: ["Applicant"],
      InterviewImport: ["Instance", "InterviewCategory"],
      InterviewImportRow: ["Instance", "InterviewImport", "Applicant"],
      FirstRoundVote: ["Applicant", "Reviewer"],
      ConflictOfInterest: ["Applicant", "Reviewer"],
      Pass: ["Instance"],
      PassApplicant: ["Pass", "Applicant"],
      PassVote: ["Pass", "Applicant", "Reviewer"],
      Decision: ["Applicant"],
      AuditLog: ["Instance"],
    };

    const position = new Map<string, number>(EXPORT_TABLE_NAMES.map((table, index) => [table, index]));

    for (const [table, dependencies] of Object.entries(dependsOn)) {
      for (const dependency of dependencies) {
        expect(
          position.get(dependency)!,
          `${dependency} must be written before ${table}`,
        ).toBeLessThan(position.get(table)!);
      }
    }
  });

  it("starts at Instance and ends at AuditLog", () => {
    expect(EXPORT_TABLE_NAMES[0]).toBe("Instance");
    expect(EXPORT_TABLE_NAMES.at(-1)).toBe("AuditLog");
  });
});

// ---------------------------------------------------------------------------
// canonicalValue
// ---------------------------------------------------------------------------

describe("canonicalValue", () => {
  it("turns a Date into an ISO string", () => {
    expect(canonicalValue(new Date("2026-08-25T12:00:00.000Z"), "x")).toBe("2026-08-25T12:00:00.000Z");
  });

  it("passes primitives and null through", () => {
    expect(canonicalValue("essay", "x")).toBe("essay");
    expect(canonicalValue(4, "x")).toBe(4);
    expect(canonicalValue(false, "x")).toBe(false);
    expect(canonicalValue(null, "x")).toBeNull();
  });

  it("sorts object keys, because jsonb reorders them on its own", () => {
    // Applicant.data comes back from Postgres with keys in whatever order jsonb
    // chose. Both sides of the round trip are read the same way, so key order is
    // never a real difference — and must not be able to look like one.
    const canonical = canonicalValue({ zeta: 1, alpha: 2, mid: 3 }, "x");
    expect(Object.keys(canonical as object)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("preserves array order rather than sorting it", () => {
    // Reviewer.rounds is a Postgres enum array whose order the database keeps.
    // Sorting here would hide a restore that reordered it.
    expect(canonicalValue(["SECOND_ROUND", "WRITTEN"], "x")).toEqual(["SECOND_ROUND", "WRITTEN"]);
  });

  it("recurses into nested objects inside JSONB", () => {
    const canonical = canonicalValue({ b: { d: 1, c: 2 }, a: [{ f: 1, e: 2 }] }, "x");
    expect(JSON.stringify(canonical)).toBe('{"a":[{"e":2,"f":1}],"b":{"c":2,"d":1}}');
  });

  it("throws on undefined rather than coercing it to null", () => {
    // A genuinely null column reads as null from Prisma, so undefined means the
    // query selected the wrong shape. Writing null would put a wrong value into
    // a file that claims to be exact.
    expect(() => canonicalValue(undefined, "Applicant.abc.email")).toThrow(ExportFormatError);
    expect(() => canonicalValue(undefined, "Applicant.abc.email")).toThrow(/Applicant\.abc\.email is undefined/);
  });

  it("throws on values JSON cannot carry", () => {
    expect(() => canonicalValue(NaN, "x")).toThrow(ExportFormatError);
    expect(() => canonicalValue(() => 1, "x")).toThrow(ExportFormatError);
  });
});

// ---------------------------------------------------------------------------
// canonicalizeSnapshot
// ---------------------------------------------------------------------------

describe("canonicalizeSnapshot", () => {
  it("orders rows by id, so two reads of one instance agree", () => {
    const snapshot = withRows("PassApplicant", [
      passApplicant("pa-3", "CARRIED"),
      passApplicant("pa-1", null),
      passApplicant("pa-2", "NEEDS_ADMIN"),
    ]);
    const canonical = canonicalizeSnapshot(snapshot);
    expect(canonical.tables.PassApplicant.map((row) => row.id)).toEqual(["pa-1", "pa-2", "pa-3"]);
  });

  it("emits columns in manifest order", () => {
    const canonical = canonicalizeSnapshot(withRows("PassApplicant", [passApplicant("pa-1", "SPARKLET")]));
    expect(Object.keys(canonical.tables.PassApplicant[0])).toEqual([
      "id",
      "passId",
      "applicantId",
      "resolution",
      "resolvedAt",
      "createdAt",
      "updatedAt",
    ]);
  });

  it("fills a table absent from the input with an empty array", () => {
    const canonical = canonicalizeSnapshot({ ...emptySnapshot(), tables: {} });
    expect(rowCounts(canonical).every(({ rows }) => rows === 0)).toBe(true);
    expect(Object.keys(canonical.tables)).toHaveLength(EXPORT_TABLES.length);
  });
});

// ---------------------------------------------------------------------------
// serialize and parse
// ---------------------------------------------------------------------------

describe("serializeExport / parseExport", () => {
  it("round-trips a snapshot unchanged", () => {
    const snapshot = withRows("PassApplicant", [
      passApplicant("pa-1", null),
      passApplicant("pa-2", "NEEDS_ADMIN"),
    ]);
    const parsed = parseExport(serializeExport(snapshot));
    expect(diffSnapshots(snapshot, parsed)).toEqual([]);
  });

  it("writes an explicit null rather than omitting the key", () => {
    // The case decision 88 singles out. An omit-nulls export makes
    // PassApplicant.resolution = NULL indistinguishable from a truncated row,
    // and NULL is one of five distinct outcomes.
    const text = serializeExport(withRows("PassApplicant", [passApplicant("pa-1", null)]));
    expect(text).toContain('"resolution": null');
    expect(parseExport(text).tables.PassApplicant[0].resolution).toBeNull();
  });

  it("keeps NEEDS_ADMIN, CARRIED and null distinguishable", () => {
    const snapshot = withRows("PassApplicant", [
      passApplicant("pa-1", null),
      passApplicant("pa-2", "CARRIED"),
      passApplicant("pa-3", "NEEDS_ADMIN"),
      passApplicant("pa-4", "SPARKLET"),
      passApplicant("pa-5", "REJECTED"),
    ]);
    const parsed = parseExport(serializeExport(snapshot));
    expect(parsed.tables.PassApplicant.map((row) => row.resolution)).toEqual([
      null,
      "CARRIED",
      "NEEDS_ADMIN",
      "SPARKLET",
      "REJECTED",
    ]);
  });

  it("refuses a row with a column missing", () => {
    const text = JSON.stringify({
      ...emptySnapshot(),
      tables: { ...emptySnapshot().tables, PassApplicant: [{ id: "pa-1", passId: "p", applicantId: "a" }] },
    });
    expect(() => parseExport(text)).toThrow(/missing resolution, resolvedAt, createdAt, updatedAt/);
  });

  it("refuses a row carrying a column this code does not know", () => {
    const row = { ...passApplicant("pa-1", null), somethingNew: 1 };
    const text = JSON.stringify({ ...emptySnapshot(), tables: { ...emptySnapshot().tables, PassApplicant: [row] } });
    expect(() => parseExport(text)).toThrow(/unknown columns: somethingNew/);
  });

  it("refuses a file missing a whole table", () => {
    const tables = { ...emptySnapshot().tables };
    delete tables.PassVote;
    expect(() => parseExport(JSON.stringify({ ...emptySnapshot(), tables }))).toThrow(
      /missing the "PassVote" table/,
    );
  });

  it("refuses a file carrying a table this code does not know", () => {
    const tables = { ...emptySnapshot().tables, SomethingNew: [] };
    expect(() => parseExport(JSON.stringify({ ...emptySnapshot(), tables }))).toThrow(
      /tables this code does not know: SomethingNew/,
    );
  });

  it("refuses a different format version", () => {
    expect(() => parseExport(JSON.stringify({ ...emptySnapshot(), formatVersion: 99 }))).toThrow(
      /format version 99/,
    );
  });

  it("refuses text that is not JSON at all", () => {
    expect(() => parseExport("not json")).toThrow(ExportFormatError);
  });

  it("refuses a file carrying a UTF-8 BOM, which is why the JSON export never gets one", () => {
    // The CSVs are served with a BOM so Excel decodes them as UTF-8. The JSON
    // must NOT be: `JSON.parse` rejects a leading U+FEFF, so a BOM here would
    // make the export unrestorable — the one thing FR-20 cannot allow. Pinned so
    // that "add a BOM to the downloads" is never applied uniformly.
    const text = `﻿${serializeExport(emptySnapshot())}`;
    expect(() => parseExport(text)).toThrow(ExportFormatError);
  });
});

// ---------------------------------------------------------------------------
// diffSnapshots — what "intact" means
// ---------------------------------------------------------------------------

describe("diffSnapshots", () => {
  it("reports nothing for two identical snapshots", () => {
    const snapshot = withRows("PassApplicant", [passApplicant("pa-1", "NEEDS_ADMIN")]);
    expect(diffSnapshots(snapshot, structuredClone(snapshot))).toEqual([]);
  });

  it("ignores generatedAt, which describes the file rather than the instance", () => {
    const before = emptySnapshot({ generatedAt: "2026-08-25T12:00:00.000Z" });
    const after = emptySnapshot({ generatedAt: "2026-08-25T12:00:09.000Z" });
    expect(diffSnapshots(before, after)).toEqual([]);
  });

  it("catches a resolution collapsing from NEEDS_ADMIN to null", () => {
    // The specific regression the round-trip check exists to catch: an
    // omit-nulls restore that reads an absent key as "not resolved".
    const before = withRows("PassApplicant", [passApplicant("pa-1", "NEEDS_ADMIN")]);
    const after = withRows("PassApplicant", [passApplicant("pa-1", null)]);
    const differences = diffSnapshots(before, after);
    expect(differences).toContainEqual({
      table: "PassApplicant",
      rowId: "pa-1",
      column: "resolution",
      detail: '"NEEDS_ADMIN" became null',
    });
  });

  it("catches a row that did not come back", () => {
    const before = withRows("PassApplicant", [passApplicant("pa-1", null), passApplicant("pa-2", null)]);
    const after = withRows("PassApplicant", [passApplicant("pa-1", null)]);
    expect(diffSnapshots(before, after)).toEqual([
      { table: "PassApplicant", rowId: "pa-2", column: null, detail: "row is missing after the round trip" },
    ]);
  });

  it("catches a row that appeared from nowhere", () => {
    const before = withRows("PassApplicant", [passApplicant("pa-1", null)]);
    const after = withRows("PassApplicant", [passApplicant("pa-1", null), passApplicant("pa-2", null)]);
    expect(diffSnapshots(before, after)).toEqual([
      { table: "PassApplicant", rowId: "pa-2", column: null, detail: "row appeared that was not exported" },
    ]);
  });

  it("catches a regenerated id, which is what decision 88 forbids", () => {
    const before = withRows("Reviewer", [
      { id: "rev-1", instanceId: "i", firstName: "Mary Anne", lastName: "Chen", isSparklet: false, rounds: ["WRITTEN"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const after = withRows("Reviewer", [
      { id: "cmt-new-cuid", instanceId: "i", firstName: "Mary Anne", lastName: "Chen", isSparklet: false, rounds: ["WRITTEN"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(diffSnapshots(before, after)).toHaveLength(2);
  });

  it("compares createdAt and updatedAt rather than excusing them", () => {
    const before = withRows("PassApplicant", [passApplicant("pa-1", "CARRIED")]);
    const after = withRows("PassApplicant", [
      { ...passApplicant("pa-1", "CARRIED"), updatedAt: "2026-08-25T13:00:00.000Z" },
    ]);
    expect(diffSnapshots(before, after)).toContainEqual({
      table: "PassApplicant",
      rowId: "pa-1",
      column: "updatedAt",
      detail: '"2026-08-20T00:00:00.000Z" became "2026-08-25T13:00:00.000Z"',
    });
  });

  it("does not care what order the rows arrived in", () => {
    const before = withRows("PassApplicant", [passApplicant("pa-1", null), passApplicant("pa-2", null)]);
    const after = withRows("PassApplicant", [passApplicant("pa-2", null), passApplicant("pa-1", null)]);
    expect(diffSnapshots(before, after)).toEqual([]);
  });

  it("does not care what order jsonb handed back an applicant's data keys", () => {
    const row = (data: ExportRow): ExportRow => ({
      id: "app-1",
      instanceId: "i",
      sourceRowIndex: 47,
      email: "a@usc.edu",
      displayName: "Applicant 47",
      data,
      status: "ACTIVE",
      stageReached: "WRITTEN",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const before = withRows("Applicant", [row({ fieldB: "2", fieldA: "1" })]);
    const after = withRows("Applicant", [row({ fieldA: "1", fieldB: "2" })]);
    expect(diffSnapshots(before, after)).toEqual([]);
  });
});
