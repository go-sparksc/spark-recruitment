// Smoke coverage for FR-16's page assembly — the seam CLAUDE.md's testing note
// was written about. The pure functions underneath (`reviewerAverage`,
// `scoreSummary`) have their own suites; what is untested anywhere else is the
// assembly, which is exactly what went wrong twice in Phase 5.
//
// Three things here are behaviour rather than plumbing, and they are the reason
// this file exists: a returned assignment is not a review, an incomplete review
// contributes no average, and an unscored category is null rather than zero.

import { describe, expect, it } from "vitest";

import { ApplicantStatus, AssignmentStatus } from "@/generated/prisma/enums";
import {
  buildInterviewCards,
  buildWrittenReviews,
  conflictCount,
  formatInterviewScore,
  toSecondRoundListRow,
  undecidedCount,
  type InterviewResultSource,
  type WrittenReviewSource,
} from "@/lib/second-round";

const CATEGORIES = ["cat-1", "cat-2", "cat-3", "cat-4"];

function assignment(overrides: Partial<WrittenReviewSource> = {}): WrittenReviewSource {
  return {
    id: "asg-1",
    status: AssignmentStatus.ACTIVE,
    reviewer: { firstName: "Ana", lastName: "Ruiz", isSparklet: false },
    scores: CATEGORIES.map((rubricCategoryId, i) => ({ rubricCategoryId, points: i + 1 })),
    note: { body: "Strong essays." },
    ...overrides,
  };
}

describe("toSecondRoundListRow", () => {
  it("carries the name — §6 gives a second-round reviewer the applicant's identity", () => {
    const row = toSecondRoundListRow({
      id: "app-1",
      displayName: "Cecilia Fang",
      sourceRowIndex: 151,
      conflicts: [],
      interviewResultCount: 2,
      hasInterviewNotes: true,
      status: ApplicantStatus.ACTIVE,
    });

    expect(row).toEqual({
      applicantId: "app-1",
      displayName: "Cecilia Fang",
      sourceRowIndex: 151,
      hasConflict: false,
      interviewResultCount: 2,
      hasInterviewNotes: true,
      outcome: null,
    });
  });

  /// Decisions 111 and 112: the row survives the outcome and names it. Still an
  /// outcome and not a vote — nothing here counts anything.
  it("names the outcome for an applicant the round has finished with", () => {
    const sparklet = toSecondRoundListRow({
      id: "app-1",
      displayName: "Cecilia Fang",
      sourceRowIndex: 151,
      conflicts: [],
      interviewResultCount: 2,
      hasInterviewNotes: true,
      status: ApplicantStatus.SPARKLET,
    });
    expect(sparklet.outcome).toBe("SPARKLET");

    const rejected = toSecondRoundListRow({
      id: "app-2",
      displayName: "Diego Hoffmann",
      sourceRowIndex: 152,
      conflicts: [],
      interviewResultCount: 2,
      hasInterviewNotes: true,
      status: ApplicantStatus.REJECTED,
    });
    expect(rejected.outcome).toBe("REJECTED");
  });

  it("reads one conflict row as flagged", () => {
    const row = toSecondRoundListRow({
      id: "app-1",
      displayName: "Cecilia Fang",
      sourceRowIndex: 151,
      conflicts: [{}],
      interviewResultCount: 0,
      hasInterviewNotes: false,
      status: ApplicantStatus.ACTIVE,
    });

    expect(row.hasConflict).toBe(true);
  });

  it("counts the flagged rows", () => {
    const rows = [true, false, true].map((flagged, index) =>
      toSecondRoundListRow({
        id: `app-${index}`,
        displayName: `Applicant ${index}`,
        sourceRowIndex: index,
        conflicts: flagged ? [{}] : [],
        interviewResultCount: 2,
        hasInterviewNotes: true,
        status: ApplicantStatus.ACTIVE,
      }),
    );

    expect(conflictCount(rows)).toBe(2);
  });

  /// Decision 112: resolved applicants keep their rows, so the row count stopped
  /// answering "how much is left to do" and the header needs both numbers.
  it("counts only the applicants the round has not finished with", () => {
    const rows = [
      ApplicantStatus.ACTIVE,
      ApplicantStatus.SPARKLET,
      ApplicantStatus.REJECTED,
      ApplicantStatus.ACTIVE,
    ].map((status, index) =>
      toSecondRoundListRow({
        id: `app-${index}`,
        displayName: `Applicant ${index}`,
        sourceRowIndex: index,
        conflicts: [],
        interviewResultCount: 2,
        hasInterviewNotes: true,
        status,
      }),
    );

    expect(rows).toHaveLength(4);
    expect(undecidedCount(rows)).toBe(2);
  });
});

