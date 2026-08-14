import Link from "next/link";
import { notFound } from "next/navigation";

import { loadPreview } from "./load";
import { CommitButton, RowControls } from "./preview-controls";
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

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Commit</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <CommitButton
            instanceId={id}
            canCommit={findings.canCommit}
            keptCount={findings.keptCount}
            warningCount={findings.warnings.length}
          />
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
