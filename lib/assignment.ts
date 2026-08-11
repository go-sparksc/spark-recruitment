// FR-7's feasibility precheck and generator. Pure — no database, no Prisma.
//
// Four constraints hold at once: three reviewers per applicant, at most one
// Sparklet each, load even on both sides, and about 5% of slots held open as a
// conflict-of-interest buffer. They are jointly unsatisfiable on some rosters,
// and the dangerous part is that the failure is quiet — an implementation that
// drops the one-Sparklet rule produces an assignment that looks entirely normal,
// and nobody finds out until a Sparklet and their own roommate are the two
// people reviewing one application.
//
// So `checkFeasibility` is separate from `generateAssignments` and never
// generates. FR-7 makes the failure a decision point for the admin — add
// non-Sparklet reviewers, or accept uneven Sparklet load — and a precheck that
// produced a plan as a side effect could not offer that choice.
//
// PRD §7.2 is quoted rather than paraphrased throughout. Paraphrasing an FR is
// how this phase already lost half of FR-6.

import { createRng } from "@/lib/rng";

export interface ReviewerInput {
  id: string;
  isSparklet: boolean;
}

export interface Pair {
  applicantId: string;
  reviewerId: string;
}

export interface AssignmentInput {
  /// Every applicant to be staffed. Scope is the caller's decision — for the
  /// written round that is all of them.
  applicantIds: readonly string[];
  /// **The round's roster**, not the instance's reviewers. FR-7: "reviewer_count
  /// throughout means the roster of the round being assigned. A reviewer serving
  /// only the second round is not capacity for the written one."
  reviewers: readonly ReviewerInput[];
  /// MANUAL and CLAIMED_FROM_POOL rows kept across a regeneration. FR-8: they
  /// are "consumed capacity rather than exclusions" — see `applyPreserved`.
  preserved?: readonly Pair[];
  /// RETURNED_TO_POOL rows. Decision 23: "an exclusion, not consumed capacity."
  /// The pair is never re-created; it occupies no slot and counts against
  /// nobody's load. A third category, distinct from preserved and generated.
  blocked?: readonly Pair[];
  /// Decision 2's action. The one-Sparklet rule still never gives.
  relaxSparkletLoad?: boolean;
  /// Tie-breaking only. Fixed in tests; the caller supplies something varying so
  /// two regenerations are not forced to produce identical plans.
  seed?: number;
}

/// A rule the preserved set already breaks. FR-8: "generation reports the
/// violation and does not correct it by removing a manual assignment."
export interface Violation {
  kind: "OVER_CEILING" | "TWO_SPARKLETS";
  reviewerId?: string;
  applicantId?: string;
  detail: string;
}

export interface FeasibilityReport {
  target: number;
  totalSlots: number;
  poolSize: number;
  assignedSlots: number;
  /// Applicants receiving the full target.
  fullApplicantCount: number;
  /// Applicants one slot short. Always `poolSize` distinct applicants.
  shortApplicantCount: number;
  loadCeiling: number;
  loadFloor: number;
  nonSparkletMinimum: number;
  nonSparkletCapacity: number;
  /// What non-Sparklets would carry under decision 2's relaxed rule. Null when
  /// the relaxed rule cannot help — no non-Sparklets to absorb the remainder.
  relaxedNonSparkletCeiling: number | null;
  relaxedNonSparkletAverage: number | null;
  feasible: boolean;
  /// FR-7's message, with this roster's numbers. Null when feasible.
  message: string | null;
  /// Rules the preserved set already breaks. Reported, never corrected.
  preexistingViolations: Violation[];
}

export interface AssignmentPlan {
  /// Generated pairs only. Preserved rows are not repeated here — the caller
  /// already has them and they are not being rewritten.
  assignments: Pair[];
  report: FeasibilityReport;
  /// Slots left open on purpose: `poolSize` of them, on distinct applicants.
  pooledApplicantIds: string[];
  loadByReviewerId: Record<string, number>;
  preexistingViolations: Violation[];
}

