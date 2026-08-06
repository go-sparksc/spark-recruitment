import { Round } from "../../generated/prisma/enums";
import { FIRST_NAMES, LAST_NAMES } from "./corpus";
import type { Rng } from "./rng";

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
/// first assignment test case (150 applicants, 143 assigned, 429 slots, load 14
/// or 15). Phase 2's fixture is therefore already sitting in the database.
///
/// Note that 8 of 30 is comfortably under the one-third ceiling the feasibility
/// check enforces: with 3 slots per applicant and at most 1 Sparklet each,
/// non-Sparklets must fill 2 of every 3 slots.
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
export const RUBRIC_CATEGORIES = [
  { name: "Entrepreneurial Drive", maxPoints: 5, ordinal: 0 },
  { name: "Initiative and Follow-Through", maxPoints: 5, ordinal: 1 },
  { name: "Communication and Clarity", maxPoints: 5, ordinal: 2 },
  { name: "Fit with Spark SC", maxPoints: 5, ordinal: 3 },
] as const;
