import { describe, expect, it } from "vitest";

import { FieldGroupRole } from "@/generated/prisma/enums";
import {
  checkedCount,
  checkedOptions,
  freeTextValues,
  isChecked,
  type GroupMember,
} from "@/lib/field-groups";

// The ethnicity group as the seed builds it: ten OPTION members and one
// FREE_TEXT write-in. Ids are stand-ins; nothing here touches a database.
const OPTION_LABELS = [
  "American Indian/Alaskan Native/First Nations",
  "Black",
  "Black or African American",
  "East Asian",
  "Hispanic/LatinX",
  "Middle Eastern/North African",
  "Native Hawaiian/Pacific Islander",
  "South Asian",
  "Southeast Asian",
  "White",
];

const members: GroupMember[] = [
  ...OPTION_LABELS.map((label, i) => ({
    id: `opt${i}`,
    displayName: label,
    groupRole: FieldGroupRole.OPTION,
  })),
  { id: "writein", displayName: "Ethnicity (self-described)", groupRole: FieldGroupRole.FREE_TEXT },
];

const idOf = (label: string) => `opt${OPTION_LABELS.indexOf(label)}`;

/// One-hot cells hold the column's own label when checked, "" when not.
function row(checked: string[], writeIn = ""): Record<string, unknown> {
  const data: Record<string, unknown> = { writein: writeIn };
  for (const label of OPTION_LABELS) data[idOf(label)] = checked.includes(label) ? label : "";
  return data;
}

describe("isChecked", () => {
  it("treats a non-empty string as checked", () => {
    expect(isChecked("East Asian")).toBe(true);
  });

  it("treats empty string, null, undefined and a missing key as unchecked", () => {
    // PRD §10.7 names all three explicitly, so all three are asserted.
    expect(isChecked("")).toBe(false);
    expect(isChecked(null)).toBe(false);
    expect(isChecked(undefined)).toBe(false);
    expect(isChecked(({} as Record<string, unknown>).absent)).toBe(false);
  });

  it("treats whitespace-only as unchecked", () => {
    // A cell holding " " is not an answer. Counting it would inflate every
    // breakdown built on this predicate.
    expect(isChecked("   ")).toBe(false);
    expect(isChecked("\n\t")).toBe(false);
  });

  it("does not treat a non-string as checked", () => {
    expect(isChecked(0)).toBe(false);
    expect(isChecked(1)).toBe(false);
    expect(isChecked(true)).toBe(false);
  });
});

describe("checkedOptions — the fixture's deliberate cases", () => {
  // Values mirror prisma/fixtures/s26-shape.csv. Reading the file itself needs
  // the CSV parser that arrives in Slice 2; these encode the same three rows so
  // the predicate is pinned now rather than later.

  it("Rowan Fixture: three boxes and a write-in gives n = 3", () => {
    const data = row(["Black", "Hispanic/LatinX", "White"], "Also Cherokee Nation (synthetic write-in)");

    expect(checkedCount(data, members)).toBe(3);
    expect(checkedOptions(data, members).map((m) => m.displayName)).toEqual([
      "Black",
      "Hispanic/LatinX",
      "White",
    ]);
  });

  it("Pax Writein: no boxes but a write-in still gives n = 0", () => {
    // The whole point of groupRole. A real answer the count cannot read, so the
    // applicant lands in "Not specified" while the text remains displayable.
    const data = row([], "Afro-Caribbean (synthetic write-in)");

    expect(checkedCount(data, members)).toBe(0);
    expect(freeTextValues(data, members)).toEqual(["Afro-Caribbean (synthetic write-in)"]);
  });

  it("Tobin Blankethnicity: no boxes and no write-in also gives n = 0", () => {
    const data = row([]);

    expect(checkedCount(data, members)).toBe(0);
    expect(freeTextValues(data, members)).toEqual([]);
  });

  it("distinguishes Black from Black or African American", () => {
    // Strict-prefix trap: any startsWith/includes matching maps one onto the
    // other. Exercised in all three fixture combinations.
    expect(checkedOptions(row(["Black"]), members).map((m) => m.displayName)).toEqual(["Black"]);
    expect(
      checkedOptions(row(["Black or African American"]), members).map((m) => m.displayName),
    ).toEqual(["Black or African American"]);
    expect(
      checkedOptions(row(["Black", "Black or African American"]), members).map((m) => m.displayName),
    ).toEqual(["Black", "Black or African American"]);
  });

  it("never counts a FREE_TEXT member however full it is", () => {
    const data = row(["White"], "a very long written answer");

    expect(checkedCount(data, members)).toBe(1);
    expect(checkedOptions(data, members).some((m) => m.groupRole === FieldGroupRole.FREE_TEXT)).toBe(
      false,
    );
  });
});

describe("freeTextValues", () => {
  it("trims and drops blanks", () => {
    expect(freeTextValues({ writein: "  Afro-Caribbean  " }, members)).toEqual(["Afro-Caribbean"]);
    expect(freeTextValues({ writein: "   " }, members)).toEqual([]);
    expect(freeTextValues({}, members)).toEqual([]);
  });
});
