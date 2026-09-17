// Smoke coverage for FR-16's page assembly — the seam CLAUDE.md's testing note
// was written about. What is untested anywhere else is the assembly, which is
// exactly what went wrong twice in Phase 5.
//
// Three things here are behaviour rather than plumbing, and they are the reason
// this file exists: an unscored interview category is null rather than zero, a
// category note lands at the same index as the score it was written about, and a
// computed average never renders as though it were the sheet's own number.
//
// The `buildWrittenReviews` suite lived here until decision 121 took the written
// round's scores and review notes off this profile. Its six cases went with the
// function — among them that a returned assignment is not a review and that an
// incomplete review contributes no average — and are in git alongside it.

import { describe, expect, it } from "vitest";

import { ApplicantStatus } from "@/generated/prisma/enums";
import {
  buildInterviewCards,
  conflictCount,
  formatInterviewScore,
  toSecondRoundListRow,
  undecidedCount,
  type InterviewResultSource,
} from "@/lib/second-round";

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
