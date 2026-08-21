import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConflictControl } from "../conflict-control";
import { Round } from "@/generated/prisma/enums";
import { SECOND_ROUND_POOL } from "@/lib/passes";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";
import { buildApplicantView } from "@/lib/review";
import { formatAverage, formatVariance } from "@/lib/results";
import { buildInterviewCards, buildWrittenReviews } from "@/lib/second-round";

export const metadata = { title: "Applicant — Spark SC" };

/// FR-16's profile: "the complete applicant profile — demographics, written
/// responses, written scores, written review notes, interview scores, interview
/// notes."
///
/// **§6 is enforced by the shared helper, not re-derived here.** Everything from
/// `Applicant.data` comes through `buildApplicantView(..., "SECOND_ROUND_REVIEWER")`,
/// which projects down to the visible field ids ON THE SERVER. Under §6 that
/// resolves to nearly everything for this viewer — demographics and responses
/// are both visible in this round — which makes this the one reviewer surface
/// where the projection returning a lot is the correct answer rather than a
/// leak.
///
/// **Nobody else's pass vote is loaded**, per decision 74. Not hidden: not
/// queried. Prior-round evidence is visible (decision 77's first row) and the
/// votes being cast now are not (its second).
export default async function SecondRoundApplicantPage({
  params,
}: {
  params: Promise<{ instanceId: string; applicantId: string }>;
}) {
  const { instanceId, applicantId } = await params;
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  if (session.rd !== Round.SECOND_ROUND) redirect(`/r/${instanceId}/list`);

  const [applicant, fields, groups, rubric, interviewCategories] = await Promise.all([
    prisma.applicant.findFirst({
      // The pool predicate again, so an applicant who has resolved cannot be
      // reached by keeping the URL open.
      where: { id: applicantId, instanceId, ...SECOND_ROUND_POOL },
      select: {
        id: true,
        displayName: true,
        email: true,
        sourceRowIndex: true,
        data: true,
        conflicts: {
          where: { reviewerId: reviewer.id, round: Round.SECOND_ROUND },
          select: { id: true },
        },
        assignments: {
          where: { round: Round.WRITTEN },
          select: {
            id: true,
            status: true,
            reviewer: { select: { firstName: true, lastName: true, isSparklet: true } },
            scores: { select: { rubricCategoryId: true, points: true } },
            note: { select: { body: true } },
          },
        },
        interviewNotes: { select: { body: true, interviewerName: true } },
        interviewResults: {
          orderBy: { interviewerName: "asc" },
          select: {
            id: true,
            interviewerName: true,
            score: true,
            categoryScores: { select: { interviewCategoryId: true, points: true } },
          },
        },
      },
    }),
    prisma.field.findMany({
      where: { instanceId },
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
      where: { instanceId },
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
    prisma.rubricCategory.findMany({
      where: { instanceId },
      orderBy: { ordinal: "asc" },
      select: { id: true, name: true, maxPoints: true },
    }),
    prisma.interviewCategory.findMany({
      where: { instanceId },
      orderBy: { ordinal: "asc" },
      select: { id: true, name: true, maxPoints: true },
    }),
  ]);

  if (!applicant) notFound();

  const view = buildApplicantView(
    {
      sourceRowIndex: applicant.sourceRowIndex,
      displayName: applicant.displayName,
      email: applicant.email,
      data: applicant.data as Record<string, unknown>,
    },
    fields,
    groups,
    "SECOND_ROUND_REVIEWER",
  );

  const written = buildWrittenReviews(
    applicant.assignments,
    rubric.map((category) => category.id),
  );
  const interviews = buildInterviewCards(
    applicant.interviewResults,
    interviewCategories.map((category) => category.id),
  );

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <Link
        href={`/r/${instanceId}/second-round`}
        className="text-muted-foreground text-sm hover:underline"
      >
        ← Second round
      </Link>

      <h1 className="mt-3 text-xl font-semibold tracking-tight">{applicant.displayName}</h1>
      {view.identified && view.email ? (
        <p className="text-muted-foreground text-sm">{view.email}</p>
      ) : null}

      {/* Interview scores first: they are the most recent evidence and the
          thing most people arrive wanting. Same card as FR-14's, one line per
          interviewer with the categories collapsed. */}
      <section className="mt-5 space-y-3">
        <h2 className="text-sm font-medium">Interview</h2>
        {interviews.length === 0 ? (
          <p className="text-muted-foreground rounded-md border p-4 text-sm">
            No interview scores were imported for this applicant.
          </p>
        ) : (
          interviews.map((card) => (
            <div key={card.resultId} className="rounded-md border p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{card.interviewerName}</span>
                <span className="text-2xl font-semibold tabular-nums">{card.score}</span>
              </div>

              {interviewCategories.length > 0 ? (
                <details className="mt-2">
                  <summary className="text-muted-foreground cursor-pointer text-sm">
                    Per-category scores
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {interviewCategories.map((category, index) => (
                      <li key={category.id} className="flex justify-between gap-3 text-sm">
                        <span>{category.name}</span>
                        <span className="tabular-nums">
                          {card.points[index] ?? "—"} / {category.maxPoints}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ))
        )}

        {applicant.interviewNotes ? (
          <div className="rounded-md border p-4">
            <h3 className="text-sm font-medium">
              Interview notes
              {applicant.interviewNotes.interviewerName
                ? ` — ${applicant.interviewNotes.interviewerName}`
                : ""}
            </h3>
            {/* whitespace-pre-line: the notes sheet carries paragraph breaks
                inside a quoted field and they are part of what was written. */}
            <p className="mt-2 text-sm whitespace-pre-line">{applicant.interviewNotes.body}</p>
          </div>
        ) : null}
      </section>

      {/* Written scores and notes. Decision 77: visible in this round, and
          attributed — the person who gave the 2 is in the room and can be asked
          why, which is what a deliberation is for. */}
      <section className="mt-6 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Written review</h2>
          <span className="text-muted-foreground text-sm tabular-nums">
            {written.summary.average === null
              ? "no complete reviews"
              : `avg ${formatAverage(written.summary.average)} · var ${formatVariance(
                  written.summary.variance,
                )}`}
          </span>
        </div>

        {written.cards.length === 0 ? (
          <p className="text-muted-foreground rounded-md border p-4 text-sm">
            No written review is recorded for this applicant.
          </p>
        ) : (
          written.cards.map((card) => (
            <div key={card.assignmentId} className="rounded-md border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">
                  {card.reviewerName}
                  {card.isSparklet ? (
                    <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs">
                      Sparklet
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground text-sm tabular-nums">
                  {card.average === null
                    ? `${card.scoredCount}/${rubric.length} scored — incomplete`
                    : `average ${card.average.toFixed(2)}`}
                </span>
              </div>

              <details className="mt-2">
                <summary className="text-muted-foreground cursor-pointer text-sm">
                  Per-category scores
                </summary>
                <ul className="mt-2 space-y-1">
                  {rubric.map((category, index) => (
                    <li key={category.id} className="flex justify-between gap-3 text-sm">
                      <span>{category.name}</span>
                      <span className="tabular-nums">
                        {card.points[index] ?? "—"} / {category.maxPoints}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>

              {card.note ? (
                <p className="mt-3 text-sm whitespace-pre-line">{card.note}</p>
              ) : (
                <p className="text-muted-foreground mt-3 text-sm italic">No note.</p>
              )}
            </div>
          ))
        )}

        {/* Counted, never named. A returned assignment is a recusal, and which
            colleague recused is not this room's business — but "three reviewers
            were assigned and you are reading two" is. */}
        {written.returnedCount > 0 ? (
          <p className="text-muted-foreground text-sm">
            {written.returnedCount} assigned reviewer
            {written.returnedCount === 1 ? "" : "s"} returned this applicant to the pool without
            reviewing.
          </p>
        ) : null}
      </section>

      {/* The application itself. Demographics and responses are both visible to
          this viewer under §6, resolved by the shared helper — this page has no
          opinion of its own about what may be shown. */}
      <section className="mt-6 space-y-3">
        <h2 className="text-sm font-medium">Application</h2>
        {view.fields.length === 0 ? (
          <p className="text-muted-foreground rounded-md border p-4 text-sm">
            This applicant answered nothing that is currently included.
          </p>
        ) : (
          view.fields.map((field) => (
            <div key={field.fieldId}>
              <h3 className="text-muted-foreground text-xs">
                {field.groupDisplayName ? `${field.groupDisplayName} — ` : ""}
                {field.displayName}
              </h3>
              <p className="mt-1 text-sm whitespace-pre-line">{field.value}</p>
            </div>
          ))
        )}
      </section>

      {/* Last, under everything it is a judgement about. FR-17's vote control
          arrives beside it once a pass is open. */}
      <section className="mt-6">
        <h2 className="text-sm font-medium">Conflict of interest</h2>
        <p className="text-muted-foreground mt-1 mb-2 text-sm">
          Flag one if you know this applicant well enough that your vote would not be fair.
        </p>
        <ConflictControl
          instanceId={instanceId}
          applicantId={applicant.id}
          applicantName={applicant.displayName}
          flagged={applicant.conflicts.length > 0}
        />
      </section>
    </main>
  );
}
