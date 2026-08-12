import { notFound } from "next/navigation";

import { signOut } from "../actions";
import { AssignmentStatus } from "@/generated/prisma/enums";
import { Button } from "@/components/ui/button";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";

export const metadata = { title: "Your applicants — Spark SC" };

/// PLACEHOLDER, replaced in Slice 4 by the real FR-9 assigned list with
/// completion state.
///
/// It exists now because Slice 3's walkthrough has to land somewhere that proves
/// the session works, and a sign-in that redirects to a 404 cannot be walked. It
/// shows only what the session itself establishes: who the server thinks you
/// are, which round, and how many applicants you hold.
export default async function ReviewerListPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  const { instanceId } = await params;
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { name: true },
  });

  if (!instance) notFound();

  const assignedCount = await prisma.assignment.count({
    where: {
      instanceId,
      round: session.rd,
      reviewerId: reviewer.id,
      status: AssignmentStatus.ACTIVE,
    },
  });

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 px-6 py-10">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {reviewer.firstName} {reviewer.lastName}
        </h1>
        <p className="text-muted-foreground text-sm">
          {instance.name} · {session.rd === "WRITTEN" ? "Written round" : session.rd}
        </p>
      </div>

      <p className="rounded-md border p-4 text-sm">
        You have <strong>{assignedCount}</strong> applicant{assignedCount === 1 ? "" : "s"} to
        review. The list itself arrives in the next slice.
      </p>

      <form action={signOut}>
        <input type="hidden" name="instanceId" value={instanceId} />
        <Button type="submit" variant="outline" className="h-11">
          Sign out
        </Button>
      </form>
    </main>
  );
}
