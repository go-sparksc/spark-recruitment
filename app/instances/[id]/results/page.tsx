import Link from "next/link";
import { notFound } from "next/navigation";

import { InstanceCrumbs } from "../instance-crumbs";
import { ResultsTable, type ResultRow } from "./results-table";
import { ApplicantStatus, AssignmentStatus, InstanceStage, Round } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { applicantDemographics, columnLabels, demographicColumns } from "@/lib/demographics";
import type { ApplicantData } from "@/lib/field-groups";
import { planShape } from "@/lib/assignment";
import { prisma } from "@/lib/prisma";
import {
  applyResultFilters,
  parseVarianceThreshold,
  rankApplicants,
  reviewerAverage,
  scoreSummary,
} from "@/lib/results";

export const metadata = { title: "Written results — Spark SC Recruitment" };

const ROUND = Round.WRITTEN;

export default async function ResultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ only?: string; minVar?: string }>;
}) {
  const { id } = await params;
  const { only, minVar } = await searchParams;
  await requireInstance(id, `/instances/${id}/results`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      currentStage: true,
      _count: { select: { applicants: true, rubricCategories: true } },
    },
  });
  if (!instance) notFound();

  const header = (
    <div className="space-y-1">
      <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />
      <h1 className="text-2xl font-semibold">Written results</h1>
      <p className="text-muted-foreground text-sm">
        Written round
        {" · "}
        <Link href={`/instances/${id}/assignments`} className="hover:underline">
          Assignments
        </Link>
      </p>
    </div>
  );

  const shell = "mx-auto w-full max-w-6xl space-y-8 px-6 py-12";

  if (instance._count.applicants === 0) {
    return (
      <main className={shell}>
        {header}
        <p className="text-muted-foreground rounded-md border p-4 text-sm">
          This instance has no applicants yet. Import the CSV first — there is nothing to rank.
        </p>
      </main>
    );
  }

  if (instance._count.rubricCategories === 0) {
    return (
      <main className={shell}>
        {header}
        <p className="text-muted-foreground rounded-md border p-4 text-sm">
          No rubric yet, so there is nothing to score against.{" "}
          <Link href={`/instances/${id}/rubric`} className="underline">
            Build the rubric
          </Link>
          .
        </p>
      </main>
    );
  }

  const [applicants, fields, groups, reviewerCount] = await Promise.all([
    prisma.applicant.findMany({
      where: { instanceId: id },
      select: {
        id: true,
        sourceRowIndex: true,
        displayName: true,
        data: true,
        status: true,
        stageReached: true,
        assignments: {
          where: { round: ROUND, status: AssignmentStatus.ACTIVE },
          select: { scores: { select: { points: true } } },
        },
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
    prisma.reviewer.count({ where: { instanceId: id, rounds: { has: ROUND } } }),
  ]);

  // FR-7's arithmetic, not a literal 3, so the denominator on this page and the
  // one the generator staffed to cannot disagree. On a roster smaller than three
  // the target is smaller and 2/2 is complete.
  const { target } = planShape(applicants.length, reviewerCount);
  const categoryCount = instance._count.rubricCategories;

  const columns = demographicColumns(fields, groups, "ADMIN");

  const rows: ResultRow[] = applicants.map((applicant) => {
    const averages = applicant.assignments
      .map((assignment) => reviewerAverage(assignment.scores.map((s) => s.points), categoryCount))
      .filter((value): value is number => value !== null);

    return {
      id: applicant.id,
      sourceRowIndex: applicant.sourceRowIndex,
      displayName: applicant.displayName,
      ...scoreSummary(averages),
      demographics: applicantDemographics(applicant.data as ApplicantData, columns),
    };
  });

  const filters = {
    incompleteOnly: only === "incomplete",
    minVariance: parseVarianceThreshold(minVar),
  };

  // Rank first, then filter, so the rank number a row carries is its place in
  // the whole cohort rather than its position within the current filter. An
  // admin filtering to high-variance applicants needs to know one of them is
  // ranked 4th overall; renumbering them 1..n would hide exactly that.
  const ranked = rankApplicants(rows).map((row, index) => ({ ...row, rank: index + 1 }));
  const visible = applyResultFilters(ranked, filters, target);

  // Clause 11e, decided here rather than in the client.
  //
  // **Server-side because the client's copy of the stage is only as fresh as the
  // payload it arrived in.** A second tab left open across a finalize would go
  // on offering checkboxes over a decision that has already been made. The
  // action re-checks the same field for the same reason, since a stale tab can
  // still submit.
  //
  // `!== WRITTEN` rather than an ordering comparison: InstanceStage is not an
  // ordered type in TypeScript, and `>` over its string values would work by
  // alphabetical accident and break the first time a value is added.
  const selectable = instance.currentStage === InstanceStage.WRITTEN;

  // Everyone still in the written round — **the same predicate `finalizeWritten`
  // recomputes server-side**, so the panel's denominator and the set that
  // actually receives Decision rows cannot drift apart.
  const byId = new Map(ranked.map((row) => [row.id, row]));
  const pool = applicants
    .filter(
      (applicant) =>
        applicant.status === ApplicantStatus.ACTIVE && applicant.stageReached === Round.WRITTEN,
    )
    .map((applicant) => {
      const row = byId.get(applicant.id);
      return {
        id: applicant.id,
        displayName: applicant.displayName,
        sourceRowIndex: applicant.sourceRowIndex,
        completedCount: row?.completedCount ?? 0,
        selections: Object.fromEntries(
          Object.entries(row?.demographics ?? {}).map(([key, cell]) => [key, cell.selected]),
        ),
      };
    });

  return (
    <main className={shell}>
      {header}
      <ResultsTable
        rows={visible}
        pool={pool}
        columns={columns.map((column) => ({
          key: column.key,
          label: column.label,
          labels: columnLabels(column),
        }))}
        target={target}
        totalCount={ranked.length}
        incompleteCount={ranked.filter((row) => row.completedCount < target).length}
        filters={{ ...filters, basePath: `/instances/${id}/results` }}
        instanceId={id}
        selectable={selectable}
      />
    </main>
  );
}
