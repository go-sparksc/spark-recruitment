// Scratch verification: does a rubric edit preserve InterviewCategory ids, and
// does the reorder survive a non-deferrable unique index?
//
// Run with:  npx tsx prisma/checks/interview-rubric-identity.ts
//
// WHY THIS SCRIPT EXISTS. PRD decision 61 turns on ids surviving a save, and
// that is not observable from the UI until an FR-12 sheet is already staged
// against them — which is exactly how the regression it fixes was found, by the
// owner clicking through after correcting a typo. `planInterviewRubricSave` is
// unit-tested in lib/rubric.test.ts, but the part that can only fail against a
// real database is the ordinal handling: `@@unique([instanceId, ordinal])` is
// NOT deferrable, so writing final positions row by row collides the instant two
// categories swap places. The parking pass exists for that, and this is the only
// thing in the repo that will notice if it stops working.
//
// WHAT IT DOES AND DOES NOT PROVE. It imports the real planner and issues the
// same three statements the save action issues, so it proves the plan and the
// statement sequence. It does NOT prove the action is wired to them correctly —
// only clicking through does that. If the action's transaction changes, change
// this too; the duplication is deliberate and small, and the alternative was
// exporting a writer from a "use server" module, which would make it a callable
// server action taking arbitrary arguments from any client.
//
// Everything it creates lives under a throwaway instance, which it deletes.

import { planInterviewRubricSave, type InterviewCategoryInput } from "../../lib/rubric";
import { createSeedClient } from "../seed/client";

const prisma = createSeedClient();

const PROBE_INSTANCE = "check_interview_rubric_identity";

let failures = 0;

function pass(label: string, detail: string) {
  console.log(`PASS  ${label}\n        ${detail}`);
}

function fail(label: string, detail: string) {
  failures += 1;
  console.log(`FAIL  ${label}\n        ${detail}`);
}

/// The same three statements `saveInterviewRubric` issues, in the same order.
async function applyPlan(instanceId: string, incoming: InterviewCategoryInput[]) {
  const existing = await prisma.interviewCategory.findMany({
    where: { instanceId },
    orderBy: { ordinal: "asc" },
    select: { id: true },
  });

  const plan = planInterviewRubricSave(
    existing.map((c) => c.id),
    incoming,
  );

  await prisma.$transaction(async (tx) => {
    if (plan.deleteIds.length > 0) {
      await tx.interviewCategory.deleteMany({ where: { id: { in: plan.deleteIds } } });
    }
    if (plan.updates.length > 0) {
      await tx.$executeRaw`
        UPDATE "InterviewCategory" SET "ordinal" = -"ordinal" - 1 WHERE "instanceId" = ${instanceId}
      `;
      for (const update of plan.updates) {
        await tx.interviewCategory.update({
          where: { id: update.id },
          data: { name: update.name, maxPoints: update.maxPoints, ordinal: update.ordinal },
        });
      }
    }
    if (plan.creates.length > 0) {
      await tx.interviewCategory.createMany({
        data: plan.creates.map((c) => ({ ...c, instanceId })),
      });
    }
  });

  return prisma.interviewCategory.findMany({
    where: { instanceId },
    orderBy: { ordinal: "asc" },
    select: { id: true, name: true, ordinal: true, maxPoints: true },
  });
}

