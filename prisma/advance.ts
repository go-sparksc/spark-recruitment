// Advance the seed instance through the first round into the second.
//
// Run with:  npm run seed:advance   (after npm run seed)
//
// **Deliberately not part of `npm run seed`.** BUILD_PLAN's Phase 5 gate and
// prisma/checks/reconciliation-fixture.ts are both written against an instance
// sitting at FIRST_ROUND with no interview data imported. A default seed that
// advanced past that state would leave both of them "passing" over a fixture
// they no longer describe — the exact failure mode the reconciliation check
// exists to catch, reintroduced one level up.
//
// What it produces is the state an admin reaches by doing the FR-12a, FR-12 and
// FR-15 work by hand: an interview rubric, two interview results per applicant,
// notes for most of them, a round of first-round votes, and FR-15's finalize.
// The finalize is written to match `finalizeFirstRound` exactly rather than
// approximately — same Decision rows over the same pool, same `stageReached` and
// `status` moves, same `currentStage`. A seed whose idea of "advanced" differed
// from the action's would develop every Phase 6 surface against a state the
// application cannot produce.
//
// It creates no Pass rows. Those are what an admin creates on FR-17's screen,
// and seeding them would develop FR-18 against a state nothing produced.

import {
  ApplicantStatus,
  DecisionActor,
  DecisionOutcome,
  InstanceStage,
  Round,
  VoteValue,
} from "../generated/prisma/enums";
import { createRng } from "../lib/rng";
import { SEED_INSTANCE_ID, createSeedClient } from "./seed/client";
import { RECONCILIATION_COHORT } from "./seed/first-round";
import {
  INTERVIEWERS,
  INTERVIEW_CATEGORIES,
  SECOND_ROUND_ADVANCE_COUNT,
  SECOND_ROUND_RNG_SEED,
  buildFirstRoundVotes,
  buildInterviewNotes,
  buildInterviewResults,
  chooseSecondRoundCohort,
} from "./seed/second-round";

const prisma = createSeedClient();

/// Derived ids, for the reason prisma/seed.ts gives: a re-run must be able to
/// replace exactly what a previous run wrote.
function seedId(kind: string, index: number, width = 3): string {
  return `${SEED_INSTANCE_ID}_${kind}_${String(index).padStart(width, "0")}`;
}

