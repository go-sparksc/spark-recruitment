"use server";

import { redirect } from "next/navigation";

import { Round } from "@/generated/prisma/enums";
import { signInReviewer, signOutReviewer } from "@/lib/reviewer-auth";

export interface SignInState {
  error?: string;
}

const ROUNDS: readonly string[] = Object.values(Round);

function parseRound(value: unknown): Round | null {
  return typeof value === "string" && ROUNDS.includes(value) ? (value as Round) : null;
}

/// FR-9's entry point, per decision 30: round, name and code on one screen with
/// one submit.
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const round = parseRound(formData.get("round"));
  const reviewerId = String(formData.get("reviewerId") ?? "");
  const code = String(formData.get("code") ?? "").trim();

  if (instanceId === "") return { error: "Something went wrong. Reload the page and try again." };
  if (round === null) return { error: "Pick a round." };
  if (reviewerId === "") return { error: "Pick your name from the list." };
  if (code === "") return { error: "Enter the access code." };

  const result = await signInReviewer(instanceId, round, reviewerId, code);

  if (!result.ok) {
    if (result.lockedForSeconds !== undefined) {
      const minutes = Math.max(1, Math.ceil(result.lockedForSeconds / 60));
      return {
        error: `Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      };
    }
    // Deliberately does not say which half was wrong. Telling someone the name
    // was accepted and only the code failed confirms the roster is real, and
    // there is nothing a genuine reviewer can do with the distinction that
    // "check the code" does not already cover.
    return { error: "That code is not right for this round. Check the message it came in." };
  }

  redirect(`/r/${instanceId}/list`);
}

/// Takes FormData so a plain <form action={signOut}> works without a client
/// component. Signing out is one button and does not need one.
export async function signOut(formData: FormData): Promise<void> {
  const instanceId = String(formData.get("instanceId") ?? "");
  await signOutReviewer();
  redirect(instanceId === "" ? "/" : `/r/${instanceId}`);
}
