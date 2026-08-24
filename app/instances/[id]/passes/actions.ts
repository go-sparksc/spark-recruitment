"use server";

import { revalidatePath } from "next/cache";

import { InstanceStage, PassResolution, PassStatus, Round } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { SECOND_ROUND_POOL, passCreationBlock, resolvePass } from "@/lib/passes";
import { prisma } from "@/lib/prisma";

export interface PassActionState {
  error?: string;
  message?: string;
}

function path(instanceId: string) {
  return `/instances/${instanceId}/passes`;
}

/// Everything a pass create or close changes the look of.
///
/// The reviewer's own list is in here deliberately: its empty state says voting
/// opens when an admin starts a pass, so the moment a pass exists that sentence
/// is wrong. Decision 64's lesson — a dead end nobody revalidated — applied
/// before it can bite.
function revalidateAll(instanceId: string) {
  revalidatePath(path(instanceId));
  revalidatePath(`/instances/${instanceId}`);
  revalidatePath(`/r/${instanceId}/second-round`);
}

/// FR-17: "A pass is created by an admin. Its membership is fixed at creation:
/// every applicant with `status = ACTIVE`."
///
/// Clauses 17a, 17b, 17c's action half, 17w, and decision 79.
export async function createPass(
  _prev: PassActionState,
  formData: FormData,
): Promise<PassActionState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  await requireInstance(instanceId, path(instanceId));

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { id: true, currentStage: true },
  });
  if (!instance) return { error: "No such instance." };

  // **Every input to the guard is read here, not taken from the request.** The
  // page renders the same guard to explain itself, but a second tab opened
  // before someone else created a pass still holds a form bound to this action.
  const [openPass, pool, reviewers, lastPass] = await Promise.all([
    prisma.pass.findFirst({
      where: { instanceId, status: PassStatus.OPEN },
      select: { id: true, ordinal: true },
    }),
    // Clause 17b, through the same constant the hub and the close-round action
    // read. `status = ACTIVE`, no round qualifier — decision 41's whole point.
    prisma.applicant.findMany({
      where: { instanceId, ...SECOND_ROUND_POOL },
      orderBy: { sourceRowIndex: "asc" },
      select: { id: true },
    }),
    prisma.reviewer.findMany({
      where: { instanceId, rounds: { has: Round.SECOND_ROUND } },
      select: { id: true },
    }),
    prisma.pass.findFirst({
      where: { instanceId },
      orderBy: { ordinal: "desc" },
      select: { ordinal: true },
    }),
  ]);

  const block = passCreationBlock({
    inSecondRound: instance.currentStage === InstanceStage.SECOND_ROUND,
    openPassOrdinal: openPass?.ordinal ?? null,
    poolSize: pool.length,
    reviewerCount: reviewers.length,
  });
  if (block) return { error: block };

  // Decision 67: conflicts are scoped by round and never by pass, so a pass
  // created today inherits every conflict flagged before it existed.
  const conflicts = await prisma.conflictOfInterest.findMany({
    where: { round: Round.SECOND_ROUND, applicant: { instanceId } },
    select: { applicantId: true, reviewerId: true },
  });

  const applicantIds = pool.map((applicant) => applicant.id);
  const reviewerIds = reviewers.map((reviewer) => reviewer.id);

  // **Resolved at creation, not left until the first vote.** Clause 17v: an
  // applicant every second-round reviewer has recused from resolves NEEDS_ADMIN
  // immediately, and §7.4 requires that be visible as the pass's answer rather
  // than as a row that never moves. With no votes yet this is the only branch
  // that can fire — everyone else has an outstanding reviewer.
  const resolutions = resolvePass({ reviewerIds, applicantIds, votes: [], conflicts });
  const needsAdmin = new Set(
    resolutions
      .filter((row) => row.resolution === PassResolution.NEEDS_ADMIN)
      .map((row) => row.applicantId),
  );

  const ordinal = (lastPass?.ordinal ?? 0) + 1;
  const now = new Date();

  try {
    await prisma.$transaction(
      async (tx) => {
        const created = await tx.pass.create({
          data: { instanceId, ordinal, status: PassStatus.OPEN },
          select: { id: true },
        });

        await tx.passApplicant.createMany({
          data: applicantIds.map((applicantId) => ({
            passId: created.id,
            applicantId,
            // Decision 70 writes no `Decision` row for NEEDS_ADMIN, and
            // `statusFor` leaves the applicant ACTIVE, so this is the only
            // write the all-COI case makes.
            resolution: needsAdmin.has(applicantId) ? PassResolution.NEEDS_ADMIN : null,
            resolvedAt: needsAdmin.has(applicantId) ? now : null,
          })),
        });

        await tx.auditLog.create({
          data: {
            instanceId,
            // One shared admin password, so the actor cannot yet name an
            // individual — open decision 16. Counts only, no applicant names.
            actor: "admin",
            action: "CREATE_PASS",
            entityType: "Pass",
            entityId: created.id,
            previousValue: {
              ordinal,
              memberCount: applicantIds.length,
              reviewerCount: reviewerIds.length,
              conflicts: conflicts.length,
              needsAdminAtCreation: needsAdmin.size,
            },
          },
        });
      },
      { timeout: 20000 },
    );
  } catch (error) {
    // The guard above is a check-then-act, and two admins creating at the same
    // moment both pass it. `Pass_instanceId_statusOpen_key` and
    // `Pass_instanceId_ordinal_key` are what actually decide, and the loser
    // arrives here. Re-reading and reporting is better than a raw P2002.
    if (isUniqueViolation(error)) {
      return {
        error:
          "Another pass was created a moment ago. Reload this page to see it before creating " +
          "another.",
      };
    }
    throw error;
  }

  revalidateAll(instanceId);

  const flagged =
    needsAdmin.size > 0
      ? ` ${needsAdmin.size} applicant${needsAdmin.size === 1 ? "" : "s"} already need${
          needsAdmin.size === 1 ? "s" : ""
        } an admin — every reviewer has a conflict.`
      : "";

  return {
    message:
      `Pass ${ordinal} created with ${applicantIds.length} applicant` +
      `${applicantIds.length === 1 ? "" : "s"} and ${reviewerIds.length} reviewer` +
      `${reviewerIds.length === 1 ? "" : "s"}.${flagged}`,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "P2002";
}

