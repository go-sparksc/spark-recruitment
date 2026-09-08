import "dotenv/config";

// Does archive-and-purge actually destroy what §8 says, and keep what it says?
// PRD decisions 94 and 95.
//
// Run with:  npm run check:archive-purge
//        or  npx tsx --conditions=react-server prisma/checks/archive-purge.ts
//
// The `--conditions=react-server` flag is not optional: lib/archive-io.ts
// carries `import "server-only"`. A check that re-implemented the purge would be
// verifying a second copy of the thing under test — and this is the one
// operation in the product with no undo, so a second copy is exactly what must
// not exist.
//
// **This script is destructive, and it is destructive ON PURPOSE against a
// throwaway instance it builds itself.** It never touches the seed instance:
// every row it creates is under a probe id, and it deletes the whole instance at
// the end. It also has to make its throwaway cycle OLD enough to be a candidate,
// which it does by backdating createdAt rather than by lowering
// RETENTION_CYCLES — the threshold is read from the environment and a check that
// changed it would be testing a configuration nobody runs.
//
// **DO NOT RUN THIS AGAINST PRODUCTION.** One effect reaches beyond the probe
// rows and cannot be scoped to them: a real purge ages out orphaned `AuditLog`
// rows — §8's instance-deletion records — by DATE, and this script runs a real
// purge. It keeps that blast radius in 2001 by backdating its filler cycles (see
// `build`), so a live database's records are not touched; the first version
// dated them to `now` and deleted nine real rows on a development database.
// That is a bug this file has already had once, and the reason those rows are
// worth this much comment.

import { Prisma } from "../../generated/prisma/client";
import { ApplicantStatus, FieldCategory, FieldGroupRole, InstanceStage, Round } from "../../generated/prisma/enums";
import { canonicalValue } from "../../lib/export";
import { buildFunnel, type Funnel } from "../../lib/funnel";
import { demographicColumns } from "../../lib/demographics";
import { archiveAndPurge, retentionCycles } from "../../lib/archive-io";
import { purgePlan } from "../../lib/archive";
import { createSeedClient } from "../seed/client";

const prisma = createSeedClient();

const P = "check-archive-";
const INSTANCE = `${P}instance`;
const ACTOR = { actor: "admin", actorName: "SYNTHETIC Check Script" };

let failures = 0;

function pass(label: string, detail: string) {
  console.log(`PASS  ${label}\n        ${detail}`);
}

function fail(label: string, detail: string) {
  failures += 1;
  console.log(`FAIL  ${label}\n        ${detail}`);
}

// ---------------------------------------------------------------------------
// Build a throwaway cycle with something in every column the purge touches
// ---------------------------------------------------------------------------

