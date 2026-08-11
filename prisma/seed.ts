import { hashSecret } from "../lib/password";
import { InstanceStage, Round } from "../generated/prisma/enums";
import { buildApplicantData, buildApplicantProfiles } from "./seed/applicants";
import { SEED_INSTANCE_ID, createSeedClient } from "./seed/client";
import { ETHNICITY_GROUP, buildFieldSpecs } from "./seed/fields";
import { createRng } from "./seed/rng";
import { RUBRIC_CATEGORIES, SPARKLET_COUNT, buildReviewerSpecs } from "./seed/roster";

const RNG_SEED = 20260805;
const APPLICANT_COUNT = 150;

const SEED_INSTANCE_NAME = "S26 Recruitment (synthetic seed)";

// Development credentials for synthetic data. Printed below so a new maintainer
// can actually open the thing. Stored only as argon2id hashes, per PRD section 8.
const DEV_INSTANCE_PASSWORD = "phase0-dev-password";
const DEV_ROUND_CODES: Record<Round, string> = {
  [Round.WRITTEN]: "written-s26",
  [Round.FIRST_ROUND]: "firstround-s26",
  [Round.SECOND_ROUND]: "secondround-s26",
};

const prisma = createSeedClient();

/// Seed rows get derived ids rather than cuids so that re-seeding is fully
/// reproducible. This matters more than it looks: Applicant.data is keyed by
/// Field id, so stable field ids mean a re-seed does not invalidate every query,
/// bookmark, and screenshot from the previous run.
function seedId(kind: string, index: number, width = 3): string {
  return `${SEED_INSTANCE_ID}_${kind}_${String(index).padStart(width, "0")}`;
}

/// Note that FieldGroup.id carries several shapes across the codebase: this
/// derived one, the 32-char md5 the field_groups migration backfill assigns, and
/// the cuid the app generates. The column is TEXT and Prisma applies
/// @default(cuid()) client-side, so none of them conflict — but never validate
/// one of these ids by length or pattern.
const ETHNICITY_GROUP_ID = `${SEED_INSTANCE_ID}_group_ethnicity`;

