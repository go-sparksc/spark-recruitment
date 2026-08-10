"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth";
import { hashSecret } from "@/lib/password";
import { prisma } from "@/lib/prisma";

export interface DeleteState {
  error?: string;
}

export interface ResetPasswordState {
  error?: string;
  saved?: boolean;
}

/// FR-5: "Never recoverable; recovery means an admin with app-level access
/// resets it."
///
/// requireAdmin ALONE. Putting this behind the instance password would mean the
/// recovery path FR-5 names does not exist — the password you cannot remember
/// would be the password required to replace it.
///
/// The consequence, stated in the PRD rather than left to be discovered: the
/// instance password is not a boundary against anyone holding the app password.
/// It scopes routine access between cycles; §8's app-level gate is the real one.
export async function resetInstancePassword(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  await requireAdmin();

  const instanceId = String(formData.get("instanceId") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (password.length < 8) return { error: "The new password must be at least 8 characters." };
  if (password !== confirm) return { error: "The two passwords do not match." };

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { id: true },
  });
  if (!instance) return { error: "No such instance." };

  const passwordHash = await hashSecret(password);

  await prisma.$transaction(async (tx) => {
    await tx.instance.update({ where: { id: instanceId }, data: { passwordHash } });
    // Audited per §8. previousValue deliberately records only that a reset
    // happened — never the old hash, and obviously never either plaintext.
    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
        action: "RESET_INSTANCE_PASSWORD",
        entityType: "Instance",
        entityId: instanceId,
        previousValue: { reset: true },
      },
    });
  });

  revalidatePath(`/instances/${instanceId}/settings`);
  return { saved: true };
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
