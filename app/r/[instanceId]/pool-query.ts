import "server-only";

// FR-9 clause 6b and 6c: which applicants are short a reviewer, and which of
// those this reviewer may actually take.
//
// **One definition of "open to me", called by two surfaces.** The pool page
// renders these rows; the list header renders their count. Computing the count
// separately is how a header saying "Claim from pool (3)" ends up opening a page
// with two rows on it — and the reviewer who taps it is the one who finds out.

import { AssignmentStatus, Round } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { claimEligibility, openSlotsOf, targetFor, type ClaimReviewer } from "@/lib/review";

export interface PoolRow {
  applicantId: string;
  /// "Applicant 47". The only identity a written reviewer gets, here as
  /// everywhere else.
  label: string;
  activeCount: number;
  target: number;
}

/// Every applicant with an open slot this reviewer is eligible to claim.
///
/// Three queries and a fold in memory rather than a `groupBy` with a having
/// clause. At 150 applicants and ~450 assignments the difference is
/// unmeasurable, and the fold is the version a maintainer can check against
/// `claimEligibility` line by line — which matters more here than elsewhere,
/// because this list and the claim transaction must agree about who may claim
/// what.
export async function openPoolFor(
  instanceId: string,
  round: Round,
  reviewer: ClaimReviewer,
): Promise<PoolRow[]> {
  const [applicants, roundReviewerCount, assignments] = await Promise.all([
    prisma.applicant.findMany({
      where: { instanceId },
      orderBy: { sourceRowIndex: "asc" },
      // §6: no displayName, no email. Nothing on this page needs them, and a
      // column that is never loaded cannot be rendered by mistake.
      select: { id: true, sourceRowIndex: true },
    }),
    prisma.reviewer.count({ where: { instanceId, rounds: { has: round } } }),
    prisma.assignment.findMany({
      where: { instanceId, round, status: AssignmentStatus.ACTIVE },
      select: {
        applicantId: true,
        reviewerId: true,
        reviewer: { select: { isSparklet: true } },
      },
    }),
  ]);

  const activeByApplicant = new Map<string, { reviewerIds: string[]; hasSparklet: boolean }>();
  for (const assignment of assignments) {
    const entry = activeByApplicant.get(assignment.applicantId) ?? {
      reviewerIds: [],
      hasSparklet: false,
    };
    entry.reviewerIds.push(assignment.reviewerId);
    entry.hasSparklet = entry.hasSparklet || assignment.reviewer.isSparklet;
    activeByApplicant.set(assignment.applicantId, entry);
  }

  // From planShape, not a literal 3. On a roster smaller than three the target
  // is smaller too, and a hardcoded 3 would advertise slots that no reviewer
  // exists to fill.
  const target = targetFor(applicants.length, roundReviewerCount);

  const rows: PoolRow[] = [];
  for (const applicant of applicants) {
    const active = activeByApplicant.get(applicant.id) ?? { reviewerIds: [], hasSparklet: false };
    const verdict = claimEligibility(reviewer, {
      openSlots: openSlotsOf(target, active.reviewerIds.length),
      assignedReviewerIds: active.reviewerIds,
      hasSparklet: active.hasSparklet,
    });

    // Clause 6c in one line: short a reviewer, and open to *this* reviewer.
    // Applicants they returned are here, per decision 28 — a returned row is
    // not an active assignment, so it does not read as ALREADY_ASSIGNED.
    if (!verdict.eligible) continue;

    rows.push({
      applicantId: applicant.id,
      label: `Applicant ${applicant.sourceRowIndex}`,
      activeCount: active.reviewerIds.length,
      target,
    });
  }

  return rows;
}
