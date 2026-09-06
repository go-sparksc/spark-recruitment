import Link from "next/link";
import { notFound } from "next/navigation";

import { InstanceCrumbs } from "../../instance-crumbs";
import { Card, CardContent } from "@/components/ui/card";
import { AssignmentStatus, Round } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildPassHistory } from "@/lib/final";
import { resolutionLabel } from "@/lib/passes";
import { buildApplicantView } from "@/lib/review";
import { formatAverage, formatVariance, reviewerAverage, scoreSummary } from "@/lib/results";
import { buildInterviewCards } from "@/lib/second-round";

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

  const [
    instance,
    applicant,
    fields,
    groups,
    categories,
    interviewCategories,
    interviewResults,
    interviewNotes,
    passes,
    secondRoundReviewers,
    conflicts,
  ] = await Promise.all([
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
    // The first round's imported evidence. Rendered only where it exists —
    // clause 12q's rule that the dashboard shows whichever half arrived, which
    // is what keeps this page correct on a written-round-only instance.
    prisma.interviewCategory.findMany({
      where: { instanceId: id },
      orderBy: { ordinal: "asc" },
      select: { id: true, name: true, maxPoints: true },
    }),
    prisma.interviewResult.findMany({
      where: { applicantId },
      orderBy: { interviewerName: "asc" },
      select: {
        id: true,
        interviewerName: true,
        score: true,
        categoryScores: { select: { interviewCategoryId: true, points: true } },
      },
    }),
    prisma.interviewNotes.findUnique({
      where: { applicantId },
      select: { interviewerName: true, body: true },
    }),
    // The second round. §6's last row makes the admin the only viewer who sees a
    // pass vote at all, and decision 74 is why no reviewer surface renders one.
    prisma.pass.findMany({
      where: { instanceId: id, members: { some: { applicantId } } },
      orderBy: { ordinal: "asc" },
      select: {
        id: true,
        ordinal: true,
        // Decision 100: each pass is read with the conflicts that existed when
        // it closed, which `buildPassHistory` decides from these two columns.
        status: true,
        closedAt: true,
        members: { where: { applicantId }, select: { resolution: true } },
        votes: {
          where: { applicantId },
          select: { applicantId: true, reviewerId: true, value: true },
        },
      },
    }),
    prisma.reviewer.findMany({
      where: { instanceId: id, rounds: { has: Round.SECOND_ROUND } },
      orderBy: { createdAt: "asc" },
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.conflictOfInterest.findMany({
      where: { round: Round.SECOND_ROUND, applicantId },
      select: { applicantId: true, reviewerId: true, createdAt: true },
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

  // Both transformations live in `lib/`, per CLAUDE.md's Phase 5 lesson. The
  // page holds the queries and nothing else.
  const interviewCards = buildInterviewCards(
    interviewResults,
    interviewCategories.map((category) => category.id),
  );
  const passHistory = buildPassHistory(
    applicantId,
    passes.map((pass) => ({
      passId: pass.id,
      ordinal: pass.ordinal,
      status: pass.status,
      closedAt: pass.closedAt,
      resolution: pass.members[0]?.resolution ?? null,
      votes: pass.votes,
    })),
    secondRoundReviewers,
    conflicts,
  );

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

      {/* FR-12's imported evidence. Absent entirely on an instance that never
          reached the first round, rather than rendered as an empty shell. */}
      {interviewCards.length > 0 || interviewNotes !== null ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">First-round interviews</h2>

          {interviewCards.map((card) => (
            <Card key={card.resultId}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{card.interviewerName}</span>
                  {/* The average as imported, never recomputed from the
                      categories — if the two disagree the sheet wins, because
                      that is the number the interviewers recorded. */}
                  <span className="text-muted-foreground text-sm tabular-nums">
                    average {card.score}
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                  {interviewCategories.map((category, index) => (
                    <div key={category.id}>
                      <dt className="text-muted-foreground text-xs">{category.name}</dt>
                      <dd className="font-medium tabular-nums">
                        {card.points[index] ?? "—"}{" "}
                        <span className="text-muted-foreground text-xs font-normal">
                          / {category.maxPoints}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          ))}

          {interviewNotes ? (
            <Card>
              <CardContent className="space-y-1 p-4">
                <p className="text-muted-foreground text-xs">
                  Interview notes
                  {interviewNotes.interviewerName ? ` · ${interviewNotes.interviewerName}` : null}
                </p>
                <p className="text-sm whitespace-pre-wrap">{interviewNotes.body}</p>
              </CardContent>
            </Card>
          ) : (
            <p className="text-muted-foreground rounded-md border p-4 text-sm">
              No interview notes were imported for this applicant.
            </p>
          )}
        </section>
      ) : null}

      {/* FR-18's data, cut the other way: one applicant across every pass.
          §6's last row makes the admin the only viewer who ever sees a pass
          vote, and decision 74 is why no reviewer surface renders one. */}
      {passHistory.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Second round</h2>
          {passHistory.map((pass) => (
            <Card key={pass.passId}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    Pass {pass.ordinal}
                    {" · "}
                    <Link
                      href={`/instances/${instance.id}/passes/${pass.passId}`}
                      className="text-muted-foreground text-sm font-normal hover:underline"
                    >
                      grid
                    </Link>
                  </span>
                  <span className="text-muted-foreground text-sm tabular-nums">
                    {resolutionLabel(pass.resolution)}
                    {" — "}
                    {pass.tally.yes} yes · {pass.tally.no} no
                    {pass.tally.skip > 0 ? ` · ${pass.tally.skip} recused` : null}
                    {pass.tally.outstanding > 0 ? ` · ${pass.tally.outstanding} outstanding` : null}
                  </span>
                </div>

                <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  {pass.votes.map((vote) => (
                    <li key={vote.reviewerId} className="flex items-baseline justify-between gap-3">
                      <span>{vote.reviewerName}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {vote.vote === "OUTSTANDING"
                          ? "—"
                          : vote.vote === "SKIP" && vote.isConflict
                            ? "conflict"
                            : vote.vote.toLowerCase()}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </section>
      ) : null}

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
