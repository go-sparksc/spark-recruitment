import Link from "next/link";
import { notFound } from "next/navigation";

import { loadPreview } from "./load";
import { CommitForm, RowControls } from "./preview-controls";
import { ImportCommitted } from "../import-committed";
import { InstanceCrumbs } from "../instance-crumbs";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Preview import — Spark SC Recruitment" };

export default async function PreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ confirm?: string }>;
}) {
  const { id } = await params;
  const { confirm } = await searchParams;
  await requireInstance(id, `/instances/${id}/preview`);

  const loaded = await loadPreview(id);
  if (!loaded) notFound();

  const { instance, findings } = loaded;

  if (instance.importCommittedAt !== null) {
    const applicantCount = await prisma.applicant.count({ where: { instanceId: id } });
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-16">
        <InstanceCrumbs instanceId={id} instanceName={instance.name} />
        <ImportCommitted
          instanceId={id}
          instanceName={instance.name}
          applicantCount={applicantCount}
          committedAt={instance.importCommittedAt}
        />
      </main>
    );
  }

  // Step two of decision 35's guard, held in the URL rather than in client
  // state so it survives with no JavaScript. Gated on canCommit as well, so a
  // bookmarked or stale `?confirm=1` cannot present a confirmation for an import
  // that a blocker has since made impossible.
  const confirming = confirm === "1" && findings.canCommit;

  const duplicateRowIndexes = new Set(findings.duplicates.flatMap((d) => d.rowIndexes));
  const blankNames = new Set(findings.blankNameRowIndexes);
  const blankEmails = new Set(findings.blankEmailRowIndexes);
  const padded = new Set(findings.paddedEmailRowIndexes);

  // Rows worth the admin's attention, plus any they have already discarded so
  // the decision stays visible and reversible.
  const notable = findings.rows.filter(
    (row) =>
      row.discarded ||
      duplicateRowIndexes.has(row.rowIndex) ||
      blankNames.has(row.rowIndex) ||
      blankEmails.has(row.rowIndex) ||
      padded.has(row.rowIndex),
  );

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      {/* The step back to mapping is the button at the foot of this page, which
          is the more findable of the two; the crumb here is the instance-level
          route decision 36 asks every instance page to carry. */}
      <InstanceCrumbs instanceId={id} instanceName={instance.name} />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{instance.name}</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {findings.keptCount} applicant{findings.keptCount === 1 ? "" : "s"} will be created
        {findings.discardedCount > 0 ? `, ${findings.discardedCount} discarded` : null}. This is the
        last point at which a bad file is cheap to fix.
      </p>

      {findings.blockers.length > 0 ? (
        <Card className="border-destructive/50 mt-8">
          <CardHeader>
            <CardTitle className="text-base">Resolve before committing</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {findings.blockers.map((b) => (
                <li key={b}>· {b}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {findings.warnings.length > 0 ? (
        <Card className="mt-8 border-amber-500/40">
          <CardHeader>
            <CardTitle className="text-base">Worth checking</CardTitle>
            <CardDescription>
              None of these block the import. Each describes an instance that could legitimately be
              what you meant.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {findings.warnings.map((w) => (
                <li key={w}>· {w}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {notable.length > 0 ? (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Rows needing a decision</CardTitle>
            <CardDescription>
              Edit an address to correct it, or discard the row. Discarding is reversible until you
              commit, and leaves a gap in the numbering rather than renumbering — row numbers point
              at records in your file.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12 text-right">Row</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Why</TableHead>
                    <TableHead>Email and action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {notable.map((row) => {
                    const reasons = [
                      duplicateRowIndexes.has(row.rowIndex) ? "duplicate email" : null,
                      blankNames.has(row.rowIndex) ? "no name" : null,
                      blankEmails.has(row.rowIndex) ? "no email" : null,
                      padded.has(row.rowIndex) ? "email has surrounding spaces" : null,
                    ].filter((r): r is string => r !== null);

                    return (
                      <TableRow key={row.rowIndex} className={row.discarded ? "opacity-50" : ""}>
                        <TableCell className="text-muted-foreground text-right tabular-nums">
                          {row.rowIndex}
                        </TableCell>
                        <TableCell className="text-sm">
                          {row.displayName || (
                            <span className="text-destructive">(no name)</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {row.discarded ? "discarded" : reasons.join(", ")}
                        </TableCell>
                        <TableCell>
                          <RowControls
                            instanceId={id}
                            rowIndex={row.rowIndex}
                            discarded={row.discarded}
                            rawEmail={row.rawEmail}
                            editable={loaded.emailOrdinal !== null}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-8">
          <CardContent className="text-muted-foreground py-6 text-center text-sm">
            No duplicates, blank names, blank addresses, or padded addresses.
          </CardContent>
        </Card>
      )}

      {/* Decision 35's two-step guard. Both steps are server-rendered: step one
          is a Link, step two is a form bound to a server action, so neither is
          a dead tap before hydration and neither fires from a stray click on a
          page whose whole purpose is reviewing and adjusting.

          Deliberately lighter than FR-5's typed-name gate for deletion, which
          is rare and destroys work that exists. This creates rather than
          destroys, it is on the path every instance takes, and since decision
          34 it no longer takes the visibility controls down with it. */}
      <Card className={`mt-8 ${confirming ? "border-amber-500/60" : ""}`}>
        <CardHeader>
          <CardTitle>{confirming ? "Commit this import?" : "Commit"}</CardTitle>
          {confirming ? (
            <CardDescription>There is no undo. Here is what changes.</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {confirming ? (
            <>
              <ul className="space-y-1.5 text-sm">
                <li>
                  · <strong className="font-medium">{findings.keptCount}</strong> applicant
                  {findings.keptCount === 1 ? "" : "s"} are created
                  {findings.discardedCount > 0
                    ? `, and ${findings.discardedCount} discarded row${
                        findings.discardedCount === 1 ? "" : "s"
                      } are not`
                    : null}
                  .
                </li>
                <li>
                  · This instance will <strong className="font-medium">not accept another CSV</strong>.
                  Importing a corrected file means deleting the instance and starting again, which
                  removes every applicant, assignment and score with it.
                </li>
                <li>
                  · Each column&apos;s <strong className="font-medium">meaning</strong> is fixed:
                  its category, its grouping, its display name, and which column is the email and
                  which the name.
                </li>
                <li className="text-muted-foreground">
                  · Still yours to change afterwards: whether a column is included, and which rounds
                  can see it. Those stay on the mapping table for the whole cycle.
                </li>
                {findings.warnings.length > 0 ? (
                  <li className="text-amber-700 dark:text-amber-400">
                    · {findings.warnings.length} warning
                    {findings.warnings.length === 1 ? "" : "s"} above{" "}
                    {findings.warnings.length === 1 ? "is" : "are"} unresolved. They do not block
                    this, but they are much harder to fix afterwards.
                  </li>
                ) : null}
              </ul>

              <div className="flex flex-wrap items-center gap-3">
                <CommitForm instanceId={id} keptCount={findings.keptCount} />
                <Link
                  href={`/instances/${id}/preview`}
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  No, keep reviewing
                </Link>
              </div>
            </>
          ) : (
            <>
              {findings.canCommit ? (
                <Link href={`/instances/${id}/preview?confirm=1`} className={buttonVariants()}>
                  Commit — create {findings.keptCount} applicant
                  {findings.keptCount === 1 ? "" : "s"}…
                </Link>
              ) : (
                <p className="text-muted-foreground text-sm">Resolve the problems above first.</p>
              )}
              <p className="text-muted-foreground text-xs">
                {findings.canCommit
                  ? "You will see exactly what becomes final before anything is created."
                  : null}
              </p>
            </>
          )}

          <Link
            href={`/instances/${id}/mapping`}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Back to column mapping
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
