// FR-20's export format. Pure — no database, no Prisma client, no `server-only`.
//
// The rule CLAUDE.md puts on lib/assignment.ts, lib/passes.ts and lib/roster.ts
// applies here for the same reason: this module decides what "the entire
// instance" means and what "intact" means, and both are properties that have to
// be testable without a database in front of them. lib/instance-io.ts is the
// half that touches Prisma.
//
// PRD decisions 86-88 and 90 are the spec. The short form:
//
//   - Every row of every table belonging to the instance, in foreign-key
//     dependency order, each table ordered by `id`.
//   - Every column emitted, INCLUDING NULLS, explicitly. A missing key on
//     restore is an error, never a default. That is what keeps
//     PassApplicant.resolution five-valued, so NEEDS_ADMIN, CARRIED and NULL
//     cannot collapse into one another.
//   - Every id written back verbatim (decision 88), so the round trip is an
//     identity and the comparison needs no exceptions.

/// Bumped when the shape of the envelope changes in a way an older restore
/// could not read. Adding or removing a column is NOT a format change — it is
/// caught by the manifest check in `parseExport`, which is the more precise
/// failure and names the column.
///
/// Removal was first exercised by decision 109, which dropped `archivedAt` and
/// `archiveSummary`: an export written before it fails with
/// `Instance[0] carries unknown columns: archivedAt, archiveSummary`, and the
/// recovery is deleting those two keys. Decision 86's round-trip guarantee is a
/// same-version guarantee, which is why this number did not move.
export const EXPORT_FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

export interface TableManifest {
  /// The Prisma model name.
  table: string;
  /// Every scalar column, in schema order.
  columns: readonly string[];
}

/// The twenty-four tables that make up one instance, **in foreign-key
/// dependency order**. `writeSnapshot` walks this list and nothing else decides
/// ordering, so the order here is load-bearing rather than cosmetic.
///
/// Three entries carry a dependency that no foreign key expresses, and each is
/// the reason its neighbour sits where it does:
///
///   - `Applicant.data` is a JSONB object **keyed by `Field.id`**, so `Field`
///     must exist before any applicant is written.
///   - `InterviewImport.mapping` encodes roles as `CATEGORY:<interviewCategoryId>`
///     inside its string values, so `InterviewCategory` precedes it.
///   - `AuditLog.entityId` and `previousValue` hold ids from every table as
///     plain strings, which is why AuditLog is last and why decision 88 refuses
///     to regenerate ids at all: there is no foreign key here to follow.
///
/// **This list is asserted against the generated Prisma client's
/// `<Model>ScalarFieldEnum` values in lib/export.test.ts.** A column added to
/// the schema and not added here fails `npm run verify`, rather than being
/// silently dropped by a restore months later.
/// `as const satisfies` rather than a plain annotation: it keeps the table names
/// as a literal union (`ExportTableName` below) while still checking the shape.
/// That union is what makes `readSnapshot`'s per-table query map exhaustive at
/// compile time — a table added here with no query fails `npm run typecheck`
/// rather than exporting as an empty array.
export const EXPORT_TABLES = [
  { table: "Instance", columns: ["id", "name", "passwordHash", "currentStage", "createdAt", "updatedAt", "importCommittedAt", "importProposals"] },
  { table: "FieldGroup", columns: ["id", "instanceId", "key", "displayName", "category", "isMultiSelect", "isIncluded", "ordinal", "isReviewerVisible", "createdAt", "updatedAt"] },
  { table: "Field", columns: ["id", "instanceId", "sourceHeader", "displayName", "category", "groupId", "groupRole", "promotedRole", "ordinal", "isIncluded", "isReviewerVisible", "createdAt", "updatedAt"] },
  { table: "ImportRow", columns: ["id", "instanceId", "rowIndex", "cells", "discarded", "createdAt"] },
  { table: "RubricCategory", columns: ["id", "instanceId", "name", "maxPoints", "ordinal", "minPoints", "description", "createdAt", "updatedAt"] },
  { table: "InterviewCategory", columns: ["id", "instanceId", "name", "maxPoints", "ordinal", "createdAt", "updatedAt"] },
  { table: "RoundAccessCode", columns: ["id", "instanceId", "round", "codeHash", "createdAt", "updatedAt"] },
  { table: "Reviewer", columns: ["id", "instanceId", "firstName", "lastName", "isSparklet", "rounds", "createdAt", "updatedAt"] },
  { table: "Applicant", columns: ["id", "instanceId", "sourceRowIndex", "email", "displayName", "data", "status", "stageReached", "createdAt", "updatedAt"] },
  { table: "Assignment", columns: ["id", "instanceId", "round", "applicantId", "reviewerId", "origin", "status", "returnReason", "returnNote", "returnedAt", "createdAt", "updatedAt"] },
  { table: "Score", columns: ["id", "assignmentId", "rubricCategoryId", "points", "createdAt", "updatedAt"] },
  { table: "ReviewNote", columns: ["id", "assignmentId", "body", "createdAt", "updatedAt"] },
  { table: "InterviewResult", columns: ["id", "applicantId", "interviewerName", "score", "createdAt", "updatedAt"] },
  { table: "InterviewCategoryScore", columns: ["id", "interviewResultId", "interviewCategoryId", "points", "createdAt", "updatedAt"] },
  { table: "InterviewNotes", columns: ["id", "applicantId", "interviewerName", "body", "createdAt", "updatedAt"] },
  { table: "InterviewImport", columns: ["id", "instanceId", "sheet", "headers", "mapping", "uploadedAt"] },
  { table: "InterviewImportRow", columns: ["id", "instanceId", "importId", "sheet", "rowIndex", "cells", "matchedApplicantId", "matchTier", "matchConfidence", "skipped", "createdAt", "updatedAt"] },
  { table: "FirstRoundVote", columns: ["id", "applicantId", "reviewerId", "value", "submittedAt", "updatedAt"] },
  { table: "ConflictOfInterest", columns: ["id", "round", "applicantId", "reviewerId", "createdAt"] },
  { table: "Pass", columns: ["id", "instanceId", "ordinal", "status", "openedAt", "closedAt"] },
  { table: "PassApplicant", columns: ["id", "passId", "applicantId", "resolution", "resolvedAt", "createdAt", "updatedAt"] },
  { table: "PassVote", columns: ["id", "passId", "applicantId", "reviewerId", "value", "submittedAt", "updatedAt"] },
  { table: "Decision", columns: ["id", "applicantId", "stage", "outcome", "actor", "decidedAt", "updatedAt"] },
  { table: "AuditLog", columns: ["id", "instanceId", "actor", "actorName", "action", "entityType", "entityId", "previousValue", "createdAt"] },
] as const satisfies readonly TableManifest[];

