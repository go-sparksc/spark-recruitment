// Display strings for the closed enums that reach a person.
//
// The rule this follows is the one lib/audit.ts states on humanizeAction: an
// OPEN set gets a transform, so a new member reads correctly without anyone
// remembering to add it; a CLOSED enum gets a `Record<Enum, string>`, so adding
// a member is a typecheck failure rather than a silent fallthrough. Audit
// actions are open. These three are not.
//
// Sentence case throughout, which is what the instance hub already rendered and
// therefore what the rest of the app has to agree with. Deliberately NOT used
// by the CSV exports: lib/export-csv.ts writes the raw enum, the export page
// promises cells are "written exactly as they were recorded", and
// lib/export-csv.test.ts pins the literal.

import {
  ApplicantStatus,
  InstanceStage,
  PassResolution,
  Round,
} from "@/generated/prisma/enums";

export const STAGE_LABEL: Record<InstanceStage, string> = {
  [InstanceStage.WRITTEN]: "Written round",
  [InstanceStage.FIRST_ROUND]: "First round",
  [InstanceStage.SECOND_ROUND]: "Second round",
  [InstanceStage.COMPLETE]: "Complete",
};

/// Title case, for a label or a cell of its own.
///
/// The three other `Round` maps in the app are deliberately left where they
/// are: two of them (reviewers/access-code-card.tsx, reviewers/actions.ts) are
/// lowercase because they are interpolated mid-sentence, and lib/roster.test.ts
/// asserts on that prose. Consolidating them is its own change.
export const ROUND_LABEL: Record<Round, string> = {
  [Round.WRITTEN]: "Written round",
  [Round.FIRST_ROUND]: "First round",
  [Round.SECOND_ROUND]: "Second round",
};

export const STATUS_LABEL: Record<ApplicantStatus, string> = {
  [ApplicantStatus.ACTIVE]: "Active",
  [ApplicantStatus.REJECTED]: "Rejected",
  [ApplicantStatus.SPARKLET]: "Sparklet",
};

// ---------------------------------------------------------------------------
// Outcome colour — decision 111
// ---------------------------------------------------------------------------

/// The two terminal outcomes, as one word both enums agree on.
///
/// `ApplicantStatus` and `PassResolution` each carry SPARKLET and REJECTED for
/// the same two facts at different scopes — what is true of the applicant, and
/// what one pass concluded. Decision 111 colours both, and a third surface
/// (FR-18's grid) colours the second. One type here is what stops the reviewer
/// list, the reviewer profile and the admin grid from each inventing a green.
export type Outcome = "SPARKLET" | "REJECTED";

/// Green for accepted, red for rejected, per decision 111.
///
/// **The classes live beside the vocabulary rather than in the components** for
/// the same reason `STATUS_LABEL` does: three private colour choices are three
/// chances for one screen to say something the next one contradicts, and this
/// one is a fact about a person that three surfaces render at once. Both tones
/// carry a border and a background as well as a text colour, so the state does
/// not rest on hue alone — a red/green distinction is the single most common
/// colour-vision failure, and the label beside it is what actually carries the
/// meaning.
export const OUTCOME_TONE: Record<Outcome, string> = {
  SPARKLET: "border-emerald-600/40 bg-emerald-50 text-emerald-800",
  REJECTED: "border-red-600/40 bg-red-50 text-red-800",
};

/// What is true of the applicant now. `ACTIVE` is not an outcome.
export function outcomeOfStatus(status: ApplicantStatus): Outcome | null {
  if (status === ApplicantStatus.SPARKLET) return "SPARKLET";
  if (status === ApplicantStatus.REJECTED) return "REJECTED";
  return null;
}

/// What one pass concluded about them. `CARRIED` and `NEEDS_ADMIN` are settled
/// states and deliberately not outcomes — decision 112 keeps them uncoloured,
/// because "a result occurred" is all a reviewer may read off them and an admin
/// reading a colour there would take a carry for a decision.
///
/// This is `isTerminal` in lib/passes.ts asked as a question about vocabulary
/// rather than about the state machine. `passes.test.ts` asserts the two agree
/// across every `PassResolution` and null — the same drift guard `needsAdminAtClose`
/// and `UNRESOLVED_AT_CLOSE` already carry, so a fifth resolution cannot teach
/// only one of them.
export function outcomeOfResolution(resolution: PassResolution | null): Outcome | null {
  if (resolution === PassResolution.SPARKLET) return "SPARKLET";
  if (resolution === PassResolution.REJECTED) return "REJECTED";
  return null;
}
