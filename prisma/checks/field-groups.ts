// Scratch verification: do the two CHECK constraints and the FieldGroup unique
// key actually bite?
//
// Run with:  npx tsx prisma/checks/field-groups.ts
//
// WHY THIS SCRIPT IS LOAD-BEARING. Prisma has no syntax for a CHECK constraint,
// so `Field_groupRole_iff_groupId` and
// `Instance_importProposals_cleared_at_commit` are invisible in
// schema.prisma. Nothing in `npm run verify` knows they exist, `prisma migrate
// dev` will not recreate them if a later migration drops them, and no
// TypeScript type will change if they disappear. This script is the only thing
// in the repo that will notice. Re-run it by hand after any schema change.
//
// The probes go through raw SQL rather than the Prisma client on purpose.
// Prisma can reject a bad write client-side without the statement ever reaching
// the server, which would prove nothing about the database. Raw SQL forces
// Postgres to answer: 23505 (unique_violation) or 23514 (check_violation),
// naming the expected constraint.
//
// Everything this script creates, it deletes, and it verifies that it did.

import { SEED_INSTANCE_ID, createSeedClient } from "../seed/client";

const prisma = createSeedClient();

const GROUP_KEY_INDEX = "FieldGroup_instanceId_key_key";
const GROUP_ROLE_CHECK = "Field_groupRole_iff_groupId";
const PROPOSALS_CHECK = "Instance_importProposals_cleared_at_commit";

const PROBE_GROUP_A = "check_fieldgroup_original";
const PROBE_GROUP_B = "check_fieldgroup_duplicate";
const PROBE_FIELD = "check_field_group_role";
const PROBE_INSTANCE = "check_instance_proposals";

const createdGroupIds: string[] = [];
const createdFieldIds: string[] = [];
const createdInstanceIds: string[] = [];

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
    return `${sqlState} raised, but by something other than ${expectedName}`;
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

