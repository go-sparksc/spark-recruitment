import Link from "next/link";
import { notFound } from "next/navigation";

import { DeleteInstanceForm } from "./delete-form";
import { ResetPasswordForm } from "./reset-password-form";
import { SemesterForm } from "./semester-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth";
import { termLabel } from "@/lib/class-standing";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Instance settings — Spark SC Recruitment" };

/// requireAdmin, NOT requireInstance. Per FR-5 this page is reachable with only
/// app-level access, which is what makes the recovery path real: an admin who
/// cannot open an instance can still remove it.
export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireAdmin(`/instances/${id}/settings`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      importCommittedAt: true,
      currentTermSeason: true,
      currentTermYear: true,
      _count: { select: { applicants: true, reviewers: true } },
    },
  });

  if (!instance) notFound();

  // Decision 119. The CHECK holds these set-or-null together, so one test covers
  // both; the second null test only narrows the type.
  const currentTerm =
    instance.currentTermSeason !== null && instance.currentTermYear !== null
      ? { season: instance.currentTermSeason, year: instance.currentTermYear }
      : null;
  // This page is deliberately reachable on the app password alone. The semester
  // action is not, so an admin who has not unlocked this instance is sent to do
  // that rather than shown a form that would bounce them there on submit.
  const unlocked = session.ins.includes(instance.id);

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-16">
      {/* `← Instances` only, deliberately — NOT InstanceCrumbs. This page gates
          on requireAdmin alone so a locked-out admin can reach it, and the hub
          gates on requireInstance, so a hub crumb here would bounce exactly the
          person FR-5's recovery path exists for straight back to /unlock. */}
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← Instances
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{instance.name}</h1>
      <p className="text-muted-foreground mt-2 text-sm">Instance settings</p>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Current semester</CardTitle>
          <CardDescription>
            {currentTerm !== null ? (
              <>
                This cycle runs in <strong>{termLabel(currentTerm)}</strong>. Class standing is
                counted from it, and it cannot be changed.
              </>
            ) : (
              <>
                Not set. Until it is, applicant pages show no class standing. It can be set once and
                then never changed — a wrong semester mislabels every applicant, and the only fix is
                deleting the instance.
              </>
            )}
          </CardDescription>
        </CardHeader>
        {currentTerm === null ? (
          <CardContent>
            {unlocked ? (
              <SemesterForm instanceId={instance.id} />
            ) : (
              <p className="text-sm">
                Setting it needs this instance&apos;s own password.{" "}
                <Link
                  href={`/instances/${instance.id}/unlock?next=${encodeURIComponent(`/instances/${instance.id}/settings`)}`}
                  className="underline"
                >
                  Unlock the instance
                </Link>{" "}
                to continue.
              </p>
            )}
          </CardContent>
        ) : null}
      </Card>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Instance password</CardTitle>
          <CardDescription>
            The password reviewers-turned-admins use to open this cycle. It cannot be recovered —
            resetting replaces it. Anyone already signed in keeps access until their session
            expires.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResetPasswordForm instanceId={instance.id} />
        </CardContent>
      </Card>

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

      {/* Both actions on this page are audited. The log lives one gate up, on
          this instance's own password, because its entries can quote applicant
          data — see the note at the top of the audit page. Linking rather than
          inlining is the honest version: the reader is told the record exists
          and what it costs to read it. */}
      <p className="text-muted-foreground mt-2 text-xs">
        Setting the semester, password resets and deletions are recorded in this cycle&apos;s{" "}
        <Link href={`/instances/${instance.id}/audit`} className="hover:underline">
          activity log
        </Link>
        , which needs the instance password to open.
      </p>
    </main>
  );
}
