"use server";

import { revalidatePath } from "next/cache";

import { ApplicantStatus, Round, VoteValue } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";

export interface VoteState {
  error?: string;
}

/// FR-14: "Reviewer votes YES or NO per applicant. No vote recorded means SKIP."
///
/// **No `SKIP` row is ever written in this round.** The absence of a row IS the
/// skip, which is what lets FR-15 exclude skips from both sides of its
/// percentage without having to distinguish an abstention from an unread
/// applicant — there is nothing to distinguish. `VoteValue.SKIP` exists for the
/// second round, where a conflict of interest resolves to an explicit skip that
/// has to be told apart from silence.
///
/// **A vote is changeable until finalize**, per PRD decision 63. Resubmitting
/// updates the existing row through `UNIQUE (applicantId, reviewerId)` rather
/// than adding a second, so a misclick costs one tap rather than the rest of the
/// round.
export async function submitFirstRoundVote(formData: FormData): Promise<VoteState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const applicantId = String(formData.get("applicantId") ?? "");
  const raw = String(formData.get("value") ?? "");

  // Inside the action, not only on the page. A server action is a POST endpoint
  // reachable without rendering the form that submits to it.
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  // The session names a round. A written-round reviewer posting here would
  // otherwise cast a first-round vote they are not on the roster for.
  if (session.rd !== Round.FIRST_ROUND) {
    return { error: "You are signed in for a different round." };
  }

  if (raw !== VoteValue.YES && raw !== VoteValue.NO) {
    // SKIP is not submittable. It is not a value a reviewer chooses; it is what
    // the absence of a row means.
    return { error: "A vote is either yes or no." };
  }

  // **The applicant is re-checked against the first-round pool**, not taken from
  // the request. An id that is no longer in the round — rejected at the written
  // stage, or already advanced by a finalize that happened while this page was
  // open — must not receive a vote that FR-15 would then count.
  const applicant = await prisma.applicant.findFirst({
    where: {
      id: applicantId,
      instanceId,
      status: ApplicantStatus.ACTIVE,
      stageReached: Round.FIRST_ROUND,
    },
    select: { id: true },
  });

  if (!applicant) {
    return {
      error:
        "That applicant is no longer in the first round. Reload the page to see the list as it " +
        "stands.",
    };
  }

  await prisma.firstRoundVote.upsert({
    where: { applicantId_reviewerId: { applicantId: applicant.id, reviewerId: reviewer.id } },
    create: { applicantId: applicant.id, reviewerId: reviewer.id, value: raw },
    // Decision 63. `updatedAt` moves; `submittedAt` keeps the first time they
    // decided, which is the more useful of the two if anyone ever asks.
    update: { value: raw },
  });

  revalidatePath(`/r/${instanceId}/first-round`);
  revalidatePath(`/r/${instanceId}/first-round/${applicant.id}`);
  return {};
}
