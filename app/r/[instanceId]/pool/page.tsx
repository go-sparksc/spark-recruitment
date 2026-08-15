import Link from "next/link";

import { claimSlot } from "../actions";
import { openPoolFor } from "../pool-query";
import { claimMessage } from "@/lib/claim-slot";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";

export const metadata = { title: "Claim from the pool — Spark SC" };

/// FR-9 bullet 6: "'Claim from pool,' showing open assignment slots on
/// applicants who are short a reviewer."
///
/// **One screen, one tap per row, and no confirmation.** Claiming is reversible
/// by the return control on the very next screen, so a confirmation step would
/// buy nothing and cost the tap budget CLAUDE.md rule 5 is about. Returning is
/// the one that asks a question, because it is the one that needs a reason.
export default async function PoolPage({
  params,
  searchParams,
}: {
  params: Promise<{ instanceId: string }>;
  searchParams: Promise<{ claim?: string }>;
}) {
  const { instanceId } = await params;
  const { claim } = await searchParams;
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  const rows = await openPoolFor(instanceId, session.rd, {
    id: reviewer.id,
    isSparklet: reviewer.isSparklet,
  });

  // Set when this reviewer lost a race, or tried to claim something the list
  // was already stale about. Never a 500 — see claimSlot.
  const message = claimMessage(claim);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <Link href={`/r/${instanceId}/list`} className="text-muted-foreground text-sm hover:underline">
        ← Your applicants
      </Link>

      <header className="mt-3 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Applicants needing a reviewer</h1>
        <p className="text-muted-foreground text-sm">
          Anything you claim is added to your list. You can hand it back if you know them.
        </p>
      </header>

      {message ? (
        // aria-live because this arrives on a fresh render after a redirect,
        // and a reviewer who tapped Claim needs to be told why they are still
        // on this page.
        <p
          aria-live="polite"
          className="border-destructive/40 bg-destructive/5 text-destructive mt-4 rounded-md border p-3 text-sm"
        >
          {message}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
          Nothing is open right now. Every applicant has a full set of reviewers, or the ones
          that are short are people you are already reviewing.
        </p>
      ) : (
        <ul className="mt-5 divide-y rounded-md border">
          {rows.map((row) => (
            <li key={row.applicantId} className="flex min-h-14 items-center gap-3 px-4 py-3">
              <span className="font-medium">{row.label}</span>
              {/* Clause 6b, in the words a reviewer can act on: how many it has
                  now against how many it needs. */}
              <span className="text-muted-foreground text-sm">
                {row.activeCount} of {row.target} reviewers
              </span>
              <form action={claimSlot} className="ml-auto">
                <input type="hidden" name="instanceId" value={instanceId} />
                <input type="hidden" name="applicantId" value={row.applicantId} />
                <button
                  type="submit"
                  className="hover:bg-muted h-11 rounded-md border px-4 text-sm font-medium"
                >
                  Claim
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
