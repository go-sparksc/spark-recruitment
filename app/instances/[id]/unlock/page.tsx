import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { UnlockForm } from "./unlock-form";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeRedirect } from "@/lib/session";

export const metadata = { title: "Unlock instance — Spark SC Recruitment" };

export default async function UnlockPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { id } = await params;
  const { next } = await searchParams;

  // App-level access only. The instance password is what this page collects, so
  // requiring it here would be circular.
  const session = await requireAdmin(`/instances/${id}/unlock`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true, name: true },
  });

  if (!instance) notFound();

  const destination = safeRedirect(next, `/instances/${id}`);
  if (session.ins.includes(id)) redirect(destination);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-16">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← Instances
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{instance.name}</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        This cycle has its own password.
      </p>

      <UnlockForm instanceId={id} next={destination} />

      <p className="text-muted-foreground mt-6 text-xs">
        Forgotten it? It cannot be recovered, but an admin with the app password can reset it from
        the instance settings — no need for this one.
      </p>
    </main>
  );
}
