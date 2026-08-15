// Scratch verification: does the row lock actually stop two reviewers taking
// the same last slot?
//
// Run with:  npx tsx prisma/checks/claim-race.ts
//
// **Why this cannot be a unit test.** The failure is two different reviewers
// passing the same eligibility check at the same instant, which no amount of
// testing `claimEligibility` over plain objects can produce — both callers are
// individually correct and the applicant still ends up with four reviewers. It
// needs two real transactions against one real Postgres.
//
// **Two obvious versions of this script prove nothing, and both were measured
// rather than reasoned about** — with a throwaway copy of the claim that omitted
// the `FOR UPDATE` and was otherwise identical.
//
//   1. *Fire two claims through `Promise.all` and assert one loses.* Passes over
//      a completely unlocked claim: the two transactions happen to serialize on
//      their own, the second reads after the first commits, and it refuses for
//      the right reason by accident.
//   2. *Hold the row lock from another connection and assert the claim blocks.*
//      Also passes over an unlocked claim, for a reason worth knowing: inserting
//      an `Assignment` takes a `FOR KEY SHARE` lock on its parent `Applicant`
//      row for the foreign key, and that conflicts with a held `FOR UPDATE` all
//      by itself. Every claim blocks. "It blocked" is necessary and proves
//      nothing.
//
// What actually separates a locked claim from an unlocked one is **when the
// eligibility read happens**, so part 1 takes the last slot away while the claim
// is waiting. A claim holding the lock reads nothing until the thief commits and
// then refuses; a claim without it has already decided it is eligible, and its
// insert lands on that stale decision and produces a fourth reviewer. Verified:
// the unlocked copy returns ok and leaves 4 against a target of 3.
//
// Part 2 keeps the end-to-end race for the state it leaves behind, not for the
// refusal — see (1).
//
// **Neither part replaces walkthrough step 6.** Both call `claimSlotWithin`
// directly, skipping HTTP, the reviewer session and Next's server-action
// dispatch — and that dispatch is sequential per client, which is exactly what
// would hide the race from a single-browser test. Two devices signed in as two
// different reviewers is still the gate; this is the pre-flight, so a broken
// lock is found before that session rather than during it.
//
// Everything this script creates, it deletes, and it verifies that it did.

import { claimSlotWithin } from "../../lib/claim-slot";
import { AssignmentOrigin, AssignmentStatus, Round } from "../../generated/prisma/enums";
import { targetFor } from "../../lib/review";
import { SEED_INSTANCE_ID, createSeedClient } from "../seed/client";

const prisma = createSeedClient();

const LOCK_APPLICANT_ID = "check_race_applicant_lock";
const RACE_APPLICANT_ID = "check_race_applicant_race";
const PROBE_APPLICANT_IDS = [LOCK_APPLICANT_ID, RACE_APPLICANT_ID];
const REVIEWER_A_ID = "check_race_reviewer_a";
const REVIEWER_B_ID = "check_race_reviewer_b";
const PROBE_REVIEWER_IDS = [REVIEWER_A_ID, REVIEWER_B_ID];

/// How long a blocked claim is given to prove it is blocked. Well above a local
/// round trip (single-digit ms) and well below the transaction timeouts below.
const BLOCK_PROOF_MS = 1500;
const TX_TIMEOUT_MS = 20_000;

let failures = 0;

function pass(label: string, detail: string) {
  console.log(`PASS  ${label}\n        ${detail}`);
}

function fail(label: string, detail: string) {
  failures += 1;
  console.log(`FAIL  ${label}\n        ${detail}`);
}

