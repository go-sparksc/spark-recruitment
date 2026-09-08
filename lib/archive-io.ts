import "server-only";

// §8's archive-and-purge, executed. PRD decisions 94 and 95.
//
// `lib/archive.ts` decides WHICH cycles are old enough, WHAT survives, and WHAT
// is destroyed; this module is the part that touches Postgres. The same split as
// lib/export.ts / lib/instance-io.ts, and for the same reason.
//
// **`server-only` makes this unimportable from a plain `tsx` script**, which
// matters because prisma/checks/archive-purge.ts has to import it — a check that
// re-implemented the purge would be verifying a second copy of the thing under
// test, and this is the one operation in the product with no undo. Run such a
// script with `tsx --conditions=react-server`.
//
// **This is the second irreversible action in the product**, after
// deleteInstance. Everything below is ordered so that a crash partway leaves the
// cycle either fully purged or untouched: it is one transaction, and the summary
// is written before the first deletion rather than after the last.

import { Prisma } from "@/generated/prisma/client";
import { buildArchiveSummary, retentionCandidates, type ArchiveSummary } from "@/lib/archive";
import { demographicColumns } from "@/lib/demographics";
import { prisma } from "@/lib/prisma";
import { PASSWORD_ATTEMPT_POLICY } from "@/lib/rate-limit";
import { pruneSpent } from "@/lib/rate-limit-store";

/// How many cycles are kept. PRD decision 94.
///
/// An environment variable rather than an in-app setting, deliberately:
/// everything else behind the app gate is additive or reversible, and §8's gate
/// is one password shared by 2-6 people. A threshold editable from that side
/// could be set to 0, turning a retention control into a delete-everything
/// button operated by whoever has the Slack message with the password in it.
///
/// Invalid values throw rather than falling back to the default. A typo'd
/// `RETENTION_CYCLES=tow` silently meaning 2 is fine right up until someone
/// writes `1` meaning `10`.
export const DEFAULT_RETENTION_CYCLES = 2;

export function retentionCycles(): number {
  const raw = process.env.RETENTION_CYCLES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_CYCLES;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `RETENTION_CYCLES must be a whole number of at least 1; got ${JSON.stringify(raw)}. ` +
        `A threshold below 1 would make the running cycle a purge candidate. ` +
        `Leave it unset for the default of ${DEFAULT_RETENTION_CYCLES}.`,
    );
  }
  return parsed;
}

export interface PurgeRefusal {
  ok: false;
  reason: "NOT_FOUND" | "ALREADY_ARCHIVED" | "NOT_OLD_ENOUGH";
  message: string;
}

export interface PurgeSuccess {
  ok: true;
  summary: ArchiveSummary;
  /// What was destroyed, for the audit row and for the screen.
  removed: Record<string, number>;
}

export type PurgeResult = PurgeRefusal | PurgeSuccess;

/// The cycles, split into retained / candidates / already archived.
export async function retentionView() {
  const instances = await prisma.instance.findMany({
    select: {
      id: true,
      name: true,
      createdAt: true,
      archivedAt: true,
      currentStage: true,
      _count: { select: { applicants: true } },
    },
  });

  return retentionCandidates(instances, retentionCycles());
}

