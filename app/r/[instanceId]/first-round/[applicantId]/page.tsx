import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { VoteButtons } from "../vote-buttons";
import { Round } from "@/generated/prisma/enums";
import { currentTermOf } from "@/lib/class-standing";
import { FIRST_ROUND_POOL } from "@/lib/first-round";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";
import { applicantLabel, buildApplicantView } from "@/lib/review";
import { buildInterviewCards } from "@/lib/second-round";
import { buildTranscript } from "@/lib/transcript";
import { InterviewCards, InterviewTranscript } from "@/components/interview-section";

export const metadata = { title: "Applicant — Spark SC" };

/// FR-14's detail view.
///
/// **§6 is enforced by the shared helper, not re-derived here.** Everything the
/// reviewer may see comes through `buildApplicantView(..., "FIRST_ROUND_REVIEWER")`,
/// which projects `Applicant.data` down to the visible field ids ON THE SERVER —
/// a hidden demographic or written response is absent from the payload, not
/// hidden by CSS. Under §6 that resolves to nothing by default for this round,
/// which is why the profile section renders only when the admin has explicitly
/// made an OTHER field first-round-visible.
export default async function FirstRoundApplicantPage({
  params,
}: {
  params: Promise<{ instanceId: string; applicantId: string }>;
}) {
  const { instanceId, applicantId } = await params;
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  if (session.rd !== Round.FIRST_ROUND) redirect(`/r/${instanceId}/list`);

  const [applicant, fields, groups, interviewCategories, interviewQuestions, instance] =
    await Promise.all([
    prisma.applicant.findFirst({
      // The pool predicate again, so an applicant who left the round cannot be
      // reached by keeping the URL.
      where: { id: applicantId, instanceId, ...FIRST_ROUND_POOL },
      select: {
        id: true,
        displayName: true,
        sourceRowIndex: true,
        data: true,
        interviewNotes: {
          select: {
            body: true,
            interviewerName: true,
            // Decision 120. Deliberately not ordered here — `buildTranscript`
            // orders by the question's ordinal, which is the sheet's own column
            // order, and an `orderBy` on this list would look like it decided
            // that while actually deciding nothing.
            answers: { select: { interviewQuestionId: true, body: true } },
          },
        },
        interviewResults: {
          orderBy: { interviewerName: "asc" },
          select: {
            id: true,
            interviewerName: true,
            score: true,
            scoreIsComputed: true,
            note: true,
            recommendation: true,
            categoryScores: {
              select: { interviewCategoryId: true, points: true, note: true },
            },
          },
        },
        firstRoundVotes: { where: { reviewerId: reviewer.id }, select: { value: true } },
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
        // Decision 119. buildApplicantView requires it and decides.
        isGraduationDate: true,
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
    // Clause 14e: the category count follows the configured rows. Nothing here
    // assumes four.
    prisma.interviewCategory.findMany({
      where: { instanceId },
      orderBy: { ordinal: "asc" },
      select: { id: true, name: true, maxPoints: true },
    }),
    // Decision 120. Instance-scoped like the rubric above it: an answer row
    // carries a question id and nothing else, so the prompts come from here
    // rather than being repeated on every applicant's transcript.
    prisma.interviewQuestion.findMany({
      where: { instanceId },
      orderBy: { ordinal: "asc" },
      select: { id: true, ordinal: true, prompt: true },
    }),
    // Decision 119: the semester class standing counts from.
    prisma.instance.findUnique({
      where: { id: instanceId },
      select: { currentTermSeason: true, currentTermYear: true },
    }),
  ]);

  if (!applicant) notFound();

  const view = buildApplicantView(
    {
      sourceRowIndex: applicant.sourceRowIndex,
      displayName: applicant.displayName,
      email: null,
      data: applicant.data as Record<string, unknown>,
    },
    fields,
    groups,
    "FIRST_ROUND_REVIEWER",
    instance === null ? null : currentTermOf(instance),
  );

  const vote = applicant.firstRoundVotes[0]?.value ?? null;

  // Both transformations live in `lib/`, per CLAUDE.md's Phase 5 lesson. The
  // page holds the queries and nothing else. Decision 120 moved the card markup
  // out too, into the component FR-16 and the admin results view also render.
  const interviews = buildInterviewCards(
    applicant.interviewResults,
    interviewCategories.map((category) => category.id),
  );
  // Empty for a transcript imported before decision 120, or from a sheet with a
  // single Notes column. InterviewTranscript falls back to InterviewNotes.body
  // in that case, which is exactly what this page rendered before.
  const transcript = buildTranscript(interviewQuestions, applicant.interviewNotes?.answers ?? []);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <Link href={`/r/${instanceId}/first-round`} className="text-muted-foreground text-sm hover:underline">
        ← First round
      </Link>

      {/* The handle beside the name, matching the list that links here and the
          second round's profile. Two applicants share a name in the seed, and a
          reviewer arriving from a search for one of them needs "am I on the
          right Diego Hoffmann" answerable without reading the email. */}
      <h1 className="mt-3 text-xl font-semibold tracking-tight">
        {applicant.displayName}
        <span className="text-muted-foreground ml-2 text-sm font-normal">
          {applicantLabel(applicant.sourceRowIndex)}
        </span>
      </h1>

      {/* Clause 14b. The averages are the headline — largest type on the page,
          one line per interviewer, above everything else.

          Decision 120: the markup itself now lives in components/interview-section,
          shared with FR-16's profile and the admin results view, so the three
          cannot come to disagree about one interview. */}
      <section className="mt-5 space-y-3">
        {interviews.length === 0 ? (
          <p className="text-muted-foreground rounded-md border p-4 text-sm">
            No interview scores have been imported for this applicant yet.
          </p>
        ) : (
          <InterviewCards
            cards={interviews}
            categories={interviewCategories}
            whitespace="pre-line"
          />
        )}
      </section>

      {/* Clause 14d. */}
      {applicant.interviewNotes ? (
        <section className="mt-5">
          <InterviewTranscript
            interviewerName={applicant.interviewNotes.interviewerName}
            sections={transcript}
            fallbackBody={applicant.interviewNotes.body}
            whitespace="pre-line"
          />
        </section>
      ) : null}

      {/* Clause 14f. Empty by default under §6 — demographics and written
          responses are both hidden from this round — and non-empty only where an
          admin made an OTHER field first-round-visible. Rendered through the
          shared resolver so this page has no opinion of its own about it. */}
      {view.fields.length > 0 ? (
        <section className="mt-5 space-y-3">
          {view.fields.map((field) => (
            <div key={field.fieldId}>
              <h2 className="text-muted-foreground text-xs">
                {field.groupDisplayName ? `${field.groupDisplayName} — ` : ""}
                {field.displayName}
              </h2>
              <p className="mt-1 text-sm whitespace-pre-line">{field.value}</p>
            </div>
          ))}
        </section>
      ) : null}

      {/* The vote last, where the thumb is, after everything it is based on. */}
      <section className="mt-6">
        <h2 className="text-sm font-medium">Your vote</h2>
        <p className="text-muted-foreground mt-1 mb-2 text-sm">
          Changeable until the round is finalized. No vote counts as a skip.
        </p>
        <VoteButtons
          instanceId={instanceId}
          applicantId={applicant.id}
          current={vote === "YES" || vote === "NO" ? vote : null}
        />
      </section>
    </main>
  );
}
