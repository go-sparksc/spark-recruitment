"use server";

// FR-19's admit-or-reject, for the applicants the second round left undecided.
//
// `plans/phase-6.md` deferred this here explicitly: "Nothing in FR-17 or FR-18
// resolves a NEEDS_ADMIN applicant... Left to Phase 7: FR-19 renders the
// Unresolved group, and the admit/reject control belongs beside it. A deferral,
// not a hole." Decision 70 fixes what it writes — a `Decision` row "whenever an
// admin actually resolves that applicant" — and decision 89 fixes what it must
// NOT write.

import { revalidatePath } from "next/cache";

import {
  ApplicantStatus,
  DecisionActor,
  DecisionOutcome,
  InstanceStage,
  PassResolution,
  Round,
} from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export interface FinalActionState {
  error?: string;
  message?: string;
}

/// Admit or reject one applicant the round could not decide.
///
/// **`PassApplicant.resolution` is deliberately untouched** (decision 89). The
/// pass row records what happened *in that pass*, and the pass genuinely failed
/// to decide them — overwriting it would destroy that record to make a later
/// event look like an earlier one. What removes them from the Unresolved group
/// is the `Decision` row this writes, which is the second half of 89's
/// predicate.
///
/// **Only on a closed round.** An all-COI applicant carries `NEEDS_ADMIN` from
/// the moment a pass is created (clause 17v), so without this guard they would
/// appear here mid-round with an admit control beside them — and admitting them
/// would decide an applicant with no vote while passes were still running, a
/// capability no requirement grants. Mid-round the tools are FR-18's manual
/// reject and decision 76's conflict removal, both of which keep the decision
/// inside the pass machinery.
export async function decideApplicant(
  _prev: FinalActionState,
  formData: FormData,
): Promise<FinalActionState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const applicantId = String(formData.get("applicantId") ?? "");
  const raw = String(formData.get("outcome") ?? "");

  await requireInstance(instanceId, `/instances/${instanceId}/final`);

  if (raw !== DecisionOutcome.SPARKLET && raw !== DecisionOutcome.REJECT) {
    return { error: "Choose admit or reject." };
  }
  const outcome = raw as typeof DecisionOutcome.SPARKLET | typeof DecisionOutcome.REJECT;

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { currentStage: true },
  });
  if (!instance) return { error: "No such instance." };
  if (instance.currentStage !== InstanceStage.COMPLETE) {
    return {
      error:
        "The second round is still open. Close it first — while passes are running, an applicant " +
        "is decided by a pass, by a manual reject, or by removing the conflict that is blocking " +
        "them.",
    };
  }

  // Scoped to the instance and to the second round: an applicant id in a request
  // body is an untrusted reference until it has been confirmed to belong here.
  const applicant = await prisma.applicant.findFirst({
    where: { id: applicantId, instanceId, stageReached: Round.SECOND_ROUND },
    select: { id: true, status: true },
  });
  if (!applicant) return { error: "No such applicant in this instance's second round." };

  const finalPass = await prisma.pass.findFirst({
    where: { instanceId },
    orderBy: { ordinal: "desc" },
    select: { id: true, ordinal: true },
  });
  if (!finalPass) return { error: "This instance has no passes." };

  const membership = await prisma.passApplicant.findUnique({
    where: { passId_applicantId: { passId: finalPass.id, applicantId } },
    select: { resolution: true },
  });

  // Decision 89's predicate, re-read here rather than trusted from the request.
  // The page renders the same one; a second tab opened before someone else acted
  // still holds a form bound to this action.
  if (membership?.resolution !== PassResolution.NEEDS_ADMIN) {
    return { error: "That applicant was not left unresolved by the final pass. Reload the page." };
  }

  const status =
    outcome === DecisionOutcome.SPARKLET ? ApplicantStatus.SPARKLET : ApplicantStatus.REJECTED;

  try {
    await prisma.$transaction(async (tx) => {
      // **`create`, not `upsert`.** Decision 89's predicate says no
      // second-round `Decision` exists, so if one does, another admin resolved
      // this applicant between the check above and here. `UNIQUE (applicantId,
      // stage)` is what actually decides that race, and letting it bite turns a
      // check-then-act into a database guarantee rather than a UI convention.
      await tx.decision.create({
        data: {
          applicantId,
          stage: Round.SECOND_ROUND,
          outcome,
          // Decision 69's other actor. A person did this, not a tally — which is
          // exactly the distinction FR-20's decisions CSV renders.
          actor: DecisionActor.ADMIN,
        },
      });

      await tx.applicant.update({ where: { id: applicantId }, data: { status } });

      // Deliberately no `passApplicant.update`. See the note above and decision 89.

      await tx.auditLog.create({
        data: {
          instanceId,
          actor: "admin",
          action: "RESOLVE_UNRESOLVED_APPLICANT",
          // The id, never the name — the same rule clause 17t puts on every
          // other audit row in this round.
          entityType: "Applicant",
          entityId: applicantId,
          previousValue: {
            finalPassOrdinal: finalPass.ordinal,
            // Recorded because it is what the row still says afterwards, and a
            // successor reading NEEDS_ADMIN beside a SPARKLET status needs to
            // find the reason here rather than infer a bug.
            finalPassResolution: membership.resolution,
            previousStatus: applicant.status,
            outcome,
          },
        },
      });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return {
        error: "Another admin decided this applicant a moment ago. Reload to see where they stand.",
      };
    }
    throw error;
  }

  revalidatePath(`/instances/${instanceId}/final`);
  revalidatePath(`/instances/${instanceId}`);
  revalidatePath(`/instances/${instanceId}/results/${applicantId}`);

  return {
    message:
      outcome === DecisionOutcome.SPARKLET
        ? "Admitted. They now appear under New Sparklets."
        : "Rejected. They now appear under Rejected.",
  };
}
