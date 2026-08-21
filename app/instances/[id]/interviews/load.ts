import "server-only";

// Assembling an interview sheet's preview from the database, shared by the page
// and the commit action so they cannot disagree about whether the sheet is ready
// to import — the same posture app/instances/[id]/preview/load.ts takes for FR-3.
//
// A plain server module rather than part of actions.ts, because a "use server"
// file may only export async functions and two of the things here are neither.

import { ImportSheet } from "@/generated/prisma/enums";
import {
  resolveMapping,
  validateMapping,
  type CategoryLike,
  type InterviewSheet,
  type StoredMapping,
} from "@/lib/import/interview-mapping";
import {
  buildInterviewPreview,
  type InterviewPreviewFindings,
  type StagedRow,
} from "@/lib/import/interview-preview";
import { prisma } from "@/lib/prisma";
import {
  matchRow,
  normalizeInterviewerName,
  type Candidate,
  type MatchOutcome,
} from "@/lib/reconciliation";

export function parseSheetParam(raw: string): InterviewSheet | null {
  const upper = raw.toUpperCase();
  return upper === "SCORES" || upper === "NOTES" ? upper : null;
}

/// U+001F, built from its codepoint so no control character sits in the source.
/// lib/roster.ts explains why that matters, and why the separator cannot be a
/// plain space: a cuid and a normalized name are both free-form text, so joining
/// them with a space would make ("a1", "kim") and ("a1 kim", "") one key.
const UNIT_SEPARATOR = String.fromCharCode(0x1f);

export const SHEET_LABEL: Record<InterviewSheet, string> = {
  SCORES: "First round scores",
  NOTES: "First round notes",
};

/// Applicants a row may resolve to: `stageReached != WRITTEN`.
///
/// **This query is the whole of PRD decision 48.** `lib/reconciliation.ts`
/// cannot enforce the scoping — it takes a pool and has no opinion about who
/// belongs in it — so widening this `where` is the single edit that reintroduces
/// the wrong-match class the decision removes. Written once and called by every
/// path that matches a row.
export async function scopedPool(instanceId: string): Promise<Candidate[]> {
  const applicants = await prisma.applicant.findMany({
    where: { instanceId, stageReached: { not: "WRITTEN" } },
    select: { id: true, email: true, displayName: true },
    orderBy: { sourceRowIndex: "asc" },
  });

  return applicants.map((applicant) => ({
    applicantId: applicant.id,
    email: applicant.email,
    displayName: applicant.displayName,
  }));
}

export interface LoadedSheet {
  importId: string;
  sheet: InterviewSheet;
  headers: string[];
  mapping: StoredMapping;
  categories: CategoryLike[];
  mappingErrors: string[];
  findings: InterviewPreviewFindings;
  pool: Candidate[];
  applicantNames: Map<string, string>;
  /// How many of the importable rows would REPLACE something already imported,
  /// per PRD decision 47's upsert.
  ///
  /// **Because "Import 12 rows" is not what a re-upload does.** A second upload
  /// of a corrected sheet silently replaced twelve existing results and said
  /// nothing about it — the count was right, the verb was wrong, and an admin
  /// had no way to tell a first import from an overwrite. Found by the owner
  /// asking whether the counts had actually changed.
  ///
  /// Computed here rather than in the pure preview, which has no database and
  /// must not grow one. Keyed exactly as the commit keys its delete, through the
  /// same normalizer, so the number cannot disagree with what happens.
  replacingCount: number;
  /// The first non-empty value in each column, for the mapping table.
  ///
  /// A heading on its own is often ambiguous — "Name" could be either party, and
  /// the S26 notes sheet calls its interviewer column "Your Name" — and one real
  /// cell settles it faster than opening the file in another window. Computed
  /// here because this is where the raw cells are; the preview rows carry only
  /// what the mapping already resolved.
  sampleByColumn: string[];
  /// Recomputed live for the rows that did not resolve, so the reconcile screen
  /// can tell "two applicants clear the threshold, pick one" from "nothing
  /// matched at all".
  ///
  /// **Not stored.** A candidate list written to the database at upload time
  /// goes stale the moment the pool changes — an applicant advanced or rejected
  /// after the file was staged — and a stale suggestion is worse than none.
  candidatesByRow: Map<number, MatchOutcome>;
}