const pairKey = (applicantId: string, reviewerId: string) => `${applicantId}${reviewerId}`;

// ---------------------------------------------------------------------------
// The arithmetic, in one place
// ---------------------------------------------------------------------------

/// FR-7's sizing. Every number below is derived here and nowhere else, so the
/// precheck and the generator cannot disagree about the shape of the problem.
export function planShape(applicantCount: number, reviewerCount: number) {
  const target = Math.min(3, reviewerCount);
  const totalSlots = applicantCount * target;

  // "no reviewer exceeds ceil(total_slots / reviewer_count) ... the full grid at
  // the applicable target, not the reduced count after the pool is withheld.
  // Using the full grid keeps the bound stable as returns add slots back to the
  // pool mid-round."
  const loadCeiling = reviewerCount === 0 ? 0 : Math.ceil(totalSlots / reviewerCount);

  // "Pool size is exactly min(max(floor(0.05 × total_slots), 3), applicant_count)
  // — the floor first, then the minimum of 3, then the cap, which wins over
  // both." Floor, not round: 22 at 150 applicants, never 23.
  //
  // Decision 20: 0 below a target of 2. Withholding a slot from a 1-slot
  // applicant leaves them with no reviewer at all, which is the model §10.1
  // rejected, and a single reviewer is no conflict-of-interest buffer anyway.
  const poolSize =
    target < 2
      ? 0
      : Math.min(Math.max(Math.floor(0.05 * totalSlots), 3), applicantCount);

  const assignedSlots = totalSlots - poolSize;

  return {
    target,
    totalSlots,
    poolSize,
    assignedSlots,
    loadCeiling,
    // The floor is over assigned_slots, not total_slots — see FR-7. It is
    // checked at generation and not maintained afterwards, because returns
    // shrink assigned_slots over the course of the round.
    loadFloor: reviewerCount === 0 ? 0 : Math.floor(assignedSlots / reviewerCount),
    fullApplicantCount: applicantCount - poolSize,
    shortApplicantCount: poolSize,
  };
}

interface Prepared {
  shape: ReturnType<typeof planShape>;
  /// Slots each applicant still needs after preserved rows are counted.
  need: Map<string, number>;
  /// Applicants chosen to be one short. Exactly `poolSize` of them.
  short: Set<string>;
  /// Capacity each reviewer has left under the ceiling.
  capacity: Map<string, number>;
  /// Applicants already carrying a Sparklet from the preserved set.
  sparkletTaken: Set<string>;
  /// Pairs generation must not create: preserved (already exist) and blocked.
  forbidden: Set<string>;
  violations: Violation[];
}

