import { describe, expect, it } from "vitest";

import { MAX_CATEGORIES, rubricTotal, validateRubric } from "@/lib/rubric";

const ok = [
  { name: "Written quality", maxPoints: 5 },
  { name: "Initiative", maxPoints: 5 },
];

describe("validateRubric", () => {
  it("accepts a well-formed rubric", () => {
    expect(validateRubric(ok)).toEqual([]);
  });

  it("does not assume four categories or any particular scale", () => {
    // Goal 5: reconfigurable between cycles. S26 used four; nothing may hardcode it.
    expect(validateRubric([{ name: "Only one", maxPoints: 100 }])).toEqual([]);
    expect(
      validateRubric(Array.from({ length: 12 }, (_, i) => ({ name: `C${i}`, maxPoints: 3 }))),
    ).toEqual([]);
  });

  it("rejects an empty rubric", () => {
    expect(validateRubric([])).toEqual(["A rubric needs at least one category."]);
  });

  it("rejects a nameless category by position", () => {
    const errors = validateRubric([ok[0], { name: "   ", maxPoints: 5 }]);
    expect(errors).toContain("Category 2 has no name.");
  });

  it("rejects points below 1, above the ceiling, and non-integers", () => {
    expect(validateRubric([{ name: "A", maxPoints: 0 }]).join(" ")).toMatch(/at least 1 point/);
    expect(validateRubric([{ name: "A", maxPoints: -3 }]).join(" ")).toMatch(/at least 1 point/);
    expect(validateRubric([{ name: "A", maxPoints: 5000 }]).join(" ")).toMatch(/capped at/);
    expect(validateRubric([{ name: "A", maxPoints: 2.5 }]).join(" ")).toMatch(/whole number/);
    expect(validateRubric([{ name: "A", maxPoints: Number.NaN }]).join(" ")).toMatch(/whole number/);
  });

  it("rejects duplicate names case-insensitively", () => {
    // Not a database error, but two categories called "Fit" make a reviewer's
    // screen ambiguous and FR-10's breakdown unreadable.
    const errors = validateRubric([
      { name: "Fit", maxPoints: 5 },
      { name: "  fit  ", maxPoints: 5 },
    ]);
    expect(errors.join(" ")).toMatch(/More than one category is called/);
  });

  it("does not report two blank names as duplicates of each other", () => {
    // They already each have their own "has no name" error; saying they collide
    // as well is noise.
    const errors = validateRubric([
      { name: "", maxPoints: 5 },
      { name: "", maxPoints: 5 },
    ]);
    expect(errors.filter((e) => e.includes("More than one"))).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it("rejects an implausible number of categories", () => {
    const many = Array.from({ length: MAX_CATEGORIES + 1 }, (_, i) => ({
      name: `C${i}`,
      maxPoints: 1,
    }));
    expect(validateRubric(many).join(" ")).toMatch(/almost certainly a typo/);
  });
});

describe("rubricTotal", () => {
  it("sums the maximum a single reviewer can award", () => {
    expect(rubricTotal(ok)).toBe(10);
    expect(rubricTotal([])).toBe(0);
  });

  it("ignores a non-numeric entry rather than returning NaN", () => {
    // The form can hold a half-typed value; a total reading NaN looks broken.
    expect(rubricTotal([{ name: "A", maxPoints: Number.NaN }, { name: "B", maxPoints: 4 }])).toBe(4);
  });
});
