// Run a complete second round against the seed instance.
//
// Run with:  npm run seed:passes   (after npm run seed && npm run seed:advance)
//
// PRD decision 91 is why this exists and why it reverses `prisma/advance.ts`'s
// "creates no Pass rows". The short form: `seed:advance` stops exactly where an
// admin would create pass 1, so FR-19's three groups, its funnel and FR-20's
// round trip would all be developed against empty sets, and BUILD_PLAN's own
// Phase 6 record says producing the all-COI case through the UI takes twelve
// reviewer sign-ins.
//
// **Every write here is the write the corresponding FR-17 action makes.** Same
// resolution function (`lib/passes.ts`), same membership query, same `Decision`
// rows with the same actors, same `AuditLog` entries. That is the posture
// `prisma/advance.ts` takes toward `finalizeFirstRound`, and for the same
// reason: a seed whose idea of a finished round differed from the action's would
// develop every Phase 7 surface against a state the application cannot produce.
//
// Re-runnable. It resets whatever a previous run wrote before building again,
// the way `prisma/seed.ts` does, so the fixture is reproducible after the
// round-trip check has deleted and restored the instance.

import {
  ApplicantStatus,
  DecisionActor,
  DecisionOutcome,
  InstanceStage,
  PassResolution,
  PassStatus,
  Round,
} from "../generated/prisma/enums";
import {
  SECOND_ROUND_POOL,
  UNRESOLVED_AT_CLOSE,
  decisionOutcomeFor,
  isMutableResolution,
  resolveApplicant,
  resolvePass,
  statusFor,
} from "../lib/passes";
import { SEED_INSTANCE_ID, createSeedClient } from "./seed/client";
import {
  MINIMUM_POOL,
  planConflicts,
  planPassOne,
  planPassTwo,
  votesFor,
  type PassOnePlan,
  type PassTwoPlan,
} from "./seed/passes";

const prisma = createSeedClient();

/// The actions this script writes, so a reset can find and remove exactly what a
/// previous run left behind. `actor` is "admin" on all of them because that is
/// what the real actions write and a seed that claimed otherwise would
/// misrepresent who acted — which is also why the reset keys on the action name
/// rather than on the actor.
const SEEDED_AUDIT_ACTIONS = [
  "CREATE_PASS",
  "CLOSE_PASS",
  "MANUAL_REJECT_IN_PASS",
  "CLOSE_SECOND_ROUND",
];

/// Undo a previous run, so this is re-runnable against an instance that already
/// has a second round on it.
///
/// Deleting the `Pass` rows cascades `PassApplicant` and `PassVote` away. What
/// does not cascade, and so is listed explicitly, is everything the round
/// *decided*: second-round `Decision` rows, the applicant statuses those
/// decisions set, the round's conflicts, and the instance stage.
async function reset(): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.pass.deleteMany({ where: { instanceId: SEED_INSTANCE_ID } });
      await tx.conflictOfInterest.deleteMany({
        where: { round: Round.SECOND_ROUND, applicant: { instanceId: SEED_INSTANCE_ID } },
      });
      await tx.decision.deleteMany({
        where: { stage: Round.SECOND_ROUND, applicant: { instanceId: SEED_INSTANCE_ID } },
      });
      await tx.auditLog.deleteMany({
        where: { instanceId: SEED_INSTANCE_ID, action: { in: SEEDED_AUDIT_ACTIONS } },
      });

      // Everyone who reached the second round goes back to ACTIVE. Scoped by
      // `stageReached` so a written-round or first-round rejection keeps its
      // status — those decisions were made by earlier phases and are not ours
      // to undo.
      await tx.applicant.updateMany({
        where: { instanceId: SEED_INSTANCE_ID, stageReached: Round.SECOND_ROUND },
        data: { status: ApplicantStatus.ACTIVE },
      });

      await tx.instance.update({
        where: { id: SEED_INSTANCE_ID },
        data: { currentStage: InstanceStage.SECOND_ROUND },
      });
    },
    { timeout: 30000 },
  );
}

