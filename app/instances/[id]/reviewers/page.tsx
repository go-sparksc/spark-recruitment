import Link from "next/link";
import { notFound } from "next/navigation";

import { RosterControls, type ReviewerRow } from "./roster-controls";
import { Round } from "@/generated/prisma/enums";
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
    select: { id: true, name: true, importCommittedAt: true, _count: { select: { applicants: true } } },
  });

  if (!instance) notFound();

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
        <Link href="/" className="text-muted-foreground text-sm hover:underline">
          ← Instances
        </Link>
        <h1 className="text-2xl font-semibold">Reviewers</h1>
        <p className="text-muted-foreground text-sm">{instance.name}</p>
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

      <RosterControls instanceId={id} round={round} reviewers={rows} />
    </main>
  );
}
