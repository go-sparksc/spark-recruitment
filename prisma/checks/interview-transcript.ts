// Scratch verification: do PRD decision 120's two unique keys and one CHECK
// actually bite?
//
// Run with:  npx tsx prisma/checks/interview-transcript.ts
//
// WHY THIS SCRIPT IS LOAD-BEARING. `InterviewQuestion_ordinal_nonneg` is a CHECK
// constraint, and Prisma has no syntax for one — it is invisible in
// schema.prisma, nothing in `npm run verify` knows it exists, and no TypeScript
// type changes if a later migration drops it. The two unique keys ARE in the
// schema, which makes them a different hazard rather than a safe one: Prisma
// will reject a duplicate client-side without the statement ever reaching
// Postgres, so a passing test proves the client is enforcing them and says
// nothing about the database. Both go through raw SQL here for that reason, and
// both must come back as 23505 naming the expected index.
//
// What each one is actually protecting:
//
//   InterviewQuestion (instanceId, ordinal)     — the commit UPSERTS on this key
//     rather than deleting and recreating the question set, because deleting
//     would cascade to InterviewAnswer and take with it the answers of every
//     applicant that import never touched. If the key stops being unique, the
//     upsert silently becomes an insert and a re-import grows a second set of
//     questions that no answer points at.
//
//   InterviewAnswer (interviewNotesId, interviewQuestionId) — one answer per
//     question per applicant. Two would render both, under one prompt, with no
//     rule for which is current.
//
//   InterviewQuestion.ordinal >= 0 — ordinal is a column position and decides
//     the order the transcript renders in. A negative one would reorder the
//     interview rather than fail, which reads as the interview having gone that
//     way.
//
// THIS SCRIPT BUILDS ITS OWN INSTANCE AND DELETES IT. It does not touch the seed
// instance, unlike most of its neighbours here. The reason is the lesson in
// CLAUDE.md's security notes: a check's fixtures can destroy real data through
// the mechanism the check is testing. Nothing here is date- or
// threshold-driven, so that specific hazard does not apply — but this check
// exercises a CASCADE, and a cascade's blast radius is decided by which parent
// row you attach a probe to. An isolated instance makes that radius provably
// this script's own rows.
//
// Everything this script creates, it deletes, and it verifies that it did.

import { createSeedClient } from "../seed/client";

const prisma = createSeedClient();

const QUESTION_ORDINAL_INDEX = "InterviewQuestion_instanceId_ordinal_key";
const ANSWER_UNIQUE_INDEX = "InterviewAnswer_interviewNotesId_interviewQuestionId_key";
const ORDINAL_CHECK = "InterviewQuestion_ordinal_nonneg";

