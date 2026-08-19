// FR-10's arithmetic. Pure — no database, no Prisma client.
//
// Same posture as lib/assignment.ts, lib/passes.ts, lib/roster.ts and
// lib/review.ts: the part of the phase that can actually be verified lives here,
// away from the surface that renders it. BUILD_PLAN's Phase 4 gate is "ranking
// matches a hand calculation on ten synthetic applicants", and the cases in
// lib/results.test.ts are that calculation written down.
//
// Every rule below is a rule the page must not be free to reinterpret. Inlined
// into a server component, each becomes a place a second surface can disagree —
// and FR-15 already says first-round results mirror this behaviour, so there
// will be a second surface.

/// Everything ranking and filtering need, and nothing else. Deliberately not the
/// row type the page renders: this is the shape the rules operate on, so the
/// tests can build one from three numbers rather than from an applicant.
export interface RankableApplicant {
  /// Decision 42's third sort key. Stable, never renumbered, and carrying no
  /// alphabetical bias — which is the property that makes it usable as a
  /// tie-break in a list someone reads top-down to decide who gets in.
  sourceRowIndex: number;
  /// Null when no review is complete. See `scoreSummary`.
  average: number | null;
  variance: number | null;
  completedCount: number;
}

// ---------------------------------------------------------------------------
// One reviewer's contribution
// ---------------------------------------------------------------------------

/// The mean of one reviewer's scores across the live rubric.
///
/// **Null unless the review is complete**, which is PRD decision 1's sense of
/// "completed reviews" and the reason FR-10 can say "2/3" at all. A reviewer who
/// scored two of four categories has an average over a different denominator
/// than everyone else's, so including it would make one applicant's number
/// incomparable with the next one's while looking exactly as authoritative.
///
/// `categoryCount` is the *live* rubric, matching `completionOf` in lib/review.ts
/// — the same denominator the reviewer's own completion state is measured
/// against, so an applicant cannot read 3/3 on the reviewer's screen and 2/3
/// here.
export function reviewerAverage(
  points: readonly number[],
  categoryCount: number,
): number | null {
  if (categoryCount <= 0) return null;
  if (points.length !== categoryCount) return null;
  return points.reduce((sum, value) => sum + value, 0) / categoryCount;
}

// ---------------------------------------------------------------------------
// FR-10's two numbers
// ---------------------------------------------------------------------------

export interface ScoreSummary {
  average: number | null;
  variance: number | null;
  completedCount: number;
}

/// The average and variance FR-10 ranks on.
///
/// **The average is the mean of the reviewer averages**, not the mean of every
/// raw score. Given that only complete reviews reach here the two coincide
/// exactly, so this fixes which one is authoritative rather than changing any
/// number today.
///
/// **Variance is population variance — divide by k, not k-1.** These three or
/// two numbers are the entire set being measured, not a sample standing in for a
/// larger one, so no bias correction applies. The difference is not cosmetic: on
/// a two-reviewer applicant the sample form doubles the number.
///
/// **Both are null when nothing is complete, and that is not the same as zero.**
/// A zero average would sort like a real low score, and a zero *variance* would
/// read as perfect agreement — the high-variance filter would then quietly pass
/// over the applicant nobody has read, which is the one case that most needs
/// looking at. Null renders as an em-dash and is found by the incomplete filter.
export function scoreSummary(reviewerAverages: readonly number[]): ScoreSummary {
  const completedCount = reviewerAverages.length;
  if (completedCount === 0) return { average: null, variance: null, completedCount: 0 };

  const average = reviewerAverages.reduce((sum, value) => sum + value, 0) / completedCount;
  const variance =
    reviewerAverages.reduce((sum, value) => sum + (value - average) ** 2, 0) / completedCount;

  return { average, variance, completedCount };
}

// ---------------------------------------------------------------------------
// FR-10's ranking
// ---------------------------------------------------------------------------

