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

import { ApplicantStatus, InstanceStage, Round } from "@/generated/prisma/enums";

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
