"use server";

import { revalidatePath } from "next/cache";

import { auditActor } from "@/lib/audit";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateRubric, type RubricCategoryInput } from "@/lib/rubric";

export interface RubricState {
  error?: string;
  errors?: string[];
  saved?: boolean;
}

/// FR-4: "Rubric is locked once any Score exists."
///
/// Counted through Assignment, since Score has no instanceId of its own. No
/// Score rows can exist yet in Phase 1 — the scoring UI is Phase 3 — so this
/// guard is written and unit-tested rather than demonstrated. It is written now
/// because Phase 3 is when it starts mattering and by then nobody will be
/// thinking about the rubric builder.
async function scoreCount(instanceId: string): Promise<number> {
  return prisma.score.count({ where: { assignment: { instanceId } } });
}

export async function saveRubric(
  instanceId: string,
  categories: RubricCategoryInput[],
): Promise<RubricState> {
  await requireInstance(instanceId, `/instances/${instanceId}/rubric`);

  const errors = validateRubric(categories);
  if (errors.length > 0) return { errors };

  if ((await scoreCount(instanceId)) > 0) {
    return {
      error:
        "Grading has started, so the rubric is locked. Reset the written scores first — " +
        "that deletes every score already submitted.",
    };
  }

  const cleaned = categories.map((category, ordinal) => ({
    name: category.name.trim(),
    minPoints: category.minPoints,
    maxPoints: category.maxPoints,
    ordinal,
    // Decision 114. Empty and whitespace-only are dropped rather than stored as
    // "": a blank criterion would render as an empty line under a score button
    // and read as guidance that failed to load. Dropping it means the value
    // simply has none, which is the state FR-4 keeps optional.
    levels: Object.entries(category.levels ?? {})
      .map(([points, criterion]) => ({ points: Number(points), criterion: criterion.trim() }))
      .filter((level) => level.criterion !== ""),
  }));

  // Replace rather than diff. RubricCategory is keyed by (instanceId, ordinal),
  // and Score references categories by id — but this path is unreachable once
  // any Score exists, so nothing can be orphaned by the delete.
  //
  // **The levels go in the same transaction**, and they have to: a rubric saved
  // with its categories replaced and its criteria not would leave every category
  // describing a scale nobody can read, and the failure would be invisible until
  // a reviewer opened the card. `createMany` cannot write the nested rows, so
  // the categories are created one at a time to get their ids back — at most
  // MAX_CATEGORIES of them, on a page an admin visits once per cycle.
  await prisma.$transaction(async (tx) => {
    await tx.rubricCategory.deleteMany({ where: { instanceId } });
    for (const { levels, ...category } of cleaned) {
      await tx.rubricCategory.create({
        data: {
          ...category,
          instanceId,
          levels: levels.length > 0 ? { create: levels } : undefined,
        },
      });
    }
  });

  revalidatePath(`/instances/${instanceId}/rubric`);
  return { saved: true };
}

/// FR-4's explicit escape hatch: changing the rubric after grading has started
/// requires deliberately discarding the grading. Audited, per §8 — this destroys
/// reviewer work and the log is what makes that answerable afterwards.
export async function resetWrittenScores(instanceId: string): Promise<RubricState> {
  const session = await requireInstance(instanceId, `/instances/${instanceId}/rubric`);

  const existing = await scoreCount(instanceId);
  if (existing === 0) return { error: "There are no written scores to reset." };

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        instanceId,
        ...auditActor(session),
        action: "RESET_WRITTEN_SCORES",
        entityType: "Instance",
        entityId: instanceId,
        previousValue: { deletedScoreCount: existing },
      },
    });
    await tx.score.deleteMany({ where: { assignment: { instanceId } } });
  });

  revalidatePath(`/instances/${instanceId}/rubric`);
  return { saved: true };
}
