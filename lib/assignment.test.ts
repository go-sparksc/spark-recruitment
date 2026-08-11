import { describe, expect, it } from "vitest";

import {
  checkFeasibility,
  generateAssignments,
  planShape,
  type AssignmentInput,
  type AssignmentPlan,
  type Pair,
  type ReviewerInput,
} from "@/lib/assignment";

// BUILD_PLAN phase 2's assignment block is the spec, and CLAUDE.md is explicit
// that if a test contradicts it the test is wrong. Each of its six cases is a
// describe below, headed by the case as written.
//
// The cases assume PRD v1.4's pool definition — 5% of assignment SLOTS, not of
// applicants. Every applicant is assigned; ~22 are short exactly one reviewer.
// Any number derived from the older "7 applicants held with zero reviewers"
// model is wrong.

function roster(count: number, sparklets: number): ReviewerInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `rev_${i}`,
    isSparklet: i < sparklets,
  }));
}

const applicants = (count: number) => Array.from({ length: count }, (_, i) => `app_${i}`);

function input(over: Partial<AssignmentInput> & Pick<AssignmentInput, "applicantIds" | "reviewers">) {
  return { seed: 7, ...over };
}

interface Counts {
  perApplicant: Map<string, number>;
  perReviewer: Map<string, number>;
  sparkletsPerApplicant: Map<string, number>;
}

function count(plan: AssignmentPlan, reviewers: readonly ReviewerInput[], preserved: readonly Pair[] = []): Counts {
  const isSparklet = new Map(reviewers.map((r) => [r.id, r.isSparklet]));
  const perApplicant = new Map<string, number>();
  const perReviewer = new Map<string, number>();
  const sparkletsPerApplicant = new Map<string, number>();

  for (const pair of [...plan.assignments, ...preserved]) {
    perApplicant.set(pair.applicantId, (perApplicant.get(pair.applicantId) ?? 0) + 1);
    perReviewer.set(pair.reviewerId, (perReviewer.get(pair.reviewerId) ?? 0) + 1);
    if (isSparklet.get(pair.reviewerId)) {
      sparkletsPerApplicant.set(
        pair.applicantId,
        (sparkletsPerApplicant.get(pair.applicantId) ?? 0) + 1,
      );
    }
  }

  return { perApplicant, perReviewer, sparkletsPerApplicant };
}

/// Every rule FR-7 states, checked on every plan any test produces. Written once
/// so a case cannot pass by asserting only the number it happens to name.
function assertPlanInvariants(
  plan: AssignmentPlan,
  args: AssignmentInput,
  options: { expectFloor?: boolean } = {},
) {
  const { report } = plan;
  const preserved = args.preserved ?? [];
  const { perApplicant, perReviewer, sparkletsPerApplicant } = count(plan, args.reviewers, preserved);

  // No duplicate pair — UNIQUE (round, applicantId, reviewerId).
  const keys = [...plan.assignments, ...preserved].map((p) => `${p.applicantId}|${p.reviewerId}`);
  expect(new Set(keys).size).toBe(keys.length);

  // A blocked pair is never re-created (decision 23).
  for (const pair of args.blocked ?? []) {
    expect(keys).not.toContain(`${pair.applicantId}|${pair.reviewerId}`);
  }

  // Every applicant is at the target or exactly one short, and never at zero
  // unless the target itself is zero.
  for (const applicantId of args.applicantIds) {
    const got = perApplicant.get(applicantId) ?? 0;
    expect(got === report.target || got === report.target - 1).toBe(true);
    if (report.target > 0) expect(got).toBeGreaterThan(0);
  }

  // Exactly poolSize applicants are short, and they are distinct by construction
  // because they are counted per applicant.
  const shortCount = args.applicantIds.filter(
    (id) => (perApplicant.get(id) ?? 0) === report.target - 1,
  ).length;
  expect(shortCount).toBe(report.poolSize);

  expect(plan.assignments.length + preserved.length).toBe(report.assignedSlots);

  // At most one Sparklet per applicant. The rule that never gives.
  for (const applicantId of args.applicantIds) {
    expect(sparkletsPerApplicant.get(applicantId) ?? 0).toBeLessThanOrEqual(1);
  }

  // The ceiling. Under the relaxed rule non-Sparklets rise to the relaxed one.
  for (const reviewer of args.reviewers) {
    const load = perReviewer.get(reviewer.id) ?? 0;
    const ceiling =
      args.relaxSparkletLoad && !reviewer.isSparklet && report.relaxedNonSparkletCeiling !== null
        ? Math.max(report.loadCeiling, report.relaxedNonSparkletCeiling)
        : report.loadCeiling;
    expect(load).toBeLessThanOrEqual(ceiling);
  }

  // The floor, per the FR-7 edit. A reviewer below it is only allowed when no
  // single swap could raise them — the same search the generator repairs with,
  // so this is the assertion and the repair agreeing rather than two opinions.
  if (options.expectFloor !== false) {
    for (const reviewer of args.reviewers) {
      const load = perReviewer.get(reviewer.id) ?? 0;
      if (load >= report.loadFloor) continue;
      expect(improvingSwapExists(plan, args, reviewer, load)).toBe(false);
    }
  }
}

