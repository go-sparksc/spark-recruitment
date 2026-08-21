import "server-only";

// The second-round pool as one reviewer sees it. Shared by the list and the
// profile so the two cannot disagree about who is in the round.
//
// Same shape as the first round's loader, and the same division of labour: the
// query lives here, everything after it lives in lib/second-round.ts where a
// test can reach it.

import { Round } from "@/generated/prisma/enums";
import { SECOND_ROUND_POOL } from "@/lib/passes";
import { prisma } from "@/lib/prisma";
import { toSecondRoundListRow, type SecondRoundListRow } from "@/lib/second-round";

export async function loadSecondRoundList(
  instanceId: string,
  reviewerId: string,
): Promise<SecondRoundListRow[]> {
  const applicants = await prisma.applicant.findMany({
    // **`SECOND_ROUND_POOL`, the same constant FR-17 creates a pass from.** Two
    // definitions of "who is in the second round" would mean a reviewer reading
    // an applicant who is not in the pass, or a pass containing someone nobody
    // was shown.
    where: { instanceId, ...SECOND_ROUND_POOL },
    // Source order, the order both earlier rounds run in, so an applicant sits
    // in a stable place across all three.
    orderBy: { sourceRowIndex: "asc" },
    select: {
      id: true,
      displayName: true,
      sourceRowIndex: true,
      interviewNotes: { select: { id: true } },
      _count: { select: { interviewResults: true } },
      // **Only this reviewer's conflict.** Whose else would be a fact about a
      // colleague's relationships that nobody on this screen needs, and §7.4's
      // stance on not knowing what other reviewers are doing covers it.
      conflicts: {
        where: { reviewerId, round: Round.SECOND_ROUND },
        select: { id: true },
      },
    },
  });

  return applicants.map((applicant) =>
    toSecondRoundListRow({
      id: applicant.id,
      displayName: applicant.displayName,
      sourceRowIndex: applicant.sourceRowIndex,
      conflicts: applicant.conflicts,
      interviewResultCount: applicant._count.interviewResults,
      hasInterviewNotes: applicant.interviewNotes !== null,
    }),
  );
}