/// FR-8's "consumed capacity rather than exclusions", made concrete.
///
/// A preserved row does five things: reduces its reviewer's remaining capacity,
/// reduces its applicant's remaining need, takes that applicant's one Sparklet
/// slot if the reviewer is one, removes the pair from the candidate set, and
/// feeds the precheck through all of the above. What it does NOT do is change
/// `target`, `totalSlots`, `poolSize` or `loadCeiling` — those come from the full
/// grid, for the same reason FR-7 gives for the ceiling: a bound that moves when
/// an admin adds one override is not a bound.
///
/// And it never removes its applicant from generation. "Excluding the applicant
/// wholesale would let manual overrides quietly degrade load evenness."
function prepare(input: AssignmentInput): Prepared {
  const applicantIds = input.applicantIds;
  const reviewers = input.reviewers;
  const preserved = input.preserved ?? [];
  const blocked = input.blocked ?? [];
  const rng = createRng(input.seed ?? 1);

  const shape = planShape(applicantIds.length, reviewers.length);
  const byId = new Map(reviewers.map((r) => [r.id, r]));

  const preservedByApplicant = new Map<string, Pair[]>();
  const preservedLoad = new Map<string, number>();
  const sparkletTaken = new Set<string>();
  const sparkletCountByApplicant = new Map<string, number>();
  const forbidden = new Set<string>();

  for (const pair of preserved) {
    preservedByApplicant.set(pair.applicantId, [
      ...(preservedByApplicant.get(pair.applicantId) ?? []),
      pair,
    ]);
    preservedLoad.set(pair.reviewerId, (preservedLoad.get(pair.reviewerId) ?? 0) + 1);
    forbidden.add(pairKey(pair.applicantId, pair.reviewerId));

    if (byId.get(pair.reviewerId)?.isSparklet) {
      sparkletTaken.add(pair.applicantId);
      sparkletCountByApplicant.set(
        pair.applicantId,
        (sparkletCountByApplicant.get(pair.applicantId) ?? 0) + 1,
      );
    }
  }

  // Decision 23: blocked pairs are forbidden but consume nothing.
  for (const pair of blocked) forbidden.add(pairKey(pair.applicantId, pair.reviewerId));

  const violations: Violation[] = [];
  for (const [reviewerId, load] of preservedLoad) {
    if (load > shape.loadCeiling) {
      violations.push({
        kind: "OVER_CEILING",
        reviewerId,
        detail: `holds ${load} preserved assignments against a ceiling of ${shape.loadCeiling}`,
      });
    }
  }
  for (const [applicantId, count] of sparkletCountByApplicant) {
    if (count > 1) {
      violations.push({
        kind: "TWO_SPARKLETS",
        applicantId,
        detail: `already has ${count} Sparklets from preserved assignments`,
      });
    }
  }

  // Which applicants go one short. Chosen among those that can be — an applicant
  // already holding `target` preserved rows has no slot left to withhold — and
  // shuffled so the same applicants are not shorted on every regeneration.
  const preservedCount = (id: string) => preservedByApplicant.get(id)?.length ?? 0;
  const shortable = rng.shuffle(applicantIds.filter((id) => preservedCount(id) < shape.target));
  const short = new Set(shortable.slice(0, shape.poolSize));

  const need = new Map<string, number>();
  for (const id of applicantIds) {
    const wanted = shape.target - (short.has(id) ? 1 : 0);
    need.set(id, Math.max(0, wanted - preservedCount(id)));
  }

  const capacity = new Map<string, number>();
  for (const reviewer of reviewers) {
    // Floored at zero: a preserved set already over the ceiling is reported
    // above, not turned into negative capacity that would skew everything after.
    capacity.set(reviewer.id, Math.max(0, shape.loadCeiling - (preservedLoad.get(reviewer.id) ?? 0)));
  }

  return { shape, need, short, capacity, sparkletTaken, forbidden, violations };
}

// ---------------------------------------------------------------------------
// FR-7's feasibility precheck
// ---------------------------------------------------------------------------

