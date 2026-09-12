// Verification: do decision 119's four raw-SQL constraints actually bite?
//
// Run with:  npx tsx prisma/checks/class-standing.ts
//
// WHY THIS SCRIPT IS LOAD-BEARING. Prisma cannot express any of the four, so
// they exist only in 20260912120000_class_standing/migration.sql:
//
//   - Field_instanceId_graduationDate_key     partial unique index
//   - Field_graduationDate_not_promoted       CHECK
//   - Instance_currentTerm_both_or_neither    CHECK
//   - Instance_currentTermYear_range          CHECK
//
// Nothing in `npm run verify` knows they exist. This script is the only thing in
// the repo that notices if a later migration drops one. Re-run it by hand after
// any schema change. Never against production.
//
// Same posture as field-groups.ts: every probe is raw SQL, so Postgres answers
// rather than the Prisma client, and a rejection must be 23505 (unique_violation)
// or 23514 (check_violation) *naming the expected constraint*. Every rejection
// is paired with the neighbouring write that must SUCCEED, because a constraint
// that refuses the correct write too is not a working constraint.
//
// **Isolated from the seed on purpose.** The probes run inside two throwaway
// instances this script creates, not inside `seed_s26_demo`. The seed designates
// its own graduation-date column, so a probe designating one there would collide
// with the seed's row and "prove" the unique index for the wrong reason.
// Deleting the probe instances cascades to their fields. Nothing here is
// selected by date, rank or threshold, so cleanup cannot reach a row the script
// did not create; it deletes by exact id and then verifies.
//
// **Not checked here, because the database does not enforce it:** that the
// semester is immutable once set. Decision 119 puts that in the actions, which
// refuse a second write. Clearing or changing it through raw SQL succeeds, and
// this script shows that it does, so nobody reads the CHECKs as a lock.

import { createSeedClient } from "../seed/client";

const prisma = createSeedClient();

const GRADUATION_DATE_INDEX = "Field_instanceId_graduationDate_key";
const NOT_PROMOTED_CHECK = "Field_graduationDate_not_promoted";
const BOTH_OR_NEITHER_CHECK = "Instance_currentTerm_both_or_neither";
const YEAR_RANGE_CHECK = "Instance_currentTermYear_range";

const PROBE_INSTANCE_A = "check_class_standing_instance_a";
const PROBE_INSTANCE_B = "check_class_standing_instance_b";
const PROBE_INSTANCES = [PROBE_INSTANCE_A, PROBE_INSTANCE_B];

const PROBE_FIELDS = {
  designatedA: "check_class_standing_designated_a",
  designatedA2: "check_class_standing_designated_a2",
  plainA1: "check_class_standing_plain_a1",
  plainA2: "check_class_standing_plain_a2",
  designatedB: "check_class_standing_designated_b",
  promotedDesignated: "check_class_standing_promoted_designated",
  promotedPlain: "check_class_standing_promoted_plain",
};

let failures = 0;

function pass(label: string, detail: string) {
  console.log(`PASS  ${label}\n        ${detail}`);
}

function fail(label: string, detail: string) {
  failures += 1;
  console.log(`FAIL  ${label}\n        ${detail}`);
}

/// Postgres reports a unique violation as 23505 and a check violation as 23514.
/// Prisma wraps raw-query errors, so look for the code and the constraint name
/// wherever they surface.
function violation(error: unknown, sqlState: string, expectedName: string): string | null {
  const meta = (error as { meta?: Record<string, unknown> }).meta ?? {};
  const text = `${(error as Error).message ?? ""} ${JSON.stringify(meta)}`;

  if (!text.includes(sqlState)) return null;
  if (!text.includes(expectedName)) {
    return null;
  }
  const kind = sqlState === "23505" ? "unique_violation" : "check_violation";
  return `Postgres raised ${sqlState} (${kind}) on ${expectedName}`;
}

async function expectRejection(
  label: string,
  sqlState: string,
  expectedName: string,
  write: () => Promise<unknown>,
) {
  try {
    await write();
    fail(label, "the write was ACCEPTED — the constraint is not enforced");
  } catch (error) {
    const detail = violation(error, sqlState, expectedName);
    if (detail) pass(label, detail);
    else
      fail(
        label,
        `rejected, but not with ${sqlState} on ${expectedName}: ${(error as Error).message}`,
      );
  }
}

