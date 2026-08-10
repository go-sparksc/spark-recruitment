import Link from "next/link";
import { notFound } from "next/navigation";

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
import { duplicateHeaders } from "@/lib/import/parse-csv";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Map columns — Spark SC Recruitment" };

interface StoredProposal {
  columnIndexes: number[];
  headers: string[];
  isMultiSelect: boolean;
}

/// Slice 2 renders what the import found. Slice 3 makes every control on this
/// page work — display name, category, include, per-round visibility, and the
/// group operations (name, dismiss, rename, split, merge, assign).
export default async function MappingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireInstance(id, `/instances/${id}/mapping`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      importCommittedAt: true,
      importProposals: true,
      fields: { orderBy: { ordinal: "asc" } },
      _count: { select: { importRows: true } },
    },
  });

  if (!instance) notFound();

  const proposals = ((instance.importProposals as { proposals?: StoredProposal[] } | null)
    ?.proposals ?? []) as StoredProposal[];
  const proposedColumns = new Set(proposals.flatMap((p) => p.columnIndexes));
  const duplicates = new Set(duplicateHeaders(instance.fields.map((f) => f.sourceHeader)));

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-16">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← Instances
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{instance.name}</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {instance.fields.length} columns and {instance._count.importRows} applicants read from the
        file. Nothing is created until you commit.
      </p>

      {proposals.length > 0 ? (
        <Card className="border-amber-500/40 mt-8">
          <CardHeader>
            <CardTitle className="text-base">
              {proposals.length === 1 ? "One group was detected" : `${proposals.length} groups were detected`}
            </CardTitle>
            <CardDescription>
              A detected group is a suggestion, not a decision — nothing is stored until you name it.
              Naming it creates it; dismissing it discards it. Both arrive in the next slice.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {proposals.map((proposal, i) => (
              <div key={i} className="rounded-md border p-4">
                <p className="text-sm font-medium">
                  {proposal.columnIndexes.length} adjacent columns, every value matching its own
                  header
                </p>
                <ul className="text-muted-foreground mt-2 space-y-0.5 text-sm">
                  {proposal.headers.map((header) => (
                    <li key={header}>· {header}</li>
                  ))}
                </ul>
                <p className="text-muted-foreground mt-3 text-xs">
                  A free-text write-in for this question will not have been detected — its values
                  vary by definition. Attaching it is a manual step.
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Columns</CardTitle>
          <CardDescription>
            Every column starts as Other and included. Categories are not guessed from header text.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-right">#</TableHead>
                  <TableHead>Source header</TableHead>
                  <TableHead>Display name</TableHead>
                  <TableHead>Category</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {instance.fields.map((field) => (
                  <TableRow key={field.id}>
                    <TableCell className="text-muted-foreground text-right tabular-nums">
                      {field.ordinal + 1}
                    </TableCell>
                    <TableCell className="max-w-md">
                      {/* Rendered with the newlines and trailing spaces intact —
                          this is what the file actually contains, and the whole
                          point of storing sourceHeader verbatim. */}
                      <span className="font-mono text-xs break-words whitespace-pre-wrap">
                        {field.sourceHeader}
                      </span>
                      {duplicates.has(field.sourceHeader) ? (
                        <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                          duplicate header
                        </span>
                      ) : null}
                      {proposedColumns.has(field.ordinal) ? (
                        <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs">
                          in a detected group
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{field.displayName}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {field.category.toLowerCase()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
