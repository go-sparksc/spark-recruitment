import Link from "next/link";
import { notFound } from "next/navigation";

import { FirstRoundResultsTable } from "./results-table";
import { InstanceCrumbs } from "../instance-crumbs";
import { InstanceStage } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { columnLabels, demographicColumns } from "@/lib/demographics";
import type { ApplicantData } from "@/lib/field-groups";
import { buildFirstRoundResultRows } from "@/lib/first-round";
import { prisma } from "@/lib/prisma";

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

  const rows = buildFirstRoundResultRows(
    applicants.map((applicant) => ({
      id: applicant.id,
      displayName: applicant.displayName,
      sourceRowIndex: applicant.sourceRowIndex,
      data: applicant.data as ApplicantData,
      status: applicant.status,
      stageReached: applicant.stageReached,
      votes: applicant.firstRoundVotes.map((vote) => vote.value),
    })),
    columns,
  );

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
