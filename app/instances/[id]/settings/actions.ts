"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auditActor } from "@/lib/audit";
import { requireAdmin, requireInstance } from "@/lib/auth";
import { termLabel, validateCurrentTerm } from "@/lib/class-standing";
import { hashSecret } from "@/lib/password";
import { prisma } from "@/lib/prisma";

export interface DeleteState {
  error?: string;
}

export interface ResetPasswordState {
  error?: string;
  saved?: boolean;
}

export interface SetSemesterState {
  error?: string;
}

/// Decision 119's set-once control, for instances created before the semester
/// was collected at creation.
///
/// **`requireInstance`, not `requireAdmin` like its neighbours.** Reset and
/// delete sit behind the app password alone because they are FR-5's recovery
/// path. This is not recovery: it changes what every reviewer sees on every
/// applicant, which is routine instance work and belongs behind the instance
/// password, the same as the mapping table's visibility controls.
///
/// **Set once, enforced here and not only by hiding the form.** The write is a
/// conditional `updateMany` on both columns still being null, so a replayed POST,
/// a second tab, or two admins racing each other all land as a count of 0, and a
/// count of 0 is refused. The database does not make the semester immutable — its
/// CHECKs only hold the pair together and bound the year — so this condition is
/// the whole of that rule.
export async function setCurrentSemester(
  _prev: SetSemesterState,
  formData: FormData,
): Promise<SetSemesterState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const session = await requireInstance(instanceId, `/instances/${instanceId}/settings`);

  const term = validateCurrentTerm(
    String(formData.get("currentTermSeason") ?? ""),
    String(formData.get("currentTermYear") ?? ""),
  );
  if (!term.ok) return { error: term.error };

  const outcome = await prisma.$transaction(async (tx) => {
    const { count } = await tx.instance.updateMany({
      where: { id: instanceId, currentTermSeason: null, currentTermYear: null },
      data: { currentTermSeason: term.term.season, currentTermYear: term.term.year },
    });
    if (count === 0) return "ALREADY_SET" as const;

    // Audited per §8: it changes what reviewers see. previousValue is the null
    // pair it replaced; the new value is on the instance itself.
    await tx.auditLog.create({
      data: {
        instanceId,
        ...auditActor(session),
        action: "SET_CURRENT_SEMESTER",
        entityType: "Instance",
        entityId: instanceId,
        previousValue: { currentTermSeason: null, currentTermYear: null },
      },
    });
    return "SET" as const;
  });

  if (outcome === "ALREADY_SET") {
    const existing = await prisma.instance.findUnique({
      where: { id: instanceId },
      select: { currentTermSeason: true, currentTermYear: true },
    });
    if (!existing) return { error: "No such instance." };
    // Naming the value that stands, so an admin who raced someone else sees what
    // won rather than a bare refusal.
    const standing =
      existing.currentTermSeason !== null && existing.currentTermYear !== null
        ? termLabel({ season: existing.currentTermSeason, year: existing.currentTermYear })
        : "a semester";
    return {
      error: `This instance's semester is already set to ${standing}, and it cannot be changed.`,
    };
  }

  revalidatePath(`/instances/${instanceId}/settings`);
  return {};
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
  const session = await requireAdmin();

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
        ...auditActor(session),
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
  const session = await requireAdmin();

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
        ...auditActor(session),
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
