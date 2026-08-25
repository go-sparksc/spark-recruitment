import Link from "next/link";
import { notFound } from "next/navigation";

import { loadFinalPage } from "./load";
import { InstanceCrumbs } from "../instance-crumbs";
import { Card, CardContent } from "@/components/ui/card";
import { InstanceStage } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import {
  groupFinalApplicants,
  stillDeciding,
  unresolvedReason,
  type FinalRow,
  type UnresolvedReason,
} from "@/lib/final";
import type { PassTally } from "@/lib/passes";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Final class — Spark SC Recruitment" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/// FR-19's sentence made renderable: "eleven skips reads very differently from
/// 7–4". The phrase names the situation; the counts beside it are the evidence.
const REASON_LABEL: Record<UnresolvedReason, string> = {
  ALL_RECUSED: "every reviewer recused",
  NO_VOTES: "nobody voted",
  INCOMPLETE: "votes still outstanding when the round closed",
  MIXED: "reviewers disagreed, with no further pass to carry into",
};

function tallyText(tally: PassTally): string {
  const parts = [`${tally.yes} yes`, `${tally.no} no`];
  if (tally.skip > 0) parts.push(`${tally.skip} recused`);
  if (tally.outstanding > 0) parts.push(`${tally.outstanding} never voted`);
  return parts.join(" · ");
}

function Group({
  title,
  description,
  rows,
  emptyText,
  showTally = false,
  instanceId,
}: {
  title: string;
  description: string;
  rows: FinalRow[];
  emptyText: string;
  showTally?: boolean;
  instanceId: string;
}) {
  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-lg font-semibold tracking-tight">
          {title} <span className="text-muted-foreground font-normal tabular-nums">{rows.length}</span>
        </h2>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">{description}</p>

      <Card className="mt-3">
        <CardContent className="divide-y p-0">
          {rows.length === 0 ? (
            <p className="text-muted-foreground px-6 py-5 text-sm">{emptyText}</p>
          ) : (
            rows.map((row) => (
              <div key={row.applicantId} className="px-6 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <span>
                    {/*
                      The handle beside the name, not instead of it. Phase 6
                      found two applicants called "Diego Hoffmann" indistinguishable
                      on the FR-18 grid — the spreadsheet's core defect arriving at
                      the presentation layer after the data model had correctly
                      refused it.
                    */}
                    <Link
                      href={`/instances/${instanceId}/results/${row.applicantId}`}
                      className="font-medium hover:underline"
                    >
                      {row.displayName}
                    </Link>
                    <span className="text-muted-foreground ml-2 text-sm tabular-nums">
                      Applicant {row.sourceRowIndex}
                    </span>
                  </span>
                  <span className="text-muted-foreground text-sm">{row.email ?? "no email"}</span>
                </div>

                {showTally && row.tally !== null ? (
                  <p className="text-muted-foreground mt-1 text-sm tabular-nums">
                    {tallyText(row.tally)}
                    {unresolvedReason(row.tally) === null
                      ? null
                      : ` — ${REASON_LABEL[unresolvedReason(row.tally)!]}`}
                  </p>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/// FR-19. All second-round applicants sorted into New Sparklet, Rejected and
/// Unresolved, with full profiles one tap away.
///
/// The demographic funnel is slice 7 and the resolve control is slice 8; this
/// slice is the three groups and the votes that tell the two Unresolved
/// situations apart.
export default async function FinalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireInstance(id, `/instances/${id}/final`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true, name: true, currentStage: true },
  });
  if (!instance) notFound();

  const { sources, finalPass } = await loadFinalPage(id);
  const groups = groupFinalApplicants(sources);
  const undecided = stillDeciding(sources);

  const closed = instance.currentStage === InstanceStage.COMPLETE;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Final class</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {/*
          Decision 64's lesson, applied before it can bite: an empty screen must
          not mean two opposite things. "The round has not finished" and "the
          round finished and produced this" are different states and read
          differently here.
        */}
        {closed
          ? `The second round is closed. ${plural(sources.length, "applicant")} reached it${
              finalPass ? `, and pass ${finalPass.ordinal} was the last` : ""
            }.`
          : `The second round is still open — ${plural(
              undecided,
              "applicant",
            )} have not been decided yet, and this screen is a record of a finished round.`}
      </p>

      <Group
        instanceId={instance.id}
        title="New Sparklets"
        description="Admitted by a unanimous pass, or by an admin resolving them afterwards."
        rows={groups.sparklets}
        emptyText="Nobody has been admitted."
      />

      <Group
        instanceId={instance.id}
        title="Rejected"
        description="Rejected by a unanimous pass, or by an admin during one."
        rows={groups.rejected}
        emptyText="Nobody was rejected in the second round."
      />

      <Group
        instanceId={instance.id}
        title="Unresolved"
        // 19c–19e, said on the screen rather than only in the code: this group is
        // found by the final pass row and never by status, and everyone in it is
        // still ACTIVE.
        description={
          finalPass
            ? `Left undecided when the round closed — found by their row in pass ${finalPass.ordinal}, not by their status. Each needs an explicit decision.`
            : "No pass has been created, so nobody can be unresolved yet."
        }
        rows={groups.unresolved}
        emptyText="Every applicant reached a decision."
        showTally
      />

      {undecided > 0 && closed ? (
        <p className="text-muted-foreground mt-8 text-sm">
          {plural(undecided, "applicant")} in the second round appear in no group. That should not
          happen on a closed round — every applicant is either decided or carries NEEDS_ADMIN on the
          final pass.
        </p>
      ) : null}
    </main>
  );
}
