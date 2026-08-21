// Smoke coverage for FR-16's page assembly — the seam CLAUDE.md's testing note
// was written about. The pure functions underneath (`reviewerAverage`,
// `scoreSummary`) have their own suites; what is untested anywhere else is the
// assembly, which is exactly what went wrong twice in Phase 5.
//
// Three things here are behaviour rather than plumbing, and they are the reason
// this file exists: a returned assignment is not a review, an incomplete review
// contributes no average, and an unscored category is null rather than zero.

import { describe, expect, it } from "vitest";

import { AssignmentStatus } from "@/generated/prisma/enums";
import {
  buildInterviewCards,
  buildWrittenReviews,
  conflictCount,
  toSecondRoundListRow,
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
    });

    expect(row).toEqual({
      applicantId: "app-1",
      displayName: "Cecilia Fang",
      sourceRowIndex: 151,
      hasConflict: false,
      interviewResultCount: 2,
      hasInterviewNotes: true,
    });
  });

  it("reads one conflict row as flagged", () => {
    const row = toSecondRoundListRow({
      id: "app-1",
      displayName: "Cecilia Fang",
      sourceRowIndex: 151,
      conflicts: [{}],
      interviewResultCount: 0,
      hasInterviewNotes: false,
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
      }),
    );

    expect(conflictCount(rows)).toBe(2);
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
          categoryScores: INTERVIEW_CATEGORIES.map((interviewCategoryId) => ({
            interviewCategoryId,
            points: 2,
          })),
        },
      ],
      INTERVIEW_CATEGORIES,
    );

    expect(card.score).toBe(3.9);
    expect(card.points).toEqual([2, 2, 2, 2]);
  });

  it("does not assume four categories", () => {
    // Clause 14e, which applies here for the same reason it applied to FR-14.
    const [card] = buildInterviewCards(
      [
        {
          id: "res-1",
          interviewerName: "Alex Kim",
          score: 3,
          categoryScores: [{ interviewCategoryId: "ic-1", points: 3 }],
        },
      ],
      ["ic-1", "ic-2", "ic-3", "ic-4", "ic-5", "ic-6"],
    );

    expect(card.points).toEqual([3, null, null, null, null, null]);
  });
});
