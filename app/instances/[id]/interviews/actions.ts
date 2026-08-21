"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { ImportSheet, MatchTier } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { CsvParseError, parseCsv } from "@/lib/import/parse-csv";
import {
  proposeMapping,
  resolveMapping,
  type InterviewSheet,
  type StoredMapping,
} from "@/lib/import/interview-mapping";
import { loadInterviewSheet, parseSheetParam, scopedPool } from "./load";
import { prisma } from "@/lib/prisma";
import { matchRow, normalizeInterviewerName } from "@/lib/reconciliation";

export interface InterviewImportState {
  error?: string;
  message?: string;
}

const ok: InterviewImportState = {};

/// Same ceiling as FR-2's applicant upload. An interview sheet is far smaller
/// than an application export, so this exists to refuse an obvious mistake with
/// a sentence rather than a stack trace.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function sheetPath(instanceId: string, sheet: InterviewSheet) {
  return `/instances/${instanceId}/interviews/${sheet.toLowerCase()}`;
}

function hubPath(instanceId: string) {
  return `/instances/${instanceId}/interviews`;
}

function revalidateSheet(instanceId: string, sheet: InterviewSheet) {
  revalidatePath(sheetPath(instanceId, sheet));
  revalidatePath(hubPath(instanceId));
  revalidatePath(`/instances/${instanceId}`);
}