/// `check_` prefixed and confined to an instance this script creates, so no
/// probe can collide with seed, demo or real data under any id scheme.
const PROBE_INSTANCE = "check_transcript_instance";
const PROBE_APPLICANT = "check_transcript_applicant";
const PROBE_NOTES = "check_transcript_notes";
const PROBE_QUESTION_A = "check_transcript_question_a";
const PROBE_QUESTION_B = "check_transcript_question_b";
const PROBE_ANSWER_A = "check_transcript_answer_a";
const PROBE_ANSWER_B = "check_transcript_answer_b";
const PROBE_QUESTION_NEGATIVE = "check_transcript_question_negative";

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
  console.log(`Instance    ${PROBE_INSTANCE} (created by this script)`);
  console.log("");

  await prisma.$executeRaw`
    INSERT INTO "Instance" ("id", "name", "passwordHash", "updatedAt")
    VALUES (${PROBE_INSTANCE}, 'Decision 120 constraint probe', 'not-a-real-hash', NOW())
  `;
  await prisma.$executeRaw`
    INSERT INTO "Applicant"
      ("id", "instanceId", "sourceRowIndex", "displayName", "data", "updatedAt")
    VALUES (${PROBE_APPLICANT}, ${PROBE_INSTANCE}, 9001, 'Probe Applicant', '{}'::jsonb, NOW())
  `;
  await prisma.$executeRaw`
    INSERT INTO "InterviewNotes" ("id", "applicantId", "body", "updatedAt")
    VALUES (${PROBE_NOTES}, ${PROBE_APPLICANT}, 'probe transcript', NOW())
  `;
  await prisma.$executeRaw`
    INSERT INTO "InterviewQuestion" ("id", "instanceId", "ordinal", "prompt", "updatedAt")
    VALUES (${PROBE_QUESTION_A}, ${PROBE_INSTANCE}, 0, 'Probe question one', NOW())
  `;

  // --- 1. InterviewQuestion (instanceId, ordinal) ----------------------------
  await expectRejection(
    "InterviewQuestion (instanceId, ordinal)",
    "23505",
    QUESTION_ORDINAL_INDEX,
    () => prisma.$executeRaw`
      INSERT INTO "InterviewQuestion" ("id", "instanceId", "ordinal", "prompt", "updatedAt")
      VALUES (${PROBE_QUESTION_B}, ${PROBE_INSTANCE}, 0, 'Probe question two', NOW())
    `,
  );

  // The same ordinal in a DIFFERENT instance must be fine — the key is scoped,
  // and a global one would make the second cycle to run unimportable.
  try {
    await prisma.$executeRaw`
      INSERT INTO "InterviewQuestion" ("id", "instanceId", "ordinal", "prompt", "updatedAt")
      VALUES (${PROBE_QUESTION_B}, ${PROBE_INSTANCE}, 1, 'Probe question two', NOW())
    `;
    pass("InterviewQuestion ordinal is per-instance", "a second ordinal was accepted");
  } catch (error) {
    fail("InterviewQuestion ordinal is per-instance", (error as Error).message);
  }

  // --- 2. InterviewQuestion.ordinal >= 0 ------------------------------------
  await expectRejection("InterviewQuestion.ordinal >= 0", "23514", ORDINAL_CHECK, () =>
    prisma.$executeRaw`
      INSERT INTO "InterviewQuestion" ("id", "instanceId", "ordinal", "prompt", "updatedAt")
      VALUES (${PROBE_QUESTION_NEGATIVE}, ${PROBE_INSTANCE}, -1, 'Probe negative', NOW())
    `,
  );

  // --- 3. InterviewAnswer (interviewNotesId, interviewQuestionId) -----------
  await prisma.$executeRaw`
    INSERT INTO "InterviewAnswer"
      ("id", "interviewNotesId", "interviewQuestionId", "body", "updatedAt")
    VALUES (${PROBE_ANSWER_A}, ${PROBE_NOTES}, ${PROBE_QUESTION_A}, 'first answer', NOW())
  `;

  await expectRejection(
    "InterviewAnswer (interviewNotesId, interviewQuestionId)",
    "23505",
    ANSWER_UNIQUE_INDEX,
    () => prisma.$executeRaw`
      INSERT INTO "InterviewAnswer"
        ("id", "interviewNotesId", "interviewQuestionId", "body", "updatedAt")
      VALUES (${PROBE_ANSWER_B}, ${PROBE_NOTES}, ${PROBE_QUESTION_A}, 'second answer', NOW())
    `,
  );

  // --- 4. The cascade FR-12's commit depends on ----------------------------
  // The notes commit deletes InterviewNotes for the applicants in its batch and
  // re-inserts them. That is only idempotent if the answers go with them; a
  // second delete would be a second opinion about which rows the commit owns.
  const answersBefore = await prisma.interviewAnswer.count({
    where: { interviewNotesId: PROBE_NOTES },
  });
  await prisma.$executeRaw`DELETE FROM "InterviewNotes" WHERE "id" = ${PROBE_NOTES}`;
  const answersAfter = await prisma.interviewAnswer.count({
    where: { interviewNotesId: PROBE_NOTES },
  });

  if (answersBefore === 1 && answersAfter === 0) {
    pass(
      "InterviewAnswer cascades from InterviewNotes",
      "deleting the transcript removed its answer",
    );
  } else {
    fail(
      "InterviewAnswer cascades from InterviewNotes",
      `${answersBefore} answer(s) before the delete, ${answersAfter} after — expected 1 then 0`,
    );
  }

  // --- 5. Questions do NOT cascade from a deleted transcript ---------------
  // The other half of the same design. A question belongs to the instance, not
  // to any one applicant's transcript, which is what lets the commit upsert it.
  const questionsLeft = await prisma.interviewQuestion.count({
    where: { instanceId: PROBE_INSTANCE },
  });
  if (questionsLeft === 2) {
    pass(
      "InterviewQuestion survives its answers",
      "both questions remain after the transcript was deleted",
    );
  } else {
    fail(
      "InterviewQuestion survives its answers",
      `${questionsLeft} question(s) remain — expected 2`,
    );
  }
}

async function cleanup() {
  // One statement. Everything this script created hangs off the probe instance
  // through a cascade, which is also the last assertion that those cascades are
  // wired the way the schema says.
  await prisma.$executeRaw`DELETE FROM "Instance" WHERE "id" = ${PROBE_INSTANCE}`;
}

async function confirmRestored() {
  const questionIds = [PROBE_QUESTION_A, PROBE_QUESTION_B, PROBE_QUESTION_NEGATIVE];
  const answerIds = [PROBE_ANSWER_A, PROBE_ANSWER_B];

  const leftover =
    (await prisma.instance.count({ where: { id: PROBE_INSTANCE } })) +
    (await prisma.applicant.count({ where: { id: PROBE_APPLICANT } })) +
    (await prisma.interviewNotes.count({ where: { id: PROBE_NOTES } })) +
    (await prisma.interviewQuestion.count({ where: { id: { in: questionIds } } })) +
    (await prisma.interviewAnswer.count({ where: { id: { in: answerIds } } }));

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
    // the probe instance behind.
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
