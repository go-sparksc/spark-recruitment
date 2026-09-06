// Decision 100's database check: a conflict flagged after the round has closed
// must not move what FR-19 shows for the final pass.
//
// Run with:  npm run check:closed-pass-conflicts
//        or  npx tsx --conditions=react-server prisma/checks/closed-pass-conflicts.ts [instanceId]
//
// FR-19 is read through `loadFinalPage`, the loader the page itself calls, so
// the wiring under test is the wiring in production rather than a second copy
// of it — the same reason round-trip.ts imports lib/instance-io.ts instead of
// re-implementing its reads. `--conditions=react-server` is what lets a
// `server-only` module load here. FR-18's grid is a page component and cannot
// be imported by a script; it reads through the same `conflictsInForce` helper,
// which the typecheck enforces and lib/passes.test.ts covers.
//
// Needs a COMPLETE instance whose final pass is closed and carries votes — the
// seeded instance after `npm run seed:passes`. It writes ONE ConflictOfInterest
// row under a fixed id and deletes it again by that id, verifying the deletion.
// Blast radius is that one row: nothing here is date-, rank- or
// threshold-driven (see CLAUDE.md's note on archive-purge), and the cleanup
// predicate is the id, never a range.
//
// The negative control is what makes the main assertion mean something: the
// same tally read the pre-100 way — the round's whole conflict set — must MOVE
// under the probe conflict. If it does not, the probe never touched the
// applicant's tally and "unchanged" proves nothing.

import "dotenv/config";

import { loadFinalPage } from "../../app/instances/[id]/final/load";
import { PassStatus, Round } from "../../generated/prisma/enums";
import { buildPassGrid, type PassTally } from "../../lib/passes";
import { SEED_INSTANCE_ID, createSeedClient } from "../seed/client";

const prisma = createSeedClient();

const instanceId = process.argv[2] ?? SEED_INSTANCE_ID;

/// Fixed and unmistakable, so a run interrupted before cleanup leaves a row the
/// next run recognises and removes first.
const PROBE_CONFLICT_ID = "check_closed_pass_conflict_probe";

let failures = 0;

function pass(label: string, detail: string) {
  console.log(`PASS  ${label}\n        ${detail}`);
}

function fail(label: string, detail: string) {
  failures += 1;
  console.log(`FAIL  ${label}\n        ${detail}`);
}

const describeTally = (tally: PassTally) =>
  `yes ${tally.yes} / no ${tally.no} / skip ${tally.skip} / outstanding ${tally.outstanding} / eligible ${tally.eligible}`;

