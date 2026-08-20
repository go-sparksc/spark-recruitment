// Scratch verification: do Phase 5's unique constraints and CHECK constraints
// actually bite?
//
// Run with:  npx tsx prisma/checks/interview-import.ts
//
// WHY THIS SCRIPT IS LOAD-BEARING. Three of the six things below are CHECK
// constraints, and Prisma has no syntax for a CHECK — they are invisible in
// schema.prisma, nothing in `npm run verify` knows they exist, `prisma migrate`
// will not recreate them if a later migration drops them, and no TypeScript type
// changes if they disappear. This script is the only thing in the repo that will
// notice. Re-run it by hand after any schema change.
//
// The unique constraints are here rather than in unique-constraints.ts because
// they belong with the CHECKs that describe the same rows: `matchTier`,
// `matchConfidence` and `skipped` are one rule split across three constraints,
// and a successor reading only half of it would conclude the other half is
// unenforced. Grouped by feature, the way field-groups.ts is.
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

const RESULT_INDEX = "InterviewResult_applicantId_interviewerName_key";
const CATEGORY_INDEX = "InterviewCategory_instanceId_ordinal_key";
/// Truncated by Postgres' 63-character identifier limit — "interviewCategoryI",
/// not "interviewCategoryId". Copied from the migration rather than composed
/// from the column names, which is how this constant would silently stop
/// matching and turn every probe below into a false FAIL.
const CATEGORY_SCORE_INDEX = "InterviewCategoryScore_interviewResultId_interviewCategoryI_key";
const IMPORT_INDEX = "InterviewImport_instanceId_sheet_key";
const ROW_INDEX = "InterviewImportRow_instanceId_sheet_rowIndex_key";

const TIER_CHECK = "InterviewImportRow_matchTier_iff_matchedApplicant";
const CONFIDENCE_CHECK = "InterviewImportRow_confidence_iff_fuzzy";
const SKIPPED_CHECK = "InterviewImportRow_skipped_is_not_matched";

// Every probe id is prefixed so cleanup can find them even if this script dies
// partway through and is re-run.
const P = "check_interview_";

const createdCategoryIds: string[] = [];
const createdCategoryScoreIds: string[] = [];
const createdResultIds: string[] = [];
const createdImportIds: string[] = [];
const createdRowIds: string[] = [];

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

/// One staged row, with everything but the columns under test held constant.
/// Raw SQL, so the enums need explicit casts and @updatedAt needs a value —
/// Prisma supplies both, and this deliberately does not go through Prisma.
async function insertRow(
  id: string,
  importId: string,
  rowIndex: number,
  columns: {
    matchedApplicantId?: string | null;
    matchTier?: "EMAIL" | "NAME" | "FUZZY" | "MANUAL" | null;
    matchConfidence?: number | null;
    skipped?: boolean;
  } = {},
) {
  const {
    matchedApplicantId = null,
    matchTier = null,
    matchConfidence = null,
    skipped = false,
  } = columns;

  await prisma.$executeRaw`
    INSERT INTO "InterviewImportRow"
      ("id", "instanceId", "importId", "sheet", "rowIndex", "cells",
       "matchedApplicantId", "matchTier", "matchConfidence", "skipped", "updatedAt")
    VALUES
      (${id}, ${SEED_INSTANCE_ID}, ${importId}, 'SCORES'::"ImportSheet", ${rowIndex},
       '{}'::jsonb, ${matchedApplicantId},
       ${matchTier}::"MatchTier", ${matchConfidence}, ${skipped}, NOW())
  `;
  createdRowIds.push(id);
}

