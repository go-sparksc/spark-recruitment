import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConflictControl } from "./conflict-control";
import { loadSecondRoundList } from "./load";
import { SignOutButton } from "../sign-out-button";
import { InstanceStage, Round } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";
import { conflictCount } from "@/lib/second-round";

export const metadata = { title: "Second round — Spark SC" };

/// FR-16's list. Everyone still in the second round, with the profile a tap away.
///
/// **No vote control on this screen, unlike FR-14's list.** A first-round vote is
/// a reaction to two numbers and a paragraph, so voting from the row saves a tap
/// that costs nothing. A pass vote is the outcome of reading a full profile and
/// arguing about it in a room, and FR-17 is explicit that selecting without
/// submitting records nothing. Putting a vote button on a row nobody has opened
/// would be the opposite of what the requirement asks for.
export default async function SecondRoundListPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  const { instanceId } = await params;
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  // A reviewer signed in for another round lands on their own list rather than
  // an empty second-round one.
  if (session.rd !== Round.SECOND_ROUND) redirect(`/r/${instanceId}/list`);

  const [instance, rows] = await Promise.all([
    prisma.instance.findUnique({
      where: { id: instanceId },
      select: { name: true, currentStage: true },
    }),
    loadSecondRoundList(instanceId, reviewer.id),
  ]);

  if (!instance) notFound();

  const flagged = conflictCount(rows);

  // Decision 64's lesson, applied before it can bite a second time: an empty
  // list means two opposite things, and so does a list with nothing to do on it.
  // Compared by identity rather than by ordering, since InstanceStage is not an
  // ordered type in TypeScript.
  const notStarted =
    instance.currentStage === InstanceStage.WRITTEN ||
    instance.currentStage === InstanceStage.FIRST_ROUND;
  const finished = instance.currentStage === InstanceStage.COMPLETE;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Second round</h1>
          <p className="text-muted-foreground text-sm">
            {reviewer.firstName} {reviewer.lastName} · {instance.name}
          </p>
        </div>
        <SignOutButton instanceId={instanceId} />
      </header>

      {rows.length === 0 ? (
        finished ? (
          <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
            The second round is closed. Thank you — nothing further is needed from you here.
          </p>
        ) : notStarted ? (
          <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
            Nobody has reached the second round yet. An admin advances applicants once the first
            round is finalized — check back, or ask in Slack.
          </p>
        ) : (
          // ACTIVE is empty while the round is still open: every applicant has
          // been resolved by the passes so far. A real end state, and a
          // different one from both of the above.
          <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
            Every applicant in the second round has been decided. There is nothing left to vote on.
          </p>
        )
      ) : (
        <>
          <p className="mt-5 text-sm font-medium">
            {rows.length} applicant{rows.length === 1 ? "" : "s"} in the round
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            Open an applicant to read their full profile. Voting happens in a pass, which an admin
            opens — until then this is here to read.
            {flagged > 0 ? ` You have flagged a conflict on ${flagged} of them.` : null}
          </p>

          <ul className="mt-3 divide-y rounded-md border">
            {rows.map((row) => (
              <li key={row.applicantId}>
                <Link
                  href={`/r/${instanceId}/second-round/${row.applicantId}`}
                  // min-h-14 and the whole row as the tap target: the same
                  // ergonomics the written round's list was built to.
                  className="hover:bg-muted active:bg-muted flex min-h-14 items-center justify-between gap-3 px-4 py-3"
                >
                  <span className="font-medium">{row.displayName}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-muted-foreground text-sm">
                      {row.interviewResultCount === 0 && !row.hasInterviewNotes
                        ? "no interview data"
                        : [
                            row.interviewResultCount > 0
                              ? `${row.interviewResultCount} score${
                                  row.interviewResultCount === 1 ? "" : "s"
                                }`
                              : null,
                            row.hasInterviewNotes ? "notes" : null,
                          ]
                            .filter((part) => part !== null)
                            .join(" · ")}
                    </span>
                    <span aria-hidden className="text-muted-foreground text-lg leading-none">
                      ›
                    </span>
                  </span>
                </Link>

                {/* Clause 16g's "per applicant", and the placement is the whole
                    point — the same call the written round's ReturnControl
                    makes, and it matters more here. A reviewer recuses because
                    they RECOGNIZED THE NAME, which happens on this screen. If
                    the only way to declare it were the profile, declaring a
                    conflict would mean first opening the demographics and
                    essays of the person you are recusing from.

                    A sibling of the Link rather than inside it: an anchor may
                    not contain a button, and the confirm panel needs the full
                    width of the row to open into. */}
                <div className="border-t border-dashed px-4 py-2">
                  <ConflictControl
                    instanceId={instanceId}
                    applicantId={row.applicantId}
                    applicantName={row.displayName}
                    flagged={row.hasConflict}
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
