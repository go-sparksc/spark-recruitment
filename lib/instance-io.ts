import "server-only";

// FR-20's database half. `lib/export.ts` decides what the format IS; this
// module is the part that reads it out of Postgres and (in slice 2) writes it
// back. Kept apart for the reason CLAUDE.md gives about pages: everything that
// can be decided without a database should be, so it can be tested without one.
//
// **Nothing here may import `slugify` or `uniqueSlug` from lib/fields.ts.**
// `FieldGroup.key` is immutable by decision 13 and travels through the export
// verbatim; a restore that re-slugged it from `displayName` would reintroduce
// the name-keying defect this system exists to remove, and would do it silently
// because the resulting key still looks reasonable.

import type { PrismaClient } from "@/generated/prisma/client";
import {
  EXPORT_FORMAT_VERSION,
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
// **`createdAt` and `updatedAt` are both accepted in Prisma's create input** —
// confirmed in `generated/prisma/models/Instance.ts`, where
// `InstanceUncheckedCreateInput` carries `createdAt?` and `updatedAt?`. A
// `@updatedAt` field auto-fills only when omitted, so writing them explicitly is
// what makes the round trip an identity under decision 88. Whether Prisma 7
// honours a provided `@updatedAt` on create rather than overwriting it is the
// one contingency `plans/phase-7.md` names, and the round-trip check is what
// settles it: if it overwrites, the diff reports `updatedAt` on every row of
// every table at once, which is a distinctive enough signature to read at a
// glance.

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