async function main() {
  await prisma.instance.deleteMany({ where: { id: PROBE_INSTANCE } });
  await prisma.instance.create({
    data: {
      id: PROBE_INSTANCE,
      name: "Interview rubric identity probe",
      // Never a real credential: this instance exists for the length of this
      // script and is deleted below.
      passwordHash: "probe-not-a-real-hash",
    },
  });

  // --- Set up the S26 shape ------------------------------------------------
  const initial = await applyPlan(PROBE_INSTANCE, [
    { name: "Communication", maxPoints: 4 },
    { name: "Motiviation", maxPoints: 4 },
    { name: "Culture Fit", maxPoints: 4 },
    { name: "Problem Solving", maxPoints: 4 },
  ]);
  const originalIds = initial.map((c) => c.id);
  console.log(`Setup       4 categories created\n`);

  // --- 1. The regression: fixing one typo must not move any id -------------
  const renamed = await applyPlan(
    PROBE_INSTANCE,
    initial.map((c) => ({
      id: c.id,
      name: c.name === "Motiviation" ? "Motivation" : c.name,
      maxPoints: c.maxPoints,
    })),
  );

  if (renamed.map((c) => c.id).join() === originalIds.join()) {
    pass(
      "A typo fix preserves every id",
      `all 4 ids unchanged, and "${renamed[1].name}" is now spelled correctly`,
    );
  } else {
    fail("A typo fix preserves every id", "ids moved — a staged FR-12 mapping would be invalidated");
  }

  // --- 2. Reorder, which is what the parking pass exists for ---------------
  const reordered = await applyPlan(PROBE_INSTANCE, [
    { id: renamed[3].id, name: renamed[3].name, maxPoints: 4 },
    { id: renamed[0].id, name: renamed[0].name, maxPoints: 4 },
    { id: renamed[1].id, name: renamed[1].name, maxPoints: 4 },
    { id: renamed[2].id, name: renamed[2].name, maxPoints: 4 },
  ]);

  const ordinalsCorrect = reordered.every((c, index) => c.ordinal === index);
  const orderCorrect =
    reordered.map((c) => c.id).join() ===
    [renamed[3].id, renamed[0].id, renamed[1].id, renamed[2].id].join();

  if (ordinalsCorrect && orderCorrect) {
    pass(
      "A full reorder survives the non-deferrable unique index",
      "ordinals 0..3 rewritten with no 23505, ids intact — the parking pass works",
    );
  } else {
    fail(
      "A full reorder survives the non-deferrable unique index",
      `ordinals ${reordered.map((c) => c.ordinal).join(",")}, order ${orderCorrect ? "ok" : "wrong"}`,
    );
  }

  // --- 3. A swap of two adjacent rows, the tightest collision case ---------
  const swapped = await applyPlan(PROBE_INSTANCE, [
    { id: reordered[1].id, name: reordered[1].name, maxPoints: 4 },
    { id: reordered[0].id, name: reordered[0].name, maxPoints: 4 },
    { id: reordered[2].id, name: reordered[2].name, maxPoints: 4 },
    { id: reordered[3].id, name: reordered[3].name, maxPoints: 4 },
  ]);

  if (swapped[0].id === reordered[1].id && swapped[1].id === reordered[0].id) {
    pass("Two adjacent categories swap places", "the case a naive row-by-row update collides on");
  } else {
    fail("Two adjacent categories swap places", "the swap did not take");
  }

  // --- 4. Add and remove touch only what changed ---------------------------
  const survivorId = swapped[0].id;
  const afterEdit = await applyPlan(PROBE_INSTANCE, [
    { id: survivorId, name: swapped[0].name, maxPoints: 4 },
    { name: "Added later", maxPoints: 5 },
  ]);

  if (
    afterEdit.length === 2 &&
    afterEdit[0].id === survivorId &&
    !originalIds.includes(afterEdit[1].id)
  ) {
    pass(
      "Adding and removing touches only what changed",
      "the surviving category kept its id; the new one is genuinely new",
    );
  } else {
    fail("Adding and removing touches only what changed", "the surviving id did not survive");
  }
}

main()
  .catch((error) => {
    failures += 1;
    console.error("\nUnexpected error:", error);
  })
  .finally(async () => {
    console.log("");
    const { count } = await prisma.instance.deleteMany({ where: { id: PROBE_INSTANCE } });
    console.log(`Cleanup     deleted ${count} probe instance (categories cascade)`);

    const leftover = await prisma.interviewCategory.count({
      where: { instanceId: PROBE_INSTANCE },
    });
    if (leftover === 0) {
      console.log("Cleanup     verified — no probe rows remain");
    } else {
      failures += 1;
      console.log(`Cleanup     FAILED — ${leftover} category row(s) remain`);
    }

    console.log("");
    console.log(failures === 0 ? "RESULT: all checks passed" : `RESULT: ${failures} check(s) failed`);
    process.exitCode = failures === 0 ? 0 : 1;
    await prisma.$disconnect();
  });
