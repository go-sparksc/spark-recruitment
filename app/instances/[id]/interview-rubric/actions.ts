"use server";

import { revalidatePath } from "next/cache";

import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateInterviewRubric, type InterviewCategoryInput } from "@/lib/rubric";

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

  const cleaned = categories.map((category, ordinal) => ({
    name: category.name.trim(),
    maxPoints: category.maxPoints,
    ordinal,
  }));

  // Replace rather than diff, the same shape `saveRubric` uses and for the same
  // reason: `InterviewCategory` is keyed by (instanceId, ordinal), and reordering
  // through a diff means a sequence of updates that collide with that key
  // halfway. Unreachable once any score exists, so the delete cannot orphan an
  // `InterviewCategoryScore` — that is what the guard above is protecting.
  await prisma.$transaction(async (tx) => {
    await tx.interviewCategory.deleteMany({ where: { instanceId } });
    await tx.interviewCategory.createMany({
      data: cleaned.map((category) => ({ ...category, instanceId })),
    });
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
