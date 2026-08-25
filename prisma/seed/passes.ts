// A complete second round: two passes, every resolution the state machine can
// produce, and a Sparklet class at the end of it.
//
// **This reverses `prisma/advance.ts`'s stated position, deliberately, per PRD
// decision 91.** That file says pass rows are what an admin creates on FR-17's
// screen and that seeding them would develop FR-18 against a state nothing
// produced. That was right for Phase 6, which was building FR-18. It inverts for
// Phase 7: FR-19 renders the *outcome* of a second round, and `seed:advance`
// stops exactly where an admin would create pass 1 — so FR-19's three groups,
// its funnel, and FR-20's round trip would every one of them be developed
// against empty sets.
//
// What keeps that safe is that `prisma/passes.ts` writes exactly what the FR-17
// actions write — same resolution function, same Decision rows, same actors,
// same audit entries — which is the posture `prisma/advance.ts` already takes
// toward `finalizeFirstRound`. A seed whose idea of a finished round differed
// from the action's would be worse than no seed at all.
//
// Pure — no database access and no Prisma client. `prisma/passes.ts` writes what
// this returns.

import { VoteValue } from "../../generated/prisma/enums";

/// Its own generator seed, for the reason `SECOND_ROUND_RNG_SEED` gives in
/// ./second-round.ts: a generator shared with another stage would let this file
/// change who advanced, and everything downstream is named after those people.
export const PASSES_RNG_SEED = 20260825;

/// What one applicant's pass 1 is meant to demonstrate.
///
/// Named rather than random. The whole point of this fixture is that every
/// branch of `lib/passes.ts` appears in it, and a random vote distribution
/// reaches the common branches often and the interesting ones never — an
/// all-COI applicant will not occur by chance in a 22-person cohort.
export type PassOneRole =
  /// Unanimous yes → SPARKLET, and the Sparklet class FR-19 renders.
  | "UNANIMOUS_YES"
  /// Unanimous no → REJECTED by the pass itself, `actor = SYSTEM`.
  | "UNANIMOUS_NO"
  /// Mixed → CARRIED. The value that exists nowhere in the hand-driven
  /// fixture and that decision 88's null-versus-CARRIED distinction is about.
  | "MIXED"
  /// Unanimous yes among those who can vote, with one reviewer recused.
  /// Case D in lib/passes.test.ts: COI is a skip, excluded from unanimity.
  | "ONE_CONFLICT_THEN_YES"
  /// Every reviewer recused → NEEDS_ADMIN at creation, and it must not read as
  /// unanimous. Clause 17v, and the case BUILD_PLAN records as needing twelve
  /// reviewer sign-ins to produce through the UI.
  | "ALL_CONFLICT"
  /// Some votes in, some outstanding → resolution stays null through the close.
  /// Decision 72: the close writes nothing, so this row is still null afterwards.
  | "PARTIAL"
  /// An admin rejects them mid-pass → REJECTED with `actor = ADMIN`.
  | "ADMIN_REJECT";

/// Pass 2 only has to distinguish "resolves" from "does not", because everyone
/// in it arrived by carrying forward.
export type PassTwoRole = "UNANIMOUS_YES" | "UNANIMOUS_NO" | "MIXED" | "PARTIAL";

export interface PassOnePlan {
  applicantId: string;
  role: PassOneRole;
}

export interface PassTwoPlan {
  applicantId: string;
  role: PassTwoRole;
}

/// The shape of the whole fixture, so a reader can see what it is meant to
/// prove without running it.
export interface SecondRoundPlan {
  passOne: PassOnePlan[];
  passTwo: PassTwoPlan[];
}

/// How many applicants take each pass 1 role, in order. Sums are checked against
/// the pool at build time rather than assumed — a cohort that shrank would
/// otherwise silently drop the interesting roles off the end.
const PASS_ONE_SHAPE: readonly { role: PassOneRole; count: number }[] = [
  { role: "UNANIMOUS_YES", count: 5 },
  { role: "ONE_CONFLICT_THEN_YES", count: 1 },
  { role: "UNANIMOUS_NO", count: 4 },
  { role: "ADMIN_REJECT", count: 1 },
  { role: "ALL_CONFLICT", count: 1 },
  { role: "PARTIAL", count: 2 },
  // MIXED takes the remainder, so the plan fits any pool size at or above the
  // sum of the counts above plus one.
];

/// The minimum cohort this fixture needs. Below it the roles cannot all appear,
/// and a fixture missing a role is the thing this file exists to prevent.
export const MINIMUM_POOL = PASS_ONE_SHAPE.reduce((sum, entry) => sum + entry.count, 0) + 1;

/// Assign each applicant a role for pass 1.
///
/// Deterministic and order-dependent: the pool arrives sorted by
/// `sourceRowIndex` (the order `createPass` itself uses), so the same applicant
/// gets the same role on every run and a screenshot stays true.
export function planPassOne(applicantIds: readonly string[]): PassOnePlan[] {
  if (applicantIds.length < MINIMUM_POOL) {
    throw new Error(
      `The second-round pool has ${applicantIds.length} applicants, and this fixture ` +
        `needs at least ${MINIMUM_POOL} to exercise every resolution. Run ` +
        `\`npm run seed && npm run seed:advance\` first.`,
    );
  }

  const plan: PassOnePlan[] = [];
  let index = 0;

  for (const { role, count } of PASS_ONE_SHAPE) {
    for (let taken = 0; taken < count; taken += 1) {
      plan.push({ applicantId: applicantIds[index], role });
      index += 1;
    }
  }

  for (; index < applicantIds.length; index += 1) {
    plan.push({ applicantId: applicantIds[index], role: "MIXED" });
  }

  return plan;
}

