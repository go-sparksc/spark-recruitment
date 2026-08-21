// FR-17's resolution state machine. Pure — no database, no Prisma client.
//
// BUILD_PLAN calls this the hardest thing in the project, and the reason it is
// hard is not the arithmetic. It is that four different questions look like one:
//
//   1. What did this reviewer effectively say?          `effectiveVote`
//   2. What has this pass concluded about this applicant? `resolveApplicant`
//   3. May that conclusion be written over what is already stored?
//                                                        `isMutableResolution`
//   4. What does that conclusion do to the applicant and to `Decision`?
//                                                        `statusFor`, `decisionOutcomeFor`
//
// Answering 2 without 3 is how a manual reject gets silently overwritten by a
// recount; answering 2 without 4 is how an applicant becomes a SPARKLET on their
// pass row and stays ACTIVE everywhere else. Each is a separate exported
// function so each can be tested, and so no surface has to re-derive one of them
// from another.
//
// Same posture as lib/assignment.ts, lib/roster.ts and lib/reconciliation.ts:
// the part with real logic lives away from the database, and the cases in
// BUILD_PLAN's Phase 6 section are its spec.

import {
  ApplicantStatus,
  DecisionOutcome,
  PassResolution,
  VoteValue,
} from "@/generated/prisma/enums";

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/// FR-17: pass membership is "every applicant with `status = ACTIVE`".
///
/// **No round qualifier, deliberately.** Decision 41 dropped `ADVANCED` from
/// `ApplicantStatus` precisely so this predicate could stay this simple: an
/// applicant who reached the second round is ACTIVE, an applicant rejected at
/// any earlier stage is REJECTED, and there is no third state to exclude. Adding
/// `stageReached = SECOND_ROUND` here would be a second definition of the same
/// set, and the two would drift.
///
/// One constant, read by pass creation and by the close-second-round action —
/// the same discipline `FIRST_ROUND_POOL` follows in lib/first-round.ts.
export const SECOND_ROUND_POOL = { status: ApplicantStatus.ACTIVE } as const;

// ---------------------------------------------------------------------------
// One reviewer, one applicant
// ---------------------------------------------------------------------------

/// What one reviewer effectively says about one applicant in one pass.
///
/// `OUTSTANDING` is not a vote and is not a skip: it is the pass still waiting.
/// It is what keeps an applicant unresolved, and it is FR-18's blank cell.
export type EffectiveVote = "YES" | "NO" | "SKIP" | "OUTSTANDING";

export interface PassVoteLike {
  applicantId: string;
  reviewerId: string;
  value: VoteValue;
}

export interface ConflictLike {
  applicantId: string;
  reviewerId: string;
}

/// Decision 67: COI-as-skip is computed, never a stored `PassVote` row.
///
/// A `PassVote` row means a reviewer actually submitted something. A conflict is
/// a fact about the pairing that outranks whatever they may have submitted
/// earlier — decision 68 deletes that row on flag, so in practice the two never
/// coexist, and this asserts the outcome rather than trusting the deletion. If
/// one ever survived a partial failure, the conflict still wins.
///
/// **A stored `SKIP` is honoured.** Nothing in the product writes one; the
/// column's type permits one; and "skip" is exactly what it would mean. Defined
/// rather than asserted away, the same call lib/first-round.ts makes in the
/// other direction.
export function effectiveVote(
  vote: VoteValue | null | undefined,
  hasConflict: boolean,
): EffectiveVote {
  if (hasConflict) return "SKIP";
  if (vote === VoteValue.YES) return "YES";
  if (vote === VoteValue.NO) return "NO";
  if (vote === VoteValue.SKIP) return "SKIP";
  return "OUTSTANDING";
}

// ---------------------------------------------------------------------------
// One applicant, one pass
// ---------------------------------------------------------------------------

export interface PassTally {
  yes: number;
  no: number;
  skip: number;
  outstanding: number;
  /// Reviewers whose vote counts toward unanimity — everyone not skipping.
  /// `eligible === 0` is the all-COI case and the whole reason `NEEDS_ADMIN`
  /// exists.
  eligible: number;
}

export interface ApplicantResolution {
  applicantId: string;
  tally: PassTally;
  /// **Null means unresolved so far, not "no outcome".** The pass is still
  /// waiting on somebody. It is a state this row may leave; `SPARKLET`,
  /// `REJECTED` and `CARRIED` are states it does not.
  resolution: PassResolution | null;
}

export interface PassInput {
  /// The electorate. Fixed for the whole round by decisions 66 and 78, which is
  /// why it is derived from `Reviewer.rounds` at read time rather than stored
  /// per pass — there is no moment at which two passes of one round can have
  /// different rosters.
  reviewerIds: readonly string[];
  /// `PassApplicant` membership, fixed at creation.
  applicantIds: readonly string[];
  votes: readonly PassVoteLike[];
  /// The round's `ConflictOfInterest` rows. Sticky across passes (FR-16), so
  /// these are scoped by round and never by pass.
  conflicts: readonly ConflictLike[];
}