/// The mathematically even distribution of the assignable slots: `remainder`
/// reviewers carry one more than the rest, and nobody carries anything else.
///
/// Used on the rosters where no Sparklet constraint binds, so "as even as
/// possible" is pinned to a concrete shape rather than to a pair of bounds a
/// lopsided plan could still satisfy. Derived from the report rather than
/// written down, so it stays right if a roster in a describe changes; each
/// caller also asserts the two counts by hand, which is the independent check.
function assertEvenSplit(plan: AssignmentPlan, reviewerCount: number) {
  const assigned = plan.report.assignedSlots;
  const base = Math.floor(assigned / reviewerCount);
  const remainder = assigned % reviewerCount;
  const loads = Object.values(plan.loadByReviewerId);

  expect(loads).toHaveLength(reviewerCount);
  expect(loads.filter((n) => n === base + 1)).toHaveLength(remainder);
  expect(loads.filter((n) => n === base)).toHaveLength(reviewerCount - remainder);
}

/// FR-7's exemption, evaluated. True means the plan left load on the table.
function improvingSwapExists(
  plan: AssignmentPlan,
  args: AssignmentInput,
  light: ReviewerInput,
  lightLoad: number,
): boolean {
  const preserved = args.preserved ?? [];
  const all = [...plan.assignments, ...preserved];
  const { perReviewer, sparkletsPerApplicant } = count(plan, args.reviewers, preserved);
  const isSparklet = new Map(args.reviewers.map((r) => [r.id, r.isSparklet]));
  const onApplicant = new Map<string, Set<string>>();
  for (const pair of all) {
    onApplicant.set(pair.applicantId, (onApplicant.get(pair.applicantId) ?? new Set()).add(pair.reviewerId));
  }

  return plan.assignments.some((pair) => {
    if (pair.reviewerId === light.id) return false;
    if ((perReviewer.get(pair.reviewerId) ?? 0) < lightLoad + 2) return false;
    if (onApplicant.get(pair.applicantId)?.has(light.id)) return false;
    if (
      light.isSparklet &&
      !isSparklet.get(pair.reviewerId) &&
      (sparkletsPerApplicant.get(pair.applicantId) ?? 0) > 0
    ) {
      return false;
    }
    return true;
  });
}

