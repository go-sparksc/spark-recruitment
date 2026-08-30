import { notFound } from "next/navigation";

import { InstanceCrumbs } from "../instance-crumbs";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ApplicantStatus } from "@/generated/prisma/enums";
import { requireInstanceUnlocked } from "@/lib/auth";
import { EXPORT_TABLES } from "@/lib/export";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Export — Spark SC Recruitment" };

function plural(count: number, noun: string, plural?: string): string {
  return `${count} ${count === 1 ? noun : (plural ?? `${noun}s`)}`;
}

/// FR-20's surface. One download in this slice — the JSON that FR-20 calls "the
/// entire instance" — with the three per-stage CSVs joining it in slice 4.
///
/// The CSVs are deliberately absent rather than present and disabled. Decisions
/// 29, 36 and 39 all record the same lesson from the other direction: a control
/// that does not work is indistinguishable from one that is broken, and an admin
/// who taps a dead button learns nothing about when it will be alive.
export default async function ExportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireInstanceUnlocked(id, `/instances/${id}/export`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true, name: true, currentStage: true },
  });
  if (!instance) notFound();

  // Counted rather than snapshotted. Rendering this page must not read the whole
  // instance into memory just to say how big it is — that is what the download
  // itself is for.
  const [applicants, reviewers, scores, decisions, passVotes, sparklets] = await Promise.all([
    prisma.applicant.count({ where: { instanceId: id } }),
    prisma.reviewer.count({ where: { instanceId: id } }),
    prisma.score.count({ where: { assignment: { instanceId: id } } }),
    prisma.decision.count({ where: { applicant: { instanceId: id } } }),
    prisma.passVote.count({ where: { pass: { instanceId: id } } }),
    prisma.applicant.count({ where: { instanceId: id, status: ApplicantStatus.SPARKLET } }),
  ]);

  // Each row says what is actually in the file rather than what it is called.
  // An admin choosing between four downloads is choosing on contents, and "0
  // Sparklets" is a finding rather than an empty file to be puzzled over.
  const csvs = [
    {
      artifact: "applicants.csv",
      title: "All applicants with scores",
      state: `${plural(applicants, "row")} · one column per rubric category`,
    },
    {
      artifact: "decisions.csv",
      title: "Decisions by stage",
      state: `${plural(decisions, "row")} · stage, outcome, and who decided`,
    },
    {
      artifact: "final-class.csv",
      title: "Final class with emails",
      state:
        sparklets === 0
          ? "no Sparklets yet — the second round has not produced any"
          : `${plural(sparklets, "Sparklet")} · name and email`,
    },
  ];

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Export</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        The club must never be locked into this tool. Everything in this instance is in the file
        below, in a documented format, whether or not this application still exists.
      </p>

      <Card className="mt-8">
        <CardContent className="p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <div>
              <h2 className="font-medium">The entire instance, as JSON</h2>
              <p className="text-muted-foreground mt-1 text-sm tabular-nums">
                {plural(EXPORT_TABLES.length, "table")} · {plural(applicants, "applicant")} ·{" "}
                {plural(reviewers, "reviewer")} · {plural(scores, "written score")} ·{" "}
                {plural(passVotes, "pass vote")} · {plural(decisions, "decision")}
              </p>
            </div>
            {/*
              A plain link, not a button with an onClick. Decision 33: a control
              built as a handler is inert before the page hydrates and then fires
              instantly afterwards, which is exactly the profile that produces "I
              do not think I clicked that". An anchor is native and works from
              the first paint.
            */}
            <a
              href={`/instances/${instance.id}/export/instance.json`}
              className={buttonVariants()}
              download
            >
              Download JSON
            </a>
          </div>

          <div className="border-destructive/40 mt-6 rounded-md border p-4">
            <p className="text-sm font-medium">Treat this file the way you treat the password.</p>
            <p className="text-muted-foreground mt-1 text-sm">
              It carries every applicant&rsquo;s essays, email and demographics, and it carries this
              instance&rsquo;s password hash and its round access codes — deliberately, so that
              restoring from it produces an instance you can actually open. Keep it wherever you keep
              the instance password, not in a shared folder.
            </p>
          </div>
        </CardContent>
      </Card>

      <h2 className="mt-10 font-medium">Per-stage CSVs</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        For reading in a spreadsheet. These are derived from the JSON above and drop what a
        spreadsheet cannot hold — restore from the JSON, not from these.
      </p>

      <Card className="mt-4">
        <CardContent className="divide-y p-0">
          {csvs.map((csv) => (
            <div
              key={csv.artifact}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-6 py-4"
            >
              <div>
                <p className="font-medium">{csv.title}</p>
                <p className="text-muted-foreground mt-1 text-sm tabular-nums">{csv.state}</p>
              </div>
              <a
                href={`/instances/${instance.id}/export/${csv.artifact}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                download
              >
                Download CSV
              </a>
            </div>
          ))}
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-6 text-sm">
        Cells are written exactly as they were recorded. A cell beginning{" "}
        <code className="text-xs">=</code>, <code className="text-xs">+</code>,{" "}
        <code className="text-xs">-</code> or <code className="text-xs">@</code> will be treated as
        a formula by Excel and Sheets — import as text if that matters. The tool does not rewrite
        what a person wrote.
      </p>
    </main>
  );
}