async function main() {
  const instance = await prisma.instance.findUnique({ where: { id: SEED_INSTANCE_ID } });
  if (!instance) throw new Error("No seed data found. Run `npm run seed` first.");

  const baseline = {
    groups: await prisma.fieldGroup.count({ where: { instanceId: SEED_INSTANCE_ID } }),
    fields: await prisma.field.count({ where: { instanceId: SEED_INSTANCE_ID } }),
  };

  console.log(`Instance    ${SEED_INSTANCE_ID}`);
  console.log(`Baseline    ${baseline.groups} field groups, ${baseline.fields} fields`);
  console.log("");

  // --- 1. FieldGroup (instanceId, key) --------------------------------------
  // key is immutable and is what FR-19 and FR-20 reference, so two groups
  // sharing one in an instance would make an export ambiguous.
  await prisma.$executeRaw`
    INSERT INTO "FieldGroup"
      ("id", "instanceId", "key", "displayName", "category", "ordinal", "updatedAt")
    VALUES
      (${PROBE_GROUP_A}, ${SEED_INSTANCE_ID}, 'check-probe-key', 'Probe Group',
       'OTHER'::"FieldCategory", 9001, NOW())
  `;
  createdGroupIds.push(PROBE_GROUP_A);
  console.log(`Setup       created ${PROBE_GROUP_A} to collide with`);
  console.log("");

  await expectRejection("FieldGroup (instanceId, key)", "23505", GROUP_KEY_INDEX, async () => {
    await prisma.$executeRaw`
      INSERT INTO "FieldGroup"
        ("id", "instanceId", "key", "displayName", "category", "ordinal", "updatedAt")
      VALUES
        (${PROBE_GROUP_B}, ${SEED_INSTANCE_ID}, 'check-probe-key', 'Duplicate Key Probe',
         'OTHER'::"FieldCategory", 9002, NOW())
    `;
    createdGroupIds.push(PROBE_GROUP_B);
  });

  // --- 2. Field CHECK ((groupId IS NULL) = (groupRole IS NULL)) -------------
  // PRD section 5 says groupRole is "set only when groupId is set". Both halves
  // are probed: a role without a group, then a group without a role. A field
  // carrying a role but no group would be counted by nothing and displayed by
  // nothing; a group member with no role has no defined behaviour in the
  // section 10.7 predicate, which branches on OPTION versus FREE_TEXT.
  await expectRejection(
    "Field CHECK — groupRole set, groupId null",
    "23514",
    GROUP_ROLE_CHECK,
    async () => {
      await prisma.$executeRaw`
        INSERT INTO "Field"
          ("id", "instanceId", "sourceHeader", "displayName", "category",
           "groupId", "groupRole", "ordinal", "updatedAt")
        VALUES
          (${PROBE_FIELD}, ${SEED_INSTANCE_ID}, 'Probe Header', 'Probe',
           'OTHER'::"FieldCategory", NULL, 'OPTION'::"FieldGroupRole", 9001, NOW())
      `;
      createdFieldIds.push(PROBE_FIELD);
    },
  );

  await expectRejection(
    "Field CHECK — groupId set, groupRole null",
    "23514",
    GROUP_ROLE_CHECK,
    async () => {
      await prisma.$executeRaw`
        INSERT INTO "Field"
          ("id", "instanceId", "sourceHeader", "displayName", "category",
           "groupId", "groupRole", "ordinal", "updatedAt")
        VALUES
          (${PROBE_FIELD}, ${SEED_INSTANCE_ID}, 'Probe Header', 'Probe',
           'OTHER'::"FieldCategory", ${PROBE_GROUP_A}, NULL, 9001, NOW())
      `;
      createdFieldIds.push(PROBE_FIELD);
    },
  );

  // --- 3. Instance CHECK (committed XOR proposals) --------------------------
  // Proposals are cleared at commit. A committed instance still holding them
  // would read as meaningful to a successor and could contradict the FieldGroup
  // rows beside it, with no rule for which one wins.
  //
  // Probed as an UPDATE rather than an INSERT because that is the shape the bug
  // would actually take: a commit path that sets importCommittedAt and forgets
  // to null importProposals.
  await prisma.$executeRaw`
    INSERT INTO "Instance"
      ("id", "name", "passwordHash", "currentStage", "importProposals", "updatedAt")
    VALUES
      (${PROBE_INSTANCE}, 'Probe Instance', 'not-a-real-hash',
       'WRITTEN'::"InstanceStage", '{"proposals":[]}'::jsonb, NOW())
  `;
  createdInstanceIds.push(PROBE_INSTANCE);

  await expectRejection(
    "Instance CHECK — committed while proposals remain",
    "23514",
    PROPOSALS_CHECK,
    async () => {
      await prisma.$executeRaw`
        UPDATE "Instance" SET "importCommittedAt" = NOW() WHERE "id" = ${PROBE_INSTANCE}
      `;
    },
  );

  // The same update with the proposals cleared must SUCCEED — a constraint that
  // rejects the correct write too is not a working constraint.
  try {
    await prisma.$executeRaw`
      UPDATE "Instance"
      SET "importCommittedAt" = NOW(), "importProposals" = NULL
      WHERE "id" = ${PROBE_INSTANCE}
    `;
    pass(
      "Instance CHECK — commit with proposals cleared is allowed",
      "the correct write was accepted, so the constraint is not simply blocking everything",
    );
  } catch (error) {
    fail(
      "Instance CHECK — commit with proposals cleared is allowed",
      `the correct write was REJECTED: ${(error as Error).message}`,
    );
  }
}

async function cleanup() {
  console.log("");
  const removed: string[] = [];

  if (createdFieldIds.length > 0) {
    const { count } = await prisma.field.deleteMany({ where: { id: { in: createdFieldIds } } });
    removed.push(`${count} field(s)`);
  }
  if (createdGroupIds.length > 0) {
    const { count } = await prisma.fieldGroup.deleteMany({ where: { id: { in: createdGroupIds } } });
    removed.push(`${count} field group(s)`);
  }
  if (createdInstanceIds.length > 0) {
    const { count } = await prisma.instance.deleteMany({
      where: { id: { in: createdInstanceIds } },
    });
    removed.push(`${count} instance(s)`);
  }

  console.log(removed.length > 0 ? `Cleanup     deleted ${removed.join(", ")}` : "Cleanup     nothing to remove");
}

async function confirmRestored() {
  const probeIds = [PROBE_GROUP_A, PROBE_GROUP_B, PROBE_FIELD, PROBE_INSTANCE];
  const leftover =
    (await prisma.fieldGroup.count({ where: { id: { in: probeIds } } })) +
    (await prisma.field.count({ where: { id: { in: probeIds } } })) +
    (await prisma.instance.count({ where: { id: { in: probeIds } } }));

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
