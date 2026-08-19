import { describe, expect, it } from "vitest";

import {
  MAX_CATEGORIES,
  MAX_DESCRIPTION_LENGTH,
  rubricRange,
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

describe("category descriptions — PRD decision 32", () => {
  it("accepts a category with no description at all", () => {
    // FR-4 makes it optional. An admin mid-setup must not be blocked by it, and
    // a cycle that briefs reviewers elsewhere is entitled to leave it empty.
    expect(validateRubric([cat({ name: "Drive" })])).toEqual([]);
  });

  it("accepts an explicitly null or empty description", () => {
    expect(validateRubric([cat({ name: "Drive", description: null })])).toEqual([]);
    expect(validateRubric([cat({ name: "Drive", description: "" })])).toEqual([]);
  });

  it("accepts a description at the limit", () => {
    const atLimit = "x".repeat(MAX_DESCRIPTION_LENGTH);
    expect(validateRubric([cat({ name: "Drive", description: atLimit })])).toEqual([]);
  });

  it("rejects one character over the limit, and says why it matters", () => {
    // The limit is not arbitrary tidiness: this renders inside a card that has
    // to share a phone screen with the score input it explains.
    const tooLong = "x".repeat(MAX_DESCRIPTION_LENGTH + 1);
    const errors = validateRubric([cat({ name: "Drive", description: tooLong })]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Category 1's description is over/);
    expect(errors[0]).toMatch(/phone/);
  });

  it("names the offending category by position", () => {
    const errors = validateRubric([
      cat({ name: "A" }),
      cat({ name: "B", description: "x".repeat(MAX_DESCRIPTION_LENGTH + 1) }),
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
