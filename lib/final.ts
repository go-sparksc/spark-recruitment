// FR-19's grouping. Pure — no database, no Prisma client.
//
// Here rather than in the page for the reason CLAUDE.md's testing note gives:
// twice in Phase 5 a page assembled correct pure functions incorrectly, and
// neither the pure suites nor the clause ledger could see it. Everything between
// "what the query returned" and "what the screen renders" lives here, and the
// page keeps only the query.
//
// **The two predicates are the whole of this file, and they are not symmetric.**
// New Sparklet and Rejected are read from `Applicant.status`. Unresolved is read
// from the final pass row and never from status — FR-17 is explicit that an
// applicant left undecided stays `ACTIVE`, and §5 says a status value would be a
// second copy of that fact with no rule for which one wins when they disagree.

import { ApplicantStatus, PassResolution, Round } from "@/generated/prisma/enums";
import {
  buildPassGrid,
  conflictsInForce,
  type DatedConflictLike,
  type EffectiveVote,
  type PassTally,
  type PassVoteLike,
  type PassWindow,
} from "@/lib/passes";

/// One applicant as FR-19 needs them, whichever group they land in.
export interface FinalApplicantSource {
  id: string;
  sourceRowIndex: number;
  displayName: string;
  email: string | null;
  status: ApplicantStatus;
  stageReached: Round;
  /// This applicant's row in the **final** pass, or null if they were not in it
  /// — a Sparklet or a rejection from an earlier pass never joins the last one,
  /// because membership is recomputed from `status` at each creation.
  finalPassResolution: PassResolution | null;
  /// Whether the applicant is in the final pass at all. Distinct from a null
  /// resolution, which means "in it, and it never decided them" — the close
  /// converts those to NEEDS_ADMIN, so a null here after a closed round means
  /// the applicant was not a member.
  inFinalPass: boolean;
  /// Whether a `Decision` row exists at `stage = SECOND_ROUND`. Decision 89's
  /// second clause: an admin who has since resolved them leaves the group
  /// without their pass row being rewritten.
  hasSecondRoundDecision: boolean;
  /// The final pass's votes for them, for the sentence FR-19 ends on: "eleven
  /// skips reads very differently from 7–4". Null where they were not in it.
  tally: PassTally | null;
}

export interface FinalRow {
  applicantId: string;
  sourceRowIndex: number;
  displayName: string;
  email: string | null;
  /// Present only for the Unresolved group, where FR-19 requires the underlying
  /// votes stay visible. A Sparklet's tally is not rendered: the decision is
  /// made and the number would be an invitation to relitigate it.
  tally: PassTally | null;
}

export interface FinalGroups {
  sparklets: FinalRow[];
  rejected: FinalRow[];
  unresolved: FinalRow[];
}

function toRow(source: FinalApplicantSource, withTally: boolean): FinalRow {
  return {
    applicantId: source.id,
    sourceRowIndex: source.sourceRowIndex,
    displayName: source.displayName,
    email: source.email,
    tally: withTally ? source.tally : null,
  };
}

/// **Decision 89's predicate, stated once.**
///
/// `resolution = NEEDS_ADMIN` on the final pass **and** no `Decision` row at
/// `stage = SECOND_ROUND`. Without the second clause an admin who admits one of
/// them appears in both New Sparklet (by status) and Unresolved (by a pass row
/// nothing rewrote) — the contradiction FR-19 never closed and 89 does.
export function isUnresolved(source: FinalApplicantSource): boolean {
  return (
    source.inFinalPass &&
    source.finalPassResolution === PassResolution.NEEDS_ADMIN &&
    !source.hasSecondRoundDecision
  );
}

/// FR-19's three groups.
///
/// **The pool is every applicant who reached the second round** —
/// `stageReached = SECOND_ROUND` — which is what "all second-round applicants"
/// means. A written-round or first-round rejection is not in it: they were
/// decided by FR-11 and FR-15, whose own screens are the record of that, and
/// listing them here would put 110 people under "Rejected" who never reached
/// this round.
///
/// Groups are exclusive and Unresolved is tested first, because an applicant can
/// satisfy two predicates at once. That is not a hypothetical: an admin who
/// rejects an unresolved applicant makes them `REJECTED` **and** leaves
/// `NEEDS_ADMIN` on their pass row, and only decision 89's `Decision`-row clause
/// separates the two — so the order here and that clause are one mechanism, not
/// two.
export function groupFinalApplicants(
  sources: readonly FinalApplicantSource[],
): FinalGroups {
  const groups: FinalGroups = { sparklets: [], rejected: [], unresolved: [] };

  for (const source of sources) {
    if (source.stageReached !== Round.SECOND_ROUND) continue;

    if (isUnresolved(source)) {
      groups.unresolved.push(toRow(source, true));
      continue;
    }
    if (source.status === ApplicantStatus.SPARKLET) {
      groups.sparklets.push(toRow(source, false));
      continue;
    }
    if (source.status === ApplicantStatus.REJECTED) {
      groups.rejected.push(toRow(source, false));
      continue;
    }

    // ACTIVE, in the second round, and not unresolved. Reachable in exactly one
    // state: the round is still running and this applicant is carrying forward.
    // FR-19 is a record of a finished round, so they belong in no group — and
    // silently dropping them is right, because the alternative is inventing a
    // fourth group the requirement does not have. The page says how many.
  }

  const bySourceRow = (a: FinalRow, b: FinalRow) => a.sourceRowIndex - b.sourceRowIndex;
  groups.sparklets.sort(bySourceRow);
  groups.rejected.sort(bySourceRow);
  groups.unresolved.sort(bySourceRow);

  return groups;
}

