// FR-19's grouping. These cases are the spec for clauses 19a and 19c–19e.
//
// The one that earns its keep is decision 89's second clause. An admin who
// resolves an unresolved applicant makes them SPARKLET or REJECTED **and**
// leaves NEEDS_ADMIN on their pass row, so they satisfy two group predicates at
// once — and the screen would list one person twice while looking entirely
// reasonable. That is the contradiction FR-19 never closed, and it is invisible
// until someone uses the control on the same page.

import { describe, expect, it } from "vitest";

import { ApplicantStatus, PassResolution, Round } from "@/generated/prisma/enums";
import {
  groupFinalApplicants,
  isUnresolved,
  stillDeciding,
  unresolvedReason,
  type FinalApplicantSource,
} from "@/lib/final";
import type { PassTally } from "@/lib/passes";

function tally(overrides: Partial<PassTally> = {}): PassTally {
  return { yes: 0, no: 0, skip: 0, outstanding: 0, eligible: 11, ...overrides };
}

function source(overrides: Partial<FinalApplicantSource> = {}): FinalApplicantSource {
  return {
    id: "app-1",
    sourceRowIndex: 1,
    displayName: "Cecilia Fang",
    email: "fang@usc.edu",
    status: ApplicantStatus.ACTIVE,
    stageReached: Round.SECOND_ROUND,
    finalPassResolution: PassResolution.NEEDS_ADMIN,
    inFinalPass: true,
    hasSecondRoundDecision: false,
    tally: tally({ yes: 7, no: 4 }),
    ...overrides,
  };
}

describe("isUnresolved — decision 89's predicate", () => {
  it("is true for a NEEDS_ADMIN row with no second-round decision", () => {
    expect(isUnresolved(source())).toBe(true);
  });

  it("is false once an admin has decided them, without the pass row changing", () => {
    // The whole of decision 89. `finalPassResolution` is still NEEDS_ADMIN —
    // the record that the pass could not decide them is deliberately intact.
    const resolved = source({
      status: ApplicantStatus.SPARKLET,
      hasSecondRoundDecision: true,
      finalPassResolution: PassResolution.NEEDS_ADMIN,
    });
    expect(isUnresolved(resolved)).toBe(false);
  });

  it("is false for any other resolution", () => {
    for (const resolution of [
      PassResolution.SPARKLET,
      PassResolution.REJECTED,
      PassResolution.CARRIED,
      null,
    ]) {
      expect(isUnresolved(source({ finalPassResolution: resolution })), String(resolution)).toBe(
        false,
      );
    }
  });

  it("is false for an applicant who was never in the final pass", () => {
    expect(isUnresolved(source({ inFinalPass: false, finalPassResolution: null }))).toBe(false);
  });
});

