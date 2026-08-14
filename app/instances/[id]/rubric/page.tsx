import { notFound } from "next/navigation";

import { RubricBuilder } from "./rubric-builder";
import { InstanceCrumbs } from "../instance-crumbs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Rubric — Spark SC Recruitment" };

export default async function RubricPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireInstance(id, `/instances/${id}/rubric`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      rubricCategories: { orderBy: { ordinal: "asc" } },
    },
  });

  if (!instance) notFound();

  // Score has no instanceId of its own; it hangs off Assignment.
  const scoreCount = await prisma.score.count({ where: { assignment: { instanceId: id } } });

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{instance.name}</h1>
      <p className="text-muted-foreground mt-2 text-sm">Written round rubric</p>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Categories</CardTitle>
          <CardDescription>
            What a written reviewer scores each applicant against. Nothing assumes a particular
            number of categories or scale — both change between cycles.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RubricBuilder
            instanceId={instance.id}
            initial={instance.rubricCategories.map((c) => ({
              name: c.name,
              maxPoints: c.maxPoints,
              // The column is nullable; the form field is a controlled textarea
              // and must never receive null.
              description: c.description ?? "",
            }))}
            lockedByScoreCount={scoreCount}
          />
        </CardContent>
      </Card>
    </main>
  );
}
