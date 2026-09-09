// FR-19's funnel. The arithmetic itself is `lib/demographics.ts`'s and is tested
// there; what these cases pin is the cohort dimension this file adds.
//
// The two that earn their keep:
//
//   - **The cohorts are nested.** `FIRST_ROUND` reads `stageReached != WRITTEN`
//     rather than `== FIRST_ROUND`, because `stageReached` records how far
//     someone GOT — so an equality test silently drops every applicant who went
//     further, and the funnel narrows in the wrong place while every number
//     still looks plausible.
//   - **§10.7's invariant survives the cohort split.** Weighted values sum to
//     the cohort size, not to the number who answered, in every cohort — which
//     only fails when single-selectors, multi-selectors and non-responders are
//     all present at once.

import { describe, expect, it } from "vitest";

import { ApplicantStatus, FieldGroupRole, Round } from "@/generated/prisma/enums";
import type { DemographicColumn } from "@/lib/demographics";
import {
  buildFunnel,
  formatShare,
  formatWeighted,
  isInCohort,
  FUNNEL_COHORTS,
  type FunnelApplicant,
} from "@/lib/funnel";

/// A one-hot ethnicity group: two options and a write-in, the shape §10.7 is
/// written about.
const ethnicity: DemographicColumn = {
  key: "grp",
  label: "Ethnicity",
  isMultiSelect: true,
  members: [
    { id: "east-asian", displayName: "East Asian", groupRole: FieldGroupRole.OPTION },
    { id: "white", displayName: "White", groupRole: FieldGroupRole.OPTION },
    { id: "write-in", displayName: "Specify", groupRole: FieldGroupRole.FREE_TEXT },
  ],
};

function applicant(overrides: Partial<FunnelApplicant> = {}): FunnelApplicant {
  return {
    id: "a",
    data: {},
    stageReached: Round.WRITTEN,
    status: ApplicantStatus.REJECTED,
    ...overrides,
  };
}

describe("isInCohort", () => {
  it("counts an applicant who went further as having reached the first round", () => {
    // The regression. `stageReached` is how far they GOT, so a second-round
    // applicant is also a first-round one.
    const secondRounder = applicant({ stageReached: Round.SECOND_ROUND });
    expect(isInCohort(secondRounder, "FIRST_ROUND")).toBe(true);
    expect(isInCohort(secondRounder, "SECOND_ROUND")).toBe(true);
    expect(isInCohort(secondRounder, "ALL")).toBe(true);
  });

  it("excludes a written-round rejection from every later cohort", () => {
    const rejected = applicant({ stageReached: Round.WRITTEN });
    expect(isInCohort(rejected, "ALL")).toBe(true);
    expect(isInCohort(rejected, "FIRST_ROUND")).toBe(false);
    expect(isInCohort(rejected, "SECOND_ROUND")).toBe(false);
  });

  it("reads Sparklet from status, not from a pass row", () => {
    // An applicant an admin resolves after the round closes is a Sparklet too.
    const admitted = applicant({
      stageReached: Round.SECOND_ROUND,
      status: ApplicantStatus.SPARKLET,
    });
    expect(isInCohort(admitted, "SPARKLET")).toBe(true);
    expect(isInCohort(applicant({ status: ApplicantStatus.ACTIVE }), "SPARKLET")).toBe(false);
  });

  it("keeps the cohorts nested, so a row reads across", () => {
    const sparklet = applicant({
      stageReached: Round.SECOND_ROUND,
      status: ApplicantStatus.SPARKLET,
    });
    for (const { key } of FUNNEL_COHORTS) expect(isInCohort(sparklet, key), key).toBe(true);
  });
});