/// A colon rather than a hyphen, and an ASCII one rather than a NUL: cuids are
/// `[a-z0-9]`, so a colon cannot occur inside either half and no two pairs can
/// collide on it. (A NUL would be marginally safer against non-cuid ids and is
/// invisible in an editor, which makes it the wrong trade in a file people read.)
const SEPARATOR = ":";

const pairKey = (applicantId: string, reviewerId: string) =>
  `${applicantId}${SEPARATOR}${reviewerId}`;

interface PassIndex {
  votes: ReadonlyMap<string, VoteValue>;
  conflicts: ReadonlySet<string>;
}

function indexOf(input: PassInput): PassIndex {
  const votes = new Map<string, VoteValue>();
  for (const vote of input.votes) {
    votes.set(pairKey(vote.applicantId, vote.reviewerId), vote.value);
  }

  const conflicts = new Set<string>();
  for (const conflict of input.conflicts) {
    conflicts.add(pairKey(conflict.applicantId, conflict.reviewerId));
  }

  return { votes, conflicts };
}

function resolveWithIndex(
  applicantId: string,
  reviewerIds: readonly string[],
  index: PassIndex,
): ApplicantResolution {
  const tally: PassTally = { yes: 0, no: 0, skip: 0, outstanding: 0, eligible: 0 };

  for (const reviewerId of reviewerIds) {
    const key = pairKey(applicantId, reviewerId);
    // **Iterating the roster, not the votes.** A vote row from someone outside
    // `reviewerIds` is not counted — it cannot swing unanimity, and the only way
    // one exists is an orphan from a roster change that decisions 66 and 78 now
    // forbid. The roster is the denominator.
    switch (effectiveVote(index.votes.get(key), index.conflicts.has(key))) {
      case "YES":
        tally.yes += 1;
        tally.eligible += 1;
        break;
      case "NO":
        tally.no += 1;
        tally.eligible += 1;
        break;
      case "SKIP":
        tally.skip += 1;
        break;
      case "OUTSTANDING":
        tally.outstanding += 1;
        tally.eligible += 1;
        break;
    }
  }

  return { applicantId, tally, resolution: resolutionOf(tally) };
}

/// The state machine, in the order §7.4 states it.
///
/// The order is the specification, not an optimization:
///
///   1. **No eligible reviewer → `NEEDS_ADMIN`.** Every reviewer recused. §7.4
///      is explicit that this must not read as unanimous, and it is first
///      because "all YES" and "all NO" are both vacuously true of an empty set —
///      a later check would resolve the applicant to whichever branch was
///      written first, which is exactly the bug the requirement names.
///   2. **Anyone still outstanding → unresolved.** FR-17: resolved "when every
///      non-SKIP reviewer has submitted".
///   3. Unanimous yes, unanimous no, otherwise mixed.
function resolutionOf(tally: PassTally): PassResolution | null {
  if (tally.eligible === 0) return PassResolution.NEEDS_ADMIN;
  if (tally.outstanding > 0) return null;
  if (tally.yes === tally.eligible) return PassResolution.SPARKLET;
  if (tally.no === tally.eligible) return PassResolution.REJECTED;
  return PassResolution.CARRIED;
}

/// One applicant's standing in one pass.
export function resolveApplicant(applicantId: string, input: PassInput): ApplicantResolution {
  return resolveWithIndex(applicantId, input.reviewerIds, indexOf(input));
}

/// Every member's standing, in `applicantIds` order. The caller decides the
/// order; this preserves it.
export function resolvePass(input: PassInput): ApplicantResolution[] {
  const index = indexOf(input);
  return input.applicantIds.map((applicantId) =>
    resolveWithIndex(applicantId, input.reviewerIds, index),
  );
}

// ---------------------------------------------------------------------------
// What the persistence layer is allowed to do with that
// ---------------------------------------------------------------------------

/// Whether a recount may be written over what a pass row already holds.
///
/// **Only `null` and `NEEDS_ADMIN` move.** The other three are settled:
///
/// - `SPARKLET` / `REJECTED` are terminal. The applicant is no longer ACTIVE, so
///   no later pass contains them, and a manual reject (decision 71) is protected
///   by this same rule — a vote landing afterwards recomputes to something, and
///   this is what stops that something from being written.
/// - `CARRIED` means the pass had its say: every eligible reviewer submitted and
///   they disagreed. That is a completed outcome even though the applicant
///   carries forward, and it is why decision 75's "changeable until that
///   applicant resolves" has a definite end.
/// - `NEEDS_ADMIN` is the one written conclusion that is not a conclusion.
///   Decision 76 lets an admin remove a conflict, which hands the applicant back
///   an eligible reviewer, so this row has to be able to become unresolved
///   again. On a closed pass in a COMPLETE instance nothing recomputes anyway.
export function isMutableResolution(existing: PassResolution | null): boolean {
  return existing === null || existing === PassResolution.NEEDS_ADMIN;
}

