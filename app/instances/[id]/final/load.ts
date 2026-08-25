import "server-only";

// The query behind FR-19. Everything between it and the screen lives in
// `lib/final.ts`; this file shapes rows and computes nothing.
//
// **The final pass is the highest ordinal**, which is the same pass
// `closeSecondRound` writes NEEDS_ADMIN onto and the only one decision 73
// touches. A CARRIED row on an earlier pass carried into a later one and is
// history rather than an open question.

import { PassResolution, Round } from "@/generated/prisma/enums";
import { demographicColumns } from "@/lib/demographics";
import type { ApplicantData } from "@/lib/field-groups";
import type { FinalApplicantSource } from "@/lib/final";
import { buildFunnel, type Funnel } from "@/lib/funnel";
import { buildPassGrid } from "@/lib/passes";
import { prisma } from "@/lib/prisma";

export interface FinalPageData {
  sources: FinalApplicantSource[];
  /// FR-19's funnel runs over the **whole** applicant pool, not just the
  /// second-round cohort the groups above are drawn from — "against each
  /// preceding stage" is the entire point, and the first stage is everyone who
  /// applied.
  funnel: Funnel;
  /// Null when no pass was ever created, which FR-17 blocks the close on — so on
  /// a COMPLETE instance this is always present, and its absence means the round
  /// is still open.
  finalPass: { id: string; ordinal: number } | null;
}

/// The funnel's own query: every applicant in the instance, with the fields and
/// groups the §6 helper needs to decide which columns are demographic.
///
/// Separate from the group query above because the two populations differ —
/// the groups are the second-round cohort, and the funnel starts from everyone
/// who applied.
async function loadFunnel(instanceId: string): Promise<Funnel> {
  const [applicants, fields, groups] = await Promise.all([
    prisma.applicant.findMany({
      where: { instanceId },
      select: { id: true, data: true, stageReached: true, status: true },
    }),
    prisma.field.findMany({
      where: { instanceId },
      orderBy: { ordinal: "asc" },
      select: {
        id: true,
        displayName: true,
        ordinal: true,
        category: true,
        isIncluded: true,
        groupId: true,
        groupRole: true,
        visibleToWrittenReviewer: true,
        visibleToFirstRoundReviewer: true,
      },
    }),
    prisma.fieldGroup.findMany({
      where: { instanceId },
      select: {
        id: true,
        displayName: true,
        ordinal: true,
        category: true,
        isIncluded: true,
        visibleToWrittenReviewer: true,
        visibleToFirstRoundReviewer: true,
      },
    }),
  ]);

  // Through the §6 helper rather than by filtering on `category` here, so an
  // excluded group or a field an admin hid is absent for the same reason it is
  // absent everywhere else.
  const columns = demographicColumns(fields, groups, "ADMIN");

  return buildFunnel(
    applicants.map((applicant) => ({
      id: applicant.id,
      data: applicant.data as ApplicantData,
      stageReached: applicant.stageReached,
      status: applicant.status,
    })),
    columns,
  );
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
      funnel: await loadFunnel(instanceId),
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
  const [roster, votes, conflicts, members, funnel] = await Promise.all([
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
    loadFunnel(instanceId),
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
    funnel,
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