describe("groupFinalApplicants", () => {
  it("sorts a finished round into the three groups", () => {
    const groups = groupFinalApplicants([
      source({
        id: "s",
        sourceRowIndex: 3,
        status: ApplicantStatus.SPARKLET,
        finalPassResolution: PassResolution.SPARKLET,
        hasSecondRoundDecision: true,
      }),
      source({
        id: "r",
        sourceRowIndex: 2,
        status: ApplicantStatus.REJECTED,
        finalPassResolution: PassResolution.REJECTED,
        hasSecondRoundDecision: true,
      }),
      source({ id: "u", sourceRowIndex: 1 }),
    ]);

    expect(groups.sparklets.map((row) => row.applicantId)).toEqual(["s"]);
    expect(groups.rejected.map((row) => row.applicantId)).toEqual(["r"]);
    expect(groups.unresolved.map((row) => row.applicantId)).toEqual(["u"]);
  });

  it("never lists one applicant in two groups after an admin resolves them", () => {
    // Both predicates are true of this person: status SPARKLET, pass row
    // NEEDS_ADMIN. Exactly one group may claim them.
    const groups = groupFinalApplicants([
      source({
        status: ApplicantStatus.SPARKLET,
        hasSecondRoundDecision: true,
        finalPassResolution: PassResolution.NEEDS_ADMIN,
      }),
    ]);

    expect(groups.sparklets).toHaveLength(1);
    expect(groups.unresolved).toHaveLength(0);
  });

  it("finds Unresolved by the pass row and never by status", () => {
    // 19e. The applicant is ACTIVE, which is what FR-17 requires and what a
    // status-based predicate would read as "still going".
    const groups = groupFinalApplicants([source({ status: ApplicantStatus.ACTIVE })]);
    expect(groups.unresolved).toHaveLength(1);
  });

  it("excludes applicants who never reached the second round", () => {
    // 110 written-round rejections do not belong under "Rejected" on a screen
    // about the second round.
    const groups = groupFinalApplicants([
      source({ stageReached: Round.WRITTEN, status: ApplicantStatus.REJECTED }),
      source({ stageReached: Round.FIRST_ROUND, status: ApplicantStatus.REJECTED }),
    ]);
    expect(groups.rejected).toHaveLength(0);
  });

  it("orders every group by sourceRowIndex", () => {
    const groups = groupFinalApplicants([
      source({ id: "b", sourceRowIndex: 9 }),
      source({ id: "a", sourceRowIndex: 2 }),
      source({ id: "c", sourceRowIndex: 40 }),
    ]);
    expect(groups.unresolved.map((row) => row.sourceRowIndex)).toEqual([2, 9, 40]);
  });

  it("carries a tally for Unresolved and withholds it elsewhere", () => {
    // FR-19 requires the votes stay visible for Unresolved specifically. A
    // Sparklet's tally would be an invitation to relitigate a settled decision.
    const groups = groupFinalApplicants([
      source({ id: "u" }),
      source({
        id: "s",
        status: ApplicantStatus.SPARKLET,
        finalPassResolution: PassResolution.SPARKLET,
        hasSecondRoundDecision: true,
      }),
    ]);
    expect(groups.unresolved[0].tally).not.toBeNull();
    expect(groups.sparklets[0].tally).toBeNull();
  });

  it("puts an applicant still carrying forward in no group", () => {
    const groups = groupFinalApplicants([
      source({ status: ApplicantStatus.ACTIVE, finalPassResolution: PassResolution.CARRIED }),
    ]);
    expect(groups.sparklets).toHaveLength(0);
    expect(groups.rejected).toHaveLength(0);
    expect(groups.unresolved).toHaveLength(0);
  });
});

describe("stillDeciding", () => {
  it("counts the second-round applicants no group claims", () => {
    expect(
      stillDeciding([
        source({ status: ApplicantStatus.ACTIVE, finalPassResolution: PassResolution.CARRIED }),
        source({ status: ApplicantStatus.ACTIVE, finalPassResolution: null }),
        source(), // unresolved — claimed, so not counted
        source({ status: ApplicantStatus.SPARKLET, hasSecondRoundDecision: true }),
      ]),
    ).toBe(2);
  });

  it("is zero on a closed round", () => {
    expect(stillDeciding([source(), source({ status: ApplicantStatus.SPARKLET })])).toBe(0);
  });
});

describe("unresolvedReason — FR-19's 'eleven skips reads very differently from 7-4'", () => {
  it("names the all-recused case", () => {
    expect(unresolvedReason(tally({ skip: 11, eligible: 0 }))).toBe("ALL_RECUSED");
  });

  it("names a pass nobody voted in", () => {
    expect(unresolvedReason(tally({ outstanding: 11 }))).toBe("NO_VOTES");
  });

  it("names an incomplete vote", () => {
    expect(unresolvedReason(tally({ yes: 5, no: 1, outstanding: 5 }))).toBe("INCOMPLETE");
  });

  it("names a mixed result that had nowhere to carry", () => {
    expect(unresolvedReason(tally({ yes: 7, no: 4, outstanding: 0 }))).toBe("MIXED");
  });

  it("is null without a tally", () => {
    expect(unresolvedReason(null)).toBeNull();
  });
});
