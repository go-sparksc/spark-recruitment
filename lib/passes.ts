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
  InstanceStage,
  PassResolution,
  PassStatus,
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
/// earlier — decision 68 deletes that row on flag in the OPEN pass, and this
/// asserts the outcome rather than trusting the deletion. **The two do coexist
/// on every closed pass**: a conflict flagged in pass 3 sits beside a YES stored
/// in pass 1, because 68 deliberately leaves closed passes alone. That is why
/// readers of a closed pass hand this function only the conflicts that existed
/// when the pass closed — see `conflictsInForce` and decision 100.
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
  /// The electorate. Fixed from the creation of the first pass by decisions 66
  /// and 78 as amended by 84, which is why it is derived from `Reviewer.rounds`
  /// at read time rather than stored per pass — there is no moment at which two
  /// passes of one round can have different rosters.
  reviewerIds: readonly string[];
  /// `PassApplicant` membership, fixed at creation.
  applicantIds: readonly string[];
  votes: readonly PassVoteLike[];
  /// The round's `ConflictOfInterest` rows. Sticky across passes (FR-16), so
  /// these are scoped by round and never by pass — the full set for the open
  /// pass, and for a closed pass the rows that existed when it closed, which is
  /// what `conflictsInForce` selects (decision 100).
  conflicts: readonly ConflictLike[];
}

/// A conflict row with the timestamp decision 100 scopes by.
export interface DatedConflictLike extends ConflictLike {
  createdAt: Date;
}

/// The two columns of a `Pass` that decide which conflicts apply to it.
export interface PassWindow {
  status: PassStatus;
  closedAt: Date | null;
}

/// Decision 100: the conflicts a pass is read with.
///
/// Conflicts carry no pass dimension (decision 67), and every reader used to
/// hand the round's whole set to every pass — so a conflict flagged during pass 3
/// rendered as SKIP over a YES stored in pass 1, moved pass 1's tally and its
/// recomputed resolution, and moved FR-19's "why unresolved" phrase. Nothing
/// stored was rewritten; what was shown was.
///
/// For the open pass, every conflict applies: the pass is still being decided
/// and a conflict is in force from the moment it is flagged. For a closed pass,
/// only the conflicts that existed at `closedAt` apply, so the pass reads as it
/// did when it closed. **One function for every reader** — FR-18's grid, FR-19's
/// tallies and the applicant's pass history — so the three cannot disagree about
/// what a cell says.
///
/// A conflict an admin later removed (decision 76) leaves no row and so cannot
/// be reconstructed here; decision 100 records that as accepted.
export function conflictsInForce<T extends DatedConflictLike>(
  conflicts: readonly T[],
  pass: PassWindow,
): T[] {
  if (pass.status === PassStatus.OPEN || pass.closedAt === null) return [...conflicts];
  const closedAt = pass.closedAt.getTime();
  return conflicts.filter((conflict) => conflict.createdAt.getTime() <= closedAt);
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
    // one exists is an orphan from a roster change that decisions 66 and 78, as
    // amended by 84, forbid once the first pass exists. The roster is the
    // denominator.
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
  /// Parallel to `cells`: whether that skip comes from a conflict.
  ///
  /// **Two different things render as `SKIP`** — an active conflict, and a
  /// stored `SKIP` vote that the enum permits and nothing writes. Decision 76's
  /// removal applies to the first and is meaningless on the second, so the grid
  /// has to tell them apart rather than offering a control that would delete a
  /// row that is not there. Derived here rather than re-derived by the page, for
  /// the reason every other transformation is: a page that rebuilds this from
  /// the raw conflicts puts the rebuild where nothing can test it.
  conflicts: boolean[];
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

    const conflicts = input.reviewerIds.map((reviewerId) =>
      index.conflicts.has(pairKey(applicantId, reviewerId)),
    );

    const storedResolution = stored.get(applicantId) ?? null;

    return {
      applicantId,
      cells,
      conflicts,
      tally,
      stored: storedResolution,
      computed,
      resolution: storedResolution ?? computed,
    };
  });

  return { reviewerIds: input.reviewerIds, rows };
}

// ---------------------------------------------------------------------------
// FR-17's creation guards
// ---------------------------------------------------------------------------

export interface PassCreationContext {
  /// `Instance.currentStage === SECOND_ROUND`. Passes belong to the second
  /// round and only to it.
  inSecondRound: boolean;
  /// The ordinal of the pass that is already open, or null. Clause 17c.
  openPassOrdinal: number | null;
  /// `SECOND_ROUND_POOL` counted server-side. Clause 17b's membership, and
  /// §7.4's zero-applicant block.
  poolSize: number;
  /// Reviewers with SECOND_ROUND in `rounds`. Decision 79.
  reviewerCount: number;
}

