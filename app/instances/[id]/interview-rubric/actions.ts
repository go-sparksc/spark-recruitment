"use server";

import { revalidatePath } from "next/cache";

import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  planInterviewRubricSave,
  validateInterviewRubric,
  type InterviewCategoryInput,
} from "@/lib/rubric";

export interface InterviewRubricState {
  error?: string;
  errors?: string[];
  saved?: boolean;
}

function path(instanceId: string) {
  return `/instances/${instanceId}/interview-rubric`;
}

/// FR-12a: "The rubric locks once any `InterviewCategoryScore` exists — a
/// distinct lock condition from FR-4's."
///
/// **Counted through `InterviewCategory`, not through the applicant.**
/// `InterviewCategoryScore` has no `instanceId` of its own and could be reached
/// either way, but this path cannot accidentally count another instance's rows,
/// and it counts exactly what the delete below would destroy — the scores
/// hanging off the categories this action is about to replace.
async function interviewScoreCount(instanceId: string): Promise<number> {
  return prisma.interviewCategoryScore.count({
    where: { interviewCategory: { instanceId } },
  });
}

export async function saveInterviewRubric(
  instanceId: string,
  categories: InterviewCategoryInput[],
): Promise<InterviewRubricState> {
  await requireInstance(instanceId, path(instanceId));

  const errors = validateInterviewRubric(categories);
  if (errors.length > 0) return { errors };

  if ((await interviewScoreCount(instanceId)) > 0) {
    return {
      error:
        "Interview scores have been imported, so this rubric is locked. Discard them first — " +
        "the sheet can be re-imported afterwards.",
    };
  }

  const existing = await prisma.interviewCategory.findMany({
    where: { instanceId },
    orderBy: { ordinal: "asc" },
    select: { id: true },
  });

  const plan = planInterviewRubricSave(
    existing.map((category) => category.id),
    categories,
  );

  // **Update in place, per PRD decision 61.** This used to delete every row and
  // recreate the set, which regenerated all four cuids on every save — so
  // correcting one category's spelling silently unmapped every column of an
  // already-staged FR-12 sheet, because the mapping stores `CATEGORY:<id>`.
  // Found by clicking through, not by review.
  //
  // Ordinals are parked first because `@@unique([instanceId, ordinal])` is not
  // deferrable: writing final positions row by row collides the moment two
  // categories swap places. Negating is one statement for the whole instance and
  // cannot collide with the 0..n-1 range being written next, since every stored
  // ordinal is non-negative.
  await prisma.$transaction(async (tx) => {
    if (plan.deleteIds.length > 0) {
      await tx.interviewCategory.deleteMany({ where: { id: { in: plan.deleteIds } } });
    }

    if (plan.updates.length > 0) {
      await tx.$executeRaw`
        UPDATE "InterviewCategory" SET "ordinal" = -"ordinal" - 1 WHERE "instanceId" = ${instanceId}
      `;

      for (const update of plan.updates) {
        await tx.interviewCategory.update({
          where: { id: update.id },
          data: { name: update.name, maxPoints: update.maxPoints, ordinal: update.ordinal },
        });
      }
    }

    if (plan.creates.length > 0) {
      await tx.interviewCategory.createMany({
        data: plan.creates.map((category) => ({ ...category, instanceId })),
      });
    }
  });

  revalidatePath(path(instanceId));
  revalidatePath(`/instances/${instanceId}`);
  return { saved: true };
}

/// The escape hatch, modelled on FR-4's `resetWrittenScores` per clause 12a-4.
///
/// **Beyond FR-12a's literal text**, which states the lock and stops. Without
/// it, an admin who imports a scores sheet and then finds the rubric wrong has
/// no path forward but deleting the instance — a dead end reachable on an
/// ordinary afternoon.
///
/// **Far less destructive than FR-4's reset, which is why it is defensible
/// here.** That one destroys work thirty reviewers typed and cannot get back.
/// This deletes imported data that still exists in the file it came from, and
/// decision 47 makes re-importing it a normal operation rather than a recovery.
///
/// Deletes `InterviewResult` rows rather than `InterviewCategoryScore` rows
/// alone. Removing only the category scores would leave results carrying an
/// average with nothing underneath it — a state no import can produce and no
/// screen is written to render.
///
/// `InterviewNotes` is untouched: it references no category and survives a
/// rubric change intact.
///
/// Audited per §8, alongside the other admin overrides.
export async function resetInterviewScores(
  instanceId: string,
): Promise<InterviewRubricState> {
  await requireInstance(instanceId, path(instanceId));

  const existing = await interviewScoreCount(instanceId);
  if (existing === 0) return { error: "There are no imported interview scores to discard." };

  const resultCount = await prisma.interviewResult.count({
    where: { applicant: { instanceId } },
  });

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        instanceId,
        // One shared admin password, so the actor cannot yet name an individual
        // — open decision 16. Same literal every other audited override uses.
        actor: "admin",
        action: "RESET_INTERVIEW_SCORES",
        entityType: "Instance",
        entityId: instanceId,
        previousValue: {
          deletedInterviewResultCount: resultCount,
          deletedCategoryScoreCount: existing,
        },
      },
    });
    // Category scores cascade from the result, so this is one statement rather
    // than two, and cannot leave half the pair behind.
    await tx.interviewResult.deleteMany({ where: { applicant: { instanceId } } });
  });

  revalidatePath(path(instanceId));
  revalidatePath(`/instances/${instanceId}`);
  return { saved: true };
}
