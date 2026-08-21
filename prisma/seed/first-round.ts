// The seed's written-round finalize, and the named cohort the FR-13 fixtures
// aim at.
//
// Two jobs, both in service of one thing: BUILD_PLAN's Phase 5 gate is "import a
// scores file where three names are deliberately wrong", and that needs a first
// round with applicants in it whose names a committed fixture file can name.
//
//   1. **Advance a cohort**, producing exactly the state `finalizeWritten`
//      produces — Decision rows at stage WRITTEN, stageReached FIRST_ROUND on
//      the advanced, REJECTED on the rest, and Instance.currentStage moved. Not
//      an approximation of it: if the seed's idea of "advanced" drifts from the
//      action's, every Phase 5 surface is developed against a state the
//      application cannot produce.
//   2. **Pin eight identities.** Applicant names come from an rng corpus, so a
//      committed fixture has nothing stable to aim at. These eight are appended
//      above the generated 150 and carry fixed names, which is what lets
//      prisma/fixtures/s26-1r-*.csv reference them by name and email.
//
// Pure — no Prisma client. seed.ts does the writing.

import { rankApplicants, reviewerAverage, scoreSummary } from "../../lib/results";
import type { ApplicantProfile } from "./applicants";

/// How many of the generated applicants advance on merit, on top of the pinned
/// cohort. Roughly a third, which is the shape of a real cycle and enough rows
/// to make the FR-15 ranking worth looking at.
export const FIRST_ROUND_ADVANCE_COUNT = 40;

/// The pinned identities, and what each one is *for*.
///
/// Every hazard the FR-13 cascade has to survive is represented by a real
/// applicant here, so the fixture rows have something to resolve to — or, in two
/// cases, deliberately fail to resolve to.
///
/// **Emails are @example.com, not @usc.edu like the generated 150.** The
/// generated addresses live only in a developer's database; these appear in a
/// committed CSV, and PRD §8 is unambiguous that nothing resembling a real USC
/// address enters the repo. example.com is RFC 2606's documentation domain, the
/// same choice prisma/fixtures/s26-shape.csv already makes. It also removes any
/// chance of colliding with a generated address, which is keyed on usc.edu.
export const RECONCILIATION_COHORT = [
  {
    firstName: "Cecilia",
    lastName: "Fang",
    email: "cecilia.fang@example.com",
    /// Tier 3, single candidate. The fixture row says "Cici Fang" — a nickname,
    /// scored 0.796 against the given name, and the case BUILD_PLAN names.
    purpose: "fuzzy match, single candidate",
  },
  {
    firstName: "Megan",
    lastName: "Woods",
    email: "megan.woods@example.com",
    /// Tier 3, ambiguous. With Maegan below, a "Meagan Woods" row clears the
    /// threshold against both and must queue rather than pick.
    purpose: "fuzzy match, ambiguous pair",
  },
  {
    firstName: "Maegan",
    lastName: "Woods",
    email: "maegan.woods@example.com",
    purpose: "fuzzy match, ambiguous pair",
  },
  {
    firstName: "Casey",
    lastName: "O'Brien",
    email: "casey.obrien@example.com",
    /// Tier 2 after normalization strips the apostrophe. Must NOT depend on the
    /// fuzzy threshold to absorb the punctuation.
    purpose: "apostrophe variance, resolves at tier 2",
  },
  {
    firstName: "Nia",
    lastName: "Chen",
    email: "nia.chen@example.com",
    /// The trap. A "Mia Chen" row differs at the given-name initial and must
    /// land in the unresolved queue, not on this applicant.
    purpose: "near-miss that must NOT match",
  },
  {
    firstName: "Jordan",
    lastName: "Lee",
    email: "jordan.lee@example.com",
    /// Tier 2 via the single-letter rule — the fixture writes "Jordan A. Lee".
    /// Also carries the decision 49 duplicate: two scores rows, same
    /// interviewer.
    purpose: "middle initial, and the decision 49 duplicate",
  },
  {
    firstName: "Priya",
    lastName: "Raman",
    email: "priya.raman@example.com",
    /// Tier 1 after normalization — the fixture pads and mixed-cases this
    /// address.
    purpose: "padded, mixed-case email",
  },
  {
    firstName: "Wren",
    lastName: "Ashford",
    email: "wren.ashford@example.com",
    /// Tier 2 with no email column value at all on the row.
    purpose: "name-only row",
  },
] as const;