/// Pass 2's membership is whoever is still `ACTIVE`, which the caller computes
/// from `Applicant.status` exactly as `createPass` does — never from pass 1's
/// resolutions, which is the distinction FR-17 and clause 17o are about.
///
/// Both of decision 73's close-round cases are produced deliberately: a `null`
/// row (PARTIAL) and a `CARRIED` row (MIXED). They are reached by different
/// routes and would be easy to handle in only one.
///
/// **`unvotable` is not a detail.** Pass 2's members arrive in `sourceRowIndex`
/// order, and the all-COI applicant from pass 1 carries into it (clause 17v) —
/// so without this the resolving roles get handed to the one applicant nobody
/// can vote on, and the pass produces no `SPARKLET` at all. The first version of
/// this function did exactly that, and the fixture looked plausible while
/// quietly missing a resolution. Applicants with no eligible reviewer keep a
/// role that expects not to resolve.
export function planPassTwo(
  applicantIds: readonly string[],
  unvotable: ReadonlySet<string> = new Set(),
): PassTwoPlan[] {
  const resolving: PassTwoRole[] = ["UNANIMOUS_YES", "UNANIMOUS_NO"];
  let assigned = 0;

  return applicantIds.map((applicantId, index) => {
    if (unvotable.has(applicantId)) {
      // Nothing this applicant is given would be cast. PARTIAL is the honest
      // label: they end the pass unresolved, which is what actually happens.
      return { applicantId, role: "PARTIAL" };
    }
    if (assigned < resolving.length) {
      const role = resolving[assigned];
      assigned += 1;
      return { applicantId, role };
    }
    // The rest split between the two shapes that survive the pass unresolved,
    // alternating so neither is a single lonely row.
    return { applicantId, role: index % 2 === 0 ? "MIXED" : "PARTIAL" };
  });
}

export interface PlannedVote {
  applicantId: string;
  reviewerId: string;
  value: typeof VoteValue.YES | typeof VoteValue.NO;
}

/// The votes one role produces, given the roster and who is recused.
///
/// Returns only YES and NO. **SKIP is never a stored row** — decision 67 makes
/// it computed from the conflict, and `submitPassVote` refuses to accept one, so
/// a seed that wrote SKIP rows would produce a state the application cannot.
export function votesFor(
  applicantId: string,
  role: PassOneRole | PassTwoRole,
  reviewerIds: readonly string[],
  recusedReviewerIds: readonly string[],
): PlannedVote[] {
  const recused = new Set(recusedReviewerIds);
  const eligible = reviewerIds.filter((reviewerId) => !recused.has(reviewerId));

  const all = (value: typeof VoteValue.YES | typeof VoteValue.NO): PlannedVote[] =>
    eligible.map((reviewerId) => ({ applicantId, reviewerId, value }));

  switch (role) {
    case "UNANIMOUS_YES":
    case "ONE_CONFLICT_THEN_YES":
      return all(VoteValue.YES);

    case "UNANIMOUS_NO":
      return all(VoteValue.NO);

    case "MIXED": {
      // A real split rather than one dissenter, so the FR-18 grid and FR-19's
      // "eleven skips reads very differently from 7–4" both have something to
      // show. Deterministic: the first third vote no.
      const dissenters = Math.max(1, Math.floor(eligible.length / 3));
      return eligible.map((reviewerId, index) => ({
        applicantId,
        reviewerId,
        value: index < dissenters ? VoteValue.NO : VoteValue.YES,
      }));
    }

    case "PARTIAL": {
      // Fewer votes than eligible reviewers, so the applicant never resolves and
      // the row stays null through the close. Decision 72's case.
      const voting = eligible.slice(0, Math.max(1, Math.floor(eligible.length / 2)));
      return voting.map((reviewerId, index) => ({
        applicantId,
        reviewerId,
        value: index === 0 ? VoteValue.NO : VoteValue.YES,
      }));
    }

    case "ALL_CONFLICT":
      // Nobody is eligible, so there is nothing to cast. `createPass` has
      // already written NEEDS_ADMIN by the time any vote would be submitted.
      return [];

    case "ADMIN_REJECT":
      // The admin's reject lands before any vote does, which is the ordinary
      // case: decision 71 says votes still in flight become moot, and a seed
      // that wrote them would be modelling the race rather than the rule.
      return [];
  }
}

/// Which reviewers are recused from which applicants, for the roles that need a
/// conflict to exist before pass 1 is created.
///
/// Conflicts are round-scoped and sticky (FR-16, decision 67), so these are
/// written once, before any pass, exactly as a reviewer flagging from the FR-16
/// list would produce.
export function planConflicts(
  plan: readonly PassOnePlan[],
  reviewerIds: readonly string[],
): { applicantId: string; reviewerId: string }[] {
  const conflicts: { applicantId: string; reviewerId: string }[] = [];

  for (const { applicantId, role } of plan) {
    if (role === "ALL_CONFLICT") {
      for (const reviewerId of reviewerIds) conflicts.push({ applicantId, reviewerId });
    }
    if (role === "ONE_CONFLICT_THEN_YES") {
      conflicts.push({ applicantId, reviewerId: reviewerIds[0] });
    }
  }

  return conflicts;
}
