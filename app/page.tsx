import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { prisma } from "@/lib/prisma";

// Phase 0 placeholder. This is NOT FR-1: the instance list is gated behind an
// app-level password in Phase 1, and PRD section 8 requires that it not be
// publicly enumerable. What this page proves is that the whole stack is wired —
// server component reads Postgres through Prisma, Tailwind and shadcn render it.
export default async function Home() {
  const instances = await prisma.instance.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      currentStage: true,
      createdAt: true,
      _count: {
        select: { applicants: true, reviewers: true, fields: true, rubricCategories: true },
      },
    },
  });

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Spark SC Recruitment</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Phase 0 — foundation. Schema, migration, and synthetic seed data.
      </p>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Instances</CardTitle>
          <CardDescription>
            Read from Postgres through Prisma in a server component. The password gate this page
            needs arrives in Phase 1 (FR-1); do not deploy it as is.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {instances.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No instances yet. Run{" "}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">npm run seed</code>.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Fields</TableHead>
                  <TableHead className="text-right">Applicants</TableHead>
                  <TableHead className="text-right">Reviewers</TableHead>
                  <TableHead className="text-right">Rubric</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {instances.map((instance) => (
                  <TableRow key={instance.id}>
                    <TableCell className="font-medium">{instance.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {instance.currentStage.replace("_", " ").toLowerCase()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {instance._count.fields}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {instance._count.applicants}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {instance._count.reviewers}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {instance._count.rubricCategories}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
