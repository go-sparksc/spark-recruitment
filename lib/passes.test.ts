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
  DecisionOutcome,
  PassResolution,
  VoteValue,
} from "@/generated/prisma/enums";
import {
  SECOND_ROUND_POOL,
  buildPassGrid,
  decisionOutcomeFor,
  effectiveVote,
  isMutableResolution,
  isTerminal,
  needsAdminAtClose,
  resolveApplicant,
  resolvePass,
  statusFor,
  type PassInput,
} from "@/lib/passes";

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
    // Decisions 66 and 78 make this unreachable through the roster page, but the
    // function must still be correct about it: the electorate is an argument, so
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
    // the round must not be able to complete a unanimity — decisions 66 and 78
    // stop one being created, and this stops one that exists from mattering.
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