/// FR-17: "Closing a pass without full votes leaves unvoted applicants ACTIVE
/// and carried forward."
///
/// Clause 17n and decision 72. **The close writes status and `closedAt` and
/// nothing else** — no resolution onto the unvoted rows, no touch to any
/// applicant. `CARRIED` would claim a mixed vote that never happened, and
/// `NULL` is what §5 says an unresolved row holds. The only thing that ever
/// writes `NEEDS_ADMIN` over a null row is the close-second-round action
/// (decision 73), which is Slice 10 and is a different sentence.
export async function closePass(
  _prev: PassActionState,
  formData: FormData,
): Promise<PassActionState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const passId = String(formData.get("passId") ?? "");
  await requireInstance(instanceId, path(instanceId));

  const pass = await prisma.pass.findFirst({
    // instanceId in the filter, not just the id: the id arrives from the
    // request and must not be able to name a pass in someone else's instance.
    where: { id: passId, instanceId },
    select: { id: true, ordinal: true, status: true },
  });

  if (!pass) return { error: "No such pass in this instance." };

  if (pass.status !== PassStatus.OPEN) {
    // 17y: there is no reopen action, so this is not a race to recover from —
    // it is a stale tab, and saying so is the whole response.
    return { error: `Pass ${pass.ordinal} is already closed. Reload this page.` };
  }

  const unresolved = await prisma.passApplicant.count({
    where: { passId: pass.id, resolution: null },
  });

  await prisma.$transaction(async (tx) => {
    await tx.pass.update({
      where: { id: pass.id },
      data: { status: PassStatus.CLOSED, closedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
        action: "CLOSE_PASS",
        entityType: "Pass",
        entityId: pass.id,
        previousValue: {
          ordinal: pass.ordinal,
          previousStatus: PassStatus.OPEN,
          // What the close deliberately left alone, recorded because it is the
          // number an admin will want when they wonder why pass 2 is so large.
          leftUnresolved: unresolved,
        },
      },
    });
  });

  revalidateAll(instanceId);

  return {
    message:
      `Pass ${pass.ordinal} closed.` +
      (unresolved > 0
        ? ` ${unresolved} applicant${unresolved === 1 ? "" : "s"} carried forward unresolved.`
        : ""),
  };
}
