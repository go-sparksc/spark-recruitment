import Link from "next/link";
import { notFound } from "next/navigation";

import { PassControls } from "./pass-controls";
import { InstanceCrumbs } from "../instance-crumbs";
import { Card, CardContent } from "@/components/ui/card";
import { InstanceStage, PassStatus, Round } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import {
  SECOND_ROUND_POOL,
  closeRoundBlock,
  passCreationBlock,
  summarizePass,
} from "@/lib/passes";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Passes — Spark SC Recruitment" };

/// FR-17's admin surface: create a pass, close a pass, see what each one did.
///
/// The grid itself is FR-18 and lives one level down, in Slice 11. This page is
/// deliberately the list and the two controls, because those are the two things
/// that change state — everything else here is a read of what they changed.
export default async function PassesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireInstance(id, `/instances/${id}/passes`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true, name: true, currentStage: true },
  });
  if (!instance) notFound();

  const [passes, poolSize, reviewerCount, conflictCount] = await Promise.all([
    prisma.pass.findMany({
      where: { instanceId: id },
      orderBy: { ordinal: "desc" },
      select: {
        id: true,
        ordinal: true,
        status: true,
        openedAt: true,
        closedAt: true,
        members: { select: { resolution: true } },
      },
    }),
    prisma.applicant.count({ where: { instanceId: id, ...SECOND_ROUND_POOL } }),
    prisma.reviewer.count({ where: { instanceId: id, rounds: { has: Round.SECOND_ROUND } } }),
    prisma.conflictOfInterest.count({
      where: { round: Round.SECOND_ROUND, applicant: { instanceId: id } },
    }),
  ]);

  // The page's only transformation, and it is a call into `lib/` rather than a
  // reduce written here. CLAUDE.md's Phase 5 lesson: a page that reshapes query
  // results before rendering them puts the reshaping where nothing can test it.
  const summaries = passes.map((pass) =>
    summarizePass({ ...pass, resolutions: pass.members.map((member) => member.resolution) }),
  );

  const openPass = summaries.find((summary) => summary.status === PassStatus.OPEN) ?? null;

  // Passes are ordered by ordinal desc, so the first is the final pass — the
  // only one decision 73 touches. A CARRIED row on an earlier pass carried into
  // a later one and is history, not an undecided applicant.
  const finalPass = summaries[0] ?? null;
  const unresolvedOnFinalPass =
    finalPass === null ? 0 : finalPass.unresolved + finalPass.carried;

  // **The same function the action enforces with.** The page explains, the
  // action refuses, and neither derives the reason separately — which is what
  // stops the button's absence and the error text from describing different
  // rules. Slice 4's posture: say so rather than offer a control that fails.
  const block = passCreationBlock({
    inSecondRound: instance.currentStage === InstanceStage.SECOND_ROUND,
    openPassOrdinal: openPass?.ordinal ?? null,
    poolSize,
    reviewerCount,
  });

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Passes</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {poolSize === 0
          ? "No applicant is still active."
          : `${plural(poolSize, "applicant")} active · ${plural(reviewerCount, "reviewer")}`}
        {conflictCount > 0 ? ` · ${plural(conflictCount, "conflict")} flagged` : ""}
      </p>

      <PassControls
        instanceId={instance.id}
        openPass={openPass ? { id: openPass.id, ordinal: openPass.ordinal } : null}
        createBlockedBecause={block}
        poolSize={poolSize}
        closeRoundBlockedBecause={closeRoundBlock({
          stage: instance.currentStage,
          passCount: summaries.length,
        })}
        unresolvedOnFinalPass={unresolvedOnFinalPass}
      />

      {summaries.length === 0 ? (
        <Card className="mt-8">
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            No pass yet. The second round begins when you create one.
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-8">
          <CardContent className="divide-y p-0">
            {summaries.map((summary) => (
              // A link, so the pass detail has a way in. The hub exists because
              // two whole surfaces once had none; a pass reachable only by typing
              // its id would be the same mistake one level down.
              <Link
                key={summary.id}
                href={`/instances/${instance.id}/passes/${summary.id}`}
                className="hover:bg-muted/50 block px-6 py-4 transition-colors"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <span className="font-medium">
                    Pass {summary.ordinal}
                    <span
                      className={
                        summary.status === PassStatus.OPEN
                          ? "text-foreground ml-2 text-xs font-normal"
                          : "text-muted-foreground ml-2 text-xs font-normal"
                      }
                    >
                      {summary.status === PassStatus.OPEN ? "open" : "closed"}
                    </span>
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {plural(summary.memberCount, "applicant")}
                  </span>
                </div>

                <p className="text-muted-foreground mt-1 text-sm">{describe(summary)}</p>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </main>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/// What a pass did, in the vocabulary §7.4 uses.
///
/// `unresolved` is named "still to vote on" on an open pass and "carried
/// forward" on a closed one, because decision 72 makes those the same column
/// meaning two different things: work remaining, and work the close chose not to
/// finish. A single label would be wrong on one of the two.
function describe(summary: ReturnType<typeof summarizePass>): string {
  const parts = [
    summary.sparklet > 0 ? `${summary.sparklet} sparklet` : null,
    summary.rejected > 0 ? `${summary.rejected} rejected` : null,
    summary.carried > 0 ? `${summary.carried} carried` : null,
    summary.needsAdmin > 0 ? `${summary.needsAdmin} needs an admin` : null,
    summary.unresolved > 0
      ? summary.status === PassStatus.OPEN
        ? `${summary.unresolved} still to resolve`
        : `${summary.unresolved} carried forward without a resolution`
      : null,
  ].filter((part) => part !== null);

  return parts.length > 0 ? parts.join(" · ") : "No members.";
}