/// `createPass`, reproduced. Membership from `SECOND_ROUND_POOL` in
/// `sourceRowIndex` order, `resolvePass` run at creation so an all-COI applicant
/// carries NEEDS_ADMIN from the start (clause 17v), and the audit row.
async function createPass(ordinal: number): Promise<{ passId: string; applicantIds: string[] }> {
  const [pool, reviewers, conflicts] = await Promise.all([
    prisma.applicant.findMany({
      where: { instanceId: SEED_INSTANCE_ID, ...SECOND_ROUND_POOL },
      orderBy: { sourceRowIndex: "asc" },
      select: { id: true },
    }),
    prisma.reviewer.findMany({
      where: { instanceId: SEED_INSTANCE_ID, rounds: { has: Round.SECOND_ROUND } },
      select: { id: true },
    }),
    prisma.conflictOfInterest.findMany({
      where: { round: Round.SECOND_ROUND, applicant: { instanceId: SEED_INSTANCE_ID } },
      select: { applicantId: true, reviewerId: true },
    }),
  ]);

  const applicantIds = pool.map((applicant) => applicant.id);
  const reviewerIds = reviewers.map((reviewer) => reviewer.id);

  const resolutions = resolvePass({ reviewerIds, applicantIds, votes: [], conflicts });
  const needsAdmin = new Set(
    resolutions
      .filter((row) => row.resolution === PassResolution.NEEDS_ADMIN)
      .map((row) => row.applicantId),
  );

  const now = new Date();
  const passId = await prisma.$transaction(
    async (tx) => {
      const created = await tx.pass.create({
        data: { instanceId: SEED_INSTANCE_ID, ordinal, status: PassStatus.OPEN },
        select: { id: true },
      });

      await tx.passApplicant.createMany({
        data: applicantIds.map((applicantId) => ({
          passId: created.id,
          applicantId,
          resolution: needsAdmin.has(applicantId) ? PassResolution.NEEDS_ADMIN : null,
          resolvedAt: needsAdmin.has(applicantId) ? now : null,
        })),
      });

      await tx.auditLog.create({
        data: {
          instanceId: SEED_INSTANCE_ID,
          actor: "admin",
          action: "CREATE_PASS",
          entityType: "Pass",
          entityId: created.id,
          previousValue: {
            ordinal,
            memberCount: applicantIds.length,
            reviewerCount: reviewerIds.length,
            conflicts: conflicts.length,
            needsAdminAtCreation: needsAdmin.size,
          },
        },
      });

      return created.id;
    },
    { timeout: 30000 },
  );

  return { passId, applicantIds };
}

/// `submitPassVote`, reproduced — including the recompute-and-persist inside the
/// same transaction as the write that changed it.
async function castVote(
  passId: string,
  applicantId: string,
  reviewerId: string,
  value: "YES" | "NO",
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.passVote.upsert({
      where: { passId_applicantId_reviewerId: { passId, applicantId, reviewerId } },
      create: { passId, applicantId, reviewerId, value },
      update: { value },
    });

    const [roster, votes, conflicts, current] = await Promise.all([
      tx.reviewer.findMany({
        where: { instanceId: SEED_INSTANCE_ID, rounds: { has: Round.SECOND_ROUND } },
        select: { id: true },
      }),
      tx.passVote.findMany({
        where: { passId, applicantId },
        select: { applicantId: true, reviewerId: true, value: true },
      }),
      tx.conflictOfInterest.findMany({
        where: { round: Round.SECOND_ROUND, applicantId },
        select: { applicantId: true, reviewerId: true },
      }),
      tx.passApplicant.findUnique({
        where: { passId_applicantId: { passId, applicantId } },
        select: { resolution: true },
      }),
    ]);

    const { resolution } = resolveApplicant(applicantId, {
      reviewerIds: roster.map((entry) => entry.id),
      applicantIds: [applicantId],
      votes,
      conflicts,
    });

    if (!isMutableResolution(current?.resolution ?? null)) return;

    await tx.passApplicant.update({
      where: { passId_applicantId: { passId, applicantId } },
      data: { resolution, resolvedAt: resolution === null ? null : new Date() },
    });

    const status = statusFor(resolution);
    if (status !== null) {
      await tx.applicant.update({ where: { id: applicantId }, data: { status } });
    }

    const outcome = decisionOutcomeFor(resolution);
    if (outcome !== null) {
      await tx.decision.upsert({
        where: { applicantId_stage: { applicantId, stage: Round.SECOND_ROUND } },
        create: { applicantId, stage: Round.SECOND_ROUND, outcome, actor: DecisionActor.SYSTEM },
        update: { outcome, actor: DecisionActor.SYSTEM },
      });
    }
  });
}

/// `manuallyReject`, reproduced. `actor = ADMIN` per decision 69, because a
/// person did this rather than a tally.
async function manuallyReject(passId: string, ordinal: number, applicantId: string): Promise<void> {
  const membership = await prisma.passApplicant.findUnique({
    where: { passId_applicantId: { passId, applicantId } },
    select: { resolution: true, applicant: { select: { status: true } } },
  });
  if (!membership) throw new Error(`Applicant ${applicantId} is not in pass ${ordinal}.`);

  await prisma.$transaction(async (tx) => {
    await tx.passApplicant.update({
      where: { passId_applicantId: { passId, applicantId } },
      data: { resolution: PassResolution.REJECTED, resolvedAt: new Date() },
    });
    await tx.applicant.update({
      where: { id: applicantId },
      data: { status: ApplicantStatus.REJECTED },
    });
    await tx.decision.upsert({
      where: { applicantId_stage: { applicantId, stage: Round.SECOND_ROUND } },
      create: {
        applicantId,
        stage: Round.SECOND_ROUND,
        outcome: DecisionOutcome.REJECT,
        actor: DecisionActor.ADMIN,
      },
      update: { outcome: DecisionOutcome.REJECT, actor: DecisionActor.ADMIN },
    });
    await tx.auditLog.create({
      data: {
        instanceId: SEED_INSTANCE_ID,
        actor: "admin",
        action: "MANUAL_REJECT_IN_PASS",
        entityType: "Applicant",
        entityId: applicantId,
        previousValue: {
          passId,
          ordinal,
          previousResolution: membership.resolution,
          previousStatus: membership.applicant.status,
        },
      },
    });
  });
}

