"use server";

import { revalidatePath } from "next/cache";

import {
  ApplicantStatus,
  DecisionActor,
  DecisionOutcome,
  InstanceStage,
  Round,
} from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { FIRST_ROUND_POOL } from "@/lib/first-round";
import { prisma } from "@/lib/prisma";

export interface FinalizeFirstRoundState {
  error?: string;
  message?: string;
}

function path(instanceId: string) {
  return `/instances/${instanceId}/first-round-results`;
}

/// FR-15's finalize, built from the requirement's own sentences rather than by
/// analogy to FR-11.
///
/// The PRD spells these out deliberately — "Finalize semantics, stated
/// explicitly rather than left to the word 'mirrors'" — so they are transcribed
/// here rather than inferred:
///
///   For every applicant in the pool (`status = ACTIVE`, `stageReached =
///   FIRST_ROUND`), one `Decision` row at `stage = FIRST_ROUND`.
///   Selected:     `outcome = ADVANCE`, status stays ACTIVE, stageReached → SECOND_ROUND.
///   Not selected: `outcome = REJECT`,  status → REJECTED,   stageReached stays FIRST_ROUND.
///   `Instance.currentStage → SECOND_ROUND`.
///
/// The structure is FR-11's, because that shape was paid for: a stage guard for
/// the stale tab, the pool recomputed server-side, unknown ids refused rather
/// than ignored, the audit row inside the transaction, and bulk statements
/// instead of a loop of upserts — 150 sequential round trips exceeded Prisma's
/// 5000 ms interactive-transaction limit and failed with P2028 on a realistic
/// cohort.
export async function finalizeFirstRound(
  _prev: FinalizeFirstRoundState,
  formData: FormData,
): Promise<FinalizeFirstRoundState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  await requireInstance(instanceId, path(instanceId));

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { id: true, currentStage: true },
  });
  if (!instance) return { error: "No such instance." };

  // The server half of the read-only state. The page stops rendering the
  // control once the round is finalized, and that is not a constraint on what
  // arrives: a second tab opened beforehand still holds a form bound here.
  if (instance.currentStage !== InstanceStage.FIRST_ROUND) {
    return {
      error:
        "The first round has already been finalized. Reload this page to see the results as they " +
        "stand.",
    };
  }

  // **The pool is computed here, not taken from the request.** The submitted ids
  // decide only who advances; who is eligible is a server fact. Read through the
  // same constant the reviewer dashboard votes against, so the set that was
  // voted on and the set that receives decisions are the same set.
  const pool = await prisma.applicant.findMany({
    where: { instanceId, ...FIRST_ROUND_POOL },
    select: { id: true },
  });

  if (pool.length === 0) {
    return { error: "There is no applicant left in the first round to decide on." };
  }

  const poolIds = new Set(pool.map((applicant) => applicant.id));
  const submitted = formData.getAll("selected").map(String);

  const unknown = submitted.filter((id) => !poolIds.has(id));
  if (unknown.length > 0) {
    return {
      error:
        `${unknown.length} selected applicant${unknown.length === 1 ? " is" : "s are"} no longer ` +
        `in the first round. Reload the page and make the selection again.`,
    };
  }

  const selected = new Set(submitted);
  const advanceIds = pool.filter((a) => selected.has(a.id)).map((a) => a.id);
  const rejectIds = pool.filter((a) => !selected.has(a.id)).map((a) => a.id);

  await prisma.$transaction(
    async (tx) => {
      await tx.auditLog.create({
        data: {
          instanceId,
          // One shared admin password, so the actor cannot yet name an
          // individual — open decision 16. Same literal every other audited
          // override uses. Counts only, no applicant names or ids.
          actor: "admin",
          action: "FINALIZE_FIRST_ROUND",
          entityType: "Instance",
          entityId: instanceId,
          previousValue: {
            stage: Round.FIRST_ROUND,
            previousInstanceStage: instance.currentStage,
            poolSize: pool.length,
            advanced: advanceIds.length,
            rejected: rejectIds.length,
          },
        },
      });

      // Delete-then-insert rather than one upsert per applicant, for the reason
      // above. Still idempotent — re-running reaches the same end state — and a
      // second finalize is already refused by the stage guard, so the only way
      // to meet existing rows is a retry after a failure, and a failure rolled
      // back.
      await tx.decision.deleteMany({
        where: { stage: Round.FIRST_ROUND, applicant: { instanceId } },
      });
      await tx.decision.createMany({
        data: pool.map((applicant) => ({
          applicantId: applicant.id,
          stage: Round.FIRST_ROUND,
          outcome: selected.has(applicant.id)
            ? DecisionOutcome.ADVANCE
            : DecisionOutcome.REJECT,
          actor: DecisionActor.ADMIN,
        })),
      });

      if (advanceIds.length > 0) {
        await tx.applicant.updateMany({
          where: { id: { in: advanceIds } },
          // stageReached only. Decision 41 dropped ADVANCED from the status
          // enum precisely because FR-17 defines second-round pass membership
          // as `status = ACTIVE` with no round qualifier — an advancing
          // applicant must stay ACTIVE the whole way through.
          data: { stageReached: Round.SECOND_ROUND },
        });
      }

      if (rejectIds.length > 0) {
        await tx.applicant.updateMany({
          where: { id: { in: rejectIds } },
          // stageReached stays FIRST_ROUND: it records how far they got, and
          // they got no further.
          data: { status: ApplicantStatus.REJECTED },
        });
      }

      await tx.instance.update({
        where: { id: instanceId },
        // What makes this screen's read-only state reachable, and what decision
        // 64 uses to tell a finished round from one that has not started.
        data: { currentStage: InstanceStage.SECOND_ROUND },
      });
    },
    { timeout: 20000 },
  );

  revalidatePath(path(instanceId));
  revalidatePath(`/instances/${instanceId}`);
  // The reviewer dashboard's empty state changes meaning at this moment —
  // decision 64.
  revalidatePath(`/r/${instanceId}/first-round`);
  // The instance list renders currentStage.
  revalidatePath("/");

  return {
    message: `First round finalized. ${advanceIds.length} advanced, ${rejectIds.length} rejected.`,
  };
}