describe("30 reviewers, 8 Sparklets, 150 applicants", () => {
  const args = input({ applicantIds: applicants(150), reviewers: roster(30, 8) });
  const plan = generateAssignments(args);

  it("450 total slots, pool = floor(0.05 x 450) = 22 — NOT 23", () => {
    expect(plan.report.totalSlots).toBe(450);
    expect(plan.report.poolSize).toBe(22);
  });

  it("all 150 applicants assigned: 128 with 3 reviewers, 22 with 2", () => {
    const { perApplicant } = count(plan, args.reviewers);

    expect([...perApplicant.values()].filter((n) => n === 3)).toHaveLength(128);
    expect([...perApplicant.values()].filter((n) => n === 2)).toHaveLength(22);
    expect(perApplicant.size).toBe(150);
  });

  it("428 slots filled, ceiling ceil(450/30) = 15, no applicant with 2 Sparklets", () => {
    expect(plan.assignments).toHaveLength(428);
    expect(plan.report.loadCeiling).toBe(15);
    assertPlanInvariants(plan, args);
  });

  it("the 22 short applicants are 22 DISTINCT applicants, never one short two", () => {
    expect(new Set(plan.pooledApplicantIds).size).toBe(22);
    const { perApplicant } = count(plan, args.reviewers);
    expect(Math.min(...perApplicant.values())).toBe(2);
  });

  it("the floor binds on all 30 — the exemption is never reached", () => {
    // 428 = 30 x 14 + 8, and 8 Sparklets need at most 120 of 150 available
    // Sparklet slots, so 14-or-15 is reachable for everyone.
    expect(plan.report.loadFloor).toBe(14);
    for (const load of Object.values(plan.loadByReviewerId)) {
      expect(load).toBeGreaterThanOrEqual(14);
      expect(load).toBeLessThanOrEqual(15);
    }
  });

  it("distributes exactly 8 reviewers at 15 and 22 at 14", () => {
    // The BUILD_PLAN gate says to print the distribution and eyeball it. This
    // asserts it instead, which is the same check made durable: 428 over 30 is
    // 14 remainder 8, so any other shape is uneven whatever the bounds allow.
    const loads = Object.values(plan.loadByReviewerId);

    expect(loads.filter((n) => n === 15)).toHaveLength(8);
    expect(loads.filter((n) => n === 14)).toHaveLength(22);
    expect(loads.reduce((a, b) => a + b, 0)).toBe(428);
    assertEvenSplit(plan, 30);
  });

  it("gives Sparklets and non-Sparklets the same treatment", () => {
    // 8 of 30 clears the constraint comfortably, so there is no reason for a
    // Sparklet to carry a different load here — and if one did, the relaxed
    // path would be silently leaking into the unrelaxed one.
    const sparkletLoads = args.reviewers
      .filter((r) => r.isSparklet)
      .map((r) => plan.loadByReviewerId[r.id]);

    for (const load of sparkletLoads) {
      expect(load).toBeGreaterThanOrEqual(14);
      expect(load).toBeLessThanOrEqual(15);
    }
  });

  it("passes the precheck", () => {
    expect(plan.report.feasible).toBe(true);
    expect(plan.report.message).toBeNull();
  });
});

describe("30 reviewers, 15 Sparklets, 150 applicants", () => {
  const args = input({ applicantIds: applicants(150), reviewers: roster(30, 15) });

  describe("the check FAILS and does not generate", () => {
    // Asserted through checkFeasibility alone. The whole reason it is a separate
    // function is that the failure has to be inspectable without producing a plan.
    const report = checkFeasibility(args);

    it("15 non-Sparklets x ceil(450/30) = 225 capacity against a 278-slot minimum", () => {
      expect(report.nonSparkletCapacity).toBe(225);
      expect(report.nonSparkletMinimum).toBe(278);
      expect(report.loadCeiling).toBe(15);
    });

    it("225 < 278, so it fails", () => {
      expect(report.feasible).toBe(false);
    });

    it("relaxed ceiling of ceil(278/15) = 19, average 18.5, against 15", () => {
      expect(report.relaxedNonSparkletCeiling).toBe(19);
      expect(report.relaxedNonSparkletAverage).toBeCloseTo(18.53, 1);
    });

    it("both numbers appear in the message, before anything is confirmed", () => {
      expect(report.message).toContain("15");
      expect(report.message).toContain("19");
      expect(report.message).toContain("18.5");
    });

    it("the message is one a non-technical successor could act on", () => {
      // The BUILD_PLAN gate's wording. It has to name the cause and both ways
      // out, in plain words.
      expect(report.message).toContain("one-Sparklet-per-applicant rule");
      expect(report.message).toContain("add non-Sparklet reviewers");
      expect(report.message).not.toContain("infeasible");
    });

    it("refuses to generate without the relaxed rule", () => {
      const plan = generateAssignments(args);

      expect(plan.assignments).toEqual([]);
      expect(plan.report.feasible).toBe(false);
    });
  });

  describe("taking the relaxed action", () => {
    const relaxedArgs = input({ ...args, relaxSparkletLoad: true });
    const plan = generateAssignments(relaxedArgs);

    it("generates with the one-Sparklet rule still intact", () => {
      const { sparkletsPerApplicant } = count(plan, relaxedArgs.reviewers);

      expect(plan.assignments).toHaveLength(428);
      for (const n of sparkletsPerApplicant.values()) expect(n).toBeLessThanOrEqual(1);
    });

    it("non-Sparklets stay within the relaxed ceiling of 19", () => {
      for (const reviewer of relaxedArgs.reviewers.filter((r) => !r.isSparklet)) {
        expect(plan.loadByReviewerId[reviewer.id]).toBeLessThanOrEqual(19);
      }
    });

    it("Sparklets carry only what one-per-applicant allows, spread evenly", () => {
      // Derived, not observed. At most one Sparklet may review any applicant, so
      // the Sparklets share at most `applicantCount` slots between them — 150 —
      // and an even share of that is 150 / 15 = 10 each. That 10 is the number
      // the relaxed trade buys, against 18 or 19 for everyone else, so it is
      // computed here rather than written down: if the roster in this describe
      // changes, the expectation should move with it instead of failing as a
      // stale literal nobody can classify as requirement or observation.
      const applicantCount = relaxedArgs.applicantIds.length;
      const sparklets = relaxedArgs.reviewers.filter((r) => r.isSparklet);
      const evenSparkletShare = Math.ceil(applicantCount / sparklets.length);

      expect(evenSparkletShare).toBe(10);
      for (const reviewer of sparklets) {
        expect(plan.loadByReviewerId[reviewer.id]).toBeLessThanOrEqual(evenSparkletShare);
      }
    });

    it("saturates the Sparklets — one on every applicant, which is what frees the rest", () => {
      // The other half of the same fact. If Sparklets took fewer than one per
      // applicant, non-Sparklets would have to carry more than 278 and the
      // relaxed ceiling of 19 would be wrong.
      const { sparkletsPerApplicant } = count(plan, relaxedArgs.reviewers);
      const total = [...sparkletsPerApplicant.values()].reduce((a, b) => a + b, 0);

      expect(total).toBe(relaxedArgs.applicantIds.length);
    });

    it("holds every other invariant", () => {
      assertPlanInvariants(plan, relaxedArgs);
    });
  });
});