async function expectAccepted(label: string, detail: string, write: () => Promise<unknown>) {
  try {
    await write();
    pass(label, detail);
  } catch (error) {
    fail(label, `the correct write was REJECTED: ${(error as Error).message}`);
  }
}

const insertInstance = (id: string) => prisma.$executeRaw`
  INSERT INTO "Instance" ("id", "name", "passwordHash", "currentStage", "updatedAt")
  VALUES (${id}, 'Class standing probe', 'not-a-real-hash', 'WRITTEN'::"InstanceStage", NOW())`;

const insertField = (
  id: string,
  instanceId: string,
  ordinal: number,
  isGraduationDate: boolean,
  promoted: "EMAIL" | "NAME" | null = null,
) =>
  promoted === null
    ? prisma.$executeRaw`
        INSERT INTO "Field"
          ("id", "instanceId", "sourceHeader", "displayName", "category", "ordinal",
           "isGraduationDate", "updatedAt")
        VALUES (${id}, ${instanceId}, 'Probe', 'Probe', 'OTHER'::"FieldCategory", ${ordinal},
                ${isGraduationDate}, NOW())`
    : prisma.$executeRaw`
        INSERT INTO "Field"
          ("id", "instanceId", "sourceHeader", "displayName", "category", "ordinal",
           "isGraduationDate", "promotedRole", "updatedAt")
        VALUES (${id}, ${instanceId}, 'Probe', 'Probe', 'OTHER'::"FieldCategory", ${ordinal},
                ${isGraduationDate}, ${promoted}::"PromotedRole", NOW())`;

const setTerm = (id: string, season: "SPRING" | "FALL" | null, year: number | null) =>
  season === null
    ? prisma.$executeRaw`
        UPDATE "Instance" SET "currentTermSeason" = NULL, "currentTermYear" = ${year}
        WHERE "id" = ${id}`
    : prisma.$executeRaw`
        UPDATE "Instance"
        SET "currentTermSeason" = ${season}::"TermSeason", "currentTermYear" = ${year}
        WHERE "id" = ${id}`;