/// Every table the export carries, as a literal union.
export type ExportTableName = (typeof EXPORT_TABLES)[number]["table"];

/// The table names in write order, which is the order `EXPORT_TABLES` declares.
export const EXPORT_TABLE_NAMES: readonly ExportTableName[] = EXPORT_TABLES.map((entry) => entry.table);

/// Tables that deliberately sit OUTSIDE the export, each with the reason it does.
/// PRD decision 96.
///
/// `lib/export.test.ts` asserts that the models in the generated Prisma client
/// are exactly `EXPORT_TABLE_NAMES` plus this list, so a table added to the
/// schema still fails `npm run verify` until someone decides, in writing and in
/// this file, which side of the line it falls on. That is the same guarantee the
/// original set-equality assertion gave; what changed is that the answer can now
/// be "not exported", stated explicitly, rather than only "exported".
///
/// **Adding an entry here is a decision about FR-20's completeness.** The bar is
/// that the table cannot belong to an instance — not that exporting it would be
/// inconvenient. Anything an instance owns is part of what "the entire instance"
/// means, and decision 86 already settled that credential-bearing rows are in.
export const NON_INSTANCE_TABLES: readonly string[] = [
  // Keyed by client address and owned by the deployment, not by any cycle.
  // Restoring one deployment's lockouts into another's database would be
  // incoherent — the addresses mean nothing there, and the rows would refuse
  // real admins on the strength of an attack that happened somewhere else.
  // Its durable record is the AuditLog row a lockout writes, which IS exported
  // for the two instance-scoped gates. See decision 92.
  "RateLimitBucket",
];

