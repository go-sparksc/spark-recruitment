"use server";

import { revalidatePath } from "next/cache";

import { AssignmentOrigin, AssignmentStatus, Round } from "@/generated/prisma/enums";
import {
  checkFeasibility,
  generateAssignments,
  type AssignmentInput,
  type FeasibilityReport,
  type Pair,
} from "@/lib/assignment";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export interface ActionState {
  error?: string;
  message?: string;
}

function path(instanceId: string) {
  return `/instances/${instanceId}/assignments`;
}

/// Everything `lib/assignment.ts` needs, read from the database.
///
/// Read inside the action that uses it rather than passed from the client: the
/// preserved set decides what survives a regeneration, and trusting the browser
/// for that would let a stale page silently discard an override an admin added
/// in another tab. §10.5 settles concurrent admins as last-write-wins, which is
/// fine for an edit and not for a bulk delete.
async function loadInput(
  instanceId: string,
  round: Round,
  relaxSparkletLoad: boolean,
): Promise<AssignmentInput & { preserved: Pair[] }> {
  const [applicants, reviewers, existing] = await Promise.all([
    prisma.applicant.findMany({
      where: { instanceId },
      orderBy: { sourceRowIndex: "asc" },
      select: { id: true },
    }),
    // FR-7: reviewer_count means the roster of the round being assigned.
    prisma.reviewer.findMany({
      where: { instanceId, rounds: { has: round } },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: { id: true, isSparklet: true },
    }),
    prisma.assignment.findMany({
      where: { instanceId, round },
      select: { applicantId: true, reviewerId: true, origin: true, status: true },
    }),
  ]);

  // FR-8 plus decision 21: MANUAL and CLAIMED_FROM_POOL are preserved as
  // consumed capacity. Decision 23: a returned row is an exclusion that consumes
  // nothing — it records a recusal, and re-pairing them would undo it.
  const active = existing.filter((a) => a.status === AssignmentStatus.ACTIVE);

  return {
    applicantIds: applicants.map((a) => a.id),
    reviewers,
    preserved: active
      .filter((a) => a.origin !== AssignmentOrigin.AUTO)
      .map(({ applicantId, reviewerId }) => ({ applicantId, reviewerId })),
    blocked: existing
      .filter((a) => a.status === AssignmentStatus.RETURNED_TO_POOL)
      .map(({ applicantId, reviewerId }) => ({ applicantId, reviewerId })),
    relaxSparkletLoad,
    seed: Date.now(),
  };
}

export interface PrecheckView {
  report: FeasibilityReport;
  applicantCount: number;
  reviewerCount: number;
  sparkletCount: number;
  autoCount: number;
  manualCount: number;
  claimedCount: number;
}

/// FR-7's precheck, rendered before anything is generated. Never writes.
export async function precheck(instanceId: string, round: Round): Promise<PrecheckView> {
  await requireInstance(instanceId, path(instanceId));

  const input = await loadInput(instanceId, round, false);
  const counts = await prisma.assignment.groupBy({
    by: ["origin"],
    where: { instanceId, round, status: AssignmentStatus.ACTIVE },
    _count: { _all: true },
  });

  const byOrigin = (origin: AssignmentOrigin) =>
    counts.find((c) => c.origin === origin)?._count._all ?? 0;

  return {
    report: checkFeasibility(input),
    applicantCount: input.applicantIds.length,
    reviewerCount: input.reviewers.length,
    sparkletCount: input.reviewers.filter((r) => r.isSparklet).length,
    autoCount: byOrigin(AssignmentOrigin.AUTO),
    manualCount: byOrigin(AssignmentOrigin.MANUAL),
    claimedCount: byOrigin(AssignmentOrigin.CLAIMED_FROM_POOL),
  };
}

export interface GenerateResult extends ActionState {
  report?: FeasibilityReport;
  /// Reviewer id to load, for the distribution table.
  loadByReviewerId?: Record<string, number>;
  violations?: { detail: string; reviewerId?: string; applicantId?: string }[];
}