async function main() {
  const instance = await prisma.instance.findUnique({
    where: { id: SEED_INSTANCE_ID },
    select: { id: true, name: true, currentStage: true },
  });

  if (!instance) {
    throw new Error(`No seed instance. Run \`npm run seed\` first.`);
  }

  // **Refuse where a re-run would destroy real work.** This script rewrites the
  // first round's data wholesale, which is harmless on a freshly seeded database
  // and is not harmless once somebody has clicked through a pass. Passes are the
  // marker because they are the first thing in the second round an admin makes
  // by hand.
  const passCount = await prisma.pass.count({ where: { instanceId: SEED_INSTANCE_ID } });
  if (passCount > 0) {
    throw new Error(
      `The seed instance already has ${passCount} pass(es). Advancing again would rewrite the ` +
        `first-round data underneath them. Run \`npm run seed\` to start the cycle over.`,
    );
  }

  if (instance.currentStage === InstanceStage.WRITTEN) {
    throw new Error(
      `The seed instance is still in the written round. \`npm run seed\` finalizes it to ` +
        `FIRST_ROUND; this script continues from there.`,
    );
  }

  // **Already past the first round, which is not the same as ready.** An
  // instance whose first round was finalized by hand — clicking through FR-15 to
  // test it — lands here with a cohort of whatever was ticked on that screen,
  // which may be one applicant or none. Advancing again is not possible: the
  // pool this reads from is empty, because everyone in it has already been
  // decided. Say so with the numbers, rather than failing three checks later
  // with "no applicant is in the first round", which reads as a broken seed.
  if (instance.currentStage !== InstanceStage.FIRST_ROUND) {
    const [active, results, votes] = await Promise.all([
      prisma.applicant.count({
        where: { instanceId: SEED_INSTANCE_ID, status: ApplicantStatus.ACTIVE },
      }),
      prisma.interviewResult.count({ where: { applicant: { instanceId: SEED_INSTANCE_ID } } }),
      prisma.firstRoundVote.count({ where: { applicant: { instanceId: SEED_INSTANCE_ID } } }),
    ]);

    throw new Error(
      `The seed instance is already at ${instance.currentStage}, with ${active} ACTIVE ` +
        `applicant(s), ${results} interview result(s) and ${votes} first-round vote(s). Its first ` +
        `round has been decided, so there is nothing left to advance.\n\n` +
        `  If that cohort is what you want, use it — FR-17 creates passes from the ACTIVE set.\n` +
        `  If you want a full synthetic second round, run \`npm run seed\` first. That RESETS the ` +
        `instance and discards anything clicked through by hand.`,
    );
  }

  // --- FR-12a: the interview rubric ----------------------------------------
  //
  // Deleted and recreated rather than upserted. Decision 61 preserves category
  // ids across an EDIT in the application, because a staged FR-12 mapping
  // references them; nothing is staged here, and a re-run wants the same derived
  // ids it had before, which it gets.
  await prisma.interviewCategory.deleteMany({ where: { instanceId: SEED_INSTANCE_ID } });
  await prisma.interviewCategory.createMany({
    data: INTERVIEW_CATEGORIES.map((category, ordinal) => ({
      id: seedId("interview_category", ordinal),
      instanceId: SEED_INSTANCE_ID,
      name: category.name,
      maxPoints: category.maxPoints,
      ordinal,
    })),
  });

  // --- The first-round pool -------------------------------------------------
  const pool = await prisma.applicant.findMany({
    where: {
      instanceId: SEED_INSTANCE_ID,
      status: ApplicantStatus.ACTIVE,
      stageReached: Round.FIRST_ROUND,
    },
    orderBy: { sourceRowIndex: "asc" },
    select: { id: true, sourceRowIndex: true },
  });

  if (pool.length === 0) {
    throw new Error(
      `No applicant is in the first round. Expected \`npm run seed\` to have advanced a cohort.`,
    );
  }

  const applicants = pool.map((applicant) => ({
    applicantId: applicant.id,
    sourceRowIndex: applicant.sourceRowIndex,
  }));

  // --- FR-12: scores and notes ---------------------------------------------
  const rng = createRng(SECOND_ROUND_RNG_SEED);

  const results = buildInterviewResults(applicants, (i) => seedId("interview_result", i), rng);
  const notes = buildInterviewNotes(applicants, results, rng);

  const applicantIds = applicants.map((applicant) => applicant.applicantId);

  // InterviewCategoryScore cascades from InterviewResult, so deleting the
  // results is enough — asserted below rather than assumed.
  await prisma.interviewResult.deleteMany({ where: { applicantId: { in: applicantIds } } });
  await prisma.interviewNotes.deleteMany({ where: { applicantId: { in: applicantIds } } });

  await prisma.interviewResult.createMany({
    data: results.map((result) => ({
      id: result.id,
      applicantId: result.applicantId,
      interviewerName: result.interviewerName,
      score: result.score,
    })),
  });

  await prisma.interviewCategoryScore.createMany({
    data: results.flatMap((result) =>
      result.categoryPoints.map((points, ordinal) => ({
        interviewResultId: result.id,
        interviewCategoryId: seedId("interview_category", ordinal),
        points,
      })),
    ),
  });

  await prisma.interviewNotes.createMany({
    data: notes.map((note) => ({
      applicantId: note.applicantId,
      interviewerName: note.interviewerName,
      body: note.body,
    })),
  });

  // --- FR-14: the votes -----------------------------------------------------
  const firstRoundReviewers = await prisma.reviewer.findMany({
    where: { instanceId: SEED_INSTANCE_ID, rounds: { has: Round.FIRST_ROUND } },
    orderBy: { id: "asc" },
    select: { id: true },
  });

  const averageByApplicant = new Map<string, number[]>();
  for (const result of results) {
    averageByApplicant.set(result.applicantId, [
      ...(averageByApplicant.get(result.applicantId) ?? []),
      result.score,
    ]);
  }

  const votes = buildFirstRoundVotes(
    applicants.map((applicant) => {
      const scores = averageByApplicant.get(applicant.applicantId) ?? [];
      return {
        ...applicant,
        interviewAverage:
          scores.length === 0 ? null : scores.reduce((sum, n) => sum + n, 0) / scores.length,
      };
    }),
    firstRoundReviewers.map((reviewer) => reviewer.id),
    rng,
  );

  await prisma.firstRoundVote.deleteMany({ where: { applicantId: { in: applicantIds } } });
  await prisma.firstRoundVote.createMany({ data: votes });

  // --- FR-15: finalize ------------------------------------------------------
  const tallyByApplicant = new Map<string, { yesCount: number; noCount: number }>();
  for (const vote of votes) {
    const tally = tallyByApplicant.get(vote.applicantId) ?? { yesCount: 0, noCount: 0 };
    if (vote.value === VoteValue.YES) tally.yesCount += 1;
    if (vote.value === VoteValue.NO) tally.noCount += 1;
    tallyByApplicant.set(vote.applicantId, tally);
  }

  const pinnedNames = new Set(
    RECONCILIATION_COHORT.map((pinned) => `${pinned.firstName} ${pinned.lastName}`),
  );
  const pinned = await prisma.applicant.findMany({
    where: { instanceId: SEED_INSTANCE_ID, displayName: { in: [...pinnedNames] } },
    select: { id: true },
  });
  const pinnedIds = new Set(pinned.map((applicant) => applicant.id));

  const advancedIds = chooseSecondRoundCohort({
    applicants: applicants.map((applicant) => ({
      ...applicant,
      ...(tallyByApplicant.get(applicant.applicantId) ?? { yesCount: 0, noCount: 0 }),
    })),
    // Only the pinned applicants who are actually in this round. A pinned
    // applicant rejected in the written round is not resurrected by being named
    // in a fixture.
    alwaysAdvance: new Set(applicantIds.filter((id) => pinnedIds.has(id))),
    advanceCount: SECOND_ROUND_ADVANCE_COUNT,
  });

  const rejectedIds = applicantIds.filter((id) => !advancedIds.has(id));

  await prisma.$transaction(
    async (tx) => {
      // Decision rows over the WHOLE pool, selected or not — FR-15's finalize
      // semantics, stated explicitly in §7.3 rather than left to "mirrors".
      await tx.decision.deleteMany({
        where: { stage: Round.FIRST_ROUND, applicant: { instanceId: SEED_INSTANCE_ID } },
      });
      await tx.decision.createMany({
        data: applicants.map((applicant) => ({
          id: seedId("decision_first", applicant.sourceRowIndex),
          applicantId: applicant.applicantId,
          stage: Round.FIRST_ROUND,
          outcome: advancedIds.has(applicant.applicantId)
            ? DecisionOutcome.ADVANCE
            : DecisionOutcome.REJECT,
          // ADMIN, not SYSTEM: a human made this call on the real screen, and a
          // seed that claimed otherwise would misrepresent who decided. The same
          // choice prisma/seed.ts makes for the written round.
          actor: DecisionActor.ADMIN,
        })),
      });

      await tx.applicant.updateMany({
        where: { id: { in: [...advancedIds] } },
        // stageReached only. They stay ACTIVE — FR-17 defines pass membership as
        // `status = ACTIVE` with no round qualifier, so an applicant reaching the
        // second round must already be ACTIVE.
        data: { stageReached: Round.SECOND_ROUND },
      });

      await tx.applicant.updateMany({
        where: { id: { in: rejectedIds } },
        // stageReached stays FIRST_ROUND: it records how far they got.
        data: { status: ApplicantStatus.REJECTED },
      });

      await tx.instance.update({
        where: { id: SEED_INSTANCE_ID },
        data: { currentStage: InstanceStage.SECOND_ROUND },
      });
    },
    { timeout: 20000 },
  );

  // --- What actually landed -------------------------------------------------
  //
  // Counted from the database rather than from the arrays above, so the summary
  // describes what was written rather than what was intended.
  const [resultCount, categoryScoreCount, notesCount, voteCount, activeCount, secondRoundReviewers] =
    await Promise.all([
      prisma.interviewResult.count({ where: { applicant: { instanceId: SEED_INSTANCE_ID } } }),
      prisma.interviewCategoryScore.count({
        where: { interviewCategory: { instanceId: SEED_INSTANCE_ID } },
      }),
      prisma.interviewNotes.count({ where: { applicant: { instanceId: SEED_INSTANCE_ID } } }),
      prisma.firstRoundVote.count({ where: { applicant: { instanceId: SEED_INSTANCE_ID } } }),
      prisma.applicant.count({
        where: { instanceId: SEED_INSTANCE_ID, status: ApplicantStatus.ACTIVE },
      }),
      prisma.reviewer.count({
        where: { instanceId: SEED_INSTANCE_ID, rounds: { has: Round.SECOND_ROUND } },
      }),
    ]);

  if (categoryScoreCount !== resultCount * INTERVIEW_CATEGORIES.length) {
    throw new Error(
      `Expected ${resultCount * INTERVIEW_CATEGORIES.length} category scores, found ` +
        `${categoryScoreCount}. The previous run's rows did not cascade away.`,
    );
  }

  console.log("");
  console.log(`Advanced "${instance.name}" to the second round`);
  console.log(`  first-round pool      ${pool.length}`);
  console.log(`  interview categories  ${INTERVIEW_CATEGORIES.length}`);
  console.log(`  interview results     ${resultCount} (${categoryScoreCount} category scores)`);
  console.log(
    `  interview notes       ${notesCount} of ${pool.length} — the rest render as "no notes"`,
  );
  console.log(`  first-round votes     ${voteCount} from ${firstRoundReviewers.length} reviewers`);
  console.log(`  advanced              ${advancedIds.size}, rejected ${rejectedIds.length}`);
  console.log(`  ACTIVE applicants     ${activeCount} — FR-17's pass membership`);
  console.log(`  second-round roster   ${secondRoundReviewers} reviewers`);
  console.log(`  interviewer names     ${INTERVIEWERS.length}, free text, not Reviewer rows`);
  console.log("");
  console.log(`  Next: create a pass at /instances/${SEED_INSTANCE_ID}/passes`);
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