/// How many second-round applicants are in no group, which happens only while
/// the round is still open.
///
/// Rendered rather than hidden: an admin opening this screen mid-round sees a
/// partial picture, and a count is what tells them so. Without it the screen
/// looks like a finished cycle that lost people.
export function stillDeciding(sources: readonly FinalApplicantSource[]): number {
  return sources.filter(
    (source) =>
      source.stageReached === Round.SECOND_ROUND &&
      source.status === ApplicantStatus.ACTIVE &&
      !isUnresolved(source),
  ).length;
}

// ---------------------------------------------------------------------------
// One applicant's second round, for the admin profile (clause 19b)
// ---------------------------------------------------------------------------

/// One reviewer's position on this applicant in one pass.
export interface ApplicantPassVote {
  reviewerId: string;
  reviewerName: string;
  vote: EffectiveVote;
  /// Whether the `SKIP` is a conflict rather than a stored abstention. The same
  /// distinction `buildPassGrid` draws, and for the same reason: two different
  /// things render as `SKIP`, and only one of them is a recusal.
  isConflict: boolean;
}

/// One pass, from one applicant's point of view.
export interface ApplicantPassRow {
  passId: string;
  ordinal: number;
  /// What the pass row holds. `stored` rather than recomputed, for
  /// `PassGridRow.resolution`'s stated reason: a manual reject and the
  /// close-round `NEEDS_ADMIN` are writes no recount reproduces.
  resolution: PassResolution | null;
  tally: PassTally;
  votes: ApplicantPassVote[];
}

export interface PassHistorySource extends PassWindow {
  passId: string;
  ordinal: number;
  resolution: PassResolution | null;
  votes: readonly PassVoteLike[];
}

/// This applicant's whole second round, pass by pass.
///
/// **Admin-only, and that is a §6 rule rather than a layout choice.** Decision
/// 74 keeps pass votes from every reviewer, closed pass or not, and §6's last
/// row makes the admin the only viewer who sees them. FR-18's grid renders one
/// pass across every applicant; this renders one applicant across every pass,
/// which is the cut an admin resolving a NEEDS_ADMIN row actually needs.
///
/// Conflicts are round-scoped and sticky (decision 67), so one set is passed in
/// — and each pass is read with the part of it that existed when that pass
/// closed, through the same `conflictsInForce` FR-18 and FR-19 use (decision
/// 100). A conflict flagged in pass 3 does not rewrite what pass 1 shows.
export function buildPassHistory(
  applicantId: string,
  passes: readonly PassHistorySource[],
  reviewers: readonly { id: string; firstName: string; lastName: string }[],
  conflicts: readonly DatedConflictLike[],
): ApplicantPassRow[] {
  const reviewerIds = reviewers.map((reviewer) => reviewer.id);

  return passes.map((pass) => {
    // One applicant, so the grid has exactly one row — reusing it rather than
    // recomputing keeps this surface and FR-18's from ever disagreeing about
    // what a cell says.
    const grid = buildPassGrid(
      {
        reviewerIds,
        applicantIds: [applicantId],
        votes: pass.votes,
        conflicts: conflictsInForce(conflicts, pass),
      },
      new Map([[applicantId, pass.resolution]]),
    );
    const row = grid.rows[0];

    return {
      passId: pass.passId,
      ordinal: pass.ordinal,
      resolution: row.stored,
      tally: row.tally,
      votes: reviewers.map((reviewer, index) => ({
        reviewerId: reviewer.id,
        reviewerName: `${reviewer.firstName} ${reviewer.lastName}`,
        vote: row.cells[index],
        isConflict: row.conflicts[index],
      })),
    };
  });
}

/// What the votes say about *why* an applicant is unresolved.
///
/// FR-19: "The underlying votes remain visible, so an admin can tell the two
/// situations apart — eleven skips reads very differently from 7–4." This is
/// that sentence as a value, so the page renders a phrase rather than deciding
/// what the numbers mean.
export type UnresolvedReason = "ALL_RECUSED" | "NO_VOTES" | "INCOMPLETE" | "MIXED";

export function unresolvedReason(tally: PassTally | null): UnresolvedReason | null {
  if (tally === null) return null;

  // Every eligible reviewer recused. The all-COI case, which §7.4 requires stay
  // distinguishable from unanimity.
  if (tally.eligible === 0) return "ALL_RECUSED";
  if (tally.yes === 0 && tally.no === 0) return "NO_VOTES";
  // Votes were still outstanding when the round closed — decision 72's null row,
  // converted to NEEDS_ADMIN by the close.
  if (tally.outstanding > 0) return "INCOMPLETE";
  // Everyone voted and they disagreed: decision 73's CARRIED row on the final
  // pass, with no next pass to carry into.
  return "MIXED";
}
