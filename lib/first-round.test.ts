// Smoke coverage for FR-14's pool predicate and row shaping. Not one of the
// four modules CLAUDE.md reserves full suites for — the interesting risks on
// that surface are §6 leakage and phone ergonomics, and neither is visible from
// here. What IS worth pinning is the predicate, because it has to agree with
// FR-15's finalize, and the SKIP narrowing, because the impossible case is
// exactly the one nobody would notice going wrong.

import { describe, expect, it } from "vitest";

import { ApplicantStatus, FieldGroupRole, Round, VoteValue } from "@/generated/prisma/enums";
import type { DemographicColumn } from "@/lib/demographics";
import {
  FIRST_ROUND_POOL,
  buildFirstRoundResultRows,
  type FirstRoundResultSource,
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

// ---------------------------------------------------------------------------
// FR-15's page assembly — the seam that had no coverage
// ---------------------------------------------------------------------------
//
// This is where the results page turns applicants and votes into ranked rows.
// It is worth testing because it is exactly where a wrong call to
// `tallySelections` would have landed as a runtime crash: the arithmetic beneath
// it is well covered and the page assembling it was not.

const ETHNICITY: DemographicColumn = {
  key: "ethnicity",
  label: "Ethnicity",
  // GroupMember is { id, displayName, groupRole } — read from the real type
  // rather than invented, which is what the first draft of this fixture got
  // wrong. OPTION members are the one-hot columns §10.7 counts.
  members: [
    { id: "f-asian", displayName: "East Asian", groupRole: FieldGroupRole.OPTION },
    { id: "f-black", displayName: "Black", groupRole: FieldGroupRole.OPTION },
  ],
};

function applicant(
  overrides: Partial<FirstRoundResultSource> = {},
): FirstRoundResultSource {
  return {
    id: "app-1",
    displayName: "Cecilia Fang",
    sourceRowIndex: 151,
    data: {},
    status: ApplicantStatus.ACTIVE,
    stageReached: Round.FIRST_ROUND,
    votes: [],
    ...overrides,
  };
}

describe("buildFirstRoundResultRows", () => {
  it("counts yes and no, and ranks by the percentage", () => {
    const rows = buildFirstRoundResultRows(
      [
        applicant({ id: "a", sourceRowIndex: 1, votes: [VoteValue.YES, VoteValue.NO] }),
        applicant({ id: "b", sourceRowIndex: 2, votes: [VoteValue.YES, VoteValue.YES] }),
      ],
      [],
    );

    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows[0]).toMatchObject({ rank: 1, yesCount: 2, noCount: 0, nonSkipCount: 2, yesPercent: 1 });
    expect(rows[1]).toMatchObject({ rank: 2, yesCount: 1, noCount: 1, nonSkipCount: 2, yesPercent: 0.5 });
  });

  it("counts a SKIP toward neither side", () => {
    // Unreachable in this round — no SKIP row is written — but the second round
    // writes them, and a skip belongs in no part of yes/(yes+no).
    const [row] = buildFirstRoundResultRows(
      [applicant({ votes: [VoteValue.YES, VoteValue.SKIP, VoteValue.SKIP] })],
      [],
    );

    expect(row).toMatchObject({ yesCount: 1, noCount: 0, nonSkipCount: 1, yesPercent: 1 });
  });

  it("gives an applicant nobody voted on a null percentage and ranks them last", () => {
    const rows = buildFirstRoundResultRows(
      [
        applicant({ id: "unvoted", sourceRowIndex: 1, votes: [] }),
        applicant({ id: "rejected", sourceRowIndex: 2, votes: [VoteValue.NO, VoteValue.NO] }),
      ],
      [],
    );

    // Below a unanimous NO, not mixed in with it.
    expect(rows.map((r) => r.id)).toEqual(["rejected", "unvoted"]);
    expect(rows[1].yesPercent).toBeNull();
    expect(rows[1].nonSkipCount).toBe(0);
  });

  it("numbers ranks over the whole cohort, including applicants already decided", () => {
    // The page loads everyone with stageReached != WRITTEN so the results survive
    // finalize. Someone already advanced still occupies a rank.
    const rows = buildFirstRoundResultRows(
      [
        applicant({ id: "advanced", sourceRowIndex: 1, stageReached: Round.SECOND_ROUND, votes: [VoteValue.YES] }),
        applicant({ id: "live", sourceRowIndex: 2, votes: [VoteValue.NO] }),
      ],
      [],
    );

    expect(rows.map((r) => [r.id, r.rank])).toEqual([
      ["advanced", 1],
      ["live", 2],
    ]);
  });

  it("marks who the finalize would decide on", () => {
    const rows = buildFirstRoundResultRows(
      [
        applicant({ id: "live" }),
        applicant({ id: "advanced", stageReached: Round.SECOND_ROUND }),
        applicant({ id: "rejected", status: ApplicantStatus.REJECTED }),
      ],
      [],
    );

    const byId = new Map(rows.map((r) => [r.id, r.inPool]));
    expect(byId.get("live")).toBe(true);
    expect(byId.get("advanced")).toBe(false);
    expect(byId.get("rejected")).toBe(false);
  });

  it("shapes selections per column for the live breakdown", () => {
    // The call that was wrong the first time. `selections` is keyed by column
    // and holds the labels that applicant selected — the shape tallySelections
    // consumes one column at a time.
    const [row] = buildFirstRoundResultRows(
      [applicant({ data: { "f-asian": "East Asian", "f-black": "" } })],
      [ETHNICITY],
    );

    expect(row.selections).toEqual({ ethnicity: ["East Asian"] });
  });

  it("gives an applicant who selected nothing an empty label list, not a missing key", () => {
    // A missing key would make the breakdown skip them rather than counting them
    // as "Not specified", which is how a demographic column quietly loses people.
    const [row] = buildFirstRoundResultRows([applicant({ data: {} })], [ETHNICITY]);

    expect(row.selections).toHaveProperty("ethnicity");
    expect(row.selections.ethnicity).toEqual([]);
  });

  it("returns nothing for an empty cohort", () => {
    expect(buildFirstRoundResultRows([], [ETHNICITY])).toEqual([]);
  });
});
