import { describe, expect, it } from "vitest";

import { FieldCategory, FieldGroupRole } from "@/generated/prisma/enums";
import {
  buildApplicantView,
  claimEligibility,
  completionOf,
  openSlotsOf,
  targetFor,
  type ApplicantSource,
  type ReviewFieldGroupLike,
  type ReviewFieldLike,
} from "@/lib/review";

function field(overrides: Partial<ReviewFieldLike> = {}): ReviewFieldLike {
  return {
    id: "f1",
    displayName: "A question",
    ordinal: 0,
    category: FieldCategory.RESPONSE,
    isIncluded: true,
    groupId: null,
    groupRole: null,
    visibleToWrittenReviewer: null,
    visibleToFirstRoundReviewer: null,
    ...overrides,
  };
}

function group(overrides: Partial<ReviewFieldGroupLike> = {}): ReviewFieldGroupLike {
  return {
    id: "g1",
    displayName: "Ethnicity",
    category: FieldCategory.DEMOGRAPHIC,
    isIncluded: true,
    visibleToWrittenReviewer: null,
    visibleToFirstRoundReviewer: null,
    ...overrides,
  };
}

function applicant(overrides: Partial<ApplicantSource> = {}): ApplicantSource {
  return {
    sourceRowIndex: 47,
    displayName: "Quinn Spacey",
    email: "quinn.spacey@usc.edu",
    data: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FR-9 bullet 1 — completion state
// ---------------------------------------------------------------------------

describe("completionOf — the assigned list's completion state", () => {
  const four = ["c1", "c2", "c3", "c4"];

  // BUILD_PLAN's Phase 3 case: a reviewer with 4 applicants, 2 fully scored, 1
  // partially, 1 untouched. Each row's state, and the aggregate the header
  // shows, both come from this function.
  it("reads 4/4 complete for a fully scored applicant", () => {
    expect(completionOf(four, ["c1", "c2", "c3", "c4"])).toEqual({
      scored: 4,
      total: 4,
      complete: true,
    });
  });

  it("reads 3/4 incomplete for a partially scored applicant", () => {
    expect(completionOf(four, ["c1", "c2", "c3"])).toEqual({
      scored: 3,
      total: 4,
      complete: false,
    });
  });

  it("reads 0/4 for an untouched applicant", () => {
    expect(completionOf(four, [])).toEqual({ scored: 0, total: 4, complete: false });
  });

  it("counts 2 of 4 complete across the four applicants of the BUILD_PLAN case", () => {
    const rows = [
      completionOf(four, four),
      completionOf(four, four),
      completionOf(four, ["c1", "c2", "c3"]),
      completionOf(four, []),
    ];

    expect(rows.filter((row) => row.complete)).toHaveLength(2);
    expect(rows.map((row) => `${row.scored}/${row.total}`)).toEqual(["4/4", "4/4", "3/4", "0/4"]);
  });
});

describe("completionOf — the FR-4 reset path moves the denominator", () => {
  const four = ["c1", "c2", "c3", "c4"];
  const five = ["c1", "c2", "c3", "c4", "c5"];

  it("reads the live rubric's size, not the one the scores were made against", () => {
    // The admin changed a 4-category rubric to 5 mid-round. The denominator is
    // 5 immediately, without anything rewriting the existing Score rows.
    expect(completionOf(five, four).total).toBe(5);
  });

  it("stops calling a previously-complete applicant complete", () => {
    expect(completionOf(four, four).complete).toBe(true);
    expect(completionOf(five, four)).toEqual({ scored: 4, total: 5, complete: false });
  });

  it("moves every applicant's denominator, not only the complete one", () => {
    // The same three score sets from the BUILD_PLAN case, re-read against the
    // widened rubric. The partially-scored applicant is the one that would
    // expose a denominator cached at assignment time rather than read live.
    expect(
      [four, ["c1", "c2", "c3"], []].map((scored) => {
        const row = completionOf(five, scored);
        return `${row.scored}/${row.total}`;
      }),
    ).toEqual(["4/5", "3/5", "0/5"]);
  });

  it("reads 0/5 after the reset that FR-4 actually requires", () => {
    // FR-4 locks the rubric once any Score exists, and the only way past the
    // lock is resetWrittenScores, which deletes every score. So the state
    // actually observed after a reset-and-relock is 0/5. The 4/5 case above is
    // reachable too — adding a category before any score exists is not blocked
    // — which is why both are pinned rather than only the one the brief names.
    expect(completionOf(five, [])).toEqual({ scored: 0, total: 5, complete: false });
  });

  it("ignores a score whose category is no longer in the rubric", () => {
    // Structurally impossible today: Score cascades from RubricCategory, so a
    // deleted category takes its scores with it. Asserted so that stays true —
    // if it ever stops being, the visible symptom would be 5/4.
    expect(completionOf(four, ["c1", "c2", "c3", "c4", "gone"])).toEqual({
      scored: 4,
      total: 4,
      complete: true,
    });
  });

  it("never reports a rubric with no categories as complete", () => {
    // Unreachable through FR-4's builder, which requires at least one category.
    // "Complete" is the word a reviewer trusts to mean they can stop.
    expect(completionOf([], [])).toEqual({ scored: 0, total: 0, complete: false });
  });
});

// ---------------------------------------------------------------------------
// FR-9 bullet 6 — the pool
// ---------------------------------------------------------------------------

describe("openSlotsOf", () => {
  it("reports one open slot on a pooled applicant who started with 2 of 3", () => {
    expect(openSlotsOf(3, 2)).toBe(1);
  });

  it("reports two open slots after one of those two returns to the pool", () => {
    // The third case in the brief's return block: an applicant with 2 of 3 loses
    // one, and must then show 1 active reviewer and 2 open slots — consistent
    // with FR-8's "slots return to the pool".
    expect(openSlotsOf(3, 1)).toBe(2);
  });

  it("reports none on a fully staffed applicant", () => {
    expect(openSlotsOf(3, 3)).toBe(0);
  });

  it("clamps rather than going negative when an admin over-assigns", () => {
    // FR-8 lets an admin add a fourth reviewer. -1 would render as an open slot
    // on the one applicant who is not short of anything.
    expect(openSlotsOf(3, 4)).toBe(0);
  });

  it("follows the reduced target on a roster smaller than three", () => {
    // planShape's target is min(3, reviewerCount). A hardcoded 3 here would
    // advertise open slots that no reviewer exists to fill.
    expect(targetFor(150, 30)).toBe(3);
    expect(targetFor(2, 2)).toBe(2);
    expect(targetFor(10, 1)).toBe(1);
    expect(openSlotsOf(targetFor(2, 2), 1)).toBe(1);
  });
});

describe("claimEligibility", () => {
  const nonSparklet = { id: "r1", isSparklet: false };
  const sparklet = { id: "r2", isSparklet: true };
  const open = { openSlots: 1, assignedReviewerIds: ["r9"], hasSparklet: false };

  it("lets a reviewer claim an open slot", () => {
    expect(claimEligibility(nonSparklet, open)).toEqual({ eligible: true });
  });

  it("refuses a second Sparklet on one applicant", () => {
    // Not in FR-9, and deliberately enforced anyway: "at most one Sparklet
    // reviews any given applicant" is an invariant of the system, not a
    // property of generation. A claim is the one path that could break it.
    expect(claimEligibility(sparklet, { ...open, hasSparklet: true })).toEqual({
      eligible: false,
      reason: "SECOND_SPARKLET",
    });
  });

  it("lets a non-Sparklet claim the same applicant", () => {
    expect(claimEligibility(nonSparklet, { ...open, hasSparklet: true })).toEqual({
      eligible: true,
    });
  });

  it("lets a Sparklet claim an applicant who has none", () => {
    expect(claimEligibility(sparklet, open)).toEqual({ eligible: true });
  });

  it("refuses a reviewer already on the applicant", () => {
    expect(claimEligibility(nonSparklet, { ...open, assignedReviewerIds: ["r9", "r1"] })).toEqual({
      eligible: false,
      reason: "ALREADY_ASSIGNED",
    });
  });

  it("refuses when the last slot has gone", () => {
    // The losing half of the two-reviewers-one-slot race. This reason is what
    // produces "someone else claimed that slot", so it must not be masked by a
    // less specific one.
    expect(claimEligibility(nonSparklet, { ...open, openSlots: 0 })).toEqual({
      eligible: false,
      reason: "NO_OPEN_SLOTS",
    });
  });

  it("reports already-assigned ahead of the transient reasons", () => {
    // A fact about this reviewer that nobody else can change outranks one that
    // changes under their feet.
    expect(
      claimEligibility(sparklet, {
        openSlots: 0,
        assignedReviewerIds: ["r2"],
        hasSparklet: true,
      }),
    ).toEqual({ eligible: false, reason: "ALREADY_ASSIGNED" });
  });

  it("reports the vanished slot ahead of the Sparklet rule", () => {
    expect(
      claimEligibility(sparklet, { openSlots: 0, assignedReviewerIds: [], hasSparklet: true }),
    ).toEqual({ eligible: false, reason: "NO_OPEN_SLOTS" });
  });

  it("does not treat a returned assignment as still assigned", () => {
    // Decision 28: a reviewer may reclaim an applicant they returned. The caller
    // passes only ACTIVE assignments, so the returned pair is simply absent.
    expect(claimEligibility(nonSparklet, { ...open, assignedReviewerIds: [] })).toEqual({
      eligible: true,
    });
  });
});

// ---------------------------------------------------------------------------
// FR-9 bullet 2 and §6 — the projection
// ---------------------------------------------------------------------------

describe("buildApplicantView — what a written reviewer gets", () => {
  it("labels the applicant by source row index and carries no identity", () => {
    const view = buildApplicantView(applicant(), [], [], "WRITTEN_REVIEWER");

    expect(view.label).toBe("Applicant 47");
    expect(view.identified).toBe(false);
  });

  it("does not put the name or the email anywhere in the serialized object", () => {
    // Serializing the whole thing rather than checking two keys: this is the
    // same reduction the RSC payload performs, so it catches a name smuggled in
    // on a nested field that a shape assertion would miss. §6 requires the value
    // to be absent from the response, not hidden by the client.
    const view = buildApplicantView(
      applicant({ data: { f1: "an essay" } }),
      [field({ id: "f1" })],
      [],
      "WRITTEN_REVIEWER",
    );

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("Quinn");
    expect(serialized).not.toContain("Spacey");
    expect(serialized).not.toContain("quinn.spacey@usc.edu");
    expect(serialized).toContain("an essay");
  });

  it("gives every RESPONSE field", () => {
    const view = buildApplicantView(
      applicant({ data: { f1: "first answer", f2: "second answer" } }),
      [
        field({ id: "f1", displayName: "Why Spark SC?", ordinal: 0 }),
        field({ id: "f2", displayName: "Tell us about a time", ordinal: 1 }),
      ],
      [],
      "WRITTEN_REVIEWER",
    );

    expect(view.fields.map((f) => f.displayName)).toEqual([
      "Why Spark SC?",
      "Tell us about a time",
    ]);
  });

  it("orders fields by ordinal rather than by input order", () => {
    const view = buildApplicantView(
      applicant({ data: { a: "second", b: "first" } }),
      [
        field({ id: "a", displayName: "Second", ordinal: 5 }),
        field({ id: "b", displayName: "First", ordinal: 1 }),
      ],
      [],
      "WRITTEN_REVIEWER",
    );

    expect(view.fields.map((f) => f.displayName)).toEqual(["First", "Second"]);
  });

  it("omits a field with no answer rather than rendering it blank", () => {
    const view = buildApplicantView(
      applicant({ data: { f1: "answered", f2: "", f3: "   " } }),
      [
        field({ id: "f1", ordinal: 0 }),
        field({ id: "f2", ordinal: 1 }),
        field({ id: "f3", ordinal: 2 }),
      ],
      [],
      "WRITTEN_REVIEWER",
    );

    expect(view.fields.map((f) => f.fieldId)).toEqual(["f1"]);
  });
});

describe("buildApplicantView — the §6 boundary, per field", () => {
  it("shows an OTHER field toggled visible for written and hides it from first round", () => {
    // The first case in the brief's visibility block: enforcement is per field,
    // not per category.
    const other = field({
      id: "other",
      displayName: "Graduation year",
      category: FieldCategory.OTHER,
      visibleToWrittenReviewer: true,
      visibleToFirstRoundReviewer: false,
    });
    const source = applicant({ data: { other: "2028" } });

    expect(
      buildApplicantView(source, [other], [], "WRITTEN_REVIEWER").fields.map((f) => f.fieldId),
    ).toEqual(["other"]);
    expect(
      buildApplicantView(source, [other], [], "FIRST_ROUND_REVIEWER").fields,
    ).toEqual([]);
  });

  it("excludes an isIncluded: false field whatever its visibility toggle says", () => {
    // isIncluded wins, consistent with §5's excluded-fields-are-retained-but-
    // excluded-from-review-surfaces.
    const excluded = field({
      id: "junk",
      category: FieldCategory.OTHER,
      isIncluded: false,
      visibleToWrittenReviewer: true,
    });

    expect(
      buildApplicantView(applicant({ data: { junk: "NET-1000" } }), [excluded], [], "WRITTEN_REVIEWER")
        .fields,
    ).toEqual([]);
  });

  it("shows a RESPONSE field with no explicit override", () => {
    // §6's flat default. Decision 18 means no toggle is offered for it in any
    // admin UI, which the FR-2 mapping table already honours.
    const response = field({ id: "essay", category: FieldCategory.RESPONSE });

    expect(
      buildApplicantView(applicant({ data: { essay: "words" } }), [response], [], "WRITTEN_REVIEWER")
        .fields.map((f) => f.fieldId),
    ).toEqual(["essay"]);
  });

  it("hides a DEMOGRAPHIC field even when it carries a written-visible override", () => {
    // Decision 18: the override columns exist on every row but are read only
    // where the resolved category is OTHER. This is the surface that rule
    // protects, so it is asserted here as well as in lib/fields.test.ts.
    const demographic = field({
      id: "eth",
      category: FieldCategory.DEMOGRAPHIC,
      visibleToWrittenReviewer: true,
    });

    expect(
      buildApplicantView(applicant({ data: { eth: "White" } }), [demographic], [], "WRITTEN_REVIEWER")
        .fields,
    ).toEqual([]);
  });

  it("takes a grouped member's visibility from its group, not from itself", () => {
    const member = field({
      id: "eth1",
      displayName: "White",
      // Deliberately wrong on the member; the group is DEMOGRAPHIC and wins.
      category: FieldCategory.RESPONSE,
      groupId: "g1",
      groupRole: FieldGroupRole.OPTION,
    });

    expect(
      buildApplicantView(applicant({ data: { eth1: "White" } }), [member], [group()], "WRITTEN_REVIEWER")
        .fields,
    ).toEqual([]);
  });

  it("attaches the group heading when a visible column belongs to a group", () => {
    const member = field({
      id: "m1",
      displayName: "Peer referral",
      category: FieldCategory.OTHER,
      groupId: "g2",
      groupRole: FieldGroupRole.OPTION,
    });
    const visibleGroup = group({
      id: "g2",
      displayName: "How did you hear about us?",
      category: FieldCategory.OTHER,
      visibleToWrittenReviewer: true,
    });

    const view = buildApplicantView(
      applicant({ data: { m1: "Peer referral" } }),
      [member],
      [visibleGroup],
      "WRITTEN_REVIEWER",
    );

    expect(view.fields).toEqual([
      {
        fieldId: "m1",
        displayName: "Peer referral",
        groupDisplayName: "How did you hear about us?",
        value: "Peer referral",
      },
    ]);
  });
});

describe("buildApplicantView — the other viewers", () => {
  const fields = [
    field({ id: "essay", displayName: "Essay", category: FieldCategory.RESPONSE, ordinal: 0 }),
    field({ id: "eth", displayName: "Ethnicity", category: FieldCategory.DEMOGRAPHIC, ordinal: 1 }),
  ];
  const data = { essay: "words", eth: "White" };

  it("gives a second-round reviewer the name, the email and both categories", () => {
    const view = buildApplicantView(applicant({ data }), fields, [], "SECOND_ROUND_REVIEWER");

    expect(view.identified).toBe(true);
    if (!view.identified) throw new Error("unreachable");
    expect(view.displayName).toBe("Quinn Spacey");
    expect(view.email).toBe("quinn.spacey@usc.edu");
    expect(view.fields.map((f) => f.fieldId)).toEqual(["essay", "eth"]);
  });

  it("gives an admin the same, and still supplies the label", () => {
    // FR-8's applicant list searches by both the label a reviewer sees and the
    // name an admin knows, so the label is not written-only.
    const view = buildApplicantView(applicant({ data }), fields, [], "ADMIN");

    expect(view.label).toBe("Applicant 47");
    expect(view.identified).toBe(true);
  });

  it("gives a first-round reviewer the identity but neither category", () => {
    // §6 hides demographics AND written responses from this round.
    const view = buildApplicantView(applicant({ data }), fields, [], "FIRST_ROUND_REVIEWER");

    expect(view.identified).toBe(true);
    expect(view.fields).toEqual([]);
  });

  it("carries a null email through rather than inventing one", () => {
    // FR-3 lets a blank-email row through once the admin resolves it.
    const view = buildApplicantView(applicant({ email: null }), [], [], "ADMIN");

    expect(view.identified).toBe(true);
    if (!view.identified) throw new Error("unreachable");
    expect(view.email).toBeNull();
  });
});