describe("buildFunnel", () => {
  /// Three applicants: one single-selector, one multi-selector, one who checked
  /// nothing. §10.7's invariant only fails when all three are present.
  const cohort: FunnelApplicant[] = [
    applicant({
      id: "single",
      data: { "east-asian": "East Asian" },
      stageReached: Round.SECOND_ROUND,
      status: ApplicantStatus.SPARKLET,
    }),
    applicant({
      id: "multi",
      data: { "east-asian": "East Asian", white: "White" },
      stageReached: Round.SECOND_ROUND,
      status: ApplicantStatus.REJECTED,
    }),
    applicant({ id: "silent", data: {}, stageReached: Round.WRITTEN }),
  ];

  it("sizes every cohort", () => {
    const funnel = buildFunnel(cohort, [ethnicity]);
    expect(funnel.cohortSizes).toEqual({
      ALL: 3,
      FIRST_ROUND: 2,
      SECOND_ROUND: 2,
      SPARKLET: 1,
    });
  });

  it("weights a multi-selector at 1/n in every cohort that holds them", () => {
    const funnel = buildFunnel(cohort, [ethnicity]);
    const rows = new Map(funnel.columns[0].rows.map((row) => [row.label, row]));

    // ALL: single gives 1 to East Asian, multi gives 0.5 to each.
    expect(rows.get("East Asian")!.cells.ALL.weighted).toBeCloseTo(1.5);
    expect(rows.get("White")!.cells.ALL.weighted).toBeCloseTo(0.5);
    expect(rows.get("East Asian")!.cells.ALL.headcount).toBe(2);
  });

  it("keeps §10.7's invariant in every cohort: weighted sums to the cohort size", () => {
    const funnel = buildFunnel(cohort, [ethnicity]);
    for (const { key } of FUNNEL_COHORTS) {
      const total = funnel.columns[0].rows.reduce((sum, row) => sum + row.cells[key].weighted, 0);
      expect(total, key).toBeCloseTo(funnel.cohortSizes[key]);
    }
  });

  it("puts a non-responder in Not specified as a whole person", () => {
    const funnel = buildFunnel(cohort, [ethnicity]);
    const notSpecified = funnel.columns[0].rows.find((row) => row.label === "Not specified");
    expect(notSpecified!.cells.ALL.weighted).toBeCloseTo(1);
    // They never reached the first round, so they are absent from that cohort.
    expect(notSpecified!.cells.FIRST_ROUND.weighted).toBeCloseTo(0);
  });

  it("computes share against the cohort, which is the point of the screen", () => {
    const funnel = buildFunnel(cohort, [ethnicity]);
    const eastAsian = funnel.columns[0].rows.find((row) => row.label === "East Asian")!;
    // 1.5 of 3 applied; 1 of 1 Sparklet.
    expect(eastAsian.cells.ALL.share).toBeCloseTo(0.5);
    expect(eastAsian.cells.SPARKLET.share).toBeCloseTo(1);
  });

  it("keeps a zero row visible so two cohorts can be compared side by side", () => {
    // "Nobody selected this" is a finding. A breakdown that omitted empty
    // options would make the columns different shapes.
    const funnel = buildFunnel(cohort, [ethnicity]);
    const white = funnel.columns[0].rows.find((row) => row.label === "White")!;
    expect(white.cells.SPARKLET.weighted).toBe(0);
    expect(white.cells.SPARKLET.headcount).toBe(0);
  });

  it("gives an empty cohort a null share rather than a zero one", () => {
    // A stage nobody reached has no composition, which is not a composition of
    // nothing — and 0% would read as "no East Asian Sparklets" rather than "no
    // Sparklets".
    const funnel = buildFunnel([applicant({ data: { white: "White" } })], [ethnicity]);
    expect(funnel.cohortSizes.SPARKLET).toBe(0);
    for (const row of funnel.columns[0].rows) expect(row.cells.SPARKLET.share).toBeNull();
  });

  it("surfaces the Sparklet class's write-ins and never counts them", () => {
    // §10.7: the free-text answer is real and the tally cannot read it, so its
    // author belongs in Not specified and the text is shown rather than dropped.
    const funnel = buildFunnel(
      [
        applicant({
          data: { "write-in": "Afro-Latina" },
          stageReached: Round.SECOND_ROUND,
          status: ApplicantStatus.SPARKLET,
        }),
      ],
      [ethnicity],
    );
    expect(funnel.columns[0].sparkletWriteIns).toEqual(["Afro-Latina"]);
    const notSpecified = funnel.columns[0].rows.find((row) => row.label === "Not specified")!;
    expect(notSpecified.cells.SPARKLET.weighted).toBeCloseTo(1);
  });

  it("handles an instance with no demographic columns at all", () => {
    const funnel = buildFunnel(cohort, []);
    expect(funnel.columns).toEqual([]);
    expect(funnel.cohortSizes.ALL).toBe(3);
  });
});

describe("formatting", () => {
  it("renders a share as one decimal percent", () => {
    expect(formatShare(0.125)).toBe("12.5%");
    expect(formatShare(1)).toBe("100.0%");
  });

  it("renders an empty cohort as an em-dash", () => {
    expect(formatShare(null)).toBe("—");
  });

  it("renders weighted people to one decimal, per §10.7", () => {
    expect(formatWeighted(12.5)).toBe("12.5");
    expect(formatWeighted(3)).toBe("3.0");
  });
});