describe("buildWrittenReviews", () => {
  it("aligns points to the live rubric and averages a complete review", () => {
    const { cards, summary } = buildWrittenReviews([assignment()], CATEGORIES);

    expect(cards[0].points).toEqual([1, 2, 3, 4]);
    expect(cards[0].average).toBe(2.5);
    expect(cards[0].scoredCount).toBe(4);
    expect(summary.average).toBe(2.5);
  });

  it("gives an incomplete review no average and leaves the gap null", () => {
    // Not zero. "Unscored" is the absence of a Score row, and a zero would both
    // read as a real low mark and drag an average that should not exist at all.
    const { cards, summary } = buildWrittenReviews(
      [assignment({ scores: [{ rubricCategoryId: "cat-1", points: 4 }] })],
      CATEGORIES,
    );

    expect(cards[0].points).toEqual([4, null, null, null]);
    expect(cards[0].average).toBeNull();
    expect(cards[0].scoredCount).toBe(1);
    // Nothing complete, so there is no cohort average — null rather than 4.
    expect(summary.average).toBeNull();
    expect(summary.completedCount).toBe(0);
  });

  it("excludes a returned assignment from the cards and counts it separately", () => {
    // A returned assignment is not a review: the reviewer recognized the
    // applicant and handed them back, and any score they left was given before
    // that. Rendering it as an opinion would also leak a recusal into a room
    // that is about to discuss the applicant.
    const reviews = buildWrittenReviews(
      [
        assignment(),
        assignment({
          id: "asg-2",
          status: AssignmentStatus.RETURNED_TO_POOL,
          reviewer: { firstName: "Sam", lastName: "Oyelaran", isSparklet: true },
        }),
      ],
      CATEGORIES,
    );

    expect(reviews.cards).toHaveLength(1);
    expect(reviews.cards[0].reviewerName).toBe("Ana Ruiz");
    expect(reviews.returnedCount).toBe(1);
    expect(reviews.summary.completedCount).toBe(1);
  });

  it("attributes the note to its author, per decision 77", () => {
    const { cards } = buildWrittenReviews([assignment()], CATEGORIES);

    expect(cards[0].reviewerName).toBe("Ana Ruiz");
    expect(cards[0].note).toBe("Strong essays.");
  });

  it("renders a missing note as null rather than an empty card", () => {
    const { cards } = buildWrittenReviews([assignment({ note: null })], CATEGORIES);

    expect(cards[0].note).toBeNull();
  });

  it("ignores a score whose category has left the rubric", () => {
    const { cards } = buildWrittenReviews(
      [
        assignment({
          scores: [
            { rubricCategoryId: "cat-1", points: 3 },
            { rubricCategoryId: "gone", points: 4 },
          ],
        }),
      ],
      CATEGORIES,
    );

    expect(cards[0].points).toEqual([3, null, null, null]);
    expect(cards[0].scoredCount).toBe(1);
  });
});

