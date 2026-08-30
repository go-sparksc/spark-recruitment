import { notFound, redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { signInPath } from "@/lib/reviewer-auth";

export const metadata = { title: "This cycle is closed — Spark SC" };

/// Where a reviewer lands on an archived cycle. PRD decision 95.
///
/// **Deliberately not the sign-in form.** The purge deletes every
/// `RoundAccessCode`, so there is no code that would let anyone in — showing a
/// form that cannot succeed sends a reviewer to chase an admin for a credential
/// that no longer exists.
///
/// **Says nothing about applicants**, and does not need to: everything a
/// reviewer would have seen here is exactly what the purge removed.
///
/// No reviewer session is required. Someone whose cookie expired months ago
/// still deserves this answer rather than a form, and there is nothing here to
/// protect — the page names one instance, which its reader already had the link
/// to.
export default async function ClosedCyclePage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  const { instanceId } = await params;

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { name: true, archivedAt: true },
  });

  if (!instance) notFound();

  // A live cycle has no business here. Sending them to sign in is the useful
  // answer, and it keeps this page from becoming a second, stale front door if
  // someone bookmarks it.
  if (instance.archivedAt === null) redirect(signInPath(instanceId));

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">This cycle is closed</h1>

      <p className="text-muted-foreground mt-4 text-sm">
        {instance.name} finished on{" "}
        {instance.archivedAt.toLocaleDateString("en-CA", { timeZone: "UTC" })}, and its applicant
        records have since been deleted.
      </p>

      <p className="text-muted-foreground mt-4 text-sm">
        Nothing here needs your review. Thank you for the reviewing you did — the club keeps the
        results, just not the applications themselves.
      </p>

      <p className="text-muted-foreground mt-6 text-xs">
        If you were expecting to review something, you may have an old link. Ask whoever shared it
        for the current one.
      </p>
    </main>
  );
}
