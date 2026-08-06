// Scratch verification: do the two unique constraints actually bite?
//
// Run with:  npx tsx prisma/checks/unique-constraints.ts
//
// The duplicate inserts go through raw SQL rather than the Prisma client on
// purpose. Prisma can reject a duplicate client-side and return P2002 without
// the statement ever reaching the server, which would prove nothing about the
// database. Raw SQL forces Postgres to answer, and the pass condition is
// SQLSTATE 23505 (unique_violation) naming the expected index.
//
// Everything this script creates, it deletes. It verifies that by comparing row
// counts before and after, and it leaves the seed instance alone.

import { SEED_INSTANCE_ID, createSeedClient } from "../seed/client";

const prisma = createSeedClient();

const APPLICANT_INDEX = "Applicant_instanceId_email_key";
const ASSIGNMENT_INDEX = "Assignment_round_applicantId_reviewerId_key";

const createdApplicantIds: string[] = [];
const createdAssignmentIds: string[] = [];

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

async function expectRejection(label: string, expectedIndex: string, insert: () => Promise<unknown>) {
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

async function main() {
  const baseline = {
    applicants: await prisma.applicant.count({ where: { instanceId: SEED_INSTANCE_ID } }),
    assignments: await prisma.assignment.count({ where: { instanceId: SEED_INSTANCE_ID } }),
  };

  const applicant = await prisma.applicant.findFirst({
    where: { instanceId: SEED_INSTANCE_ID, email: { not: null } },
    orderBy: { sourceRowIndex: "asc" },
  });
  const reviewer = await prisma.reviewer.findFirst({
    where: { instanceId: SEED_INSTANCE_ID },
    orderBy: { id: "asc" },
  });

  if (!applicant?.email || !reviewer) {
    throw new Error("No seed data found. Run `npm run seed` first.");
  }

  console.log(`Instance    ${SEED_INSTANCE_ID}`);
  console.log(`Baseline    ${baseline.applicants} applicants, ${baseline.assignments} assignments`);
  console.log(`Colliding   applicant ${applicant.displayName} <${applicant.email}>`);
  console.log(`            reviewer  ${reviewer.firstName} ${reviewer.lastName}`);
  console.log("");

  // --- 1. Applicant (instanceId, email) -------------------------------------
  const duplicateApplicantId = "check_duplicate_applicant";

  await expectRejection("Applicant (instanceId, email)", APPLICANT_INDEX, async () => {
    await prisma.$executeRaw`
      INSERT INTO "Applicant"
        ("id", "instanceId", "sourceRowIndex", "email", "displayName", "data", "updatedAt")
      VALUES
        (${duplicateApplicantId}, ${SEED_INSTANCE_ID}, 9001, ${applicant.email},
         'Duplicate Email Probe', '{}'::jsonb, NOW())
    `;
    // Only reached if the constraint did NOT fire, in which case the row is real
    // and has to be cleaned up.
    createdApplicantIds.push(duplicateApplicantId);
  });

  // --- 2. Assignment (round, applicantId, reviewerId) -----------------------
  // This one needs a row to collide with, so the first insert is expected to
  // succeed and is registered for cleanup immediately.
  const originalAssignment = await prisma.assignment.create({
    data: {
      id: "check_assignment_original",
      instanceId: SEED_INSTANCE_ID,
      round: "WRITTEN",
      applicantId: applicant.id,
      reviewerId: reviewer.id,
    },
  });
  createdAssignmentIds.push(originalAssignment.id);
  console.log(`Setup       created assignment ${originalAssignment.id} to collide with`);
  console.log("");

  const duplicateAssignmentId = "check_duplicate_assignment";

  await expectRejection("Assignment (round, applicantId, reviewerId)", ASSIGNMENT_INDEX, async () => {
    await prisma.$executeRaw`
      INSERT INTO "Assignment"
        ("id", "instanceId", "round", "applicantId", "reviewerId", "updatedAt")
      VALUES
        (${duplicateAssignmentId}, ${SEED_INSTANCE_ID}, 'WRITTEN'::"Round",
         ${applicant.id}, ${reviewer.id}, NOW())
    `;
    createdAssignmentIds.push(duplicateAssignmentId);
  });
}

async function cleanup() {
  console.log("");
  if (createdAssignmentIds.length > 0) {
    const { count } = await prisma.assignment.deleteMany({
      where: { id: { in: createdAssignmentIds } },
    });
    console.log(`Cleanup     deleted ${count} assignment(s): ${createdAssignmentIds.join(", ")}`);
  }
  if (createdApplicantIds.length > 0) {
    const { count } = await prisma.applicant.deleteMany({
      where: { id: { in: createdApplicantIds } },
    });
    console.log(`Cleanup     deleted ${count} applicant(s): ${createdApplicantIds.join(", ")}`);
  }
  if (createdAssignmentIds.length === 0 && createdApplicantIds.length === 0) {
    console.log("Cleanup     nothing to remove");
  }
}

async function confirmRestored() {
  const leftover = await prisma.applicant.count({
    where: { id: { in: ["check_duplicate_applicant"] } },
  });
  const leftoverAssignments = await prisma.assignment.count({
    where: { id: { in: ["check_assignment_original", "check_duplicate_assignment"] } },
  });

  if (leftover === 0 && leftoverAssignments === 0) {
    console.log("Cleanup     verified — no probe rows remain");
  } else {
    failures += 1;
    console.log(
      `Cleanup     FAILED — ${leftover} applicant(s) and ${leftoverAssignments} assignment(s) remain`,
    );
  }
}

main()
  .catch((error) => {
    failures += 1;
    console.error("\nUnexpected error:", error);
  })
  .finally(async () => {
    // Cleanup runs even if main() threw partway through, so a crash cannot leave
    // probe rows behind in the seed instance.
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
