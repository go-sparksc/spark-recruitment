import "server-only";

// FR-20's database half. `lib/export.ts` decides what the format IS; this
// module is the part that reads it out of Postgres and (in slice 2) writes it
// back. Kept apart for the reason CLAUDE.md gives about pages: everything that
// can be decided without a database should be, so it can be tested without one.
//
// **`server-only` makes this module unimportable from a plain `tsx` script**,
// which matters because `prisma/checks/round-trip.ts` has to import it — a check
// that re-implemented these reads would be verifying a second copy of the thing
// under test. Run such a script with `tsx --conditions=react-server`, which
// resolves the `server-only` package to its empty build rather than to the
// module that throws. The flag form is used rather than `NODE_OPTIONS=` because
// npm scripts run through cmd.exe on Windows, where the env-var prefix is not a
// thing. The marker stays: this module reads `passwordHash` and every
// `codeHash`, and keeping it out of a client bundle is worth one flag.
//
// **Nothing here may import `slugify` or `uniqueSlug` from lib/fields.ts.**
// `FieldGroup.key` is immutable by decision 13 and travels through the export
// verbatim; a restore that re-slugged it from `displayName` would reintroduce
// the name-keying defect this system exists to remove, and would do it silently
// because the resulting key still looks reasonable.

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  DATE_COLUMNS,
  EXPORT_FORMAT_VERSION,
  EXPORT_TABLES,
  NULLABLE_JSON_COLUMNS,
  canonicalizeSnapshot,
  type ExportRow,
  type ExportTableName,
  type InstanceSnapshot,
} from "@/lib/export";

/// Every table read in one go, keyed by the manifest's table name.
///
/// Typed as a total record over `ExportTableName`, which is what makes this
/// exhaustive: adding a table to `EXPORT_TABLES` without adding its query here
/// fails `npm run typecheck` rather than exporting an empty array and passing
/// the round trip.
type TableReader = Record<ExportTableName, () => Promise<unknown[]>>;