/// `closePass`, reproduced. Status and `closedAt` and nothing else — decision 72
/// is emphatic that the close writes no resolution.
async function closePass(passId: string, ordinal: number): Promise<void> {
  const unresolved = await prisma.passApplicant.count({ where: { passId, resolution: null } });

  await prisma.$transaction(async (tx) => {
    await tx.pass.update({
      where: { id: passId },
      data: { status: PassStatus.CLOSED, closedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        instanceId: SEED_INSTANCE_ID,
        actor: "admin",
        action: "CLOSE_PASS",
        entityType: "Pass",
        entityId: passId,
        previousValue: { ordinal, unresolvedAtClose: unresolved },
      },
    });
  });
}

/// `closeSecondRound`, reproduced. Decision 73's `NULL` **or** `CARRIED` on the
/// final pass only, no `Decision` rows, no `Applicant.status` writes (17u).
async function closeSecondRound(finalPassId: string, ordinal: number): Promise<number> {
  const unresolved = await prisma.passApplicant.count({
    where: { passId: finalPassId, ...UNRESOLVED_AT_CLOSE },
  });

  await prisma.$transaction(async (tx) => {
    const finalPass = await tx.pass.findUnique({
      where: { id: finalPassId },
      select: { status: true },
    });
    if (finalPass?.status === PassStatus.OPEN) {
      await tx.pass.update({
        where: { id: finalPassId },
        data: { status: PassStatus.CLOSED, closedAt: new Date() },
      });
    }

    await tx.passApplicant.updateMany({
      where: { passId: finalPassId, ...UNRESOLVED_AT_CLOSE },
      data: { resolution: PassResolution.NEEDS_ADMIN, resolvedAt: new Date() },
    });

    await tx.instance.update({
      where: { id: SEED_INSTANCE_ID },
      data: { currentStage: InstanceStage.COMPLETE },
    });

    await tx.auditLog.create({
      data: {
        instanceId: SEED_INSTANCE_ID,
        actor: "admin",
        action: "CLOSE_SECOND_ROUND",
        entityType: "Instance",
        entityId: SEED_INSTANCE_ID,
        previousValue: {
          previousInstanceStage: InstanceStage.SECOND_ROUND,
          finalPassOrdinal: ordinal,
          finalPassWasOpen: finalPass?.status === PassStatus.OPEN,
          markedNeedsAdmin: unresolved,
        },
      },
    });
  });

  return unresolved;
}

async function runPass<T extends PassOnePlan | PassTwoPlan>(
  passId: string,
  plan: readonly T[],
  reviewerIds: readonly string[],
  conflictsByApplicant: Map<string, string[]>,
): Promise<void> {
  for (const entry of plan) {
    const recused = conflictsByApplicant.get(entry.applicantId) ?? [];
    for (const vote of votesFor(entry.applicantId, entry.role, reviewerIds, recused)) {
      await castVote(passId, vote.applicantId, vote.reviewerId, vote.value);
    }
  }
}

