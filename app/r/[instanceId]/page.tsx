import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { SignInForm, type ReviewerOption } from "./sign-in-form";
import { Round } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { readReviewer } from "@/lib/reviewer-auth";

export const metadata = { title: "Sign in to review — Spark SC" };

const ROUNDS = [Round.WRITTEN, Round.FIRST_ROUND, Round.SECOND_ROUND];

const ROUND_LABELS: Record<Round, string> = {
  [Round.WRITTEN]: "Written",
  [Round.FIRST_ROUND]: "First round",
  [Round.SECOND_ROUND]: "Second round",
};

function parseRound(value: string | undefined): Round {
  return ROUNDS.find((round) => round === value) ?? Round.WRITTEN;
}

/// FR-9's entry point. Deliberately outside the §8 app-level gate: reviewers do
/// not hold the admin password and never see the instance list. The link itself
/// is the first factor — the id is a cuid and not enumerable — and the round
/// access code is the second.
///
/// The round is a set of links rather than client state, so switching it
/// re-reads that round's roster on the server. A client-side selector would
/// leave the name dropdown showing the previous round's reviewers, which is a
/// sign-in that fails for a reason nobody can see.
export default async function ReviewerSignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ instanceId: string }>;
  searchParams: Promise<{ round?: string }>;
}) {
  const { instanceId } = await params;
  const { round: roundParam } = await searchParams;

  const round = parseRound(roundParam);

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { id: true, name: true },
  });

  if (!instance) notFound();

  // Already signed in for this instance — including on a different round, since
  // the session names one. Send them on rather than making them sign in twice.
  const existing = await readReviewer(instanceId);
  if (existing) redirect(`/r/${instanceId}/list`);

  const [accessCode, reviewers] = await Promise.all([
    prisma.roundAccessCode.findUnique({
      where: { instanceId_round: { instanceId, round } },
      select: { round: true },
    }),
    prisma.reviewer.findMany({
      where: { instanceId, rounds: { has: round } },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const options: ReviewerOption[] = reviewers.map((reviewer) => ({
    id: reviewer.id,
    name: `${reviewer.firstName} ${reviewer.lastName}`,
  }));

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Spark SC review</h1>
      <p className="text-muted-foreground mt-1 text-sm">{instance.name}</p>

      <nav className="mt-6 flex gap-2 text-sm" aria-label="Round">
        {ROUNDS.map((value) => (
          <Link
            key={value}
            href={`/r/${instanceId}?round=${value}`}
            aria-current={value === round ? "page" : undefined}
            className={
              value === round
                ? "bg-foreground text-background rounded-md px-3 py-2"
                : "hover:bg-muted rounded-md border px-3 py-2"
            }
          >
            {ROUND_LABELS[value]}
          </Link>
        ))}
      </nav>

      {/* Three states, and each says what to do next rather than presenting a
          form that cannot succeed. An admin who has not set a code yet is the
          likeliest cause of the first two, and a reviewer cannot fix either by
          trying harder. */}
      {accessCode === null ? (
        <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
          The {ROUND_LABELS[round].toLowerCase()} is not open yet — no access code has been set for
          it. Ask a Spark SC admin to set one.
        </p>
      ) : options.length === 0 ? (
        <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
          No reviewers are on the {ROUND_LABELS[round].toLowerCase()} roster yet. Ask a Spark SC
          admin to add you.
        </p>
      ) : (
        <SignInForm instanceId={instanceId} round={round} reviewers={options} />
      )}
    </main>
  );
}
