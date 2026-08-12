import { Round } from "../../generated/prisma/enums";
import { FIRST_NAMES, LAST_NAMES } from "./corpus";
import type { Rng } from "../../lib/rng";

export const REVIEWER_COUNT = 30;
export const SPARKLET_COUNT = 8;

// PRD section 4: ~30 written reviewers, 15-25 first round, 11-15 second round.
const FIRST_ROUND_COUNT = 20;
const SECOND_ROUND_COUNT = 12;

export interface ReviewerSpec {
  firstName: string;
  lastName: string;
  isSparklet: boolean;
  rounds: Round[];
}

/// 30 reviewers with 8 Sparklets is the exact roster from BUILD_PLAN phase 2's
/// first assignment test case, so that fixture is already sitting in the
/// database. Against 150 applicants at a target of 3: 450 total slots, a pool of
/// floor(0.05 x 450) = 22, and 428 assigned across 128 applicants holding three
/// reviewers and 22 holding two. No reviewer exceeds ceil(450 / 30) = 15.
///
/// These numbers are PRD v1.4's. An earlier draft of this comment carried the
/// superseded model — whole applicants held back with zero reviewers, giving 143
/// assigned and 429 slots — which BUILD_PLAN phase 2 now retires by name. Any
/// figure derived from it is wrong.
///
/// 8 of 30 clears the feasibility check comfortably, but note what that check
/// actually computes. With at most 1 Sparklet per applicant, non-Sparklets must
/// fill at least 2 of every 3-slot applicant and 1 of every 2-slot one, which is
/// 2 x 128 + 1 x 22 = 278 of the 428 assignable slots. Against that, 22
/// non-Sparklets at a ceiling of 15 carry 330. PRD section 7.2 is explicit that
/// the precheck works from those slot counts rather than from the "Sparklets
/// under a third of the roster" rule of thumb, which is deliberately
/// conservative: the thumb rule turns away an 11-Sparklet roster that the real
/// constraint accepts at 19 x 15 = 285 against the same 278.
export function buildReviewerSpecs(rng: Rng): ReviewerSpec[] {
  const used = new Set<string>();
  const names: { firstName: string; lastName: string }[] = [];

  while (names.length < REVIEWER_COUNT) {
    const firstName = rng.pick(FIRST_NAMES);
    const lastName = rng.pick(LAST_NAMES);
    const key = `${firstName} ${lastName}`;
    if (used.has(key)) continue;
    used.add(key);
    names.push({ firstName, lastName });
  }

  const indexes = [...names.keys()];
  const sparklets = new Set(rng.shuffle(indexes).slice(0, SPARKLET_COUNT));

  // Rosters are drawn independently per round rather than nested, because PRD
  // section 7 treats them as distinct rosters, not tiers.
  const firstRound = new Set(rng.shuffle(indexes).slice(0, FIRST_ROUND_COUNT));
  const secondRound = new Set(rng.shuffle(indexes).slice(0, SECOND_ROUND_COUNT));

  return names.map((name, index) => ({
    ...name,
    isSparklet: sparklets.has(index),
    rounds: [
      Round.WRITTEN,
      ...(firstRound.has(index) ? [Round.FIRST_ROUND] : []),
      ...(secondRound.has(index) ? [Round.SECOND_ROUND] : []),
    ],
  }));
}

/// FR-4: admin sets the number of categories and max points, then names them.
/// Four categories at 5 points each matches FR-9's "0/4 scored, 4/4 scored".
/// Descriptions are seeded, not left null, because they are what a written
/// reviewer scores against (PRD decision 32) and the seed is the fixture every
/// walkthrough runs on. A seeded rubric with empty descriptions would make the
/// reviewer screen look finished while hiding the thing that decision exists to
/// fix. Wording is illustrative synthetic content, not Spark SC's real rubric.
export const RUBRIC_CATEGORIES = [
  {
    name: "Entrepreneurial Drive",
    maxPoints: 5,
    ordinal: 0,
    description:
      "Appetite for building rather than joining. A 5 has started something unprompted and can say what it cost them; a 1 describes ambition with nothing attached to it.",
  },
  {
    name: "Initiative and Follow-Through",
    maxPoints: 5,
    ordinal: 1,
    description:
      "Evidence of finishing, not just starting. A 5 ran something end to end past the point it stopped being exciting; a 1 lists projects with no outcome.",
  },
  {
    name: "Communication and Clarity",
    maxPoints: 5,
    ordinal: 2,
    description:
      "Whether the writing makes the thinking legible. A 5 is specific and ordered and would be understood by someone outside their field; a 1 needs re-reading to extract a claim.",
  },
  {
    name: "Fit with Spark SC",
    maxPoints: 5,
    ordinal: 3,
    description:
      "What they would actually do here, beyond wanting to belong. A 5 names the unglamorous half of the work; a 1 could be applying to any club.",
  },
] as const;
