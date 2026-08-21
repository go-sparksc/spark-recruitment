// Smoke coverage for FR-14's pool predicate and row shaping. Not one of the
// four modules CLAUDE.md reserves full suites for — the interesting risks on
// that surface are §6 leakage and phone ergonomics, and neither is visible from
// here. What IS worth pinning is the predicate, because it has to agree with
// FR-15's finalize, and the SKIP narrowing, because the impossible case is
// exactly the one nobody would notice going wrong.

import { describe, expect, it } from "vitest";

import { ApplicantStatus, Round, VoteValue } from "@/generated/prisma/enums";
import {
  FIRST_ROUND_POOL,
  toFirstRoundListRow,
  votedCount,
  type FirstRoundApplicantSource,
} from "@/lib/first-round";

function source(overrides: Partial<FirstRoundApplicantSource> = {}): FirstRoundApplicantSource {
  return {
    id: "app-1",
    displayName: "Cecilia Fang",
    sourceRowIndex: 151,
    resultCount: 2,
    hasNotes: true,
    vote: null,
    ...overrides,
  };
}

describe("FIRST_ROUND_POOL", () => {
  it("is ACTIVE and stageReached FIRST_ROUND", () => {
    // FR-15's finalize writes Decision rows over this same set. If the two ever
    // disagree, a reviewer votes on someone who receives no decision, or an
    // applicant is decided on votes nobody was shown. Pinned here so a change on
    // either side has to be deliberate.
    expect(FIRST_ROUND_POOL).toEqual({
      status: ApplicantStatus.ACTIVE,
      stageReached: Round.FIRST_ROUND,
    });
  });

  it("is narrower than FR-13's import scoping", () => {
    // Decision 48 scopes the FR-12 import to `stageReached != WRITTEN`, which
    // deliberately still includes second-round applicants because an interview
    // sheet may name them. This set is who is being voted on NOW, so an
    // applicant who has advanced is out of it.
    expect(FIRST_ROUND_POOL.stageReached).toBe(Round.FIRST_ROUND);
    expect(FIRST_ROUND_POOL.stageReached).not.toBe(Round.SECOND_ROUND);
  });
});

describe("toFirstRoundListRow", () => {
  it("carries a YES and a NO through", () => {
    expect(toFirstRoundListRow(source({ vote: VoteValue.YES })).vote).toBe("YES");
    expect(toFirstRoundListRow(source({ vote: VoteValue.NO })).vote).toBe("NO");
  });

  it("reports no vote as null, which is what a skip is", () => {
    expect(toFirstRoundListRow(source({ vote: null })).vote).toBeNull();
  });

  it("narrows a SKIP row to null rather than showing it as a vote", () => {
    // Unreachable today: nothing writes a SKIP in this round. The second round
    // does, for a conflict of interest, and if one ever arrived here rendering
    // it as cast would tell a reviewer they had decided something they had not.
    expect(toFirstRoundListRow(source({ vote: VoteValue.SKIP })).vote).toBeNull();
  });

  it("passes through the interview-data counts clause 12q renders", () => {
    const none = toFirstRoundListRow(source({ resultCount: 0, hasNotes: false }));
    expect(none.resultCount).toBe(0);
    expect(none.hasNotes).toBe(false);

    const half = toFirstRoundListRow(source({ resultCount: 2, hasNotes: false }));
    expect(half.resultCount).toBe(2);
    expect(half.hasNotes).toBe(false);
  });
});

describe("votedCount", () => {
  it("counts votes, not applicants", () => {
    const rows = [
      toFirstRoundListRow(source({ id: "a", vote: VoteValue.YES })),
      toFirstRoundListRow(source({ id: "b", vote: VoteValue.NO })),
      toFirstRoundListRow(source({ id: "c", vote: null })),
    ];
    expect(votedCount(rows)).toBe(2);
  });

  it("does not count a skip as voted", () => {
    // Decision 62's number has to mean "decisions I have made", or a reviewer
    // reading 48 of 48 would think they were finished when they had abstained.
    const rows = [toFirstRoundListRow(source({ vote: VoteValue.SKIP }))];
    expect(votedCount(rows)).toBe(0);
  });

  it("is zero for an empty pool", () => {
    expect(votedCount([])).toBe(0);
  });
});
