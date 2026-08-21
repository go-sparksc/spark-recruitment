import Link from "next/link";
import { notFound } from "next/navigation";

import { FirstRoundResultsTable, type FirstRoundResultRow } from "./results-table";
import { InstanceCrumbs } from "../instance-crumbs";
import { InstanceStage, VoteValue } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { applicantDemographics, columnLabels, demographicColumns } from "@/lib/demographics";
import type { ApplicantData } from "@/lib/field-groups";
import { FIRST_ROUND_POOL } from "@/lib/first-round";
import { prisma } from "@/lib/prisma";
import { firstRoundSummary, rankFirstRound } from "@/lib/results";

export const metadata = { title: "First round results — Spark SC Recruitment" };

/// FR-15. Ranked by yes percentage, selection, finalize.
export default async function FirstRoundResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireInstance(id, `/instances/${id}/first-round-results`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true, name: true, currentStage: true },
  });
  if (!instance) notFound();

  const [applicants, fields, groups] = await Promise.all([
    prisma.applicant.findMany({
      // Everyone the first round decided on — the current pool, plus those
      // already advanced or rejected by a finalize that has happened. Ranking
      // only the live pool would empty this page the moment it was finalized,
      // and FR-15's results are what an admin revisits afterwards.
      where: { instanceId: id, stageReached: { not: "WRITTEN" } },
      select: {
        id: true,
        displayName: true,
        sourceRowIndex: true,
        data: true,
        status: true,
        stageReached: true,
        firstRoundVotes: { select: { value: true } },
      },
    }),
    prisma.field.findMany({
      where: { instanceId: id },
      orderBy: { ordinal: "asc" },
      select: {
        id: true,
        displayName: true,
        ordinal: true,
        category: true,
        isIncluded: true,
        groupId: true,
        groupRole: true,
        visibleToWrittenReviewer: true,
        visibleToFirstRoundReviewer: true,
      },
    }),
    prisma.fieldGroup.findMany({
      where: { instanceId: id },
      orderBy: { ordinal: "asc" },
      select: {
        id: true,
        displayName: true,
        ordinal: true,
        category: true,
        isIncluded: true,
        visibleToWrittenReviewer: true,
        visibleToFirstRoundReviewer: true,
      },
    }),
  ]);

  const header = (
    <div className="space-y-1">
      <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />
      <h1 className="text-2xl font-semibold">First round results</h1>
      <p className="text-muted-foreground text-sm">
        Ranked by yes percentage, skips excluded ·{" "}
        <Link href={`/instances/${id}/interviews`} className="hover:underline">
          Interview import
        </Link>
      </p>
    </div>
  );

  const shell = "mx-auto w-full max-w-5xl space-y-8 px-6 py-12";

  if (applicants.length === 0) {
    return (
      <main className={shell}>
        {header}
        <p className="text-muted-foreground rounded-md border p-4 text-sm">
          No applicant has reached the first round yet.{" "}
          <Link href={`/instances/${id}/results`} className="underline">
            Finalize the written round
          </Link>{" "}
          first.
        </p>
      </main>
    );
  }

  const columns = demographicColumns(fields, groups, "ADMIN");

  const scored = applicants.map((applicant) => {
    // A SKIP row is not written in this round, but the column permits one and
    // the second round writes them. Counted into neither side rather than
    // asserted away — a skip belongs in no part of yes/(yes+no).
    const yesCount = applicant.firstRoundVotes.filter((v) => v.value === VoteValue.YES).length;
    const noCount = applicant.firstRoundVotes.filter((v) => v.value === VoteValue.NO).length;

    return {
      id: applicant.id,
      displayName: applicant.displayName,
      sourceRowIndex: applicant.sourceRowIndex,
      ...firstRoundSummary({ yesCount, noCount }),
      selections: Object.fromEntries(
        Object.entries(
          applicantDemographics(applicant.data as ApplicantData, columns),
        ).map(([key, cell]) => [key, cell.selected]),
      ),
      // The same predicate the reviewer dashboard and the finalize action use.
      inPool:
        applicant.status === FIRST_ROUND_POOL.status &&
        applicant.stageReached === FIRST_ROUND_POOL.stageReached,
    };
  });

  // Rank over everyone the round decided on, then number them. The rank a row
  // carries is its place in the cohort, not its position in a filtered view —
  // same reasoning FR-10's page uses.
  const rows: FirstRoundResultRow[] = rankFirstRound(scored).map((row, index) => ({
    ...row,
    rank: index + 1,
  }));

  // Clause 15j, and the server half of it. A client's copy of the stage is only
  // as fresh as the payload it arrived in, so a tab left open across a finalize
  // would keep offering checkboxes over a decision already made. The action
  // re-checks the same field.
  const selectable = instance.currentStage === InstanceStage.FIRST_ROUND;

  return (
    <main className={shell}>
      {header}

      {!selectable ? (
        <p className="text-muted-foreground rounded-md border p-4 text-sm">
          {instance.currentStage === InstanceStage.WRITTEN
            ? "The written round has not been finalized yet, so nobody is in the first round to decide on."
            : "The first round has been finalized. These results stay here for reference."}
        </p>
      ) : null}

      <FirstRoundResultsTable
        instanceId={id}
        rows={rows}
        columns={columns.map((column) => ({
          key: column.key,
          label: column.label,
          labels: columnLabels(column),
        }))}
        selectable={selectable}
      />
    </main>
  );
}
