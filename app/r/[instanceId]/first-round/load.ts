import "server-only";

// The first-round pool as a reviewer sees it. Shared by the list and the detail
// screen so the two cannot disagree about who is in the round.

import {
  FIRST_ROUND_POOL,
  toFirstRoundListRow,
  type FirstRoundListRow,
} from "@/lib/first-round";
import { prisma } from "@/lib/prisma";

export async function loadFirstRoundList(
  instanceId: string,
  reviewerId: string,
): Promise<FirstRoundListRow[]> {
  const applicants = await prisma.applicant.findMany({
    where: { instanceId, ...FIRST_ROUND_POOL },
    // Source order, the same order the written round's list runs in, so an
    // applicant sits in a stable place across both rounds.
    orderBy: { sourceRowIndex: "asc" },
    select: {
      id: true,
      // §6 permits a first-round reviewer the applicant's name: they sat in the
      // room. `resolvePromoted` blinds only the written round.
      displayName: true,
      sourceRowIndex: true,
      interviewNotes: { select: { id: true } },
      _count: { select: { interviewResults: true } },
      // Only this reviewer's vote. Another reviewer's would be an anchoring
      // problem, and §7.4's stance on live counts applies at least as much
      // before a vote as during one.
      firstRoundVotes: {
        where: { reviewerId },
        select: { value: true },
      },
    },
  });

  return applicants.map((applicant) =>
    toFirstRoundListRow({
      id: applicant.id,
      displayName: applicant.displayName,
      sourceRowIndex: applicant.sourceRowIndex,
      resultCount: applicant._count.interviewResults,
      hasNotes: applicant.interviewNotes !== null,
      vote: applicant.firstRoundVotes[0]?.value ?? null,
    }),
  );
}
