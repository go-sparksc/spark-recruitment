// PRD decision 115 — which rounds a reviewer must already serve before joining
// another. Pure — no database, no Prisma client.
//
// **Its own module rather than an addition to lib/roster.ts**, which states as a
// design property that it is "free of the Round enum and of any opinion about
// which round is being staffed". This rule is nothing but an opinion about which
// round is being staffed, so putting it there would have quietly broken the
// invariant that module's own comment asserts.
//
// **And not in the roster's server actions**, where it started. A `"use server"`
// module may only export async functions, so a rule living there cannot be
// imported by a test — and this one has ordering, an agreement between a list
// and its prose, and a message an admin has to act on.

import { Round } from "@/generated/prisma/enums";

/// What a reviewer must already hold before they can hold `round`.
///
/// Written: nothing — it is where everyone enters. First round: the written.
/// Second round: both.
const ROUND_PREREQUISITES: Record<Round, Round[]> = {
  [Round.WRITTEN]: [],
  [Round.FIRST_ROUND]: [Round.WRITTEN],
  [Round.SECOND_ROUND]: [Round.WRITTEN, Round.FIRST_ROUND],
};

/// Lowercase, because every use of it here is mid-sentence. `lib/labels.ts`
/// records why this codebase has several round-name maps rather than one: some
/// are title case for a cell of their own, some lowercase for prose, and tests
/// assert on the prose.
const ROUND_WORDS: Record<Round, string> = {
  [Round.WRITTEN]: "written round",
  [Round.FIRST_ROUND]: "first round",
  [Round.SECOND_ROUND]: "second round",
};

/// Why this reviewer may not join `round` yet, or null when they may.
///
/// **This is not decision 84's lock and must not be folded into it.** 84 is a
/// *time* lock — the second-round roster freezes once a pass exists, because a
/// denominator then has votes riding on it. This is a *membership* rule: it
/// holds from the moment the instance exists, applies to the first round too,
/// and has nothing to do with whether a pass exists.
///
/// The caller checks 84 first. A frozen roster makes eligibility moot, so an
/// admin who trips both should be told the roster is fixed rather than sent off
/// to staff the written round for a change that would be refused anyway.
///
/// Membership of the earlier round's roster, not evidence of submitted work —
/// decision 115. Someone rostered who scored nothing was still handed the
/// applications, and asking "did they actually do anything" would put a
/// judgment about a person behind a checkbox.
export function prerequisiteBlock(rounds: readonly Round[], round: Round): string | null {
  const missing = ROUND_PREREQUISITES[round].filter((needed) => !rounds.includes(needed));
  if (missing.length === 0) return null;

  const names = missing.map((needed) => ROUND_WORDS[needed]);
  const list = names.length === 1 ? `the ${names[0]}` : `the ${names[0]} and the ${names[1]}`;

  // Names the FIRST missing round as the fix, not the whole list: the rounds are
  // ordered, so that is the only one an admin can act on right now. Telling
  // someone to add a reviewer to both at once would be telling them to do
  // something the grid cannot express.
  return (
    `A reviewer joins the ${ROUND_WORDS[round]} only after ${list}. Someone who never read the ` +
    `written applications would be deliberating without the evidence the earlier rounds ` +
    `produced. Add them to the ${names[0]} first.`
  );
}

/// Decision 115: new people enter through the written round and are promoted
/// from there on the roster grid. Both routes that CREATE a reviewer — FR-6's
/// add form and its paste box — are written-round-only.
///
/// Here rather than beside the actions so the refusal and the page's
/// explanation cannot drift into saying different things about the same rule.
export const ADD_WRONG_ROUND =
  "Reviewers are added to the written round, then ticked into later rounds on the grid below. " +
  "That way a first- or second-round reviewer has always read the written applications, and one " +
  "person never ends up as two roster rows.";
