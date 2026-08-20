// Assignments and written scores for the seed fixture.
//
// Both were "deliberately absent" until now, on the grounds that phases 2, 3
// and 6 would specify their shape and inventing one early would let a wrong one
// harden. Phases 2 and 3 have shipped, so that reasoning has expired for these
// two; it still holds for passes, votes and decisions, which is why they are
// still not here.
//
// Pure — no database access and no Prisma client. This module returns rows and
// prisma/seed.ts writes them, which is what lets the fixture arithmetic below be
// checked by reading rather than by querying.

import { generateAssignments, planShape } from "../../lib/assignment";
import type { Rng } from "../../lib/rng";

export interface AssignmentRow {
  id: string;
  applicantId: string;
  reviewerId: string;
}

export interface ScoreRow {
  assignmentId: string;
  rubricCategoryId: string;
  points: number;
}

export interface NoteRow {
  assignmentId: string;
  body: string;
}

/// Its own seed rather than a draw from the shared `rng`.
///
/// prisma/seed.ts threads one generator through applicant generation and then
/// reviewer generation, so reviewer names depend on applicants having consumed
/// exactly the same number of draws. Taking scores from that same generator
/// would be safe only as long as nothing above ever moved. A separate seed makes
/// score generation unable to rename a single reviewer, which matters because
/// every screenshot and bookmark from Phase 3 names them.
const SCORES_RNG_SEED = 20260819;

/// The tie-break in `generateAssignments`, chosen by the search in
/// `buildAssignments` rather than written down.
///
/// **Why a search and not a constant.** The generator holds ~5% of slots open on
/// applicants it picks by shuffle, and it does not know that ten particular rows
/// carry a hand-authored fixture. A hardcoded seed therefore works until the
/// roster, the applicant count, or the fixture changes, and then fails with the
/// pool sitting on a case that needs three reviewers — which is exactly what the
/// first attempt at this did. Searching states the requirement instead of
/// encoding one lucky answer, and the result is still deterministic: the same
/// inputs always find the same seed, because the candidates are tried in order.
const ASSIGNMENT_SEED_CANDIDATES = 200;

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/// FR-7's generator, called exactly as the admin's Generate button calls it, so
/// the seed and the app cannot disagree about the shape of a round.
///
/// At 150 applicants and 30 written reviewers this produces the documented
/// figures in ./roster.ts: 450 slots, a pool of 22, and 428 assignments across
/// 128 applicants holding three reviewers and 22 holding two.
export function buildAssignments(
  applicantIds: readonly string[],
  reviewers: readonly { id: string; isSparklet: boolean }[],
  assignmentId: (index: number) => string,
  /// Applicants the pool must not land on, because the fixture below needs them
  /// staffed to the full target. Everyone else is fair game, so the ~5% pool is
  /// still spread across the cohort rather than pushed to one end of it.
  requireFullTarget: ReadonlySet<string> = new Set(),
): { rows: AssignmentRow[]; pooledApplicantIds: string[]; seed: number } {
  for (let seed = 1; seed <= ASSIGNMENT_SEED_CANDIDATES; seed += 1) {
    const plan = generateAssignments({ applicantIds, reviewers, seed });

    // FR-7's precheck, asserted rather than assumed. 30 reviewers with 8
    // Sparklets clears it comfortably; checking means a future edit to
    // ./roster.ts that stops clearing it fails here, with the report's own
    // message, rather than producing a quietly malformed fixture. Seed-
    // independent, so a failure here ends the search rather than continuing it.
    if (!plan.report.feasible) {
      throw new Error(`Seed roster is not assignable: ${plan.report.message ?? "no reason given"}`);
    }

    // Empty by construction: the seed passes no preserved rows, so there is
    // nothing generation could have inherited a violation from.
    if (plan.preexistingViolations.length > 0) {
      throw new Error(
        `Seed assignment generation reported ${plan.preexistingViolations.length} violation(s): ` +
          plan.preexistingViolations.map((violation) => violation.detail).join("; "),
      );
    }

    if (plan.pooledApplicantIds.some((id) => requireFullTarget.has(id))) continue;

    return {
      rows: plan.assignments.map((pair, index) => ({
        id: assignmentId(index),
        applicantId: pair.applicantId,
        reviewerId: pair.reviewerId,
      })),
      pooledApplicantIds: plan.pooledApplicantIds,
      seed,
    };
  }

  throw new Error(
    `No assignment seed in 1..${ASSIGNMENT_SEED_CANDIDATES} left all ${requireFullTarget.size} ` +
      `fixture applicants at the full target. Either the fixture now needs more fully-staffed ` +
      `applicants than the pool can avoid, or the roster shrank.`,
  );
}

