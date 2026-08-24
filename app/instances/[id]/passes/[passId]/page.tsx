import Link from "next/link";
import { notFound } from "next/navigation";

import { RejectControl } from "./reject-control";
import { InstanceCrumbs } from "../../instance-crumbs";
import { Card, CardContent } from "@/components/ui/card";
import { ApplicantStatus, PassStatus } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { isTerminal, resolutionLabel, summarizePass } from "@/lib/passes";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Pass — Spark SC Recruitment" };

/// One pass, its membership, and clause 17l's manual reject.
///
/// **FR-18's reviewer-by-applicant grid lands on this page in Slice 11**, beside
/// each row rather than instead of it. This slice builds the applicant-scoped
/// surface the reject needs — 17l rejects an applicant *within a pass*, and the
/// pass list is pass-scoped — because a slice that ships an action with no way
/// to click it is the horizontal layer CLAUDE.md rules out.
export default async function PassDetailPage({
  params,
}: {
  params: Promise<{ id: string; passId: string }>;
}) {
  const { id, passId } = await params;
  await requireInstance(id, `/instances/${id}/passes/${passId}`);

  const [instance, pass] = await Promise.all([
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
            resolvedAt: true,
            applicant: { select: { id: true, displayName: true, status: true } },
          },
        },
      },
    }),
  ]);

  if (!instance || !pass) notFound();

  const summary = summarizePass({
    ...pass,
    resolutions: pass.members.map((member) => member.resolution),
  });

  const open = pass.status === PassStatus.OPEN;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
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
        {summary.memberCount} applicant{summary.memberCount === 1 ? "" : "s"} · {summary.sparklet}{" "}
        sparklet · {summary.rejected} rejected · {summary.carried} carried · {summary.needsAdmin}{" "}
        needing an admin · {summary.unresolved} unresolved
      </p>

      {summary.memberCount === 0 ? (
        <Card className="mt-8">
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            This pass has no members.
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-8">
          <CardContent className="divide-y p-0">
            {pass.members.map((member) => {
              // The reject is offered only where it can succeed, which is the
              // same set the action allows: an open pass, a row this pass has
              // not resolved terminally, and an applicant no other pass has
              // decided. The action re-checks all three.
              const rejectable =
                open &&
                !isTerminal(member.resolution) &&
                member.applicant.status === ApplicantStatus.ACTIVE;

              return (
                <div key={member.applicant.id} className="px-6 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <span className="font-medium">{member.applicant.displayName}</span>
                    <span className="text-muted-foreground text-sm">
                      {resolutionLabel(member.resolution)}
                    </span>
                  </div>

                  {rejectable ? (
                    <RejectControl
                      instanceId={instance.id}
                      passId={pass.id}
                      applicantId={member.applicant.id}
                      applicantName={member.applicant.displayName}
                    />
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </main>
  );
}