/// Overwrite the identity of the last `RECONCILIATION_COHORT.length` profiles.
///
/// **The caller generates `150 + cohort.length` profiles and passes them all
/// here.** Generating the extra eight at the END of the rng sequence is what
/// keeps rows 1–150 byte-identical to what the seed produced before this
/// existed: every draw for the first 150 happens first and is unaffected by
/// anything after it. Existing ids, screenshots and `Applicant.data` keys
/// survive, which matters because `Applicant.data` is keyed by Field id and a
/// re-seed that moved them would invalidate every bookmark into the app.
///
/// Only identity is replaced. The essays, demographics and blank-rate behaviour
/// stay whatever the generator produced, so these eight are ordinary applicants
/// in every respect except being findable by name.
export function applyReconciliationCohort(profiles: ApplicantProfile[]): ApplicantProfile[] {
  const start = profiles.length - RECONCILIATION_COHORT.length;
  if (start < 0) {
    throw new Error(
      `Need at least ${RECONCILIATION_COHORT.length} profiles to pin, got ${profiles.length}.`,
    );
  }

  return profiles.map((profile, index) => {
    if (index < start) return profile;
    const pinned = RECONCILIATION_COHORT[index - start];
    return {
      ...profile,
      firstName: pinned.firstName,
      lastName: pinned.lastName,
      displayName: `${pinned.firstName} ${pinned.lastName}`,
      email: pinned.email,
    };
  });
}

export interface ScoredAssignment {
  applicantId: string;
  points: number[];
}

export interface AdvancementInput {
  applicants: { applicantId: string; sourceRowIndex: number }[];
  /// One entry per assignment that has any score at all.
  assignments: ScoredAssignment[];
  categoryCount: number;
  /// Always advance these, whatever they scored. The pinned cohort — the
  /// fixtures name them, so they have to be in the first-round pool for the
  /// gate to mean anything.
  alwaysAdvance: ReadonlySet<string>;
  advanceCount: number;
}

/// Who advances, ranked exactly the way FR-10 ranks and FR-11 selects.
///
/// Reuses `lib/results.ts` rather than sorting here, so the cohort the seed
/// produces is the cohort an admin clicking through the real screen would have
/// produced from the same scores. A second ranking rule living in the seed is a
/// second thing to keep in step, and it would drift silently — nothing renders
/// the seed's opinion anywhere it could be compared.
///
/// The pinned cohort is added on top of the merit list rather than displacing
/// it, so `advanceCount` still means what it says about the generated 150.
export function chooseFirstRoundCohort(input: AdvancementInput): Set<string> {
  const byApplicant = new Map<string, number[]>();
  for (const assignment of input.assignments) {
    const average = reviewerAverage(assignment.points, input.categoryCount);
    if (average === null) continue;
    byApplicant.set(assignment.applicantId, [
      ...(byApplicant.get(assignment.applicantId) ?? []),
      average,
    ]);
  }

  const ranked = rankApplicants(
    input.applicants.map((applicant) => ({
      applicantId: applicant.applicantId,
      sourceRowIndex: applicant.sourceRowIndex,
      ...scoreSummary(byApplicant.get(applicant.applicantId) ?? []),
    })),
  );

  const advanced = new Set(input.alwaysAdvance);
  for (const row of ranked) {
    if (advanced.size >= input.advanceCount + input.alwaysAdvance.size) break;
    advanced.add(row.applicantId);
  }

  return advanced;
}
