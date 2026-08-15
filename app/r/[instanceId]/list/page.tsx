import Link from "next/link";
import { notFound } from "next/navigation";

import { SignOutButton } from "../sign-out-button";
import { AssignmentStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";
import { completionOf } from "@/lib/review";

export const metadata = { title: "Your applicants — Spark SC" };

/// FR-9 bullet 1: "Their assigned applicants as a list with completion state
/// (0/4 scored, 4/4 scored)".
///
/// Both halves of that are here — the per-applicant state on every row, and the
/// aggregate in the header. The aggregate is the easy one and the one a reviewer
/// actually navigates by ("am I done yet"); the per-applicant state is what
/// tells them which one to open next.
///
/// A returned applicant is simply absent, not shown greyed out as "returned".
/// That falls out of the ACTIVE filter rather than needing a rule: the
/// assignment stopped being this reviewer's the moment they handed it back.
export default async function ReviewerListPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  const { instanceId } = await params;
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  const [instance, categories, assignments] = await Promise.all([
    prisma.instance.findUnique({
      where: { id: instanceId },
      select: { name: true },
    }),
    prisma.rubricCategory.findMany({
      where: { instanceId },
      orderBy: { ordinal: "asc" },
      select: { id: true },
    }),
    prisma.assignment.findMany({
      where: {
        instanceId,
        round: session.rd,
        reviewerId: reviewer.id,
        status: AssignmentStatus.ACTIVE,
      },
      // Source order, which is the order the anonymous labels run in. A reviewer
      // working top to bottom sees "Applicant 12, 47, 91" ascending rather than
      // whatever order the generator happened to insert them in.
      orderBy: { applicant: { sourceRowIndex: "asc" } },
      select: {
        id: true,
        // §6: the applicant's name and email are not selected at all. Nothing
        // on this page needs them, and a column that is never loaded cannot be
        // rendered by mistake.
        applicant: { select: { sourceRowIndex: true } },
        scores: { select: { rubricCategoryId: true } },
      },
    }),
  ]);

  if (!instance) notFound();

  const categoryIds = categories.map((category) => category.id);

  const rows = assignments.map((assignment) => ({
    id: assignment.id,
    label: `Applicant ${assignment.applicant.sourceRowIndex}`,
    completion: completionOf(
      categoryIds,
      assignment.scores.map((score) => score.rubricCategoryId),
    ),
  }));

  const completeCount = rows.filter((row) => row.completion.complete).length;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Your applicants</h1>
        <p className="text-muted-foreground text-sm">
          {reviewer.firstName} {reviewer.lastName} · {instance.name}
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
          Nothing is assigned to you yet. An admin generates assignments once the roster is set —
          check back, or ask in Slack.
        </p>
      ) : (
        <>
          <p className="mt-5 text-sm font-medium">
            {completeCount} of {rows.length} complete
          </p>

          <ul className="mt-3 divide-y rounded-md border">
            {rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/r/${instanceId}/a/${row.id}`}
                  // min-h-14: a full-width row is the tap target, not the text
                  // inside it. This is the control a reviewer hits fifteen times.
                  className="hover:bg-muted flex min-h-14 items-center justify-between gap-3 px-4 py-3"
                >
                  <span className="font-medium">{row.label}</span>
                  <span
                    className={
                      row.completion.complete
                        ? "text-sm text-emerald-600"
                        : "text-muted-foreground text-sm"
                    }
                  >
                    {row.completion.scored}/{row.completion.total} categories
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <SignOutButton instanceId={instanceId} />
    </main>
  );
}