async function main() {
  const rng = createRng(RNG_SEED);
  const fieldSpecs = buildFieldSpecs();

  const ethnicityMembers = fieldSpecs.filter((spec) => spec.groupKey === ETHNICITY_GROUP.key);
  const ethnicityGroupOrdinal = Math.min(...ethnicityMembers.map((spec) => spec.ordinal));

  // The seed's only group. If the catalog ever grows a second one this needs to
  // become a map keyed by group key rather than a single constant — hence the
  // assertion rather than a silent assumption.
  const distinctGroupKeys = new Set(
    fieldSpecs.map((spec) => spec.groupKey).filter((key): key is string => key !== null),
  );
  if (distinctGroupKeys.size !== 1) {
    throw new Error(
      `Expected exactly one field group in the catalog, found ${distinctGroupKeys.size}: ` +
        `${[...distinctGroupKeys].join(", ")}. Update seed.ts to create each one.`,
    );
  }

  // Idempotent by deletion rather than upsert: the instance owns every row
  // beneath it through cascades, so this resets exactly the seed data and leaves
  // anything else in the database untouched.
  const { count: removed } = await prisma.instance.deleteMany({
    where: { id: SEED_INSTANCE_ID },
  });
  if (removed > 0) {
    console.log(`Removed the previous seed instance (${SEED_INSTANCE_ID}).`);
  }

  const roundCodeEntries = Object.entries(DEV_ROUND_CODES) as [Round, string][];

  const [instancePasswordHash, ...roundCodeHashes] = await Promise.all([
    hashSecret(DEV_INSTANCE_PASSWORD),
    ...roundCodeEntries.map(([, code]) => hashSecret(code)),
  ]);

  await prisma.instance.create({
    data: {
      id: SEED_INSTANCE_ID,
      name: SEED_INSTANCE_NAME,
      passwordHash: instancePasswordHash,
      currentStage: InstanceStage.WRITTEN,
      // The seed's applicants are committed applicants, not staged rows, so the
      // flag that says so has to be set. FR-3 makes importCommittedAt the record
      // that an import is final: it is what refuses a second CSV, and what any
      // later surface checks before assuming there are applicants to work with.
      // Left null, the seeded instance would claim to be a draft while holding
      // 150 committed Applicant rows and no ImportRow rows to have staged them —
      // a state the real import flow cannot produce.
      importCommittedAt: new Date(),
      // Groups are created with the instance so the fields below can point at
      // them. Nested creates run parent-first, so the group row exists by the
      // time a member references its id.
      fieldGroups: {
        create: [
          {
            id: ETHNICITY_GROUP_ID,
            key: ETHNICITY_GROUP.key,
            displayName: ETHNICITY_GROUP.displayName,
            category: ETHNICITY_GROUP.category,
            isMultiSelect: ETHNICITY_GROUP.isMultiSelect,
            isIncluded: ETHNICITY_GROUP.isIncluded,
            // Sorts where its first member sits.
            ordinal: ethnicityGroupOrdinal,
          },
        ],
      },
      fields: {
        create: fieldSpecs.map((spec) => ({
          id: seedId("field", spec.ordinal, 2),
          sourceHeader: spec.sourceHeader,
          displayName: spec.displayName,
          category: spec.category,
          // groupId and groupRole are set together or not at all; the
          // Field_groupRole_iff_groupId CHECK rejects a half-set row.
          groupId: spec.groupKey === null ? null : ETHNICITY_GROUP_ID,
          groupRole: spec.groupRole,
          isIncluded: spec.isIncluded,
          ordinal: spec.ordinal,
        })),
      },
      rubricCategories: {
        create: RUBRIC_CATEGORIES.map((category) => ({
          id: seedId("rubric", category.ordinal, 1),
          ...category,
        })),
      },
      roundAccessCodes: {
        create: roundCodeEntries.map(([round], index) => ({
          id: seedId("code", index, 1),
          round,
          codeHash: roundCodeHashes[index],
        })),
      },
    },
  });

  // Re-read the fields to pair each spec with the id the database assigned.
  // Applicant.data is keyed by that id and never by header text, so renaming a
  // column in Phase 1 cannot orphan a value.
  const storedFields = await prisma.field.findMany({
    where: { instanceId: SEED_INSTANCE_ID },
    orderBy: { ordinal: "asc" },
    select: { id: true, ordinal: true },
  });

  const specsWithIds = fieldSpecs.map((spec, index) => {
    const stored = storedFields[index];
    if (!stored || stored.ordinal !== spec.ordinal) {
      throw new Error(`Field ordinal mismatch at index ${index}; refusing to write applicants.`);
    }
    return { ...spec, id: stored.id };
  });

  const profiles = buildApplicantProfiles(rng, APPLICANT_COUNT);

  await prisma.applicant.createMany({
    data: profiles.map((profile) => ({
      id: seedId("applicant", profile.sourceRowIndex),
      instanceId: SEED_INSTANCE_ID,
      sourceRowIndex: profile.sourceRowIndex,
      email: profile.email,
      displayName: profile.displayName,
      data: buildApplicantData(profile, specsWithIds),
    })),
  });

  const reviewers = buildReviewerSpecs(rng);
  await prisma.reviewer.createMany({
    data: reviewers.map((reviewer, index) => ({
      id: seedId("reviewer", index, 2),
      instanceId: SEED_INSTANCE_ID,
      ...reviewer,
    })),
  });

  // Assignments, scores, votes, passes, and decisions are deliberately absent.
  // They belong to phases 2, 3, and 6; inventing them now would let a wrong
  // shape harden before those phases specify one.

  const sparklets = reviewers.filter((reviewer) => reviewer.isSparklet).length;

  console.log("");
  console.log(`Seeded instance "${SEED_INSTANCE_NAME}"`);
  console.log(`  fields             ${fieldSpecs.length}`);
  console.log(`  applicants         ${profiles.length}`);
  console.log(`  reviewers          ${reviewers.length} (${sparklets} Sparklets)`);
  console.log(`  rubric categories  ${RUBRIC_CATEGORIES.length}`);
  console.log("");
  console.log("Development credentials (synthetic data only, stored as argon2id hashes):");
  console.log(`  instance password  ${DEV_INSTANCE_PASSWORD}`);
  for (const [round, code] of Object.entries(DEV_ROUND_CODES)) {
    console.log(`  ${round.padEnd(17)} ${code}`);
  }
  console.log("");
  console.log("Run `npm run seed:inspect` to verify the field catalog and JSONB resolution.");

  if (sparklets !== SPARKLET_COUNT) {
    throw new Error(`Expected ${SPARKLET_COUNT} Sparklets, generated ${sparklets}.`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