/// Columns that are `DateTime` in the schema, per table.
///
/// Only the restore needs these. Reading, JSON carries an ISO string happily;
/// writing, Prisma wants a `Date` and refuses a string — loudly, at the insert,
/// which is what makes a mistake here a failed check rather than a silent
/// corruption. `lib/export.test.ts` additionally asserts every name below is a
/// real column of its table, which catches the typo case that would otherwise
/// leave a timestamp quietly unconverted.
export const DATE_COLUMNS: Readonly<Record<ExportTableName, readonly string[]>> = {
  Instance: ["createdAt", "updatedAt", "importCommittedAt"],
  FieldGroup: ["createdAt", "updatedAt"],
  Field: ["createdAt", "updatedAt"],
  ImportRow: ["createdAt"],
  RubricCategory: ["createdAt", "updatedAt"],
  InterviewCategory: ["createdAt", "updatedAt"],
  RoundAccessCode: ["createdAt", "updatedAt"],
  Reviewer: ["createdAt", "updatedAt"],
  Applicant: ["createdAt", "updatedAt"],
  Assignment: ["returnedAt", "createdAt", "updatedAt"],
  Score: ["createdAt", "updatedAt"],
  ReviewNote: ["createdAt", "updatedAt"],
  InterviewResult: ["createdAt", "updatedAt"],
  InterviewCategoryScore: ["createdAt", "updatedAt"],
  InterviewNotes: ["createdAt", "updatedAt"],
  InterviewImport: ["uploadedAt"],
  InterviewImportRow: ["createdAt", "updatedAt"],
  FirstRoundVote: ["submittedAt", "updatedAt"],
  ConflictOfInterest: ["createdAt"],
  Pass: ["openedAt", "closedAt"],
  PassApplicant: ["resolvedAt", "createdAt", "updatedAt"],
  PassVote: ["submittedAt", "updatedAt"],
  Decision: ["decidedAt", "updatedAt"],
  AuditLog: ["createdAt"],
};

/// Columns that are **nullable** `Json` in the schema.
///
/// These are the only two remaining places where `null` cannot be written as
/// `null`:
/// Prisma wants `Prisma.DbNull` for a SQL NULL in a nullable Json column and
/// `Prisma.JsonNull` for a JSON `null` literal, and passing a bare `null` is a
/// type error rather than a silent wrong write. Non-nullable Json columns
/// (`ImportRow.cells`, `Applicant.data`, `InterviewImport.headers` and
/// `.mapping`, `InterviewImportRow.cells`) never hold null and need no mapping.
///
/// Getting `Instance.importProposals` wrong is caught by the
/// `importCommittedAt IS NULL OR importProposals IS NULL` CHECK on any committed
/// instance, which is the guard §5 added for a different reason and which
/// happens to cover this one too.
export const NULLABLE_JSON_COLUMNS: Readonly<Partial<Record<ExportTableName, readonly string[]>>> = {
  Instance: ["importProposals"],
  AuditLog: ["previousValue"],
};

// Keyed by plain `string` rather than by `ExportTableName`: the whole job of
// `parseExport` is to decide whether a name read out of an untrusted file is one
// of ours, and a map that only accepts names already known cannot answer that.
const MANIFEST_BY_TABLE = new Map<string, TableManifest>(
  EXPORT_TABLES.map((entry) => [entry.table, entry]),
);

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/// What survives JSON. Dates arrive here already converted to ISO strings by
/// `canonicalizeSnapshot`, which is what makes the before-and-after comparison
/// an apples-to-apples one: both sides are read through Postgres and normalized
/// by the same function.
export type ExportValue = string | number | boolean | null | ExportValue[] | { [key: string]: ExportValue };

export type ExportRow = Record<string, ExportValue>;

export interface InstanceSnapshot {
  formatVersion: number;
  /// When the file was written. **Deliberately outside `diffSnapshots`** — it
  /// describes the export event, not the instance, and two exports of identical
  /// data taken a second apart must not read as a difference. It is the only
  /// value in the envelope that is expected to vary, and it is metadata rather
  /// than data.
  generatedAt: string;
  instanceId: string;
  /// Keyed by table name. Every table in `EXPORT_TABLES` is present, including
  /// the ones with no rows — an absent table and an empty table are different
  /// claims, and only one of them is true.
  tables: Record<string, ExportRow[]>;
}