describe("buildInterviewCards", () => {
  const INTERVIEW_CATEGORIES = ["ic-1", "ic-2", "ic-3", "ic-4"];

  it("keeps the imported average verbatim even where it disagrees with the mean", () => {
    // FR-12 is explicit: the sheet wins. Interviewers sometimes adjust the
    // average deliberately, and that number is the one they recorded.
    const [card] = buildInterviewCards(
      [
        {
          id: "res-1",
          interviewerName: "Alex Kim",
          score: 3.9,
          scoreIsComputed: false,
          note: null,
          recommendation: null,
          categoryScores: INTERVIEW_CATEGORIES.map((interviewCategoryId) => ({
            interviewCategoryId,
            points: 2,
            note: null,
          })),
        },
      ],
      INTERVIEW_CATEGORIES,
    );

    expect(card.score).toBe(3.9);
    expect(card.points).toEqual([2, 2, 2, 2]);
    expect(card.scoreIsComputed).toBe(false);
  });

  it("does not assume four categories", () => {
    // Clause 14e, which applies here for the same reason it applied to FR-14.
    const [card] = buildInterviewCards(
      [
        {
          id: "res-1",
          interviewerName: "Alex Kim",
          score: 3,
          scoreIsComputed: false,
          note: null,
          recommendation: null,
          categoryScores: [{ interviewCategoryId: "ic-1", points: 3, note: null }],
        },
      ],
      ["ic-1", "ic-2", "ic-3", "ic-4", "ic-5", "ic-6"],
    );

    expect(card.points).toEqual([3, null, null, null, null, null]);
  });

  // -------------------------------------------------------------------------
  // PRD decision 120
  // -------------------------------------------------------------------------

  const result = (over: Partial<InterviewResultSource> = {}): InterviewResultSource => ({
    id: "res-1",
    interviewerName: "Alex Kim",
    score: 3,
    scoreIsComputed: false,
    note: null,
    recommendation: null,
    categoryScores: [],
    ...over,
  });

  it("aligns category notes to the configured categories, index-parallel with points", () => {
    // The two arrays are read as one row by every render site, so a note must
    // land at the same index as the score it was written about.
    const [card] = buildInterviewCards(
      [
        result({
          categoryScores: [
            { interviewCategoryId: "ic-3", points: 4, note: "third" },
            { interviewCategoryId: "ic-1", points: 2, note: "first" },
          ],
        }),
      ],
      INTERVIEW_CATEGORIES,
    );

    expect(card.points).toEqual([2, null, 4, null]);
    expect(card.categoryNotes).toEqual(["first", null, "third", null]);
  });

  it("keeps a scored category with no note distinct from an unscored one", () => {
    const [card] = buildInterviewCards(
      [
        result({
          categoryScores: [{ interviewCategoryId: "ic-1", points: 0, note: null }],
        }),
      ],
      ["ic-1", "ic-2"],
    );

    // 0 is a legal score and must not read as "unscored" — the falsy-check trap
    // decision 59 exists to prevent, arriving at the render layer.
    expect(card.points).toEqual([0, null]);
    expect(card.categoryNotes).toEqual([null, null]);
  });

  it("carries the overall note and the recommendation onto the card", () => {
    const [card] = buildInterviewCards(
      [result({ note: "strong overall", recommendation: "YES" })],
      INTERVIEW_CATEGORIES,
    );

    expect(card.note).toBe("strong overall");
    expect(card.recommendation).toBe("YES");
  });

  it("carries the computed-score flag, so no page has to look it up", () => {
    const [card] = buildInterviewCards(
      [result({ score: 3.5, scoreIsComputed: true })],
      INTERVIEW_CATEGORIES,
    );
    expect(card.scoreIsComputed).toBe(true);
  });
});

describe("formatInterviewScore", () => {
  it("labels a computed score and leaves a recorded one bare", () => {
    // The whole of decision 6's surviving requirement at the render layer: a
    // computed average must never be indistinguishable from a recorded one.
    expect(formatInterviewScore({ score: 3.5, scoreIsComputed: true })).toBe("3.5 (computed)");
    expect(formatInterviewScore({ score: 3.5, scoreIsComputed: false })).toBe("3.5");
  });

  it("renders a whole number without a trailing decimal", () => {
    expect(formatInterviewScore({ score: 4, scoreIsComputed: false })).toBe("4");
  });
});