async function build(): Promise<void> {
  await teardown();

  // Backdated far enough to sit outside any plausible RETENTION_CYCLES. The
  // instance also has to be older than every real instance, since candidacy is
  // by RANK, not by age alone.
  const longAgo = new Date("2000-01-01T00:00:00.000Z");

  await prisma.instance.create({
    data: {
      id: INSTANCE,
      name: "SYNTHETIC Archive Probe",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$probe$probe",
      currentStage: InstanceStage.COMPLETE,
      createdAt: longAgo,
      importCommittedAt: longAgo,
    },
  });

  // Being old is not enough: candidacy is by RANK, so the probe is only a
  // candidate once RETENTION_CYCLES newer cycles exist. On a fresh database the
  // seed instance alone is not enough to push it out of the window, which is how
  // the first run of this script failed.
  //
  // Fillers, rather than lowering RETENTION_CYCLES — the threshold is read from
  // the environment, and a check that changed it would be testing a
  // configuration nobody runs.
  //
  // **Backdated to just after the probe, NOT to now.** The cutoff is the
  // `createdAt` of the oldest RETAINED cycle, and the purge deletes every
  // orphaned audit row older than it. Fillers dated now would push the cutoff to
  // today and age out every orphaned instance-deletion record in the database —
  // real ones, which this script did not create and has no business destroying.
  // The first run of it deleted nine. Dated 2001 the cutoff lands in 2001, which
  // still ages out this script's own 1999 probe row and leaves everything modern
  // alone.
  const fillerCount = retentionCycles();
  await prisma.instance.createMany({
    data: Array.from({ length: fillerCount }, (_, i) => ({
      id: `${P}filler-${i}`,
      name: `SYNTHETIC Filler ${i}`,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$probe$probe",
      currentStage: InstanceStage.WRITTEN,
      // Date.UTC rather than a template string, which would produce "2001-010-01"
      // for a threshold above 9.
      createdAt: new Date(Date.UTC(2001, i, 1)),
    })),
  });

  // An ethnicity group with two options and a write-in, so the frozen funnel has
  // real §10.7 weighting in it rather than a single trivial column.
  await prisma.fieldGroup.create({
    data: {
      id: `${P}group`,
      instanceId: INSTANCE,
      key: "ethnicity",
      displayName: "Ethnicity",
      category: FieldCategory.DEMOGRAPHIC,
      isMultiSelect: true,
      ordinal: 1,
    },
  });

  await prisma.field.createMany({
    data: [
      { id: `${P}f_asian`, instanceId: INSTANCE, sourceHeader: "East Asian", displayName: "East Asian", category: FieldCategory.DEMOGRAPHIC, ordinal: 1, groupId: `${P}group`, groupRole: FieldGroupRole.OPTION },
      { id: `${P}f_black`, instanceId: INSTANCE, sourceHeader: "Black", displayName: "Black", category: FieldCategory.DEMOGRAPHIC, ordinal: 2, groupId: `${P}group`, groupRole: FieldGroupRole.OPTION },
      { id: `${P}f_write`, instanceId: INSTANCE, sourceHeader: "Self-describe", displayName: "Self-describe", category: FieldCategory.DEMOGRAPHIC, ordinal: 3, groupId: `${P}group`, groupRole: FieldGroupRole.FREE_TEXT },
      { id: `${P}f_essay`, instanceId: INSTANCE, sourceHeader: "Why Spark?", displayName: "Why Spark?", category: FieldCategory.RESPONSE, ordinal: 4 },
    ],
  });

  await prisma.rubricCategory.create({
    data: { id: `${P}rubric`, instanceId: INSTANCE, name: "Motivation", maxPoints: 4, ordinal: 1 },
  });

  await prisma.roundAccessCode.create({
    data: { id: `${P}code`, instanceId: INSTANCE, round: Round.WRITTEN, codeHash: "$argon2id$v=19$m=19456,t=2,p=1$probe$probe" },
  });

  await prisma.reviewer.create({
    data: { id: `${P}rev`, instanceId: INSTANCE, firstName: "SYNTHETIC", lastName: "Reviewer", isSparklet: false, rounds: [Round.WRITTEN] },
  });

  // Three applicants: a Sparklet, a rejection, and one still active. Each with
  // an essay, an email, and demographic answers -- all three of §8's categories.
  const applicants = [
    { id: `${P}a1`, row: 1, status: ApplicantStatus.SPARKLET, stage: Round.SECOND_ROUND, data: { [`${P}f_asian`]: "East Asian", [`${P}f_essay`]: "SYNTHETIC essay one" } },
    { id: `${P}a2`, row: 2, status: ApplicantStatus.REJECTED, stage: Round.FIRST_ROUND, data: { [`${P}f_black`]: "Black", [`${P}f_essay`]: "SYNTHETIC essay two" } },
    { id: `${P}a3`, row: 3, status: ApplicantStatus.ACTIVE, stage: Round.WRITTEN, data: { [`${P}f_asian`]: "East Asian", [`${P}f_black`]: "Black", [`${P}f_write`]: "SYNTHETIC write-in", [`${P}f_essay`]: "SYNTHETIC essay three" } },
  ];

  for (const applicant of applicants) {
    await prisma.applicant.create({
      data: {
        id: applicant.id,
        instanceId: INSTANCE,
        sourceRowIndex: applicant.row,
        email: `${applicant.id}@example.com`,
        displayName: `SYNTHETIC Person ${applicant.row}`,
        data: applicant.data,
        status: applicant.status,
        stageReached: applicant.stage,
      },
    });
  }

  // The verbatim-CSV copies, which are the ones most easily forgotten.
  await prisma.importRow.create({
    data: { id: `${P}import`, instanceId: INSTANCE, rowIndex: 1, cells: { "0": "SYNTHETIC verbatim essay", "1": "a1@example.com" } },
  });

  // An assignment with a score and a note, so the purge can be shown keeping the
  // score while deleting the note.
  await prisma.assignment.create({
    data: { id: `${P}asg`, instanceId: INSTANCE, round: Round.WRITTEN, applicantId: `${P}a1`, reviewerId: `${P}rev` },
  });
  await prisma.score.create({
    data: { id: `${P}score`, assignmentId: `${P}asg`, rubricCategoryId: `${P}rubric`, points: 3 },
  });
  await prisma.reviewNote.create({
    data: { id: `${P}note`, assignmentId: `${P}asg`, body: "SYNTHETIC free text about an applicant" },
  });
  await prisma.interviewNotes.create({
    data: { id: `${P}inotes`, applicantId: `${P}a1`, interviewerName: "SYNTHETIC Interviewer", body: "SYNTHETIC interview note" },
  });

  // An audit row whose previousValue carries applicant data, which is exactly
  // what §8 says these payloads can do.
  await prisma.auditLog.create({
    data: {
      id: `${P}audit`,
      instanceId: INSTANCE,
      actor: "admin",
      actorName: "SYNTHETIC Check Script",
      action: "MANUAL_REJECT",
      entityType: "Applicant",
      entityId: `${P}a1`,
      previousValue: { displayName: "SYNTHETIC Person 1", email: "a1@example.com" },
    },
  });

  // An ORPHANED audit row, older than any plausible cutoff. §8 requires these
  // age out on the same threshold or they accumulate forever.
  await prisma.auditLog.create({
    data: {
      id: `${P}orphan`,
      instanceId: null,
      actor: "admin",
      actorName: null,
      action: "DELETE_INSTANCE",
      entityType: "Instance",
      entityId: `${P}long-gone`,
      previousValue: { name: "SYNTHETIC Deleted Cycle" },
      createdAt: new Date("1999-01-01T00:00:00.000Z"),
    },
  });
}