/// Archive one cycle: freeze its statistics, then destroy what §8 says to.
///
/// **One transaction, in this order, and the order is the design.**
///
///   1. Re-read `archivedAt` and refuse if set. Inside the transaction, not
///      before it: two admins on the archive screen at once, or one
///      double-submitting, is the ordinary way a second purge happens, and a
///      check outside the transaction loses that race. A second purge would
///      recompute the summary against the data the first one emptied and
///      overwrite correct numbers with zeros, failing nothing.
///   2. Confirm the cycle is actually old enough. The screen already filtered,
///      but the action is a POST endpoint reachable without it.
///   3. Read everything the summary needs, while it still exists.
///   4. Write the summary and `archivedAt`.
///   5. Destroy, per `purgePlan()`.
///   6. Write the audit row LAST, so it survives step 5's `previousValue`
///      nulling rather than being erased by it.
export async function archiveAndPurge(
  instanceId: string,
  actor: { actor: string; actorName: string | null },
): Promise<PurgeResult> {
  const cycles = retentionCycles();

  return prisma.$transaction(
    async (tx) => {
      // 1 & 2 — eligibility, re-read under the transaction.
      const instance = await tx.instance.findUnique({
        where: { id: instanceId },
        select: { id: true, name: true, currentStage: true, createdAt: true, archivedAt: true },
      });

      if (!instance) {
        return { ok: false, reason: "NOT_FOUND", message: "No such instance." } as const;
      }

      if (instance.archivedAt !== null) {
        // Returned, not thrown: a second purge is a normal thing to attempt
        // (a stale tab, a double-click), not a fault.
        return {
          ok: false,
          reason: "ALREADY_ARCHIVED",
          message:
            `“${instance.name}” was already archived on ` +
            `${instance.archivedAt.toISOString().slice(0, 10)}. Its statistics are frozen and ` +
            `its applicant data is gone; running again would overwrite the frozen numbers ` +
            `with zeros.`,
        } as const;
      }

      const all = await tx.instance.findMany({
        select: { id: true, name: true, createdAt: true, archivedAt: true },
      });
      const split = retentionCandidates(all, cycles);

      if (!split.candidates.some((candidate) => candidate.id === instanceId)) {
        return {
          ok: false,
          reason: "NOT_OLD_ENOUGH",
          message:
            `“${instance.name}” is one of the ${cycles} most recent cycles and is not old ` +
            `enough to purge. Raise RETENTION_CYCLES only to keep MORE, never to purge sooner.`,
        } as const;
      }

      // 3 — read what the summary needs, before anything is destroyed.
      const archivedAt = new Date();

      const [applicants, fields, groups, reviewers, writtenRubric, interviewRubric] =
        await Promise.all([
          tx.applicant.findMany({
            where: { instanceId },
            select: { id: true, data: true, status: true, stageReached: true },
          }),
          // The same shape app/instances/[id]/final/load.ts reads. Members are
          // derived by `demographicColumns` from the fields' own groupId and
          // groupRole, so there is no sub-select here — and matching that
          // caller exactly is what keeps the frozen funnel identical to the one
          // FR-19 rendered before the purge.
          tx.field.findMany({
            where: { instanceId },
            orderBy: { ordinal: "asc" },
            select: {
              id: true,
              displayName: true,
              ordinal: true,
              category: true,
              isIncluded: true,
              groupId: true,
              groupRole: true,
              isReviewerVisible: true,
            },
          }),
          tx.fieldGroup.findMany({
            where: { instanceId },
            select: {
              id: true,
              displayName: true,
              ordinal: true,
              category: true,
              isIncluded: true,
              isReviewerVisible: true,
            },
          }),
          tx.reviewer.findMany({ where: { instanceId }, select: { isSparklet: true } }),
          tx.rubricCategory.findMany({
            where: { instanceId },
            select: { name: true, maxPoints: true },
            orderBy: { ordinal: "asc" },
          }),
          tx.interviewCategory.findMany({
            where: { instanceId },
            select: { name: true, maxPoints: true },
            orderBy: { ordinal: "asc" },
          }),
        ]);

      const [scores, reviewNotes, interviewResults, firstRoundVotes, passVotes, decisions] =
        await Promise.all([
          tx.score.count({ where: { assignment: { instanceId } } }),
          tx.reviewNote.count({ where: { assignment: { instanceId } } }),
          tx.interviewResult.count({ where: { applicant: { instanceId } } }),
          tx.firstRoundVote.count({ where: { applicant: { instanceId } } }),
          tx.passVote.count({ where: { pass: { instanceId } } }),
          tx.decision.count({ where: { applicant: { instanceId } } }),
        ]);

      const summary = buildArchiveSummary({
        name: instance.name,
        currentStage: instance.currentStage,
        createdAt: instance.createdAt,
        archivedAt,
        applicants: applicants.map((applicant) => ({
          id: applicant.id,
          data: applicant.data as Record<string, unknown>,
          status: applicant.status,
          stageReached: applicant.stageReached,
        })),
        // ADMIN, so the frozen breakdown covers every included demographic
        // column rather than only what some round's reviewers could see. §6's
        // visibility is about who may read a live applicant, not about which
        // statistics the club keeps.
        demographicColumns: demographicColumns(fields, groups, "ADMIN"),
        reviewers,
        writtenRubric,
        interviewRubric,
        reviewCounts: {
          scores,
          reviewNotes,
          interviewResults,
          firstRoundVotes,
          passVotes,
          decisions,
        },
      });

      // 4 — freeze. Before any deletion, which is the whole point.
      await tx.instance.update({
        where: { id: instanceId },
        data: { archivedAt, archiveSummary: summary as object },
      });

      // 5 — destroy, per purgePlan(). Applicant columns are cleared row by row
      // because displayName becomes a per-row value; the rest is set-based.
      const removed: Record<string, number> = {};

      for (const applicant of applicants) {
        await tx.applicant.update({
          where: { id: applicant.id },
          data: { email: null, data: {} },
        });
      }
      // displayName becomes the anonymous label written reviewers already see,
      // so the non-null column stays meaningful. Raw SQL because the value is
      // derived from another column of the same row.
      await tx.$executeRaw`
        UPDATE "Applicant"
        SET "displayName" = 'Applicant ' || "sourceRowIndex"
        WHERE "instanceId" = ${instanceId}
      `;
      removed.Applicant = applicants.length;

      removed.ImportRow = (await tx.importRow.deleteMany({ where: { instanceId } })).count;
      removed.InterviewImportRow = (
        await tx.interviewImportRow.deleteMany({ where: { instanceId } })
      ).count;
      removed.ReviewNote = (
        await tx.reviewNote.deleteMany({ where: { assignment: { instanceId } } })
      ).count;
      removed.InterviewNotes = (
        await tx.interviewNotes.deleteMany({ where: { applicant: { instanceId } } })
      ).count;
      removed.RoundAccessCode = (
        await tx.roundAccessCode.deleteMany({ where: { instanceId } })
      ).count;
      removed.AuditLogPayloads = (
        await tx.auditLog.updateMany({
          where: { instanceId, previousValue: { not: Prisma.DbNull } },
          data: { previousValue: Prisma.DbNull },
        })
      ).count;

      // Orphaned instance-deletion and app-level lockout rows, aged out on the
      // same threshold. §8: "Archive-and-purge must age these out on the same
      // threshold as everything else, or they accumulate forever." They belong
      // to no cycle, so cycle rank cannot apply — the cutoff date does.
      if (split.cutoff !== null) {
        removed.OrphanedAuditLog = (
          await tx.auditLog.deleteMany({
            where: { instanceId: null, createdAt: { lt: split.cutoff } },
          })
        ).count;
      }

      // 6 — the record of the purge, written LAST so the previousValue nulling
      // above cannot erase it. Counts only; never content, since this row
      // outlives the purge and must not reintroduce what it removed.
      await tx.auditLog.create({
        data: {
          instanceId,
          ...actor,
          action: "ARCHIVE_AND_PURGE",
          entityType: "Instance",
          entityId: instanceId,
          previousValue: { retentionCycles: cycles, removed },
        },
      });

      return { ok: true, summary, removed } as const;
    },
    // The applicant loop is one statement per row. At 158 applicants that is
    // well inside the default, but a cycle twice the size on a cold connection
    // is not, and a timeout here rolls back a purge that had already frozen its
    // summary.
    { timeout: 120_000 },
  );
}

/// Housekeeping that does not belong to any one cycle, run alongside a purge.
///
/// Separate from the transaction above: a failure to tidy spent rate-limit
/// buckets must not roll back a completed purge, and the two have nothing to do
/// with each other beyond both being retention.
export async function pruneAfterPurge(): Promise<number> {
  return pruneSpent(PASSWORD_ATTEMPT_POLICY);
}

/// Whether an instance is archived, for the two gates that must refuse one.
export async function isArchived(instanceId: string): Promise<boolean> {
  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { archivedAt: true },
  });
  return instance?.archivedAt != null;
}
