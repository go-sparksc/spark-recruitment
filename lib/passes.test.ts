// FR-17's state machine. One of the four suites CLAUDE.md reserves real tests
// for, and the one BUILD_PLAN says to write the cases for before any code.
//
// **The cases in BUILD_PLAN's Phase 6 section are the spec.** They are
// transcribed here in the order they appear there, each labelled with its
// source, followed by the decisions 66-71 cases and the boundaries the
// requirement implies but does not enumerate. If a test below contradicts
// BUILD_PLAN or PRD §7.4, the test is wrong.
//
// Every case is built from `pass()` rather than from a fixture, so the input to
// each assertion is visible in the assertion itself — eleven reviewers, some
// votes, some conflicts. What makes this suite worth reading is that the inputs
// are legible, not that they are realistic.

import { describe, expect, it } from "vitest";

import {
  ApplicantStatus,
  DecisionActor,
  InstanceStage,
  DecisionOutcome,
  PassResolution,
  PassStatus,
  VoteValue,
} from "@/generated/prisma/enums";
import {
  RESOLUTION_LABEL,
  UNRESOLVED_AT_CLOSE,
  closeRoundBlock,
  SECOND_ROUND_POOL,
  buildPassGrid,
  conflictsInForce,
  decisionOutcomeFor,
  effectiveVote,
  isMutableResolution,
  isTerminal,
  needsAdminAtClose,
  passCreationBlock,
  resolutionLabel,
  resolveApplicant,
  resolvePass,
  reversalBlock,
  statusFor,
  summarizePass,
  voteAvailability,
  type PassInput,
  type ReversalContext,
} from "@/lib/passes";
import { outcomeOfResolution } from "@/lib/labels";

/// Eleven reviewers, the number BUILD_PLAN's cases use.
const REVIEWERS = Array.from({ length: 11 }, (_, i) => `rev-${i + 1}`);

/// One applicant, `app`, with votes and conflicts named by reviewer index.
///
/// `yes: 7` means reviewers 1-7 voted yes; `no: 4` means the NEXT four voted no.
/// Positional rather than by id because every case in BUILD_PLAN is stated as
/// counts, and writing them as counts is what makes the test readable against
/// the requirement it comes from.
function pass(spec: {
  reviewers?: readonly string[];
  yes?: number;
  no?: number;
  skipVotes?: number;
  coi?: number;
  applicantId?: string;
}): PassInput {
  const reviewers = spec.reviewers ?? REVIEWERS;
  const applicantId = spec.applicantId ?? "app";

  const votes = [];
  const conflicts = [];
  let cursor = 0;

  // Conflicts are taken from the FRONT of the roster and votes from after them,
  // so a case with both never accidentally puts a vote and a conflict on the
  // same reviewer — that combination has its own case below, built explicitly.
  for (let i = 0; i < (spec.coi ?? 0); i += 1, cursor += 1) {
    conflicts.push({ applicantId, reviewerId: reviewers[cursor] });
  }
  for (let i = 0; i < (spec.yes ?? 0); i += 1, cursor += 1) {
    votes.push({ applicantId, reviewerId: reviewers[cursor], value: VoteValue.YES });
  }
  for (let i = 0; i < (spec.no ?? 0); i += 1, cursor += 1) {
    votes.push({ applicantId, reviewerId: reviewers[cursor], value: VoteValue.NO });
  }
  for (let i = 0; i < (spec.skipVotes ?? 0); i += 1, cursor += 1) {
    votes.push({ applicantId, reviewerId: reviewers[cursor], value: VoteValue.SKIP });
  }

  return { reviewerIds: reviewers, applicantIds: [applicantId], votes, conflicts };
}

const resolutionOf = (input: PassInput) => resolveApplicant("app", input).resolution;

// ---------------------------------------------------------------------------
// BUILD_PLAN's Phase 6 cases, in order
// ---------------------------------------------------------------------------