/// Never generates. See the module header.
///
/// "With at most 1 Sparklet per applicant, non-Sparklets must fill at least 2 of
/// every 3-slot applicant and at least 1 of every 2-slot applicant." Generalised:
/// each applicant absorbs at most one Sparklet, so the non-Sparklet minimum is
/// the sum over applicants of (slots needed − one Sparklet's worth, if the
/// applicant can still take a Sparklet). With no preserved rows that collapses to
/// `assignedSlots − applicantCount` = 428 − 150 = 278, the same number §7.2
/// derives as `2 × 128 + 1 × 22`.
///
/// "The precheck computes against actual assignable slots, not the one-third
/// shortcut."
export function checkFeasibility(input: AssignmentInput): FeasibilityReport {
  const { shape, need, sparkletTaken, violations } = prepare(input);
  const reviewers = input.reviewers;

  const nonSparklets = reviewers.filter((r) => !r.isSparklet);
  const preservedLoad = new Map<string, number>();
  for (const pair of input.preserved ?? []) {
    preservedLoad.set(pair.reviewerId, (preservedLoad.get(pair.reviewerId) ?? 0) + 1);
  }

  let nonSparkletMinimum = 0;
  for (const applicantId of input.applicantIds) {
    const remaining = need.get(applicantId) ?? 0;
    const sparkletHeadroom = sparkletTaken.has(applicantId) ? 0 : 1;
    nonSparkletMinimum += Math.max(0, remaining - sparkletHeadroom);
  }

  const nonSparkletCapacity = nonSparklets.reduce(
    (sum, r) => sum + Math.max(0, shape.loadCeiling - (preservedLoad.get(r.id) ?? 0)),
    0,
  );

  const feasible = nonSparkletCapacity >= nonSparkletMinimum;

  // Decision 2's relaxed rule: Sparklets saturate at one per applicant and
  // non-Sparklets absorb the remainder. Null when there are no non-Sparklets —
  // the one-Sparklet rule never gives, so nothing can absorb it.
  const relaxedNonSparkletCeiling =
    nonSparklets.length === 0 ? null : Math.ceil(nonSparkletMinimum / nonSparklets.length);
  const relaxedNonSparkletAverage =
    nonSparklets.length === 0 ? null : nonSparkletMinimum / nonSparklets.length;

  return {
    ...shape,
    nonSparkletMinimum,
    nonSparkletCapacity,
    relaxedNonSparkletCeiling,
    relaxedNonSparkletAverage,
    feasible,
    message: feasible
      ? null
      : failureMessage({
          sparkletCount: reviewers.length - nonSparklets.length,
          reviewerCount: reviewers.length,
          nonSparkletCount: nonSparklets.length,
          nonSparkletMinimum,
          nonSparkletCapacity,
          loadCeiling: shape.loadCeiling,
          relaxedNonSparkletCeiling,
          relaxedNonSparkletAverage,
          preservedCount: (input.preserved ?? []).length,
        }),
    preexistingViolations: violations,
  };
}