/// The fixture applicants that need every one of their target slots filled —
/// the ones whose worked case has three reviewer averages. Cases with one or two
/// reviewers are unaffected by pooling, since review count is completed reviews
/// over the *target* rather than over however many reviewers were assigned.
export function fullTargetRowIndexes(): number[] {
  const shape = planShape(1, 3);
  return FIXTURE_ROW_INDEXES.filter((row) => (FIXTURE[row] ?? []).length >= shape.target);
}

// ---------------------------------------------------------------------------
// The hand-authored fixture — plans/phase-4.md, FR-10's worked cases
// ---------------------------------------------------------------------------

/// One entry per reviewer, each holding that reviewer's score in every rubric
/// category. An applicant with fewer entries than assignments has the remainder
/// left unscored, which is how "2/3" and "1/3" are produced — review count
/// counts *completed* reviews, per PRD decision 1, so an assignment nobody
/// finished simply does not contribute.
///
/// Keyed by `sourceRowIndex`, 1-based, so the ten fixture applicants are the ten
/// an admin sees first if they sort by applicant number. **These are the numbers
/// the BUILD_PLAN gate is checked against by hand.** If the results page
/// disagrees with the expectations in the comment below, the page is wrong.
///
///   row  reviewer averages          average   variance   count
///   ---  -------------------------  --------  ---------  -----
///    8   4.00, 4.00, 4.00           4.0000    0.0000     3/3     rank 1
///    1   4.00, 3.75, 3.75           3.8333    0.0139     3/3     rank 2
///    2   3.00, 3.00, 3.00           3.0000    0.0000     3/3     rank 3
///    6   3.00                       3.0000    0.0000     1/3     rank 4
///    3   3.50, 3.00, 2.50           3.0000    0.1667     3/3     rank 5
///    4   4.00, 2.00                 3.0000    1.0000     2/3     rank 6
///    5   3.75, 2.50, 2.00           2.7500    0.5417     3/3     rank 7
///   10   4.00, 1.00, 3.00           2.6667    1.5556     3/3     rank 8
///    9   1.00, 1.25, 1.25           1.1667    0.0139     3/3     rank 9
///    7   (none complete)            —         —          0/3     last
///
/// Rows 2 and 6 tie on both of FR-10's stated keys and are separated by decision
/// 42's third key, `sourceRowIndex` ascending — which is why row 2 ranks above
/// row 6 and why this fixture is the thing that proves the third key exists.
const FIXTURE: Record<number, readonly (readonly number[])[]> = {
  1: [
    [4, 4, 4, 4],
    [4, 4, 3, 4],
    [4, 3, 4, 4],
  ],
  2: [
    [3, 3, 3, 3],
    [3, 3, 3, 3],
    [3, 3, 3, 3],
  ],
  3: [
    [4, 4, 3, 3],
    [3, 3, 3, 3],
    [2, 3, 2, 3],
  ],
  // Two reviewers. The third assignment is left entirely unscored.
  4: [
    [4, 4, 4, 4],
    [2, 2, 2, 2],
  ],
  5: [
    [4, 4, 4, 3],
    [3, 3, 2, 2],
    [2, 2, 2, 2],
  ],
  // One reviewer. Variance is a true zero and reads as perfect agreement; only
  // the marked count cell says otherwise.
  6: [[3, 3, 3, 3]],
  // Nobody finished. Average and variance are undefined rather than zero, and
  // this is the applicant FR-11's finalize confirmation has to name.
  7: [],
  8: [
    [4, 4, 4, 4],
    [4, 4, 4, 4],
    [4, 4, 4, 4],
  ],
  9: [
    [1, 1, 1, 1],
    [1, 1, 1, 2],
    [1, 2, 1, 1],
  ],
  // The high-variance outlier, so the threshold filter has an unambiguous target.
  10: [
    [4, 4, 4, 4],
    [1, 1, 1, 1],
    [3, 3, 3, 3],
  ],
};

export const FIXTURE_ROW_INDEXES = Object.keys(FIXTURE).map(Number);

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/// How often a non-fixture assignment is left part-scored rather than finished.
/// Enough that FR-10's incomplete filter has something to find beyond the 22
/// pooled applicants, which is the case PRD decision 1 warns about: returns add
/// pool slots over the course of the round, so the incomplete set is not the
/// initial 22.
const P_PARTIAL_REVIEW = 0.06;

/// How often an applicant's reviewers are made to disagree sharply, rather than
/// clustering within a point. Roughly one applicant in six, so the high-variance
/// filter is exercised against a real population rather than one planted row.
const P_CONTENTIOUS = 0.16;