/// Whether this resolution takes the applicant out of every future pass.
export function isTerminal(resolution: PassResolution | null): boolean {
  return resolution === PassResolution.SPARKLET || resolution === PassResolution.REJECTED;
}

/// What the applicant's own status becomes. Null where it does not change —
/// `CARRIED` and `NEEDS_ADMIN` both leave them ACTIVE, and §7.4 is emphatic
/// about the second one: there is no `UNRESOLVED` status, and an applicant's
/// fate at the end of the round lives on their final pass row.
export function statusFor(resolution: PassResolution | null): ApplicantStatus | null {
  if (resolution === PassResolution.SPARKLET) return ApplicantStatus.SPARKLET;
  if (resolution === PassResolution.REJECTED) return ApplicantStatus.REJECTED;
  return null;
}

/// Decisions 69 and 70: a `Decision` row at `stage = SECOND_ROUND` the moment an
/// applicant resolves, and none at all for `NEEDS_ADMIN` — nothing has been
/// decided yet, which is the entire meaning of the value.
///
/// `CARRIED` writes none either, for the same reason and one further: the
/// applicant is still in the round, and `UNIQUE (applicantId, stage)` gives them
/// exactly one second-round decision to spend.
export function decisionOutcomeFor(resolution: PassResolution | null): DecisionOutcome | null {
  if (resolution === PassResolution.SPARKLET) return DecisionOutcome.SPARKLET;
  if (resolution === PassResolution.REJECTED) return DecisionOutcome.REJECT;
  return null;
}

/// Decision 73: what "still unresolved" means to the close-second-round action.
///
/// `null` is the applicant no pass ever finished voting on; `CARRIED` on the
/// **final** pass is the applicant whose votes were mixed and who had no next
/// pass to carry into. Both are undecided, both need an admin, and FR-19 finds
/// them by `NEEDS_ADMIN` and by nothing else — so a `CARRIED` final row that
/// kept its value would be invisible to the only screen obliged to show it.
///
/// `SPARKLET` and `REJECTED` are never overwritten, which is also what makes the
/// action idempotent as §7.4 requires: the second run matches no rows.
export function needsAdminAtClose(existing: PassResolution | null): boolean {
  return existing === null || existing === PassResolution.CARRIED;
}

// ---------------------------------------------------------------------------
// FR-18's grid
// ---------------------------------------------------------------------------

export interface PassGridRow {
  applicantId: string;
  /// One cell per reviewer, in `reviewerIds` order. FR-18's "blank / yes / no /
  /// skip", where blank is `OUTSTANDING`.
  cells: EffectiveVote[];
  tally: PassTally;
  /// What the pass row holds in the database.
  stored: PassResolution | null;
  /// What the votes and conflicts say right now.
  computed: PassResolution | null;
  /// **What to render, and why `stored` wins.** A manual reject (decision 71)
  /// and the close-round action's `NEEDS_ADMIN` (decision 73) are both writes
  /// that no recount reproduces — recomputing a manually rejected applicant
  /// gives `null` or `CARRIED`, and rendering that would tell an admin the
  /// rejection they performed had not happened. `computed` is kept beside it so
  /// the two can be compared rather than one silently standing for the other.
  resolution: PassResolution | null;
}

export interface PassGrid {
  reviewerIds: readonly string[];
  rows: PassGridRow[];
}

/// FR-18's reviewer-by-applicant grid.
///
/// Here rather than in the page because the page would otherwise be doing the
/// one thing CLAUDE.md's testing note forbids: transforming query results into a
/// display shape where nothing can test the transformation. `lib/first-round.ts`
/// is the worked example this follows.
export function buildPassGrid(
  input: PassInput,
  stored: ReadonlyMap<string, PassResolution | null> = new Map(),
): PassGrid {
  const index = indexOf(input);

  const rows = input.applicantIds.map((applicantId) => {
    const { tally, resolution: computed } = resolveWithIndex(
      applicantId,
      input.reviewerIds,
      index,
    );

    const cells = input.reviewerIds.map((reviewerId) => {
      const key = pairKey(applicantId, reviewerId);
      return effectiveVote(index.votes.get(key), index.conflicts.has(key));
    });

    const storedResolution = stored.get(applicantId) ?? null;

    return {
      applicantId,
      cells,
      tally,
      stored: storedResolution,
      computed,
      resolution: storedResolution ?? computed,
    };
  });

  return { reviewerIds: input.reviewerIds, rows };
}
