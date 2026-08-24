// Scratch verification for Phase 6, Slice 6: does the one-open-pass index bite,
// and is it actually partial?
//
// Run with:  npx tsx prisma/checks/passes.ts
//
// The duplicate insert goes through raw SQL rather than the Prisma client on
// purpose, for the reason prisma/checks/unique-constraints.ts states: Prisma can
// reject a duplicate client-side and return P2002 without the statement ever
// reaching the server, which would prove nothing about the database. The pass
// condition is SQLSTATE 23505 (unique_violation) naming the expected index.
//
// **The third check is the one that earns its keep.** A TOTAL unique index on
// "instanceId" would reject the duplicate OPEN pass exactly as the partial one
// does, so rejecting the duplicate proves only that *an* index exists. Inserting
// a CLOSED pass beside the OPEN one and requiring it to be ACCEPTED is what
// distinguishes the constraint we wrote from the one we did not want — a total
// index would make a second pass impossible for the rest of the cycle, and every
// other check here would still be green.
//
// Everything this script creates, it deletes, and it verifies that it did.

import { SEED_INSTANCE_ID, createSeedClient } from "../seed/client";

const prisma = createSeedClient();

const ONE_OPEN_INDEX = "Pass_one_open_per_instance";

// Ordinals well clear of any real pass, and distinct from each other so that
// Pass_instanceId_ordinal_key cannot be what fires on the duplicate.
const PROBE_OPEN_ORDINAL = 9001;
const PROBE_DUPLICATE_ORDINAL = 9002;
const PROBE_CLOSED_ORDINAL = 9003;

const PROBE_OPEN_ID = "check_pass_open_collider";
const PROBE_DUPLICATE_ID = "check_pass_open_duplicate";
const PROBE_CLOSED_ID = "check_pass_closed_beside_open";
const ALL_PROBE_IDS = [PROBE_OPEN_ID, PROBE_DUPLICATE_ID, PROBE_CLOSED_ID];

const createdPassIds: string[] = [];

let failures = 0;

function pass(label: string, detail: string) {
  console.log(`PASS  ${label}\n        ${detail}`);
}

function fail(label: string, detail: string) {
  failures += 1;
  console.log(`FAIL  ${label}\n        ${detail}`);
}

/// Postgres reports a unique violation as SQLSTATE 23505. Prisma wraps raw-query
/// errors, so look for the code and the index name wherever they surface.
function uniqueViolation(error: unknown, expectedIndex: string): string | null {
  const meta = (error as { meta?: Record<string, unknown> }).meta ?? {};
  const text = `${(error as Error).message ?? ""} ${JSON.stringify(meta)}`;

  if (!text.includes("23505")) return null;
  if (!text.includes(expectedIndex)) {
    return `23505 raised, but by a different index than ${expectedIndex}`;
  }
  return `Postgres raised 23505 (unique_violation) on ${expectedIndex}`;
}

async function expectRejection(
  label: string,
  expectedIndex: string,
  insert: () => Promise<unknown>,
) {
  try {
    await insert();
    fail(label, "the duplicate INSERT was ACCEPTED — the constraint is not enforced");
  } catch (error) {
    const detail = uniqueViolation(error, expectedIndex);
    if (detail) {
      pass(label, detail);
    } else {
      fail(label, `rejected, but not with a 23505 on ${expectedIndex}: ${(error as Error).message}`);
    }
  }
}

async function expectAcceptance(label: string, detail: string, insert: () => Promise<unknown>) {
  try {
    await insert();
    pass(label, detail);
  } catch (error) {
    fail(label, `the INSERT was REJECTED: ${(error as Error).message}`);
  }
}

function insertPass(id: string, ordinal: number, status: "OPEN" | "CLOSED") {
  return status === "OPEN"
    ? prisma.$executeRaw`
        INSERT INTO "Pass" ("id", "instanceId", "ordinal", "status", "openedAt")
        VALUES (${id}, ${SEED_INSTANCE_ID}, ${ordinal}, 'OPEN'::"PassStatus", NOW())
      `
    : prisma.$executeRaw`
        INSERT INTO "Pass" ("id", "instanceId", "ordinal", "status", "openedAt", "closedAt")
        VALUES (${id}, ${SEED_INSTANCE_ID}, ${ordinal}, 'CLOSED'::"PassStatus", NOW(), NOW())
      `;
}