export async function loadInterviewSheet(
  instanceId: string,
  sheet: InterviewSheet,
): Promise<LoadedSheet | null> {
  const staged = await prisma.interviewImport.findUnique({
    where: { instanceId_sheet: { instanceId, sheet: sheet as ImportSheet } },
    select: {
      id: true,
      headers: true,
      mapping: true,
      rows: {
        orderBy: { rowIndex: "asc" },
        select: {
          rowIndex: true,
          cells: true,
          matchedApplicantId: true,
          matchTier: true,
          matchConfidence: true,
          skipped: true,
        },
      },
    },
  });

  if (!staged) return null;

  const [categories, pool] = await Promise.all([
    prisma.interviewCategory.findMany({
      where: { instanceId },
      orderBy: { ordinal: "asc" },
      select: { id: true, name: true, maxPoints: true },
    }),
    scopedPool(instanceId),
  ]);

  const headers = staged.headers as string[];
  const mapping = staged.mapping as StoredMapping;
  const categoryIds = new Set(categories.map((c) => c.id));

  const mappingErrors = validateMapping(mapping, headers, categories, sheet);
  const columns = resolveMapping(mapping, categoryIds);

  const rows: StagedRow[] = staged.rows.map((row) => ({
    rowIndex: row.rowIndex,
    cells: row.cells as Record<string, string>,
    matchedApplicantId: row.matchedApplicantId,
    matchTier: row.matchTier,
    matchConfidence: row.matchConfidence,
    skipped: row.skipped,
  }));

  const applicantNames = new Map(pool.map((c) => [c.applicantId, c.displayName]));

  // Only for rows that did not resolve. Re-running the cascade over resolved
  // rows would cost a pass over the pool per row to produce an answer already
  // stored.
  const candidatesByRow = new Map<number, MatchOutcome>();
  for (const row of rows) {
    if (row.skipped || row.matchedApplicantId !== null) continue;
    candidatesByRow.set(
      row.rowIndex,
      matchRow(
        {
          email: columns.emailColumn === null ? undefined : row.cells[String(columns.emailColumn)],
          name: columns.nameColumn === null ? undefined : row.cells[String(columns.nameColumn)],
        },
        pool,
      ),
    );
  }

  const findings = buildInterviewPreview({
    sheet,
    rows,
    columns,
    categories,
    mappingErrors,
    applicantNames,
  });

  // What a commit would overwrite. Keyed exactly as `commitInterviewSheet` keys
  // its delete — (applicant, folded interviewer) for scores, applicant alone for
  // notes — so this count and the rows that actually get replaced are the same
  // set by construction rather than by two pieces of code agreeing.
  const importable = findings.rows.filter((row) => !row.skipped && row.applicantId !== null);
  const importableApplicantIds = [
    ...new Set(importable.map((row) => row.applicantId as string)),
  ];

  let replacingCount = 0;
  if (importableApplicantIds.length > 0) {
    if (sheet === "SCORES") {
      const existingResults = await prisma.interviewResult.findMany({
        where: { applicantId: { in: importableApplicantIds } },
        select: { applicantId: true, interviewerName: true },
      });
      const existingKeys = new Set(
        existingResults.map(
          (r) => `${r.applicantId}${UNIT_SEPARATOR}${normalizeInterviewerName(r.interviewerName)}`,
        ),
      );
      replacingCount = importable.filter((row) =>
        existingKeys.has(
          `${row.applicantId}${UNIT_SEPARATOR}${normalizeInterviewerName(row.interviewerName)}`,
        ),
      ).length;
    } else {
      const existingNotes = await prisma.interviewNotes.findMany({
        where: { applicantId: { in: importableApplicantIds } },
        select: { applicantId: true },
      });
      const existingKeys = new Set(existingNotes.map((n) => n.applicantId));
      replacingCount = importable.filter((row) =>
        existingKeys.has(row.applicantId as string),
      ).length;
    }
  }

  const sampleByColumn = headers.map((_, columnIndex) => {
    const found = rows.find((row) => (row.cells[String(columnIndex)] ?? "").trim() !== "");
    return found ? (found.cells[String(columnIndex)] ?? "").trim() : "";
  });

  return {
    importId: staged.id,
    sheet,
    headers,
    mapping,
    sampleByColumn,
    replacingCount,
    categories,
    mappingErrors,
    findings,
    pool,
    applicantNames,
    candidatesByRow,
  };
}