async function main() {
  const instance = await prisma.instance.findUnique({
    where: { id: SEED_INSTANCE_ID },
    select: { id: true, name: true, currentStage: true },
  });
  if (!instance) {
    throw new Error("No seed instance found. Run `npm run seed && npm run seed:advance` first.");
  }
  if (instance.currentStage === InstanceStage.WRITTEN || instance.currentStage === InstanceStage.FIRST_ROUND) {
    throw new Error(
      `The seed instance is at ${instance.currentStage}. Run \`npm run seed:advance\` first — ` +
        `this script starts where an admin would create pass 1.`,
    );
  }

  await reset();

  const reviewers = await prisma.reviewer.findMany({
    where: { instanceId: SEED_INSTANCE_ID, rounds: { has: Round.SECOND_ROUND } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const reviewerIds = reviewers.map((reviewer) => reviewer.id);
  if (reviewerIds.length === 0) {
    throw new Error("No second-round reviewers. Decision 79 blocks pass creation without them.");
  }

  const pool = await prisma.applicant.findMany({
    where: { instanceId: SEED_INSTANCE_ID, ...SECOND_ROUND_POOL },
    orderBy: { sourceRowIndex: "asc" },
    select: { id: true },
  });

  const passOnePlan = planPassOne(pool.map((applicant) => applicant.id));

  // Conflicts first, before any pass exists — round-scoped and sticky, exactly
  // as a reviewer flagging from the FR-16 list produces them.
  const conflicts = planConflicts(passOnePlan, reviewerIds);
  await prisma.conflictOfInterest.createMany({
    data: conflicts.map((conflict) => ({ ...conflict, round: Round.SECOND_ROUND })),
  });

  const conflictsByApplicant = new Map<string, string[]>();
  for (const conflict of conflicts) {
    const existing = conflictsByApplicant.get(conflict.applicantId) ?? [];
    existing.push(conflict.reviewerId);
    conflictsByApplicant.set(conflict.applicantId, existing);
  }

  // --- Pass 1 ---------------------------------------------------------------
  const passOne = await createPass(1);
  await runPass(passOne.passId, passOnePlan, reviewerIds, conflictsByApplicant);

  for (const entry of passOnePlan) {
    if (entry.role === "ADMIN_REJECT") {
      await manuallyReject(passOne.passId, 1, entry.applicantId);
    }
  }

  await closePass(passOne.passId, 1);

  // --- Pass 2 ---------------------------------------------------------------
  //
  // Membership is recomputed from `Applicant.status` inside `createPass`, never
  // from pass 1's resolutions — clause 17o, and the reason a NEEDS_ADMIN
  // applicant from pass 1 appears here.
  const passTwo = await createPass(2);
  // Who has no eligible reviewer left — the all-COI applicant that clause 17v
  // carries into this pass. Handing them a resolving role would waste it, and
  // the pass would produce no SPARKLET.
  const unvotable = new Set(
    passTwo.applicantIds.filter(
      (applicantId) => (conflictsByApplicant.get(applicantId) ?? []).length >= reviewerIds.length,
    ),
  );
  const passTwoPlan = planPassTwo(passTwo.applicantIds, unvotable);
  await runPass(passTwo.passId, passTwoPlan, reviewerIds, conflictsByApplicant);

  const markedNeedsAdmin = await closeSecondRound(passTwo.passId, 2);

  // --- What actually landed -------------------------------------------------
  //
  // Counted from the database rather than from the plan, so the summary
  // describes what was written rather than what was intended. Same posture as
  // prisma/advance.ts.
  const passes = await prisma.pass.findMany({
    where: { instanceId: SEED_INSTANCE_ID },
    orderBy: { ordinal: "asc" },
    select: { id: true, ordinal: true, status: true },
  });

  console.log("");
  console.log(`Second round complete on "${instance.name}"`);
  console.log(`  reviewers            ${reviewerIds.length}`);
  console.log(`  pool at pass 1       ${pool.length} (fixture needs ${MINIMUM_POOL})`);
  console.log(`  conflicts flagged    ${conflicts.length}`);

  for (const pass of passes) {
    const grouped = await prisma.passApplicant.groupBy({
      by: ["resolution"],
      where: { passId: pass.id },
      _count: true,
    });
    const shown = grouped
      .map((row) => `${row.resolution ?? "null"} ${row._count}`)
      .sort()
      .join(", ");
    const votes = await prisma.passVote.count({ where: { passId: pass.id } });
    console.log(`  pass ${pass.ordinal} (${pass.status})    ${shown} · ${votes} votes`);
  }

  const [sparklets, rejected, active, decisions] = await Promise.all([
    prisma.applicant.count({
      where: { instanceId: SEED_INSTANCE_ID, status: ApplicantStatus.SPARKLET },
    }),
    prisma.applicant.count({
      where: {
        instanceId: SEED_INSTANCE_ID,
        status: ApplicantStatus.REJECTED,
        stageReached: Round.SECOND_ROUND,
      },
    }),
    prisma.applicant.count({
      where: { instanceId: SEED_INSTANCE_ID, ...SECOND_ROUND_POOL, stageReached: Round.SECOND_ROUND },
    }),
    prisma.decision.groupBy({
      by: ["actor"],
      where: { stage: Round.SECOND_ROUND, applicant: { instanceId: SEED_INSTANCE_ID } },
      _count: true,
    }),
  ]);

  console.log(`  marked NEEDS_ADMIN   ${markedNeedsAdmin} at close`);
  console.log(`  New Sparklets        ${sparklets}`);
  console.log(`  Rejected in round 2  ${rejected}`);
  console.log(`  still ACTIVE         ${active} — FR-19's Unresolved group, found by the pass row`);
  console.log(
    `  Decision rows        ${decisions.map((row) => `${row.actor} ${row._count}`).join(", ")}`,
  );
  console.log("");
  console.log(`  Next: /instances/${SEED_INSTANCE_ID}/passes`);
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
