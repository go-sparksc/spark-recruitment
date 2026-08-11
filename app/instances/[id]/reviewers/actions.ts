"use server";

import { revalidatePath } from "next/cache";

import { Round } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
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
async function existingReviewers(instanceId: string, round: Round) {
  const reviewers = await prisma.reviewer.findMany({
    where: { instanceId },
    select: { id: true, firstName: true, lastName: true, rounds: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  return reviewers.map((reviewer) => ({
    id: reviewer.id,
    firstName: reviewer.firstName,
    lastName: reviewer.lastName,
    servesThisRound: reviewer.rounds.includes(round),
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

  // The client is not trusted to have cleared the queue. Re-parsing what it
  // submitted is what enforces FR-6 here rather than in the browser: a CREATE
  // whose name still cannot be split is refused, whatever the UI allowed.
  const reparsed = parseRoster(
    creates.map((r) => `${r.firstName} ${r.lastName}`).join("\n"),
    [],
  );
  const unsplittable = reparsed.needsConfirmation.filter((entry) =>
    entry.flags.includes("UNSPLITTABLE"),
  );
  if (unsplittable.length > 0) {
    return {
      error:
        `${unsplittable.length} reviewer${unsplittable.length === 1 ? "" : "s"} still ` +
        `${unsplittable.length === 1 ? "has" : "have"} no last name. Give each one a last ` +
        `name or drop the line.`,
    };
  }

  if (creates.length === 0 && addRounds.length === 0) {
    return { error: "Nothing to import — every line was dropped." };
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
    if (creates.length > 0) {
      await tx.reviewer.createMany({
        // FR-6: pasted reviewers arrive as non-Sparklets, in the round being
        // staffed and no other. Both are set in the grid afterwards.
        data: creates.map((r) => ({
          instanceId,
          firstName: r.firstName.trim(),
          lastName: r.lastName.trim(),
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