function check(label: string, condition: boolean, detail: string) {
  if (condition) pass(label, detail);
  else fail(label, detail);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function claim(applicantId: string, reviewerId: string) {
  return prisma.$transaction(
    (tx) =>
      claimSlotWithin(tx, {
        instanceId: SEED_INSTANCE_ID,
        round: Round.WRITTEN,
        applicantId,
        reviewer: { id: reviewerId, isSparklet: false },
      }),
    { timeout: TX_TIMEOUT_MS },
  );
}

async function activeOn(applicantId: string) {
  return prisma.assignment.findMany({
    where: {
      instanceId: SEED_INSTANCE_ID,
      round: Round.WRITTEN,
      applicantId,
      status: AssignmentStatus.ACTIVE,
    },
    select: { reviewerId: true, origin: true },
  });
}

async function setUp(): Promise<{ baseline: number; target: number; stealer: string }> {
  const baseline = await prisma.assignment.count({ where: { instanceId: SEED_INSTANCE_ID } });

  // Non-Sparklet on purpose: the one-Sparklet rule is a different refusal and
  // would mask the one this script is looking for.
  // One more than the fillers: part 1 needs a reviewer to take the last slot
  // out from under the waiting claim.
  const roster = await prisma.reviewer.findMany({
    where: { instanceId: SEED_INSTANCE_ID, isSparklet: false, rounds: { has: Round.WRITTEN } },
    orderBy: { id: "asc" },
    take: 3,
    select: { id: true },
  });

  if (roster.length < 3) {
    throw new Error("Need at least three non-Sparklet written reviewers. Run `npm run seed` first.");
  }

  const fillers = roster.slice(0, 2);
  const stealer = roster[2].id;

  // The racers are created rather than borrowed, so the script never has to
  // reason about assignments the seed already gave a real reviewer.
  await prisma.reviewer.create({
    data: {
      id: REVIEWER_A_ID,
      instanceId: SEED_INSTANCE_ID,
      firstName: "Race",
      lastName: "Probe A",
      isSparklet: false,
      rounds: [Round.WRITTEN],
    },
  });
  await prisma.reviewer.create({
    data: {
      id: REVIEWER_B_ID,
      instanceId: SEED_INSTANCE_ID,
      firstName: "Race",
      lastName: "Probe B",
      isSparklet: false,
      rounds: [Round.WRITTEN],
    },
  });

  await prisma.applicant.create({
    data: {
      id: LOCK_APPLICANT_ID,
      instanceId: SEED_INSTANCE_ID,
      sourceRowIndex: 9101,
      displayName: "Race Probe — lock",
      data: {},
    },
  });
  await prisma.applicant.create({
    data: {
      id: RACE_APPLICANT_ID,
      instanceId: SEED_INSTANCE_ID,
      sourceRowIndex: 9102,
      displayName: "Race Probe — race",
      data: {},
    },
  });

  // Read the way claimSlotWithin reads it, and after the fixtures exist — the
  // probe applicants and the probe reviewers all count toward it.
  const applicantCount = await prisma.applicant.count({ where: { instanceId: SEED_INSTANCE_ID } });
  const reviewerCount = await prisma.reviewer.count({
    where: { instanceId: SEED_INSTANCE_ID, rounds: { has: Round.WRITTEN } },
  });
  const target = targetFor(applicantCount, reviewerCount);

  // Both probes filled to exactly one slot short, which is the only state in
  // which a race has a loser.
  for (const applicantId of PROBE_APPLICANT_IDS) {
    for (const filler of fillers.slice(0, target - 1)) {
      await prisma.assignment.create({
        data: {
          instanceId: SEED_INSTANCE_ID,
          round: Round.WRITTEN,
          applicantId,
          reviewerId: filler.id,
          origin: AssignmentOrigin.AUTO,
        },
      });
    }
  }

  console.log(`Instance    ${SEED_INSTANCE_ID}`);
  console.log(`Target      ${target} reviewers per applicant`);
  console.log(`Baseline    ${baseline} assignments`);
  console.log(`Probes      two applicants at ${target - 1} of ${target}`);
  console.log("");

  return { baseline, target, stealer };
}

/// Part 1 — the discriminating check.
///
/// **It is not "does a claim block", and finding that out is what this comment
/// is for.** A claim blocks whether or not it takes the lock: inserting an
/// `Assignment` takes a `FOR KEY SHARE` lock on its parent `Applicant` row for
/// the foreign key, and that conflicts with a held `FOR UPDATE` all on its own.
/// Measured with a throwaway copy of the claim that omitted the lock — it
/// blocked exactly the same way. So "it blocked" is necessary and proves
/// nothing.
///
/// What separates them is **when the eligibility read happens**. The slot is
/// taken *while the claim is waiting*:
///
///   - Taking the lock, the claim reads nothing until the holder commits, sees
///     the applicant already full, and refuses.
///   - Not taking the lock, the claim has already read "2 of 3, eligible"
///     before it blocks on the foreign key. When the holder commits, its insert
///     proceeds on that stale decision and the applicant ends up with four.
///
/// That is the actual defect this lock exists to prevent, and it is
/// deterministic — no timing luck, no reliance on two transactions happening to
/// interleave.
async function checkTheLockIsTaken(target: number, stealer: string) {
  let release!: () => void;
  let held!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });

  // One connection takes the applicant's row lock, waits to be told, and then
  // takes the last slot itself before committing.
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Applicant" WHERE id = ${LOCK_APPLICANT_ID} FOR UPDATE`;
      held();
      await gate;
      await tx.assignment.create({
        data: {
          instanceId: SEED_INSTANCE_ID,
          round: Round.WRITTEN,
          applicantId: LOCK_APPLICANT_ID,
          reviewerId: stealer,
          origin: AssignmentOrigin.MANUAL,
        },
      });
    },
    { timeout: TX_TIMEOUT_MS },
  );

  await holding;

  const claiming = claim(LOCK_APPLICANT_ID, REVIEWER_A_ID);
  // Swallowed so a claim that throws rather than waiting cannot become an
  // unhandled rejection before the assertion below reads it.
  const settled = claiming.then(
    () => "completed" as const,
    () => "threw" as const,
  );

  // Necessary but not sufficient — see the note above. Kept because a claim that
  // sailed straight through would be wrong for a different reason.
  const waited = await Promise.race([settled, sleep(BLOCK_PROOF_MS).then(() => "blocked" as const)]);
  check(
    "a claim cannot proceed while the applicant's row is locked",
    waited === "blocked",
    waited === "blocked"
      ? `still waiting after ${BLOCK_PROOF_MS} ms`
      : `the claim ${waited} while the row was locked`,
  );

  release();
  await holder;

  const result = await claiming;

  check(
    "a claim refuses when the slot is taken while it waits",
    !result.ok && result.reason === "NO_OPEN_SLOTS",
    result.ok
      ? "it claimed anyway — the eligibility read happened BEFORE the lock, which is the stale-read bug"
      : `refused with ${result.reason}`,
  );

  const after = await activeOn(LOCK_APPLICANT_ID);
  check(
    "and the applicant is not left one reviewer over target",
    after.length === target,
    `${after.length} ACTIVE assignment(s) against a target of ${target}`,
  );
}

