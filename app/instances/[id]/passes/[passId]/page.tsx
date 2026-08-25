import Link from "next/link";
import { notFound } from "next/navigation";

import { PassGrid, type GridRow } from "./pass-grid";
import { RejectControl } from "./reject-control";
import { InstanceCrumbs } from "../../instance-crumbs";
import { Card, CardContent } from "@/components/ui/card";
import { ApplicantStatus, PassStatus, Round } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import {
  buildPassGrid,
  isMutableResolution,
  isTerminal,
  resolutionLabel,
  summarizePass,
} from "@/lib/passes";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Pass — Spark SC Recruitment" };

/// FR-18's pass dashboard, and clause 17l's manual reject.
///
/// **Admin-only, by the same gate every other admin surface uses** (18e). No
/// reviewer route reaches this page, and decision 74 is why it matters: this is
/// the only surface in the product that renders a pass vote.
export default async function PassDetailPage({
  params,
}: {
  params: Promise<{ id: string; passId: string }>;
}) {
  const { id, passId } = await params;
  await requireInstance(id, `/instances/${id}/passes/${passId}`);

  const [instance, pass, reviewers] = await Promise.all([
    prisma.instance.findUnique({ where: { id }, select: { id: true, name: true } }),
    prisma.pass.findFirst({
      // instanceId in the filter, not just the id: a pass id from the URL must
      // not be able to name a pass in another instance.
      where: { id: passId, instanceId: id },
      select: {
        id: true,
        ordinal: true,
        status: true,
        openedAt: true,
        closedAt: true,
        members: {
          orderBy: { applicant: { sourceRowIndex: "asc" } },
          select: {
            resolution: true,
            applicant: { select: { id: true, displayName: true, status: true } },
          },
        },
        votes: { select: { applicantId: true, reviewerId: true, value: true } },
      },
    }),
    // The electorate, fixed for the round by decisions 66 and 78 (as amended by
    // 84), which is why it is read from the roster rather than stored per pass.
    prisma.reviewer.findMany({
      where: { instanceId: id, rounds: { has: Round.SECOND_ROUND } },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  if (!instance || !pass) notFound();

  const applicantIds = pass.members.map((member) => member.applicant.id);

  // Conflicts are round-scoped and carry no pass dimension (decision 67), so
  // this reads the round's set and lets `buildPassGrid` decide which pairs in
  // this pass it touches.
  const conflicts = await prisma.conflictOfInterest.findMany({
    where: { round: Round.SECOND_ROUND, applicantId: { in: applicantIds } },
    select: { applicantId: true, reviewerId: true },
  });

  const stored = new Map(
    pass.members.map((member) => [member.applicant.id, member.resolution] as const),
  );

  // The page's transformation is one call into `lib/`. Everything FR-18 renders
  // — the cells, the totals, the resolution — comes out of `buildPassGrid`,
  // which is where a test can reach it.
  const grid = buildPassGrid(
    {
      reviewerIds: reviewers.map((reviewer) => reviewer.id),
      applicantIds,
      votes: pass.votes,
      conflicts,
    },
    stored,
  );

  const summary = summarizePass({
    ...pass,
    resolutions: pass.members.map((member) => member.resolution),
  });

  const open = pass.status === PassStatus.OPEN;
  const byId = new Map(pass.members.map((member) => [member.applicant.id, member] as const));

  const rows: GridRow[] = grid.rows.map((row) => {
    const member = byId.get(row.applicantId);
    return {
      applicantId: row.applicantId,
      applicantName: member?.applicant.displayName ?? "—",
      cells: row.cells,
      conflicts: row.conflicts,
      tally: row.tally,
      // 18d renders `resolution`, which is the stored value where there is one
      // and the recount otherwise — a manual reject and the close-round's
      // NEEDS_ADMIN are both writes no recount reproduces.
      resolutionLabel: resolutionLabel(row.resolution),
      mutable: isMutableResolution(row.stored),
    };
  });

  // 17l's control, offered only where it can succeed — the same three conditions
  // the action re-checks. Filtered rather than listed beside every row: on a
  // closed or fully resolved pass this section is empty, which is the honest
  // answer, and the grid above is where the pass is read.
  const rejectable = pass.members.filter(
    (member) =>
      open &&
      !isTerminal(member.resolution) &&
      member.applicant.status === ApplicantStatus.ACTIVE,
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-16">
      <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />

      <p className="mt-4">
        <Link
          href={`/instances/${instance.id}/passes`}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Passes
        </Link>
      </p>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Pass {pass.ordinal}
        <span className="text-muted-foreground ml-3 text-sm font-normal">
          {open ? "open" : "closed"}
        </span>
      </h1>

      <p className="text-muted-foreground mt-2 text-sm">
        {summary.memberCount} applicant{summary.memberCount === 1 ? "" : "s"} ·{" "}
        {reviewers.length} reviewer{reviewers.length === 1 ? "" : "s"} · {summary.sparklet}{" "}
        sparklet · {summary.rejected} rejected · {summary.carried} carried · {summary.needsAdmin}{" "}
        needing an admin · {summary.unresolved} unresolved
      </p>

      {summary.memberCount === 0 ? (
        <Card className="mt-8">
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            This pass has no members.
          </CardContent>
        </Card>
      ) : reviewers.length === 0 ? (
        // Decision 79 blocks creating a pass with no roster, so this is only
        // reachable on a historical pass whose reviewers were later deleted
        // outright. Say so rather than rendering a grid with no columns.
        <Card className="mt-8">
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            No reviewer is on the second-round roster, so this pass has no columns to show.
          </CardContent>
        </Card>
      ) : (
        <PassGrid
          instanceId={instance.id}
          reviewers={reviewers.map((reviewer) => ({
            id: reviewer.id,
            name: `${reviewer.firstName} ${reviewer.lastName}`,
          }))}
          rows={rows}
          removable={open}
        />
      )}

      {rejectable.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-sm font-medium">Reject an applicant</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Decides them outright, without a vote. They are excluded from this and every later
            pass.
          </p>

          <Card className="mt-3">
            <CardContent className="divide-y p-0">
              {rejectable.map((member) => (
                <div key={member.applicant.id} className="px-6 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <span className="font-medium">{member.applicant.displayName}</span>
                    <span className="text-muted-foreground text-sm">
                      {resolutionLabel(member.resolution)}
                    </span>
                  </div>

                  <RejectControl
                    instanceId={instance.id}
                    passId={pass.id}
                    applicantId={member.applicant.id}
                    applicantName={member.applicant.displayName}
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      ) : null}
    </main>
  );
}
