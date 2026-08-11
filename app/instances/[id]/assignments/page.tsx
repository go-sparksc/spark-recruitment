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

export default async function AssignmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireInstance(id, `/instances/${id}/assignments`);

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

  const [applicants, reviewers] = await Promise.all([
    prisma.applicant.findMany({
      where: { instanceId: id },
      orderBy: { sourceRowIndex: "asc" },
      select: {
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
    // §6: written reviewers see an anonymous label, and the admin sees the same
    // one here so the two are talking about the same thing when a slot is
    // returned. Names stay available on FR-10, where decisions are made.
    label: `Applicant ${applicant.sourceRowIndex}`,
    reviewers: applicant.assignments.map((assignment) => ({
      assignmentId: assignment.id,
      id: assignment.reviewer.id,
      name: `${assignment.reviewer.firstName} ${assignment.reviewer.lastName}`,
      isSparklet: assignment.reviewer.isSparklet,
      origin: assignment.origin,
    })),
  }));

  // Applicants short a reviewer first: those are the open pool slots, and they
  // are the only rows an admin has a reason to act on.
  rows.sort((a, b) => a.reviewers.length - b.reviewers.length);

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
          />
        </>
      )}
    </main>
  );
}
