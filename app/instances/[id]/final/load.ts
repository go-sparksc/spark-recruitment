import "server-only";

// The query behind FR-19. Everything between it and the screen lives in
// `lib/final.ts`; this file shapes rows and computes nothing.
//
// **The final pass is the highest ordinal**, which is the same pass
// `closeSecondRound` writes NEEDS_ADMIN onto and the only one decision 73
// touches. A CARRIED row on an earlier pass carried into a later one and is
// history rather than an open question.

import { PassResolution, Round } from "@/generated/prisma/enums";
import type { FinalApplicantSource } from "@/lib/final";
import { buildPassGrid } from "@/lib/passes";
import { prisma } from "@/lib/prisma";

export interface FinalPageData {
  sources: FinalApplicantSource[];
  /// Null when no pass was ever created, which FR-17 blocks the close on — so on
  /// a COMPLETE instance this is always present, and its absence means the round
  /// is still open.
  finalPass: { id: string; ordinal: number } | null;
}

export async function loadFinalPage(instanceId: string): Promise<FinalPageData> {
  const finalPass = await prisma.pass.findFirst({
    where: { instanceId },
    orderBy: { ordinal: "desc" },
    select: { id: true, ordinal: true },
  });

  const applicants = await prisma.applicant.findMany({
    where: { instanceId, stageReached: Round.SECOND_ROUND },
    orderBy: { sourceRowIndex: "asc" },
    select: {
      id: true,
      sourceRowIndex: true,
      displayName: true,
      email: true,
      status: true,
      stageReached: true,
      decisions: {
        where: { stage: Round.SECOND_ROUND },
        select: { id: true },
      },
      passMemberships: finalPass
        ? {
            where: { passId: finalPass.id },
            select: { resolution: true },
          }
        : false,
    },
  });

  if (!finalPass) {
    return {
      finalPass: null,
      sources: applicants.map((applicant) => ({
        id: applicant.id,
        sourceRowIndex: applicant.sourceRowIndex,
        displayName: applicant.displayName,
        email: applicant.email,
        status: applicant.status,
        stageReached: applicant.stageReached,
        finalPassResolution: null,
        inFinalPass: false,
        hasSecondRoundDecision: applicant.decisions.length > 0,
        tally: null,
      })),
    };
  }

  // The tallies FR-19 requires stay visible, built by the same function FR-18's
  // grid uses so the two surfaces cannot disagree about what a row's votes say.
  const [roster, votes, conflicts, members] = await Promise.all([
    prisma.reviewer.findMany({
      where: { instanceId, rounds: { has: Round.SECOND_ROUND } },
      select: { id: true },
    }),
    prisma.passVote.findMany({
      where: { passId: finalPass.id },
      select: { applicantId: true, reviewerId: true, value: true },
    }),
    prisma.conflictOfInterest.findMany({
      where: { round: Round.SECOND_ROUND, applicant: { instanceId } },
      select: { applicantId: true, reviewerId: true },
    }),
    prisma.passApplicant.findMany({
      where: { passId: finalPass.id },
      select: { applicantId: true, resolution: true },
    }),
  ]);

  const memberIds = members.map((member) => member.applicantId);
  const storedByApplicant = new Map<string, PassResolution | null>(
    members.map((member) => [member.applicantId, member.resolution]),
  );

  const grid = buildPassGrid(
    {
      reviewerIds: roster.map((reviewer) => reviewer.id),
      applicantIds: memberIds,
      votes,
      conflicts,
    },
    storedByApplicant,
  );
  const tallyByApplicant = new Map(grid.rows.map((row) => [row.applicantId, row.tally]));

  return {
    finalPass,
    sources: applicants.map((applicant) => ({
      id: applicant.id,
      sourceRowIndex: applicant.sourceRowIndex,
      displayName: applicant.displayName,
      email: applicant.email,
      status: applicant.status,
      stageReached: applicant.stageReached,
      finalPassResolution: applicant.passMemberships[0]?.resolution ?? null,
      inFinalPass: applicant.passMemberships.length > 0,
      hasSecondRoundDecision: applicant.decisions.length > 0,
      tally: tallyByApplicant.get(applicant.id) ?? null,
    })),
  };
}
