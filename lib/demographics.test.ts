import { describe, expect, it } from "vitest";

import { FieldCategory, FieldGroupRole } from "@/generated/prisma/enums";
import {
  NOT_SPECIFIED,
  applicantDemographics,
  columnLabels,
  demographicColumns,
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
    visibleToWrittenReviewer: null,
    visibleToFirstRoundReviewer: null,
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
    visibleToWrittenReviewer: null,
    visibleToFirstRoundReviewer: null,
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
