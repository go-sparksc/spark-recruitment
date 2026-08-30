import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ArchiveSummary } from "@/lib/archive";
import { requireInstanceUnlocked } from "@/lib/auth";
import { FUNNEL_COHORTS, formatShare, formatWeighted } from "@/lib/funnel";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Archived cycle — Spark SC Recruitment" };

/// What is left of a purged cycle. PRD decisions 94 and 95.
///
/// **Everything on this page comes from `Instance.archiveSummary`**, never from
/// the rows — which is the point. The demographic breakdown below was computed
/// from `Applicant.data` at the moment of the purge, and `Applicant.data` is now
/// `{}`. Recomputing it here would render a table of zeros for a cycle that had
/// real numbers, and would do it without failing.
///
/// `requireInstanceUnlocked`, so this page does not redirect to itself. It still
/// costs the instance password: decision 95 keeps `Instance.passwordHash`
/// precisely so an archived cycle stays openable by whoever ran it.
export default async function ArchivedInstancePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  await requireInstanceUnlocked(id, `/instances/${id}/archive`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true, name: true, archivedAt: true, archiveSummary: true },
  });

  if (!instance) notFound();

  // A live cycle belongs on its hub. This also means the redirect in
  // requireInstance cannot strand anyone here after a restore.
  if (instance.archivedAt === null || instance.archiveSummary === null) {
    redirect(`/instances/${id}`);
  }

  const summary = instance.archiveSummary as unknown as ArchiveSummary;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← Instances
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{instance.name}</h1>

      <div className="border-muted-foreground/30 bg-muted/40 mt-6 rounded border p-4">
        <p className="text-sm font-medium">
          Archived on {instance.archivedAt.toLocaleDateString("en-CA", { timeZone: "UTC" })}
        </p>
        <p className="text-muted-foreground mt-2 text-sm">
          Essays, email addresses, demographic answers and interview notes for this cycle have
          been deleted, per the club&apos;s retention rule. The statistics below were computed
          before the deletion and are all that remains of them. Scores, votes and decisions are
          untouched.
        </p>
      </div>

      <h2 className="mt-10 text-lg font-medium">The cycle</h2>
      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
        <Stat label="Applied" value={summary.cohortSizes.ALL} />
        <Stat label="First round" value={summary.cohortSizes.FIRST_ROUND} />
        <Stat label="Second round" value={summary.cohortSizes.SECOND_ROUND} />
        <Stat label="New Sparklets" value={summary.cohortSizes.SPARKLET} />
        <Stat label="Rejected" value={summary.applicants.rejected} />
        <Stat label="Unresolved at close" value={summary.applicants.active} />
        <Stat label="Reviewers" value={summary.reviewers.total} />
        <Stat label="Sparklet reviewers" value={summary.reviewers.sparklets} />
      </dl>

      <h2 className="mt-10 text-lg font-medium">Work recorded</h2>
      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
        <Stat label="Written scores" value={summary.reviewCounts.scores} />
        <Stat label="Review notes" value={summary.reviewCounts.reviewNotes} />
        <Stat label="Interview results" value={summary.reviewCounts.interviewResults} />
        <Stat label="First-round votes" value={summary.reviewCounts.firstRoundVotes} />
        <Stat label="Pass votes" value={summary.reviewCounts.passVotes} />
        <Stat label="Decisions" value={summary.reviewCounts.decisions} />
      </dl>

      {summary.funnel.columns.length === 0 ? null : (
        <>
          <h2 className="mt-10 text-lg font-medium">Composition at each stage</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            Frozen at the moment of the purge. Each cell is the §10.7 weighted count and its share
            of that stage — an applicant who selected three options contributes a third to each.
          </p>

          {summary.funnel.columns.map((column) => (
            <section key={column.key} className="mt-8">
              <h3 className="text-sm font-medium">{column.label}</h3>
              <div className="mt-3 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>&nbsp;</TableHead>
                      {FUNNEL_COHORTS.map((cohort) => (
                        <TableHead key={cohort.key} className="text-right whitespace-nowrap">
                          {cohort.label}
                          <span className="text-muted-foreground block text-xs font-normal">
                            n = {summary.cohortSizes[cohort.key]}
                          </span>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {column.rows.map((row) => (
                      <TableRow key={row.label}>
                        <TableCell className="text-sm">{row.label}</TableCell>
                        {FUNNEL_COHORTS.map((cohort) => (
                          <TableCell key={cohort.key} className="text-right text-sm">
                            {formatWeighted(row.cells[cohort.key].weighted)}
                            <span className="text-muted-foreground block text-xs">
                              {formatShare(row.cells[cohort.key].share)}
                            </span>
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          ))}
        </>
      )}

      <h2 className="mt-10 text-lg font-medium">The instruments used</h2>
      <p className="text-muted-foreground mt-2 text-sm">
        Kept so a future cycle can tell what a past score was out of.
      </p>
      <RubricList title="Written rubric" categories={summary.rubric.written} />
      <RubricList title="Interview rubric" categories={summary.rubric.interview} />

      <p className="text-muted-foreground mt-10 text-xs">
        Still available for this cycle:{" "}
        <Link href={`/instances/${instance.id}/export`} className="hover:underline">
          export
        </Link>
        {" · "}
        <Link href={`/instances/${instance.id}/audit`} className="hover:underline">
          activity
        </Link>
        {" · "}
        <Link href={`/instances/${instance.id}/settings`} className="hover:underline">
          settings
        </Link>
      </p>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-lg font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function RubricList({
  title,
  categories,
}: {
  title: string;
  categories: { name: string; maxPoints: number }[];
}) {
  return (
    <div className="mt-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {categories.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-sm">Never configured.</p>
      ) : (
        <ul className="text-muted-foreground mt-1 text-sm">
          {categories.map((category) => (
            <li key={category.name}>
              {category.name} — out of {category.maxPoints}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
