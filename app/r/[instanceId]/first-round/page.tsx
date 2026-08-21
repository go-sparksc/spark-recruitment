import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { loadFirstRoundList } from "./load";
import { VoteButtons } from "./vote-buttons";
import { SignOutButton } from "../sign-out-button";
import { Round } from "@/generated/prisma/enums";
import { votedCount } from "@/lib/first-round";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";

export const metadata = { title: "First round — Spark SC" };

/// FR-14's list. Every applicant still in the first round, with the vote on the
/// row itself.
///
/// **Voting from the list, not only from the detail screen.** A first-round
/// reviewer is deciding on two numbers and a paragraph, not five essays — for
/// many applicants the summary on the row is the whole basis of the decision,
/// and making them open a page to register it would be the extra tap CLAUDE.md
/// warns costs a completed review. The detail screen is there for the ones they
/// want to look at properly.
export default async function FirstRoundListPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  const { instanceId } = await params;
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  // A reviewer signed in for another round lands on their own list rather than
  // an empty first-round one.
  if (session.rd !== Round.FIRST_ROUND) redirect(`/r/${instanceId}/list`);

  const [instance, rows] = await Promise.all([
    prisma.instance.findUnique({ where: { id: instanceId }, select: { name: true } }),
    loadFirstRoundList(instanceId, reviewer.id),
  ]);

  if (!instance) notFound();

  // Decision 62. The same navigational aid FR-9 gives written reviewers, and
  // more useful here: nothing narrows this list, so "am I done" is otherwise
  // unanswerable without counting.
  const voted = votedCount(rows);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">First round</h1>
          <p className="text-muted-foreground text-sm">
            {reviewer.firstName} {reviewer.lastName} · {instance.name}
          </p>
        </div>
        <SignOutButton instanceId={instanceId} />
      </header>

      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
          Nobody has reached the first round yet. An admin advances applicants once the written
          round is finalized — check back, or ask in Slack.
        </p>
      ) : (
        <>
          <p className="mt-5 text-sm font-medium">
            Voted on {voted} of {rows.length}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            You can change a vote any time before the round is finalized. Leaving one blank counts
            as a skip and does not count against the applicant.
          </p>

          <ul className="mt-3 space-y-2">
            {rows.map((row) => (
              <li key={row.applicantId} className="rounded-md border p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <Link
                    href={`/r/${instanceId}/first-round/${row.applicantId}`}
                    className="font-medium hover:underline"
                  >
                    {row.displayName}
                  </Link>
                  <Link
                    href={`/r/${instanceId}/first-round/${row.applicantId}`}
                    className="text-muted-foreground shrink-0 text-sm hover:underline"
                  >
                    {/* Clause 12q. Whichever half of the import exists is
                        rendered; the other is absent, not blocking. */}
                    {row.resultCount === 0 && !row.hasNotes
                      ? "no interview data"
                      : [
                          row.resultCount > 0
                            ? `${row.resultCount} score${row.resultCount === 1 ? "" : "s"}`
                            : null,
                          row.hasNotes ? "notes" : null,
                        ]
                          .filter((part) => part !== null)
                          .join(" · ")}
                    {" ›"}
                  </Link>
                </div>

                <div className="mt-3">
                  <VoteButtons
                    instanceId={instanceId}
                    applicantId={row.applicantId}
                    current={row.vote}
                    size="compact"
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
