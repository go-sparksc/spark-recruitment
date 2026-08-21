import Link from "next/link";
import { notFound } from "next/navigation";

import { UploadForm } from "./upload-form";
import { InstanceCrumbs } from "../instance-crumbs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ImportSheet } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Interview import — Spark SC Recruitment" };

/// FR-12's two uploads, side by side.
///
/// **Neither reads the other's state**, which is decision 47 made structural:
/// "Each sheet is staged, previewed, and committed on its own schedule." There
/// is no cross-sheet gate anywhere on this page, including on the buttons.
export default async function InterviewsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireInstance(id, `/instances/${id}/interviews`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!instance) notFound();

  const [staged, categoryCount, resultCount, notesCount, poolCount] = await Promise.all([
    prisma.interviewImport.findMany({
      where: { instanceId: id },
      select: { sheet: true, uploadedAt: true, _count: { select: { rows: true } } },
    }),
    prisma.interviewCategory.count({ where: { instanceId: id } }),
    prisma.interviewResult.count({ where: { applicant: { instanceId: id } } }),
    prisma.interviewNotes.count({ where: { applicant: { instanceId: id } } }),
    // PRD decision 48's pool, reported so an admin who uploads before finalizing
    // the written round is told why nothing matches rather than left guessing.
    prisma.applicant.count({ where: { instanceId: id, stageReached: { not: "WRITTEN" } } }),
  ]);

  const stagedBySheet = new Map(staged.map((row) => [row.sheet, row]));

  const sheets = [
    {
      sheet: ImportSheet.SCORES,
      title: "First round scores",
      description:
        "One row per interviewer per applicant: the applicant's email or name, the interviewer's name, one column per interview category, and the average.",
      committed: `${resultCount} score row${resultCount === 1 ? "" : "s"} imported`,
      blocked:
        categoryCount === 0
          ? "Set up the interview rubric first — the scores sheet has one column per category."
          : null,
    },
    {
      sheet: ImportSheet.NOTES,
      title: "First round notes",
      description:
        "One row per applicant: the applicant's email or name, optionally who wrote the notes, and the notes themselves.",
      committed: `${notesCount} applicant${notesCount === 1 ? "" : "s"} with notes`,
      blocked: null,
    },
  ];

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Interview import</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Two sheets, imported independently. Neither waits for the other, and either can be
        re-uploaded to correct it.
      </p>

      {poolCount === 0 ? (
        <p className="text-muted-foreground mt-6 rounded-md border p-4 text-sm">
          No applicant has reached the first round yet, so there is nobody for an interview sheet to
          refer to.{" "}
          <Link href={`/instances/${id}/results`} className="underline">
            Finalize the written round
          </Link>{" "}
          first.
        </p>
      ) : null}

      <div className="mt-8 space-y-6">
        {sheets.map((entry) => {
          const stagedSheet = stagedBySheet.get(entry.sheet);
          const href = `/instances/${id}/interviews/${entry.sheet.toLowerCase()}`;

          return (
            <Card key={entry.sheet}>
              <CardHeader>
                <CardTitle>{entry.title}</CardTitle>
                <CardDescription>{entry.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground text-sm">
                  {entry.committed}
                  {stagedSheet
                    ? ` · ${stagedSheet._count.rows} row${
                        stagedSheet._count.rows === 1 ? "" : "s"
                      } staged, not yet imported`
                    : ""}
                </p>

                {stagedSheet ? (
                  <Link
                    href={href}
                    className="inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted"
                  >
                    Continue with the staged file
                  </Link>
                ) : null}

                {entry.blocked ? (
                  <p className="text-muted-foreground rounded-md border p-3 text-sm">
                    {entry.blocked}{" "}
                    <Link href={`/instances/${id}/interview-rubric`} className="underline">
                      Interview rubric
                    </Link>
                  </p>
                ) : (
                  <UploadForm
                    instanceId={id}
                    sheet={entry.sheet}
                    label={entry.title}
                    hasStaged={stagedSheet !== undefined}
                  />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </main>
  );
}
