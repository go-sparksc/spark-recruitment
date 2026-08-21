import "server-only";

// The first-round pool as a reviewer sees it. Shared by the list and the detail
// screen so the two cannot disagree about who is in the round.

import { ApplicantStatus, Round } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

/// Everyone still in the first round.
///
/// **No `Assignment` rows.** FR-14 describes "Round → First Round, then name"
/// and then the applicant's interview scores, with no mention of assignment, and
/// `FirstRoundVote` is keyed on `(applicantId, reviewerId)` with no assignment
/// either — every first-round reviewer votes on every applicant. That is the
/// structural difference from FR-9's written dashboard, where the pool exists
/// precisely because thirty reviewers cannot each read a hundred and fifty
/// essays. A first-round reviewer is reading two numbers and a paragraph.
///
/// The predicate matches FR-15's finalize pool exactly — `status = ACTIVE` and
/// `stageReached = FIRST_ROUND` — so the set a reviewer votes on and the set
/// that receives `Decision` rows cannot drift apart.
export const FIRST_ROUND_POOL = {
  status: ApplicantStatus.ACTIVE,
  stageReached: Round.FIRST_ROUND,
} as const;

export interface FirstRoundListRow {
  applicantId: string;
  displayName: string;
  sourceRowIndex: number;
  /// Null when this reviewer has not voted. Per FR-14 that absence IS the skip;
  /// no SKIP row is ever written in this round.
  vote: "YES" | "NO" | null;
  /// Clause 12q: the dashboard renders whichever half of the FR-12 import
  /// exists. These counts are what let the list say "no interview data yet"
  /// on a row instead of rendering an empty card.
  resultCount: number;
  hasNotes: boolean;
}

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

  return applicants.map((applicant) => {
    const vote = applicant.firstRoundVotes[0]?.value ?? null;
    return {
      applicantId: applicant.id,
      displayName: applicant.displayName,
      sourceRowIndex: applicant.sourceRowIndex,
      // SKIP is unreachable here — nothing writes one in this round — but the
      // column's type permits it, so it is narrowed rather than asserted.
      vote: vote === "YES" || vote === "NO" ? vote : null,
      resultCount: applicant._count.interviewResults,
      hasNotes: applicant.interviewNotes !== null,
    };
  });
}