async function main() {
  const instance = await prisma.instance.findUnique({
    where: { id: SEED_INSTANCE_ID },
    select: { id: true, name: true, currentStage: true },
  });

  if (!instance) {
    throw new Error("No seed instance found. Run `npm run seed` first.");
  }

  const baselinePasses = await prisma.pass.count({ where: { instanceId: SEED_INSTANCE_ID } });
  const existingOpen = await prisma.pass.findFirst({
    where: { instanceId: SEED_INSTANCE_ID, status: "OPEN" },
    select: { id: true, ordinal: true },
  });

  console.log(`Instance    ${SEED_INSTANCE_ID} (${instance.name}, ${instance.currentStage})`);
  console.log(`Baseline    ${baselinePasses} pass(es)`);
  console.log("");

  // --- 1. A collider ---------------------------------------------------------
  // If the instance already has an OPEN pass — somebody clicked through one —
  // use it rather than creating a second, which is the very thing under test.
  // Same posture unique-constraints.ts takes with an existing applicant.
  if (existingOpen) {
    console.log(
      `Setup       using existing OPEN pass ${existingOpen.id} (ordinal ${existingOpen.ordinal})`,
    );
  } else {
    await expectAcceptance(
      "An OPEN pass may be created when none is open",
      `inserted ${PROBE_OPEN_ID} at ordinal ${PROBE_OPEN_ORDINAL}`,
      async () => {
        await insertPass(PROBE_OPEN_ID, PROBE_OPEN_ORDINAL, "OPEN");
        createdPassIds.push(PROBE_OPEN_ID);
      },
    );
  }
  console.log("");

  // --- 2. The index bites ----------------------------------------------------
  await expectRejection("A second OPEN pass on one instance", ONE_OPEN_INDEX, async () => {
    await insertPass(PROBE_DUPLICATE_ID, PROBE_DUPLICATE_ORDINAL, "OPEN");
    // Only reached if the constraint did NOT fire, in which case the row is real
    // and has to be cleaned up.
    createdPassIds.push(PROBE_DUPLICATE_ID);
  });

  // --- 3. The index is PARTIAL, not total ------------------------------------
  await expectAcceptance(
    "A CLOSED pass alongside an OPEN one",
    "accepted — the index is partial, so closed passes do not collide",
    async () => {
      await insertPass(PROBE_CLOSED_ID, PROBE_CLOSED_ORDINAL, "CLOSED");
      createdPassIds.push(PROBE_CLOSED_ID);
    },
  );

  // --- 4. Decision 68's invariant, over whatever is in the database ----------
  // Flagging a conflict deletes any vote that reviewer had already cast. This
  // creates nothing and asserts over real rows, so it is free to run now (when
  // there are none) and is the assertion that matters after Slice 12's gate
  // walk-through has actually flagged a COI on top of a vote.
  const coexisting = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM "PassVote" v
      JOIN "ConflictOfInterest" c
        ON c."applicantId" = v."applicantId"
       AND c."reviewerId" = v."reviewerId"
     WHERE c."round" = 'SECOND_ROUND'::"Round"
  `;
  const coexistingCount = coexisting[0]?.n ?? 0;
  if (coexistingCount === 0) {
    pass(
      "Decision 68: no PassVote survives behind a COI",
      "no (applicantId, reviewerId) has both a second-round conflict and a stored vote",
    );
  } else {
    fail(
      "Decision 68: no PassVote survives behind a COI",
      `${coexistingCount} vote row(s) coexist with a second-round conflict — the flag did not delete them`,
    );
  }
}

async function cleanup() {
  console.log("");
  if (createdPassIds.length > 0) {
    const { count } = await prisma.pass.deleteMany({ where: { id: { in: createdPassIds } } });
    console.log(`Cleanup     deleted ${count} pass(es): ${createdPassIds.join(", ")}`);
  } else {
    console.log("Cleanup     nothing to remove");
  }
}

async function confirmRestored() {
  const leftover = await prisma.pass.count({ where: { id: { in: ALL_PROBE_IDS } } });

  if (leftover === 0) {
    console.log("Cleanup     verified — no probe rows remain");
  } else {
    failures += 1;
    console.log(`Cleanup     FAILED — ${leftover} probe pass(es) remain`);
  }
}

main()
  .catch((error) => {
    failures += 1;
    console.error("\nUnexpected error:", error);
  })
  .finally(async () => {
    // Cleanup runs even if main() threw partway through, so a crash cannot leave
    // probe passes behind — and a stray OPEN probe would block every real pass
    // creation from then on.
    try {
      await cleanup();
      await confirmRestored();
    } catch (error) {
      failures += 1;
      console.error("Cleanup itself failed:", error);
    }

    console.log("");
    console.log(failures === 0 ? "RESULT: all checks passed" : `RESULT: ${failures} check(s) failed`);

    process.exitCode = failures === 0 ? 0 : 1;
    await prisma.$disconnect();
  });
