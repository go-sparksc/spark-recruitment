import { notFound, redirect } from "next/navigation";

import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/// An instance has no landing page of its own yet. Where it sends you depends on
/// whether its CSV has committed: FR-3's preview and the rounds arrive in later
/// slices, so until then a committed instance goes to the mapping table too.
export default async function InstancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireInstance(id, `/instances/${id}`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!instance) notFound();

  redirect(`/instances/${id}/mapping`);
}
