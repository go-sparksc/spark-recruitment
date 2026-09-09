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
  /// What each offered score value means, per PRD decision 114 — one entry per
  /// value from `minPoints` to `maxPoints`, keyed by the value itself.
  ///
  /// **A map rather than an array**, because the thing a criterion belongs to is
  /// a score value and not a position. An array would silently re-point every
  /// criterion at a different number the moment someone changed `minPoints`,
  /// which is the shape of bug decision 40 already had to reason about once.
  ///
  /// Missing and empty are the same thing and both mean "no guidance for this
  /// value", which decision 114 keeps optional for the reason decision 32 made
  /// the description optional.
  levels?: Readonly<Record<number, string>>;
}

export const MAX_CATEGORIES = 20;
export const MAX_POINTS_CEILING = 1000;
/// Long enough for two or three sentences of guidance, short enough that nobody
/// pastes an essay into a card that has to fit on a phone beside a score input.
export const MAX_CRITERION_LENGTH = 400;

/// How many values a category may offer while carrying per-value criteria.
///
/// **Not a cap on `maxPoints`.** Decision 114 is explicit that `MAX_POINTS_CEILING`
/// stays where it is: lowering it would retroactively invalidate an instance
/// that has already run, which is decision 40's entire argument for making the
/// scale data rather than a rule. This bounds the *rubric-writing* exercise
/// instead — one line of guidance per value stops being a rubric somewhere well
/// before a hundred of them, and a category that wide is a typo rather than a
/// plan. A rubric already wider than this keeps whatever it holds; the check
/// below only fires on a scale someone is editing now.
export const MAX_SCALE_VALUES = 10;

