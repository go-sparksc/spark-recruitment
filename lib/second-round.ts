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
//
// `buildWrittenReviews` was here until decision 121 took the written round's
// scores and review notes off this profile. The profile was its only caller, so
// it and its two interfaces were deleted rather than left exported with nothing
// calling them. Reversing 121 means restoring them from git, not rewriting them —
// the decision entry in PRD §10 names the commit.

import { ApplicantStatus } from "@/generated/prisma/enums";
import { outcomeOfStatus, type Outcome } from "@/lib/labels";

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
  /// What the round decided about them, or null while they are still in it.
  /// Decisions 111 and 112: the row persists after a terminal outcome and says
  /// which way it went. Nothing else about the vote is here — no count, no other
  /// reviewer, per decision 74's surviving half.
  outcome: Outcome | null;
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
  status: ApplicantStatus;
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
    outcome: outcomeOfStatus(source.status),
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

/// How many the round has not finished with. Decision 112 keeps resolved
/// applicants on the list, so "how many rows are there" stopped answering "how
/// much is left to do" and the header needs both numbers.
///
/// Here rather than in the page for the same reason `conflictCount` is: it
/// decides which of three sentences the header renders, and a count derived in
/// the component would be a second definition of "still in the round".
export function undecidedCount(rows: readonly SecondRoundListRow[]): number {
  return rows.filter((row) => row.outcome === null).length;
}

// ---------------------------------------------------------------------------
// Interview scores, for the profile
// ---------------------------------------------------------------------------

export interface InterviewResultSource {
  id: string;
  interviewerName: string;
  score: number;
  /// PRD decision 120. See `InterviewCard.scoreIsComputed`.
  scoreIsComputed: boolean;
  note: string | null;
  recommendation: "YES" | "NO" | null;
  categoryScores: readonly {
    interviewCategoryId: string;
    points: number;
    note: string | null;
  }[];
}

export interface InterviewCard {
  resultId: string;
  interviewerName: string;
  /// `InterviewResult.score`, imported verbatim. Never recomputed here — if it
  /// disagrees with the mean of the categories below, the sheet wins, because
  /// that is the number the interviewers actually recorded.
  score: number;
  /// True when the sheet carried no Average column and this score is the mean of
  /// the categories below. PRD decision 120.
  ///
  /// **Every render site must show this.** A computed average that reads like a
  /// recorded one is precisely what decision 6 forbids; the arithmetic itself is
  /// fine. Carried on the card rather than left for a page to look up, so a page
  /// cannot forget to.
  scoreIsComputed: boolean;
  /// This interviewer's overall prose, or null. PRD decision 120.
  note: string | null;
  /// Advisory, and counted by nothing. PRD decision 120.
  recommendation: "YES" | "NO" | null;
  points: (number | null)[];
  /// Aligned to `categoryIds` exactly as `points` is, and independently of it:
  /// a category can have a score and no note, and the two arrays must stay
  /// index-parallel so a page can read `points[i]` and `categoryNotes[i]` as one
  /// row. A note without a score cannot occur — decision 59 writes no row for an
  /// unreadable score, and the note is a column on that row.
  categoryNotes: (string | null)[];
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
    const notesByCategory = new Map(
      result.categoryScores.map((score) => [score.interviewCategoryId, score.note]),
    );

    return {
      resultId: result.id,
      interviewerName: result.interviewerName,
      score: result.score,
      scoreIsComputed: result.scoreIsComputed,
      note: result.note,
      recommendation: result.recommendation,
      points: categoryIds.map((id) => byCategory.get(id) ?? null),
      categoryNotes: categoryIds.map((id) => notesByCategory.get(id) ?? null),
    };
  });
}

/// How an interview score should read, given its provenance. PRD decision 120.
///
/// One function rather than three copies of the same ternary, so the three pages
/// that render an interview cannot come to differ about what a computed average
/// looks like — which is the failure decision 120's "one shared transform" is
/// about.
export function formatInterviewScore(card: {
  score: number;
  scoreIsComputed: boolean;
}): string {
  return card.scoreIsComputed ? `${card.score} (computed)` : String(card.score);
}