/// Thrown by `parseExport` when a file is not one this code can restore.
/// A distinct class so the check script can tell "the file is wrong" from
/// "the database is wrong", which are different failures with different fixes.
export class ExportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportFormatError";
  }
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/// One value, normalized for both serialization and comparison.
///
/// `Date` becomes an ISO-8601 string; everything else that JSON already carries
/// passes through. Object keys are sorted, because both snapshots come back
/// through Postgres `jsonb`, which reorders keys on its own — so key order is
/// never a real difference and must not be able to look like one.
///
/// **Array order is preserved, never sorted.** `Reviewer.rounds` is a Postgres
/// enum array whose order the database keeps and a restore writes back
/// unchanged; sorting it here would hide a restore that reordered it.
///
/// `undefined` throws rather than being coerced to null. A column that is
/// genuinely null reads as `null` from Prisma, so `undefined` means the caller
/// selected the wrong shape, and silently writing null would put a wrong value
/// in an export that claims to be exact.
export function canonicalValue(value: unknown, path: string): ExportValue {
  if (value === null) return null;
  if (value === undefined) {
    throw new ExportFormatError(
      `${path} is undefined. Every column must be selected and emitted explicitly; ` +
        `a null column reads as null, so undefined means the query shape is wrong.`,
    );
  }
  if (value instanceof Date) return value.toISOString();

  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value as string | boolean;
  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      throw new ExportFormatError(`${path} is ${String(value)}, which JSON cannot carry.`);
    }
    return value as number;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`));
  }

  if (kind === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, ExportValue> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalValue(source[key], `${path}.${key}`);
    }
    return sorted;
  }

  throw new ExportFormatError(`${path} is a ${kind}, which this export format does not carry.`);
}

/// A whole snapshot, normalized: every table present, rows ordered by `id`,
/// columns in manifest order, values canonicalized.
///
/// Run on both sides of the round trip, so a difference the comparison reports
/// is a difference in the data rather than in how Postgres happened to hand it
/// back.
export function canonicalizeSnapshot(snapshot: InstanceSnapshot): InstanceSnapshot {
  const tables: Record<string, ExportRow[]> = {};

  for (const { table, columns } of EXPORT_TABLES) {
    const rows = snapshot.tables[table] ?? [];
    const canonical = rows.map((row) => {
      const out: ExportRow = {};
      for (const column of columns) {
        out[column] = canonicalValue(row[column], `${table}.${String(row.id)}.${column}`);
      }
      return out;
    });

    // By id, so two reads of the same data are in the same order regardless of
    // what Postgres chose to return. Every table in the model has an `id`.
    canonical.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    tables[table] = canonical;
  }

  return {
    formatVersion: snapshot.formatVersion,
    generatedAt: snapshot.generatedAt,
    instanceId: snapshot.instanceId,
    tables,
  };
}

// ---------------------------------------------------------------------------
// Serialize and parse
// ---------------------------------------------------------------------------

/// The export file. Indented and canonically ordered so that when a round trip
/// does fail, the two files can be diffed by hand and the diff is about the
/// data rather than about formatting.
export function serializeExport(snapshot: InstanceSnapshot): string {
  return `${JSON.stringify(canonicalizeSnapshot(snapshot), null, 2)}\n`;
}

/// Read a file back, refusing anything this code cannot restore exactly.
///
/// **Shape is checked before content**, and the checks are deliberately strict
/// in both directions. A table or column present in the file but unknown here
/// means the file came from a newer schema and restoring it would silently drop
/// data. A table or column known here but absent from the file means the
/// opposite. Both are named rather than defaulted, which is the whole reason
/// nulls are emitted explicitly: a missing key is an error, never a zero value.
export function parseExport(text: string): InstanceSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ExportFormatError(`Not valid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ExportFormatError("The export must be a JSON object.");
  }
  const envelope = parsed as Record<string, unknown>;

  if (envelope.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw new ExportFormatError(
      `Export format version ${String(envelope.formatVersion)}, but this code reads ` +
        `version ${EXPORT_FORMAT_VERSION}.`,
    );
  }
  if (typeof envelope.instanceId !== "string" || envelope.instanceId === "") {
    throw new ExportFormatError("The export names no instanceId.");
  }
  if (typeof envelope.generatedAt !== "string") {
    throw new ExportFormatError("The export names no generatedAt.");
  }
  if (typeof envelope.tables !== "object" || envelope.tables === null || Array.isArray(envelope.tables)) {
    throw new ExportFormatError("The export carries no tables object.");
  }

  const source = envelope.tables as Record<string, unknown>;

  const unknownTables = Object.keys(source).filter((table) => !MANIFEST_BY_TABLE.has(table));
  if (unknownTables.length > 0) {
    throw new ExportFormatError(
      `The export carries tables this code does not know: ${unknownTables.join(", ")}. ` +
        `It was probably written by a newer schema, and restoring it would drop them.`,
    );
  }

  const tables: Record<string, ExportRow[]> = {};

  for (const { table, columns } of EXPORT_TABLES) {
    const rows = source[table];
    if (rows === undefined) {
      throw new ExportFormatError(
        `The export is missing the "${table}" table. An absent table and an empty ` +
          `table are different claims; an empty one is written as [].`,
      );
    }
    if (!Array.isArray(rows)) {
      throw new ExportFormatError(`"${table}" is not an array of rows.`);
    }

    const expected = new Set<string>(columns);
    rows.forEach((row, index) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new ExportFormatError(`${table}[${index}] is not a row object.`);
      }
      const present = Object.keys(row as Record<string, unknown>);

      const missing = columns.filter((column) => !(column in (row as Record<string, unknown>)));
      if (missing.length > 0) {
        throw new ExportFormatError(
          `${table}[${index}] is missing ${missing.join(", ")}. Every column is emitted ` +
            `explicitly, nulls included — a missing key is an error, never a default.`,
        );
      }

      const extra = present.filter((column) => !expected.has(column));
      if (extra.length > 0) {
        throw new ExportFormatError(
          `${table}[${index}] carries unknown columns: ${extra.join(", ")}.`,
        );
      }
    });

    tables[table] = rows as ExportRow[];
  }

  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: envelope.generatedAt,
    instanceId: envelope.instanceId,
    tables,
  };
}

