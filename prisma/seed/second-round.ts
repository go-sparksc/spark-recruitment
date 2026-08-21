// The first round's data, and the finalize that opens the second one.
//
// Phase 6 needs an instance sitting in `SECOND_ROUND` with a real cohort in it:
// FR-16 renders a full profile, and a profile with no interview scores, no
// interview notes and no written scores is a page that cannot be judged. The
// reviews module says its own reasoning about this — passes and votes were
// "deliberately absent" until the requirement that specifies them shipped — and
// FR-17 has now specified them, so the part of that reservation covering the
// FIRST round has expired. Pass rows are still not here: those are what an admin
// creates on the FR-17 screen, and seeding them would develop FR-18 against a
// state the application never produced.
//
// **This does not run as part of `npm run seed`.** BUILD_PLAN's Phase 5 gate and
// prisma/checks/reconciliation-fixture.ts are both written against an instance
// at FIRST_ROUND with nothing imported, and a default seed that advanced past it
// would quietly stop testing that phase. `npm run seed:advance` is the opt-in.
//
// Pure — no database access and no Prisma client. prisma/advance.ts writes what
// this returns.

import { VoteValue } from "../../generated/prisma/enums";
import { firstRoundSummary, rankFirstRound } from "../../lib/results";
import type { Rng } from "../../lib/rng";

/// Its own seed, for the reason `SCORES_RNG_SEED` documents in ./reviews.ts: a
/// generator shared with applicant or reviewer generation would make this file
/// able to rename a reviewer, and every Phase 3 screenshot names them.
export const SECOND_ROUND_RNG_SEED = 20260821;

/// FR-12a's rubric, as an admin would configure it. Four categories in S26; the
/// count is not assumed anywhere in the application and is not assumed here.
export const INTERVIEW_CATEGORIES = [
  { name: "Communication", maxPoints: 4 },
  { name: "Initiative", maxPoints: 4 },
  { name: "Collaboration", maxPoints: 4 },
  { name: "Interest in Spark", maxPoints: 4 },
] as const;

/// Free text on the real sheet, typed by whoever ran the interview — which is
/// the whole reason FR-13 exists. Deliberately NOT drawn from the reviewer
/// roster: an interviewer is not a `Reviewer` row, and seeding them as though
/// they were would model away the problem the reconciliation cascade solves.
export const INTERVIEWERS = [
  "Alex Kim",
  "Jordan Ruiz",
  "Sam Osei",
  "Taylor Brooks",
  "Riley Nakamura",
  "Devon Achebe",
] as const;

/// How many of the first round advance. Roughly half, which is the shape of a
/// real cycle and leaves a second-round pool small enough to deliberate over.
export const SECOND_ROUND_ADVANCE_COUNT = 22;

/// Applicants with no interview notes at all, as a fraction. Clause 12q — "the
/// dashboard renders whichever half exists" — is only exercised if some half is
/// actually missing, and a fixture where every applicant has everything is a
/// fixture that never reaches the branch.
const NOTES_MISSING_RATE = 0.15;

export interface FirstRoundApplicant {
  applicantId: string;
  sourceRowIndex: number;
}

// ---------------------------------------------------------------------------
// FR-12's imported data
// ---------------------------------------------------------------------------

export interface InterviewResultRow {
  id: string;
  applicantId: string;
  interviewerName: string;
  /// `InterviewResult.score`. On the real sheet this is a number the interviewer
  /// typed, which FR-12 imports verbatim and never recomputes; here it is the
  /// mean of the category points, rounded the way a person would round it.
  score: number;
  /// One per category, in `INTERVIEW_CATEGORIES` order.
  categoryPoints: number[];
}

/// Two interview results per applicant, one per interviewer, as FR-12 expects.
///
/// The two interviewers for an applicant are always distinct — the sheet's upsert
/// key is `(applicantId, interviewerName)`, so a repeated name would collapse two
/// rows into one and quietly halve the fixture.
export function buildInterviewResults(
  applicants: readonly FirstRoundApplicant[],
  resultId: (index: number) => string,
  rng: Rng,
): InterviewResultRow[] {
  const rows: InterviewResultRow[] = [];

  for (const applicant of applicants) {
    // A per-applicant centre, so an applicant is broadly consistent across both
    // interviewers rather than two independent draws. Real interview scores
    // correlate; a fixture where they do not makes the FR-15 ranking noise.
    const centre = rng.int(2, 4);
    const [first, second] = rng.shuffle(INTERVIEWERS).slice(0, 2);

    for (const interviewerName of [first, second]) {
      const categoryPoints = INTERVIEW_CATEGORIES.map((category) => {
        const drift = rng.weighted([
          [-1, 1],
          [0, 3],
          [1, 1],
        ]);
        return Math.min(category.maxPoints, Math.max(1, centre + drift));
      });

      const mean = categoryPoints.reduce((sum, n) => sum + n, 0) / categoryPoints.length;

      rows.push({
        id: resultId(rows.length),
        applicantId: applicant.applicantId,
        interviewerName,
        score: Math.round(mean * 100) / 100,
        categoryPoints,
      });
    }
  }

  return rows;
}

export interface InterviewNotesRow {
  applicantId: string;
  interviewerName: string;
  body: string;
}

