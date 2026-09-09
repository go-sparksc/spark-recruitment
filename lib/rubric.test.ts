import { describe, expect, it } from "vitest";

import {
  MAX_CATEGORIES,
  MAX_CRITERION_LENGTH,
  rubricRange,
  scaleValues,
  planInterviewRubricSave,
  validateInterviewRubric,
  validateRubric,
  type RubricCategoryInput,
} from "@/lib/rubric";

/// Defaults the floor to 0, which is what every rubric in the database had
/// before decision 40 and what these cases were originally written against.
/// Cases that are *about* the floor pass it explicitly.
function cat(overrides: Partial<RubricCategoryInput> = {}): RubricCategoryInput {
  return { name: "A", minPoints: 0, maxPoints: 5, ...overrides };
}

const ok = [
  cat({ name: "Written quality" }),
  cat({ name: "Initiative" }),
];

describe("validateRubric", () => {
  it("accepts a well-formed rubric", () => {
    expect(validateRubric(ok)).toEqual([]);
  });

  it("does not assume four categories or any particular scale", () => {
    // Goal 5: reconfigurable between cycles. S26 used four; nothing may hardcode it.
    expect(validateRubric([cat({ name: "Only one", maxPoints: 100 })])).toEqual([]);
    expect(
      validateRubric(Array.from({ length: 12 }, (_, i) => cat({ name: `C${i}`, maxPoints: 3 }))),
    ).toEqual([]);
  });

  it("rejects an empty rubric", () => {
    expect(validateRubric([])).toEqual(["A rubric needs at least one category."]);
  });

  it("rejects a nameless category by position", () => {
    const errors = validateRubric([ok[0], cat({ name: "   " })]);
    expect(errors).toContain("Category 2 has no name.");
  });

  it("rejects points below 1, above the ceiling, and non-integers", () => {
    expect(validateRubric([cat({ maxPoints: 0 })]).join(" ")).toMatch(/at least 1 point/);
    expect(validateRubric([cat({ maxPoints: -3 })]).join(" ")).toMatch(/at least 1 point/);
    expect(validateRubric([cat({ maxPoints: 5000 })]).join(" ")).toMatch(/capped at/);
    expect(validateRubric([cat({ maxPoints: 2.5 })]).join(" ")).toMatch(/whole number/);
    expect(validateRubric([cat({ maxPoints: Number.NaN })]).join(" ")).toMatch(/whole number/);
  });

  it("rejects duplicate names case-insensitively", () => {
    // Not a database error, but two categories called "Fit" make a reviewer's
    // screen ambiguous and FR-10's breakdown unreadable.
    const errors = validateRubric([cat({ name: "Fit" }), cat({ name: "  fit  " })]);
    expect(errors.join(" ")).toMatch(/More than one category is called/);
  });

  it("does not report two blank names as duplicates of each other", () => {
    // They already each have their own "has no name" error; saying they collide
    // as well is noise.
    const errors = validateRubric([cat({ name: "" }), cat({ name: "" })]);
    expect(errors.filter((e) => e.includes("More than one"))).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it("rejects an implausible number of categories", () => {
    const many = Array.from({ length: MAX_CATEGORIES + 1 }, (_, i) =>
      cat({ name: `C${i}`, maxPoints: 1 }),
    );
    expect(validateRubric(many).join(" ")).toMatch(/almost certainly a typo/);
  });
});

// ---------------------------------------------------------------------------
// The scale's floor — PRD decision 40
// ---------------------------------------------------------------------------

describe("minPoints", () => {
  it("accepts the 1-4 instrument decision 40 exists for", () => {
    expect(validateRubric([cat({ minPoints: 1, maxPoints: 4 })])).toEqual([]);
  });

  it("accepts a floor of 0, which is every rubric built before the column", () => {
    // The default is 0 precisely so the migration changed the meaning of no
    // existing row. A validator that rejected it would invalidate history.
    expect(validateRubric([cat({ minPoints: 0, maxPoints: 5 })])).toEqual([]);
  });

  it("rejects a negative floor", () => {
    expect(validateRubric([cat({ minPoints: -1, maxPoints: 4 })]).join(" ")).toMatch(
      /cannot be negative/,
    );
  });

  it("rejects a fractional floor", () => {
    expect(validateRubric([cat({ minPoints: 1.5, maxPoints: 4 })]).join(" ")).toMatch(
      /whole number/,
    );
  });

  it("rejects a floor equal to the maximum", () => {
    // Strictly less than, not less than or equal. A category offering exactly
    // one value is not a scale, and FR-10's variance over it is zero by
    // construction rather than by agreement.
    const errors = validateRubric([cat({ minPoints: 4, maxPoints: 4 })]);
    expect(errors.join(" ")).toMatch(/has to be below its highest/);
  });

  it("rejects a floor above the maximum, and names both numbers", () => {
    const errors = validateRubric([cat({ minPoints: 5, maxPoints: 4 })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\(5\)/);
    expect(errors[0]).toMatch(/\(4\)/);
  });

  it("reports one problem, not two, when the maximum is itself garbage", () => {
    // A floor cannot be meaningfully compared against NaN. Saying so twice
    // sends the admin looking for a second mistake they did not make.
    const errors = validateRubric([cat({ minPoints: 1, maxPoints: Number.NaN })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/whole number of points/);
  });

  it("names the offending category by position", () => {
    const errors = validateRubric([cat({ name: "A" }), cat({ name: "B", minPoints: 9 })]);
    expect(errors.join(" ")).toMatch(/Category 2/);
    expect(errors.join(" ")).not.toMatch(/Category 1/);
  });
});

describe("scaleValues", () => {
  /// One helper, three readers — the builder's inputs, the validator's check and
  /// the reviewer's buttons. Three derivations of "which values does this
  /// category offer" is how one of them comes to disagree about the floor.
  it("runs from the floor to the ceiling inclusive", () => {
    expect(scaleValues(1, 4)).toEqual([1, 2, 3, 4]);
    expect(scaleValues(0, 5)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("is a single value where the bounds meet", () => {
    // validateRubric rejects this as a rubric, but the helper is arithmetic and
    // answers honestly rather than second-guessing its caller.
    expect(scaleValues(3, 3)).toEqual([3]);
  });

  it("is empty for an inverted or non-integer range", () => {
    expect(scaleValues(4, 1)).toEqual([]);
    expect(scaleValues(Number.NaN, 4)).toEqual([]);
    expect(scaleValues(1, Number.NaN)).toEqual([]);
  });
});

describe("per-value criteria — PRD decision 114", () => {
  it("accepts a category with no criteria at all", () => {
    // FR-4 keeps them optional on decision 32's original terms: an admin
    // mid-setup must not be blocked, and a cycle that briefs reviewers
    // elsewhere is entitled to leave them empty.
    expect(validateRubric([cat({ name: "Drive" })])).toEqual([]);
    expect(validateRubric([cat({ name: "Drive", levels: {} })])).toEqual([]);
  });

  it("accepts criteria on some values and not others", () => {
    expect(
      validateRubric([cat({ name: "Drive", minPoints: 1, maxPoints: 4, levels: { 4: "Ran it end to end" } })]),
    ).toEqual([]);
  });

  it("accepts a criterion at the limit", () => {
    const atLimit = "x".repeat(MAX_CRITERION_LENGTH);
    expect(
      validateRubric([cat({ name: "Drive", minPoints: 1, maxPoints: 4, levels: { 2: atLimit } })]),
    ).toEqual([]);
  });

  it("rejects one character over the limit, and says why it matters", () => {
    // Not arbitrary tidiness: this renders on a card sharing a phone screen
    // with the score buttons it explains.
    const tooLong = "x".repeat(MAX_CRITERION_LENGTH + 1);
    const errors = validateRubric([
      cat({ name: "Drive", minPoints: 1, maxPoints: 4, levels: { 3: tooLong } }),
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Category 1's guidance for a score of 3 is over/);
    expect(errors[0]).toMatch(/phone/);
  });

  /// **The case that would otherwise be invisible.** Reachable by writing
  /// guidance and then lowering the ceiling: the criterion is stored, exported,
  /// and rendered nowhere, so nobody finds out until a restore.
  it("rejects a criterion attached to a score outside the range", () => {
    const errors = validateRubric([
      cat({ name: "Drive", minPoints: 1, maxPoints: 4, levels: { 7: "Unreachable" } }),
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/score of 7/);
    expect(errors[0]).toMatch(/outside its 1–4 range/);
  });

  it("rejects a criterion below the floor as well as above the ceiling", () => {
    // Decision 40's floor is real: a 1-4 category offers no 0, so guidance for
    // one describes a score no reviewer can give.
    const errors = validateRubric([
      cat({ name: "Drive", minPoints: 1, maxPoints: 4, levels: { 0: "Nothing at all" } }),
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/score of 0/);
  });

  /// Decision 114's width cap, and the half of it that matters: it bounds the
  /// rubric-writing exercise, NOT `maxPoints`. A wide scale with no criteria is
  /// still legal, because lowering MAX_POINTS_CEILING would retroactively
  /// invalidate an instance that has already run — decision 40's whole argument.
  it("rejects criteria on a scale wider than the cap, but not the scale itself", () => {
    const wide = cat({ name: "Drive", minPoints: 0, maxPoints: 100 });
    expect(validateRubric([wide])).toEqual([]);

    const errors = validateRubric([{ ...wide, levels: { 50: "Halfway" } }]);
    expect(errors.some((e) => /too many to write a line about each/.test(e))).toBe(true);
  });

  it("names the offending category by position", () => {
    const errors = validateRubric([
      cat({ name: "A" }),
      cat({
        name: "B",
        minPoints: 1,
        maxPoints: 4,
        levels: { 2: "x".repeat(MAX_CRITERION_LENGTH + 1) },
      }),
    ]);

    expect(errors.join(" ")).toMatch(/Category 2/);
    expect(errors.join(" ")).not.toMatch(/Category 1/);
  });
});

describe("rubricRange", () => {
  it("sums both ends of what a single reviewer can award", () => {
    expect(rubricRange(ok)).toEqual({ min: 0, max: 10 });
    expect(rubricRange([])).toEqual({ min: 0, max: 0 });
  });

  it("reports a floored rubric's real minimum, not zero", () => {
    // The whole reason this is a range: on four 1-4 categories the lowest
    // total a reviewer can award is 4, and calling it 0 describes an
    // instrument that does not exist.
    const fourByOneToFour = Array.from({ length: 4 }, (_, i) =>
      cat({ name: `C${i}`, minPoints: 1, maxPoints: 4 }),
    );
    expect(rubricRange(fourByOneToFour)).toEqual({ min: 4, max: 16 });
  });

  it("ignores a non-numeric entry rather than returning NaN", () => {
    // The form can hold a half-typed value; a total reading NaN looks broken.
    expect(
      rubricRange([cat({ maxPoints: Number.NaN }), cat({ name: "B", maxPoints: 4 })]),
    ).toEqual({ min: 0, max: 4 });
    expect(rubricRange([cat({ minPoints: Number.NaN, maxPoints: 4 })])).toEqual({
      min: 0,
      max: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// FR-12a — the interview rubric
// ---------------------------------------------------------------------------

describe("validateInterviewRubric", () => {
  it("accepts the S26 shape: four categories, each out of 4", () => {
    expect(
      validateInterviewRubric([
        { name: "Communication", maxPoints: 4 },
        { name: "Motivation", maxPoints: 4 },
        { name: "Culture Fit", maxPoints: 4 },
        { name: "Problem Solving", maxPoints: 4 },
      ]),
    ).toEqual([]);
  });

  it("assumes no particular number of categories or scale", () => {
    // Clause 12g: a cycle that changes its interview rubric needs no code change.
    expect(validateInterviewRubric([{ name: "Overall", maxPoints: 10 }])).toEqual([]);
    expect(
      validateInterviewRubric(
        Array.from({ length: 6 }, (_, i) => ({ name: `C${i}`, maxPoints: 5 })),
      ),
    ).toEqual([]);
  });

  it("requires at least one category, a name, and a sane maximum", () => {
    expect(validateInterviewRubric([])).toHaveLength(1);
    expect(validateInterviewRubric([{ name: "  ", maxPoints: 4 }])).toContain(
      "Category 1 has no name.",
    );
    expect(validateInterviewRubric([{ name: "A", maxPoints: 0 }])).toContain(
      "Category 1 needs at least 1 point.",
    );
    expect(validateInterviewRubric([{ name: "A", maxPoints: 1.5 }])).toContain(
      "Category 1 needs a whole number of points.",
    );
  });

  it("rejects duplicate names, which the FR-12 mapping step binds by", () => {
    expect(
      validateInterviewRubric([
        { name: "Fit", maxPoints: 4 },
        { name: "fit", maxPoints: 4 },
      ]),
    ).toContain("More than one category is called “fit”.");
  });

  it("never reports a floor error, since FR-12a has no floor", () => {
    // The delegation supplies minPoints: 0, so every floor branch in
    // validateRubric is unreachable from here. Asserted rather than assumed —
    // a maxPoints of 1 is the case that would trip `minPoints >= maxPoints` if
    // the supplied floor ever changed to decision 40's 1.
    expect(validateInterviewRubric([{ name: "Pass or fail", maxPoints: 1 }])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PRD decision 61 — ids survive a rubric edit
// ---------------------------------------------------------------------------

describe("planInterviewRubricSave", () => {
  const existing = ["cat-a", "cat-b", "cat-c"];

  it("keeps every id when only a name changes", () => {
    // THE regression. Correcting "Motiviation" used to regenerate all four ids
    // and silently unmap every column of an already-staged FR-12 sheet.
    const plan = planInterviewRubricSave(existing, [
      { id: "cat-a", name: "Communication", maxPoints: 4 },
      { id: "cat-b", name: "Motivation", maxPoints: 4 },
      { id: "cat-c", name: "Culture Fit", maxPoints: 4 },
    ]);

    expect(plan.updates.map((u) => u.id)).toEqual(["cat-a", "cat-b", "cat-c"]);
    expect(plan.creates).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.updates[1].name).toBe("Motivation");
  });

  it("expresses a reorder purely as updates, with new ordinals", () => {
    const plan = planInterviewRubricSave(existing, [
      { id: "cat-c", name: "C", maxPoints: 4 },
      { id: "cat-a", name: "A", maxPoints: 4 },
      { id: "cat-b", name: "B", maxPoints: 4 },
    ]);

    expect(plan.creates).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.updates).toEqual([
      { id: "cat-c", name: "C", maxPoints: 4, ordinal: 0 },
      { id: "cat-a", name: "A", maxPoints: 4, ordinal: 1 },
      { id: "cat-b", name: "B", maxPoints: 4, ordinal: 2 },
    ]);
  });

  it("creates only the added category and keeps the rest", () => {
    const plan = planInterviewRubricSave(existing, [
      { id: "cat-a", name: "A", maxPoints: 4 },
      { id: "cat-b", name: "B", maxPoints: 4 },
      { id: "cat-c", name: "C", maxPoints: 4 },
      { name: "New one", maxPoints: 5 },
    ]);

    expect(plan.updates).toHaveLength(3);
    expect(plan.creates).toEqual([{ name: "New one", maxPoints: 5, ordinal: 3 }]);
    expect(plan.deleteIds).toEqual([]);
  });

  it("deletes only the removed category", () => {
    const plan = planInterviewRubricSave(existing, [
      { id: "cat-a", name: "A", maxPoints: 4 },
      { id: "cat-c", name: "C", maxPoints: 4 },
    ]);

    expect(plan.updates.map((u) => u.id)).toEqual(["cat-a", "cat-c"]);
    expect(plan.deleteIds).toEqual(["cat-b"]);
  });

  it("treats an id the instance does not own as a create", () => {
    // Stops a stale or tampered payload adopting another instance's category.
    const plan = planInterviewRubricSave(existing, [
      { id: "someone-elses", name: "A", maxPoints: 4 },
    ]);

    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([{ name: "A", maxPoints: 4, ordinal: 0 }]);
    expect(plan.deleteIds).toEqual(existing);
  });

  it("honours a repeated id once and creates the second", () => {
    // Two updates to one row would leave one submitted category unsaved.
    const plan = planInterviewRubricSave(existing, [
      { id: "cat-a", name: "First", maxPoints: 4 },
      { id: "cat-a", name: "Second", maxPoints: 4 },
    ]);

    expect(plan.updates).toEqual([{ id: "cat-a", name: "First", maxPoints: 4, ordinal: 0 }]);
    expect(plan.creates).toEqual([{ name: "Second", maxPoints: 4, ordinal: 1 }]);
  });

  it("starts from nothing on a first save", () => {
    const plan = planInterviewRubricSave([], [{ name: "Only", maxPoints: 4 }]);
    expect(plan).toEqual({
      updates: [],
      creates: [{ name: "Only", maxPoints: 4, ordinal: 0 }],
      deleteIds: [],
    });
  });

  it("trims names, as the save used to", () => {
    const plan = planInterviewRubricSave(["cat-a"], [{ id: "cat-a", name: "  Fit  ", maxPoints: 4 }]);
    expect(plan.updates[0].name).toBe("Fit");
  });
});