describe("BUILD_PLAN Phase 6 — the cases written before the code", () => {
  it("A: 11 YES → SPARKLET", () => {
    expect(resolutionOf(pass({ yes: 11 }))).toBe(PassResolution.SPARKLET);
  });

  it("B: 11 NO → REJECTED", () => {
    expect(resolutionOf(pass({ no: 11 }))).toBe(PassResolution.REJECTED);
  });

  it("C: 7 YES, 4 NO → CARRIED", () => {
    expect(resolutionOf(pass({ yes: 7, no: 4 }))).toBe(PassResolution.CARRIED);
  });

  it("D: 2 COI, other 9 all YES → SPARKLET, COI excluded from unanimity", () => {
    const result = resolveApplicant("app", pass({ coi: 2, yes: 9 }));

    expect(result.resolution).toBe(PassResolution.SPARKLET);
    // The tally is the part that has to be right for FR-18 as well as for this:
    // nine eligible, two skipping, and the skips counted somewhere rather than
    // vanishing.
    expect(result.tally).toEqual({ yes: 9, no: 0, skip: 2, outstanding: 0, eligible: 9 });
  });

  it("E: all 11 COI → NEEDS_ADMIN, never SPARKLET, never REJECTED", () => {
    const result = resolveApplicant("app", pass({ coi: 11 }));

    // The case §7.4 calls out by name. An empty eligible set makes "all YES" and
    // "all NO" both vacuously true, so this is the one branch whose ORDER in the
    // implementation is load-bearing rather than incidental.
    expect(result.resolution).toBe(PassResolution.NEEDS_ADMIN);
    expect(result.tally).toEqual({ yes: 0, no: 0, skip: 11, outstanding: 0, eligible: 0 });
  });

  it("F: 5 of 11 votes in → unresolved, and a close does not change that", () => {
    const result = resolveApplicant("app", pass({ yes: 3, no: 2 }));

    expect(result.resolution).toBeNull();
    expect(result.tally.outstanding).toBe(6);
    // Decision 72: closing writes nothing, so the row a closed pass leaves is
    // still the null this returns. Asserted as the pair it is — `null` has to be
    // both "not yet" and "left that way", and nothing else may fill it in.
    expect(isMutableResolution(result.resolution)).toBe(true);
  });

  it("reviewer added between passes: pass 1 is computed against pass 1's roster", () => {
    // Decisions 66 and 78, as amended by 84, make this unreachable through the
    // roster page once the first pass exists, but the function must still be
    // correct about it: the electorate is an argument, so
    // a pass computed with eleven reviewers stays an eleven-reviewer pass no
    // matter who is on the roster when it is recomputed.
    const eleven = pass({ yes: 11 });
    expect(resolutionOf(eleven)).toBe(PassResolution.SPARKLET);

    const twelve: PassInput = { ...eleven, reviewerIds: [...REVIEWERS, "rev-12"] };
    // The twelfth has not voted, so the same votes no longer resolve.
    expect(resolutionOf(twelve)).toBeNull();
  });

  it("G manually rejected: the recount never overwrites it", () => {
    // The pure half of decision 71. A manual reject is not a computed outcome —
    // what this asserts is that the computed outcome may not be written over it,
    // which is the property that keeps a late vote from undoing an admin.
    expect(isMutableResolution(PassResolution.REJECTED)).toBe(false);
    expect(resolutionOf(pass({ yes: 4 }))).toBeNull();
  });

  it("H unresolved at close: NULL and CARRIED both become NEEDS_ADMIN", () => {
    // Decision 73. Both, or a CARRIED final row is invisible to FR-19.
    expect(needsAdminAtClose(null)).toBe(true);
    expect(needsAdminAtClose(PassResolution.CARRIED)).toBe(true);
  });

  it("running the close twice changes nothing the second time", () => {
    // §7.4 requires idempotence. It falls out of the predicate: after the first
    // run every row it matched holds NEEDS_ADMIN, which it does not match.
    expect(needsAdminAtClose(PassResolution.NEEDS_ADMIN)).toBe(false);
    expect(needsAdminAtClose(PassResolution.SPARKLET)).toBe(false);
    expect(needsAdminAtClose(PassResolution.REJECTED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Boundaries the requirement implies and does not enumerate
// ---------------------------------------------------------------------------

describe("the empty and near-empty eligible set", () => {
  it("2 COI and 9 outstanding is unresolved, not NEEDS_ADMIN", () => {
    // The distinction the all-COI branch has to be careful about: some conflicts
    // is not no eligible reviewers. Nine people simply have not voted yet.
    const result = resolveApplicant("app", pass({ coi: 2 }));

    expect(result.resolution).toBeNull();
    expect(result.tally).toEqual({ yes: 0, no: 0, skip: 2, outstanding: 9, eligible: 9 });
  });

  it("10 COI and 1 YES is SPARKLET — one eligible reviewer is unanimity", () => {
    expect(resolutionOf(pass({ coi: 10, yes: 1 }))).toBe(PassResolution.SPARKLET);
  });

  it("10 COI and 1 outstanding is unresolved", () => {
    expect(resolutionOf(pass({ coi: 10 }))).toBeNull();
  });

  it("an empty roster resolves every member NEEDS_ADMIN", () => {
    // Decision 79 blocks creating such a pass. This is why: with no electorate
    // the whole membership flags at creation, which is indistinguishable at a
    // glance from the all-COI case it is not.
    const input: PassInput = {
      reviewerIds: [],
      applicantIds: ["app", "app-2"],
      votes: [],
      conflicts: [],
    };

    expect(resolvePass(input).map((row) => row.resolution)).toEqual([
      PassResolution.NEEDS_ADMIN,
      PassResolution.NEEDS_ADMIN,
    ]);
  });
});

describe("skips that are not conflicts", () => {
  it("a stored SKIP row counts as a skip", () => {
    // Nothing writes one. The column permits one, and "skip" is what it would
    // mean, so it has a defined answer rather than an assertion hiding it.
    const result = resolveApplicant("app", pass({ skipVotes: 2, yes: 9 }));

    expect(result.resolution).toBe(PassResolution.SPARKLET);
    expect(result.tally.skip).toBe(2);
  });

  it("every eligible reviewer storing SKIP is NEEDS_ADMIN", () => {
    expect(resolutionOf(pass({ skipVotes: 11 }))).toBe(PassResolution.NEEDS_ADMIN);
  });

  it("6 YES, 3 NO, 2 COI is CARRIED and reports the skips", () => {
    const result = resolveApplicant("app", pass({ coi: 2, yes: 6, no: 3 }));

    expect(result.resolution).toBe(PassResolution.CARRIED);
    expect(result.tally).toEqual({ yes: 6, no: 3, skip: 2, outstanding: 0, eligible: 9 });
  });
});

describe("votes that must not count", () => {
  it("a vote from someone off the roster is ignored", () => {
    // The roster is the denominator. An orphan row from a reviewer no longer in
    // the round must not be able to complete a unanimity — decisions 66 and 78,
    // as amended by 84, stop one being created once the first pass exists, and
    // this stops one that exists from mattering.
    const input = pass({ yes: 10 });
    const withOrphan: PassInput = {
      ...input,
      votes: [...input.votes, { applicantId: "app", reviewerId: "ghost", value: VoteValue.YES }],
    };

    expect(resolutionOf(withOrphan)).toBeNull();
    expect(resolveApplicant("app", withOrphan).tally.eligible).toBe(11);
  });

  it("a conflict beats a vote row on the same reviewer", () => {
    // Decision 68 deletes the vote when the conflict is flagged, so the two
    // never coexist. This asserts the OUTCOME rather than trusting the deletion:
    // if one ever survived a partial failure, the conflict still wins, because a
    // vote from someone who has since disclosed a conflict cannot count toward
    // unanimity.
    const input: PassInput = {
      reviewerIds: REVIEWERS,
      applicantIds: ["app"],
      votes: REVIEWERS.map((reviewerId) => ({
        applicantId: "app",
        reviewerId,
        value: VoteValue.YES,
      })),
      conflicts: [{ applicantId: "app", reviewerId: "rev-1" }],
    };

    const result = resolveApplicant("app", input);

    expect(result.resolution).toBe(PassResolution.SPARKLET);
    expect(result.tally).toEqual({ yes: 10, no: 0, skip: 1, outstanding: 0, eligible: 10 });
  });
});

describe("decision 76 — an admin removes a conflict", () => {
  it("all-COI falls back to unresolved when one conflict is dropped", () => {
    expect(resolutionOf(pass({ coi: 11 }))).toBe(PassResolution.NEEDS_ADMIN);

    // The same pass with one fewer conflict. The reviewer returns OUTSTANDING —
    // decision 68 destroyed their vote at flag time and it does not come back —
    // so the applicant needs a vote they did not need a moment ago.
    const dropped = pass({ coi: 10 });
    const result = resolveApplicant("app", dropped);

    expect(result.resolution).toBeNull();
    expect(result.tally.outstanding).toBe(1);
  });

  it("NEEDS_ADMIN is the one written resolution a recount may replace", () => {
    // Which is what makes the fallback above reachable at all.
    expect(isMutableResolution(PassResolution.NEEDS_ADMIN)).toBe(true);
    expect(isMutableResolution(null)).toBe(true);

    // And these are the three it may not. CARRIED is here deliberately: the pass
    // had its say, every eligible reviewer submitted, and that is what gives
    // decision 75's "changeable until that applicant resolves" a definite end.
    expect(isMutableResolution(PassResolution.SPARKLET)).toBe(false);
    expect(isMutableResolution(PassResolution.REJECTED)).toBe(false);
    expect(isMutableResolution(PassResolution.CARRIED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What a resolution does to everything else
// ---------------------------------------------------------------------------

describe("decisions 69 and 70 — what gets written alongside", () => {
  it("SPARKLET and REJECTED are terminal and move the applicant", () => {
    expect(isTerminal(PassResolution.SPARKLET)).toBe(true);
    expect(isTerminal(PassResolution.REJECTED)).toBe(true);
    expect(statusFor(PassResolution.SPARKLET)).toBe(ApplicantStatus.SPARKLET);
    expect(statusFor(PassResolution.REJECTED)).toBe(ApplicantStatus.REJECTED);
  });

  it("CARRIED and NEEDS_ADMIN leave the applicant ACTIVE", () => {
    // §7.4 is emphatic: there is no UNRESOLVED status, and an applicant's fate
    // at the end of the round lives on their final pass row. A second copy on
    // the applicant could disagree with the first.
    expect(isTerminal(PassResolution.CARRIED)).toBe(false);
    expect(isTerminal(PassResolution.NEEDS_ADMIN)).toBe(false);
    expect(statusFor(PassResolution.CARRIED)).toBeNull();
    expect(statusFor(PassResolution.NEEDS_ADMIN)).toBeNull();
    expect(statusFor(null)).toBeNull();
  });

  it("only a terminal resolution writes a Decision row", () => {
    expect(decisionOutcomeFor(PassResolution.SPARKLET)).toBe(DecisionOutcome.SPARKLET);
    expect(decisionOutcomeFor(PassResolution.REJECTED)).toBe(DecisionOutcome.REJECT);

    // Decision 70: nothing has been decided yet, which is the entire meaning of
    // NEEDS_ADMIN. CARRIED writes none either — the applicant is still in the
    // round, and UNIQUE (applicantId, stage) gives them one second-round
    // decision to spend.
    expect(decisionOutcomeFor(PassResolution.NEEDS_ADMIN)).toBeNull();
    expect(decisionOutcomeFor(PassResolution.CARRIED)).toBeNull();
    expect(decisionOutcomeFor(null)).toBeNull();
  });
});

describe("SECOND_ROUND_POOL", () => {
  it("is status ACTIVE with no round qualifier", () => {
    // FR-17's membership rule, pinned. Pass creation and the close-second-round
    // action both read it, and decision 41 dropped ADVANCED from the status enum
    // precisely so it could stay this simple. A `stageReached` clause added here
    // would be a second definition of the same set.
    expect(SECOND_ROUND_POOL).toEqual({ status: ApplicantStatus.ACTIVE });
  });
});

// ---------------------------------------------------------------------------
// FR-18's grid
// ---------------------------------------------------------------------------

describe("buildPassGrid", () => {
  const three = ["rev-1", "rev-2", "rev-3"];

  const input: PassInput = {
    reviewerIds: three,
    applicantIds: ["yes-all", "mixed", "conflicted", "waiting"],
    votes: [
      { applicantId: "yes-all", reviewerId: "rev-1", value: VoteValue.YES },
      { applicantId: "yes-all", reviewerId: "rev-2", value: VoteValue.YES },
      { applicantId: "yes-all", reviewerId: "rev-3", value: VoteValue.YES },
      { applicantId: "mixed", reviewerId: "rev-1", value: VoteValue.YES },
      { applicantId: "mixed", reviewerId: "rev-2", value: VoteValue.NO },
      { applicantId: "mixed", reviewerId: "rev-3", value: VoteValue.NO },
      { applicantId: "conflicted", reviewerId: "rev-2", value: VoteValue.YES },
      { applicantId: "waiting", reviewerId: "rev-1", value: VoteValue.YES },
    ],
    conflicts: [
      { applicantId: "conflicted", reviewerId: "rev-1" },
      { applicantId: "conflicted", reviewerId: "rev-3" },
    ],
  };

  it("renders blank / yes / no / skip per reviewer, in roster order", () => {
    const grid = buildPassGrid(input);

    expect(grid.reviewerIds).toEqual(three);
    expect(grid.rows.map((row) => row.cells)).toEqual([
      ["YES", "YES", "YES"],
      ["YES", "NO", "NO"],
      // The conflicted applicant: skip, the one real vote, skip.
      ["SKIP", "YES", "SKIP"],
      ["YES", "OUTSTANDING", "OUTSTANDING"],
    ]);
  });

  it("carries the tally and the resolution on every row", () => {
    const grid = buildPassGrid(input);

    expect(grid.rows.map((row) => row.resolution)).toEqual([
      PassResolution.SPARKLET,
      PassResolution.CARRIED,
      // One eligible reviewer voting yes is unanimity.
      PassResolution.SPARKLET,
      null,
    ]);
    expect(grid.rows[2].tally).toEqual({ yes: 1, no: 0, skip: 2, outstanding: 0, eligible: 1 });
  });

  it("keeps rows in the order the caller passed them", () => {
    const grid = buildPassGrid(input);
    expect(grid.rows.map((row) => row.applicantId)).toEqual(input.applicantIds);
  });

  it("a stored resolution wins over the recount, and both stay visible", () => {
    // The case that makes the `stored` parameter necessary rather than tidy: a
    // manually rejected applicant (decision 71) recomputes to CARRIED, and
    // rendering that would tell an admin the rejection they performed had not
    // happened.
    const grid = buildPassGrid(input, new Map([["mixed", PassResolution.REJECTED]]));
    const row = grid.rows[1];

    expect(row.resolution).toBe(PassResolution.REJECTED);
    expect(row.stored).toBe(PassResolution.REJECTED);
    expect(row.computed).toBe(PassResolution.CARRIED);
  });

  it("falls back to the recount where nothing is stored", () => {
    const grid = buildPassGrid(input, new Map([["mixed", null]]));

    expect(grid.rows[1].resolution).toBe(PassResolution.CARRIED);
    expect(grid.rows[1].stored).toBeNull();
  });
});

describe("effectiveVote", () => {
  it("is SKIP for a conflict whatever the vote says", () => {
    expect(effectiveVote(VoteValue.YES, true)).toBe("SKIP");
    expect(effectiveVote(null, true)).toBe("SKIP");
  });

  it("is OUTSTANDING only when there is no row and no conflict", () => {
    expect(effectiveVote(null, false)).toBe("OUTSTANDING");
    expect(effectiveVote(undefined, false)).toBe("OUTSTANDING");
    expect(effectiveVote(VoteValue.SKIP, false)).toBe("SKIP");
  });
});

// ---------------------------------------------------------------------------
// Slice 7: the creation guards and the pass list
// ---------------------------------------------------------------------------

describe("passCreationBlock", () => {
  const ready = {
    inSecondRound: true,
    openPassOrdinal: null,
    poolSize: 40,
    reviewerCount: 11,
  };

  it("allows creation when the round is open, nothing is open, and both sides are non-empty", () => {
    expect(passCreationBlock(ready)).toBeNull();
  });

  it("blocks outside the second round, and says the round cannot be reopened", () => {
    const block = passCreationBlock({ ...ready, inSecondRound: false });

    expect(block).not.toBeNull();
    expect(block).toMatch(/cannot be reopened/);
  });

  /// Clause 17c, the half the partial index does not cover: the index makes a
  /// second OPEN row impossible, and this is what makes the refusal legible.
  it("blocks a second pass while one is open, naming the one that is open", () => {
    const block = passCreationBlock({ ...ready, openPassOrdinal: 2 });

    expect(block).toMatch(/Pass 2 is still open/);
  });

  /// §7.4: "Block creation, tell the admin the pool is resolved."
  it("blocks an empty pool", () => {
    expect(passCreationBlock({ ...ready, poolSize: 0 })).toMatch(/Every applicant has been decided/);
  });

  /// Decision 79, whose message must "name the fix, which is the reviewer roster".
  it("blocks an empty second-round roster and names the roster", () => {
    expect(passCreationBlock({ ...ready, reviewerCount: 0 })).toMatch(/second-round roster/);
  });

  /// The order is the specification: in a COMPLETE instance the other three
  /// questions are not worth asking, and an admin told "no reviewers" would go
  /// fix the wrong thing.
  it("reports the stage before any other block when several apply at once", () => {
    const block = passCreationBlock({
      inSecondRound: false,
      openPassOrdinal: 1,
      poolSize: 0,
      reviewerCount: 0,
    });

    expect(block).toMatch(/second round/);
    expect(block).not.toMatch(/roster/);
  });

  it("reports the open pass before the two emptiness blocks", () => {
    const block = passCreationBlock({
      ...ready,
      openPassOrdinal: 3,
      poolSize: 0,
      reviewerCount: 0,
    });

    expect(block).toMatch(/Pass 3 is still open/);
  });
});

describe("summarizePass", () => {
  const source = {
    id: "pass-1",
    ordinal: 1,
    status: PassStatus.CLOSED,
    openedAt: new Date("2026-08-24T10:00:00Z"),
    closedAt: new Date("2026-08-24T11:00:00Z"),
    resolutions: [
      PassResolution.SPARKLET,
      PassResolution.SPARKLET,
      PassResolution.REJECTED,
      PassResolution.CARRIED,
      PassResolution.NEEDS_ADMIN,
      null,
      null,
    ],
  };

  it("counts each resolution, and nulls as unresolved", () => {
    const summary = summarizePass(source);

    expect(summary).toMatchObject({
      memberCount: 7,
      sparklet: 2,
      rejected: 1,
      carried: 1,
      needsAdmin: 1,
      unresolved: 2,
    });
  });

  it("carries the pass's own identity through unchanged", () => {
    const summary = summarizePass(source);

    expect(summary.id).toBe("pass-1");
    expect(summary.ordinal).toBe(1);
    expect(summary.status).toBe(PassStatus.CLOSED);
    expect(summary.closedAt).toEqual(source.closedAt);
  });

  /// Decision 72: closing writes no resolution, so a closed pass legitimately
  /// carries nulls. They are unresolved, not a zero-member pass.
  it("counts a freshly created pass as entirely unresolved", () => {
    const summary = summarizePass({
      ...source,
      status: PassStatus.OPEN,
      closedAt: null,
      resolutions: [null, null, null],
    });

    expect(summary.memberCount).toBe(3);
    expect(summary.unresolved).toBe(3);
    expect(summary.sparklet + summary.rejected + summary.carried + summary.needsAdmin).toBe(0);
  });

  it("handles a pass with no members at all", () => {
    const summary = summarizePass({ ...source, resolutions: [] });

    expect(summary.memberCount).toBe(0);
    expect(summary.unresolved).toBe(0);
  });
});

describe("voteAvailability", () => {
  const open = {
    applicantStatus: ApplicantStatus.ACTIVE,
    hasOpenPass: true,
    isMember: true,
    hasConflict: false,
    storedResolution: null,
    currentVote: null,
  };

  it("is OPEN with no current vote for a member of an open pass", () => {
    expect(voteAvailability(open)).toEqual({ kind: "OPEN", current: null });
  });

  /// Decision 75: changeable until the applicant resolves, so the control comes
  /// back carrying what was submitted rather than blank.
  it("carries the reviewer's own existing vote back into the control", () => {
    expect(voteAvailability({ ...open, currentVote: VoteValue.YES })).toEqual({
      kind: "OPEN",
      current: VoteValue.YES,
    });
  });

  it("is NO_PASS when nothing is open", () => {
    expect(voteAvailability({ ...open, hasOpenPass: false })).toEqual({ kind: "NO_PASS" });
  });

  it("is NOT_IN_PASS for an applicant outside the fixed membership", () => {
    expect(voteAvailability({ ...open, isMember: false })).toEqual({ kind: "NOT_IN_PASS" });
  });

  /// Clause 17f.
  it("is CONFLICT for a conflicted reviewer", () => {
    expect(voteAvailability({ ...open, hasConflict: true })).toEqual({ kind: "CONFLICT" });
  });

  /// The conflict outranks everything below it: decision 68 already deleted the
  /// vote, so "the pass has settled" would answer a question they did not ask.
  it("reports the conflict ahead of a settled resolution", () => {
    expect(
      voteAvailability({
        ...open,
        hasConflict: true,
        storedResolution: PassResolution.CARRIED,
      }),
    ).toEqual({ kind: "CONFLICT" });
  });

  /// Decision 75's window shutting on its own: CARRIED means every eligible
  /// reviewer submitted and they disagreed, which is a completed outcome.
  ///
  /// **And it says nothing about which way.** Decisions 83 and 83a: the settled
  /// state is a prop to a client component, so a resolution on it would travel
  /// in the page payload whether or not it rendered. `toStrictEqual` is what
  /// catches a key coming back.
  it("is SETTLED once the pass has concluded on the applicant, and carries no outcome", () => {
    expect(
      voteAvailability({ ...open, storedResolution: PassResolution.CARRIED }),
    ).toStrictEqual({ kind: "SETTLED" });

    expect(
      voteAvailability({ ...open, storedResolution: PassResolution.SPARKLET }),
    ).toStrictEqual({ kind: "SETTLED" });
  });

  /// Decision 76's whole point: an admin removed this reviewer's conflict, the
  /// row still carries the all-COI NEEDS_ADMIN, and the vote they cast now is
  /// what resolves it. NEEDS_ADMIN is mutable, so it must not read as settled.
  it("is OPEN on a NEEDS_ADMIN row once the reviewer's conflict is gone", () => {
    expect(
      voteAvailability({ ...open, storedResolution: PassResolution.NEEDS_ADMIN }),
    ).toEqual({ kind: "OPEN", current: null });
  });

  /// The same predicate the persistence layer writes through, asserted as one
  /// fact rather than two that could drift.
  it("refuses exactly the rows a recount refuses to overwrite", () => {
    for (const resolution of [
      PassResolution.SPARKLET,
      PassResolution.REJECTED,
      PassResolution.CARRIED,
      PassResolution.NEEDS_ADMIN,
      null,
    ]) {
      const availability = voteAvailability({ ...open, storedResolution: resolution });
      expect(availability.kind === "SETTLED").toBe(!isMutableResolution(resolution));
    }
  });

  // -------------------------------------------------------------------------
  // Decisions 111 and 112 — the terminal outcome, named
  // -------------------------------------------------------------------------

  /// Decision 111 reverses decision 74's outcome half. The cost is stated there
  /// and is real: a terminal outcome is unanimous by construction, so this tells
  /// the reviewer who cast the last vote how every other one voted.
  it("is RESOLVED and names the outcome for a Sparklet", () => {
    expect(
      voteAvailability({ ...open, applicantStatus: ApplicantStatus.SPARKLET }),
    ).toStrictEqual({ kind: "RESOLVED", outcome: "SPARKLET" });
  });

  it("is RESOLVED and names the outcome for a rejected applicant", () => {
    expect(
      voteAvailability({ ...open, applicantStatus: ApplicantStatus.REJECTED }),
    ).toStrictEqual({ kind: "RESOLVED", outcome: "REJECTED" });
  });

  /// **The case the built product actually reaches, and the one the old code
  /// 404'd on.** An applicant resolved in pass 1 is not a member of pass 2, so
  /// the open pass has nothing to say about them. Reading the outcome off
  /// `Applicant.status` rather than off a pass row is what makes this answerable
  /// at all — `isMember: false` would otherwise win and report NOT_IN_PASS,
  /// which is true and useless.
  it("is RESOLVED for an applicant decided by an earlier pass, not NOT_IN_PASS", () => {
    expect(
      voteAvailability({
        ...open,
        applicantStatus: ApplicantStatus.SPARKLET,
        isMember: false,
        storedResolution: null,
      }),
    ).toStrictEqual({ kind: "RESOLVED", outcome: "SPARKLET" });
  });

  /// After the round closes there is no open pass at all, and the outcome is
  /// still the thing the reviewer is owed.
  it("is RESOLVED with no pass open", () => {
    expect(
      voteAvailability({
        ...open,
        applicantStatus: ApplicantStatus.REJECTED,
        hasOpenPass: false,
      }),
    ).toStrictEqual({ kind: "RESOLVED", outcome: "REJECTED" });
  });

  /// RESOLVED outranks the conflict, unlike SETTLED which does not. Every other
  /// state answers "may this reviewer vote now"; this one answers "may anyone
  /// ever again", and the conflict control beside it still shows the recusal.
  it("reports the outcome ahead of the reviewer's own conflict", () => {
    expect(
      voteAvailability({
        ...open,
        applicantStatus: ApplicantStatus.SPARKLET,
        hasConflict: true,
      }),
    ).toStrictEqual({ kind: "RESOLVED", outcome: "SPARKLET" });
  });

  /// Decision 112 keeps CARRIED and NEEDS_ADMIN uncoloured and unnamed. CARRIED
  /// stays SETTLED and stays empty — `toStrictEqual` is what catches an outcome
  /// key arriving on it, which would travel in the RSC payload whether or not
  /// the component rendered it.
  it("leaves a CARRIED applicant settled and unnamed", () => {
    expect(
      voteAvailability({ ...open, storedResolution: PassResolution.CARRIED }),
    ).toStrictEqual({ kind: "SETTLED" });
  });

  /// The vocabulary and the state machine, asserted to agree. Same drift guard
  /// `needsAdminAtClose` and `UNRESOLVED_AT_CLOSE` carry: a fifth resolution
  /// cannot teach only one of them.
  it("agrees with isTerminal about which resolutions are outcomes", () => {
    for (const resolution of [
      PassResolution.SPARKLET,
      PassResolution.REJECTED,
      PassResolution.CARRIED,
      PassResolution.NEEDS_ADMIN,
      null,
    ]) {
      expect(outcomeOfResolution(resolution) !== null).toBe(isTerminal(resolution));
    }
  });
});

describe("decision 107 — reversing a manual reject", () => {
  /// Exactly the state `manuallyReject` leaves behind in an open pass: the row,
  /// the status, and the ADMIN/REJECT decision row that names a person as the
  /// one who decided.
  const reversible: ReversalContext = {
    passStatus: PassStatus.OPEN,
    storedResolution: PassResolution.REJECTED,
    applicantStatus: ApplicantStatus.REJECTED,
    decision: { actor: DecisionActor.ADMIN, outcome: DecisionOutcome.REJECT },
  };

  it("allows reversing a manual reject in the open pass", () => {
    expect(reversalBlock(reversible)).toBeNull();
  });

  /// Decision 106's scope, and 17y: nothing in a closed pass changes.
  it("blocks once the pass is closed, and says so", () => {
    const block = reversalBlock({ ...reversible, passStatus: PassStatus.CLOSED });

    expect(block).toMatch(/closed/);
    expect(block).toMatch(/cannot be reopened/);
  });

  /// Only a REJECTED row can be reversed. The other four are not rejections —
  /// SPARKLET is the opposite one, CARRIED and NEEDS_ADMIN decided nothing, and
  /// null is a pass still waiting.
  it("blocks every row that is not REJECTED", () => {
    for (const resolution of [
      PassResolution.SPARKLET,
      PassResolution.CARRIED,
      PassResolution.NEEDS_ADMIN,
      null,
    ]) {
      expect(reversalBlock({ ...reversible, storedResolution: resolution })).toMatch(
        /has not rejected/,
      );
    }
  });

  /// The distinction 106 is built on: decision 69 writes SYSTEM for a unanimous
  /// tally and ADMIN for a person. A vote-driven REJECTED row is not reversible,
  /// and the message says why rather than merely refusing.
  it("blocks a REJECTED row decided by a unanimous vote, naming the vote", () => {
    const block = reversalBlock({
      ...reversible,
      decision: { actor: DecisionActor.SYSTEM, outcome: DecisionOutcome.REJECT },
    });

    expect(block).toMatch(/unanimous vote/);
    expect(block).toMatch(/not by an admin/);
  });

  it("blocks a REJECTED row with no decision at all", () => {
    expect(reversalBlock({ ...reversible, decision: null })).toMatch(/unanimous vote/);
  });

  /// Defensive, and exhaustive over what the row can hold.
  it("blocks an ADMIN decision that is not a REJECT", () => {
    expect(
      reversalBlock({
        ...reversible,
        decision: { actor: DecisionActor.ADMIN, outcome: DecisionOutcome.SPARKLET },
      }),
    ).toMatch(/not a rejection/);
  });

  /// The row still reads REJECTED but the applicant does not: another tab got
  /// there first, between this one's read and its submit.
  it("blocks when the applicant is already back to ACTIVE, as already reversed", () => {
    expect(reversalBlock({ ...reversible, applicantStatus: ApplicantStatus.ACTIVE })).toMatch(
      /already been reversed/,
    );
  });

  /// Order is the specification, matching `manuallyReject`: the pass is asked
  /// about first, so a closed pass with a vote-driven row reports the closed
  /// pass — the reason nothing on that page can change, rather than the reason
  /// this row in particular could not.
  it("reports the closed pass ahead of every other block", () => {
    const block = reversalBlock({
      passStatus: PassStatus.CLOSED,
      storedResolution: PassResolution.CARRIED,
      applicantStatus: ApplicantStatus.ACTIVE,
      decision: { actor: DecisionActor.SYSTEM, outcome: DecisionOutcome.REJECT },
    });

    expect(block).toMatch(/closed/);
    expect(block).not.toMatch(/unanimous/);
  });

  /// **The regression guard.** A reversal exists, and a REJECTED row is still
  /// immovable to every recount. Loosening `isMutableResolution` to admit the
  /// reversal would reopen decision 71's hole — a vote in flight overwriting a
  /// manual reject — which is exactly why the reversal has its own predicate.
  it("does not loosen the recount rule: a reversible row is still not mutable", () => {
    expect(reversalBlock(reversible)).toBeNull();
    expect(isMutableResolution(reversible.storedResolution)).toBe(false);
    expect(isTerminal(reversible.storedResolution)).toBe(true);
  });
});

describe("resolutionLabel", () => {
  it("names every resolution in §7.4's vocabulary", () => {
    expect(resolutionLabel(PassResolution.SPARKLET)).toBe("Sparklet");
    expect(resolutionLabel(PassResolution.REJECTED)).toBe("Rejected");
    expect(resolutionLabel(PassResolution.CARRIED)).toBe("Carried");
    expect(resolutionLabel(PassResolution.NEEDS_ADMIN)).toBe("Needs an admin");
  });

  /// Null is not a fifth resolution: the pass has not finished with them. And
  /// the word is not "Unresolved", which FR-19 uses for a different predicate.
  it("distinguishes a null row from every stored value, without FR-19's word", () => {
    expect(resolutionLabel(null)).toBe("No resolution");

    const stored = Object.values(PassResolution).map((value) => resolutionLabel(value));
    expect(stored).not.toContain("No resolution");
    expect([...stored, resolutionLabel(null)]).not.toContain("Unresolved");
  });

  /// The guard the type already gives, asserted so a new enum member cannot ship
  /// a blank cell if someone widens the map's type later.
  it("has a label for every member of the enum", () => {
    for (const value of Object.values(PassResolution)) {
      expect(RESOLUTION_LABEL[value]).toBeTruthy();
    }
  });
});

describe("closeRoundBlock", () => {
  const ready = { stage: InstanceStage.SECOND_ROUND, passCount: 3 };

  it("allows the close in the second round with at least one pass", () => {
    expect(closeRoundBlock(ready)).toBeNull();
  });

  /// Clause 17s, and the message has to name the fix rather than only the rule.
  it("blocks with no pass and says to create one", () => {
    const block = closeRoundBlock({ ...ready, passCount: 0 });

    expect(block).toMatch(/Create a pass/i);
  });

  it("blocks before the round has started", () => {
    expect(closeRoundBlock({ ...ready, stage: InstanceStage.WRITTEN })).toMatch(/not started/);
    expect(closeRoundBlock({ ...ready, stage: InstanceStage.FIRST_ROUND })).toMatch(/not started/);
  });

  /// The page renders this as an explanation. The ACTION must not treat it as an
  /// error — 17r makes a second close a no-op, not a failure — which is why the
  /// action checks COMPLETE before it consults this.
  it("reports a closed round rather than allowing a second close", () => {
    expect(closeRoundBlock({ ...ready, stage: InstanceStage.COMPLETE })).toBe(
      "The second round is closed.",
    );
  });

  it("reports the closed round even with no pass, since the round is over either way", () => {
    expect(closeRoundBlock({ stage: InstanceStage.COMPLETE, passCount: 0 })).toBe(
      "The second round is closed.",
    );
  });
});

describe("UNRESOLVED_AT_CLOSE agrees with needsAdminAtClose", () => {
  /// **One rule, two spellings, pinned together.** `needsAdminAtClose` answers
  /// for a stored value and `UNRESOLVED_AT_CLOSE` selects the rows; decision 73
  /// says both mean "NULL or CARRIED". Adding a fifth `PassResolution` and
  /// teaching only one of them about it fails here rather than in production,
  /// where it would look like a close that silently skipped some applicants.
  const selected = new Set(
    UNRESOLVED_AT_CLOSE.OR.map((clause) => clause.resolution as PassResolution | null),
  );

  const everyValue: (PassResolution | null)[] = [...Object.values(PassResolution), null];

  it("selects exactly the values the predicate accepts", () => {
    for (const value of everyValue) {
      expect(selected.has(value)).toBe(needsAdminAtClose(value));
    }
  });

  /// Decision 73 spelled out, so the agreement above cannot be satisfied by both
  /// sides being wrong in the same direction.
  it("means NULL or CARRIED and nothing else", () => {
    expect(selected).toEqual(new Set([null, PassResolution.CARRIED]));
  });

  /// SPARKLET and REJECTED are never overwritten, which is what makes the action
  /// idempotent as §7.4 requires.
  it("never selects a terminal resolution", () => {
    expect(selected.has(PassResolution.SPARKLET)).toBe(false);
    expect(selected.has(PassResolution.REJECTED)).toBe(false);
  });
});

describe("conflictsInForce — decision 100", () => {
  const closedAt = new Date("2026-03-01T12:00:00Z");
  const conflicts = [
    { applicantId: "app", reviewerId: "rev-1", createdAt: new Date("2026-02-20T00:00:00Z") },
    { applicantId: "app", reviewerId: "rev-2", createdAt: closedAt },
    { applicantId: "app", reviewerId: "rev-3", createdAt: new Date("2026-03-05T00:00:00Z") },
  ];

  it("hands an open pass every conflict — the pass is still being decided", () => {
    expect(conflictsInForce(conflicts, { status: PassStatus.OPEN, closedAt: null })).toEqual(
      conflicts,
    );
  });

  it("hands a closed pass only the conflicts that existed when it closed", () => {
    const inForce = conflictsInForce(conflicts, { status: PassStatus.CLOSED, closedAt });
    expect(inForce.map((c) => c.reviewerId)).toEqual(["rev-1", "rev-2"]);
  });

  it("counts a conflict flagged at the closing instant as in force", () => {
    // `<=`, not `<`: the close and the flag can share a timestamp at the
    // database's resolution, and a conflict the close saw is one it honoured.
    const inForce = conflictsInForce([conflicts[1]], { status: PassStatus.CLOSED, closedAt });
    expect(inForce).toHaveLength(1);
  });

  it("treats a closed pass with no closedAt as open, rather than dropping everything", () => {
    // Defensive: the schema permits it and the honest reading of "closed at
    // nobody knows when" is that no conflict can be excluded on timing.
    expect(conflictsInForce(conflicts, { status: PassStatus.CLOSED, closedAt: null })).toEqual(
      conflicts,
    );
  });

  it("returns a copy, never the caller's array", () => {
    const open = conflictsInForce(conflicts, { status: PassStatus.OPEN, closedAt: null });
    expect(open).not.toBe(conflicts);
  });

  it("keeps a stored YES on a closed pass when the conflict came later", () => {
    // The defect as it showed on FR-18: a conflict flagged in a later pass
    // rendered SKIP over a YES stored in pass 1, and pass 1's tally moved. Read
    // through `conflictsInForce`, pass 1 shows what it showed when it closed.
    const votes = REVIEWERS.map((reviewerId) => ({
      applicantId: "app",
      reviewerId,
      value: VoteValue.YES,
    }));
    const later = [{ applicantId: "app", reviewerId: "rev-1", createdAt: new Date("2026-03-05") }];
    const closedPass = { status: PassStatus.CLOSED, closedAt };

    const asClosed = buildPassGrid({
      reviewerIds: REVIEWERS,
      applicantIds: ["app"],
      votes,
      conflicts: conflictsInForce(later, closedPass),
    }).rows[0];
    expect(asClosed.cells[0]).toBe("YES");
    expect(asClosed.tally).toEqual({ yes: 11, no: 0, skip: 0, outstanding: 0, eligible: 11 });

    // The same conflict on the open pass is in force, exactly as before.
    const asOpen = buildPassGrid({
      reviewerIds: REVIEWERS,
      applicantIds: ["app"],
      votes,
      conflicts: conflictsInForce(later, { status: PassStatus.OPEN, closedAt: null }),
    }).rows[0];
    expect(asOpen.cells[0]).toBe("SKIP");
    expect(asOpen.tally.eligible).toBe(10);
  });
});

describe("buildPassGrid tells a conflict skip from a stored skip (clause 18f)", () => {
  const reviewers = ["r1", "r2", "r3"];

  /// r1 has a conflict, r2 submitted a SKIP vote, r3 voted yes. All three of the
  /// first two render as `SKIP`, and only one of them is removable.
  const input: PassInput = {
    reviewerIds: reviewers,
    applicantIds: ["a"],
    votes: [
      { applicantId: "a", reviewerId: "r2", value: VoteValue.SKIP },
      { applicantId: "a", reviewerId: "r3", value: VoteValue.YES },
    ],
    conflicts: [{ applicantId: "a", reviewerId: "r1" }],
  };

  const row = buildPassGrid(input).rows[0];

  it("renders both as skip, because that is what FR-18 shows", () => {
    expect(row.cells).toEqual(["SKIP", "SKIP", "YES"]);
  });

  it("marks only the conflict one as a conflict", () => {
    expect(row.conflicts).toEqual([true, false, false]);
  });

  it("keeps the conflict flags aligned with the cells", () => {
    expect(row.conflicts).toHaveLength(row.cells.length);
    expect(row.conflicts).toHaveLength(reviewers.length);
  });

  /// Decision 68's invariant seen from the grid: a conflict outranks a vote, and
  /// the cell is a removable skip rather than the vote that should not exist.
  it("marks a conflict that coexists with a vote row", () => {
    const withBoth = buildPassGrid({
      ...input,
      votes: [{ applicantId: "a", reviewerId: "r1", value: VoteValue.YES }],
    }).rows[0];

    expect(withBoth.cells[0]).toBe("SKIP");
    expect(withBoth.conflicts[0]).toBe(true);
  });

  it("marks nothing where there are no conflicts at all", () => {
    const clean = buildPassGrid({ ...input, conflicts: [] }).rows[0];

    expect(clean.conflicts).toEqual([false, false, false]);
  });
});
