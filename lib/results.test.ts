import { describe, expect, it } from "vitest";

import {
  firstRoundSummary,
  formatYesPercent,
  hasNoVotes,
  rankFirstRound,
  applyResultFilters,
  formatAverage,
  formatVariance,
  isUnderTarget,
  parseVarianceThreshold,
  rankApplicants,
  reviewerAverage,
  scoreSummary,
  type RankableApplicant,
} from "@/lib/results";

// ---------------------------------------------------------------------------
// The worked cases from plans/phase-4.md. These are the spec: if the
// implementation disagrees with a number here, the implementation is wrong.
//
// All cases assume the post-decision-40 instrument — four rubric categories,
// each 1 to 4 — which is what prisma/seed/roster.ts now seeds and what the ten
// fixture applicants in prisma/seed/reviews.ts are scored on.
// ---------------------------------------------------------------------------

const CATEGORIES = 4;

/// The applicant average for a set of complete reviews, given as raw scores.
function summarise(reviews: readonly (readonly number[])[]) {
  const averages = reviews
    .map((points) => reviewerAverage(points, CATEGORIES))
    .filter((value): value is number => value !== null);
  return scoreSummary(averages);
}

describe("reviewerAverage", () => {
  it("averages a complete review across the live rubric", () => {
    expect(reviewerAverage([4, 4, 4, 4], 4)).toBe(4);
    expect(reviewerAverage([4, 4, 3, 4], 4)).toBe(3.75);
    expect(reviewerAverage([2, 3, 2, 3], 4)).toBe(2.5);
  });

  it("returns null for a part-scored review", () => {
    // PRD decision 1's "completed reviews". Two of four categories produces an
    // average over a different denominator than everyone else's, which would be
    // incomparable while looking exactly as authoritative.
    expect(reviewerAverage([4, 4], 4)).toBeNull();
    expect(reviewerAverage([], 4)).toBeNull();
  });

  it("returns null rather than dividing by zero on an empty rubric", () => {
    expect(reviewerAverage([], 0)).toBeNull();
  });

  it("does not accept more scores than the rubric has categories", () => {
    // Structurally impossible today — UNIQUE (assignmentId, rubricCategoryId) —
    // and asserted so a caller that de-duplicated badly cannot silently inflate
    // an average.
    expect(reviewerAverage([4, 4, 4, 4, 4], 4)).toBeNull();
  });
});