describe("3 reviewers, 0 Sparklets, 10 applicants", () => {
  const args = input({ applicantIds: applicants(10), reviewers: roster(3, 0) });
  const plan = generateAssignments(args);

  it("30 slots, pool = max(floor(1.5), 3) = 3", () => {
    expect(plan.report.totalSlots).toBe(30);
    expect(plan.report.poolSize).toBe(3);
  });

  it("7 applicants get all 3 reviewers, 3 applicants get 2", () => {
    const { perApplicant } = count(plan, args.reviewers);

    expect([...perApplicant.values()].filter((n) => n === 3)).toHaveLength(7);
    expect([...perApplicant.values()].filter((n) => n === 2)).toHaveLength(3);
  });

  it("splits 27 slots as 9 each, with no remainder to argue about", () => {
    // By hand: 27 = 3 x 9 exactly. A third roster with a knowable optimum, and
    // the one where the even split is perfect rather than off by a remainder.
    const loads = Object.values(plan.loadByReviewerId);

    expect(loads).toEqual([9, 9, 9]);
    assertEvenSplit(plan, 3);
  });

  it("holds every invariant", () => {
    assertPlanInvariants(plan, args);
  });
});

describe("2 reviewers, 2 applicants", () => {
  const args = input({ applicantIds: applicants(2), reviewers: roster(2, 0) });
  const plan = generateAssignments(args);

  it("target is min(3, 2) = 2, so 4 slots, floor(0.2) = 0, minimum 3, capped at 2", () => {
    expect(plan.report.target).toBe(2);
    expect(plan.report.totalSlots).toBe(4);
    expect(plan.report.poolSize).toBe(2);
  });

  it("the exactly-one-short rule beats the minimum-3 rule; no applicant loses two", () => {
    const { perApplicant } = count(plan, args.reviewers);

    expect([...perApplicant.values()]).toEqual([1, 1]);
  });

  it("each applicant ends with 1 reviewer, neither with 0", () => {
    const { perApplicant } = count(plan, args.reviewers);

    for (const applicantId of args.applicantIds) expect(perApplicant.get(applicantId)).toBe(1);
    assertPlanInvariants(plan, args);
  });

  it("and each reviewer carries exactly 1", () => {
    // By hand: 2 assignable slots over 2 reviewers. The smallest roster where
    // the shape is knowable, and the one where a pool that ignored its cap would
    // show up immediately as a reviewer carrying nothing.
    expect(Object.values(plan.loadByReviewerId)).toEqual([1, 1]);
    assertEvenSplit(plan, 2);
  });
});