/// Read one instance in full.
///
/// **Scoping is per table and deliberate.** Twelve tables carry `instanceId`
/// directly; the rest are reached through the row that owns them, and each is
/// scoped through the relation that actually owns it rather than through
/// whichever relation happens to be shortest — `InterviewCategoryScore` hangs
/// off its `InterviewResult`, not off its category, because that is the row it
/// would be deleted with.
///
/// `AuditLog` is scoped by `instanceId`, which excludes the orphaned rows §8
/// leaves behind when an instance is deleted. Those belong to no instance by
/// design, and an export claiming them would attach one instance's file to
/// another instance's deletion.
export async function readSnapshot(
  prisma: PrismaClient,
  instanceId: string,
): Promise<InstanceSnapshot> {
  const byInstance = { instanceId };

  const readers: TableReader = {
    Instance: () => prisma.instance.findMany({ where: { id: instanceId } }),
    FieldGroup: () => prisma.fieldGroup.findMany({ where: byInstance }),
    Field: () => prisma.field.findMany({ where: byInstance }),
    ImportRow: () => prisma.importRow.findMany({ where: byInstance }),
    RubricCategory: () => prisma.rubricCategory.findMany({ where: byInstance }),
    // Decision 114. Scoped through its category, the same way Score reaches the
    // instance through its assignment — RubricLevel carries no instanceId, so
    // an unscoped read here would export every instance's rubric prose into one
    // instance's file.
    RubricLevel: () => prisma.rubricLevel.findMany({ where: { rubricCategory: byInstance } }),
    InterviewCategory: () => prisma.interviewCategory.findMany({ where: byInstance }),
    RoundAccessCode: () => prisma.roundAccessCode.findMany({ where: byInstance }),
    Reviewer: () => prisma.reviewer.findMany({ where: byInstance }),
    Applicant: () => prisma.applicant.findMany({ where: byInstance }),
    Assignment: () => prisma.assignment.findMany({ where: byInstance }),
    Score: () => prisma.score.findMany({ where: { assignment: byInstance } }),
    ReviewNote: () => prisma.reviewNote.findMany({ where: { assignment: byInstance } }),
    InterviewResult: () => prisma.interviewResult.findMany({ where: { applicant: byInstance } }),
    InterviewCategoryScore: () =>
      prisma.interviewCategoryScore.findMany({
        where: { interviewResult: { applicant: byInstance } },
      }),
    InterviewNotes: () => prisma.interviewNotes.findMany({ where: { applicant: byInstance } }),
    InterviewImport: () => prisma.interviewImport.findMany({ where: byInstance }),
    InterviewImportRow: () => prisma.interviewImportRow.findMany({ where: byInstance }),
    FirstRoundVote: () => prisma.firstRoundVote.findMany({ where: { applicant: byInstance } }),
    ConflictOfInterest: () => prisma.conflictOfInterest.findMany({ where: { applicant: byInstance } }),
    Pass: () => prisma.pass.findMany({ where: byInstance }),
    PassApplicant: () => prisma.passApplicant.findMany({ where: { pass: byInstance } }),
    PassVote: () => prisma.passVote.findMany({ where: { pass: byInstance } }),
    Decision: () => prisma.decision.findMany({ where: { applicant: byInstance } }),
    AuditLog: () => prisma.auditLog.findMany({ where: byInstance }),
  };

  const names = Object.keys(readers) as ExportTableName[];
  const results = await Promise.all(names.map((name) => readers[name]()));

  const tables: Record<string, ExportRow[]> = {};
  names.forEach((name, index) => {
    tables[name] = results[index] as ExportRow[];
  });

  if (tables.Instance.length === 0) {
    throw new Error(`No instance ${instanceId} to export.`);
  }

  // Canonicalized on the way out, so the file and the in-memory snapshot are the
  // same thing: rows ordered by id, columns in manifest order, dates as ISO
  // strings. Both sides of the round trip then run through one normalization
  // and a difference the comparison reports is a difference in the data.
  return canonicalizeSnapshot({
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    instanceId,
    tables,
  });
}

// ---------------------------------------------------------------------------
// The restore
// ---------------------------------------------------------------------------

/// Just enough of a Prisma model delegate to bulk-insert through it. Narrower
/// than `any`, which keeps the dynamic dispatch below honest without pulling in
/// twenty-four generated argument types that would say nothing extra.
interface CreateManyDelegate {
  createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
}

/// One row, converted from what JSON carries back to what Prisma accepts.
///
/// Two conversions, and no others: an ISO string becomes a `Date` for a
/// `DateTime` column, and `null` becomes `Prisma.DbNull` for a nullable `Json`
/// column. Everything else — enums, scalar lists, non-null JSONB, numbers — goes
/// in exactly as the file carries it, which is what decision 88 means by the
/// round trip being an identity.
function toPrismaRow(
  table: ExportTableName,
  row: ExportRow,
): Record<string, unknown> {
  const dateColumns = new Set<string>(DATE_COLUMNS[table]);
  const nullableJson = new Set<string>(NULLABLE_JSON_COLUMNS[table] ?? []);
  const out: Record<string, unknown> = {};

  for (const [column, value] of Object.entries(row)) {
    if (dateColumns.has(column)) {
      out[column] = value === null ? null : new Date(value as string);
      continue;
    }
    if (nullableJson.has(column) && value === null) {
      // NOT `null`. See NULLABLE_JSON_COLUMNS — a bare null is a type error
      // here, and DbNull is what actually writes SQL NULL.
      out[column] = Prisma.DbNull;
      continue;
    }
    out[column] = value;
  }

  return out;
}