const NOTE_OPENERS = [
  "Came in with a clear sense of what they want out of Spark.",
  "Thoughtful, a little quiet at the start and much better once warmed up.",
  "Strong on the project questions, thinner on the collaboration ones.",
  "Very high energy. Would need direction but would take it.",
  "Has run something before and it shows in how they talk about failure.",
];

const NOTE_CLOSERS = [
  "Would put them on a project team without hesitation.",
  "Worth a second look in deliberation — I could be talked either way.",
  "Yes from me.",
  "Not a no, but not near the top of my list either.",
  "Asked good questions back, which is always a signal.",
];

/// One notes row per applicant, per FR-12's "One row per applicant" — and none
/// at all for a slice of them, so clause 12q's missing half is reachable.
export function buildInterviewNotes(
  applicants: readonly FirstRoundApplicant[],
  results: readonly InterviewResultRow[],
  rng: Rng,
): InterviewNotesRow[] {
  const interviewerByApplicant = new Map<string, string>();
  for (const result of results) {
    if (!interviewerByApplicant.has(result.applicantId)) {
      interviewerByApplicant.set(result.applicantId, result.interviewerName);
    }
  }

  const rows: InterviewNotesRow[] = [];

  for (const applicant of applicants) {
    if (rng.chance(NOTES_MISSING_RATE)) continue;

    rows.push({
      applicantId: applicant.applicantId,
      // The notes sheet names one interviewer per applicant, not both.
      interviewerName: interviewerByApplicant.get(applicant.applicantId) ?? INTERVIEWERS[0],
      // Two sentences and a blank line between them: the real sheet carries
      // paragraph breaks inside a quoted field, and FR-14 renders them with
      // `whitespace-pre-line`. A fixture with no newline in it never shows that
      // working.
      body: `${rng.pick(NOTE_OPENERS)}\n\n${rng.pick(NOTE_CLOSERS)}`,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// FR-14's votes
// ---------------------------------------------------------------------------

export interface FirstRoundVoteRow {
  applicantId: string;
  reviewerId: string;
  value: VoteValue;
}

/// A reviewer abstains on roughly this share of the pool. FR-14: "No vote
/// recorded means SKIP", and FR-15 excludes skips from both sides of the
/// percentage — neither is exercised by a fixture where everybody votes on
/// everybody.
const ABSTAIN_RATE = 0.12;

/// Every first-round reviewer votes on every applicant, minus abstentions.
///
/// **No `SKIP` row is ever written.** The absence of a row is the skip, which is
/// the rule `submitFirstRoundVote` enforces; a seed that wrote SKIP rows would
/// produce a state the application cannot.
///
/// The yes-probability follows the applicant's interview average, so the FR-15
/// ranking has signal in it rather than being a coin flip per cell — an ordering
/// nobody can sanity-check is not a fixture worth ranking.
export function buildFirstRoundVotes(
  applicants: readonly (FirstRoundApplicant & { interviewAverage: number | null })[],
  reviewerIds: readonly string[],
  rng: Rng,
): FirstRoundVoteRow[] {
  const rows: FirstRoundVoteRow[] = [];

  for (const applicant of applicants) {
    // No interview data at all: reviewers have nothing to go on, so the split is
    // even. These are the applicants FR-15's zero-vote marker and the "no
    // interview data" row state exist for.
    const average = applicant.interviewAverage ?? 2.5;
    // 2.0 → ~0.25 yes, 4.0 → ~0.85 yes.
    const yesProbability = Math.min(0.9, Math.max(0.1, (average - 1.5) * 0.42));

    for (const reviewerId of reviewerIds) {
      if (rng.chance(ABSTAIN_RATE)) continue;

      rows.push({
        applicantId: applicant.applicantId,
        reviewerId,
        value: rng.chance(yesProbability) ? VoteValue.YES : VoteValue.NO,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// FR-15's finalize
// ---------------------------------------------------------------------------

export interface SecondRoundCohortInput {
  applicants: readonly (FirstRoundApplicant & {
    yesCount: number;
    noCount: number;
  })[];
  /// Always advance these whatever they scored. The pinned reconciliation cohort
  /// again: the FR-13 fixtures name them, and an advance that dropped them would
  /// take the only applicants a committed file can find out of the round the
  /// file is about.
  alwaysAdvance: ReadonlySet<string>;
  advanceCount: number;
}

/// Who advances, ranked exactly the way FR-15 ranks and selects.
///
/// Reuses `lib/results.ts` rather than sorting here, for the reason
/// `chooseFirstRoundCohort` gives about its own round: the cohort this produces
/// has to be the cohort an admin clicking through the real screen would have
/// produced from the same votes. A second ranking rule in the seed is a second
/// thing to keep in step, and it would drift silently — nothing renders the
/// seed's opinion anywhere it could be compared.
export function chooseSecondRoundCohort(input: SecondRoundCohortInput): Set<string> {
  const ranked = rankFirstRound(
    input.applicants.map((applicant) => ({
      applicantId: applicant.applicantId,
      sourceRowIndex: applicant.sourceRowIndex,
      ...firstRoundSummary({ yesCount: applicant.yesCount, noCount: applicant.noCount }),
    })),
  );

  const advanced = new Set(input.alwaysAdvance);
  for (const row of ranked) {
    if (advanced.size >= input.advanceCount + input.alwaysAdvance.size) break;
    advanced.add(row.applicantId);
  }

  return advanced;
}
