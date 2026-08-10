"use server";

import { redirect } from "next/navigation";

import { signInAsAdmin } from "@/lib/auth";
import { safeRedirect } from "@/lib/session";

export interface LoginState {
  error?: string;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  const next = safeRedirect(String(formData.get("next") ?? ""));

  if (password === "") return { error: "Enter the admin password." };

  const result = await signInAsAdmin(password);

  if (!result.ok) {
    if (result.lockedForSeconds !== undefined) {
      const minutes = Math.max(1, Math.ceil(result.lockedForSeconds / 60));
      return {
        error: `Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      };
    }
    // Deliberately not "no such password" or anything that distinguishes a
    // wrong password from a missing configuration.
    return { error: "Incorrect password." };
  }

  redirect(next);
}
