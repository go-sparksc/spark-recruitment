// FR-19's demographic funnel. Pure — no database, no Prisma client.
//
// "Demographic breakdown of the Sparklet class against each preceding stage,
// replacing the manual `Overall Stats` sheet."
//
// **Every number here comes from `lib/demographics.ts`.** §10.7 is explicit that
// the checked predicate and the 1/n weighting live in exactly one place, because
// every demographic number in FR-11 and FR-19 rests on them and two copies would
// drift apart silently. `tallySelections` was written with this screen in mind —
// its own docstring says so — and takes selections rather than applicants
// precisely so this file can reuse it without arriving with the same shaped
// inputs.
//
// What this module adds is the *cohort* dimension: the same breakdown computed
// four times over four nested populations, plus the share of each cohort, which
// is the only way a reader can compare 7 Sparklets against 158 applicants
// without doing arithmetic in their head.

import { ApplicantStatus, Round } from "@/generated/prisma/enums";
import {
  applicantDemographics,
  columnLabels,
  tallySelections,
  type DemographicColumn,
} from "@/lib/demographics";
import type { ApplicantData } from "@/lib/field-groups";

export interface FunnelApplicant {
  id: string;
  data: ApplicantData;
  stageReached: Round;
  status: ApplicantStatus;
}

export type CohortKey = "ALL" | "FIRST_ROUND" | "SECOND_ROUND" | "SPARKLET";

/// The four populations, outermost first.
///
/// **Nested by construction**: every Sparklet reached the second round, every
/// second-round applicant reached the first, and every first-round applicant was
/// imported. That is what makes reading across a row meaningful — the cohorts
/// are stages of one funnel rather than four unrelated groups.
///
/// `FIRST_ROUND` is `stageReached != WRITTEN` rather than `== FIRST_ROUND`,
/// because `stageReached` records how far someone **got**: an applicant who
/// reached the second round has `SECOND_ROUND` on that column and would vanish
/// from the first-round cohort under an equality test. The same reading FR-13's
/// scoping already uses.
export const FUNNEL_COHORTS: readonly { key: CohortKey; label: string }[] = [
  { key: "ALL", label: "Applied" },
  { key: "FIRST_ROUND", label: "First round" },
  { key: "SECOND_ROUND", label: "Second round" },
  { key: "SPARKLET", label: "Sparklets" },
];

export function isInCohort(applicant: FunnelApplicant, cohort: CohortKey): boolean {
  switch (cohort) {
    case "ALL":
      return true;
    case "FIRST_ROUND":
      return applicant.stageReached !== Round.WRITTEN;
    case "SECOND_ROUND":
      return applicant.stageReached === Round.SECOND_ROUND;
    case "SPARKLET":
      // Read from `status`, not from a pass row. An applicant an admin resolves
      // by hand after the round closes is a Sparklet too, and FR-17 is explicit
      // that a pass row records what happened *in that pass* rather than what
      // the applicant is now. Same reading `loadFinalClassCsv` takes.
      return applicant.status === ApplicantStatus.SPARKLET;
  }
}

/// One option, in one cohort.
export interface FunnelCell {
  /// §10.7's `1/n`. Sums, across every row of a column, to the cohort size.
  weighted: number;
  /// How many applicants selected this at all. Sums to more than the cohort
  /// size when people select several, which is why `weighted` exists beside it.
  headcount: number;
  /// `weighted / cohortSize`, or null for an empty cohort.
  ///
  /// **This is what makes the funnel readable**, and it is the whole reason the
  /// screen is not four columns of raw counts: 2 of 7 Sparklets and 30 of 158
  /// applicants are the same proportion and look nothing alike. Derived from
  /// `weighted` rather than `headcount` so the column sums to 100%.
  share: number | null;
}

export interface FunnelRow {
  label: string;
  cells: Record<CohortKey, FunnelCell>;
}

