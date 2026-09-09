import { describe, expect, it } from "vitest";

import { FieldCategory, FieldGroupRole } from "@/generated/prisma/enums";
import {
  NOT_SPECIFIED,
  applicantDemographics,
  columnLabels,
  demographicColumns,
  formatTally,
  tallySelections,
  type DemographicField,
  type DemographicGroup,
} from "@/lib/demographics";

// ---------------------------------------------------------------------------
// §10.7's fractional counting
// ---------------------------------------------------------------------------

const ETHNICITIES = ["East Asian", "South Asian", "White", "Black"];

describe("tallySelections", () => {
  it("gives a single-selector a whole person", () => {
    const rows = tallySelections([["White"]], ETHNICITIES);
    expect(rows.find((r) => r.label === "White")).toEqual({
      label: "White",
      weighted: 1,
      headcount: 1,
    });
  });

  it("splits a two-box applicant into halves", () => {
    // §10.7's worked example: "An applicant checking both East Asian and White".
    const rows = tallySelections([["East Asian", "White"]], ETHNICITIES);
    expect(rows.find((r) => r.label === "East Asian")?.weighted).toBe(0.5);
    expect(rows.find((r) => r.label === "White")?.weighted).toBe(0.5);
  });

  it("splits a three-box applicant into thirds", () => {
    const rows = tallySelections([["East Asian", "White", "Black"]], ETHNICITIES);
    for (const label of ["East Asian", "White", "Black"]) {
      expect(rows.find((r) => r.label === label)?.weighted).toBeCloseTo(1 / 3, 10);
    }
  });

  it("counts a non-responder as a whole person in Not specified", () => {
    const rows = tallySelections([[]], ETHNICITIES);
    expect(rows.find((r) => r.label === NOT_SPECIFIED)).toEqual({
      label: NOT_SPECIFIED,
      weighted: 1,
      headcount: 1,
    });
  });

  it("THE INVARIANT: weighted totals sum to the applicant count", () => {
    // §10.7 states this as the property the Not specified bucket exists to
    // preserve. It only fails when single-selectors, multi-selectors and
    // non-responders are all present, so all three are here.
    const selections = [
      ["White"],
      ["East Asian", "White"],
      ["East Asian", "South Asian", "Black"],
      [],
      ["Black"],
      [],
      ["South Asian", "Black"],
    ];
    const rows = tallySelections(selections, ETHNICITIES);
    const total = rows.reduce((sum, row) => sum + row.weighted, 0);

    expect(total).toBeCloseTo(selections.length, 10);
  });

  it("does not let the weighted column sum to the responder count instead", () => {
    // The specific failure §10.7 warns about: drop the bucket and two people
    // vanish. Asserted as a distinct number so a regression cannot pass by
    // being merely close.
    const selections = [["White"], [], []];
    const total = tallySelections(selections, ETHNICITIES).reduce((s, r) => s + r.weighted, 0);
    expect(total).toBeCloseTo(3, 10);
    expect(total).not.toBeCloseTo(1, 10);
  });

  it("keeps the headcount as whole people, above the weighted total", () => {
    // "East Asian: 12.5 weighted / 18 checked" — two different questions, and
    // the reason both columns are shown.
    const rows = tallySelections(
      [
        ["East Asian"],
        ["East Asian", "White"],
        ["East Asian", "White", "Black"],
      ],
      ETHNICITIES,
    );
    const eastAsian = rows.find((r) => r.label === "East Asian");
    expect(eastAsian?.headcount).toBe(3);
    expect(eastAsian?.weighted).toBeCloseTo(1 + 0.5 + 1 / 3, 10);
  });

  it("keeps a zero row visible so two cohorts can be compared", () => {
    // A breakdown that silently omits unselected options makes the selection
    // panel and the pool panel different shapes, which is exactly the
    // comparison FR-11 exists to show.
    const rows = tallySelections([["White"]], ETHNICITIES);
    expect(rows.map((r) => r.label)).toEqual(ETHNICITIES);
    expect(rows.find((r) => r.label === "Black")).toEqual({
      label: "Black",
      weighted: 0,
      headcount: 0,
    });
  });

  it("omits the Not specified row when nobody is in it", () => {
    const rows = tallySelections([["White"]], ETHNICITIES);
    expect(rows.some((r) => r.label === NOT_SPECIFIED)).toBe(false);
  });

  it("puts Not specified last, after any undeclared label", () => {
    const rows = tallySelections([["Martian"], []], ETHNICITIES);
    expect(rows.at(-1)?.label).toBe(NOT_SPECIFIED);
    expect(rows.map((r) => r.label)).toContain("Martian");
  });

  it("does not let a repeated label take more than one person's share", () => {
    // Unreachable through one-hot columns, which is why it is worth not
    // depending on: a duplicate would take 2/n and break the invariant.
    const rows = tallySelections([["White", "White"]], ETHNICITIES);
    expect(rows.find((r) => r.label === "White")?.weighted).toBe(1);
    expect(rows.reduce((sum, r) => sum + r.weighted, 0)).toBeCloseTo(1, 10);
  });

  it("returns only zero rows for an empty cohort", () => {
    // The selection panel's opening state: nothing checked yet.
    const rows = tallySelections([], ETHNICITIES);
    expect(rows.every((r) => r.weighted === 0 && r.headcount === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Columns and per-applicant answers
// ---------------------------------------------------------------------------

function field(overrides: Partial<DemographicField> = {}): DemographicField {
  return {
    id: "f1",
    displayName: "A column",
    ordinal: 0,
    category: FieldCategory.DEMOGRAPHIC,
    isIncluded: true,
    groupId: null,
    groupRole: null,
    isReviewerVisible: null,
    ...overrides,
  };
}

function group(overrides: Partial<DemographicGroup> = {}): DemographicGroup {
  return {
    id: "g1",
    displayName: "Ethnicity",
    ordinal: 0,
    category: FieldCategory.DEMOGRAPHIC,
    isIncluded: true,
    isReviewerVisible: null,
    // The ethnicity group this fixture stands for is the multi-select one §10.7
    // is written about, so that is the honest default here.
    isMultiSelect: true,
    ...overrides,
  };
}

const ETHNICITY_GROUP = group();
const ONE_HOT = [
  field({ id: "e1", displayName: "East Asian", ordinal: 1, groupId: "g1", groupRole: FieldGroupRole.OPTION }),
  field({ id: "e2", displayName: "White", ordinal: 2, groupId: "g1", groupRole: FieldGroupRole.OPTION }),
  field({
    id: "e3",
    displayName: "Specify your ethnicity",
    ordinal: 3,
    groupId: "g1",
    groupRole: FieldGroupRole.FREE_TEXT,
  }),
];

describe("demographicColumns", () => {
  it("collapses a group to one column, not one per one-hot option", () => {
    // Ten ethnicity columns inline would make the ranked table unreadable, and
    // the group is the unit §5 puts category and inclusion on.
    const columns = demographicColumns(ONE_HOT, [ETHNICITY_GROUP]);
    expect(columns).toHaveLength(1);
    expect(columns[0].label).toBe("Ethnicity");
    expect(columns[0].members).toHaveLength(3);
  });

  it("gives an ungrouped demographic field its own column", () => {
    const pronouns = field({ id: "p", displayName: "Pronouns", ordinal: 9 });
    const columns = demographicColumns([...ONE_HOT, pronouns], [ETHNICITY_GROUP]);
    expect(columns.map((c) => c.label)).toEqual(["Ethnicity", "Pronouns"]);
    expect(columns[1].members).toBeNull();
  });

  it("omits RESPONSE and OTHER fields", () => {
    const essay = field({ id: "r", displayName: "Why Spark", category: FieldCategory.RESPONSE });
    expect(demographicColumns([essay], [])).toEqual([]);
  });

  it("omits an excluded group, following resolveField rather than re-deriving", () => {
    const excluded = group({ isIncluded: false });
    expect(demographicColumns(ONE_HOT, [excluded])).toEqual([]);
  });

  it("hides demographics from a written reviewer, per §6", () => {
    // Not a surface that exists today — FR-10 is admin-only — but the helper
    // takes a viewer precisely so it cannot become one by accident.
    expect(demographicColumns(ONE_HOT, [ETHNICITY_GROUP], "WRITTEN_REVIEWER")).toEqual([]);
  });
});

describe("applicantDemographics", () => {
  const columns = demographicColumns(ONE_HOT, [ETHNICITY_GROUP]);

  it("returns the checked option labels", () => {
    const cells = applicantDemographics({ e1: "East Asian", e2: "" }, columns);
    expect(cells.g1.selected).toEqual(["East Asian"]);
  });

  it("treats an empty, whitespace-only or absent cell as unchecked", () => {
    const cells = applicantDemographics({ e1: "   ", e2: "" }, columns);
    expect(cells.g1.selected).toEqual([]);
  });

  it("puts a write-in author in Not specified but still surfaces their text", () => {
    // §10.7: they have given a real answer the count cannot read. Both halves
    // matter — counted as unspecified, and shown rather than discarded.
    const cells = applicantDemographics({ e3: "Chaldean" }, columns);
    expect(cells.g1.selected).toEqual([]);
    expect(cells.g1.writeIn).toBe("Chaldean");
    expect(tallySelections([cells.g1.selected], columnLabels(columns[0])).at(-1)?.label).toBe(
      NOT_SPECIFIED,
    );
  });

  it("treats an ungrouped field as the n = 1 case", () => {
    const pronouns = field({ id: "p", displayName: "Pronouns", ordinal: 9 });
    const withPronouns = demographicColumns([...ONE_HOT, pronouns], [ETHNICITY_GROUP]);
    const cells = applicantDemographics({ p: "they/them" }, withPronouns);
    expect(cells.p.selected).toEqual(["they/them"]);
  });
});

describe("columnLabels", () => {
  it("lists the OPTION members and excludes the write-in", () => {
    // Being a member is what lets FR-19 find the write-in; being FREE_TEXT is
    // what keeps it out of the count.
    const columns = demographicColumns(ONE_HOT, [ETHNICITY_GROUP]);
    expect(columnLabels(columns[0])).toEqual(["East Asian", "White"]);
  });
});

describe("formatTally — PRD decision 118", () => {
  /// The worked example from the decision: two applicants who each ticked two
  /// boxes contribute 0.5 apiece, so the weighted total is 1.0 against a pool of
  /// 9, ticked by 2 people.
  it("renders a multi-select row as weighted/pool (headcount)", () => {
    expect(formatTally({ label: "East Asian", weighted: 1, headcount: 2 }, 9, true)).toBe(
      "1.0/9 (2)",
    );
  });

  it("keeps one decimal, because that is what a 1/n weighting produces", () => {
    // 12.5 of 150, ticked by 18 — the example §10.7 itself uses. Rounding to a
    // whole person would stop the column summing to the pool.
    expect(formatTally({ label: "East Asian", weighted: 12.5, headcount: 18 }, 150, true)).toBe(
      "12.5/150 (18)",
    );
  });

  /// **Not a special case — the general rule where two of its three numbers
  /// coincide.** A single-select column cannot be multi-selected, so n is always
  /// 1, weighted equals headcount, and the bracketed number would repeat the
  /// numerator.
  it("renders a single-select row as applicable/total, with no bracket", () => {
    expect(formatTally({ label: "Yes", weighted: 33, headcount: 33 }, 150, false)).toBe("33/150");
    expect(formatTally({ label: "No", weighted: 117, headcount: 117 }, 150, false)).toBe("117/150");
  });

  it("renders a zero row rather than hiding it", () => {
    // `tallySelections` keeps zero rows deliberately — "nobody selected this" is
    // a finding, and two cohorts have to line up side by side.
    expect(formatTally({ label: "Pacific Islander", weighted: 0, headcount: 0 }, 9, true)).toBe(
      "0.0/9 (0)",
    );
    expect(formatTally({ label: "Yes", weighted: 0, headcount: 0 }, 150, false)).toBe("0/150");
  });

  /// The empty-selection case the panel renders before anyone ticks a checkbox.
  /// A zero denominator is not an error state here; it is the honest reading of
  /// "nothing is selected yet", and the panel is always rendered per FR-11.
  it("survives a pool of zero", () => {
    expect(formatTally({ label: "East Asian", weighted: 0, headcount: 0 }, 0, true)).toBe(
      "0.0/0 (0)",
    );
  });

  /// **The invariant, restated through the formatter.** §10.7 says the weighted
  /// column sums to the size of the set counted — so the numerators of a whole
  /// breakdown, denominators included, have to add back up to the denominator.
  /// Asserted over a set containing a single-selector, a multi-selector and a
  /// non-responder together, because it only fails when all three are present.
  it("prints numerators that sum to the denominator it prints", () => {
    const rows = tallySelections(
      [["East Asian"], ["East Asian", "White"], []],
      ["East Asian", "White"],
    );

    const printed = rows.map((row) => formatTally(row, 3, true));
    const numerators = printed.map((text) => Number(text.split("/")[0]));

    expect(numerators.reduce((sum, value) => sum + value, 0)).toBeCloseTo(3, 10);
    expect(printed.every((text) => text.endsWith("(1)") || text.includes("/3 "))).toBe(true);
  });
});