/// "Applicants ranked by average score descending, then by variance ascending",
/// plus decision 42's `sourceRowIndex` ascending third key.
///
/// **Sorts on the unrounded values.** Display rounds; two applicants are tied
/// only when the underlying numbers are equal, never when their rendered ones
/// match.
///
/// **An applicant with no complete review sorts last**, below every real score,
/// rather than being treated as a zero. Comparing null as -Infinity does that
/// without a special case, and keeps the comparator total — which matters,
/// because a comparator that returns 0 for pairs that are not actually
/// equivalent lets the browser and the server disagree about row order.
///
/// Returns a new array. The caller's is not reordered in place, since a server
/// component may hold it for a second purpose.
export function rankApplicants<T extends RankableApplicant>(rows: readonly T[]): T[] {
  return [...rows].sort(compareForRank);
}

function compareForRank(a: RankableApplicant, b: RankableApplicant): number {
  const averageA = a.average ?? Number.NEGATIVE_INFINITY;
  const averageB = b.average ?? Number.NEGATIVE_INFINITY;
  if (averageA !== averageB) return averageB - averageA;

  // Ascending: closer agreement ranks higher among equal averages. Null sorts
  // last here too, consistently with the average above.
  const varianceA = a.variance ?? Number.POSITIVE_INFINITY;
  const varianceB = b.variance ?? Number.POSITIVE_INFINITY;
  if (varianceA !== varianceB) return varianceA - varianceB;

  return a.sourceRowIndex - b.sourceRowIndex;
}

// ---------------------------------------------------------------------------
// FR-10's two filters
// ---------------------------------------------------------------------------

export interface ResultFilters {
  /// Any applicant under the target number of completed reviews.
  incompleteOnly: boolean;
  /// Null means the filter is off, which is FR-10's default. The threshold is
  /// admin-set at view time and never persisted.
  minVariance: number | null;
}

/// Both filters, composed with AND — they are independent controls and both
/// narrow.
///
/// **The variance threshold is inclusive.** An admin who types 0.5 means "0.5 and
/// up"; a strict `>` would hide the exact-boundary applicant, who is precisely
/// the one they typed the number to find.
///
/// **An undefined variance never matches any threshold, including 0.** The
/// applicant nobody reviewed is not a low-variance applicant and is not a
/// high-variance one; they are found by `incompleteOnly`, which is the filter
/// that is actually about them.
export function applyResultFilters<T extends RankableApplicant>(
  rows: readonly T[],
  filters: ResultFilters,
  target: number,
): T[] {
  return rows.filter((row) => {
    if (filters.incompleteOnly && !isUnderTarget(row.completedCount, target)) return false;
    if (filters.minVariance !== null) {
      if (row.variance === null) return false;
      if (row.variance < filters.minVariance) return false;
    }
    return true;
  });
}

/// Whether the review-count cell carries FR-10's visual marker.
///
/// **On the cell, not the row.** The FR-10 paragraph is explicit: "trust this
/// number less" has to read on the number and not on the applicant as a whole,
/// because an applicant with two thorough reviews is not a worse applicant.
export function isUnderTarget(completedCount: number, target: number): boolean {
  return completedCount < target;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/// Here rather than in the component so the em-dash rule is covered by the same
/// tests as the arithmetic that produces it. A null rendered as "0.00" is the
/// single most misleading thing this page could do.
export function formatAverage(average: number | null): string {
  return average === null ? "—" : average.toFixed(2);
}

/// Three decimals, because two would collapse 0.0139 and 0.0000 into the same
/// string and the whole point of the column is telling agreement from its
/// absence.
export function formatVariance(variance: number | null): string {
  return variance === null ? "—" : variance.toFixed(3);
}

/// Parses the admin's typed threshold. Empty, whitespace, and anything that is
/// not a finite number all mean *off* rather than an error: this arrives from a
/// URL, and a malformed one should render the unfiltered page rather than a
/// failure. Negative values are accepted and simply match everything with a
/// defined variance, which is the same thing 0 does.
export function parseVarianceThreshold(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