/// Part 2 — the end-to-end race. Weaker on its own (see the header) and kept for
/// the state it leaves behind rather than for the refusal.
async function checkTheRaceLeavesOneWinner(target: number) {
  const [a, b] = await Promise.all([
    claim(RACE_APPLICANT_ID, REVIEWER_A_ID),
    claim(RACE_APPLICANT_ID, REVIEWER_B_ID),
  ]);

  const winners = [a, b].filter((outcome) => outcome.ok);
  const losers = [a, b].filter((outcome) => !outcome.ok);

  check(
    "exactly one of two simultaneous claims wins",
    winners.length === 1,
    `A: ${JSON.stringify(a)}  B: ${JSON.stringify(b)}`,
  );

  check(
    "the loser is told the slot has gone",
    losers.length === 1 && !losers[0].ok && losers[0].reason === "NO_OPEN_SLOTS",
    losers.length === 1 && !losers[0].ok ? `refused with ${losers[0].reason}` : "no single loser",
  );

  const active = await activeOn(RACE_APPLICANT_ID);

  check(
    "the applicant ends at the target, not one over",
    active.length === target,
    `${active.length} ACTIVE assignment(s) against a target of ${target}`,
  );

  const claimed = active.filter((row) => row.origin === AssignmentOrigin.CLAIMED_FROM_POOL);
  check(
    "the winning row is marked CLAIMED_FROM_POOL",
    claimed.length === 1,
    `${claimed.length} row(s) with origin CLAIMED_FROM_POOL`,
  );

  const racers = active.filter((row) => PROBE_REVIEWER_IDS.includes(row.reviewerId));
  check(
    "only one of the two racers holds a slot",
    racers.length === 1,
    `${racers.length} probe reviewer(s) on the applicant`,
  );
}

async function cleanup() {
  console.log("");

  // Assignments explicitly, even though deleting the applicant would cascade
  // them: a cleanup that leans on a cascade cannot report what it removed.
  const { count: assignments } = await prisma.assignment.deleteMany({
    where: { applicantId: { in: PROBE_APPLICANT_IDS } },
  });
  const { count: applicants } = await prisma.applicant.deleteMany({
    where: { id: { in: PROBE_APPLICANT_IDS } },
  });
  const { count: reviewers } = await prisma.reviewer.deleteMany({
    where: { id: { in: PROBE_REVIEWER_IDS } },
  });

  console.log(
    `Cleanup     deleted ${assignments} assignment(s), ${applicants} applicant(s), ${reviewers} reviewer(s)`,
  );
}

async function confirmRestored(baseline: number | undefined) {
  const leftoverApplicants = await prisma.applicant.count({
    where: { id: { in: PROBE_APPLICANT_IDS } },
  });
  const leftoverReviewers = await prisma.reviewer.count({
    where: { id: { in: PROBE_REVIEWER_IDS } },
  });

  if (leftoverApplicants === 0 && leftoverReviewers === 0) {
    console.log("Cleanup     verified — no probe rows remain");
  } else {
    failures += 1;
    console.log(
      `Cleanup     FAILED — ${leftoverApplicants} applicant(s) and ${leftoverReviewers} reviewer(s) remain`,
    );
  }

  // The seed's own assignments must be exactly as they were. A probe that
  // quietly consumed one of them would otherwise look like a pass.
  const assignments = await prisma.assignment.count({ where: { instanceId: SEED_INSTANCE_ID } });
  if (baseline === undefined) return;

  if (assignments === baseline) {
    console.log(`Cleanup     assignment count back at ${baseline}`);
  } else {
    failures += 1;
    console.log(`Cleanup     FAILED — assignment count moved from ${baseline} to ${assignments}`);
  }
}

let baseline: number | undefined;

setUp()
  .then(async ({ baseline: value, target, stealer }) => {
    baseline = value;
    await checkTheLockIsTaken(target, stealer);
    console.log("");
    await checkTheRaceLeavesOneWinner(target);
  })
  .catch((error) => {
    failures += 1;
    console.error("\nUnexpected error:", error);
  })
  .finally(async () => {
    try {
      await cleanup();
      await confirmRestored(baseline);
    } catch (error) {
      failures += 1;
      console.error("Cleanup itself failed:", error);
    }

    console.log("");
    console.log(failures === 0 ? "RESULT: all checks passed" : `RESULT: ${failures} check(s) failed`);
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