describe("31 reviewers, 0 Sparklets, 150 applicants", () => {
  const args = input({ applicantIds: applicants(150), reviewers: roster(31, 0) });
  const plan = generateAssignments(args);

  it("450 total slots, pool = 22, 428 assigned", () => {
    expect(plan.report.totalSlots).toBe(450);
    expect(plan.report.poolSize).toBe(22);
    expect(plan.assignments).toHaveLength(428);
  });

  it("428 across 31 does not divide evenly; no reviewer exceeds ceil(450/31) = 15", () => {
    expect(plan.report.loadCeiling).toBe(15);
    for (const load of Object.values(plan.loadByReviewerId)) expect(load).toBeLessThanOrEqual(15);
  });

  it("and none falls below floor(428/31) = 13", () => {
    expect(plan.report.loadFloor).toBe(13);
    for (const load of Object.values(plan.loadByReviewerId)) expect(load).toBeGreaterThanOrEqual(13);
    assertPlanInvariants(plan, args);
  });

  it("distributes exactly 25 reviewers at 14 and 6 at 13", () => {
    // By hand: 428 = 31 x 13 + 25, so 25 reviewers carry one more than the other
    // 6 and no other shape is even. This is the second roster with a knowable
    // optimum, and it divides differently from 150/30/8 — remainder 25 of 31
    // rather than 8 of 30 — so the floor logic is not verified at a single point.
    const loads = Object.values(plan.loadByReviewerId);

    expect(loads.filter((n) => n === 14)).toHaveLength(25);
    expect(loads.filter((n) => n === 13)).toHaveLength(6);
    assertEvenSplit(plan, 31);
  });
});

describe("Regeneration after manual overrides exist", () => {
  const reviewers = roster(30, 8);
  const sparklet = reviewers[0];
  const nonSparklet = reviewers[10];

  it("a preserved assignment counts against its reviewer's load ceiling", () => {
    // Consumed capacity, not an exclusion. The reviewer's total across preserved
    // and generated must respect the same ceiling.
    const preserved: Pair[] = Array.from({ length: 5 }, (_, i) => ({
      applicantId: `app_${i}`,
      reviewerId: nonSparklet.id,
    }));
    const args = input({ applicantIds: applicants(150), reviewers, preserved });
    const plan = generateAssignments(args);
    const { perReviewer } = count(plan, reviewers, preserved);

    expect(perReviewer.get(nonSparklet.id)).toBeLessThanOrEqual(plan.report.loadCeiling);
    assertPlanInvariants(plan, args);
  });

  it("a preserved Sparklet blocks a second Sparklet on that applicant", () => {
    const preserved: Pair[] = [{ applicantId: "app_0", reviewerId: sparklet.id }];
    const args = input({ applicantIds: applicants(150), reviewers, preserved });
    const plan = generateAssignments(args);
    const { sparkletsPerApplicant } = count(plan, reviewers, preserved);

    expect(sparkletsPerApplicant.get("app_0")).toBe(1);
  });

  it("an applicant with 1 MANUAL assignment still receives 2 generated slots", () => {
    // "it is not excluded from generation." Excluding it would quietly degrade
    // load evenness across the rest of the grid.
    const preserved: Pair[] = [{ applicantId: "app_0", reviewerId: nonSparklet.id }];
    const args = input({ applicantIds: applicants(150), reviewers, preserved });
    const plan = generateAssignments(args);

    const generatedForApp0 = plan.assignments.filter((p) => p.applicantId === "app_0");
    expect(generatedForApp0).toHaveLength(2);
    expect(generatedForApp0.map((p) => p.reviewerId)).not.toContain(nonSparklet.id);
  });

  it("reports a preserved set already over a ceiling, and leaves it in place", () => {
    const preserved: Pair[] = Array.from({ length: 20 }, (_, i) => ({
      applicantId: `app_${i}`,
      reviewerId: nonSparklet.id,
    }));
    const args = input({ applicantIds: applicants(150), reviewers, preserved });
    const plan = generateAssignments(args);

    expect(plan.preexistingViolations.some((v) => v.kind === "OVER_CEILING")).toBe(true);
    // Never silently removed to satisfy the constraint.
    const { perReviewer } = count(plan, reviewers, preserved);
    expect(perReviewer.get(nonSparklet.id)).toBeGreaterThanOrEqual(20);
  });

  it("reports a preserved set already putting 2 Sparklets on one applicant", () => {
    const preserved: Pair[] = [
      { applicantId: "app_0", reviewerId: reviewers[0].id },
      { applicantId: "app_0", reviewerId: reviewers[1].id },
    ];
    const args = input({ applicantIds: applicants(150), reviewers, preserved });
    const plan = generateAssignments(args);

    expect(plan.preexistingViolations.some((v) => v.kind === "TWO_SPARKLETS")).toBe(true);
    const stillThere = [...plan.assignments, ...preserved].filter(
      (p) => p.applicantId === "app_0" && (p.reviewerId === reviewers[0].id || p.reviewerId === reviewers[1].id),
    );
    expect(stillThere).toHaveLength(2);
  });

  it("never re-creates a RETURNED_TO_POOL pair, and it costs no capacity", () => {
    // Decision 23. The exclusion must not read as a used slot.
    const blocked: Pair[] = [{ applicantId: "app_0", reviewerId: nonSparklet.id }];
    const args = input({ applicantIds: applicants(150), reviewers, blocked });
    const plan = generateAssignments(args);

    expect(
      plan.assignments.some((p) => p.applicantId === "app_0" && p.reviewerId === nonSparklet.id),
    ).toBe(false);
    expect(plan.assignments).toHaveLength(428);
    assertPlanInvariants(plan, args);
  });
});