async function main() {
  const applicant = await prisma.applicant.findFirst({
    where: { instanceId: SEED_INSTANCE_ID },
    orderBy: { sourceRowIndex: "asc" },
  });
  if (!applicant) throw new Error("No seed data found. Run `npm run seed` first.");

  console.log(`Instance    ${SEED_INSTANCE_ID}`);
  console.log(`Colliding   applicant ${applicant.displayName} (row ${applicant.sourceRowIndex})`);
  console.log("");

  // --- 1. InterviewCategory (instanceId, ordinal) ----------------------------
  // Ordinal 9001 rather than 1: the seed may legitimately hold an interview
  // rubric, and this probe must collide with itself rather than with real data.
  const category = await prisma.interviewCategory.create({
    data: { id: `${P}category`, instanceId: SEED_INSTANCE_ID, name: "Probe", maxPoints: 4, ordinal: 9001 },
  });
  createdCategoryIds.push(category.id);

  await expectRejection("InterviewCategory (instanceId, ordinal)", "23505", CATEGORY_INDEX, async () => {
    await prisma.$executeRaw`
      INSERT INTO "InterviewCategory" ("id", "instanceId", "name", "maxPoints", "ordinal", "updatedAt")
      VALUES (${`${P}category_dup`}, ${SEED_INSTANCE_ID}, 'Probe duplicate', 4, 9001, NOW())
    `;
    createdCategoryIds.push(`${P}category_dup`);
  });

  // --- 2. InterviewResult (applicantId, interviewerName) --------------------
  // PRD decision 47: this is what makes a re-committed scores sheet an upsert
  // rather than a duplicate row.
  const result = await prisma.interviewResult.create({
    data: {
      id: `${P}result`,
      applicantId: applicant.id,
      interviewerName: "Probe Interviewer",
      score: 3.5,
    },
  });
  createdResultIds.push(result.id);

  await expectRejection("InterviewResult (applicantId, interviewerName)", "23505", RESULT_INDEX, async () => {
    await prisma.$executeRaw`
      INSERT INTO "InterviewResult" ("id", "applicantId", "interviewerName", "score", "updatedAt")
      VALUES (${`${P}result_dup`}, ${applicant.id}, 'Probe Interviewer', 4.0, NOW())
    `;
    createdResultIds.push(`${P}result_dup`);
  });

  // --- 3. InterviewCategoryScore (interviewResultId, interviewCategoryId) ---
  const categoryScore = await prisma.interviewCategoryScore.create({
    data: {
      id: `${P}category_score`,
      interviewResultId: result.id,
      interviewCategoryId: category.id,
      points: 3,
    },
  });
  createdCategoryScoreIds.push(categoryScore.id);

  await expectRejection(
    "InterviewCategoryScore (interviewResultId, interviewCategoryId)",
    "23505",
    CATEGORY_SCORE_INDEX,
    async () => {
      await prisma.$executeRaw`
        INSERT INTO "InterviewCategoryScore"
          ("id", "interviewResultId", "interviewCategoryId", "points", "updatedAt")
        VALUES (${`${P}category_score_dup`}, ${result.id}, ${category.id}, 4, NOW())
      `;
      createdCategoryScoreIds.push(`${P}category_score_dup`);
    },
  );

  // --- 4. InterviewImport (instanceId, sheet) -------------------------------
  // FR-12 accepts repeated uploads by REPLACING this row. Two staging sets for
  // one sheet would leave the preview reading one and the commit writing the
  // other.
  const staged = await prisma.interviewImport.create({
    data: {
      id: `${P}import`,
      instanceId: SEED_INSTANCE_ID,
      sheet: "SCORES",
      headers: ["Applicant Email", "Interviewer Name", "Average"],
      mapping: {},
    },
  });
  createdImportIds.push(staged.id);

  await expectRejection("InterviewImport (instanceId, sheet)", "23505", IMPORT_INDEX, async () => {
    await prisma.$executeRaw`
      INSERT INTO "InterviewImport" ("id", "instanceId", "sheet", "headers", "mapping")
      VALUES (${`${P}import_dup`}, ${SEED_INSTANCE_ID}, 'SCORES'::"ImportSheet", '[]'::jsonb, '{}'::jsonb)
    `;
    createdImportIds.push(`${P}import_dup`);
  });

  // --- 5. InterviewImportRow (instanceId, sheet, rowIndex) ------------------
  await insertRow(`${P}row`, staged.id, 1);

  await expectRejection("InterviewImportRow (instanceId, sheet, rowIndex)", "23505", ROW_INDEX, () =>
    insertRow(`${P}row_dup`, staged.id, 1),
  );

  // --- 6. CHECK: matchTier is set iff matchedApplicantId is ------------------
  // Half-resolved is not a state. A row pointing at an applicant with no tier
  // cannot say who decided that, and a tier with no applicant is a match to
  // nobody.
  await expectRejection("CHECK matchTier iff matchedApplicantId", "23514", TIER_CHECK, () =>
    insertRow(`${P}row_tier`, staged.id, 2, { matchedApplicantId: applicant.id, matchTier: null }),
  );

  await expectRejection("CHECK matchTier iff matchedApplicantId (reverse)", "23514", TIER_CHECK, () =>
    insertRow(`${P}row_tier_rev`, staged.id, 3, { matchedApplicantId: null, matchTier: "EMAIL" }),
  );

  // --- 7. CHECK: matchConfidence is set iff the tier is FUZZY ---------------
  // PRD §5: "set only when matchTier = FUZZY". A confidence beside an EMAIL
  // match would read as meaningful, and a FUZZY match without one hides the
  // number decision 53 requires an admin to see before ticking it.
  await expectRejection("CHECK confidence iff FUZZY", "23514", CONFIDENCE_CHECK, () =>
    insertRow(`${P}row_conf`, staged.id, 4, {
      matchedApplicantId: applicant.id,
      matchTier: "EMAIL",
      matchConfidence: 0.91,
    }),
  );

  await expectRejection("CHECK confidence iff FUZZY (reverse)", "23514", CONFIDENCE_CHECK, () =>
    insertRow(`${P}row_conf_rev`, staged.id, 5, {
      matchedApplicantId: applicant.id,
      matchTier: "FUZZY",
      matchConfidence: null,
    }),
  );

  // --- 8. CHECK: a skipped row is not also a matched one --------------------
  // PRD decision 51. "This row matches nobody" and "this row matches her" are
  // contradictory answers to the same question, and commit reads both.
  await expectRejection("CHECK skipped is not matched", "23514", SKIPPED_CHECK, () =>
    insertRow(`${P}row_skip`, staged.id, 6, {
      matchedApplicantId: applicant.id,
      matchTier: "MANUAL",
      skipped: true,
    }),
  );

  // --- 9. The legal shapes are still legal ---------------------------------
  // Without this, a CHECK written too strictly would pass every probe above and
  // reject the rows the application actually writes.
  await insertRow(`${P}row_ok_unresolved`, staged.id, 10);
  await insertRow(`${P}row_ok_email`, staged.id, 11, {
    matchedApplicantId: applicant.id,
    matchTier: "EMAIL",
  });
  await insertRow(`${P}row_ok_fuzzy`, staged.id, 12, {
    matchedApplicantId: applicant.id,
    matchTier: "FUZZY",
    matchConfidence: 0.796,
  });
  await insertRow(`${P}row_ok_skipped`, staged.id, 13, { skipped: true });
  pass(
    "The four legal row shapes are accepted",
    "unresolved, EMAIL-matched, FUZZY-matched with a confidence, and skipped",
  );
}

