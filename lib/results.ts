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

// ---------------------------------------------------------------------------
// FR-15's arithmetic — the first round
// ---------------------------------------------------------------------------
//
// Beside FR-10's rather than in a module of its own, because the file's own
// header anticipated it: "FR-15 already says first-round results mirror this
// behaviour, so there will be a second surface." The two rounds rank on
// different numbers — an average of scores against a percentage of votes — but
// they are the same kind of thing and a successor looking for one will look here
// for the other.

/// One applicant's first-round votes, already reduced to counts.
///
/// **Skips are not represented**, which is the point. FR-14 writes no SKIP row —
/// the absence of a vote IS the skip — so a skip is simply a reviewer who does
/// not appear in either count. Carrying a `skipCount` would invite someone to
/// put it in a denominator.
export interface FirstRoundTally {
  yesCount: number;
  noCount: number;
}

export interface FirstRoundSummary {
  yesCount: number;
  noCount: number;
  /// yes + no. The number FR-15 requires shown beside the percentage, because
  /// "2/2 and 14/14 are not the same signal".
  nonSkipCount: number;
  /// `yes / (yes + no)`, or **null when nobody voted**.
  ///
  /// Null rather than 0: a zero would sort as the worst possible result and read
  /// as unanimous rejection, when it means nothing was recorded at all. The same
  /// distinction `scoreSummary` draws for an unreviewed applicant, for the same
  /// reason.
  yesPercent: number | null;
}

/// FR-15: "yes% = yes / (yes + no), skips excluded from both numerator and
/// denominator."
export function firstRoundSummary(tally: FirstRoundTally): FirstRoundSummary {
  const nonSkipCount = tally.yesCount + tally.noCount;
  return {
    yesCount: tally.yesCount,
    noCount: tally.noCount,
    nonSkipCount,
    yesPercent: nonSkipCount === 0 ? null : tally.yesCount / nonSkipCount,
  };
}

export interface RankableFirstRoundApplicant {
  sourceRowIndex: number;
  yesPercent: number | null;
  nonSkipCount: number;
}

/// FR-15's ranking, with PRD decision 46's tiebreak.
///
/// Yes percentage descending, then **raw non-skip count descending** — a 6/6
/// unanimous yes is a stronger signal than a 2/2 one at the same percentage and
/// the ranking should say so — then `sourceRowIndex` ascending, which is
/// arbitrary with respect to the applicant and is what makes it fair as a last
/// resort. Same third key as decision 42 uses for FR-10.
///
/// **An applicant nobody voted on sorts last**, below every real percentage,
/// rather than being treated as 0% and mixed in with unanimous rejections.
/// Comparing null as -Infinity does that with no special case and keeps the
/// comparator total, which matters because a comparator returning 0 for pairs
/// that are not equivalent lets two renders of the same page disagree.
///
/// Returns a new array; the caller's is not reordered in place.
export function rankFirstRound<T extends RankableFirstRoundApplicant>(rows: readonly T[]): T[] {
  return [...rows].sort(compareFirstRound);
}

function compareFirstRound(
  a: RankableFirstRoundApplicant,
  b: RankableFirstRoundApplicant,
): number {
  const percentA = a.yesPercent ?? Number.NEGATIVE_INFINITY;
  const percentB = b.yesPercent ?? Number.NEGATIVE_INFINITY;
  if (percentA !== percentB) return percentB - percentA;

  if (a.nonSkipCount !== b.nonSkipCount) return b.nonSkipCount - a.nonSkipCount;

  return a.sourceRowIndex - b.sourceRowIndex;
}

/// Whether the vote-count cell carries FR-15's marker.
///
/// **On the cell, not the row**, exactly as FR-10's under-target marker is. And
/// **literal zero**, not a threshold: decision 46 is explicit that there is no
/// fixed target here to fall short of, unlike the written round's 3/3.
export function hasNoVotes(nonSkipCount: number): boolean {
  return nonSkipCount === 0;
}

/// Here rather than in the component, so the em-dash rule is covered by the same
/// tests as the arithmetic. A null rendered as "0%" is the single most
/// misleading thing this page could do — it would read as a unanimous rejection
/// of someone nobody assessed.
export function formatYesPercent(yesPercent: number | null): string {
  return yesPercent === null ? "—" : `${Math.round(yesPercent * 100)}%`;
}
