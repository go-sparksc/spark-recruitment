"use server";

import { redirect } from "next/navigation";

import { AssignmentStatus, Round } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { MAX_NOTE_LENGTH, validateScore } from "@/lib/review";
import { requireReviewerOnRoster, signInReviewer, signOutReviewer } from "@/lib/reviewer-auth";

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

  // Order matters and is not arbitrary: the name is checked BEFORE the code.
  //
  // This is the second of the two guards that stop a nameless sign-in — the
  // first is `required` on the <select>, which works before hydration. This one
  // is the boundary, since a client guard is only ever a courtesy.
  //
  // Keeping the name first is also what makes the message right. Reverse them
  // and a reviewer whose name did not reach the server is told their code is
  // wrong, sending them to re-check a code that was fine. Verified in a browser
  // by stripping `required` and submitting an empty id: the server answers
  // "Pick your name from the list." and creates no session.
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

// ---------------------------------------------------------------------------
// FR-9 clauses 3a, 3b and 4 — scoring, the note, and autosave
// ---------------------------------------------------------------------------

export interface SaveState {
  ok: boolean;
  error?: string;
  /// Epoch ms, so the card can say when rather than only whether.
  savedAt?: number;
}

/// **Every save takes FormData, and that is deliberate.** The pre-hydration
/// native POST and the hydrated autosave then send byte-identical requests, so
/// there is one contract to reason about, one thing to test, and no second path
/// that only runs when JavaScript is absent — which is the path nobody
/// exercises and therefore the one that rots.
///
/// Each pair below is one core plus two thin wrappers, because React types a
/// form's `action` as returning `void | Promise<void>`. The `*Form` wrapper is
/// what `<form action={...}>` binds and it reports failure by throwing; the
/// other returns a `SaveState` for the autosave queue, which needs to
/// distinguish "saved" from "will retry" without a navigation. The rules live
/// in the core and neither wrapper may add any.
function refuse(message: string): never {
  throw new Error(message);
}

/// An assignment id in a request body is an untrusted reference until it has
/// been shown to belong to this reviewer, in this round, and to still be theirs.
///
/// `requireReviewerOnRoster` is called HERE and not only on the page: a server
/// action is a POST endpoint reachable without ever loading the form, so
/// render-time gating is not a boundary. Same reasoning as lib/auth.ts.
async function ownedAssignmentId(instanceId: string, assignmentId: string): Promise<string> {
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  const assignment = await prisma.assignment.findFirst({
    where: {
      id: assignmentId,
      instanceId,
      round: session.rd,
      reviewerId: reviewer.id,
      status: AssignmentStatus.ACTIVE,
    },
    select: { id: true },
  });

  // Covers a returned-to-pool assignment as well as a forged id: once it is no
  // longer theirs, it is no longer writable. Deliberately does not say which,
  // for the same reason sign-in does not say which half was wrong.
  if (!assignment) refuse("That applicant is no longer assigned to you.");
  return assignment.id;
}

async function applyScore(formData: FormData): Promise<void> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const assignmentId = String(formData.get("assignmentId") ?? "");
  const rubricCategoryId = String(formData.get("rubricCategoryId") ?? "");
  const raw = formData.get("points");

  if (instanceId === "" || assignmentId === "" || rubricCategoryId === "") {
    refuse("Something went wrong. Reload the page and try again.");
  }
  if (raw === null) refuse("No score was submitted.");

  const owned = await ownedAssignmentId(instanceId, assignmentId);

  // Scoped to the instance: a category id from another cycle is not a category
  // this reviewer may write against, and the maximum has to come from the row
  // rather than from the request.
  const category = await prisma.rubricCategory.findFirst({
    where: { id: rubricCategoryId, instanceId },
    select: { id: true, maxPoints: true },
  });
  if (!category) refuse("That rubric category no longer exists. Reload the page.");

  // "" is the clear control, and the only way 3/4 goes back to 2/4.
  const text = String(raw).trim();
  const points = text === "" ? null : Number(text);
  if (points !== null && !Number.isFinite(points)) refuse("That is not a score.");

  const verdict = validateScore(points, category.maxPoints);
  if (!verdict.ok) refuse(verdict.reason);

  if (verdict.points === null) {
    // deleteMany rather than delete: deleting a row that is already gone is the
    // expected outcome of a retried clear, not an error.
    await prisma.score.deleteMany({
      where: { assignmentId: owned, rubricCategoryId: category.id },
    });
    return;
  }

  // Upsert on the unique key that has existed since Phase 0. This is where "a
  // retry after an ambiguous failure cannot write twice" comes from — a
  // constraint, not a nonce. See PRD decision 26.
  await prisma.score.upsert({
    where: {
      assignmentId_rubricCategoryId: { assignmentId: owned, rubricCategoryId: category.id },
    },
    create: { assignmentId: owned, rubricCategoryId: category.id, points: verdict.points },
    update: { points: verdict.points },
  });
}

async function applyNote(formData: FormData): Promise<void> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const assignmentId = String(formData.get("assignmentId") ?? "");
  const body = String(formData.get("body") ?? "");

  if (instanceId === "" || assignmentId === "") {
    refuse("Something went wrong. Reload the page and try again.");
  }
  if (body.length > MAX_NOTE_LENGTH) {
    refuse(`Notes are capped at ${MAX_NOTE_LENGTH} characters.`);
  }

  const owned = await ownedAssignmentId(instanceId, assignmentId);

  // An emptied note removes the row rather than storing "". Mirrors the score
  // clear: undoing something must leave no trace of it, or FR-10 later reports a
  // note that says nothing.
  if (body.trim() === "") {
    await prisma.reviewNote.deleteMany({ where: { assignmentId: owned } });
    return;
  }

  await prisma.reviewNote.upsert({
    where: { assignmentId: owned },
    create: { assignmentId: owned, body },
    update: { body },
  });
}

/// The no-JavaScript and pre-hydration path. Bound directly to `<form action>`,
/// so a tap in the hydration window is a completed save rather than a discarded
/// one — PRD decision 33's second mitigation.
///
/// **Neither of these calls `revalidatePath`, `refresh()` or `redirect`.** A
/// route re-render per keystroke is the opposite of what a phone on a bad
/// connection needs. The native POST re-renders anyway because that is what a
/// form submit does; the hydrated path deliberately does not.
export async function saveScoreForm(formData: FormData): Promise<void> {
  await applyScore(formData);
}

export async function saveNoteForm(formData: FormData): Promise<void> {
  await applyNote(formData);
}

/// What the autosave queue calls once the page is interactive. Reports rather
/// than throws, because "will retry" is a state the card has to render and an
/// unhandled rejection is not.
export async function saveScore(formData: FormData): Promise<SaveState> {
  try {
    await applyScore(formData);
    return { ok: true, savedAt: Date.now() };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

export async function saveNote(formData: FormData): Promise<SaveState> {
  try {
    await applyNote(formData);
    return { ok: true, savedAt: Date.now() };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/// Only messages this module wrote are shown. A Prisma or connection error
/// carries schema detail and a connection string fragment, and a reviewer can
/// act on neither.
function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : "Could not save. Retrying.";
}