export function buildScores(
  assignments: readonly AssignmentRow[],
  rowIndexByApplicantId: ReadonlyMap<string, number>,
  categories: readonly { id: string; minPoints: number; maxPoints: number }[],
  rng: Rng,
): ScoreRow[] {
  const byApplicant = new Map<string, AssignmentRow[]>();
  for (const assignment of assignments) {
    const list = byApplicant.get(assignment.applicantId) ?? [];
    list.push(assignment);
    byApplicant.set(assignment.applicantId, list);
  }

  const rows: ScoreRow[] = [];
  const push = (assignmentId: string, points: readonly number[]) => {
    points.forEach((value, index) => {
      const category = categories[index];
      if (!category) return;
      rows.push({ assignmentId, rubricCategoryId: category.id, points: value });
    });
  };

  // Sorted so generation order does not depend on Map iteration order, which
  // would make the fixture non-reproducible for no benefit.
  const applicantIds = [...byApplicant.keys()].sort();

  for (const applicantId of applicantIds) {
    const mine = byApplicant.get(applicantId) ?? [];
    const rowIndex = rowIndexByApplicantId.get(applicantId);
    const fixture = rowIndex === undefined ? undefined : FIXTURE[rowIndex];

    if (fixture) {
      if (fixture.length > mine.length) {
        throw new Error(
          `Fixture applicant at sourceRowIndex ${rowIndex} needs ${fixture.length} complete ` +
            `review(s) but was assigned only ${mine.length} reviewer(s). The unassigned pool ` +
            `landed on it. Change ASSIGNMENT_SEED in prisma/seed/reviews.ts, or move the case ` +
            `to a row index that is not pooled.`,
        );
      }
      fixture.forEach((points, index) => push(mine[index].id, points));
      continue;
    }

    // Everyone else. A "true quality" per applicant, then per-reviewer noise
    // around it, so averages spread across the whole scale and reviewers
    // sometimes disagree — rather than 140 rows that all look alike and prove
    // nothing about the ranking.
    const contentious = rng.chance(P_CONTENTIOUS);
    const spread = contentious ? 2 : 1;

    for (const assignment of mine) {
      const partial = rng.chance(P_PARTIAL_REVIEW);
      const scored = partial ? rng.int(1, categories.length - 1) : categories.length;

      const points: number[] = [];
      for (let index = 0; index < scored; index += 1) {
        const category = categories[index];
        const base = rng.int(category.minPoints, category.maxPoints);
        const noise = rng.int(-spread, spread);
        points.push(clamp(base + noise, category.minPoints, category.maxPoints));
      }
      push(assignment.id, points);
    }
  }

  return rows;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// ---------------------------------------------------------------------------
// Review notes
// ---------------------------------------------------------------------------

/// Illustrative synthetic prose. Deliberately in the register a real reviewer
/// writes in — a clause about the application and a clause about the doubt —
/// rather than lorem ipsum, because FR-10's admin view is read by a person
/// deciding whether the score in front of them is trustworthy, and placeholder
/// text cannot show whether that screen works.
const NOTE_OPENERS = [
  "Strong on the founding story",
  "Clear writing throughout",
  "Genuinely unusual project",
  "Good energy, thin on specifics",
  "Solid all round",
  "Answers the question asked",
  "Real follow-through here",
  "Interesting background",
] as const;

const NOTE_CLOSERS = [
  "but the Spark fit answer could be any club.",
  "and they name the unglamorous half of the work.",
  "though nothing they list has an outcome attached.",
  "so I would want to hear them talk it through.",
  "and the timeline holds up on a second read.",
  "but I could not tell what they actually did.",
  "— scored down on clarity, not on substance.",
  "and I would be glad to interview them.",
] as const;

/// How often a completed review carries a note.
///
/// **Not 100%.** FR-9 makes the note optional and `ReviewNote` is a separate
/// row, so "this reviewer scored but did not write" is a state the admin view
/// has to render — and a fixture where every review has a note would never show
/// it. Not 0% either, which is what the seed did before this and which left
/// FR-10's "scores **and** notes" clause rendering an empty state on every card.
const P_HAS_NOTE = 0.72;

export function buildNotes(
  scores: readonly ScoreRow[],
  categoryCount: number,
  rng: Rng,
): NoteRow[] {
  // Only completed reviews get notes. A reviewer who stopped halfway has not
  // reached the note, which sits under the score inputs on FR-9's screen.
  const scoredByAssignment = new Map<string, number>();
  for (const score of scores) {
    scoredByAssignment.set(
      score.assignmentId,
      (scoredByAssignment.get(score.assignmentId) ?? 0) + 1,
    );
  }

  const rows: NoteRow[] = [];
  for (const assignmentId of [...scoredByAssignment.keys()].sort()) {
    if (scoredByAssignment.get(assignmentId) !== categoryCount) continue;
    if (!rng.chance(P_HAS_NOTE)) continue;
    rows.push({
      assignmentId,
      body: `${rng.pick(NOTE_OPENERS)} ${rng.pick(NOTE_CLOSERS)}`,
    });
  }
  return rows;
}

export function createScoresRng(createRng: (seed: number) => Rng): Rng {
  return createRng(SCORES_RNG_SEED);
}

/// Re-exported so prisma/seed.ts can print the shape it just wrote without
/// re-deriving it. `planShape` is FR-7's arithmetic and stays the only place
/// any of these numbers is computed.
export { planShape };
