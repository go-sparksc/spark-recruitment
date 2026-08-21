"use server";

import { revalidatePath } from "next/cache";

import { PassStatus, Round } from "@/generated/prisma/enums";
import { SECOND_ROUND_POOL } from "@/lib/passes";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";

export interface ConflictState {
  error?: string;
}

/// FR-16: "Reviewer can flag conflict of interest per applicant, which is sticky
/// across all passes."
///
/// **Sticky falls out of the key, not out of a rule.** `ConflictOfInterest` is
/// unique on `(round, applicantId, reviewerId)` and carries no pass dimension,
/// so there is nowhere for a per-pass conflict to be stored even by accident.
/// Decision 68's "in that pass and any later one" is the same fact stated from
/// the other side.
///
/// **Decision 68: flagging deletes any vote already cast in the open pass.** A
/// vote from a reviewer who has since disclosed a conflict cannot go on counting
/// toward unanimity — and because `lib/passes.ts` computes a conflicted reviewer
/// as SKIP whether or not a row survives, the deletion is about the record
/// rather than about the arithmetic. Both halves matter: the arithmetic must be
/// right even if this fails, and the record must not show a vote the system will
/// not count. Same transaction, so a partial failure leaves neither.
///
/// This is one-way for the reviewer, per decision 76. An admin can remove it
/// from FR-18's grid; nothing here can, and the confirm in the UI says so.
export async function flagConflict(formData: FormData): Promise<ConflictState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const applicantId = String(formData.get("applicantId") ?? "");

  // Inside the action, not only on the page: a server action is a POST endpoint
  // reachable without rendering the form that submits to it.
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  if (session.rd !== Round.SECOND_ROUND) {
    return { error: "You are signed in for a different round." };
  }

  // **The applicant is re-checked against the pool**, not taken from the
  // request. An id that has since resolved — made a Sparklet, or rejected — is
  // no longer somebody this reviewer can recuse from.
  const applicant = await prisma.applicant.findFirst({
    where: { id: applicantId, instanceId, ...SECOND_ROUND_POOL },
    select: { id: true },
  });

  if (!applicant) {
    return {
      error:
        "That applicant is no longer in the second round. Reload the page to see the list as it " +
        "stands.",
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.conflictOfInterest.upsert({
      where: {
        round_applicantId_reviewerId: {
          round: Round.SECOND_ROUND,
          applicantId: applicant.id,
          reviewerId: reviewer.id,
        },
      },
      create: {
        round: Round.SECOND_ROUND,
        applicantId: applicant.id,
        reviewerId: reviewer.id,
      },
      // Idempotent: flagging twice is one conflict, not an error. A reviewer
      // double-tapping on a phone must not see a failure for doing the thing
      // they meant to do.
      update: {},
    });

    // Decision 68, scoped to passes that are still OPEN.
    //
    // The decision says the reviewer is SKIP "from that point forward, in that
    // pass and any later one" — forward, which a closed pass is not. Deleting a
    // closed pass's vote would rewrite a decision that has already been made
    // and recorded, and §7.4 is explicit that a closed pass is not reopened;
    // corrections there happen through an admin override on the applicant.
    //
    // Nothing is lost by leaving it. A closed pass's `PassApplicant.resolution`
    // is stored, and `buildPassGrid` renders the stored value over the recount,
    // so the conflict flagged today cannot retroactively unmake last week's
    // Sparklet — it just shows, correctly, that the two now differ.
    await tx.passVote.deleteMany({
      where: {
        applicantId: applicant.id,
        reviewerId: reviewer.id,
        pass: { status: PassStatus.OPEN },
      },
    });
  });

  revalidatePath(`/r/${instanceId}/second-round`);
  revalidatePath(`/r/${instanceId}/second-round/${applicant.id}`);
  return {};
}