// ---------------------------------------------------------------------------
// The comparison — what "intact" means
// ---------------------------------------------------------------------------

/// One way in which two snapshots disagree.
///
/// Field-level rather than a blind object diff, so the round-trip check can say
/// "PassApplicant <id>.resolution: NEEDS_ADMIN became null" rather than
/// printing two large objects and leaving a person to find it.
export interface SnapshotDifference {
  table: string;
  /// Null for a difference about the table as a whole.
  rowId: string | null;
  /// Null for a difference about a row as a whole.
  column: string | null;
  detail: string;
}

function show(value: ExportValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/// Compare two snapshots field by field over the manifest.
///
/// **`generatedAt` is not compared** — see `InstanceSnapshot`. Everything else
/// is, including `id`, `createdAt` and `updatedAt`: decision 88 preserves ids
/// and timestamps explicitly, so nothing about the data is expected to differ
/// and the comparison carries no exception list. A comparison with expected
/// drift in it is one a real regression can hide inside.
export function diffSnapshots(before: InstanceSnapshot, after: InstanceSnapshot): SnapshotDifference[] {
  const differences: SnapshotDifference[] = [];

  if (before.instanceId !== after.instanceId) {
    differences.push({
      table: "(envelope)",
      rowId: null,
      column: "instanceId",
      detail: `${before.instanceId} became ${after.instanceId}`,
    });
  }

  const left = canonicalizeSnapshot(before);
  const right = canonicalizeSnapshot(after);

  for (const { table, columns } of EXPORT_TABLES) {
    const leftRows = new Map(left.tables[table].map((row) => [String(row.id), row]));
    const rightRows = new Map(right.tables[table].map((row) => [String(row.id), row]));

    for (const [id, leftRow] of leftRows) {
      const rightRow = rightRows.get(id);
      if (rightRow === undefined) {
        differences.push({ table, rowId: id, column: null, detail: "row is missing after the round trip" });
        continue;
      }
      for (const column of columns) {
        const a = leftRow[column];
        const b = rightRow[column];
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          differences.push({ table, rowId: id, column, detail: `${show(a)} became ${show(b)}` });
        }
      }
    }

    for (const id of rightRows.keys()) {
      if (!leftRows.has(id)) {
        differences.push({ table, rowId: id, column: null, detail: "row appeared that was not exported" });
      }
    }
  }

  return differences;
}

/// A printable form, for the round-trip check's output.
export function formatDifferences(differences: readonly SnapshotDifference[]): string {
  return differences
    .map((difference) => {
      const where = [difference.table, difference.rowId, difference.column].filter(Boolean).join(" · ");
      return `  ${where}: ${difference.detail}`;
    })
    .join("\n");
}

/// How many rows the snapshot holds, per table, for the check's summary and for
/// the export page's "what is in this file" line.
export function rowCounts(snapshot: InstanceSnapshot): { table: string; rows: number }[] {
  return EXPORT_TABLES.map(({ table }) => ({ table, rows: snapshot.tables[table]?.length ?? 0 }));
}
