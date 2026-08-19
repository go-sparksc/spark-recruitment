import Link from "next/link";
import { notFound } from "next/navigation";

import { InstanceCrumbs } from "../../instance-crumbs";
import { Card, CardContent } from "@/components/ui/card";
import { AssignmentStatus, Round } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildApplicantView } from "@/lib/review";
import { formatAverage, formatVariance, reviewerAverage, scoreSummary } from "@/lib/results";

export const metadata = { title: "Applicant — Spark SC Recruitment" };

const ROUND = Round.WRITTEN;

/// FR-10's last clause: "Admin can open any applicant to read the full profile
/// and all three reviewers' scores and notes."
///
/// The admin viewer, so every included field is visible — §6 gives ADMIN
/// everything, and this is the page where a decision actually gets made. It
/// still runs through `buildApplicantView` rather than reading `data` directly,
/// so inclusion and grouping behave here exactly as they do everywhere else.
export default async function ApplicantResultPage({
  params,
}: {
  params: Promise<{ id: string; applicantId: string }>;
}) {
  const { id, applicantId } = await params;
  await requireInstance(id, `/instances/${id}/results/${applicantId}`);

  const [instance, applicant, fields, groups, categories] = await Promise.all([
    prisma.instance.findUnique({ where: { id }, select: { id: true, name: true } }),
    // Scoped to the instance: an applicant id in a URL is an untrusted
    // reference until it has been confirmed to belong to this cycle.
    prisma.applicant.findFirst({
      where: { id: applicantId, instanceId: id },
      select: {
        id: true,
        sourceRowIndex: true,
        displayName: true,
        email: true,
        data: true,
        status: true,
        stageReached: true,
        assignments: {
          where: { round: ROUND },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            status: true,
            returnReason: true,
            returnNote: true,
            reviewer: { select: { firstName: true, lastName: true, isSparklet: true } },
            scores: { select: { rubricCategoryId: true, points: true } },
            note: { select: { body: true } },
          },
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
      select: {
        id: true,
        displayName: true,
        category: true,
        isIncluded: true,
        visibleToWrittenReviewer: true,
        visibleToFirstRoundReviewer: true,
      },
    }),
    prisma.rubricCategory.findMany({
      where: { instanceId: id },
      orderBy: { ordinal: "asc" },
      select: { id: true, name: true, minPoints: true, maxPoints: true },
    }),
  ]);

  if (!instance || !applicant) notFound();

  const view = buildApplicantView(
    {
      sourceRowIndex: applicant.sourceRowIndex,
      displayName: applicant.displayName,
      email: applicant.email,
      data: applicant.data as Record<string, unknown>,
    },
    fields,
    groups,
    "ADMIN",
  );

  const active = applicant.assignments.filter((a) => a.status === AssignmentStatus.ACTIVE);
  const returned = applicant.assignments.filter((a) => a.status !== AssignmentStatus.ACTIVE);

  const averages = active
    .map((assignment) => reviewerAverage(assignment.scores.map((s) => s.points), categories.length))
    .filter((value): value is number => value !== null);
  const summary = scoreSummary(averages);

  return (
    <main className="mx-auto w-full max-w-4xl space-y-8 px-6 py-12">
      <div className="space-y-1">
        <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />
        <h1 className="text-2xl font-semibold">{applicant.displayName}</h1>
        <p className="text-muted-foreground text-sm">
          Applicant {applicant.sourceRowIndex}
          {applicant.email ? ` · ${applicant.email}` : null}
          {" · "}
          <Link href={`/instances/${instance.id}/results`} className="hover:underline">
            Back to results
          </Link>
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <Stat label="Average" value={formatAverage(summary.average)} />
        <Stat label="Variance" value={formatVariance(summary.variance)} />
        <Stat
          label="Complete reviews"
          value={`${summary.completedCount} of ${active.length} assigned`}
        />
        <Stat label="Status" value={`${applicant.status} · ${applicant.stageReached}`} />
      </dl>

      {/* FR-10 clause: all three reviewers' scores AND notes. */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Reviews</h2>
        {active.length === 0 ? (
          <p className="text-muted-foreground rounded-md border p-4 text-sm">
            No reviewer is assigned to this applicant in the written round.
          </p>
        ) : (
          active.map((assignment) => {
            const byCategory = new Map(assignment.scores.map((s) => [s.rubricCategoryId, s.points]));
            const own = reviewerAverage(
              assignment.scores.map((s) => s.points),
              categories.length,
            );

            return (
              <Card key={assignment.id}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {assignment.reviewer.firstName} {assignment.reviewer.lastName}
                      {assignment.reviewer.isSparklet ? (
                        <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs">
                          Sparklet
                        </span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground text-sm tabular-nums">
                      {own === null
                        ? `${assignment.scores.length}/${categories.length} scored — incomplete`
                        : `average ${own.toFixed(2)}`}
                    </span>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                    {categories.map((category) => {
                      const points = byCategory.get(category.id);
                      return (
                        <div key={category.id}>
                          <dt className="text-muted-foreground text-xs">{category.name}</dt>
                          <dd className="font-medium tabular-nums">
                            {points ?? "—"}{" "}
                            <span className="text-muted-foreground text-xs font-normal">
                              / {category.maxPoints}
                            </span>
                          </dd>
                        </div>
                      );
                    })}
                  </dl>

                  {assignment.note?.body ? (
                    <p className="text-sm whitespace-pre-wrap">{assignment.note.body}</p>
                  ) : (
                    <p className="text-muted-foreground text-sm italic">No note.</p>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}

        {/* Decision 39: a returned row is the record of a recusal and has to be
            readable somewhere. It is dimmed and non-actionable here for the same
            reason it is on the assignments page. */}
        {returned.length > 0 ? (
          <div className="text-muted-foreground space-y-1 rounded-md border p-4 text-sm">
            <p className="font-medium">Returned to pool</p>
            {returned.map((assignment) => (
              <p key={assignment.id}>
                {assignment.reviewer.firstName} {assignment.reviewer.lastName} —{" "}
                {assignment.returnReason === "CONFLICT_OF_INTEREST" ? "conflict of interest" : "other"}
                {assignment.returnNote ? `: ${assignment.returnNote}` : null}
              </p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Application</h2>
        {view.fields.length === 0 ? (
          <p className="text-muted-foreground rounded-md border p-4 text-sm">
            This applicant answered nothing that is currently included.
          </p>
        ) : (
          <dl className="space-y-4">
            {view.fields.map((field) => (
              <div key={field.fieldId}>
                <dt className="text-muted-foreground text-xs">
                  {field.groupDisplayName ? `${field.groupDisplayName} · ` : null}
                  {field.displayName}
                </dt>
                <dd className="text-sm whitespace-pre-wrap">{field.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
