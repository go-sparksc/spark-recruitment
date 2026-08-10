"use server";

import { redirect } from "next/navigation";

import { unlockInstance } from "@/lib/auth";
import { safeRedirect } from "@/lib/session";

export interface UnlockState {
  error?: string;
}

export async function unlock(_prev: UnlockState, formData: FormData): Promise<UnlockState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeRedirect(String(formData.get("next") ?? ""), `/instances/${instanceId}`);

  if (password === "") return { error: "Enter this instance's password." };

  // unlockInstance calls requireAdmin() itself, so this action cannot be used to
  // probe instance passwords without app-level access.
  const result = await unlockInstance(instanceId, password);

  if (!result.ok) {
    if (result.lockedForSeconds !== undefined) {
      const minutes = Math.max(1, Math.ceil(result.lockedForSeconds / 60));
      return {
        error: `Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      };
    }
    return { error: "Incorrect password." };
  }

  redirect(next);
}
