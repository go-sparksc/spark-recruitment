"use server";

import { redirect } from "next/navigation";

import { signInAsAdmin } from "@/lib/auth";
import { adminDisplayName, safeRedirect } from "@/lib/session";

export interface LoginState {
  error?: string;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const firstName = String(formData.get("firstName") ?? "");
  const lastName = String(formData.get("lastName") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeRedirect(String(formData.get("next") ?? ""));

  // The name is validated BEFORE the password is checked, and its failure is
  // reported separately. That is safe precisely because the name is not a
  // credential (PRD decision 16): telling someone they left it blank reveals
  // nothing, since there is no roster it could be checked against.
  const name = adminDisplayName(firstName, lastName);
  if (name === null) {
    return { error: "Enter your first and last name, so overrides can be attributed." };
  }

  if (password === "") return { error: "Enter the admin password." };

  const result = await signInAsAdmin(name, password);

  if (!result.ok) {
    if (result.lockedForSeconds !== undefined) {
      const minutes = Math.max(1, Math.ceil(result.lockedForSeconds / 60));
      return {
        error: `Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      };
    }
    // Deliberately not "no such password" or anything that distinguishes a
    // wrong password from a missing configuration. The name is never mentioned
    // here either — a wrong password fails the same way whoever typed it.
    return { error: "Incorrect password." };
  }

  redirect(next);
}
