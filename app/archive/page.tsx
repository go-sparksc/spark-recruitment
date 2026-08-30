import Link from "next/link";

import { PurgeForm } from "./purge-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { purgePlan } from "@/lib/archive";
import { retentionCycles, retentionView } from "@/lib/archive-io";
import { requireAdmin } from "@/lib/auth";

export const metadata = { title: "Retention — Spark SC Recruitment" };

/// §8's retention screen. PRD decisions 94 and 95.
///
/// Cross-instance by nature — "cycles older than a threshold" is not a question
/// about one cycle — so it lives at the app level rather than under
/// /instances/[id].
///
/// `requireAdmin` alone, matching FR-5's precedent for deletion. See the note on
/// `purgeInstance`.
export default async function ArchivePage() {
  await requireAdmin("/archive");

  const cycles = retentionCycles();
  const { retained, candidates, alreadyArchived, cutoff } = await retentionView();
  const plan = purgePlan();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← Instances
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Retention</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        The club keeps the <strong>{cycles} most recent</strong> recruitment cycles in full.
        Anything older can have its applicant data deleted while its statistics are kept.
      </p>
      <p className="text-muted-foreground mt-2 text-xs">
        Set by <code>RETENTION_CYCLES</code> in the deployment&apos;s environment, deliberately not
        editable here — a threshold anyone with the app password could lower would be a
        delete-everything button. Changing it needs a redeploy.
      </p>

      <section className="mt-10">
        <h2 className="text-lg font-medium">Old enough to archive</h2>

        {candidates.length === 0 ? (
          <p className="text-muted-foreground mt-3 text-sm">
            Nothing yet. With {retained.length}{" "}
            {retained.length === 1 ? "cycle" : "cycles"} on record and a threshold of {cycles},
            every cycle is still within the retention window.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground mt-3 text-sm">
              This cannot be undone. Export a cycle first if there is any chance the club will
              want its applications back.
            </p>

            {candidates.map((instance) => (
              <Card key={instance.id} className="border-destructive/40 mt-6">
                <CardHeader>
                  <CardTitle className="text-base">{instance.name}</CardTitle>
                  <CardDescription>
                    Created {instance.createdAt.toLocaleDateString("en-CA", { timeZone: "UTC" })}
                    {" · "}
                    <Link
                      href={`/instances/${instance.id}/export`}
                      className="underline underline-offset-2"
                    >
                      export it first
                    </Link>
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <PurgeForm instanceId={instance.id} instanceName={instance.name} />
                </CardContent>
              </Card>
            ))}
          </>
        )}
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-medium">What archiving removes</h2>
        <ul className="mt-3 space-y-3 text-sm">
          {plan.map((step) => (
            <li key={step.table}>
              <span className="font-medium">
                {step.action === "DELETE"
                  ? `Every ${step.table} row`
                  : `${step.table}: ${step.columns?.join(", ")}`}
              </span>
              <span className="text-muted-foreground block text-xs">{step.why}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-4 text-sm">
          Scores, votes, decisions, assignments, passes, reviewers and the rubric are kept. So is
          the demographic breakdown, frozen as numbers before the answers behind it are deleted.
        </p>
      </section>

      {alreadyArchived.length > 0 ? (
        <section className="mt-12">
          <h2 className="text-lg font-medium">Already archived</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {alreadyArchived.map((instance) => (
              <li key={instance.id}>
                <Link href={`/instances/${instance.id}/archive`} className="hover:underline">
                  {instance.name}
                </Link>
                <span className="text-muted-foreground">
                  {" — "}
                  {instance.archivedAt?.toLocaleDateString("en-CA", { timeZone: "UTC" })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-12">
        <h2 className="text-lg font-medium">Kept in full</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {retained.map((instance) => (
            <li key={instance.id}>
              <Link href={`/instances/${instance.id}`} className="hover:underline">
                {instance.name}
              </Link>
              <span className="text-muted-foreground">
                {" — created "}
                {instance.createdAt.toLocaleDateString("en-CA", { timeZone: "UTC" })}
              </span>
            </li>
          ))}
        </ul>
        {cutoff === null ? null : (
          <p className="text-muted-foreground mt-4 text-xs">
            Records of deleted cycles older than{" "}
            {cutoff.toLocaleDateString("en-CA", { timeZone: "UTC" })} are removed alongside the
            next archive, so they cannot accumulate forever.
          </p>
        )}
      </section>
    </main>
  );
}
