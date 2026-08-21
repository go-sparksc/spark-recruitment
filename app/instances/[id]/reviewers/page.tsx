import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessCodeCard } from "./access-code-card";
import { RosterControls, type ReviewerRow } from "./roster-controls";
import { InstanceCrumbs } from "../instance-crumbs";
import { InstanceStage, Round } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Reviewers — Spark SC Recruitment" };

const ROUNDS = [Round.WRITTEN, Round.FIRST_ROUND, Round.SECOND_ROUND];

function parseRound(value: string | undefined): Round {
  return ROUNDS.find((round) => round === value) ?? Round.WRITTEN;
}

/// FR-6. The page is round-scoped because a paste staffs one round; the roster
/// grid below it is instance-wide, since `Reviewer` is one row per person
/// carrying which rounds they serve.
export default async function ReviewersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ round?: string }>;
}) {
  const { id } = await params;
  const { round: roundParam } = await searchParams;
  await requireInstance(id, `/instances/${id}/reviewers`);

  const round = parseRound(roundParam);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      currentStage: true,
      importCommittedAt: true,
      _count: { select: { applicants: true } },
    },
  });

  if (!instance) notFound();

  const accessCode = await prisma.roundAccessCode.findUnique({
    where: { instanceId_round: { instanceId: id, round } },
    // Deliberately not selecting codeHash. §8 puts access codes under the same
    // rule as passwords, and a hash that is never loaded cannot be rendered.
    select: { id: true },
  });

  const reviewers = await prisma.reviewer.findMany({
    where: { instanceId: id },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      isSparklet: true,
      rounds: true,
      _count: { select: { assignments: true } },
    },
  });

  // Decisions 66 and 78, on the round being staffed. COMPLETE counts as fixed
  // too: the round is over and its roster is a historical fact.
  const rosterFixed =
    round === Round.SECOND_ROUND &&
    (instance.currentStage === InstanceStage.SECOND_ROUND ||
      instance.currentStage === InstanceStage.COMPLETE);

  const rows: ReviewerRow[] = reviewers.map((reviewer) => ({
    id: reviewer.id,
    firstName: reviewer.firstName,
    lastName: reviewer.lastName,
    isSparklet: reviewer.isSparklet,
    rounds: reviewer.rounds,
    assignmentCount: reviewer._count.assignments,
  }));

  return (
    <main className="mx-auto w-full max-w-4xl space-y-8 px-6 py-12">
      <div className="space-y-1">
        <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />
        <h1 className="text-2xl font-semibold">Reviewers</h1>
      </div>

      {instance._count.applicants === 0 ? (
        <p className="text-muted-foreground rounded-md border p-4 text-sm">
          This instance has no applicants yet. You can build the roster now, but there is nothing
          to assign it to until the CSV is imported.
        </p>
      ) : null}

      <nav className="flex gap-2 text-sm" aria-label="Round being staffed">
        {ROUNDS.map((value) => (
          <Link
            key={value}
            href={`/instances/${id}/reviewers?round=${value}`}
            aria-current={value === round ? "page" : undefined}
            className={
              value === round
                ? "bg-foreground text-background rounded-md px-3 py-1.5"
                : "hover:bg-muted rounded-md border px-3 py-1.5"
            }
          >
            {value === Round.WRITTEN
              ? "Written"
              : value === Round.FIRST_ROUND
                ? "First round"
                : "Second round"}
          </Link>
        ))}
      </nav>

      {/* key={round}: the round nav above is a client navigation, so without it
          this component stays mounted across a round switch and carries the
          previous round's success message and typed code onto the new one. */}
      <AccessCodeCard
        key={round}
        instanceId={id}
        round={round}
        hasCode={accessCode !== null}
      />

      {/* Decisions 66 and 78. The actions refuse this on their own — they are
          the boundary — and this is what stops an admin discovering the rule by
          typing a name into a box that then throws it away. It says which
          direction is locked and why, because "you cannot edit this" with no
          reason reads as a bug. */}
      {rosterFixed ? (
        <p className="rounded-md border p-4 text-sm">
          <span className="font-medium">This roster is fixed.</span>{" "}
          <span className="text-muted-foreground">
            The second round has started, and how many votes it takes to decide an applicant
            depends on exactly who is on it. Neither adding nor removing a second-round reviewer
            is possible until the round is closed. Names can still be corrected, and the written
            and first-round rosters are unaffected.
          </span>
        </p>
      ) : null}

      <RosterControls instanceId={id} round={round} reviewers={rows} />
    </main>
  );
}
