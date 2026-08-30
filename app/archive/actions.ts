"use server";

import { revalidatePath } from "next/cache";

import { archiveAndPurge, pruneAfterPurge } from "@/lib/archive-io";
import { auditActor } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";

export interface PurgeState {
  error?: string;
  done?: string;
}

/// FR-less by design — §8 is the requirement, not a numbered FR. PRD decision 95.
///
/// **`requireAdmin` alone, deliberately, not `requireInstance`.** The same
/// reasoning FR-5 uses for deletion: an archive screen that demanded each
/// cycle's own password could not purge the one cycle whose password was lost,
/// which is exactly the cycle most likely to be old enough to need purging. A
/// purge is also strictly less destructive than the deletion already gated this
/// way — it keeps the instance, its scores and its decisions.
///
/// The typed name is the confirmation, mirroring `deleteInstance`. There is no
/// undo.
export async function purgeInstance(
  _prev: PurgeState,
  formData: FormData,
): Promise<PurgeState> {
  const session = await requireAdmin();

  const instanceId = String(formData.get("instanceId") ?? "");
  const typedName = String(formData.get("confirmName") ?? "").trim();
  const expectedName = String(formData.get("expectedName") ?? "").trim();

  if (instanceId === "") return { error: "Something went wrong. Reload and try again." };

  // Compared against the name rendered on this page rather than re-read from the
  // database, so the admin is confirming the cycle they were looking at. The
  // action re-checks eligibility itself, so a stale name cannot purge the wrong
  // row — it can only fail to match.
  if (typedName !== expectedName) {
    return { error: `Type the cycle's name exactly — “${expectedName}” — to confirm.` };
  }

  const result = await archiveAndPurge(instanceId, auditActor(session));

  if (!result.ok) return { error: result.message };

  // Outside the purge transaction: failing to tidy spent rate-limit buckets must
  // not roll back a completed purge.
  await pruneAfterPurge().catch(() => {});

  revalidatePath("/archive");
  revalidatePath("/");

  const removed = Object.entries(result.removed)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${count} ${table}`)
    .join(", ");

  return { done: removed === "" ? "Archived. Nothing needed removing." : `Archived. Removed ${removed}.` };
}
