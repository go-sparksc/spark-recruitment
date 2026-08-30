import Link from "next/link";
import { notFound } from "next/navigation";

import { InstanceCrumbs } from "../instance-crumbs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { actorLabel, auditPageWindow, humanizeAction, AUDIT_PAGE_SIZE } from "@/lib/audit";
import { requireInstanceUnlocked } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Activity — Spark SC Recruitment" };

/// §8's audit log, made readable. PRD decisions 16 and 93.
///
/// **The instance gate, NOT `requireAdmin` — a deliberate departure from the
/// settings page this is linked from.** §8 says in as many words that
/// `previousValue` payloads can carry applicant data, and settings gates on the
/// app password alone so that an admin who has lost an instance's password can
/// still reach FR-5's recovery path. Rendering audit rows under that gate would
/// hand applicant data to someone who has never unlocked the cycle. The recovery
/// path does not need to read the log, so the two pages gate differently.
///
/// **`requireInstanceUnlocked` rather than `requireInstance`**, so this page
/// survives an archive-and-purge — one of decision 95's four named exemptions.
/// The purge nulls every `previousValue` on the cycle, so the applicant data
/// that justified the stricter gate above is precisely what is no longer here;
/// and the purge writes its own `ARCHIVE_AND_PURGE` row into this table, so
/// hiding this page would leave the most consequential act in a cycle's life
/// visible only inside a JSON export.
///
/// Writing the log has been in place since Phase 2; nothing read it until now
/// except FR-20's export. That is what made decision 16's attribution worth
/// buying — a name recorded where no one can see it is a name recorded for the
/// benefit of whoever eventually opens the JSON.
export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page: requestedPage } = await searchParams;

  await requireInstanceUnlocked(id, `/instances/${id}/audit`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!instance) notFound();

  const total = await prisma.auditLog.count({ where: { instanceId: id } });
  const window = auditPageWindow(total, Number(requestedPage ?? 1), AUDIT_PAGE_SIZE);

  const rows = await prisma.auditLog.findMany({
    where: { instanceId: id },
    orderBy: { createdAt: "desc" },
    skip: window.skip,
    take: window.take,
    select: {
      id: true,
      actor: true,
      actorName: true,
      action: true,
      entityType: true,
      entityId: true,
      previousValue: true,
      createdAt: true,
    },
  });

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Activity</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Every override, reset and deletion on this cycle, newest first. Recorded automatically;
        nothing here can be edited or removed from inside the app.
      </p>

      {total === 0 ? (
        <p className="text-muted-foreground mt-10 text-sm">
          Nothing has been recorded for this cycle yet. Manual assignment changes, rubric edits,
          decision reversals and password resets all appear here.
        </p>
      ) : (
        <>
          <div className="mt-8 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {/* Three columns, not four. A separate Details column is only
                      as wide as its header, and a JSON payload wrapping inside
                      130px breaks between a key and its value — which reads as
                      corruption rather than as formatting. The payload goes in
                      the wide column instead, under the action it describes. */}
                  <TableHead className="whitespace-nowrap">When</TableHead>
                  <TableHead className="whitespace-nowrap">Who</TableHead>
                  <TableHead>What changed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground align-top whitespace-nowrap text-xs">
                      {/* Fixed locale and an explicit UTC zone, so the rendered
                          string does not differ between the server and the
                          reader's browser and trip React's hydration check. */}
                      {row.createdAt.toLocaleString("en-CA", {
                        timeZone: "UTC",
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                      <span className="sr-only"> UTC</span>
                    </TableCell>

                    <TableCell className="align-top text-sm">{actorLabel(row)}</TableCell>

                    <TableCell className="align-top text-sm">
                      {humanizeAction(row.action)}
                      <span className="text-muted-foreground block text-xs">
                        {row.entityType} {row.entityId}
                      </span>

                      {row.previousValue === null ? null : (
                        // Collapsed by default. §8 requires the previous value be
                        // LOGGED; it does not require it be on screen at all
                        // times, and these payloads can carry applicant data.
                        <details className="mt-1">
                          <summary className="text-muted-foreground cursor-pointer text-xs hover:underline">
                            Previous value
                          </summary>
                          <pre className="bg-muted mt-2 overflow-x-auto rounded p-2 text-xs">
                            {JSON.stringify(row.previousValue, null, 2)}
                          </pre>
                        </details>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-6 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {total} {total === 1 ? "entry" : "entries"} · page {window.page} of {window.pageCount}
            </span>

            <span className="flex gap-4">
              {window.hasPrevious ? (
                <Link href={`/instances/${instance.id}/audit?page=${window.page - 1}`} className="hover:underline">
                  ← Newer
                </Link>
              ) : null}
              {window.hasNext ? (
                <Link href={`/instances/${instance.id}/audit?page=${window.page + 1}`} className="hover:underline">
                  Older →
                </Link>
              ) : null}
            </span>
          </div>
        </>
      )}
    </main>
  );
}