/// The funnel as FR-19 would have rendered it, before anything is purged.
async function funnelBeforePurge(): Promise<Funnel> {
  const [applicants, fields, groups] = await Promise.all([
    prisma.applicant.findMany({
      where: { instanceId: INSTANCE },
      select: { id: true, data: true, stageReached: true, status: true },
    }),
    prisma.field.findMany({
      where: { instanceId: INSTANCE },
      orderBy: { ordinal: "asc" },
      select: { id: true, displayName: true, ordinal: true, category: true, isIncluded: true, groupId: true, groupRole: true, isReviewerVisible: true },
    }),
    prisma.fieldGroup.findMany({
      where: { instanceId: INSTANCE },
      select: { id: true, displayName: true, ordinal: true, category: true, isIncluded: true, isReviewerVisible: true },
    }),
  ]);

  return buildFunnel(
    applicants.map((a) => ({ id: a.id, data: a.data as Record<string, unknown>, stageReached: a.stageReached, status: a.status })),
    demographicColumns(fields, groups, "ADMIN"),
  );
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function checkNothingPersonalSurvives() {
  const [withEmail, withData, importRows, interviewRows, notes, interviewNotes, codes, payloads] =
    await Promise.all([
      prisma.applicant.count({ where: { instanceId: INSTANCE, email: { not: null } } }),
      prisma.applicant.count({ where: { instanceId: INSTANCE, NOT: { data: { equals: {} } } } }),
      prisma.importRow.count({ where: { instanceId: INSTANCE } }),
      prisma.interviewImportRow.count({ where: { instanceId: INSTANCE } }),
      prisma.reviewNote.count({ where: { assignment: { instanceId: INSTANCE } } }),
      prisma.interviewNotes.count({ where: { applicant: { instanceId: INSTANCE } } }),
      prisma.roundAccessCode.count({ where: { instanceId: INSTANCE } }),
      // Every payload EXCEPT the purge's own row, which is written last
      // precisely so the nulling cannot erase it (decision 95) and whose payload
      // is row counts. Counting it here would assert against the design rather
      // than for it — the first run of this script did exactly that. That the
      // row's payload holds nothing personal is asserted separately below.
      prisma.auditLog.count({
        where: {
          instanceId: INSTANCE,
          action: { not: "ARCHIVE_AND_PURGE" },
          // Prisma.DbNull, not null: for a nullable Json column `null` is
          // ambiguous between "SQL NULL" and "the JSON value null", and Prisma
          // refuses it at the type level. tsx does not typecheck, so this ran
          // green before `npm run typecheck` saw it.
          NOT: { previousValue: { equals: Prisma.DbNull } },
        },
      }),
    ]);

  const leftovers = { withEmail, withData, importRows, interviewRows, notes, interviewNotes, codes, payloads };
  const bad = Object.entries(leftovers).filter(([, count]) => count > 0);

  if (bad.length === 0) {
    pass(
      "nothing personal survives the purge",
      `zero of: email, non-empty data, ImportRow, InterviewImportRow, ReviewNote, InterviewNotes, RoundAccessCode, AuditLog.previousValue`,
    );
  } else {
    fail(
      "nothing personal survives the purge",
      `still present: ${bad.map(([k, v]) => `${k}=${v}`).join(", ")}`,
    );
  }
}

async function checkDisplayNamesAreAnonymised() {
  const applicants = await prisma.applicant.findMany({
    where: { instanceId: INSTANCE },
    select: { displayName: true, sourceRowIndex: true },
    orderBy: { sourceRowIndex: "asc" },
  });

  const wrong = applicants.filter((a) => a.displayName !== `Applicant ${a.sourceRowIndex}`);

  if (wrong.length === 0 && applicants.length === 3) {
    pass(
      "display names become the anonymous label",
      `all ${applicants.length} read "Applicant <sourceRowIndex>" — the label written reviewers already see, so a non-null column stays meaningful`,
    );
  } else {
    fail(
      "display names become the anonymous label",
      `${wrong.length} of ${applicants.length} wrong: ${JSON.stringify(wrong.slice(0, 3))}`,
    );
  }
}

async function checkAggregatesAreKept() {
  const [scores, assignments, applicants, reviewers, rubric, fields] = await Promise.all([
    prisma.score.count({ where: { assignment: { instanceId: INSTANCE } } }),
    prisma.assignment.count({ where: { instanceId: INSTANCE } }),
    prisma.applicant.count({ where: { instanceId: INSTANCE } }),
    prisma.reviewer.count({ where: { instanceId: INSTANCE } }),
    prisma.rubricCategory.count({ where: { instanceId: INSTANCE } }),
    prisma.field.count({ where: { instanceId: INSTANCE } }),
  ]);

  const expected = { scores: 1, assignments: 1, applicants: 3, reviewers: 1, rubric: 1, fields: 4 };
  const actual = { scores, assignments, applicants, reviewers, rubric, fields };

  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass(
      "the retained aggregates are untouched",
      `${JSON.stringify(actual)} — a purge that took Score or Applicant with it would leave a summary nothing could corroborate`,
    );
  } else {
    fail("the retained aggregates are untouched", `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function checkSummaryReproducesTheFunnel(before: Funnel) {
  const instance = await prisma.instance.findUnique({
    where: { id: INSTANCE },
    select: { archivedAt: true, archiveSummary: true },
  });

  const summary = instance?.archiveSummary as { funnel?: Funnel; cohortSizes?: Record<string, number> } | null;

  if (!instance?.archivedAt || !summary?.funnel) {
    fail("the frozen summary reproduces the pre-purge funnel", "no summary was written");
    return;
  }

  // Cell for cell. This is the assertion the whole design exists for: recomputing
  // the funnel now would give zeros, because Applicant.data is {}.
  //
  // Canonicalized first. The frozen copy has been through Postgres `jsonb`,
  // which does not preserve object key order — comparing the raw JSON text
  // reports a difference for two identical funnels, which is the same trap
  // lib/export.ts documents and solves with this function.
  const same =
    JSON.stringify(canonicalValue(summary.funnel, "frozen")) ===
    JSON.stringify(canonicalValue(before as unknown, "before"));

  if (same) {
    const ethnicity = before.columns.find((c) => c.label === "Ethnicity");
    pass(
      "the frozen summary reproduces the pre-purge funnel",
      `identical cell for cell; cohort sizes ${JSON.stringify(summary.cohortSizes)}, ` +
        `${ethnicity?.rows.length ?? 0} ethnicity rows preserved after the data behind them was deleted`,
    );
  } else {
    fail(
      "the frozen summary reproduces the pre-purge funnel",
      `the frozen funnel differs from what FR-19 rendered before the purge.\n` +
        `        before: ${JSON.stringify(before).slice(0, 300)}\n` +
        `        frozen: ${JSON.stringify(summary.funnel).slice(0, 300)}`,
    );
  }
}

async function checkSummaryCarriesNothingPersonal() {
  const instance = await prisma.instance.findUnique({
    where: { id: INSTANCE },
    select: { archiveSummary: true },
  });

  const json = JSON.stringify(instance?.archiveSummary ?? {});
  const leaks = ["SYNTHETIC essay", "SYNTHETIC Person", "@example.com", "SYNTHETIC write-in"].filter((needle) =>
    json.includes(needle),
  );

  if (leaks.length === 0) {
    pass(
      "the frozen summary carries no applicant data",
      "no essay, name, email or write-in appears in it — the summary outlives the purge and must not reintroduce what it removed",
    );
  } else {
    fail("the frozen summary carries no applicant data", `found: ${leaks.join(", ")}`);
  }
}

async function checkOrphanedAuditRowsAgeOut() {
  const orphan = await prisma.auditLog.findUnique({ where: { id: `${P}orphan` } });

  if (orphan === null) {
    pass(
      "orphaned audit rows age out on the same threshold",
      "the 1999 instance-deletion record is gone — §8 requires these not accumulate forever",
    );
  } else {
    fail(
      "orphaned audit rows age out on the same threshold",
      `the orphaned row from ${orphan.createdAt.toISOString()} survived the purge`,
    );
  }
}

async function checkThePurgeItselfIsAudited() {
  const rows = await prisma.auditLog.findMany({
    where: { instanceId: INSTANCE, action: "ARCHIVE_AND_PURGE" },
  });

  // The one payload the purge deliberately leaves behind, so it gets the same
  // scrutiny the frozen summary does: counts only, never content, because this
  // row outlives the purge and must not reintroduce what it removed.
  const payload = JSON.stringify(rows[0]?.previousValue ?? {});
  const leaks = ["SYNTHETIC essay", "SYNTHETIC Person", "@example.com", "SYNTHETIC write-in"].filter(
    (needle) => payload.includes(needle),
  );

  if (leaks.length > 0) {
    fail("the purge writes its own audit row, and it survives", `its payload leaks: ${leaks.join(", ")}`);
  } else if (rows.length === 1 && rows[0].previousValue !== null) {
    pass(
      "the purge writes its own audit row, and it survives",
      `actorName=${JSON.stringify(rows[0].actorName)}, payload=${payload} — ` +
        `written last, so the previousValue nulling could not erase it; counts only, no content`,
    );
  } else {
    fail(
      "the purge writes its own audit row, and it survives",
      `expected exactly 1 row with a payload, found ${rows.length} with payload ` +
        `${JSON.stringify(rows[0]?.previousValue ?? null)}. Written before the nulling step, it would be blank.`,
    );
  }
}

/// The case that would otherwise destroy data silently.
async function checkSecondPurgeIsRefused() {
  const before = await prisma.instance.findUnique({
    where: { id: INSTANCE },
    select: { archivedAt: true, archiveSummary: true },
  });
  const auditBefore = await prisma.auditLog.count({
    where: { instanceId: INSTANCE, action: "ARCHIVE_AND_PURGE" },
  });

  const result = await archiveAndPurge(INSTANCE, ACTOR);

  const after = await prisma.instance.findUnique({
    where: { id: INSTANCE },
    select: { archivedAt: true, archiveSummary: true },
  });
  const auditAfter = await prisma.auditLog.count({
    where: { instanceId: INSTANCE, action: "ARCHIVE_AND_PURGE" },
  });

  const refused = !result.ok && result.reason === "ALREADY_ARCHIVED";
  const timestampHeld = before?.archivedAt?.getTime() === after?.archivedAt?.getTime();
  // The assertion that matters. A refusal that still overwrote the summary would
  // pass the first two and destroy the numbers anyway.
  const summaryHeld = JSON.stringify(before?.archiveSummary) === JSON.stringify(after?.archiveSummary);

  if (refused && timestampHeld && summaryHeld && auditBefore === auditAfter) {
    pass(
      "a second purge is refused, and changes nothing",
      `reason=${(result as { reason: string }).reason}; archivedAt unchanged, ` +
        `archiveSummary byte-identical, no second ARCHIVE_AND_PURGE row`,
    );
  } else {
    fail(
      "a second purge is refused, and changes nothing",
      `refused=${refused}, archivedAt held=${timestampHeld}, summary held=${summaryHeld}, ` +
        `audit rows ${auditBefore}->${auditAfter}. A second run recomputes the summary against ` +
        `the emptied data and overwrites correct numbers with zeros.`,
    );
  }
}

async function checkPurgePlanMatchesWhatRan() {
  // The plan is the documentation; this is what keeps it honest. Every table the
  // plan says is DELETEd must now be empty for this instance.
  const counts: Record<string, number> = {
    ImportRow: await prisma.importRow.count({ where: { instanceId: INSTANCE } }),
    InterviewImportRow: await prisma.interviewImportRow.count({ where: { instanceId: INSTANCE } }),
    ReviewNote: await prisma.reviewNote.count({ where: { assignment: { instanceId: INSTANCE } } }),
    InterviewNotes: await prisma.interviewNotes.count({ where: { applicant: { instanceId: INSTANCE } } }),
    RoundAccessCode: await prisma.roundAccessCode.count({ where: { instanceId: INSTANCE } }),
  };

  const deletes = purgePlan().filter((step) => step.action === "DELETE").map((step) => step.table);
  const unmet = deletes.filter((table) => (counts[table] ?? 0) > 0);
  const unchecked = deletes.filter((table) => !(table in counts));

  if (unmet.length === 0 && unchecked.length === 0) {
    pass(
      "every DELETE the plan names actually happened",
      `${deletes.join(", ")} — all empty for this instance`,
    );
  } else {
    fail(
      "every DELETE the plan names actually happened",
      `still populated: ${unmet.join(", ") || "none"}; not asserted here: ${unchecked.join(", ") || "none"}`,
    );
  }
}

// ---------------------------------------------------------------------------

async function teardown() {
  // Audit rows FIRST, and matched on entityId rather than on instanceId.
  //
  // `AuditLog.instanceId` is ON DELETE SET NULL, not CASCADE — deliberately, so
  // §8's instance-deletion record outlives the instance it describes. That means
  // deleting the instance ORPHANS its audit rows rather than removing them, so a
  // teardown that cleared orphans first and deleted the instance second would
  // create the very rows it had just cleaned up. (It did, on the first run of
  // this script.) Matching on the probe prefix catches them in both states.
  await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: P } } });
  await prisma.instance.deleteMany({ where: { id: { startsWith: P } } });
}

async function confirmRestored() {
  const [instances, orphans] = await Promise.all([
    prisma.instance.count({ where: { id: { startsWith: P } } }),
    prisma.auditLog.count({ where: { entityId: { startsWith: P } } }),
  ]);

  if (instances === 0 && orphans === 0) {
    console.log("Cleanup     verified — no probe rows remain");
  } else {
    failures += 1;
    console.log(`Cleanup     FAILED — ${instances} instance(s) and ${orphans} orphaned audit row(s) remain`);
  }
}

async function main() {
  console.log(`RETENTION_CYCLES  ${retentionCycles()} (read from the environment, not overridden)`);
  console.log("");

  await build();

  const before = await funnelBeforePurge();
  console.log(`Before purge      cohort sizes ${JSON.stringify(before.cohortSizes)}`);
  console.log("");

  const result = await archiveAndPurge(INSTANCE, ACTOR);

  if (!result.ok) {
    fail("the purge runs at all", `refused: ${result.reason} — ${result.message}`);
    return;
  }
  pass("the purge runs", `removed ${JSON.stringify(result.removed)}`);

  await checkNothingPersonalSurvives();
  await checkDisplayNamesAreAnonymised();
  await checkAggregatesAreKept();
  await checkSummaryReproducesTheFunnel(before);
  await checkSummaryCarriesNothingPersonal();
  await checkOrphanedAuditRowsAgeOut();
  await checkThePurgeItselfIsAudited();
  await checkPurgePlanMatchesWhatRan();
  await checkSecondPurgeIsRefused();
}

main()
  .catch((error) => {
    failures += 1;
    console.error("\nUnexpected error:", error);
  })
  .finally(async () => {
    try {
      await teardown();
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
