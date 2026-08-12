// FR-4 rubric validation. Pure — no database, no Prisma.
//
// Thin by design. CLAUDE.md reserves real test suites for lib/assignment.ts and
// lib/passes.ts; this exists because the rules are worth stating once rather
// than scattering them across a form component and a server action, which is
// how a client and a server end up disagreeing about what is valid.

export interface RubricCategoryInput {
  name: string;
  maxPoints: number;
  /// What this category asks for and what the top of its scale means. Optional
  /// per FR-4, and the only thing a written reviewer has to score against beyond
  /// the name — see PRD decision 32.
  description?: string | null;
}

export const MAX_CATEGORIES = 20;
export const MAX_POINTS_CEILING = 1000;
/// Long enough for two or three sentences of guidance, short enough that nobody
/// pastes an essay into a card that has to fit on a phone beside a score input.
export const MAX_DESCRIPTION_LENGTH = 400;

/// Goal 5: the rubric must be reconfigurable between cycles, so nothing here
/// assumes four categories or any particular scale. The only limits are the
/// ones that catch a typo — a 500-category rubric is a fat finger, not a plan.
export function validateRubric(categories: readonly RubricCategoryInput[]): string[] {
  const errors: string[] = [];

  if (categories.length === 0) {
    errors.push("A rubric needs at least one category.");
    return errors;
  }

  if (categories.length > MAX_CATEGORIES) {
    errors.push(`A rubric of more than ${MAX_CATEGORIES} categories is almost certainly a typo.`);
  }

  categories.forEach((category, index) => {
    const position = index + 1;

    if (category.name.trim() === "") {
      errors.push(`Category ${position} has no name.`);
    }

    if (!Number.isInteger(category.maxPoints)) {
      errors.push(`Category ${position} needs a whole number of points.`);
    } else if (category.maxPoints < 1) {
      errors.push(`Category ${position} needs at least 1 point.`);
    } else if (category.maxPoints > MAX_POINTS_CEILING) {
      errors.push(`Category ${position} is capped at ${MAX_POINTS_CEILING} points.`);
    }

    // Absent is fine — FR-4 makes the description optional. Only its length is
    // validated, because it renders inside a card that has to share a phone
    // screen with the score input it explains.
    if ((category.description ?? "").length > MAX_DESCRIPTION_LENGTH) {
      errors.push(
        `Category ${position}'s description is over ${MAX_DESCRIPTION_LENGTH} characters. ` +
          `Reviewers read this on a phone beside the score box.`,
      );
    }
  });

  // Duplicate names are not a database error — RubricCategory is keyed by
  // (instanceId, ordinal) — but two categories called "Fit" make a reviewer's
  // scoring screen ambiguous and FR-10's per-category breakdown unreadable.
  const seen = new Map<string, number>();
  for (const category of categories) {
    const key = category.name.trim().toLowerCase();
    if (key === "") continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [name, count] of seen) {
    if (count > 1) errors.push(`More than one category is called “${name}”.`);
  }

  return errors;
}

/// The total a single reviewer can award. Shown while building so the scale is
/// visible before grading starts rather than discovered from the first results.
export function rubricTotal(categories: readonly RubricCategoryInput[]): number {
  return categories.reduce(
    (sum, category) => sum + (Number.isFinite(category.maxPoints) ? category.maxPoints : 0),
    0,
  );
}
