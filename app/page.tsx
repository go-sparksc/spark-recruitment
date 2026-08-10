import Link from "next/link";

import { signOut } from "./actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Instances — Spark SC Recruitment" };

// FR-1. Behind the app-level gate, per PRD section 8: the instance list must not
// be publicly enumerable. requireAdmin() is called here rather than relying on
// proxy.ts, which is a redirect for signed-out visitors and not a boundary.
export default async function Home() {
  await requireAdmin("/");

  const instances = await prisma.instance.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      currentStage: true,
      createdAt: true,
      importCommittedAt: true,
      _count: { select: { applicants: true, reviewers: true } },
    },
  });

  const dateFormat = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Spark SC Recruitment</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            One instance per recruitment cycle.
          </p>
        </div>
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </div>

      <Card className="mt-8">
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Instances</CardTitle>
            <CardDescription>
              {instances.length === 0
                ? "Nothing yet."
                : `${instances.length} cycle${instances.length === 1 ? "" : "s"}.`}
            </CardDescription>
          </div>
          {/* buttonVariants on the Link rather than a Button wrapping it: this
              is Base UI's Button, which has no asChild. */}
          <Link href="/instances/new" className={buttonVariants({ size: "sm" })}>
            New instance from CSV
          </Link>
        </CardHeader>
        <CardContent>
          {instances.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">
              Start a cycle by importing the application export.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Applicants</TableHead>
                  <TableHead className="text-right">Reviewers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {instances.map((instance) => (
                  <TableRow key={instance.id}>
                    <TableCell className="font-medium">
                      <Link href={`/instances/${instance.id}`} className="hover:underline">
                        {instance.name}
                      </Link>
                      {/* An instance whose CSV has not committed is mid-import,
                          not a running cycle. Saying so keeps a half-built row
                          from being mistaken for a finished one. */}
                      {instance.importCommittedAt === null ? (
                        <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs">
                          Draft
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {dateFormat.format(instance.createdAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {instance.currentStage.replace(/_/g, " ").toLowerCase()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {instance._count.applicants}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {instance._count.reviewers}
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