async function main() {
  // Refuse to run over leftovers from a crashed earlier run, rather than
  // colliding with them and reporting a misleading result.
  const stale = await prisma.instance.count({ where: { id: { in: PROBE_INSTANCES } } });
  if (stale > 0) {
    throw new Error(
      `${stale} probe instance(s) already exist from an earlier run. Nothing was probed; ` +
        `cleanup below removes them by exact id, so re-run once it reports verified.`,
    );
  }

  for (const id of PROBE_INSTANCES) await insertInstance(id);
  console.log(`Setup       created probe instances ${PROBE_INSTANCES.join(", ")}`);
  console.log("");

  // --- 1. Partial unique index: one graduation-date column per instance -----
  await expectAccepted(
    "Field partial unique — the first designated column",
    "one designated column per instance is allowed",
    () => insertField(PROBE_FIELDS.designatedA, PROBE_INSTANCE_A, 9001, true),
  );

  await expectRejection(
    "Field partial unique — a second designated column in the same instance",
    "23505",
    GRADUATION_DATE_INDEX,
    () => insertField(PROBE_FIELDS.designatedA2, PROBE_INSTANCE_A, 9002, true),
  );

  // Partial: the many `false` rows must not collide with each other.
  await expectAccepted(
    "Field partial unique — many undesignated columns are fine",
    "two more isGraduationDate = false rows beside the designated one",
    async () => {
      await insertField(PROBE_FIELDS.plainA1, PROBE_INSTANCE_A, 9003, false);
      await insertField(PROBE_FIELDS.plainA2, PROBE_INSTANCE_A, 9004, false);
    },
  );

  // --- 2. CHECK: a promoted column is never the graduation date -------------
  // Its Field row is deleted at commit, and the designation would go with it.
  // Probed as an INSERT and as an UPDATE, since the likelier bug is designating
  // a column that is already promoted, or promoting one already designated.
  //
  // The two probes that could create a designated row run in instance B while
  // B has NO designated column yet. So the unique index cannot be what rejects
  // them, and a pass here names this CHECK for the right reason, without leaning
  // on Postgres evaluating CHECKs before indexes.
  await expectRejection(
    "Field CHECK — inserted both promoted and designated",
    "23514",
    NOT_PROMOTED_CHECK,
    () => insertField(PROBE_FIELDS.promotedDesignated, PROBE_INSTANCE_B, 9002, true, "EMAIL"),
  );

  await expectAccepted(
    "Field CHECK — a promoted, undesignated column is fine",
    "promotion alone does not trip the constraint",
    () => insertField(PROBE_FIELDS.promotedPlain, PROBE_INSTANCE_B, 9003, false, "EMAIL"),
  );

  await expectRejection(
    "Field CHECK — designating the promoted column",
    "23514",
    NOT_PROMOTED_CHECK,
    () => prisma.$executeRaw`
      UPDATE "Field" SET "isGraduationDate" = true
      WHERE "id" = ${PROBE_FIELDS.promotedPlain}`,
  );

  // Updates the one designated row in place, so it cannot collide with itself
  // on the unique index.
  await expectRejection(
    "Field CHECK — promoting the designated column",
    "23514",
    NOT_PROMOTED_CHECK,
    () => prisma.$executeRaw`
      UPDATE "Field" SET "promotedRole" = 'NAME'::"PromotedRole"
      WHERE "id" = ${PROBE_FIELDS.designatedA}`,
  );

  // Back to section 1's index, now that B's promoted probes are done: scoped by
  // instanceId, so another instance has its own designation.
  await expectAccepted(
    "Field partial unique — a designated column in a different instance",
    "the index is per instance, not global",
    () => insertField(PROBE_FIELDS.designatedB, PROBE_INSTANCE_B, 9001, true),
  );

  // --- 3. CHECK: the semester is set or null as a pair ----------------------
  // Valid years throughout, so only this constraint can be the one that fires.
  await expectRejection(
    "Instance CHECK — season without year",
    "23514",
    BOTH_OR_NEITHER_CHECK,
    () => setTerm(PROBE_INSTANCE_A, "FALL", null),
  );

  await expectRejection(
    "Instance CHECK — year without season",
    "23514",
    BOTH_OR_NEITHER_CHECK,
    () => setTerm(PROBE_INSTANCE_A, null, 2026),
  );

  await expectAccepted(
    "Instance CHECK — season and year together",
    "Fall 2026 written as a pair",
    () => setTerm(PROBE_INSTANCE_A, "FALL", 2026),
  );

  // --- 4. CHECK: the year is within 2000–2100 --------------------------------
  // The season stays set, so only the range can be what fires.
  await expectRejection(
    "Instance CHECK — a two-digit year",
    "23514",
    YEAR_RANGE_CHECK,
    () => setTerm(PROBE_INSTANCE_A, "FALL", 26),
  );

  await expectRejection(
    "Instance CHECK — one past the upper bound",
    "23514",
    YEAR_RANGE_CHECK,
    () => setTerm(PROBE_INSTANCE_A, "FALL", 2101),
  );

  await expectRejection(
    "Instance CHECK — one below the lower bound",
    "23514",
    YEAR_RANGE_CHECK,
    () => setTerm(PROBE_INSTANCE_A, "FALL", 1999),
  );

  await expectAccepted(
    "Instance CHECK — both bounds are inclusive",
    "2000 and 2100 are each accepted",
    async () => {
      await setTerm(PROBE_INSTANCE_A, "SPRING", 2000);
      await setTerm(PROBE_INSTANCE_A, "SPRING", 2100);
    },
  );

  // --- 5. Not a lock, stated rather than assumed ----------------------------
  await expectAccepted(
    "Instance — the database does NOT make the semester immutable",
    "clearing a set semester succeeds in SQL; immutability lives in the actions, per decision 119",
    () => setTerm(PROBE_INSTANCE_A, null, null),
  );
}

async function cleanup() {
  console.log("");
  // Exact ids only. Deleting the instances cascades to every probe field.
  const { count } = await prisma.instance.deleteMany({ where: { id: { in: PROBE_INSTANCES } } });
  console.log(`Cleanup     deleted ${count} probe instance(s) and, by cascade, their fields`);
}

async function confirmRestored() {
  const leftover =
    (await prisma.instance.count({ where: { id: { in: PROBE_INSTANCES } } })) +
    (await prisma.field.count({ where: { id: { in: Object.values(PROBE_FIELDS) } } }));

  if (leftover === 0) {
    console.log("Cleanup     verified — no probe rows remain");
  } else {
    failures += 1;
    console.log(`Cleanup     FAILED — ${leftover} probe row(s) remain`);
  }
}

main()
  .catch((error) => {
    failures += 1;
    console.error("\nUnexpected error:", error);
  })
  .finally(async () => {
    // Cleanup runs even if main() threw partway through.
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
