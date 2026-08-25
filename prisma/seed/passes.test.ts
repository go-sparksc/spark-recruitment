// Smoke coverage for the second-round fixture's shape. Not one of the four
// modules CLAUDE.md reserves full suites for — `lib/passes.ts` is what decides
// resolutions and is tested exhaustively there, and this file only decides who
// votes which way.
//
// What earns a test here is the property the fixture exists for: **every
// resolution the state machine can produce must actually appear.** A fixture
// missing a branch is worse than no fixture, because FR-19 and FR-20 then get
// developed against a state that looks complete. The pass-2 case below is not
// hypothetical — the first version handed the resolving role to the one
// applicant nobody could vote on, and the run looked entirely plausible while
// producing no SPARKLET in that pass.

import { describe, expect, it } from "vitest";

import { VoteValue } from "../../generated/prisma/enums";
import {
  MINIMUM_POOL,
  planConflicts,
  planPassOne,
  planPassTwo,
  votesFor,
  type PassOneRole,
} from "./passes";

const reviewerIds = Array.from({ length: 12 }, (_, index) => `rev-${index}`);
const pool = (size: number) => Array.from({ length: size }, (_, index) => `app-${index}`);

describe("planPassOne", () => {
  it("produces every role, so no resolution branch goes unexercised", () => {
    const roles = new Set(planPassOne(pool(30)).map((entry) => entry.role));
    const required: PassOneRole[] = [
      "UNANIMOUS_YES",
      "UNANIMOUS_NO",
      "MIXED",
      "ONE_CONFLICT_THEN_YES",
      "ALL_CONFLICT",
      "PARTIAL",
      "ADMIN_REJECT",
    ];
    for (const role of required) expect(roles, role).toContain(role);
  });

  it("covers the whole pool, once each", () => {
    const plan = planPassOne(pool(30));
    expect(plan).toHaveLength(30);
    expect(new Set(plan.map((entry) => entry.applicantId)).size).toBe(30);
  });

  it("refuses a pool too small to carry every role", () => {
    // Silently dropping roles off the end is the failure this guards. The
    // message names the fix rather than the constraint.
    expect(() => planPassOne(pool(MINIMUM_POOL - 1))).toThrow(/at least/);
    expect(() => planPassOne(pool(MINIMUM_POOL))).not.toThrow();
  });

  it("is deterministic, so a screenshot stays true", () => {
    expect(planPassOne(pool(30))).toEqual(planPassOne(pool(30)));
  });
});

describe("planPassTwo", () => {
  it("gives the resolving roles to applicants who can actually be voted on", () => {
    // The regression. `app-0` is the all-COI applicant carried in from pass 1,
    // and it arrives first because pass membership is ordered by sourceRowIndex.
    const plan = planPassTwo(["app-0", "app-1", "app-2", "app-3"], new Set(["app-0"]));
    expect(plan[0]).toEqual({ applicantId: "app-0", role: "PARTIAL" });
    expect(plan.find((entry) => entry.role === "UNANIMOUS_YES")?.applicantId).toBe("app-1");
    expect(plan.find((entry) => entry.role === "UNANIMOUS_NO")?.applicantId).toBe("app-2");
  });

  it("produces both of decision 73's close-round cases", () => {
    // A `null` row (PARTIAL) and a `CARRIED` row (MIXED). The close converts
    // both to NEEDS_ADMIN, and handling only one would pass a fixture with only
    // one in it.
    const roles = new Set(planPassTwo(pool(8)).map((entry) => entry.role));
    expect(roles).toContain("PARTIAL");
    expect(roles).toContain("MIXED");
  });
});

describe("votesFor", () => {
  it("never returns SKIP, which decision 67 forbids as a stored row", () => {
    const roles: PassOneRole[] = [
      "UNANIMOUS_YES",
      "UNANIMOUS_NO",
      "MIXED",
      "ONE_CONFLICT_THEN_YES",
      "ALL_CONFLICT",
      "PARTIAL",
      "ADMIN_REJECT",
    ];
    for (const role of roles) {
      for (const vote of votesFor("app-0", role, reviewerIds, [])) {
        expect(vote.value, role).not.toBe(VoteValue.SKIP);
      }
    }
  });

  it("excludes recused reviewers rather than voting on their behalf", () => {
    const votes = votesFor("app-0", "ONE_CONFLICT_THEN_YES", reviewerIds, ["rev-0"]);
    expect(votes).toHaveLength(reviewerIds.length - 1);
    expect(votes.map((vote) => vote.reviewerId)).not.toContain("rev-0");
    expect(votes.every((vote) => vote.value === VoteValue.YES)).toBe(true);
  });

  it("casts nothing when every reviewer is recused", () => {
    expect(votesFor("app-0", "ALL_CONFLICT", reviewerIds, reviewerIds)).toEqual([]);
  });

  it("leaves PARTIAL short of the roster, so the row cannot resolve", () => {
    const votes = votesFor("app-0", "PARTIAL", reviewerIds, []);
    expect(votes.length).toBeGreaterThan(0);
    expect(votes.length).toBeLessThan(reviewerIds.length);
  });

  it("splits MIXED rather than making it one dissenter", () => {
    const votes = votesFor("app-0", "MIXED", reviewerIds, []);
    const no = votes.filter((vote) => vote.value === VoteValue.NO).length;
    expect(votes).toHaveLength(reviewerIds.length);
    expect(no).toBeGreaterThan(1);
    expect(no).toBeLessThan(votes.length);
  });
});

describe("planConflicts", () => {
  it("recuses every reviewer from the ALL_CONFLICT applicant and one from the other", () => {
    const plan = planPassOne(pool(30));
    const conflicts = planConflicts(plan, reviewerIds);

    const allConflictId = plan.find((entry) => entry.role === "ALL_CONFLICT")!.applicantId;
    const oneConflictId = plan.find((entry) => entry.role === "ONE_CONFLICT_THEN_YES")!.applicantId;

    expect(conflicts.filter((c) => c.applicantId === allConflictId)).toHaveLength(reviewerIds.length);
    expect(conflicts.filter((c) => c.applicantId === oneConflictId)).toHaveLength(1);
  });

  it("flags nobody else", () => {
    const plan = planPassOne(pool(30));
    const flagged = new Set(planConflicts(plan, reviewerIds).map((c) => c.applicantId));
    expect(flagged.size).toBe(2);
  });
});