/// Write a whole instance back, in foreign-key dependency order.
///
/// **Every id is written explicitly** (decision 88), so no foreign key is
/// remapped and `Applicant.data`'s `Field.id` keys, `InterviewImport.mapping`'s
/// embedded category ids, and `AuditLog.entityId` all keep pointing at rows that
/// exist. That is the property that makes a restore an identity rather than a
/// copy, and it is why the collision check below refuses rather than merges.
///
/// One transaction and one `createMany` per table — a fixed number of bulk
/// statements rather than a statement per row. FR-11's finalize learned that the
/// hard way when 150 sequential round trips exceeded Prisma's transaction limit.
export async function writeSnapshot(
  prisma: PrismaClient,
  snapshot: InstanceSnapshot,
): Promise<{ table: ExportTableName; rows: number }[]> {
  const canonical = canonicalizeSnapshot(snapshot);

  const existing = await prisma.instance.findUnique({
    where: { id: canonical.instanceId },
    select: { id: true },
  });
  if (existing) {
    throw new Error(
      `Instance ${canonical.instanceId} already exists. A restore writes every id ` +
        `verbatim (decision 88), so it cannot merge into a live instance — delete it ` +
        `first, or restore into an empty database.`,
    );
  }

  const written: { table: ExportTableName; rows: number }[] = [];

  await prisma.$transaction(
    async (tx) => {
      const delegates = tx as unknown as Record<string, CreateManyDelegate>;

      // EXPORT_TABLES order is the foreign-key order. Sequential and deliberate:
      // Promise.all here would race Field against Applicant and ImportRow
      // against Instance, and the failure would be intermittent.
      for (const { table } of EXPORT_TABLES) {
        const rows = canonical.tables[table];
        if (rows.length === 0) {
          written.push({ table, rows: 0 });
          continue;
        }

        // The Prisma delegate is the model name with a lowercased first letter.
        const delegate = delegates[`${table[0].toLowerCase()}${table.slice(1)}`];
        const result = await delegate.createMany({
          data: rows.map((row) => toPrismaRow(table, row)),
        });
        written.push({ table, rows: result.count });
      }
    },
    { timeout: 120_000 },
  );

  return written;
}

// ---------------------------------------------------------------------------
// Two things the writer will need, found while writing the reader
// ---------------------------------------------------------------------------
//
// Recorded here rather than left to be rediscovered in slice 2, because both are
// invisible until they are wrong and neither is guessable from the schema.
//
// **A nullable Json column cannot be set to SQL NULL by passing `null`.** Prisma
// reads `Instance.importProposals`, `ImportRow.cells` and the rest back as
// `null`, but writing `null` to a nullable Json field is a type error — it wants
// `Prisma.DbNull` for a SQL NULL and `Prisma.JsonNull` for a JSON `null`
// literal. The restore must map its `null` to `Prisma.DbNull` for these columns
// specifically, and the CHECK on Instance
// (`importCommittedAt IS NULL OR importProposals IS NULL`) is what will catch it
// if that mapping is wrong on a committed instance.
//
// **`createdAt` and `updatedAt` are both accepted in Prisma's create input, and
// Prisma 7 honours both on create — SETTLED, measured rather than assumed.**
// `plans/phase-7.md` named this as the round trip's one contingency: if
// `@updatedAt` were overwritten on create, it would become the single expected
// difference and "intact" would need an exception list. It is not. A full round
// trip over the seed instance — 4376 rows across all 24 tables — came back with
// zero differences, `updatedAt` included.
//
// Recorded because the failure signature is worth knowing if this ever changes
// under a Prisma upgrade: it would be `updatedAt` differing on *every row of
// every table at once*, which the check groups by column precisely so that
// pattern is readable at a glance rather than buried in four thousand lines.

/// The filename an admin ends up with in their downloads folder.
///
/// Named for the instance rather than "export.json", because the file is a
/// backup that will sit beside others from other cycles, and because §8 makes it
/// sensitive enough to be worth recognising without opening.
export function exportFilename(instanceName: string, generatedAt: string): string {
  const slug =
    instanceName
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "instance";
  return `${slug}-${generatedAt.slice(0, 10)}.json`;
}
