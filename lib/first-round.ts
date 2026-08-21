// FR-14's pool predicate and row shaping. Pure — no database, no Prisma client.
//
// Small, and here rather than in the page's loader for two reasons. The loader
// carries `server-only`, so nothing under it can be imported by a test; and the
// predicate is the one thing on this surface that has to agree with something
// far away — FR-15's finalize writes `Decision` rows over the same set, and the
// two drifting apart would mean a reviewer voting on an applicant who never
// receives a decision, or an applicant decided on votes nobody was shown.

import { ApplicantStatus, Round, VoteValue } from "@/generated/prisma/enums";
import { applicantDemographics, type DemographicColumn } from "@/lib/demographics";
import type { ApplicantData } from "@/lib/field-groups";
import { firstRoundSummary, rankFirstRound } from "@/lib/results";

/// Everyone still in the first round.
///
/// **One constant, read by the reviewer list, the applicant detail page, the
/// vote action and FR-15's finalize.** Four callers, one definition: an applicant
/// is in the first round for all of them or none of them.
///
/// `stageReached = FIRST_ROUND` rather than `!= WRITTEN` — the latter is FR-13's
/// import scoping (decision 48), which deliberately includes applicants who have
/// gone on to the second round because an interview sheet may still name them.
/// This set is narrower: who is being voted on *now*.
export const FIRST_ROUND_POOL = {
  status: ApplicantStatus.ACTIVE,
  stageReached: Round.FIRST_ROUND,
} as const;

/// What the reviewer list shows for one applicant.
export interface FirstRoundListRow {
  applicantId: string;
  displayName: string;
  sourceRowIndex: number;
  /// Null when this reviewer has not voted. Per FR-14 that absence IS the skip.
  vote: "YES" | "NO" | null;
  /// Clause 12q: the dashboard renders whichever half of the FR-12 import
  /// exists, so the row can say "no interview data yet" rather than opening onto
  /// an empty card.
  resultCount: number;
  hasNotes: boolean;
}

/// The shape the loader hands back, narrowed from what Prisma returns.
export interface FirstRoundApplicantSource {
  id: string;
  displayName: string;
  sourceRowIndex: number;
  resultCount: number;
  hasNotes: boolean;
  /// This reviewer's vote row, if any. At most one — `FirstRoundVote` is unique
  /// on `(applicantId, reviewerId)`.
  vote: VoteValue | null;
}

/// **`SKIP` narrows to null rather than being rendered.**
///
/// Nothing writes a `SKIP` row in this round — the absence of a row is what a
/// skip means — but the column's type permits one, and the second round does
/// write them for a conflict of interest. If one ever reached this list, showing
/// it as a cast vote would tell a reviewer they had decided something they had
/// not. Narrowed rather than asserted, so the impossible case has a defined
/// answer instead of a type assertion hiding it.
export function toFirstRoundListRow(source: FirstRoundApplicantSource): FirstRoundListRow {
  return {
    applicantId: source.id,
    displayName: source.displayName,
    sourceRowIndex: source.sourceRowIndex,
    vote:
      source.vote === VoteValue.YES || source.vote === VoteValue.NO ? source.vote : null,
    resultCount: source.resultCount,
    hasNotes: source.hasNotes,
  };
}

/// Decision 62's "voted on N of M". Here rather than in the component so the
/// definition of "voted" and the rows it counts cannot part company — a skip is
/// not a vote, and this is the one place that says so.
export function votedCount(rows: readonly FirstRoundListRow[]): number {
  return rows.filter((row) => row.vote !== null).length;
}

// ---------------------------------------------------------------------------
// FR-15's page assembly
// ---------------------------------------------------------------------------
//
// The transformation between "applicant rows with their votes" and "ranked
// result rows" — the seam the results page used to do inline, where a wrong
// call to `tallySelections` would have been a runtime crash on a page with no
// test rather than a typecheck failure. The Prisma query stays in the page; this
// is everything after it.


/// One applicant as the results page loads them.
export interface FirstRoundResultSource {
  id: string;
  displayName: string;
  sourceRowIndex: number;
  data: ApplicantData;
  status: ApplicantStatus;
  stageReached: Round;
  /// Every reviewer's vote on this applicant. Unlike the reviewer dashboard,
  /// which loads only the signed-in reviewer's.
  votes: readonly VoteValue[];
}

export interface FirstRoundResultRow {
  id: string;
  rank: number;
  displayName: string;
  sourceRowIndex: number;
  yesCount: number;
  noCount: number;
  nonSkipCount: number;
  yesPercent: number | null;
  /// Column key -> the labels this applicant selected, for the live breakdown.
  selections: Record<string, string[]>;
  /// Whether FR-15's finalize would decide on this applicant. False for someone
  /// the round has already decided — the page ranks them for reference, but the
  /// checkbox column does not apply.
  inPool: boolean;
}

/// Rank and shape the first-round results.
///
/// **Ranked over everyone passed in, not just the pool.** The caller loads
/// everyone with `stageReached != WRITTEN`, because ranking only the live pool
/// would blank the page the moment it was finalized and these results are what
/// an admin revisits afterwards. `inPool` is what the checkbox column reads.
///
/// **A SKIP vote counts toward neither side.** Nothing writes one in this round
/// — the absence of a row is the skip — but the second round does, and a skip
/// belongs in no part of `yes / (yes + no)`. Filtered rather than asserted away.
export function buildFirstRoundResultRows(
  applicants: readonly FirstRoundResultSource[],
  columns: readonly DemographicColumn[],
): FirstRoundResultRow[] {
  const scored = applicants.map((applicant) => ({
    id: applicant.id,
    displayName: applicant.displayName,
    sourceRowIndex: applicant.sourceRowIndex,
    ...firstRoundSummary({
      yesCount: applicant.votes.filter((value) => value === VoteValue.YES).length,
      noCount: applicant.votes.filter((value) => value === VoteValue.NO).length,
    }),
    selections: Object.fromEntries(
      Object.entries(applicantDemographics(applicant.data, columns)).map(([key, cell]) => [
        key,
        cell.selected,
      ]),
    ),
    inPool:
      applicant.status === FIRST_ROUND_POOL.status &&
      applicant.stageReached === FIRST_ROUND_POOL.stageReached,
  }));

  // Rank the whole cohort, then number. The rank a row carries is its place
  // among everyone the round decided on, not its position in a filtered view —
  // the same rule FR-10's page follows.
  return rankFirstRound(scored).map((row, index) => ({ ...row, rank: index + 1 }));
}
