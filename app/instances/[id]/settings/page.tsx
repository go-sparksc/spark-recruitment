import Link from "next/link";
import { notFound } from "next/navigation";

import { DeleteInstanceForm } from "./delete-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Instance settings — Spark SC Recruitment" };

/// requireAdmin, NOT requireInstance. Per FR-5 this page is reachable with only
/// app-level access, which is what makes the recovery path real: an admin who
/// cannot open an instance can still remove it.
export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdmin(`/instances/${id}/settings`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      importCommittedAt: true,
      _count: { select: { applicants: true, reviewers: true } },
    },
  });

  if (!instance) notFound();

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-16">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← Instances
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{instance.name}</h1>
      <p className="text-muted-foreground mt-2 text-sm">Instance settings</p>

      <Card className="border-destructive/40 mt-8">
        <CardHeader>
          <CardTitle className="text-base">Delete this instance</CardTitle>
          <CardDescription>
            Removes {instance._count.applicants} applicant
            {instance._count.applicants === 1 ? "" : "s"} and {instance._count.reviewers} reviewer
            {instance._count.reviewers === 1 ? "" : "s"}, with every score, note, and vote attached
            to them. Permanent, with no undo.
            {instance.importCommittedAt !== null
              ? " This is the only way to import a corrected file."
              : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteInstanceForm instanceId={instance.id} instanceName={instance.name} />
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-6 text-xs">
        This page needs only the app password, not this instance&apos;s own — otherwise a forgotten
        instance password would leave a row nobody could open, reset, or remove.
      </p>
    </main>
  );
}
