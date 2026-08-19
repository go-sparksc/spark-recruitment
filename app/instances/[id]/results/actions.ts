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
import { prisma } from "@/lib/prisma";

export interface FinalizeState {
  error?: string;
  message?: string;
}

function path(instanceId: string) {
  return `/instances/${instanceId}/results`;
}

/// FR-11's finalize, with the semantics decision 41 makes explicit.
///
/// **A `Decision` row for every applicant in the pool, not only the ones who
/// advance.** The record of "we reviewed X and passed on them" is as real as the
/// record of advancing someone, and `UNIQUE (applicantId, stage)` exists to hold
/// exactly one of them.
///
/// Selected: `ADVANCE`, `status` stays `ACTIVE`, `stageReached → FIRST_ROUND`.
/// Not selected: `REJECT`, `status → REJECTED`, `stageReached` stays `WRITTEN`.
///
/// `status` deliberately does not move to anything for the advanced — decision
/// 41 dropped `ADVANCED` from the enum precisely because FR-17 defines
/// second-round membership as `status = ACTIVE` with no round qualifier, so an
/// advancing applicant must stay ACTIVE the whole way through.
export async function finalizeWritten(
  _prev: FinalizeState,
  formData: FormData,
): Promise<FinalizeState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  await requireInstance(instanceId, path(instanceId));

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { id: true, currentStage: true },
  });
  if (!instance) return { error: "No such instance." };

  // Clause 11e's server half. The page stops rendering the control once the
  // round is finalized, and that is not a constraint on what arrives: a second
  // tab opened before the finalize still holds a form bound to this action.
  //
  // Returned rather than thrown — a stale tab is a situation a real admin
  // reaches, not an impossible one, so it deserves a sentence rather than a
  // stack trace. Same shape as `openDraft` refusing a second CSV commit.
  if (instance.currentStage !== InstanceStage.WRITTEN) {
    return {
      error:
        "The written round has already been finalized. Reload this page to see the results as they stand.",
    };
  }

  // **The pool is computed here, not taken from the request.** The submitted ids
  // decide only who advances; who is *eligible* is a server fact. An id that is
  // not in the pool is refused rather than ignored, because silently dropping it
  // would let a stale tab finalize a selection that no longer means what the
  // admin saw.
  const pool = await prisma.applicant.findMany({
    where: {
      instanceId,
      status: ApplicantStatus.ACTIVE,
      stageReached: Round.WRITTEN,
    },
    select: { id: true },
  });

  if (pool.length === 0) {
    return { error: "There is no applicant left in the written round to decide on." };
  }

  const poolIds = new Set(pool.map((applicant) => applicant.id));
  const submitted = formData.getAll("selected").map(String);

  const unknown = submitted.filter((id) => !poolIds.has(id));
  if (unknown.length > 0) {
    return {
      error:
        `${unknown.length} selected applicant${unknown.length === 1 ? " is" : "s are"} no longer ` +
        `in the written round. Reload the page and make the selection again.`,
    };
  }

  const selected = new Set(submitted);
  const advanceIds = pool.filter((a) => selected.has(a.id)).map((a) => a.id);
  const rejectIds = pool.filter((a) => !selected.has(a.id)).map((a) => a.id);

  await prisma.$transaction(async (tx) => {
    // Audited before the writes, in the same transaction. §8 lists decision
    // reversal as audited, and the first write of a decision is not the lesser
    // event. No applicant names or ids in the payload — counts only, matching
    // what the other audited overrides record.
    await tx.auditLog.create({
      data: {
        instanceId,
        // One shared admin password, so the actor cannot yet name an
        // individual — see open decision 16. Same literal every other audited
        // override uses.
        actor: "admin",
        action: "FINALIZE_WRITTEN_ROUND",
        entityType: "Instance",
        entityId: instanceId,
        previousValue: {
          stage: Round.WRITTEN,
          previousInstanceStage: instance.currentStage,
          poolSize: pool.length,
          advanced: advanceIds.length,
          rejected: rejectIds.length,
        },
      },
    });

    for (const applicantId of pool.map((a) => a.id)) {
      const advancing = selected.has(applicantId);
      // Upsert rather than create, so a submit retried after a dropped
      // connection is idempotent rather than a unique-constraint error the
      // admin cannot act on. A reversal updates this row, per §5.
      await tx.decision.upsert({
        where: { applicantId_stage: { applicantId, stage: Round.WRITTEN } },
        create: {
          applicantId,
          stage: Round.WRITTEN,
          outcome: advancing ? DecisionOutcome.ADVANCE : DecisionOutcome.REJECT,
          actor: DecisionActor.ADMIN,
        },
        update: {
          outcome: advancing ? DecisionOutcome.ADVANCE : DecisionOutcome.REJECT,
          actor: DecisionActor.ADMIN,
        },
      });
    }

    if (advanceIds.length > 0) {
      await tx.applicant.updateMany({
        where: { id: { in: advanceIds } },
        // stageReached only. Decision 41: "populates the First Round tab" means
        // this and nothing more — no roster, no assignments, no access code.
        // That is FR-12 onward, Phase 5's job.
        data: { stageReached: Round.FIRST_ROUND },
      });
    }

    if (rejectIds.length > 0) {
      await tx.applicant.updateMany({
        where: { id: { in: rejectIds } },
        // stageReached stays WRITTEN: it records how far they got, and they
        // got no further.
        data: { status: ApplicantStatus.REJECTED },
      });
    }

    // Decision 43. One field on Instance, and what makes clause 11e's
    // read-only state reachable at all.
    await tx.instance.update({
      where: { id: instanceId },
      data: { currentStage: InstanceStage.FIRST_ROUND },
    });
  });

  revalidatePath(path(instanceId));
  revalidatePath(`/instances/${instanceId}`);
  // The instance list renders currentStage.
  revalidatePath("/");

  return {
    message: `Written round finalized. ${advanceIds.length} advanced, ${rejectIds.length} rejected.`,
  };
}