/// Why a pass cannot be created right now, or null when one can be.
///
/// **One function, read by both the page and the action.** The page needs it to
/// say why the button is absent — the Slice 4 rule, that a surface explains
/// rather than offering a control that fails — and the action needs it because a
/// second tab still holds a form bound to it. Deriving the two separately is how
/// they end up disagreeing about which guard fired, and the message an admin
/// reads stops matching the reason they were refused.
///
/// Order is deliberate. Stage first, because in a COMPLETE instance none of the
/// other three questions is worth asking. Then the open pass, then §7.4's two
/// table rows in the order §7.4 lists them.
export function passCreationBlock(context: PassCreationContext): string | null {
  if (!context.inSecondRound) {
    return (
      "Passes belong to the second round. This instance is not in it — finalize the first " +
      "round to begin, or, if the second round has been closed, it cannot be reopened."
    );
  }

  if (context.openPassOrdinal !== null) {
    return (
      `Pass ${context.openPassOrdinal} is still open. Exactly one pass is open at a time, so ` +
      `close it before creating the next.`
    );
  }

  if (context.poolSize === 0) {
    return (
      "Every applicant has been decided — there is nobody left for a pass to vote on. Close " +
      "the second round to finish the cycle."
    );
  }

  if (context.reviewerCount === 0) {
    // Decision 79. Without an electorate every member resolves NEEDS_ADMIN the
    // moment the pass is created: a pass that decides nothing and flags
    // everyone, indistinguishable at a glance from the all-COI case it is not.
    return (
      "No reviewer is on the second-round roster. Add reviewers to the second round before " +
      "creating a pass."
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// The pass list
// ---------------------------------------------------------------------------

export interface PassSummarySource {
  id: string;
  ordinal: number;
  status: PassStatus;
  openedAt: Date;
  closedAt: Date | null;
  /// One entry per member, in any order. Null is a row that has not resolved.
  resolutions: readonly (PassResolution | null)[];
}

export interface PassSummary {
  id: string;
  ordinal: number;
  status: PassStatus;
  openedAt: Date;
  closedAt: Date | null;
  memberCount: number;
  sparklet: number;
  rejected: number;
  carried: number;
  needsAdmin: number;
  /// Members with no resolution yet. On an open pass this is the work left; on a
  /// closed one it is decision 72's unvoted rows, which the close deliberately
  /// left as `NULL`.
  unresolved: number;
}

/// The pass list's per-row counts.
///
/// In `lib/` rather than the page for CLAUDE.md's Phase 5 reason: a page that
/// reshapes query results before rendering them puts the reshaping where nothing
/// can test it, and twice in Phase 5 that is exactly where the defect was.
export function summarizePass(source: PassSummarySource): PassSummary {
  const counts = { sparklet: 0, rejected: 0, carried: 0, needsAdmin: 0, unresolved: 0 };

  for (const resolution of source.resolutions) {
    switch (resolution) {
      case PassResolution.SPARKLET:
        counts.sparklet += 1;
        break;
      case PassResolution.REJECTED:
        counts.rejected += 1;
        break;
      case PassResolution.CARRIED:
        counts.carried += 1;
        break;
      case PassResolution.NEEDS_ADMIN:
        counts.needsAdmin += 1;
        break;
      case null:
        counts.unresolved += 1;
        break;
    }
  }

  return {
    id: source.id,
    ordinal: source.ordinal,
    status: source.status,
    openedAt: source.openedAt,
    closedAt: source.closedAt,
    memberCount: source.resolutions.length,
    ...counts,
  };
}

// ---------------------------------------------------------------------------
// Whether one reviewer may vote right now
// ---------------------------------------------------------------------------

export type VoteAvailability =
  /// No pass is open. FR-17: a vote lands in the currently open pass, and
  /// without one there is nowhere for it to land.
  | { kind: "NO_PASS" }
  /// Membership was fixed at creation (17b), so an applicant who became active
  /// afterwards is genuinely not in this pass. Defensive: nothing in the
  /// product makes a REJECTED applicant ACTIVE again.
  | { kind: "NOT_IN_PASS" }
  /// Clause 17f. Computed from the conflict, never from a stored SKIP row.
  | { kind: "CONFLICT" }
  /// The pass has already concluded on this applicant, so decision 75's window
  /// has shut on its own.
  ///
  /// **Carries no resolution, deliberately.** Decision 83 forbids telling a
  /// reviewer which way it went, and 83a is what "settled" reveals — that a
  /// result occurred, nothing more. This value is a prop to a client component,
  /// so anything on it is serialised into the page payload whether or not the
  /// component renders it; the way to not reveal a field is to not send it.
  /// The reviewer surfaces only ever reach this state with `CARRIED`, since the
  /// terminal outcomes change `Applicant.status` and the profile 404s first, but
  /// the type should not depend on that staying true.
  | { kind: "SETTLED" }
  | { kind: "OPEN"; current: VoteValue | null };

export interface VoteAvailabilityInput {
  hasOpenPass: boolean;
  isMember: boolean;
  hasConflict: boolean;
  storedResolution: PassResolution | null;
  /// **This reviewer's own vote and no one else's.** Decision 74 and clause
  /// 17z: no reviewer surface loads another reviewer's `PassVote`, so there is
  /// no count here to leak.
  currentVote: VoteValue | null;
}

/// May this reviewer vote on this applicant, and what does the control show?
///
/// **One function, read by the profile and by the action.** 17f asks for both
/// halves — "the control is absent, and the action refuses" — and deriving them
/// separately is how a control disappears for one reason while the action
/// refuses for another. Same posture as `passCreationBlock`.
///
/// Order is the specification. The conflict outranks the stored resolution
/// because decision 68 has already deleted this reviewer's vote: they are SKIP
/// whatever the row says, and telling them the pass has settled would be
/// answering a question they did not ask.
export function voteAvailability(input: VoteAvailabilityInput): VoteAvailability {
  if (!input.hasOpenPass) return { kind: "NO_PASS" };
  if (!input.isMember) return { kind: "NOT_IN_PASS" };
  if (input.hasConflict) return { kind: "CONFLICT" };

  // `isMutableResolution` is the same predicate the persistence layer writes
  // through, so a row this refuses to vote on is exactly a row a recount refuses
  // to overwrite. NEEDS_ADMIN is mutable: decision 76 lets an admin hand this
  // reviewer back their eligibility, and the vote they then cast is the whole
  // point of that decision.
  if (!isMutableResolution(input.storedResolution) && input.storedResolution !== null) {
    return { kind: "SETTLED" };
  }

  return { kind: "OPEN", current: input.currentVote };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/// How a resolution is named on an admin surface, in §7.4's own words.
///
/// Here rather than in a component because the pass list, the member list and
/// FR-18's grid all render the same five states, and three private label maps is
/// three chances for one screen to call `NEEDS_ADMIN` something the next screen
/// does not. Exhaustive over the enum by type, so adding a `PassResolution`
/// member fails the typecheck here rather than rendering blank somewhere.
export const RESOLUTION_LABEL: Record<PassResolution, string> = {
  [PassResolution.SPARKLET]: "Sparklet",
  [PassResolution.REJECTED]: "Rejected",
  [PassResolution.CARRIED]: "Carried",
  [PassResolution.NEEDS_ADMIN]: "Needs an admin",
};

/// `null` is not a resolution and is deliberately not in the map above: it means
/// the pass has not finished with this applicant, which is a different kind of
/// answer from the four that have.
///
/// **Not "Unresolved".** That is FR-19's word for a different predicate —
/// `NEEDS_ADMIN` on the final pass with no admin decision since — and an admin
/// reading it on the pass list and on FR-19 would be reading two predicates under
/// one word. §5's own phrase for this cell is "null until resolved".
export function resolutionLabel(resolution: PassResolution | null): string {
  return resolution === null ? "No resolution" : RESOLUTION_LABEL[resolution];
}

// ---------------------------------------------------------------------------
// Closing the second round
// ---------------------------------------------------------------------------

/// Decision 73's "still unresolved", as a Prisma filter.
///
/// **The same rule as `needsAdminAtClose`, in the shape a query needs.** That
/// predicate answers for one stored value; this selects the rows. Two spellings
/// of one rule is a drift risk, so `passes.test.ts` asserts they agree across
/// every `PassResolution` and null — if someone adds a fifth resolution and
/// teaches only one of them about it, that test fails.
///
/// `null` cannot be expressed through `in`: SQL's `IN (NULL)` matches nothing, so
/// the OR is load-bearing rather than stylistic. Same posture as
/// `SECOND_ROUND_POOL` — a where-fragment living beside the rule it encodes.
/// **No `as const`, unlike `SECOND_ROUND_POOL`**, and not an oversight: Prisma's
/// generated `WhereInput` types declare `OR` as a mutable array, so a readonly
/// tuple is rejected at the call site. Re-adding it breaks the typecheck rather
/// than tightening anything.
export const UNRESOLVED_AT_CLOSE = {
  OR: [{ resolution: null }, { resolution: PassResolution.CARRIED }],
};

export interface CloseRoundContext {
  stage: InstanceStage;
  /// Passes on this instance, at any status.
  passCount: number;
}

/// Why the second round cannot be closed right now, or null when it can.
///
/// **`COMPLETE` returns a message here but is not an error at the action.** The
/// page uses this to explain why the control is absent, and "already closed" is
/// the honest explanation. The action must treat that state as an idempotent
/// no-op instead, per 17r — running the close twice has to change nothing rather
/// than fail — so it checks for `COMPLETE` before consulting this.
export function closeRoundBlock(context: CloseRoundContext): string | null {
  if (context.stage === InstanceStage.COMPLETE) {
    return "The second round is closed.";
  }

  if (context.stage !== InstanceStage.SECOND_ROUND) {
    return "The second round has not started. Finalize the first round first.";
  }

  // Clause 17s. Without a pass there is no `PassApplicant` row to carry
  // NEEDS_ADMIN, so every applicant would end the cycle unresolved with nothing
  // to find them by — and FR-19 would render an empty Unresolved group over a
  // live pool.
  if (context.passCount === 0) {
    return (
      "No pass has been created, so there is nowhere to record who was left undecided. Create " +
      "a pass and run it before closing the round."
    );
  }

  return null;
}
