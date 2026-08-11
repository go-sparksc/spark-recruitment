import Link from "next/link";
import { notFound } from "next/navigation";

import { precheck } from "./actions";
import {
  GeneratePanel,
  LoadTable,
  OverridePanel,
  type ApplicantRow,
  type ReviewerOption,
} from "./assignment-controls";
import { AssignmentStatus, Round } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Assignments — Spark SC Recruitment" };

/// Phase 2 assigns the written round. The page is written round-agnostic because
/// nothing in FR-7 is specific to it, but only WRITTEN is reachable until the
/// later rounds have dashboards to read the assignments.
const ROUND = Round.WRITTEN;

/// Big enough that most cycles need one or two pages, small enough that the
/// payload stays flat as the applicant count grows. 150 rows each carrying three
/// reviewers is not large today and is the wrong thing to ship whole.
const PAGE_SIZE = 50;

export default async function AssignmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; q?: string; only?: string }>;
}) {
  const { id } = await params;
  const { page: pageParam, q: rawQuery, only } = await searchParams;
  await requireInstance(id, `/instances/${id}/assignments`);

  const query = (rawQuery ?? "").trim();
  const shortOnly = only === "short";
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true, name: true, _count: { select: { applicants: true } } },
  });

  if (!instance) notFound();

  const header = (
    <div className="space-y-1">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← Instances
      </Link>
      <h1 className="text-2xl font-semibold">Assignments</h1>
      <p className="text-muted-foreground text-sm">
        {instance.name} · written round
        {" · "}
        <Link href={`/instances/${id}/reviewers`} className="hover:underline">
          Reviewers
        </Link>
      </p>
    </div>
  );

  // Nothing here means anything without applicants, and the page would otherwise
  // render a precheck full of zeroes that reads like a bug.
  if (instance._count.applicants === 0) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-8 px-6 py-12">
        {header}
        <p className="text-muted-foreground rounded-md border p-4 text-sm">
          This instance has no applicants yet. Import the CSV first — there is nothing to assign
          reviewers to.
        </p>
      </main>
    );
  }

  const view = await precheck(id, ROUND);

  // "Short a reviewer" is the pool view and the main reason to open this page,
  // but it is a count over a relation, which Prisma cannot filter on directly.
  // Two cheap queries instead of loading every applicant into memory: the ids,
  // and the active assignment counts. Applicants with no assignments at all do
  // not appear in the groupBy, so they are added back from the id list.
  let shortApplicantIds: string[] | null = null;
  if (shortOnly) {
    const [ids, grouped] = await Promise.all([
      prisma.applicant.findMany({ where: { instanceId: id }, select: { id: true } }),
      prisma.assignment.groupBy({
        by: ["applicantId"],
        where: { instanceId: id, round: ROUND, status: AssignmentStatus.ACTIVE },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map(grouped.map((row) => [row.applicantId, row._count._all]));
    shortApplicantIds = ids
      .map((a) => a.id)
      .filter((applicantId) => (counts.get(applicantId) ?? 0) < view.report.target);
  }

  // Search matches the anonymous label's number AND the name. §6 keeps names
  // visible to admins throughout, and an admin looking for one person knows the
  // name, not the row index — but a returned-slot conversation names "Applicant
  // 47", so both have to work.
  const asNumber = Number.parseInt(query, 10);
  const where = {
    instanceId: id,
    ...(shortApplicantIds === null ? {} : { id: { in: shortApplicantIds } }),
    ...(query === ""
      ? {}
      : {
          OR: [
            { displayName: { contains: query, mode: "insensitive" as const } },
            ...(Number.isNaN(asNumber) ? [] : [{ sourceRowIndex: asNumber }]),
          ],
        }),
  };

  const matchCount = await prisma.applicant.count({ where });
  const pageCount = Math.max(1, Math.ceil(matchCount / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);

  const [applicants, reviewers] = await Promise.all([
    prisma.applicant.findMany({
      where,
      // Source order, which is stable and is what "Applicant 47" means.
      //
      // Deliberately NOT ordered by assignment count to float short applicants:
      // Prisma cannot filter a relation _count used in orderBy, so it would
      // count returned rows and other rounds too. The "Only short a reviewer"
      // filter answers that question exactly instead of approximating it in a
      // sort, and sorting after paging would only reorder the current page,
      // which reads as an order and is not one.
      orderBy: { sourceRowIndex: "asc" },
      skip: (currentPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        displayName: true,
        id: true,
        sourceRowIndex: true,
        assignments: {
          where: { round: ROUND, status: AssignmentStatus.ACTIVE },
          select: {
            id: true,
            origin: true,
            reviewer: { select: { id: true, firstName: true, lastName: true, isSparklet: true } },
          },
        },
      },
    }),
    prisma.reviewer.findMany({
      where: { instanceId: id, rounds: { has: ROUND } },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        isSparklet: true,
        _count: {
          select: { assignments: { where: { round: ROUND, status: AssignmentStatus.ACTIVE } } },
        },
      },
    }),
  ]);

  const reviewerOptions: ReviewerOption[] = reviewers.map((reviewer) => ({
    id: reviewer.id,
    name: `${reviewer.firstName} ${reviewer.lastName}`,
    isSparklet: reviewer.isSparklet,
    load: reviewer._count.assignments,
  }));

  const rows: ApplicantRow[] = applicants.map((applicant) => ({
    id: applicant.id,
    // Both. The anonymous label is the shared identifier — it is what a written
    // reviewer sees, so a returned-slot conversation names it — and the name is
    // how an admin knows who this is. §6 keeps names visible to admins
    // throughout, so showing it here costs nothing and searching it is the only
    // way to find one person among 150.
    label: `Applicant ${applicant.sourceRowIndex}`,
    name: applicant.displayName,
    reviewers: applicant.assignments.map((assignment) => ({
      assignmentId: assignment.id,
      id: assignment.reviewer.id,
      name: `${assignment.reviewer.firstName} ${assignment.reviewer.lastName}`,
      isSparklet: assignment.reviewer.isSparklet,
      origin: assignment.origin,
    })),
  }));

  return (
    <main className="mx-auto w-full max-w-4xl space-y-10 px-6 py-12">
      {header}

      {view.reviewerCount === 0 ? (
        <p className="text-muted-foreground rounded-md border p-4 text-sm">
          No reviewer serves the written round yet.{" "}
          <Link href={`/instances/${id}/reviewers`} className="underline">
            Build the roster
          </Link>{" "}
          before assigning.
        </p>
      ) : (
        <>
          <GeneratePanel instanceId={id} round={ROUND} precheck={view} />
          <LoadTable reviewers={reviewerOptions} />
          <OverridePanel
            instanceId={id}
            round={ROUND}
            applicants={rows}
            reviewers={reviewerOptions}
            paging={{
              basePath: `/instances/${id}/assignments`,
              query,
              shortOnly,
              page: currentPage,
              pageCount,
              matchCount,
              totalCount: instance._count.applicants,
            }}
          />
        </>
      )}
    </main>
  );
}