export interface FunnelColumn {
  /// The group id for a grouped question, the field id for an ungrouped one.
  key: string;
  label: string;
  rows: FunnelRow[];
  /// Free-text write-ins from the **Sparklet class** — the population this
  /// breakdown is about. §10.7: they are a real answer the tally cannot read,
  /// which is why their author sits in "Not specified" and why the text is still
  /// worth showing rather than discarding.
  sparkletWriteIns: string[];
}

export interface Funnel {
  /// How many applicants each cohort holds, for the column headers and for the
  /// invariant below.
  cohortSizes: Record<CohortKey, number>;
  columns: FunnelColumn[];
}

const EMPTY_SIZES: Record<CohortKey, number> = {
  ALL: 0,
  FIRST_ROUND: 0,
  SECOND_ROUND: 0,
  SPARKLET: 0,
};

/// The whole breakdown: every demographic column, four cohorts wide.
///
/// **The invariant worth stating, because §10.7 rests on it:** within one column
/// and one cohort, the weighted values sum to that cohort's size — not to the
/// number of people who answered. The `NOT_SPECIFIED` bucket is what buys that,
/// and `tallySelections` adds it; nothing here needs to.
export function buildFunnel(
  applicants: readonly FunnelApplicant[],
  columns: readonly DemographicColumn[],
): Funnel {
  const cohortSizes = { ...EMPTY_SIZES };
  const membersByCohort = {} as Record<CohortKey, FunnelApplicant[]>;

  for (const { key } of FUNNEL_COHORTS) {
    const members = applicants.filter((applicant) => isInCohort(applicant, key));
    membersByCohort[key] = members;
    cohortSizes[key] = members.length;
  }

  const built = columns.map((column) => {
    const labels = columnLabels(column);

    // One tally per cohort, each over the same column, so a row can be read
    // across. Rows are keyed by label rather than by index: `tallySelections`
    // appends observed-but-undeclared labels (an ungrouped field's values are
    // data rather than configuration) and the "Not specified" bucket only when
    // somebody lands in it, so two cohorts can legitimately produce different
    // row sets for one column.
    const byCohort = {} as Record<CohortKey, Map<string, { weighted: number; headcount: number }>>;
    const order: string[] = [];

    for (const { key } of FUNNEL_COHORTS) {
      const selections = membersByCohort[key].map(
        (applicant) => applicantDemographics(applicant.data, [column])[column.key].selected,
      );
      const tallies = tallySelections(selections, labels);

      byCohort[key] = new Map(
        tallies.map((tally) => [tally.label, { weighted: tally.weighted, headcount: tally.headcount }]),
      );
      for (const tally of tallies) {
        if (!order.includes(tally.label)) order.push(tally.label);
      }
    }

    const rows: FunnelRow[] = order.map((label) => {
      const cells = {} as Record<CohortKey, FunnelCell>;
      for (const { key } of FUNNEL_COHORTS) {
        const found = byCohort[key].get(label) ?? { weighted: 0, headcount: 0 };
        const size = cohortSizes[key];
        cells[key] = {
          weighted: found.weighted,
          headcount: found.headcount,
          share: size === 0 ? null : found.weighted / size,
        };
      }
      return { label, cells };
    });

    const sparkletWriteIns = membersByCohort.SPARKLET.map(
      (applicant) => applicantDemographics(applicant.data, [column])[column.key].writeIn,
    ).filter((text) => text.trim() !== "");

    return { key: column.key, label: column.label, rows, sparkletWriteIns };
  });

  return { cohortSizes, columns: built };
}

/// `0.125` → `"12.5%"`. An em-dash for an empty cohort, which is not zero — a
/// stage nobody reached has no composition rather than a composition of nothing.
export function formatShare(share: number | null): string {
  return share === null ? "—" : `${(share * 100).toFixed(1)}%`;
}

/// §10.7: "Display one decimal place alongside a raw headcount — 'East Asian:
/// 12.5 weighted / 18 checked' — since a panel showing fractional people with no
/// explanation will read as a bug to a successor."
export function formatWeighted(weighted: number): string {
  return weighted.toFixed(1);
}
