"use server";

import { redirect } from "next/navigation";

import { AssignmentStatus, Round } from "@/generated/prisma/enums";
import { claimSlotWithin } from "@/lib/claim-slot";
import { prisma } from "@/lib/prisma";
import { MAX_NOTE_LENGTH, validateReturn, validateScore } from "@/lib/review";
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
  // this reviewer may write against, and both bounds have to come from the row
  // rather than from the request.
  const category = await prisma.rubricCategory.findFirst({
    where: { id: rubricCategoryId, instanceId },
    select: { id: true, minPoints: true, maxPoints: true },
  });
  if (!category) refuse("That rubric category no longer exists. Reload the page.");

  // "" is the clear control, and the only way 3/4 goes back to 2/4.
  const text = String(raw).trim();
  const points = text === "" ? null : Number(text);
  if (points !== null && !Number.isFinite(points)) refuse("That is not a score.");

  const verdict = validateScore(points, category.minPoints, category.maxPoints);
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

// ---------------------------------------------------------------------------
// FR-9 clauses 5a, 5b and 5c — returning an applicant to the pool
// ---------------------------------------------------------------------------

/// "'Return to pool' on any applicant, with a required reason (conflict of
/// interest / other)."
///
/// FormData-shaped like every save above, so the control works before React
/// attaches — a `<details>` disclosure around a plain form needs no JavaScript
/// at all, which is decision 33's standard met without a modal.
///
/// **`ownedAssignmentId` is reused unchanged and does more here than it looks.**
/// It scopes to this reviewer, this round, and `status: ACTIVE` — so a forged
/// id, another reviewer's assignment, and a return submitted twice all refuse
/// identically, and the second submit cannot re-return something already
/// returned.
///
/// **Scores and the note are deliberately not deleted.** The reviewer handed the
/// applicant back; they did not retract an opinion they had already recorded.
/// Whether FR-10 counts a returned reviewer's scores is a Phase 4 question and
/// is not decided here — but destroying the rows now would decide it silently.
///
/// **No `AuditLog` row.** §8 audits admin overrides, and this is not one: the
/// `Assignment` row is its own record, carrying who returned it, why, the free
/// text, and when. A log row would duplicate a record that cannot drift from
/// itself.
export async function returnToPool(formData: FormData): Promise<void> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const assignmentId = String(formData.get("assignmentId") ?? "");
  const reason = formData.get("reason");
  const note = String(formData.get("note") ?? "");

  if (instanceId === "" || assignmentId === "") {
    refuse("Something went wrong. Reload the page and try again.");
  }

  const verdict = validateReturn(typeof reason === "string" ? reason : null, note);
  if (!verdict.ok) refuse(verdict.error);

  const owned = await ownedAssignmentId(instanceId, assignmentId);

  await prisma.assignment.update({
    where: { id: owned },
    data: {
      status: AssignmentStatus.RETURNED_TO_POOL,
      returnReason: verdict.reason,
      returnNote: verdict.note,
      returnedAt: new Date(),
    },
  });

  // The list is dynamic — it reads cookies — so it re-renders on arrival and
  // the returned applicant is simply absent, per the ACTIVE filter it already
  // had. No revalidation needed and none wanted.
  redirect(`/r/${instanceId}/list`);
}

// ---------------------------------------------------------------------------
// FR-9 clause 6 — claiming an open slot
// ---------------------------------------------------------------------------

/// FR-9 clause 6a: "'Claim from pool'".
///
/// **The losing claimant is redirected, not thrown at.** A thrown error renders
/// an error boundary, and the walkthrough's requirement is that neither device
/// in the race sees a 500 — one lands on the applicant, the other is told
/// plainly and gets a pool list that no longer offers it. The redirect back to
/// `/pool` re-renders that list on the way, which is the refresh, and it works
/// with no JavaScript, which the pre-hydration path needs.
///
/// **`redirect` is called after the transaction closes, never inside it.** It
/// reports by throwing a control-flow error, and thrown inside `$transaction`
/// that error is a rollback — the claim would be undone and the reviewer would
/// land on an applicant that is not theirs.
export async function claimSlot(formData: FormData): Promise<void> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const applicantId = String(formData.get("applicantId") ?? "");

  if (instanceId === "" || applicantId === "") {
    refuse("Something went wrong. Reload the page and try again.");
  }

  // Same boundary as every other action here: the session decides who is
  // claiming, and the Sparklet flag is read from the database rather than
  // accepted from the request.
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  const outcome = await prisma.$transaction((tx) =>
    claimSlotWithin(tx, {
      instanceId,
      round: session.rd,
      applicantId,
      reviewer: { id: reviewer.id, isSparklet: reviewer.isSparklet },
    }),
  );

  if (!outcome.ok) redirect(`/r/${instanceId}/pool?claim=${outcome.reason}`);

  redirect(`/r/${instanceId}/a/${outcome.assignmentId}`);
}

/// Only messages this module wrote are shown. A Prisma or connection error
/// carries schema detail and a connection string fragment, and a reviewer can
/// act on neither.
function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : "Could not save. Retrying.";
}