async function cleanup() {
  console.log("");
  const deletions: [string, number][] = [];

  // Order matters: rows and category scores reference the parents below them.
  deletions.push([
    "interview import row",
    (await prisma.interviewImportRow.deleteMany({ where: { id: { startsWith: P } } })).count,
  ]);
  deletions.push([
    "interview import",
    (await prisma.interviewImport.deleteMany({ where: { id: { startsWith: P } } })).count,
  ]);
  deletions.push([
    "interview category score",
    (await prisma.interviewCategoryScore.deleteMany({ where: { id: { startsWith: P } } })).count,
  ]);
  deletions.push([
    "interview result",
    (await prisma.interviewResult.deleteMany({ where: { id: { startsWith: P } } })).count,
  ]);
  deletions.push([
    "interview category",
    (await prisma.interviewCategory.deleteMany({ where: { id: { startsWith: P } } })).count,
  ]);

  const removed = deletions.filter(([, count]) => count > 0);
  if (removed.length === 0) {
    console.log("Cleanup     nothing to remove");
    return;
  }
  for (const [label, count] of removed) {
    console.log(`Cleanup     deleted ${count} ${label}(s)`);
  }
}

/// Counted by prefix rather than by the id lists, so a row this script created
/// and forgot to register is still caught.
async function confirmRestored() {
  const leftover =
    (await prisma.interviewImportRow.count({ where: { id: { startsWith: P } } })) +
    (await prisma.interviewImport.count({ where: { id: { startsWith: P } } })) +
    (await prisma.interviewCategoryScore.count({ where: { id: { startsWith: P } } })) +
    (await prisma.interviewResult.count({ where: { id: { startsWith: P } } })) +
    (await prisma.interviewCategory.count({ where: { id: { startsWith: P } } }));

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
