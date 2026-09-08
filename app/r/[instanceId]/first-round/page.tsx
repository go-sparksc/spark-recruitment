import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { loadFirstRoundList } from "./load";
import { SignOutButton } from "../sign-out-button";
import { InstanceStage, Round } from "@/generated/prisma/enums";
import { filterFirstRoundRows, votedCount } from "@/lib/first-round";
import { applicantLabel } from "@/lib/review";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";

export const metadata = { title: "First round — Spark SC" };

/// FR-14's list. Every applicant still in the first round, and a way to find
/// one — decision 113 moved the vote onto the applicant's own page.
///
/// **The vote is no longer on the row, and the comment that used to stand here
/// argued the opposite.** It said a first-round reviewer "is deciding on two
/// numbers and a paragraph, so the summary on the row is the whole basis of the
/// decision". That was never true of this screen: the row shows *how much
/// interview data exists* — "2 scores · notes" — and links to the page that
/// holds it. A vote cast from here was cast on a name and a count, which is what
/// decision 82 says the explicit-submit requirement exists to prevent, and
/// decision 113 applies that reasoning one round earlier.
///
/// **What the row keeps is the reviewer's own vote, as a marker.** Decision 82's
/// own cost paragraph grants this — a per-row marker of your own vote is
/// additive and reveals nothing, and decision 74 forbids only somebody else's.
/// Decision 62's "voted on N of M" counter rests on the same data. So the first
/// round takes the second round's pattern without taking its cost, and the
/// second round's list stays bare on its own separate reasoning.
export default async function FirstRoundListPage({
  params,
  searchParams,
}: {
  params: Promise<{ instanceId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { instanceId } = await params;
  const { q } = await searchParams;
  const query = typeof q === "string" ? q : "";
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  // A reviewer signed in for another round lands on their own list rather than
  // an empty first-round one.
  if (session.rd !== Round.FIRST_ROUND) redirect(`/r/${instanceId}/list`);

  const [instance, rows] = await Promise.all([
    prisma.instance.findUnique({
      where: { id: instanceId },
      select: { name: true, currentStage: true },
    }),
    loadFirstRoundList(instanceId, reviewer.id),
  ]);

  if (!instance) notFound();

  // Decision 62. The same navigational aid FR-9 gives written reviewers, and
  // more useful here: nothing narrows this list, so "am I done" is otherwise
  // unanswerable without counting.
  //
  // **Over `rows`, not over `visible`.** A search box now narrows what is
  // rendered, and counting the filtered set would make this number answer a
  // question nobody asked — "voted on 1 of 1" under a search for one name reads
  // as finished.
  const voted = votedCount(rows);
  const visible = filterFirstRoundRows(rows, query);

  // Decision 64. Anything past FIRST_ROUND means the round has been finalized;
  // WRITTEN means it has not opened. Compared by identity rather than ordering,
  // since InstanceStage is not an ordered type in TypeScript and a greater-than
  // over its string values would work by alphabetical accident and break the
  // first time a value is added — the same reasoning clause 11e used.
  const finished =
    instance.currentStage === InstanceStage.SECOND_ROUND ||
    instance.currentStage === InstanceStage.COMPLETE;

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

      {/* PRD decision 64. An empty list means two opposite things — the round is
          over, or it has not started — and before this it said the second in
          both cases, so a reviewer opening the app the morning after the round
          closed was told nobody had reached it yet.

          `currentStage` is what tells them apart, the second reader for the
          field decision 43 added. Past FIRST_ROUND means finished; still on
          WRITTEN means not started. */}
      {rows.length === 0 ? (
        finished ? (
          <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
            The first round is closed and the decisions have been made. Thank you — nothing further
            is needed from you here.
          </p>
        ) : (
          <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
            Nobody has reached the first round yet. An admin advances applicants once the written
            round is finalized — check back, or ask in Slack.
          </p>
        )
      ) : (
        <>
          <p className="mt-5 text-sm font-medium">
            Voted on {voted} of {rows.length}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            Open an applicant to read their interview scores and vote. You can change a vote any
            time before the round is finalized. Leaving one blank counts as a skip and does not
            count against the applicant.
          </p>

          {/* A plain GET form, so it works with no JavaScript and before React
              hydrates — decision 33 measured that window at ~640 ms on a warm
              desktop route, and this is a phone. A client-side filter would be
              snappier and would be dead for exactly as long as it took a
              reviewer to type into it.

              The query also survives in the URL, so a reviewer who opens an
              applicant and comes back lands on the same narrowed list. */}
          <form method="GET" className="mt-4 flex gap-2">
            <input
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Find by name or number"
              aria-label="Find an applicant by name or number"
              className="min-h-12 flex-1 rounded-md border px-3 text-base"
            />
            <button
              type="submit"
              className="hover:bg-muted min-h-12 rounded-md border px-4 text-sm font-medium"
            >
              Find
            </button>
          </form>

          {query.trim() !== "" ? (
            <p className="text-muted-foreground mt-2 text-sm">
              {visible.length} of {rows.length} shown ·{" "}
              <Link href={`/r/${instanceId}/first-round`} className="underline">
                Clear
              </Link>
            </p>
          ) : null}

          {visible.length === 0 ? (
            <p className="text-muted-foreground mt-3 rounded-md border p-4 text-sm">
              Nobody in this round matches “{query.trim()}”.
            </p>
          ) : null}

          <ul className="mt-3 space-y-2">
            {visible.map((row) => (
              <li key={row.applicantId} className="rounded-md border p-3">
                <div className="flex items-baseline justify-between gap-3">
                  {/* **The handle beside the name, and it is load-bearing on
                      this screen rather than decorative.** Names collide — the
                      seed carries two "Diego Hoffmann", which is the spreadsheet
                      defect arriving at the presentation layer after the data
                      model correctly refused it, and Phase 6 hit exactly this on
                      FR-18's grid.

                      Decision 113 raises the stakes here: this list is now a
                      surface for *finding* someone, and a search for "diego"
                      returning two identical rows leaves a reviewer opening both
                      to tell which is which. It is also what makes the number
                      searchable in practice — the filter matches
                      `sourceRowIndex`, and before this the row never showed a
                      reviewer what number to type. Found by searching this
                      screen rather than by reading the diff. */}
                  <Link
                    href={`/r/${instanceId}/first-round/${row.applicantId}`}
                    className="font-medium hover:underline"
                  >
                    {row.displayName}
                    <span className="text-muted-foreground ml-2 text-xs font-normal">
                      {applicantLabel(row.sourceRowIndex)}
                    </span>
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

                {/* Decision 113's marker, in place of the control that used to
                    sit here. Their own vote and nobody else's — decision 74
                    forbids the rest, and there is no count on this page to leak.

                    **Deliberately not the green/red of decision 111.** That
                    colour means an outcome — the round decided this person —
                    and a reviewer who saw their own "yes" in green would read
                    it as the applicant having got through. This says what it
                    is, in words, in the muted tone everything else secondary on
                    this row uses. */}
                {row.vote === null ? null : (
                  <p className="text-muted-foreground mt-2 text-sm">
                    You voted {row.vote === "YES" ? "yes" : "no"}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
