import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConflictControl } from "../conflict-control";
import { VoteButtons } from "./vote-buttons";
import { PassStatus, Round } from "@/generated/prisma/enums";
import { SECOND_ROUND_COHORT, voteAvailability } from "@/lib/passes";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";
import { applicantLabel, buildApplicantView } from "@/lib/review";
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
      // **`SECOND_ROUND_COHORT`, matching the list** — decision 112. This used
      // to be `SECOND_ROUND_POOL`, with a comment saying a resolved applicant
      // "cannot be reached by keeping the URL open". That was the intent and it
      // had a defect the requirement never wanted: `submitPassVote` revalidates
      // *this* route, so the reviewer whose own vote resolved the applicant was
      // re-rendered through a query that no longer matched, and got a 404 in
      // place of any confirmation. The page they were standing on disappeared
      // underneath them at the moment they used it.
      //
      // Reading is now allowed for the whole cohort and writing is not: the
      // vote and conflict actions keep the ACTIVE predicate, which is where
      // "cannot be reached" actually belonged.
      where: { id: applicantId, instanceId, ...SECOND_ROUND_COHORT },
      select: {
        id: true,
        displayName: true,
        email: true,
        sourceRowIndex: true,
        status: true,
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
        isReviewerVisible: true,
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
        isReviewerVisible: true,
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

  // FR-17's vote control. **The open pass is resolved here, server-side** — 17d
  // says a vote lands in the currently open pass, so no pass id ever travels
  // through the client.
  //
  // **The only `PassVote` this page loads is this reviewer's own**, per decision
  // 74 and clause 17z. Not fetched and hidden: not fetched. There is no count in
  // the RSC payload to leak, which is the §6 posture applied to votes.
  const openPass = await prisma.pass.findFirst({
    where: { instanceId, status: PassStatus.OPEN },
    select: { id: true },
  });

  const [membership, ownVote] = openPass
    ? await Promise.all([
        prisma.passApplicant.findUnique({
          where: { passId_applicantId: { passId: openPass.id, applicantId: applicant.id } },
          select: { resolution: true },
        }),
        prisma.passVote.findUnique({
          where: {
            passId_applicantId_reviewerId: {
              passId: openPass.id,
              applicantId: applicant.id,
              reviewerId: reviewer.id,
            },
          },
          select: { value: true },
        }),
      ])
    : [null, null];

  const availability = voteAvailability({
    // Decision 111's outcome, read from the durable record. An applicant
    // resolved by an EARLIER pass is not a member of the open one, so nothing
    // above would have anything to say about them.
    applicantStatus: applicant.status,
    hasOpenPass: openPass !== null,
    isMember: membership !== null,
    hasConflict: applicant.conflicts.length > 0,
    storedResolution: membership?.resolution ?? null,
    currentVote: ownVote?.value ?? null,
  });

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

      {/* The handle beside the name here too. A reviewer arrives from a list
          that now shows it, and the profile is where they decide — "am I on the
          right Diego Hoffmann" has to be answerable without reading the email
          and knowing which one it belongs to. */}
      <h1 className="mt-3 text-xl font-semibold tracking-tight">
        {applicant.displayName}
        <span className="text-muted-foreground ml-2 text-sm font-normal">
          {applicantLabel(applicant.sourceRowIndex)}
        </span>
      </h1>
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

      {/* FR-17's vote, under everything it is a judgement about. Decision 82
          puts it here and only here: the list is for reading and recusing, and a
          vote cast from a row nobody opened is what FR-17's explicit submit is
          written to prevent. */}
      <section className="mt-6">
        <h2 className="text-sm font-medium">
          {availability.kind === "RESOLVED" ? "Outcome" : "Your vote"}
        </h2>
        {/* The standing promise, and decision 111 does not weaken it: what this
            page gained is the outcome, not anybody's ballot. The sentence is
            still true and is worth keeping exactly where a reviewer is deciding
            whether to trust the screen. */}
        <p className="text-muted-foreground mt-1 mb-2 text-sm">
          Nobody else&rsquo;s vote is shown here, during the pass or after it closes.
        </p>
        <VoteButtons
          instanceId={instanceId}
          applicantId={applicant.id}
          availability={availability}
        />
      </section>

      {/* Beside the vote, because it is the alternative to casting one.

          Absent once the round has finished with this applicant, for decision
          100's reason: `flagConflict` refuses a resolved applicant, so offering
          the control would be offering something that fails. Decision 112 keeps
          the page reachable; it does not make it writable. */}
      {availability.kind === "RESOLVED" ? null : (
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
      )}
    </main>
  );
}
