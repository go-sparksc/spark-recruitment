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
import { matchRow, type Candidate, type MatchOutcome } from "@/lib/reconciliation";

export function parseSheetParam(raw: string): InterviewSheet | null {
  const upper = raw.toUpperCase();
  return upper === "SCORES" || upper === "NOTES" ? upper : null;
}

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
    categories,
    mappingErrors,
    findings: buildInterviewPreview({
      sheet,
      rows,
      columns,
      categories,
      mappingErrors,
      applicantNames,
    }),
    pool,
    applicantNames,
    candidatesByRow,
  };
}