describe("scoreSummary — the worked cases", () => {
  it("case 1: three reviewers, non-terminating average", () => {
    // 4,4,4,4 / 4,4,3,4 / 4,3,4,4 -> 4.00, 3.75, 3.75
    // mean 11.5/3 = 3.83333...; deviations +0.16667, -0.08333, -0.08333
    // squares 0.027778, 0.006944, 0.006944 -> 0.041667 / 3 = 0.013889
    const { average, variance, completedCount } = summarise([
      [4, 4, 4, 4],
      [4, 4, 3, 4],
      [4, 3, 4, 4],
    ]);
    expect(average).toBeCloseTo(3.8333, 4);
    expect(variance).toBeCloseTo(0.013889, 6);
    expect(completedCount).toBe(3);
  });

  it("case 2: perfect agreement is exactly zero variance", () => {
    const { average, variance } = summarise([
      [3, 3, 3, 3],
      [3, 3, 3, 3],
      [3, 3, 3, 3],
    ]);
    expect(average).toBe(3);
    expect(variance).toBe(0);
  });

  it("case 3: population variance, not sample variance", () => {
    // 4,4,3,3 / 3,3,3,3 / 2,3,2,3 -> 3.50, 3.00, 2.50
    // mean 3.00; squares 0.25, 0, 0.25 -> 0.5 / 3 = 0.166667
    //
    // This case alone distinguishes the required formula from the reflex one:
    // the sample form would divide by 2 and give 0.25.
    const { average, variance } = summarise([
      [4, 4, 3, 3],
      [3, 3, 3, 3],
      [2, 3, 2, 3],
    ]);
    expect(average).toBe(3);
    expect(variance).toBeCloseTo(0.166667, 6);
    expect(variance).not.toBeCloseTo(0.25, 6);
  });

  it("case 4: two reviewers, where the divisor choice is loudest", () => {
    // 4.00, 2.00 -> mean 3.00, squares 1 and 1 -> 2 / 2 = 1.0
    // The sample form would give 2.0 — a doubling, on the applicants FR-10 is
    // most likely to be asked about.
    const { average, variance, completedCount } = summarise([
      [4, 4, 4, 4],
      [2, 2, 2, 2],
    ]);
    expect(average).toBe(3);
    expect(variance).toBe(1);
    expect(variance).not.toBe(2);
    expect(completedCount).toBe(2);
  });

  it("case 5: an ordinary mid-table row", () => {
    // 4,4,4,3 / 3,3,2,2 / 2,2,2,2 -> 3.75, 2.50, 2.00
    // mean 8.25/3 = 2.75; squares 1.0, 0.0625, 0.5625 -> 1.625 / 3 = 0.541667
    const { average, variance } = summarise([
      [4, 4, 4, 3],
      [3, 3, 2, 2],
      [2, 2, 2, 2],
    ]);
    expect(average).toBe(2.75);
    expect(variance).toBeCloseTo(0.541667, 6);
  });

  it("case 6: one reviewer gives a true zero variance", () => {
    // A single point has no deviation from its own mean. The number is honest
    // and reads as perfect agreement, which is exactly why the count cell has to
    // carry the marker — nothing about 0.000 says "one person said this".
    const { average, variance, completedCount } = summarise([[3, 3, 3, 3]]);
    expect(average).toBe(3);
    expect(variance).toBe(0);
    expect(completedCount).toBe(1);
  });

  it("case 7: no complete review is null, not zero", () => {
    const { average, variance, completedCount } = summarise([]);
    expect(average).toBeNull();
    expect(variance).toBeNull();
    expect(completedCount).toBe(0);
  });

  it("ignores part-scored reviews when counting completions", () => {
    // The applicant has three assignments; one reviewer stopped halfway. They
    // read 2/3, and the half-finished scores contribute to neither number.
    const averages = [[4, 4, 4, 4], [2, 2], [2, 2, 2, 2]]
      .map((points) => reviewerAverage(points, CATEGORIES))
      .filter((value): value is number => value !== null);
    const { average, variance, completedCount } = scoreSummary(averages);

    expect(completedCount).toBe(2);
    expect(average).toBe(3);
    expect(variance).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function row(
  sourceRowIndex: number,
  average: number | null,
  variance: number | null,
  completedCount = 3,
): RankableApplicant {
  return { sourceRowIndex, average, variance, completedCount };
}

describe("rankApplicants", () => {
  it("ranks by average descending", () => {
    const ranked = rankApplicants([row(1, 2.75, 0), row(2, 4.0, 0), row(3, 3.0, 0)]);
    expect(ranked.map((r) => r.sourceRowIndex)).toEqual([2, 3, 1]);
  });

  it("breaks a tied average by variance ascending", () => {
    const ranked = rankApplicants([
      row(1, 3.0, 1.0),
      row(2, 3.0, 0.0),
      row(3, 3.0, 0.166667),
    ]);
    expect(ranked.map((r) => r.sourceRowIndex)).toEqual([2, 3, 1]);
  });

  it("case 8: breaks a tie on BOTH stated keys by sourceRowIndex — decision 42", () => {
    // Three reviewers all scoring straight 3s and one reviewer scoring a 3 both
    // produce 3.0000 / 0.0000. Without a third key their order is whatever the
    // database returned and can differ between two loads of the same page.
    const ranked = rankApplicants([row(6, 3.0, 0.0, 1), row(2, 3.0, 0.0, 3)]);
    expect(ranked.map((r) => r.sourceRowIndex)).toEqual([2, 6]);
  });

  it("orders the ten seeded fixture applicants exactly as the plan's table does", () => {
    // The BUILD_PLAN Phase 4 gate, as a unit test. The same ten rows and the
    // same expected order that prisma/seed/reviews.ts writes and
    // `npm run seed:inspect` prints.
    const fixture = [
      row(1, 3.833333, 0.013889),
      row(2, 3.0, 0.0),
      row(3, 3.0, 0.166667),
      row(4, 3.0, 1.0, 2),
      row(5, 2.75, 0.541667),
      row(6, 3.0, 0.0, 1),
      row(7, null, null, 0),
      row(8, 4.0, 0.0),
      row(9, 1.166667, 0.013889),
      row(10, 2.666667, 1.555556),
    ];
    expect(rankApplicants(fixture).map((r) => r.sourceRowIndex)).toEqual([
      8, 1, 2, 6, 3, 4, 5, 10, 9, 7,
    ]);
  });

  it("sorts an applicant with no complete review last, not as a zero", () => {
    // A zero average would rank above nobody but would still be a number; the
    // point is that it sits below every real score AND is never mistaken for
    // one.
    const ranked = rankApplicants([row(1, null, null, 0), row(2, 1.0, 0)]);
    expect(ranked.map((r) => r.sourceRowIndex)).toEqual([2, 1]);
  });

  it("case 9: sorts on the unrounded value, not the displayed one", () => {
    // Both render as "3.00" at two decimals. They are not tied.
    const ranked = rankApplicants([row(1, 3.001, 0.5), row(2, 3.002, 0.9)]);
    expect(ranked.map((r) => r.sourceRowIndex)).toEqual([2, 1]);
  });

  it("does not reorder the caller's array in place", () => {
    const original = [row(1, 1.0, 0), row(2, 4.0, 0)];
    rankApplicants(original);
    expect(original.map((r) => r.sourceRowIndex)).toEqual([1, 2]);
  });

  it("is stable across repeated calls on equivalent input", () => {
    // The property decision 42 exists for: two renders of the same page must
    // not disagree. Shuffled input, identical output.
    const rows = [row(3, 3.0, 0), row(1, 3.0, 0), row(2, 3.0, 0)];
    const first = rankApplicants(rows).map((r) => r.sourceRowIndex);
    const second = rankApplicants([...rows].reverse()).map((r) => r.sourceRowIndex);
    expect(first).toEqual([1, 2, 3]);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const TARGET = 3;
const off = { incompleteOnly: false, minVariance: null };

describe("applyResultFilters", () => {
  it("is a no-op when both filters are off", () => {
    const rows = [row(1, 3.0, 0.0), row(2, null, null, 0)];
    expect(applyResultFilters(rows, off, TARGET)).toHaveLength(2);
  });

  it("incomplete finds every applicant under the target, including zero", () => {
    const rows = [row(1, 3.0, 0.0, 3), row(2, 3.0, 1.0, 2), row(3, 3.0, 0.0, 1), row(4, null, null, 0)];
    const found = applyResultFilters(rows, { ...off, incompleteOnly: true }, TARGET);
    expect(found.map((r) => r.sourceRowIndex)).toEqual([2, 3, 4]);
  });

  it("case 9: the variance threshold is inclusive at the boundary", () => {
    // An admin typing 0.5 means "0.5 and up". A strict > would hide exactly the
    // applicant they typed the number to find.
    const rows = [row(1, 3.0, 0.5), row(2, 3.0, 0.4999)];
    const found = applyResultFilters(rows, { ...off, minVariance: 0.5 }, TARGET);
    expect(found.map((r) => r.sourceRowIndex)).toEqual([1]);
  });

  it("case 10: a threshold of zero matches everything with a defined variance", () => {
    const rows = [row(1, 3.0, 0.0), row(2, 3.0, 1.5)];
    expect(applyResultFilters(rows, { ...off, minVariance: 0 }, TARGET)).toHaveLength(2);
  });

  it("case 11: an undefined variance never matches, at any threshold including 0", () => {
    // The applicant nobody read is neither low-variance nor high-variance. They
    // are found by the incomplete filter, which is the one about them.
    const rows = [row(1, null, null, 0)];
    expect(applyResultFilters(rows, { ...off, minVariance: 0 }, TARGET)).toEqual([]);
    expect(applyResultFilters(rows, { ...off, minVariance: 5 }, TARGET)).toEqual([]);
  });

  it("case 12: the two filters compose with AND", () => {
    const rows = [
      row(1, 3.0, 1.0, 3), // high variance, complete
      row(2, 3.0, 0.0, 2), // incomplete, low variance
      row(3, 3.0, 1.0, 2), // both
    ];
    const found = applyResultFilters(
      rows,
      { incompleteOnly: true, minVariance: 0.5 },
      TARGET,
    );
    expect(found.map((r) => r.sourceRowIndex)).toEqual([3]);
  });

  it("measures incompleteness against the given target, not a hardcoded 3", () => {
    // On a roster too small to reach three, the target is smaller and an
    // applicant at 2/2 is complete. A literal 3 would report the whole cohort
    // as incomplete.
    const rows = [row(1, 3.0, 0.0, 2)];
    expect(applyResultFilters(rows, { ...off, incompleteOnly: true }, 2)).toEqual([]);
    expect(applyResultFilters(rows, { ...off, incompleteOnly: true }, 3)).toHaveLength(1);
  });
});

describe("isUnderTarget", () => {
  it("marks anything below the target", () => {
    expect(isUnderTarget(3, 3)).toBe(false);
    expect(isUnderTarget(2, 3)).toBe(true);
    expect(isUnderTarget(0, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

describe("formatting", () => {
  it("case 13: renders a missing number as an em-dash, never as zero", () => {
    expect(formatAverage(null)).toBe("—");
    expect(formatVariance(null)).toBe("—");
  });

  it("renders an average to two decimals", () => {
    expect(formatAverage(3.833333)).toBe("3.83");
    expect(formatAverage(3)).toBe("3.00");
  });

  it("renders a variance to three, so near-zero is not shown as zero", () => {
    // Two decimals would collapse 0.0139 and 0.0000 into "0.01" and "0.00" —
    // and worse, 0.0004 into "0.00", which is the column claiming perfect
    // agreement it did not measure.
    expect(formatVariance(0.013889)).toBe("0.014");
    expect(formatVariance(0)).toBe("0.000");
    expect(formatVariance(1.555556)).toBe("1.556");
  });
});

describe("parseVarianceThreshold", () => {
  it("treats absent, empty and whitespace as off", () => {
    expect(parseVarianceThreshold(undefined)).toBeNull();
    expect(parseVarianceThreshold(null)).toBeNull();
    expect(parseVarianceThreshold("")).toBeNull();
    expect(parseVarianceThreshold("   ")).toBeNull();
  });

  it("treats a malformed value as off rather than as an error", () => {
    // This arrives from a URL anyone can edit. Rendering the unfiltered page
    // beats rendering a failure.
    expect(parseVarianceThreshold("abc")).toBeNull();
    expect(parseVarianceThreshold("1.2.3")).toBeNull();
  });

  it("accepts a real threshold, including zero", () => {
    expect(parseVarianceThreshold("0")).toBe(0);
    expect(parseVarianceThreshold("0.5")).toBe(0.5);
    expect(parseVarianceThreshold(" 1.25 ")).toBe(1.25);
  });
});

// ---------------------------------------------------------------------------
// FR-15 — the first round
// ---------------------------------------------------------------------------

describe("firstRoundSummary", () => {
  it("excludes skips from both numerator and denominator", () => {
    // FR-15's central sentence. Eleven reviewers on the roster, four voted:
    // 3 yes, 1 no. The seven who did not vote are invisible to the arithmetic —
    // FR-14 writes no SKIP row, so a skip is a reviewer who is simply absent.
    expect(firstRoundSummary({ yesCount: 3, noCount: 1 })).toEqual({
      yesCount: 3,
      noCount: 1,
      nonSkipCount: 4,
      yesPercent: 0.75,
    });
  });

  it("reports 2/2 and 14/14 as the same percentage but different counts", () => {
    // The reason FR-15 requires the raw counts beside the percentage.
    const small = firstRoundSummary({ yesCount: 2, noCount: 0 });
    const large = firstRoundSummary({ yesCount: 14, noCount: 0 });

    expect(small.yesPercent).toBe(1);
    expect(large.yesPercent).toBe(1);
    expect(small.nonSkipCount).toBe(2);
    expect(large.nonSkipCount).toBe(14);
  });

  it("gives an applicant nobody voted on a null percentage, never zero", () => {
    // A zero would sort as the worst possible result and read as unanimous
    // rejection. It means nothing was recorded at all.
    expect(firstRoundSummary({ yesCount: 0, noCount: 0 }).yesPercent).toBeNull();
  });

  it("distinguishes that from a genuine unanimous no", () => {
    expect(firstRoundSummary({ yesCount: 0, noCount: 5 }).yesPercent).toBe(0);
  });
});

describe("rankFirstRound", () => {
  const row = (sourceRowIndex: number, yesCount: number, noCount: number) => ({
    sourceRowIndex,
    ...firstRoundSummary({ yesCount, noCount }),
  });

  it("ranks by yes percentage descending", () => {
    const ranked = rankFirstRound([row(1, 1, 3), row(2, 3, 1), row(3, 2, 2)]);
    expect(ranked.map((r) => r.sourceRowIndex)).toEqual([2, 3, 1]);
  });

  it("breaks a percentage tie on raw non-skip count, descending", () => {
    // Decision 46: 6/6 is a stronger signal than 2/2 at the same 100%.
    const ranked = rankFirstRound([row(1, 2, 0), row(2, 6, 0), row(3, 4, 0)]);
    expect(ranked.map((r) => r.sourceRowIndex)).toEqual([2, 3, 1]);
  });

  it("falls back to sourceRowIndex ascending when both keys tie", () => {
    const ranked = rankFirstRound([row(9, 3, 1), row(2, 3, 1), row(5, 3, 1)]);
    expect(ranked.map((r) => r.sourceRowIndex)).toEqual([2, 5, 9]);
  });

  it("sorts an applicant nobody voted on last, below a unanimous no", () => {
    // The case that would go wrong if null were treated as 0%.
    const ranked = rankFirstRound([row(1, 0, 0), row(2, 0, 4), row(3, 1, 3)]);
    expect(ranked.map((r) => r.sourceRowIndex)).toEqual([3, 2, 1]);
  });

  it("does not reorder the caller's array", () => {
    const rows = [row(1, 1, 1), row(2, 2, 0)];
    const before = rows.map((r) => r.sourceRowIndex);
    rankFirstRound(rows);
    expect(rows.map((r) => r.sourceRowIndex)).toEqual(before);
  });

  it("is a total order — equal rows never compare as equivalent", () => {
    // sourceRowIndex is unique per instance, so no two rows can tie on all
    // three keys. A comparator returning 0 for non-equivalent pairs would let
    // two renders of the same page disagree about row order.
    const ranked = rankFirstRound([row(3, 1, 1), row(1, 1, 1), row(2, 1, 1)]);
    expect(ranked.map((r) => r.sourceRowIndex)).toEqual([1, 2, 3]);
  });
});

describe("hasNoVotes and formatYesPercent", () => {
  it("marks literal zero only", () => {
    // Decision 46: no fixed target to fall short of here, unlike FR-10's 3/3.
    expect(hasNoVotes(0)).toBe(true);
    expect(hasNoVotes(1)).toBe(false);
    expect(hasNoVotes(11)).toBe(false);
  });

  it("renders a null percentage as an em-dash, never 0%", () => {
    expect(formatYesPercent(null)).toBe("—");
    expect(formatYesPercent(0)).toBe("0%");
    expect(formatYesPercent(0.75)).toBe("75%");
    expect(formatYesPercent(1)).toBe("100%");
  });

  it("rounds to whole percents", () => {
    // 2 of 3 is 66.67%; the column is read at a glance, not audited.
    expect(formatYesPercent(2 / 3)).toBe("67%");
  });
});