/// The score values a category offers, low to high.
///
/// One helper rather than three `for` loops: the builder renders an input per
/// value, `validateRubric` checks a criterion per value, and the reviewer's card
/// renders a button per value. Three separate derivations of "which values does
/// this category have" is how one of them comes to disagree about whether the
/// floor is included.
export function scaleValues(minPoints: number, maxPoints: number): number[] {
  if (!Number.isInteger(minPoints) || !Number.isInteger(maxPoints)) return [];
  if (maxPoints < minPoints) return [];
  const values: number[] = [];
  for (let value = minPoints; value <= maxPoints; value += 1) values.push(value);
  return values;
}

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

    // Decision 114's criteria. Absent is fine, per value and in total: FR-4
    // keeps them optional for the reason decision 32 kept the description
    // optional, so what is checked is width, length, and that nothing is
    // attached to a score the category does not offer.
    const levels = category.levels ?? {};
    const values = scaleValues(category.minPoints, category.maxPoints);

    if (values.length > MAX_SCALE_VALUES && Object.keys(levels).length > 0) {
      errors.push(
        `Category ${position} offers ${values.length} different scores, which is too many to ` +
          `write a line about each. Narrow the range to ${MAX_SCALE_VALUES} values or fewer.`,
      );
    }

    for (const [key, criterion] of Object.entries(levels)) {
      const value = Number(key);

      // A criterion attached to a score nobody can give. Reachable by lowering
      // maxPoints after writing the guidance, and it would otherwise be stored,
      // exported, and rendered nowhere — invisible until a restore.
      if (!values.includes(value)) {
        errors.push(
          `Category ${position} has guidance for a score of ${key}, which is outside its ` +
            `${category.minPoints}–${category.maxPoints} range.`,
        );
        continue;
      }

      if (criterion.length > MAX_CRITERION_LENGTH) {
        errors.push(
          `Category ${position}'s guidance for a score of ${key} is over ` +
            `${MAX_CRITERION_LENGTH} characters. Reviewers read this on a phone beside the ` +
            `score box.`,
        );
      }
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

// ---------------------------------------------------------------------------
// FR-12a — the interview rubric
// ---------------------------------------------------------------------------

/// One interview category. **No floor and no description**, unlike the written
/// rubric above.
///
/// FR-12a asks for "number of categories and max points per category" and
/// nothing else, and the two omissions are deliberate rather than unfinished:
///
///   - **No `minPoints`.** Decision 40 added a floor to the written rubric
///     because FR-9 renders an input control and "no submitted answer should be
///     scorable as nothing". These numbers are not typed into a control — they
///     arrive from an interviewer's spreadsheet through FR-12, where 0 is a
///     legal thing for a sheet to say. A floor here would reject real data at
///     import for failing a rule the interviewers never agreed to.
///   - **No `description`.** Decision 32's reasoning was that a written reviewer
///     scoring blind needs to know what the category means. Nobody scores
///     against this rubric inside the application; FR-12 imports numbers that
///     were already decided in the room.
///
/// A separate type rather than reusing `RubricCategoryInput` with the extra
/// fields ignored, so the builder cannot send a description that silently goes
/// nowhere.
export interface InterviewCategoryInput {
  /// The existing row's id, absent for a category being added.
  ///
  /// **Load-bearing, per PRD decision 61.** A staged FR-12 mapping stores
  /// `CATEGORY:<id>`, so an id that changes when someone fixes a typo silently
  /// unmaps every column of an in-progress import. This is the same ruling §5
  /// makes for `FieldGroup.key` and for the same reason.
  id?: string;
  name: string;
  maxPoints: number;
}

/// What a save has to do to turn the stored rubric into the submitted one.
///
/// Pure, and separated from the action so the identity rule that decision 61
/// turns on can be tested without a database — this is the part that regressed,
/// and "the ids survived" is not observable from the UI until an import is
/// already staged against them.
export interface InterviewRubricPlan {
  updates: { id: string; name: string; maxPoints: number; ordinal: number }[];
  creates: { name: string; maxPoints: number; ordinal: number }[];
  deleteIds: string[];
}

/// PRD decision 61: update in place, add and remove only what actually changed.
///
/// A submitted row keeps its id when the database still has that row. Anything
/// else is a create — including a row carrying an id the instance does not own,
/// which is what stops a tampered or stale payload from adopting another
/// instance's category.
///
/// **A repeated id is honoured once.** Two submitted rows claiming one id would
/// otherwise become two updates to the same row, leaving one submitted category
/// silently unsaved; the second occurrence becomes a create instead.
///
/// Ordinal is position in the submitted list, so reordering is expressed purely
/// as updates. The caller has to park the survivors on temporary ordinals before
/// writing these, since `@@unique([instanceId, ordinal])` is not deferrable.
export function planInterviewRubricSave(
  existingIds: readonly string[],
  incoming: readonly InterviewCategoryInput[],
): InterviewRubricPlan {
  const available = new Set(existingIds);
  const claimed = new Set<string>();

  const updates: InterviewRubricPlan["updates"] = [];
  const creates: InterviewRubricPlan["creates"] = [];

  incoming.forEach((category, ordinal) => {
    const row = { name: category.name.trim(), maxPoints: category.maxPoints, ordinal };

    if (category.id !== undefined && available.has(category.id) && !claimed.has(category.id)) {
      claimed.add(category.id);
      updates.push({ id: category.id, ...row });
    } else {
      creates.push(row);
    }
  });

  return {
    updates,
    creates,
    // Everything the instance had that the submission no longer claims.
    deleteIds: existingIds.filter((id) => !claimed.has(id)),
  };
}

/// FR-12a's validation, which is FR-4's minus the two fields above.
///
/// Delegates rather than reimplements: the category cap, the points ceiling, the
/// blank-name check and the duplicate-name check are the same rules for the same
/// reasons, and two copies would drift. `minPoints: 0` is supplied here rather
/// than by the caller — it makes the floor checks unreachable, which is the
/// point, and keeps `0 <= minPoints < maxPoints` satisfied for every valid
/// maximum.
///
/// Duplicate names matter more here than in the written rubric: FR-12's mapping
/// step binds a CSV column to a category BY NAME, and two categories called
/// "Fit" make that mapping ambiguous at exactly the moment nobody is looking.
export function validateInterviewRubric(
  categories: readonly InterviewCategoryInput[],
): string[] {
  return validateRubric(categories.map((category) => ({ ...category, minPoints: 0 })));
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
