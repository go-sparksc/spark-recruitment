import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConflictControl } from "./conflict-control";
import { loadSecondRoundList } from "./load";
import { SignOutButton } from "../sign-out-button";
import { InstanceStage, PassStatus, Round } from "@/generated/prisma/enums";
import { OUTCOME_TONE, STATUS_LABEL } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { applicantLabel } from "@/lib/review";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";
import { conflictCount, undecidedCount } from "@/lib/second-round";

export const metadata = { title: "Second round — Spark SC" };

/// FR-16's list. Everyone who reached the second round, with the profile a tap
/// away — decision 112, which keeps a resolved applicant here rather than
/// dropping them.
///
/// **No vote control on this screen.** Decision 82: a pass vote is the outcome
/// of reading a full profile and arguing about it in a room, and FR-17 is
/// explicit that selecting without submitting records nothing. Putting a vote
/// button on a row nobody has opened would be the opposite of what the
/// requirement asks for. (The comparison 82 drew against FR-14's list was
/// wrong about that screen — see decision 113 — but the conclusion for this one
/// is unchanged, and it never rested on the comparison.)
///
/// **An outcome is not a vote state.** Decision 111 puts green and red on the
/// rows the round has finished with. That is the applicant's status, not
/// anybody's ballot: no count, no tally and no other reviewer reaches this
/// page, which is decision 74's surviving half and clause 17z.
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

  const [instance, rows, openPass] = await Promise.all([
    prisma.instance.findUnique({
      where: { id: instanceId },
      select: { name: true, currentStage: true },
    }),
    loadSecondRoundList(instanceId, reviewer.id),
    // **The same state the profile reads to show or hide the vote control.**
    // This page used to assert "voting happens in a pass, which an admin opens"
    // as a fixed string, which went on saying so after a pass was open — telling
    // a reviewer there was nothing to do while every profile offered them a
    // vote. The list had never learned that passes exist.
    prisma.pass.findFirst({
      where: { instanceId, status: PassStatus.OPEN },
      select: { id: true },
    }),
  ]);

  if (!instance) notFound();

  const flagged = conflictCount(rows);
  // Decision 112: the row count stopped answering "how much is left". Both
  // numbers come from lib/second-round.ts so the header cannot disagree with the
  // rows underneath it.
  const undecided = undecidedCount(rows);

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
          // Stage is SECOND_ROUND and the cohort is empty: the first round was
          // finalized and advanced nobody. A real state, and a different one
          // from both of the above.
          //
          // **This branch used to mean something else.** Before decision 112 the
          // list was `status = ACTIVE`, so an empty one also meant "every
          // applicant has been resolved" — which is now impossible here, because
          // resolved applicants keep their rows. That sentence moved to the
          // header below, where it is derived from the rows rather than from
          // their absence.
          <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
            Nobody was advanced to the second round. The first round has been finalized — ask in
            Slack if that looks wrong.
          </p>
        )
      ) : (
        <>
          <p className="mt-5 text-sm font-medium">
            {rows.length} applicant{rows.length === 1 ? "" : "s"} in the round
            {undecided < rows.length ? (
              <span className="text-muted-foreground font-normal">
                {" · "}
                {undecided === 0 ? "all decided" : `${undecided} still to decide`}
              </span>
            ) : null}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {undecided === 0
              ? "Every applicant has been decided. These stay here so you can see how the round finished."
              : openPass
                ? "A pass is open. Open an applicant to read their full profile and vote."
                : "Open an applicant to read their full profile. Voting happens in a pass, which an admin opens — until then this is here to read."}
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
                  {/* The label beside the name, not instead of it: §6 gives a
                      second-round reviewer the name, and names are not unique.
                      Two applicants here are both called "Diego Hoffmann". */}
                  <span className="font-medium">
                    {row.displayName}
                    <span className="text-muted-foreground ml-2 text-xs font-normal">
                      {applicantLabel(row.sourceRowIndex)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {/* Decision 111. The outcome, and only the outcome — the
                        label is what carries the meaning and the colour is the
                        thing you can read across a list at a glance. No count
                        and no other reviewer, per decision 74's surviving half.

                        `STATUS_LABEL` rather than a word invented here, so the
                        reviewer's list, the profile and every admin surface all
                        call a Sparklet the same thing. */}
                    {row.outcome !== null ? (
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                          OUTCOME_TONE[row.outcome]
                        }`}
                      >
                        {STATUS_LABEL[row.outcome]}
                      </span>
                    ) : null}
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
                {/* Decision 100: once the round is closed there is nothing a
                    conflict could still bear on, and the action refuses one, so
                    the control is absent rather than offered and refused.

                    **The same rule now covers a resolved applicant**, and this
                    is the half decision 112 would have broken by accident.
                    `flagConflict` re-checks `SECOND_ROUND_POOL` — status ACTIVE
                    — deliberately, because a resolved applicant is readable but
                    not writable. Keeping their row on the list without this
                    would put a working-looking control on every green and red
                    row that the action then refuses, which is exactly the
                    offered-and-refused shape decision 100 exists to prevent. */}
                {finished || row.outcome !== null ? null : (
                  <div className="border-t border-dashed px-4">
                    <ConflictControl
                      instanceId={instanceId}
                      applicantId={row.applicantId}
                      applicantName={row.displayName}
                      flagged={row.hasConflict}
                      variant="row"
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
