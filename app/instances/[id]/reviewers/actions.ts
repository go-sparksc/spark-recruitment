"use server";

import { revalidatePath } from "next/cache";

import { Round } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { hashSecret } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import {
  checkReviewerName,
  checkReviewerRemoval,
  parseRoster,
  type ParsedRoster,
  type RemovalVerdict,
} from "@/lib/roster";

export interface ActionState {
  error?: string;
  message?: string;
}

const ok: ActionState = {};

const ROUND_LABELS: Record<Round, string> = {
  [Round.WRITTEN]: "written round",
  [Round.FIRST_ROUND]: "first round",
  [Round.SECOND_ROUND]: "second round",
};

function path(instanceId: string) {
  return `/instances/${instanceId}/reviewers`;
}

/// Every reviewer on the INSTANCE, with round membership flattened for the round
/// being staffed. Instance-scoped per PRD decision 22: a reviewer serving
/// another round is the same person, not a new one.
///
/// `round` is null for callers that do not belong to a round at all — renaming
/// is the one — and `servesThisRound` is then false throughout and unread. Only
/// the paste queue consumes it, to say whether adding the round would be a no-op.
async function existingReviewers(instanceId: string, round: Round | null) {
  const reviewers = await prisma.reviewer.findMany({
    where: { instanceId },
    select: { id: true, firstName: true, lastName: true, rounds: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  return reviewers.map((reviewer) => ({
    id: reviewer.id,
    firstName: reviewer.firstName,
    lastName: reviewer.lastName,
    servesThisRound: round !== null && reviewer.rounds.includes(round),
  }));
}

/// Parse without writing. The confirmation queue lives between this and
/// `commitPaste` as client state — a 30-line paste is nowhere near the body
/// limit that forced `ImportRow` into the database in Phase 1, so nothing is
/// staged and an abandoned paste leaves nothing behind.
export async function previewPaste(
  instanceId: string,
  round: Round,
  text: string,
): Promise<ParsedRoster> {
  await requireInstance(instanceId, path(instanceId));

  return parseRoster(text, await existingReviewers(instanceId, round));
}

/// What the admin decided about one queued line.
export type PasteResolution =
  /// Create a `Reviewer`. Carries the names as they stand after any edit in the
  /// queue, which is how an UNSPLITTABLE line gets its last name.
  | { kind: "CREATE"; firstName: string; lastName: string }
  /// Add this round to a reviewer who already exists (PRD decision 22).
  | { kind: "ADD_ROUND"; reviewerId: string }
  | { kind: "DROP" };

export async function commitPaste(
  instanceId: string,
  round: Round,
  resolutions: PasteResolution[],
): Promise<ActionState> {
  await requireInstance(instanceId, path(instanceId));

  const creates = resolutions.filter((r) => r.kind === "CREATE");
  const addRounds = resolutions.filter((r) => r.kind === "ADD_ROUND");

  if (creates.length === 0 && addRounds.length === 0) {
    return { error: "Nothing to import — every line was dropped." };
  }

  // The client is not trusted to have cleared the queue, and the queue's two
  // free-text inputs never went through parseRoster at all. Every proposed name
  // goes through the shared gate here.
  //
  // This used to join the two fields back into one line and re-split it, which
  // validated a string it then did not store: "Ann" + "Marie Smith" was checked
  // as ("Ann Marie", "Smith") and written as ("Ann", "Marie Smith"). It happened
  // to catch the blank-name case it was aimed at, and would have gone on being
  // subtly wrong about everything else.
  const existing = await existingReviewers(instanceId, round);
  const checked: { firstName: string; lastName: string }[] = [];

  for (const create of creates) {
    // Matches are NOT refused here: choosing CREATE in the queue is the admin
    // saying these are two different people, which FR-6 allows.
    const verdict = checkReviewerName(create, existing);
    if (!verdict.ok) {
      const shown = `${create.firstName} ${create.lastName}`.trim();
      return { error: `${shown === "" ? "One entry" : `“${shown}”`}: ${verdict.reason}` };
    }
    checked.push({ firstName: verdict.firstName, lastName: verdict.lastName });
  }

  // Guard the ids rather than trusting them: an ADD_ROUND naming a reviewer on
  // another instance would otherwise reach across instances.
  const targets = await prisma.reviewer.findMany({
    where: { instanceId, id: { in: addRounds.map((r) => r.reviewerId) } },
    select: { id: true, rounds: true },
  });
  if (targets.length !== addRounds.length) {
    return { error: "One of those reviewers no longer exists. Reload and paste again." };
  }

  await prisma.$transaction(async (tx) => {
    if (checked.length > 0) {
      await tx.reviewer.createMany({
        // FR-6: pasted reviewers arrive as non-Sparklets, in the round being
        // staffed and no other, and the flag and any further rounds are set in
        // the grid afterwards. That is a constraint on the PASTE — it keeps one
        // paste box being one paste box, rather than a box with a column of
        // checkboxes beside it. Manual add has its own Sparklet checkbox, which
        // FR-6 describes and which nothing here contradicts.
        //
        // Names come from `checked`, never from the raw resolutions: the values
        // the gate returned are the values that get stored.
        data: checked.map((r) => ({
          instanceId,
          firstName: r.firstName,
          lastName: r.lastName,
          isSparklet: false,
          rounds: [round],
        })),
      });
    }

    for (const target of targets) {
      // Idempotent: adding a round the reviewer already serves is a no-op rather
      // than a duplicate entry in the array.
      if (target.rounds.includes(round)) continue;
      await tx.reviewer.update({
        where: { id: target.id },
        data: { rounds: [...target.rounds, round] },
      });
    }
  });

  revalidatePath(path(instanceId));

  const added = targets.filter((t) => !t.rounds.includes(round)).length;
  return {
    message:
      `Added ${creates.length} reviewer${creates.length === 1 ? "" : "s"}` +
      (added > 0 ? `, and put ${added} existing one${added === 1 ? "" : "s"} in this round` : "") +
      `.`,
  };
}

/// A name that already exists on the roster, handed back for the admin to
/// confirm rather than refused. FR-6 allows two reviewers to share a name, so
/// the answer has to come from a person; `matchNames` is what the prompt shows.
export interface NameState extends ActionState {
  needsConfirmation?: { firstName: string; lastName: string; matchCount: number };
}

/// FR-6's first sentence: "Admin adds reviewers by first and last name with a
/// Sparklet checkbox." This is that path; bulk paste is the addition beside it.
///
/// The Sparklet checkbox is here because FR-6 puts one here. It is not an
/// exemption from the rule that pasted reviewers arrive as non-Sparklets — that
/// rule is about keeping one paste box being one paste box, and says nothing
/// about a form with two fields already on it.
export async function addReviewer(
  instanceId: string,
  round: Round,
  input: { firstName: string; lastName: string; isSparklet: boolean },
  confirmDuplicate = false,
): Promise<NameState> {
  await requireInstance(instanceId, path(instanceId));

  const verdict = checkReviewerName(input, await existingReviewers(instanceId, round));
  if (!verdict.ok) return { error: verdict.reason };

  if (verdict.matches.length > 0 && !confirmDuplicate) {
    return {
      needsConfirmation: {
        firstName: verdict.firstName,
        lastName: verdict.lastName,
        matchCount: verdict.matches.length,
      },
    };
  }

  await prisma.reviewer.create({
    data: {
      instanceId,
      firstName: verdict.firstName,
      lastName: verdict.lastName,
      isSparklet: input.isSparklet,
      rounds: [round],
    },
  });

  revalidatePath(path(instanceId));
  return { message: `Added ${verdict.firstName} ${verdict.lastName}.` };
}

/// Correct a name — a typo in a pasted line, or a rename.
///
/// **Takes no round, and touches no round.** The update below writes `firstName`
/// and `lastName` and nothing else, so a reviewer serving all three rounds keeps
/// all three. A name is a property of the person, not of their membership in the
/// round whose page the edit happened to be opened from.
///
/// Deliberately unguarded, unlike removal: renaming destroys nothing. Every
/// score, assignment, and vote references `reviewerId`, which is the whole point
/// of §5's rule against keying by name — so a rename cannot orphan anything, and
/// adding a removal-style block here by analogy would be wrong.
export async function renameReviewer(
  instanceId: string,
  reviewerId: string,
  input: { firstName: string; lastName: string },
  confirmDuplicate = false,
): Promise<NameState> {
  await requireInstance(instanceId, path(instanceId));

  const reviewer = await prisma.reviewer.findFirst({
    where: { id: reviewerId, instanceId },
    select: { id: true },
  });
  if (!reviewer) return { error: "That reviewer no longer exists." };

  const verdict = checkReviewerName(input, await existingReviewers(instanceId, null), {
    // Without this, every rename collides with the row being renamed — including
    // one that only fixes capitalisation.
    ignoreReviewerId: reviewerId,
  });
  if (!verdict.ok) return { error: verdict.reason };

  if (verdict.matches.length > 0 && !confirmDuplicate) {
    return {
      needsConfirmation: {
        firstName: verdict.firstName,
        lastName: verdict.lastName,
        matchCount: verdict.matches.length,
      },
    };
  }

  await prisma.reviewer.update({
    where: { id: reviewerId },
    // Two fields. Not rounds, not isSparklet, not assignments.
    data: { firstName: verdict.firstName, lastName: verdict.lastName },
  });

  revalidatePath(path(instanceId));
  return { message: `Renamed to ${verdict.firstName} ${verdict.lastName}.` };
}

export async function setSparklet(
  instanceId: string,
  reviewerId: string,
  isSparklet: boolean,
): Promise<ActionState> {
  await requireInstance(instanceId, path(instanceId));

  await prisma.reviewer.update({
    where: { id: reviewerId, instanceId },
    data: { isSparklet },
  });

  revalidatePath(path(instanceId));
  return ok;
}

/// The counts `checkReviewerRemoval` decides on. Scoped to one round when
/// `round` is given, to every assignment the reviewer holds when it is null.
///
/// `Score` and `ReviewNote` have no reviewerId of their own — they hang off
/// `Assignment` — so both are counted through it, the same way FR-4's rubric
/// lock counts scores through `assignment.instanceId`.
async function removalImpact(instanceId: string, reviewerId: string, round: Round | null) {
  const where = { instanceId, reviewerId, ...(round === null ? {} : { round }) };

  const [assignmentCount, scoredAssignmentCount, notedAssignmentCount] = await Promise.all([
    prisma.assignment.count({ where }),
    prisma.assignment.count({ where: { ...where, scores: { some: {} } } }),
    prisma.assignment.count({ where: { ...where, note: { isNot: null } } }),
  ]);

  return { assignmentCount, scoredAssignmentCount, notedAssignmentCount };
}

/// What a removal would cost, without doing it. The grid calls this to build its
/// confirmation, so the admin reads the real numbers before deciding.
export async function previewRemoval(
  instanceId: string,
  reviewerId: string,
  round: Round | null,
): Promise<RemovalVerdict> {
  await requireInstance(instanceId, path(instanceId));

  const reviewer = await prisma.reviewer.findFirst({
    where: { id: reviewerId, instanceId },
    select: { firstName: true, lastName: true },
  });
  if (!reviewer) return { allowed: false, reason: "That reviewer no longer exists." };

  return checkReviewerRemoval(
    {
      reviewerName: `${reviewer.firstName} ${reviewer.lastName}`,
      roundLabel: round === null ? null : ROUND_LABELS[round],
    },
    await removalImpact(instanceId, reviewerId, round),
  );
}

/// Remove a reviewer, or withdraw them from one round.
///
/// The guard runs again here, on counts read inside the same call, rather than
/// trusting the verdict the confirmation was built from. Between rendering that
/// confirmation and clicking it, a reviewer can have submitted a score —
/// §10.5's answer to concurrent admins is last-write-wins, which is fine for an
/// edit and not fine for a delete.
export async function removeReviewer(
  instanceId: string,
  reviewerId: string,
  round: Round | null,
): Promise<ActionState> {
  await requireInstance(instanceId, path(instanceId));

  const reviewer = await prisma.reviewer.findFirst({
    where: { id: reviewerId, instanceId },
    select: { firstName: true, lastName: true, rounds: true },
  });
  if (!reviewer) return { error: "That reviewer no longer exists." };

  // One read, used for both the verdict and the audit row, so the number the
  // guard decided on is the number the log records.
  const impact = await removalImpact(instanceId, reviewerId, round);

  const verdict = checkReviewerRemoval(
    {
      reviewerName: `${reviewer.firstName} ${reviewer.lastName}`,
      roundLabel: round === null ? null : ROUND_LABELS[round],
    },
    impact,
  );
  if (!verdict.allowed) return { error: verdict.reason };

  await prisma.$transaction(async (tx) => {
    // §8 audits admin overrides. Losing assignments is exactly the kind of thing
    // that has to be answerable afterwards, so the row records what was there.
    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
        action: round === null ? "REMOVE_REVIEWER" : "REMOVE_REVIEWER_FROM_ROUND",
        entityType: "Reviewer",
        entityId: reviewerId,
        previousValue: {
          firstName: reviewer.firstName,
          lastName: reviewer.lastName,
          rounds: reviewer.rounds,
          round,
          deletedAssignmentCount: impact.assignmentCount,
        },
      },
    });

    if (round === null) {
      await tx.reviewer.delete({ where: { id: reviewerId } });
      return;
    }

    // Withdrawing from a round deletes that round's assignments explicitly. The
    // reviewer row survives, so no cascade would fire and the assignments would
    // otherwise be left pointing at a round the reviewer no longer serves.
    await tx.assignment.deleteMany({ where: { instanceId, reviewerId, round } });
    await tx.reviewer.update({
      where: { id: reviewerId },
      data: { rounds: reviewer.rounds.filter((r) => r !== round) },
    });
  });

  revalidatePath(path(instanceId));
  return { message: verdict.consequence };
}