/// Run the FR-13 cascade over every staged row and write the outcome back.
///
/// Called after an upload and after any mapping change, because which columns
/// carry the email and the name is exactly what the cascade reads. A mapping
/// edit that did not re-match would leave the reconcile lists describing the
/// previous mapping, which is the kind of stale screen an admin trusts.
///
/// **Rows the admin has already decided are left alone.** A MANUAL match and a
/// skip are both human decisions, and re-running the matcher over them would
/// silently undo work — the admin would fix a row, change a column, and find
/// their fix gone with nothing saying so.
async function rematch(instanceId: string, sheet: InterviewSheet): Promise<void> {
  const [staged, pool] = await Promise.all([
    prisma.interviewImportRow.findMany({
      where: { instanceId, sheet: sheet as ImportSheet },
      select: {
        id: true,
        cells: true,
        matchTier: true,
        skipped: true,
      },
    }),
    scopedPool(instanceId),
  ]);

  const importRow = await prisma.interviewImport.findUnique({
    where: { instanceId_sheet: { instanceId, sheet: sheet as ImportSheet } },
    select: { mapping: true },
  });
  if (!importRow) return;

  const categoryIds = new Set(
    (
      await prisma.interviewCategory.findMany({
        where: { instanceId },
        select: { id: true },
      })
    ).map((c) => c.id),
  );

  const columns = resolveMapping(importRow.mapping as StoredMapping, categoryIds);

  // One statement per changed row. The row count here is an interview sheet —
  // two per applicant across a first-round cohort, so tens rather than the 150
  // that made FR-11's finalize exceed Prisma's transaction limit. Deliberately
  // NOT wrapped in a transaction: this is idempotent and re-runnable, and a
  // partial pass followed by a re-run reaches the same state.
  for (const row of staged) {
    if (row.skipped || row.matchTier === MatchTier.MANUAL) continue;

    const cells = row.cells as Record<string, string>;
    const outcome = matchRow(
      {
        email: columns.emailColumn === null ? undefined : cells[String(columns.emailColumn)],
        name: columns.nameColumn === null ? undefined : cells[String(columns.nameColumn)],
      },
      pool,
    );

    const next =
      outcome.kind === "MATCHED"
        ? {
            matchedApplicantId: outcome.applicantId,
            matchTier: outcome.tier as MatchTier,
            matchConfidence: outcome.confidence,
          }
        : // AMBIGUOUS and UNRESOLVED both land unresolved in the database. The
          // difference between them is what the reconcile screen offers, and it
          // is recomputed there from the same pool rather than stored — storing
          // a candidate list would go stale the moment the pool changed.
          { matchedApplicantId: null, matchTier: null, matchConfidence: null };

    await prisma.interviewImportRow.update({ where: { id: row.id }, data: next });
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/// FR-12: "A sheet accepts repeated uploads."
///
/// Clause 12r and 12u. A new upload REPLACES this sheet's staging set — the
/// `InterviewImport` row is deleted and its rows cascade — rather than being
/// refused the way FR-3 refuses a second applicant CSV. Committed data is
/// untouched until the new file is committed in its turn.
export async function uploadInterviewSheet(
  _prev: InterviewImportState,
  formData: FormData,
): Promise<InterviewImportState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const sheet = parseSheetParam(String(formData.get("sheet") ?? ""));
  if (!sheet) return { error: "Unknown sheet." };

  await requireInstance(instanceId, hubPath(instanceId));

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file to upload." };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: "That file is larger than 8MB. A real interview export is far smaller." };
  }

  // Clause 12c: every configured category needs a column, so a scores sheet
  // uploaded before FR-12a's rubric exists has nothing to map to. Refused here
  // with the reason rather than at the mapping table with a list of errors.
  if (sheet === "SCORES") {
    const categoryCount = await prisma.interviewCategory.count({ where: { instanceId } });
    if (categoryCount === 0) {
      return {
        error:
          "Set up the interview rubric first. The scores sheet has one column per category, and " +
          "there are no categories yet to map them to.",
      };
    }
  }

  let parsed;
  try {
    parsed = parseCsv(Buffer.from(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof CsvParseError) return { error: error.message };
    throw error;
  }

  const categories = await prisma.interviewCategory.findMany({
    where: { instanceId },
    orderBy: { ordinal: "asc" },
    select: { id: true, name: true, maxPoints: true },
  });

  const mapping = proposeMapping(parsed.headers, categories, sheet);

  await prisma.$transaction(async (tx) => {
    // Replaces rather than accumulates. UNIQUE (instanceId, sheet) would refuse
    // a second row anyway; deleting first is what makes the upload an upload
    // rather than an error.
    await tx.interviewImport.deleteMany({
      where: { instanceId, sheet: sheet as ImportSheet },
    });

    const created = await tx.interviewImport.create({
      data: {
        instanceId,
        sheet: sheet as ImportSheet,
        headers: parsed.headers,
        mapping,
      },
      select: { id: true },
    });

    await tx.interviewImportRow.createMany({
      data: parsed.rows.map((cells, index) => ({
        instanceId,
        importId: created.id,
        sheet: sheet as ImportSheet,
        // 1-based, matching the row numbers the preview and the fixture README
        // both use, and never renumbered.
        rowIndex: index + 1,
        cells: Object.fromEntries(cells.map((value, column) => [String(column), value])),
      })),
    });
  });

  await rematch(instanceId, sheet);

  revalidateSheet(instanceId, sheet);
  redirect(sheetPath(instanceId, sheet));
}

/// Throw away a staged sheet without committing it. The rows cascade from the
/// import row.
export async function discardStagedSheet(
  instanceId: string,
  sheetParam: string,
): Promise<InterviewImportState> {
  const sheet = parseSheetParam(sheetParam);
  if (!sheet) return { error: "Unknown sheet." };
  await requireInstance(instanceId, hubPath(instanceId));

  await prisma.interviewImport.deleteMany({
    where: { instanceId, sheet: sheet as ImportSheet },
  });

  revalidateSheet(instanceId, sheet);
  return ok;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/// Clause 12f. One column's role at a time, re-matching afterwards because the
/// email and name columns are what FR-13 reads.
export async function setColumnRole(
  instanceId: string,
  sheetParam: string,
  columnIndex: number,
  role: string,
): Promise<InterviewImportState> {
  const sheet = parseSheetParam(sheetParam);
  if (!sheet) return { error: "Unknown sheet." };
  await requireInstance(instanceId, hubPath(instanceId));

  const staged = await prisma.interviewImport.findUnique({
    where: { instanceId_sheet: { instanceId, sheet: sheet as ImportSheet } },
    select: { id: true, mapping: true },
  });
  if (!staged) return { error: "No staged file for this sheet." };

  const mapping = { ...(staged.mapping as StoredMapping), [String(columnIndex)]: role };

  await prisma.interviewImport.update({
    where: { id: staged.id },
    data: { mapping },
  });

  await rematch(instanceId, sheet);

  revalidateSheet(instanceId, sheet);
  return ok;
}

// ---------------------------------------------------------------------------
// Reconciliation — FR-13's tiers 3 and 4
// ---------------------------------------------------------------------------

/// PRD decision 53. A fuzzy match is a proposal until a human agrees with it.
///
/// **Confirmation moves the tier to MANUAL and clears the confidence**, which is
/// what records that a person decided rather than the matcher. §5 holds
/// `matchConfidence` to FUZZY with a CHECK, so the number cannot be kept
/// alongside MANUAL — and it has already done its job by the time the tick
/// happens, which is to tell the admin how close the match was.
export async function confirmFuzzyMatch(
  instanceId: string,
  sheetParam: string,
  rowIndex: number,
): Promise<InterviewImportState> {
  const sheet = parseSheetParam(sheetParam);
  if (!sheet) return { error: "Unknown sheet." };
  await requireInstance(instanceId, hubPath(instanceId));

  const row = await prisma.interviewImportRow.findUnique({
    where: {
      instanceId_sheet_rowIndex: { instanceId, sheet: sheet as ImportSheet, rowIndex },
    },
    select: { id: true, matchTier: true, matchedApplicantId: true },
  });
  if (!row) return { error: "No such row." };
  if (row.matchTier !== MatchTier.FUZZY || row.matchedApplicantId === null) {
    return { error: "That row is not waiting on a fuzzy match." };
  }

  await prisma.interviewImportRow.update({
    where: { id: row.id },
    data: { matchTier: MatchTier.MANUAL, matchConfidence: null },
  });

  revalidateSheet(instanceId, sheet);
  return ok;
}

/// FR-13's tier 4: "an unresolved queue the admin maps by hand."
///
/// The applicant must be in the scoped pool. Checked server-side rather than
/// trusted from the form, since a select is not a constraint on what a POST can
/// carry, and decision 48's whole value is that an out-of-scope applicant is not
/// reachable.
export async function mapRowManually(
  instanceId: string,
  sheetParam: string,
  rowIndex: number,
  applicantId: string,
): Promise<InterviewImportState> {
  const sheet = parseSheetParam(sheetParam);
  if (!sheet) return { error: "Unknown sheet." };
  await requireInstance(instanceId, hubPath(instanceId));

  const applicant = await prisma.applicant.findFirst({
    where: { id: applicantId, instanceId, stageReached: { not: "WRITTEN" } },
    select: { id: true },
  });
  if (!applicant) {
    return {
      error:
        "That applicant is not in the first round, so an interview sheet cannot refer to them.",
    };
  }

  await prisma.interviewImportRow.update({
    where: {
      instanceId_sheet_rowIndex: { instanceId, sheet: sheet as ImportSheet, rowIndex },
    },
    // skipped cleared alongside: a row cannot be both mapped and not importing,
    // and the CHECK constraint says so.
    data: {
      matchedApplicantId: applicant.id,
      matchTier: MatchTier.MANUAL,
      matchConfidence: null,
      skipped: false,
    },
  });

  revalidateSheet(instanceId, sheet);
  return ok;
}

/// PRD decision 51's third outcome, and the escape hatch for a decision 49
/// collision.
///
/// **Skipping clears the match**, because the CHECK constraint forbids a row
/// that is both skipped and matched — "this row matches nobody" and "this row
/// matches her" are contradictory answers to one question. Un-skipping therefore
/// re-runs the matcher for that row rather than restoring a remembered match.
export async function setRowSkipped(
  instanceId: string,
  sheetParam: string,
  rowIndex: number,
  skipped: boolean,
): Promise<InterviewImportState> {
  const sheet = parseSheetParam(sheetParam);
  if (!sheet) return { error: "Unknown sheet." };
  await requireInstance(instanceId, hubPath(instanceId));

  await prisma.interviewImportRow.update({
    where: {
      instanceId_sheet_rowIndex: { instanceId, sheet: sheet as ImportSheet, rowIndex },
    },
    data: skipped
      ? { skipped: true, matchedApplicantId: null, matchTier: null, matchConfidence: null }
      : { skipped: false },
  });

  // Un-skipping puts the row back in front of the matcher. Skipping does not
  // need it — the row is out of scope for every list.
  if (!skipped) await rematch(instanceId, sheet);

  revalidateSheet(instanceId, sheet);
  return ok;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/// Trimmed and whitespace-collapsed, case PRESERVED — the same split
/// lib/roster.ts makes between what is stored and what is compared. FR-14
/// renders this name, so folding its case would put every interviewer in the
/// dashboard in lower case.
function storableInterviewerName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/// FR-12's commit, for either sheet. One transaction, and repeatable.
///
/// **Bulk statements, not a loop of upserts.** FR-11's finalize learned this the
/// hard way: 150 sequential round trips took 5112 ms against Prisma's 5000 ms
/// interactive-transaction limit and failed with P2028 on a realistic cohort.
/// An interview sheet is smaller, but the failure mode is identical and the fix
/// is to do less work rather than to raise the timeout.
///
/// **Delete-then-insert rather than upsert**, which is what decision 47's
/// "re-committing upserts" means in practice. The delete targets exactly the
/// keys this batch is about to write, so a re-commit replaces its own rows and
/// touches nothing else — and the operation is idempotent, so a retry after a
/// failure reaches the same state.
export async function commitInterviewSheet(
  _prev: InterviewImportState,
  formData: FormData,
): Promise<InterviewImportState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const sheet = parseSheetParam(String(formData.get("sheet") ?? ""));
  if (!sheet) return { error: "Unknown sheet." };

  await requireInstance(instanceId, hubPath(instanceId));

  const loaded = await loadInterviewSheet(instanceId, sheet);
  if (!loaded) return { error: "No staged file for this sheet." };

  // Re-checked server-side. The screen stops offering the button once anything
  // blocks, and that is not a constraint on what arrives: a second tab opened
  // before a row was skipped still holds a form bound to this action.
  if (!loaded.findings.canCommit) {
    return {
      error:
        "Some problems still need resolving before this sheet can be imported. Reload the page " +
        "to see them as they stand.",
    };
  }

  const importable = loaded.findings.rows.filter(
    (row) => !row.skipped && row.applicantId !== null,
  );

  if (sheet === "SCORES") {
    // The result row and its category scores are kept in separate fields rather
    // than one object the insert has to strip. `createMany` takes exactly the
    // model's columns, and carrying an extra key only to discard it at the call
    // site is how an unrelated field ends up passed to Prisma by a later edit.
    const results = importable.map((row) => ({
      result: {
        id: crypto.randomUUID(),
        applicantId: row.applicantId as string,
        interviewerName: storableInterviewerName(row.interviewerName),
        // Clause 12h: verbatim from the sheet, never recomputed. `canCommit`
        // guarantees this parsed, so the assertion is safe.
        score: row.average as number,
      },
      categoryPoints: row.categoryPoints,
    }));

    // Decision 47's upsert, made robust to spelling drift ACROSS uploads. The
    // unique key is the stored string, so a second upload writing "alex kim"
    // where the first wrote "Alex Kim" would insert a duplicate rather than
    // replace. Comparing through the shared normalizer finds those rows;
    // comparing raw strings would not.
    const applicantIds = [...new Set(results.map((r) => r.result.applicantId))];
    const existing = await prisma.interviewResult.findMany({
      where: { applicantId: { in: applicantIds } },
      select: { id: true, applicantId: true, interviewerName: true },
    });

    // U+001F as the separator, written as an escape and never as the character
    // itself — lib/roster.ts explains why, and specifically why NOT U+0000: a
    // literal NUL in source trips git's binary heuristic, and an escape someone
    // later 'simplifies' into the real character would do it here too.
    const incoming = new Set(
      results.map((r) => `${r.result.applicantId}\u001F${normalizeInterviewerName(r.result.interviewerName)}`),
    );
    const supersededIds = existing
      .filter((row) =>
        incoming.has(`${row.applicantId}\u001F${normalizeInterviewerName(row.interviewerName)}`),
      )
      .map((row) => row.id);

    await prisma.$transaction(
      async (tx) => {
        if (supersededIds.length > 0) {
          // InterviewCategoryScore cascades from the result, so this is one
          // statement and cannot leave half a pair behind.
          await tx.interviewResult.deleteMany({ where: { id: { in: supersededIds } } });
        }

        await tx.interviewResult.createMany({
          data: results.map((r) => r.result),
        });

        const categoryScores = results.flatMap((entry) =>
          entry.categoryPoints.map((point) => ({
            interviewResultId: entry.result.id,
            interviewCategoryId: point.interviewCategoryId,
            points: point.points,
          })),
        );
        if (categoryScores.length > 0) {
          await tx.interviewCategoryScore.createMany({ data: categoryScores });
        }

        await tx.interviewImport.delete({ where: { id: loaded.importId } });
      },
      { timeout: 20000 },
    );

    revalidateSheet(instanceId, sheet);
    return {
      message:
        `Imported ${results.length} interview score row${results.length === 1 ? "" : "s"} ` +
        `across ${applicantIds.length} applicant${applicantIds.length === 1 ? "" : "s"}.`,
    };
  }

  // NOTES. Keyed on applicantId alone — InterviewNotes already carries
  // UNIQUE (applicantId), which gives decision 47's behaviour for free.
  const notes = importable.map((row) => ({
    id: crypto.randomUUID(),
    applicantId: row.applicantId as string,
    // Nullable by design: only one interviewer of the pair writes the notes, and
    // the "Your Name" column records which — when the sheet has one.
    interviewerName: storableInterviewerName(row.interviewerName) || null,
    body: row.notes,
  }));

  await prisma.$transaction(
    async (tx) => {
      await tx.interviewNotes.deleteMany({
        where: { applicantId: { in: notes.map((note) => note.applicantId) } },
      });
      await tx.interviewNotes.createMany({ data: notes });
      await tx.interviewImport.delete({ where: { id: loaded.importId } });
    },
    { timeout: 20000 },
  );

  revalidateSheet(instanceId, sheet);
  return {
    message: `Imported notes for ${notes.length} applicant${notes.length === 1 ? "" : "s"}.`,
  };
}
