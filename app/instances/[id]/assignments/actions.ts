"use server";

import { revalidatePath } from "next/cache";

import { Prisma } from "@/generated/prisma/client";
import { AssignmentOrigin, AssignmentStatus, ReturnReason, Round } from "@/generated/prisma/enums";
import {
  checkFeasibility,
  generateAssignments,
  type AssignmentInput,
  type FeasibilityReport,
  type Pair,
} from "@/lib/assignment";
import { auditActor } from "@/lib/audit";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateReturn } from "@/lib/review";

export interface ActionState {
  error?: string;
  message?: string;
}

function path(instanceId: string) {
  return `/instances/${instanceId}/assignments`;
}

/// Everything `lib/assignment.ts` needs, read from the database.
///
/// Takes the client so that `generate` can call it **inside** its transaction.
/// Two reasons, and the second is why the parameter exists at all:
///
/// The preserved set decides what survives a regeneration, so trusting the
/// browser for it would let a stale page discard an override an admin added in
/// another tab. §10.5 settles concurrent admins as last-write-wins, which is
/// fine for an edit and not for a bulk delete.
///
/// Reading it from the database but *outside* the transaction only narrows that
/// window rather than closing it. An override written between the read and the
/// delete survives — the delete is scoped to AUTO — but was never counted as
/// consumed capacity, so its reviewer can end up over the ceiling with nothing
/// reporting it. Inside the transaction, the set the plan was built from is the
/// set the delete runs against.
async function loadInput(
  db: Prisma.TransactionClient,
  instanceId: string,
  round: Round,
  relaxSparkletLoad: boolean,
): Promise<AssignmentInput & { preserved: Pair[]; rowIndexById: Map<string, number> }> {
  const [applicants, reviewers, existing] = await Promise.all([
    db.applicant.findMany({
      where: { instanceId },
      orderBy: { sourceRowIndex: "asc" },
      // The row index is what decision 99's shortfall is reported by: the
      // anonymous label is the identifier an admin can act on from this page.
      select: { id: true, sourceRowIndex: true },
    }),
    // FR-7: reviewer_count means the roster of the round being assigned.
    db.reviewer.findMany({
      where: { instanceId, rounds: { has: round } },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: { id: true, isSparklet: true },
    }),
    db.assignment.findMany({
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
    rowIndexById: new Map(applicants.map((a) => [a.id, a.sourceRowIndex])),
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

  const input = await loadInput(prisma, instanceId, round, false);
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
  /// Decision 99: applicants the fill left below what the plan wanted for them.
  /// Labelled with the anonymous handle, which is what FR-8's list is found by.
  shortfall?: { applicantId: string; label: string; wanted: number; got: number }[];
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
  const session = await requireInstance(instanceId, path(instanceId));

  // Read, plan and write in one transaction, so the preserved set the plan was
  // built from is the set the delete runs against. See `loadInput`.
  let plan: ReturnType<typeof generateAssignments> | null = null;
  let discarded = 0;
  let rowIndexById = new Map<string, number>();

  await prisma.$transaction(
    async (tx) => {
      const loaded = await loadInput(tx, instanceId, round, options.relaxSparkletLoad === true);
      rowIndexById = loaded.rowIndexById;
      const input: AssignmentInput = options.discardPreserved
        ? { ...loaded, preserved: [] }
        : loaded;

      plan = generateAssignments(input);

      if (!plan.report.feasible && options.relaxSparkletLoad !== true) {
        // FR-7: "the system must not silently violate a constraint." Returning
        // early leaves the transaction read-only, so nothing is written and the
        // page renders the message and the two actions.
        return;
      }

      discarded = options.discardPreserved ? loaded.preserved.length : 0;

      await tx.assignment.deleteMany({
        where: {
          instanceId,
          round,
          // AUTO rows are the generator's own output and are replaced. Returned
          // rows survive whatever their origin: they are the record of a
          // recusal, and deleting one would let the pair be generated again.
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
          ...auditActor(session),
          action: "GENERATE_ASSIGNMENTS",
          entityType: "Instance",
          entityId: instanceId,
          previousValue: {
            round,
            generated: plan.assignments.length,
            relaxSparkletLoad: options.relaxSparkletLoad === true,
            preservedKept: options.discardPreserved ? 0 : loaded.preserved.length,
            discardedOverrides: discarded,
            // Decision 99. Ids only, per §8 — the page names them by handle.
            shortfall: plan.shortfall.map((entry) => entry.applicantId),
          },
        },
      });
    },
    // The default interactive-transaction timeout is 5s. Planning 450 slots is
    // in-memory and fast, but the reads and the createMany now sit inside it,
    // and a slow connection should not roll back a correct plan.
    { timeout: 20_000 },
  );

  if (plan === null) throw new Error("generate produced no plan");
  const settled: ReturnType<typeof generateAssignments> = plan;

  if (!settled.report.feasible && options.relaxSparkletLoad !== true) {
    return { report: settled.report, error: settled.report.message ?? undefined };
  }

  // The BUILD_PLAN gate asks for the distribution on the console. Sorted, so an
  // uneven tail is visible at a glance rather than buried in insertion order.
  const loads = Object.entries(settled.loadByReviewerId).sort((a, b) => a[1] - b[1]);
  const histogram = new Map<number, number>();
  for (const [, load] of loads) histogram.set(load, (histogram.get(load) ?? 0) + 1);
  console.log(
    `[assignments] ${round}: ${settled.assignments.length} placed, ` +
      `${settled.report.poolSize} pooled, ceiling ${settled.report.loadCeiling}, ` +
      `floor ${settled.report.loadFloor}, ` +
      `${settled.shortfall.length} applicant${settled.shortfall.length === 1 ? "" : "s"} under-staffed`,
  );
  console.log(
    `[assignments] load distribution: ` +
      [...histogram]
        .sort((a, b) => a[0] - b[0])
        .map(([load, n]) => `${n}x${load}`)
        .join("  "),
  );

  revalidatePath(path(instanceId));

  // Decision 99: the plan is placed, and the run is not called a success while
  // anyone is under-staffed. The list is what the admin acts on; the message
  // only says that it exists.
  const shortfall = settled.shortfall.map((entry) => ({
    applicantId: entry.applicantId,
    label: `Applicant ${rowIndexById.get(entry.applicantId) ?? "?"}`,
    wanted: entry.wanted,
    got: entry.got,
  }));
  const placed = `Placed ${settled.assignments.length} assignments.`;
  const byDesign = `${settled.report.shortApplicantCount} applicants are one reviewer short, by design.`;
  const discardedNote =
    discarded > 0 ? ` Discarded ${discarded} override${discarded === 1 ? "" : "s"}.` : "";

  return {
    report: settled.report,
    loadByReviewerId: settled.loadByReviewerId,
    violations: settled.preexistingViolations.map((v) => ({
      detail: v.detail,
      reviewerId: v.reviewerId,
      applicantId: v.applicantId,
    })),
    shortfall,
    message:
      shortfall.length === 0
        ? `${placed} ${byDesign}${discardedNote}`
        : `${placed} ${byDesign}${discardedNote} ${shortfall.length} applicant` +
          `${shortfall.length === 1 ? " is" : "s are"} under-staffed and listed below — ` +
          `nobody could be placed on them. Assign them by hand.`,
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
///
/// **Where the pair already exists as a RETURNED_TO_POOL row, this reactivates
/// it rather than inserting** — PRD decision 39. `current` below reads only
/// ACTIVE rows, so before Phase 3 this fell through to a `create` that violated
/// `UNIQUE (round, applicantId, reviewerId)` and surfaced as a raw database
/// error. It was unreachable until FR-9's return-to-pool existed to create such
/// a row, which is why it survived Phase 2's walkthrough. Same shape as decision
/// 28's re-claim, and the same reasoning: a deliberate person overriding a
/// recusal is not generation re-pairing them.
export async function assignReviewer(
  instanceId: string,
  round: Round,
  applicantId: string,
  reviewerId: string,
): Promise<ActionState> {
  const session = await requireInstance(instanceId, path(instanceId));

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

  // Any row found here is RETURNED_TO_POOL: an ACTIVE one would have refused
  // above as already on the applicant.
  const returned = await prisma.assignment.findUnique({
    where: { round_applicantId_reviewerId: { round, applicantId, reviewerId } },
    select: { id: true, returnReason: true },
  });

  await prisma.$transaction(async (tx) => {
    if (returned) {
      await tx.assignment.update({
        where: { id: returned.id },
        data: {
          status: AssignmentStatus.ACTIVE,
          origin: AssignmentOrigin.MANUAL,
          returnReason: null,
          returnNote: null,
          returnedAt: null,
        },
      });
    } else {
      await tx.assignment.create({
        data: { instanceId, round, applicantId, reviewerId, origin: AssignmentOrigin.MANUAL },
      });
    }
    await tx.auditLog.create({
      data: {
        instanceId,
        ...auditActor(session),
        action: "ASSIGN_REVIEWER",
        entityType: "Applicant",
        entityId: applicantId,
        previousValue: {
          round,
          reviewerId,
          reviewerName: `${reviewer.firstName} ${reviewer.lastName}`,
          // §8 wants the previous value, and "this reviewer had recused
          // themselves and an admin overrode it" is the part worth keeping.
          ...(returned ? { reactivatedFrom: returned.returnReason } : {}),
        },
      },
    });
  });

  revalidatePath(path(instanceId));
  return {
    message: returned
      ? `Assigned ${reviewer.firstName} ${reviewer.lastName}, who had returned this applicant.`
      : `Assigned ${reviewer.firstName} ${reviewer.lastName}.`,
  };
}

/// FR-8's third verb. One transaction, not an unassign followed by an assign.
///
/// Two round trips from the browser can half-fail — the network drops after the
/// delete — and leave the applicant a reviewer short with nothing in the log
/// saying a swap was intended. One action also gives §8 a single row answering
/// "who replaced whom", which two rows only imply.
///
/// The outgoing assignment is excluded from the one-Sparklet check: swapping one
/// Sparklet for another is legal, and comparing against a row that is about to
/// disappear would refuse it.
export async function swapReviewer(
  instanceId: string,
  round: Round,
  applicantId: string,
  outReviewerId: string,
  inReviewerId: string,
): Promise<ActionState> {
  const session = await requireInstance(instanceId, path(instanceId));

  if (outReviewerId === inReviewerId) return { error: "That is the same reviewer." };

  const [incoming, existing] = await Promise.all([
    prisma.reviewer.findFirst({
      where: { id: inReviewerId, instanceId },
      select: { id: true, firstName: true, lastName: true, isSparklet: true, rounds: true },
    }),
    prisma.assignment.findMany({
      where: { instanceId, round, applicantId, status: AssignmentStatus.ACTIVE },
      select: {
        id: true,
        reviewerId: true,
        origin: true,
        _count: { select: { scores: true } },
        reviewer: { select: { firstName: true, lastName: true, isSparklet: true } },
      },
    }),
  ]);

  const outgoing = existing.find((a) => a.reviewerId === outReviewerId);

  if (!incoming) return { error: "That reviewer no longer exists." };
  if (!outgoing) return { error: "That assignment no longer exists. Reload and try again." };
  if (!incoming.rounds.includes(round)) {
    return { error: `${incoming.firstName} ${incoming.lastName} does not serve this round.` };
  }
  if (existing.some((a) => a.reviewerId === inReviewerId)) {
    return { error: `${incoming.firstName} ${incoming.lastName} is already on this applicant.` };
  }
  if (
    incoming.isSparklet &&
    existing.some((a) => a.reviewerId !== outReviewerId && a.reviewer.isSparklet)
  ) {
    return {
      error:
        `This applicant already has a different Sparklet reviewer, and at most one Sparklet may ` +
        `review any applicant. Swap that one instead, or pick a non-Sparklet.`,
    };
  }

  // Decision 39's case again, on the other verb. FR-8 is "assign, unassign, or
  // swap" and fixing only the first of the three is the exact failure CLAUDE.md
  // names: the incoming reviewer may hold a RETURNED_TO_POOL row on this
  // applicant, and `existing` above reads only ACTIVE ones, so the create below
  // would violate the unique index.
  const incomingReturned = await prisma.assignment.findUnique({
    where: { round_applicantId_reviewerId: { round, applicantId, reviewerId: inReviewerId } },
    select: { id: true, returnReason: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        instanceId,
        ...auditActor(session),
        action: "SWAP_REVIEWER",
        entityType: "Applicant",
        entityId: applicantId,
        // Both halves in one row, so the log answers who replaced whom without
        // needing two rows correlated by timestamp.
        previousValue: {
          round,
          outReviewerId,
          outReviewerName: `${outgoing.reviewer.firstName} ${outgoing.reviewer.lastName}`,
          outOrigin: outgoing.origin,
          deletedScoreCount: outgoing._count.scores,
          inReviewerId,
          inReviewerName: `${incoming.firstName} ${incoming.lastName}`,
          ...(incomingReturned ? { inReactivatedFrom: incomingReturned.returnReason } : {}),
        },
      },
    });
    await tx.assignment.delete({ where: { id: outgoing.id } });
    if (incomingReturned) {
      await tx.assignment.update({
        where: { id: incomingReturned.id },
        data: {
          status: AssignmentStatus.ACTIVE,
          origin: AssignmentOrigin.MANUAL,
          returnReason: null,
          returnNote: null,
          returnedAt: null,
        },
      });
    } else {
      await tx.assignment.create({
        data: { instanceId, round, applicantId, reviewerId: inReviewerId, origin: AssignmentOrigin.MANUAL },
      });
    }
  });

  revalidatePath(path(instanceId));
  return {
    message:
      `Swapped ${outgoing.reviewer.firstName} ${outgoing.reviewer.lastName} for ` +
      `${incoming.firstName} ${incoming.lastName}.` +
      (outgoing._count.scores > 0
        ? ` ${outgoing._count.scores} score${outgoing._count.scores === 1 ? "" : "s"} went with the old assignment.`
        : ""),
  };
}

/// Remove one reviewer from one applicant. Audited with what it removed, per §8.
/// PRD decision 117. FR-8's fourth verb: put a reviewer's slot back in the pool
/// on their behalf, for the non-responsive reviewer the reviewer-facing control
/// was never going to be used by.
///
/// **Extends FR-9's path rather than adding a mechanism.** It writes the same
/// `RETURNED_TO_POOL` row `returnToPool` writes, so `openPoolFor` sees the
/// applicant as short a reviewer, any reviewer can claim the slot, and
/// generation treats the pair as decision 23's exclusion. A second verb with
/// the same effect and a different row shape would mean `lib/assignment.ts`
/// knowing about both, which is how two definitions of "is this slot open" come
/// to disagree.
///
/// **`unassignReviewer` below is a different verb and stays.** It *deletes* the
/// row, so generation may re-pair that reviewer with that applicant, and it
/// destroys any scores on it. That is right for "this pairing was a mistake" and
/// wrong for "this reviewer is not coming back": a return preserves the scores
/// and permanently excludes the pair, which is what a ghosting reviewer calls
/// for. The asymmetry predates this decision and was incidental; 117 is where it
/// becomes deliberate.
///
/// **Reason is always `OTHER` and the note is required**, amending decision 27.
/// A reviewer's `CONFLICT_OF_INTEREST` explains itself; an admin acting on
/// someone else's behalf has no reason category doing that work, so the note is
/// the entire record of what happened and why.
///
/// Audited, unlike the reviewer's own return: §8 logs admin overrides.
export async function returnAssignmentToPool(
  instanceId: string,
  round: Round,
  applicantId: string,
  reviewerId: string,
  note: string,
): Promise<ActionState> {
  const session = await requireInstance(instanceId, path(instanceId));

  // The same validator FR-9's control runs, so the two paths cannot disagree
  // about what a return needs. `OTHER` is fixed here rather than accepted from
  // the caller: an admin is not in a position to assert somebody else's
  // conflict of interest, and recording one as though the reviewer had declared
  // it would put words in their mouth on a row that outlives the round.
  const verdict = validateReturn(ReturnReason.OTHER, note);
  if (!verdict.ok) return { error: verdict.error };
  if (verdict.note === null) {
    return { error: "Say why this slot is going back to the pool. It is the only record of it." };
  }

  const assignment = await prisma.assignment.findFirst({
    // ACTIVE only: a row already returned is the state this produces, so
    // running it twice is a no-op rather than an overwrite that moves
    // `returnedAt` and loses when it actually happened.
    where: { instanceId, round, applicantId, reviewerId, status: AssignmentStatus.ACTIVE },
    select: {
      id: true,
      origin: true,
      _count: { select: { scores: true } },
      reviewer: { select: { firstName: true, lastName: true } },
    },
  });

  if (!assignment) {
    return { error: "That reviewer is not actively assigned to this applicant." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        instanceId,
        ...auditActor(session),
        action: "RETURN_ASSIGNMENT_TO_POOL",
        entityType: "Applicant",
        entityId: applicantId,
        previousValue: {
          round,
          reviewerId,
          origin: assignment.origin,
          // Named `keptScoreCount`, not `deletedScoreCount`. The unassign row
          // beside it in the log uses the latter, and an admin reading the two
          // together should be able to see at a glance which verb destroyed
          // work and which did not.
          keptScoreCount: assignment._count.scores,
          note: verdict.note,
        },
      },
    });
    await tx.assignment.update({
      where: { id: assignment.id },
      data: {
        status: AssignmentStatus.RETURNED_TO_POOL,
        returnReason: verdict.reason,
        returnNote: verdict.note,
        returnedAt: new Date(),
      },
    });
  });

  revalidatePath(path(instanceId));
  return {
    message:
      `${assignment.reviewer.firstName} ${assignment.reviewer.lastName}'s slot is back in the ` +
      `pool for anyone to claim.` +
      (assignment._count.scores > 0
        ? ` Their ${assignment._count.scores} score${assignment._count.scores === 1 ? "" : "s"} ` +
          `stayed.`
        : ""),
  };
}

export async function unassignReviewer(
  instanceId: string,
  round: Round,
  applicantId: string,
  reviewerId: string,
): Promise<ActionState> {
  const session = await requireInstance(instanceId, path(instanceId));

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
        ...auditActor(session),
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
