import { notFound } from "next/navigation";

import { InterviewRubricBuilder } from "./interview-rubric-builder";
import { InstanceCrumbs } from "../instance-crumbs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ImportSheet } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Interview rubric — Spark SC Recruitment" };

/// FR-12a. Its own page rather than a section of `/rubric`, per PRD decision 54:
/// two instruments with two lock rules and two "once any score exists"
/// conditions on one screen is the tangle decision 6 separated them to avoid.
///
/// **Nothing on this page reads `RubricCategory`**, which is clause 12a-1 made
/// structural rather than remembered.
export default async function InterviewRubricPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireInstance(id, `/instances/${id}/interview-rubric`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      interviewCategories: { orderBy: { ordinal: "asc" } },
    },
  });

  if (!instance) notFound();

  // Through InterviewCategory rather than through the applicant: it counts
  // exactly the rows a rubric replace would destroy, and cannot reach another
  // instance's. Same predicate the action re-checks — render-time gating is not
  // a boundary, since a server action is a POST endpoint reachable without the
  // page that renders its form.
  const [scoreCount, stagedScoresSheet] = await Promise.all([
    prisma.interviewCategoryScore.count({
      where: { interviewCategory: { instanceId: id } },
    }),
    // PRD decision 61's warning. A staged sheet's mapping is bound to these
    // categories, and adding or removing one leaves its column unmapped — a real
    // cost of editing after upload, stated here rather than discovered on the
    // import screen.
    prisma.interviewImport.findUnique({
      where: { instanceId_sheet: { instanceId: id, sheet: ImportSheet.SCORES } },
      select: { _count: { select: { rows: true } } },
    }),
  ]);

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{instance.name}</h1>
      <p className="text-muted-foreground mt-2 text-sm">First round interview rubric</p>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Interview categories</CardTitle>
          <CardDescription>
            The categories interviewers scored against, so the first-round scores sheet can be
            mapped to them. Separate from the written rubric — different instrument, different
            categories, scored at a different time. Nothing assumes a particular number of them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InterviewRubricBuilder
            instanceId={instance.id}
            initial={instance.interviewCategories.map((category) => ({
              // The id travels to the client and back so a save can update this
              // row rather than recreate it — PRD decision 61. Not a secret:
              // it identifies a row the admin is already looking at, and the
              // action re-checks that the instance owns it.
              id: category.id,
              name: category.name,
              maxPoints: category.maxPoints,
            }))}
            lockedByScoreCount={scoreCount}
            stagedScoresSheet={stagedScoresSheet}
          />
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-6 text-xs">
        The scores sheet needs one column per category. Their names here do not have to match the
        file&rsquo;s column headings — the import step is where columns are mapped to categories.
      </p>
    </main>
  );
}
