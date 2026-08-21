import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { VoteButtons } from "../vote-buttons";
import { Round } from "@/generated/prisma/enums";
import { FIRST_ROUND_POOL } from "@/lib/first-round";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";
import { buildApplicantView } from "@/lib/review";

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

  const [applicant, fields, groups, categories] = await Promise.all([
    prisma.applicant.findFirst({
      // The pool predicate again, so an applicant who left the round cannot be
      // reached by keeping the URL.
      where: { id: applicantId, instanceId, ...FIRST_ROUND_POOL },
      select: {
        id: true,
        displayName: true,
        sourceRowIndex: true,
        data: true,
        interviewNotes: { select: { body: true, interviewerName: true } },
        interviewResults: {
          orderBy: { interviewerName: "asc" },
          select: {
            id: true,
            interviewerName: true,
            score: true,
            categoryScores: {
              select: { interviewCategoryId: true, points: true },
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
    // Clause 14e: the category count follows the configured rows. Nothing here
    // assumes four.
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
      email: null,
      data: applicant.data as Record<string, unknown>,
    },
    fields,
    groups,
    "FIRST_ROUND_REVIEWER",
  );

  const vote = applicant.firstRoundVotes[0]?.value ?? null;
  const categoryName = new Map(categories.map((c) => [c.id, c]));

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <Link href={`/r/${instanceId}/first-round`} className="text-muted-foreground text-sm hover:underline">
        ← First round
      </Link>

      <h1 className="mt-3 text-xl font-semibold tracking-tight">{applicant.displayName}</h1>

      {/* Clause 14b. The averages are the headline — largest type on the page,
          one line per interviewer, above everything else. */}
      <section className="mt-5 space-y-3">
        {applicant.interviewResults.length === 0 ? (
          <p className="text-muted-foreground rounded-md border p-4 text-sm">
            No interview scores have been imported for this applicant yet.
          </p>
        ) : (
          applicant.interviewResults.map((result) => (
            <div key={result.id} className="rounded-md border p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{result.interviewerName}</span>
                <span className="text-2xl font-semibold tabular-nums">{result.score}</span>
              </div>

              {/* Clause 14c: collapsed by default, expandable. `<details>`
                  rather than state, so it works before hydration. */}
              {result.categoryScores.length > 0 ? (
                <details className="mt-2">
                  <summary className="text-muted-foreground cursor-pointer text-sm">
                    Per-category scores
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {result.categoryScores.map((score) => {
                      const category = categoryName.get(score.interviewCategoryId);
                      return (
                        <li
                          key={score.interviewCategoryId}
                          className="flex justify-between gap-3 text-sm"
                        >
                          <span>{category?.name ?? "Category"}</span>
                          <span className="tabular-nums">
                            {score.points}
                            {category ? ` / ${category.maxPoints}` : ""}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              ) : null}
            </div>
          ))
        )}
      </section>

      {/* Clause 14d. */}
      {applicant.interviewNotes ? (
        <section className="mt-5 rounded-md border p-4">
          <h2 className="text-sm font-medium">
            Interview notes
            {applicant.interviewNotes.interviewerName
              ? ` — ${applicant.interviewNotes.interviewerName}`
              : ""}
          </h2>
          {/* whitespace-pre-line: the notes sheet carries paragraph breaks
              inside a quoted field and they are part of what was written. */}
          <p className="mt-2 text-sm whitespace-pre-line">{applicant.interviewNotes.body}</p>
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