describe("degenerate rosters", () => {
  it("one reviewer: pool is 0 and every applicant gets their one", () => {
    // PRD decision 20. Applying the pool formula here would withhold whole
    // applicants, which is the model §10.1 rejected.
    const args = input({ applicantIds: applicants(10), reviewers: roster(1, 0) });
    const plan = generateAssignments(args);

    expect(plan.report.target).toBe(1);
    expect(plan.report.poolSize).toBe(0);
    expect(plan.assignments).toHaveLength(10);
    assertPlanInvariants(plan, args);
  });

  it("no reviewers: nothing to do, and no crash", () => {
    const plan = generateAssignments(input({ applicantIds: applicants(10), reviewers: [] }));

    expect(plan.report.target).toBe(0);
    expect(plan.report.totalSlots).toBe(0);
    expect(plan.assignments).toEqual([]);
  });

  it("no applicants: nothing to do", () => {
    const plan = generateAssignments(input({ applicantIds: [], reviewers: roster(30, 8) }));

    expect(plan.assignments).toEqual([]);
    expect(plan.report.poolSize).toBe(0);
  });

  it("all Sparklets: the check fails and the relaxed rule is not offered", () => {
    // The relaxed rule works by letting non-Sparklets absorb the remainder. With
    // none, there is nothing to absorb it, and the one-Sparklet rule never gives.
    const report = checkFeasibility(input({ applicantIds: applicants(150), reviewers: roster(30, 30) }));

    expect(report.feasible).toBe(false);
    expect(report.relaxedNonSparkletCeiling).toBeNull();
    expect(report.message).toContain("Add non-Sparklet reviewers");
  });
});

describe("planShape", () => {
  it("applies the pool cap last, so it wins over the minimum of 3", () => {
    expect(planShape(2, 2).poolSize).toBe(2);
    expect(planShape(10, 3).poolSize).toBe(3);
    expect(planShape(150, 30).poolSize).toBe(22);
  });

  it("floors the 5%, never rounds it", () => {
    // 0.05 x 450 = 22.5. The difference between floor and round here is one
    // applicant who does or does not lose a reviewer.
    expect(planShape(150, 30).poolSize).toBe(22);
  });

  it("bases the ceiling on the full grid, not on the assignable slots", () => {
    // FR-7: "Using the full grid keeps the bound stable as returns add slots
    // back to the pool mid-round."
    //
    // Asserted at 31 reviewers, not 30, because the two readings COINCIDE at 30:
    // ceil(450/30) and ceil(428/30) are both 15, so that case cannot tell them
    // apart. At 31 they are 15 and 14.
    expect(planShape(150, 31).loadCeiling).toBe(Math.ceil(450 / 31));
    expect(planShape(150, 31).loadCeiling).not.toBe(Math.ceil(428 / 31));
  });

  it("bases the floor on the assignable slots, not the full grid", () => {
    // Same trick in reverse, and again 31 is where they diverge:
    // floor(428/31) = 13 against floor(450/31) = 14.
    expect(planShape(150, 31).loadFloor).toBe(Math.floor(428 / 31));
    expect(planShape(150, 31).loadFloor).not.toBe(Math.floor(450 / 31));
  });
});