/// Add a round to a reviewer from the grid. The inverse of a round withdrawal,
/// and deliberately not guarded: it destroys nothing.
export async function addRound(
  instanceId: string,
  reviewerId: string,
  round: Round,
): Promise<ActionState> {
  await requireInstance(instanceId, path(instanceId));

  const reviewer = await prisma.reviewer.findFirst({
    where: { id: reviewerId, instanceId },
    select: { rounds: true },
  });
  if (!reviewer) return { error: "That reviewer no longer exists." };
  if (reviewer.rounds.includes(round)) return ok;

  await prisma.reviewer.update({
    where: { id: reviewerId },
    data: { rounds: [...reviewer.rounds, round] },
  });

  revalidatePath(path(instanceId));
  return ok;
}

// ---------------------------------------------------------------------------
// Round access code (PRD decision 31)
// ---------------------------------------------------------------------------

/// Set or rotate the access code reviewers type to reach this round, per §8.
///
/// Outside FR-9's six bullets and shipped anyway: `RoundAccessCode` has existed
/// since Phase 0 and only the seed has ever written one, so every instance built
/// through FR-2 carried an unreachable reviewer dashboard. The Phase 3 gate
/// requires a board member who has never seen the tool to complete a review, and
/// that cannot happen on an instance with no code.
///
/// Hashed with the same argon2id path as every other secret here, and never
/// returned or re-displayed — §8 puts access codes under the same rule as
/// passwords. An admin who forgets it rotates it rather than reading it back.
export async function setRoundCode(
  instanceId: string,
  round: Round,
  code: string,
): Promise<ActionState> {
  await requireInstance(instanceId, path(instanceId));

  // Reviewers type this on a phone keyboard from a Slack message. A code with a
  // leading or trailing space is one nobody can enter, and trimming it silently
  // would store something other than what the admin typed.
  if (code.trim() !== code) {
    return { error: "Leading and trailing spaces are not allowed — reviewers cannot type them." };
  }
  // Long enough to be worth hashing. The limiter in decision 19 caps one address
  // at roughly 40 guesses an hour, which makes a strong code impractical to
  // guess and does nothing at all for "spark".
  if (code.length < 6) {
    return { error: "An access code needs at least 6 characters." };
  }

  const existing = await prisma.roundAccessCode.findUnique({
    where: { instanceId_round: { instanceId, round } },
    select: { id: true },
  });
  const rotated = existing !== null;

  const codeHash = await hashSecret(code);

  await prisma.$transaction(async (tx) => {
    await tx.roundAccessCode.upsert({
      where: { instanceId_round: { instanceId, round } },
      create: { instanceId, round, codeHash },
      update: { codeHash },
    });
    // Audited per §8: this changes who can reach applicant data. previousValue
    // records that a rotation happened and never the old hash, matching what
    // resetInstancePassword already does.
    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
        action: rotated ? "ROTATE_ROUND_CODE" : "SET_ROUND_CODE",
        entityType: "RoundAccessCode",
        entityId: existing?.id ?? `${instanceId}:${round}`,
        previousValue: { round, rotated },
      },
    });
  });

  revalidatePath(path(instanceId));

  const rotatedMessage =
    `Rotated the ${ROUND_LABELS[round]} code. Reviewers already signed in stay signed in ` +
    `until their session expires; the old code no longer works for anyone new.`;
  const setMessage = `Set the ${ROUND_LABELS[round]} code. Share it with the link below.`;

  return { message: rotated ? rotatedMessage : setMessage };
}