async function main() {
  // A leftover from an interrupted run goes first, so this run starts clean.
  await prisma.conflictOfInterest.deleteMany({ where: { id: PROBE_CONFLICT_ID } });

  const finalPass = await prisma.pass.findFirst({
    where: { instanceId },
    orderBy: { ordinal: "desc" },
    select: { id: true, ordinal: true, status: true, closedAt: true },
  });

  if (!finalPass || finalPass.status !== PassStatus.CLOSED || finalPass.closedAt === null) {
    fail(
      "a closed final pass exists",
      `instance ${instanceId} has ${finalPass ? `pass ${finalPass.ordinal} in status ${finalPass.status}` : "no pass"}; run npm run seed:passes first`,
    );
    return;
  }
  const closedAt = finalPass.closedAt;

  // A (applicant, reviewer) pair with a stored vote in the final pass and no
  // conflict today: the probe conflict has to land on a vote that counts, or
  // the negative control cannot move.
  const [votes, conflicts] = await Promise.all([
    prisma.passVote.findMany({
      where: { passId: finalPass.id },
      orderBy: [{ applicantId: "asc" }, { reviewerId: "asc" }],
      select: { applicantId: true, reviewerId: true },
    }),
    prisma.conflictOfInterest.findMany({
      where: { round: Round.SECOND_ROUND, applicant: { instanceId } },
      select: { applicantId: true, reviewerId: true },
    }),
  ]);
  const conflicted = new Set(conflicts.map((c) => `${c.applicantId}:${c.reviewerId}`));
  const probe = votes.find((vote) => !conflicted.has(`${vote.applicantId}:${vote.reviewerId}`));

  if (!probe) {
    fail("a votable pair exists", `pass ${finalPass.ordinal} has no vote without a conflict on it`);
    return;
  }

  const before = await loadFinalPage(instanceId);
  const tallyBefore = before.sources.find((source) => source.id === probe.applicantId)?.tally;
  if (!tallyBefore) {
    fail("FR-19 carries a tally for the probe applicant", `applicant ${probe.applicantId} has none`);
    return;
  }

  try {
    await prisma.conflictOfInterest.create({
      data: {
        id: PROBE_CONFLICT_ID,
        round: Round.SECOND_ROUND,
        applicantId: probe.applicantId,
        reviewerId: probe.reviewerId,
      },
    });

    // createdAt defaults to now(). Asserted rather than assumed: a pass closed
    // in the same second as this run would make the probe meaningless.
    const created = await prisma.conflictOfInterest.findUnique({
      where: { id: PROBE_CONFLICT_ID },
      select: { createdAt: true },
    });
    if (!created || created.createdAt.getTime() <= closedAt.getTime()) {
      fail(
        "the probe conflict postdates the close",
        `createdAt ${created?.createdAt.toISOString() ?? "missing"} against closedAt ${closedAt.toISOString()}`,
      );
      return;
    }
    pass(
      "the probe conflict postdates the close",
      `flagged ${created.createdAt.toISOString()}, pass ${finalPass.ordinal} closed ${closedAt.toISOString()}`,
    );

    const after = await loadFinalPage(instanceId);
    const tallyAfter = after.sources.find((source) => source.id === probe.applicantId)?.tally;

    if (tallyAfter && JSON.stringify(tallyAfter) === JSON.stringify(tallyBefore)) {
      pass(
        "FR-19's tally does not move under a post-close conflict",
        `applicant ${probe.applicantId}: ${describeTally(tallyBefore)} before and after`,
      );
    } else {
      fail(
        "FR-19's tally does not move under a post-close conflict",
        `before ${describeTally(tallyBefore)}; after ${tallyAfter ? describeTally(tallyAfter) : "missing"}`,
      );
    }

    // Negative control: the pre-100 read, with the round's whole conflict set,
    // must move — one more skip, one fewer eligible — or the probe proved nothing.
    const [roster, applicantVotes, applicantConflicts] = await Promise.all([
      prisma.reviewer.findMany({
        where: { instanceId, rounds: { has: Round.SECOND_ROUND } },
        select: { id: true },
      }),
      prisma.passVote.findMany({
        where: { passId: finalPass.id, applicantId: probe.applicantId },
        select: { applicantId: true, reviewerId: true, value: true },
      }),
      prisma.conflictOfInterest.findMany({
        where: { round: Round.SECOND_ROUND, applicantId: probe.applicantId },
        select: { applicantId: true, reviewerId: true },
      }),
    ]);
    const unscoped = buildPassGrid({
      reviewerIds: roster.map((reviewer) => reviewer.id),
      applicantIds: [probe.applicantId],
      votes: applicantVotes,
      conflicts: applicantConflicts,
    }).rows[0].tally;

    if (unscoped.skip === tallyBefore.skip + 1 && unscoped.eligible === tallyBefore.eligible - 1) {
      pass(
        "negative control: the unscoped read moves",
        `read the pre-100 way the same applicant is ${describeTally(unscoped)}`,
      );
    } else {
      fail(
        "negative control: the unscoped read moves",
        `expected skip ${tallyBefore.skip + 1} and eligible ${tallyBefore.eligible - 1}; got ${describeTally(unscoped)}`,
      );
    }
  } finally {
    await prisma.conflictOfInterest.deleteMany({ where: { id: PROBE_CONFLICT_ID } });
    const left = await prisma.conflictOfInterest.count({ where: { id: PROBE_CONFLICT_ID } });
    if (left === 0) {
      pass("cleanup", `probe conflict ${PROBE_CONFLICT_ID} removed`);
    } else {
      fail("cleanup", `${left} probe conflict row(s) still present under ${PROBE_CONFLICT_ID}`);
    }
  }
}

main()
  .catch((error) => {
    failures += 1;
    console.error(error);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
