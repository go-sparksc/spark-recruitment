import "server-only";

// The second-round pool as one reviewer sees it. Shared by the list and the
// profile so the two cannot disagree about who is in the round.
//
// Same shape as the first round's loader, and the same division of labour: the
// query lives here, everything after it lives in lib/second-round.ts where a
// test can reach it.

import { Round } from "@/generated/prisma/enums";
import { SECOND_ROUND_COHORT } from "@/lib/passes";
import { prisma } from "@/lib/prisma";
import { toSecondRoundListRow, type SecondRoundListRow } from "@/lib/second-round";

export async function loadSecondRoundList(
  instanceId: string,
  reviewerId: string,
): Promise<SecondRoundListRow[]> {
  const applicants = await prisma.applicant.findMany({
    // **`SECOND_ROUND_COHORT`, not `SECOND_ROUND_POOL`** — decision 112. This
    // asks who reached the second round, and the answer stays true after the
    // applicant resolves; the pool asks who a new pass is created over, which is
    // clause 17b and is `status = ACTIVE` by requirement.
    //
    // The two were one constant until decision 112, because the sets coincided.
    // They no longer do, and the comment that used to stand here — "two
    // definitions of who is in the second round would mean a reviewer reading an
    // applicant who is not in the pass" — had the risk backwards: it is the
    // shared constant that would have forced one of the two surfaces to be
    // wrong. A reviewer reading a resolved applicant is now the requirement.
    where: { instanceId, ...SECOND_ROUND_COHORT },
    // Source order, the order both earlier rounds run in, so an applicant sits
    // in a stable place across all three — and, since decision 112, keeps that
    // place when they resolve rather than jumping or vanishing.
    orderBy: { sourceRowIndex: "asc" },
    select: {
      id: true,
      displayName: true,
      sourceRowIndex: true,
      // Decision 111's outcome. The durable record, and the only one that still
      // answers once the pass that wrote it has closed.
      status: true,
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
      status: applicant.status,
      conflicts: applicant.conflicts,
      interviewResultCount: applicant._count.interviewResults,
      hasInterviewNotes: applicant.interviewNotes !== null,
    }),
  );
}