/// Generate, or regenerate.
///
/// `discardPreserved` is FR-8's "unless explicitly told otherwise" — the second
/// button on the regeneration warning. Without it, MANUAL and CLAIMED_FROM_POOL
/// rows survive and are consumed as capacity.
export async function generate(
  instanceId: string,
  round: Round,
  options: { relaxSparkletLoad?: boolean; discardPreserved?: boolean } = {},
): Promise<GenerateResult> {
  await requireInstance(instanceId, path(instanceId));

  const loaded = await loadInput(instanceId, round, options.relaxSparkletLoad === true);
  const input: AssignmentInput = options.discardPreserved ? { ...loaded, preserved: [] } : loaded;

  const plan = generateAssignments(input);

  if (!plan.report.feasible && options.relaxSparkletLoad !== true) {
    // FR-7: "the system must not silently violate a constraint." Nothing is
    // written; the page renders the message and the two actions.
    return { report: plan.report, error: plan.report.message ?? undefined };
  }

  const discarded = options.discardPreserved ? loaded.preserved.length : 0;

  await prisma.$transaction(async (tx) => {
    await tx.assignment.deleteMany({
      where: {
        instanceId,
        round,
        // AUTO rows are the generator's own output and are replaced. Returned
        // rows survive whatever their origin: they are the record of a recusal,
        // and deleting one would let the same pair be generated next time.
        status: AssignmentStatus.ACTIVE,
        ...(options.discardPreserved ? {} : { origin: AssignmentOrigin.AUTO }),
      },
    });

    await tx.assignment.createMany({
      data: plan.assignments.map((pair) => ({
        instanceId,
        round,
        applicantId: pair.applicantId,
        reviewerId: pair.reviewerId,
        origin: AssignmentOrigin.AUTO,
      })),
    });

    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
        action: "GENERATE_ASSIGNMENTS",
        entityType: "Instance",
        entityId: instanceId,
        previousValue: {
          round,
          generated: plan.assignments.length,
          relaxSparkletLoad: options.relaxSparkletLoad === true,
          preservedKept: options.discardPreserved ? 0 : loaded.preserved.length,
          discardedOverrides: discarded,
        },
      },
    });
  });

  // The BUILD_PLAN gate asks for the distribution on the console. Sorted, so an
  // uneven tail is visible at a glance rather than buried in insertion order.
  const loads = Object.entries(plan.loadByReviewerId).sort((a, b) => a[1] - b[1]);
  const histogram = new Map<number, number>();
  for (const [, load] of loads) histogram.set(load, (histogram.get(load) ?? 0) + 1);
  console.log(
    `[assignments] ${round}: ${plan.assignments.length} placed, ` +
      `${plan.report.poolSize} pooled, ceiling ${plan.report.loadCeiling}, ` +
      `floor ${plan.report.loadFloor}`,
  );
  console.log(
    `[assignments] load distribution: ` +
      [...histogram]
        .sort((a, b) => a[0] - b[0])
        .map(([load, n]) => `${n}x${load}`)
        .join("  "),
  );

  revalidatePath(path(instanceId));

  return {
    report: plan.report,
    loadByReviewerId: plan.loadByReviewerId,
    violations: plan.preexistingViolations.map((v) => ({
      detail: v.detail,
      reviewerId: v.reviewerId,
      applicantId: v.applicantId,
    })),
    message:
      `Placed ${plan.assignments.length} assignments. ` +
      `${plan.report.shortApplicantCount} applicants are one reviewer short, by design.` +
      (discarded > 0 ? ` Discarded ${discarded} override${discarded === 1 ? "" : "s"}.` : ""),
  };
}

// ---------------------------------------------------------------------------
// FR-8 manual override
// ---------------------------------------------------------------------------

/// Assign one reviewer to one applicant, marked MANUAL.
///
/// The two rules that can refuse it are named rather than left to the unique
/// index: FR-7's one-Sparklet rule, and the pair already existing. A constraint
/// violation surfacing as a database error tells an admin nothing they can act on.
export async function assignReviewer(
  instanceId: string,
  round: Round,
  applicantId: string,
  reviewerId: string,
): Promise<ActionState> {
  await requireInstance(instanceId, path(instanceId));

  const [reviewer, current] = await Promise.all([
    prisma.reviewer.findFirst({
      where: { id: reviewerId, instanceId },
      select: { id: true, firstName: true, lastName: true, isSparklet: true, rounds: true },
    }),
    prisma.assignment.findMany({
      where: { instanceId, round, applicantId, status: AssignmentStatus.ACTIVE },
      select: { reviewerId: true, reviewer: { select: { isSparklet: true } } },
    }),
  ]);

  if (!reviewer) return { error: "That reviewer no longer exists." };
  if (!reviewer.rounds.includes(round)) {
    return { error: `${reviewer.firstName} ${reviewer.lastName} does not serve this round.` };
  }
  if (current.some((a) => a.reviewerId === reviewerId)) {
    return { error: `${reviewer.firstName} ${reviewer.lastName} is already on this applicant.` };
  }
  if (reviewer.isSparklet && current.some((a) => a.reviewer.isSparklet)) {
    return {
      error:
        `This applicant already has a Sparklet reviewer, and at most one Sparklet may review ` +
        `any applicant. Remove the existing one first, or pick a non-Sparklet.`,
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.assignment.create({
      data: { instanceId, round, applicantId, reviewerId, origin: AssignmentOrigin.MANUAL },
    });
    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
        action: "ASSIGN_REVIEWER",
        entityType: "Applicant",
        entityId: applicantId,
        previousValue: { round, reviewerId, reviewerName: `${reviewer.firstName} ${reviewer.lastName}` },
      },
    });
  });

  revalidatePath(path(instanceId));
  return { message: `Assigned ${reviewer.firstName} ${reviewer.lastName}.` };
}

/// Remove one reviewer from one applicant. Audited with what it removed, per §8.
export async function unassignReviewer(
  instanceId: string,
  round: Round,
  applicantId: string,
  reviewerId: string,
): Promise<ActionState> {
  await requireInstance(instanceId, path(instanceId));

  const assignment = await prisma.assignment.findFirst({
    where: { instanceId, round, applicantId, reviewerId },
    select: {
      id: true,
      origin: true,
      _count: { select: { scores: true } },
      reviewer: { select: { firstName: true, lastName: true } },
    },
  });

  if (!assignment) return { error: "That assignment no longer exists." };

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
        action: "UNASSIGN_REVIEWER",
        entityType: "Applicant",
        entityId: applicantId,
        previousValue: {
          round,
          reviewerId,
          origin: assignment.origin,
          deletedScoreCount: assignment._count.scores,
        },
      },
    });
    await tx.assignment.delete({ where: { id: assignment.id } });
  });

  revalidatePath(path(instanceId));
  return {
    message:
      `Removed ${assignment.reviewer.firstName} ${assignment.reviewer.lastName}.` +
      (assignment._count.scores > 0
        ? ` ${assignment._count.scores} score${assignment._count.scores === 1 ? "" : "s"} went with it.`
        : ""),
  };
}
