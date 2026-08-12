"use server";

import { revalidatePath } from "next/cache";

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
    maxPoints: category.maxPoints,
    // Empty and whitespace-only both store as null rather than "". A blank
    // string would render as an empty paragraph under the category name and
    // read as a description that failed to load.
    description: (category.description ?? "").trim() || null,
    ordinal,
  }));

  // Replace rather than diff. RubricCategory is keyed by (instanceId, ordinal),
  // and Score references categories by id — but this path is unreachable once
  // any Score exists, so nothing can be orphaned by the delete.
  await prisma.$transaction(async (tx) => {
    await tx.rubricCategory.deleteMany({ where: { instanceId } });
    await tx.rubricCategory.createMany({
      data: cleaned.map((c) => ({ ...c, instanceId })),
    });
  });

  revalidatePath(`/instances/${instanceId}/rubric`);
  return { saved: true };
}

/// FR-4's explicit escape hatch: changing the rubric after grading has started
/// requires deliberately discarding the grading. Audited, per §8 — this destroys
/// reviewer work and the log is what makes that answerable afterwards.
export async function resetWrittenScores(instanceId: string): Promise<RubricState> {
  await requireInstance(instanceId, `/instances/${instanceId}/rubric`);

  const existing = await scoreCount(instanceId);
  if (existing === 0) return { error: "There are no written scores to reset." };

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
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
