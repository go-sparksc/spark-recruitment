// FR-4 rubric validation. Pure — no database, no Prisma.
//
// Thin by design. CLAUDE.md reserves real test suites for lib/assignment.ts and
// lib/passes.ts; this exists because the rules are worth stating once rather
// than scattering them across a form component and a server action, which is
// how a client and a server end up disagreeing about what is valid.

export interface RubricCategoryInput {
  name: string;
  /// The scale's floor, per PRD decision 40. 0 for rubrics built before the
  /// column existed; 1 for anything FR-4's builder creates now.
  minPoints: number;
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

    // Decision 40's invariant: 0 <= minPoints < maxPoints.
    //
    // Strictly less than, not less than or equal: a category whose floor equals
    // its ceiling offers the reviewer exactly one value, which is not a scale
    // and would make every applicant's variance on it zero by construction.
    //
    // Guarded on maxPoints being an integer so a category with a garbage
    // maximum reports one problem rather than two — the floor cannot be
    // meaningfully compared against NaN, and saying so twice helps nobody.
    if (!Number.isInteger(category.minPoints)) {
      errors.push(`Category ${position}'s lowest score needs to be a whole number.`);
    } else if (category.minPoints < 0) {
      errors.push(`Category ${position}'s lowest score cannot be negative.`);
    } else if (Number.isInteger(category.maxPoints) && category.minPoints >= category.maxPoints) {
      errors.push(
        `Category ${position}'s lowest score (${category.minPoints}) has to be below its ` +
          `highest (${category.maxPoints}).`,
      );
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

/// The range a single reviewer can award across the whole rubric. Shown while
/// building so the scale is visible before grading starts rather than discovered
/// from the first results.
///
/// A range rather than a single total since decision 40: with a floor, the
/// lowest possible score is no longer zero, and "16 points per reviewer" would
/// describe a 4–16 instrument as though 0 were reachable.
export function rubricRange(categories: readonly RubricCategoryInput[]): {
  min: number;
  max: number;
} {
  const sum = (pick: (category: RubricCategoryInput) => number) =>
    categories.reduce((total, category) => {
      const value = pick(category);
      return total + (Number.isFinite(value) ? value : 0);
    }, 0);

  return { min: sum((category) => category.minPoints), max: sum((category) => category.maxPoints) };
}
