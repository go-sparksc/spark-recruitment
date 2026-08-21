// FR-16's page assembly. Pure — no database, no Prisma client.
//
// Here rather than in the page for the reason CLAUDE.md's testing note gives:
// twice in Phase 5 a page assembled correct pure functions incorrectly, and
// neither the pure suites nor the clause ledger could see it. Everything between
// "what the query returned" and "what the profile renders" lives here, and the
// page keeps only the query.
//
// The resolution state machine is NOT here. That is lib/passes.ts, which knows
// nothing about rendering; this module knows nothing about resolution.

import { AssignmentStatus } from "@/generated/prisma/enums";
import { reviewerAverage, scoreSummary, type ScoreSummary } from "@/lib/results";

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface SecondRoundListRow {
  applicantId: string;
  displayName: string;
  sourceRowIndex: number;
  /// This reviewer's own conflict on this applicant. Sticky across every pass
  /// (FR-16), so it is a property of the round rather than of any pass.
  hasConflict: boolean;
  /// Clause 12q again: the profile renders whichever half of the FR-12 import
  /// exists, so the row can say so before anyone opens it.
  interviewResultCount: number;
  hasInterviewNotes: boolean;
}

export interface SecondRoundListSource {
  id: string;
  displayName: string;
  sourceRowIndex: number;
  /// This reviewer's conflict rows for this applicant — at most one, since
  /// `ConflictOfInterest` is unique on `(round, applicantId, reviewerId)`. An
  /// array because that is the shape a scoped Prisma include returns.
  conflicts: readonly unknown[];
  interviewResultCount: number;
  hasInterviewNotes: boolean;
}

export function toSecondRoundListRow(source: SecondRoundListSource): SecondRoundListRow {
  return {
    applicantId: source.id,
    // §6: a second-round reviewer sees the name. They are about to argue about
    // this person in a room; `resolvePromoted` blinds the written round only.
    displayName: source.displayName,
    sourceRowIndex: source.sourceRowIndex,
    hasConflict: source.conflicts.length > 0,
    interviewResultCount: source.interviewResultCount,
    hasInterviewNotes: source.hasInterviewNotes,
  };
}

/// How many of this list the reviewer has recused from.
///
/// Here rather than in the component because it is the number the header uses
/// to explain a shorter votable list later, and a second count derived a second
/// way would drift from the rows under it.
export function conflictCount(rows: readonly SecondRoundListRow[]): number {
  return rows.filter((row) => row.hasConflict).length;
}

// ---------------------------------------------------------------------------
// Written scores, for the profile
// ---------------------------------------------------------------------------

export interface WrittenReviewSource {
  id: string;
  status: AssignmentStatus;
  reviewer: { firstName: string; lastName: string; isSparklet: boolean };
  scores: readonly { rubricCategoryId: string; points: number }[];
  note: { body: string } | null;
}

export interface WrittenReviewCard {
  assignmentId: string;
  /// Decision 77: attributed, not anonymized. FR-14 names the interviewer and
  /// FR-11's admin view names the written reviewer; anonymizing here would make
  /// this the only surface in the product that hides a scorer, and in a
  /// deliberation the point of knowing who gave the 2 is that they are in the
  /// room to be asked why.
  reviewerName: string;
  isSparklet: boolean;
  /// Null where the review is incomplete — `reviewerAverage`'s rule, not a
  /// second one. A mean over two of four categories is not comparable with a
  /// mean over four and must not render as though it were.
  average: number | null;
  /// Points per live rubric category, in the caller's category order. Null is an
  /// unscored category, which is the absence of a `Score` row and never a zero.
  points: (number | null)[];
  scoredCount: number;
  /// Decision 77's second half: the written reviewer's own reasoning, which
  /// FR-16's list omitted and which is the most useful thing on this card.
  note: string | null;
}

export interface WrittenReviews {
  cards: WrittenReviewCard[];
  /// Across the completed reviews only, exactly as FR-10 computes it.
  summary: ScoreSummary;
  /// Assignments that exist but were handed back. Counted, never rendered as a
  /// review: a returned assignment produced no opinion, and showing the reviewer
  /// who recused would leak a recusal to the room.
  returnedCount: number;
}

/// The written round's evidence, shaped for one applicant's profile.
///
/// **Returned assignments are excluded from everything.** They are not a review,
/// their scores (if any) were given before the reviewer recognized the
/// applicant, and FR-10 already treats them this way. They are counted so the
/// profile can say "2 of 3 reviewed" honestly rather than silently showing two.
export function buildWrittenReviews(
  assignments: readonly WrittenReviewSource[],
  categoryIds: readonly string[],
): WrittenReviews {
  const active = assignments.filter(
    (assignment) => assignment.status === AssignmentStatus.ACTIVE,
  );

  const cards = active.map((assignment) => {
    const byCategory = new Map(
      assignment.scores.map((score) => [score.rubricCategoryId, score.points]),
    );

    return {
      assignmentId: assignment.id,
      reviewerName: `${assignment.reviewer.firstName} ${assignment.reviewer.lastName}`,
      isSparklet: assignment.reviewer.isSparklet,
      average: reviewerAverage(
        assignment.scores.map((score) => score.points),
        categoryIds.length,
      ),
      points: categoryIds.map((id) => byCategory.get(id) ?? null),
      // Counted over the LIVE rubric, matching `completionOf`: a score against a
      // category no longer in the rubric contributes nothing.
      scoredCount: categoryIds.filter((id) => byCategory.has(id)).length,
      note: assignment.note?.body ?? null,
    };
  });

  return {
    cards,
    summary: scoreSummary(
      cards.map((card) => card.average).filter((value): value is number => value !== null),
    ),
    returnedCount: assignments.length - active.length,
  };
}

// ---------------------------------------------------------------------------
// Interview scores, for the profile
// ---------------------------------------------------------------------------

export interface InterviewResultSource {
  id: string;
  interviewerName: string;
  score: number;
  categoryScores: readonly { interviewCategoryId: string; points: number }[];
}

export interface InterviewCard {
  resultId: string;
  interviewerName: string;
  /// `InterviewResult.score`, imported verbatim. Never recomputed here — if it
  /// disagrees with the mean of the categories below, the sheet wins, because
  /// that is the number the interviewers actually recorded.
  score: number;
  points: (number | null)[];
}

/// One card per interviewer, points aligned to the configured categories.
///
/// **The category count follows the configured rows**, per clause 14e, which
/// applies here for the same reason it applied to FR-14: four in S26, and
/// nothing may assume it.
export function buildInterviewCards(
  results: readonly InterviewResultSource[],
  categoryIds: readonly string[],
): InterviewCard[] {
  return results.map((result) => {
    const byCategory = new Map(
      result.categoryScores.map((score) => [score.interviewCategoryId, score.points]),
    );

    return {
      resultId: result.id,
      interviewerName: result.interviewerName,
      score: result.score,
      points: categoryIds.map((id) => byCategory.get(id) ?? null),
    };
  });
}
