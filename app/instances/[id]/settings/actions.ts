"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export interface DeleteState {
  error?: string;
}

/// Delete an instance and everything under it.
///
/// Gated on requireAdmin ALONE, deliberately — not requireInstance. FR-5 makes
/// an instance password unrecoverable and names app-level access as the recovery
/// path; if deletion also sat behind the instance password, an admin who typoed
/// one at creation could not open the instance, reset it, OR remove it, leaving
/// a permanently unreachable row holding real applicant data.
///
/// The typed name is the confirmation. There is no undo.
export async function deleteInstance(
  _prev: DeleteState,
  formData: FormData,
): Promise<DeleteState> {
  await requireAdmin();

  const instanceId = String(formData.get("instanceId") ?? "");
  const typedName = String(formData.get("confirmName") ?? "").trim();

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: {
      id: true,
      name: true,
      currentStage: true,
      importCommittedAt: true,
      _count: { select: { applicants: true } },
    },
  });

  if (!instance) return { error: "No such instance." };

  if (typedName !== instance.name) {
    return { error: `Type the instance name exactly — “${instance.name}” — to confirm.` };
  }

  await prisma.$transaction(async (tx) => {
    // 1. Purge this instance's existing audit rows FIRST. They describe entities
    //    about to stop existing, and their previousValue payloads can carry
    //    applicant data that §8's retention rules say must not outlive the
    //    cycle. Doing this after the delete would be impossible — the FK is
    //    SET NULL, so they would already be orphaned and unfindable.
    await tx.auditLog.deleteMany({ where: { instanceId } });

    // 2. Write the deletion record while the instance still exists.
    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
        action: "DELETE_INSTANCE",
        entityType: "Instance",
        entityId: instance.id,
        // Identity and scale only. Never applicant data — this row outlives
        // the purge and must not reintroduce what the purge removed.
        previousValue: {
          name: instance.name,
          applicantCount: instance._count.applicants,
          currentStage: instance.currentStage,
          importCommittedAt: instance.importCommittedAt?.toISOString() ?? null,
        },
      },
    });

    // 3. Delete. ON DELETE SET NULL orphans that one row by design, so the
    //    record of the deletion survives the cascade it describes. Under the
    //    Phase 0 CASCADE it would have been destroyed, leaving the single
    //    irreversible action in the product as the only one with no trace.
    await tx.instance.delete({ where: { id: instanceId } });
  });

  revalidatePath("/");
  redirect("/");
}