/// FR-7's copy, with this roster's numbers in it.
///
/// Written for the audience the BUILD_PLAN gate names — "one a non-technical
/// successor could act on" — so it says what is wrong, what the two numbers
/// mean, and what can be done, in that order, without the word "infeasible".
function failureMessage(n: {
  sparkletCount: number;
  reviewerCount: number;
  nonSparkletCount: number;
  nonSparkletMinimum: number;
  nonSparkletCapacity: number;
  loadCeiling: number;
  relaxedNonSparkletCeiling: number | null;
  relaxedNonSparkletAverage: number | null;
  /// MANUAL and CLAIMED_FROM_POOL rows already on the round. Both numbers above
  /// are computed net of them, so on a live instance they will not match a
  /// worked example done on a clean roster.
  preservedCount: number;
}): string {
  const head =
    `You have ${n.sparkletCount} Sparklets among ${n.reviewerCount} reviewers. ` +
    `Even distribution is not possible under the one-Sparklet-per-applicant rule.`;

  if (n.nonSparkletCount === 0) {
    return (
      `${head} Every reviewer on this round is a Sparklet, and at most one Sparklet may ` +
      `review any applicant, so most applicants cannot be staffed at all. Add non-Sparklet ` +
      `reviewers to the round.`
    );
  }

  const why =
    `Because at most one Sparklet may review any applicant, your ${n.nonSparkletCount} ` +
    `non-Sparklet reviewers would have to cover ${n.nonSparkletMinimum} of the assignments, ` +
    `and an even share caps them at ${n.loadCeiling} each — ${n.nonSparkletCapacity} in total.`;

  // Both figures above are net of whatever is already assigned by hand, so on a
  // live instance they will not match a worked example done on a clean roster.
  // Naming the count rather than the fact is what makes it checkable: the
  // number here should equal the manual and claimed rows the page lists above.
  // Without this, the sensible reading of the discrepancy is that the tool is
  // wrong — which is exactly how it was read the first time it appeared.
  const preserved =
    n.preservedCount === 0
      ? ""
      : ` ${n.preservedCount} assignment${n.preservedCount === 1 ? "" : "s"} already on this ` +
        `round — manual overrides and claimed slots — ${n.preservedCount === 1 ? "is" : "are"} ` +
        `counted in both figures, so they are lower than they would be on a clean run.`;

  const options =
    `Options: add non-Sparklet reviewers, or allow Sparklet load to be lighter than average, ` +
    `which would put about ${n.relaxedNonSparkletAverage?.toFixed(1)} assignments on each ` +
    `non-Sparklet reviewer (capped at ${n.relaxedNonSparkletCeiling}) instead of ${n.loadCeiling}.`;

  return `${head} ${why}${preserved} ${options}`;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/// Refuses when the precheck fails and the relaxed rule has not been chosen.
/// FR-7: "the system must not silently violate a constraint."
export function generateAssignments(input: AssignmentInput): AssignmentPlan {
  const report = checkFeasibility(input);

  if (!report.feasible && input.relaxSparkletLoad !== true) {
    return {
      assignments: [],
      report,
      pooledApplicantIds: [],
      loadByReviewerId: {},
      preexistingViolations: report.preexistingViolations,
    };
  }

  const { shape, need, short, capacity, sparkletTaken, forbidden, violations } = prepare(input);
  const rng = createRng(input.seed ?? 1);

  // Load starts at what the preserved set already consumes, so the ceiling and
  // the floor are measured over preserved plus generated — which is what a
  // reviewer actually carries.
  const load = new Map<string, number>();
  for (const reviewer of input.reviewers) {
    load.set(reviewer.id, shape.loadCeiling - (capacity.get(reviewer.id) ?? 0));
  }

  const taken = new Set(sparkletTaken);
  /// Pairs that must not be created: preserved rows (they already exist) and
  /// RETURNED_TO_POOL rows (decision 23). Grows as generation places pairs.
  const placed = new Set(forbidden);
  /// Who is on each applicant, for the floor repair below. Seeded with the
  /// preserved rows: they are not movable, but a swap must not put a reviewer
  /// onto an applicant they already serve through one.
  const onApplicant = new Map<string, Set<string>>();
  for (const pair of input.preserved ?? []) {
    onApplicant.set(
      pair.applicantId,
      (onApplicant.get(pair.applicantId) ?? new Set()).add(pair.reviewerId),
    );
  }

  const assignments: Pair[] = [];

  // Under the relaxed rule the ceiling on non-Sparklets rises to whatever the
  // remainder requires; Sparklets stay bounded by one-per-applicant alone.
  // "Sparklets take whatever the constraint allows, and non-Sparklets absorb the
  // remainder." The one-Sparklet rule is never the thing that gives.
  const relaxed = report.feasible ? false : input.relaxSparkletLoad === true;
  const ceilingFor = (reviewer: ReviewerInput) =>
    relaxed && !reviewer.isSparklet
      ? Math.max(shape.loadCeiling, report.relaxedNonSparkletCeiling ?? shape.loadCeiling)
      : shape.loadCeiling;

  // Most-constrained applicant first, so the hardest ones are placed while the
  // most reviewers are still free. Ties broken by seeded shuffle rather than by
  // input order, so a regeneration does not short the same people every time.
  const order = rng
    .shuffle(input.applicantIds)
    .sort((a, b) => (need.get(b) ?? 0) - (need.get(a) ?? 0));

  for (const applicantId of order) {
    let remaining = need.get(applicantId) ?? 0;

    while (remaining > 0) {
      const candidates = input.reviewers.filter((reviewer) => {
        if (placed.has(pairKey(applicantId, reviewer.id))) return false;
        if ((load.get(reviewer.id) ?? 0) >= ceilingFor(reviewer)) return false;
        // The rule that never gives, in either mode.
        if (reviewer.isSparklet && taken.has(applicantId)) return false;
        return true;
      });

      if (candidates.length === 0) break;

      // Lowest load wins, which is what drives both bounds. Under the relaxed
      // rule Sparklets are preferred while they are still under one-per-applicant
      // saturation, so they absorb what they are allowed to and non-Sparklets
      // carry only the genuine remainder.
      const pick = candidates.sort((a, b) => {
        if (relaxed && a.isSparklet !== b.isSparklet) return a.isSparklet ? -1 : 1;
        return (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0);
      })[0];

      assignments.push({ applicantId, reviewerId: pick.id });
      placed.add(pairKey(applicantId, pick.id));
      load.set(pick.id, (load.get(pick.id) ?? 0) + 1);
      onApplicant.set(applicantId, (onApplicant.get(applicantId) ?? new Set()).add(pick.id));
      if (pick.isSparklet) taken.add(applicantId);
      remaining -= 1;
    }
  }

  evenOutToFloor({
    reviewers: input.reviewers,
    assignments,
    load,
    onApplicant,
    taken,
    floor: shape.loadFloor,
  });

  return {
    assignments,
    report,
    pooledApplicantIds: [...short],
    loadByReviewerId: Object.fromEntries(load),
    preexistingViolations: violations,
  };
}

/// FR-7's floor, enforced by the swap it is defined in terms of.
///
/// "A reviewer may sit below the floor only when no single swap could raise
/// them" — so the way to satisfy the rule is to run that swap to a fixed point.
/// For a reviewer `r` below the floor, find an applicant `a` and reviewer `s`
/// where `s` is on `a`, `s` carries at least two more than `r`, `r` is not
/// already on `a`, and putting `r` there would not give `a` two Sparklets. Move
/// it. Repeat until no such triple exists.
///
/// The same search is the assertion and the repair, which is why it is written
/// once: whatever a test would flag as a violation is exactly what this fixes,
/// so the two cannot disagree about what "as even as possible" means.
///
/// A swap moves one slot from a heavier reviewer to a lighter one and changes no
/// applicant's count, so it cannot break the pool shape, the target, or the
/// ceiling. It strictly reduces the total distance from the floor, which is what
/// terminates it; the iteration cap is belt and braces against a bug, not part
/// of the argument.
function evenOutToFloor(state: {
  reviewers: readonly ReviewerInput[];
  assignments: Pair[];
  load: Map<string, number>;
  onApplicant: Map<string, Set<string>>;
  taken: Set<string>;
  floor: number;
}): void {
  const { reviewers, assignments, load, onApplicant, taken, floor } = state;
  const isSparklet = new Map(reviewers.map((r) => [r.id, r.isSparklet]));
  const maxPasses = assignments.length * 2 + 16;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const light = reviewers.find((r) => (load.get(r.id) ?? 0) < floor);
    if (!light) return;

    const lightLoad = load.get(light.id) ?? 0;

    const swap = assignments.find((pair) => {
      const holder = pair.reviewerId;
      if (holder === light.id) return false;
      if ((load.get(holder) ?? 0) < lightLoad + 2) return false;
      if (onApplicant.get(pair.applicantId)?.has(light.id)) return false;
      // Moving a Sparklet's slot to another Sparklet is fine — the applicant
      // still ends with one. Moving a non-Sparklet's slot to a Sparklet is only
      // fine if the applicant has none.
      if (light.isSparklet && !isSparklet.get(holder) && taken.has(pair.applicantId)) return false;
      return true;
    });

    // No improving swap exists for this reviewer, and the one-Sparklet rule is
    // why. FR-7 exempts them; there is nothing further to do.
    if (!swap) return;

    const holder = swap.reviewerId;
    swap.reviewerId = light.id;
    load.set(holder, (load.get(holder) ?? 0) - 1);
    load.set(light.id, lightLoad + 1);

    const on = onApplicant.get(swap.applicantId);
    on?.delete(holder);
    on?.add(light.id);

    if (isSparklet.get(holder) && !light.isSparklet) taken.delete(swap.applicantId);
    if (light.isSparklet) taken.add(swap.applicantId);
  }
}
