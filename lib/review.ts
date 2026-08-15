// FR-9's arithmetic and its §6 projection. Pure — no database, no Prisma client.
//
// Same posture as lib/assignment.ts, lib/passes.ts and lib/roster.ts: the parts
// of a phase that can actually be verified live here, away from the surface that
// renders them. Phase 3 is entirely UI, so this is the only thing in it a test
// can hold still.
//
// Three of the four functions are small. They are here rather than inlined into
// a page because each one is a rule the UI must not be free to reinterpret:
// the completion denominator is the live rubric, an open slot is measured
// against FR-7's target, and eligibility to claim includes the one-Sparklet
// invariant. Inlined, each becomes a place where a second surface can disagree.

import { ReturnReason } from "@/generated/prisma/enums";
import { planShape } from "@/lib/assignment";
import {
  projectApplicantData,
  resolvePromoted,
  visibleFieldIds,
  type FieldGroupLike,
  type FieldLike,
  type Viewer,
} from "@/lib/fields";

// ---------------------------------------------------------------------------
// FR-9 bullet 1 — completion state
// ---------------------------------------------------------------------------

export interface Completion {
  scored: number;
  total: number;
  complete: boolean;
}

/// "0/4 scored, 4/4 scored", per FR-9.
///
/// **The denominator is the live rubric, and the numerator counts only scores
/// whose category still exists.** That is what makes FR-4's reset-and-relock
/// path correct without a special case: an admin who changes a 4-category
/// rubric to 5 mid-round moves every applicant's denominator to 5, and anyone
/// who read 4/4 against the old rubric stops reading complete.
///
/// In practice the reset deletes every `Score` — FR-4 locks the rubric once any
/// score exists, and the only way past the lock destroys them — so the state
/// actually observed after a reset is `0/5` rather than `4/5`. `4/5` is still
/// reachable without a reset, since adding a category before any score exists is
/// not blocked, and both are tested.
///
/// `categoryIds` is treated as the authority for what counts. A score against a
/// category that is no longer in the rubric contributes nothing, which is
/// structurally impossible today (`Score` cascades from `RubricCategory`) and is
/// asserted so it stays that way.
export function completionOf(
  categoryIds: readonly string[],
  scoredCategoryIds: readonly string[],
): Completion {
  const live = new Set(categoryIds);
  // A Set on the scores too: `UNIQUE (assignmentId, rubricCategoryId)` means a
  // caller cannot legitimately pass the same category twice, but counting
  // distinct values makes a caller that did unable to report 5/4.
  const scoredLive = new Set([...scoredCategoryIds].filter((id) => live.has(id)));

  const total = live.size;
  const scored = scoredLive.size;

  // A rubric with no categories is one that was never built, not one that is
  // finished. FR-4 requires at least one category, so this is unreachable
  // through the builder — but "complete" is the word a reviewer trusts to mean
  // they can stop, and 0/0 must not say it.
  return { scored, total, complete: total > 0 && scored === total };
}

// ---------------------------------------------------------------------------
// FR-9 bullet 3 — the score itself
// ---------------------------------------------------------------------------

/// Long enough for a paragraph of real reasoning, short enough that a paste of
/// the applicant's whole essay is refused rather than stored.
///
/// Lives here rather than beside the action that enforces it because a
/// `"use server"` module may only export async functions, and the textarea needs
/// the same number for its `maxLength` — so the cap is visible to the reviewer
/// before it is enforced, rather than silently truncating what they typed.
export const MAX_NOTE_LENGTH = 5000;

export type ScoreValidation =
  | { ok: true; points: number | null }
  | { ok: false; reason: string };

/// Whether a submitted score is one this category can actually take.
///
/// **Here rather than in the input control, because the bound is a rule and the
/// control is a rendering of it.** The segmented row only ever draws legal
/// values, so on the happy path this never refuses anything — which is exactly
/// why it has to exist: a server action is a POST endpoint reachable without the
/// form, and "the client only offered 0 to 5" is not a constraint on what
/// arrives.
///
/// `null` is a value rather than an error. It means *clear this score*, which is
/// what takes an applicant from 3/4 back to 2/4, and FR-9 needs that to be
/// expressible — a reviewer who mis-taps must be able to undo it without an
/// admin resetting the rubric.
export function validateScore(points: number | null, maxPoints: number): ScoreValidation {
  if (points === null) return { ok: true, points: null };

  if (!Number.isInteger(points)) {
    return { ok: false, reason: "A score has to be a whole number." };
  }
  if (points < 0) {
    return { ok: false, reason: "A score cannot be negative." };
  }
  if (points > maxPoints) {
    return { ok: false, reason: `This category is out of ${maxPoints}.` };
  }

  return { ok: true, points };
}

// ---------------------------------------------------------------------------
// FR-9 bullet 5 — returning an applicant to the pool
// ---------------------------------------------------------------------------

/// A return note is one line explaining a recusal, not a review. The score
/// note's 5000 is for reasoning about an applicant; this is for "we were on the
/// same debate team", and a cap an order of magnitude smaller says so.
export const MAX_RETURN_NOTE_LENGTH = 500;

const RETURN_REASONS: readonly string[] = Object.values(ReturnReason);

export type ReturnValidation =
  | { ok: true; reason: ReturnReason; note: string | null }
  | { ok: false; error: string };

/// FR-9's "with a required reason (conflict of interest / other)".
///
/// **The requirement is enforced here rather than by `required` on the radio
/// group.** The attribute is the courtesy that makes the browser say so before
/// the round trip; this is the boundary, because the action is a POST endpoint
/// reachable without the form. Both halves of clause 5b exist and only one of
/// them is a constraint.
///
/// **The note is optional for BOTH reasons, per decision 27** — including
/// `OTHER`, which is the half that ships as required by accident. A required
/// text box is a wall in front of the one action a reviewer takes when they
/// recognize an applicant, and an unexplained "Other" is still more than an
/// abandoned return.
///
/// An empty or whitespace-only note becomes `null` rather than `""`. The column
/// is nullable and "the reviewer wrote nothing" is not the same fact as "the
/// reviewer wrote an empty string" — FR-10 will read this later and should not
/// have to tell them apart.
export function validateReturn(reason: string | null, note: string): ReturnValidation {
  if (reason === null || !RETURN_REASONS.includes(reason)) {
    return { ok: false, error: "Pick a reason." };
  }

  const trimmed = note.trim();
  if (trimmed.length > MAX_RETURN_NOTE_LENGTH) {
    return { ok: false, error: `Keep the reason under ${MAX_RETURN_NOTE_LENGTH} characters.` };
  }

  return { ok: true, reason: reason as ReturnReason, note: trimmed === "" ? null : trimmed };
}

// ---------------------------------------------------------------------------
// FR-9 bullet 6 — the pool
// ---------------------------------------------------------------------------

/// How many of an applicant's slots are open, per FR-9's "applicants who are
/// short a reviewer".
///
/// `target` comes from `planShape` rather than a literal 3, so the pool view and
/// the generator cannot disagree about how many reviewers an applicant is
/// supposed to have. On a roster smaller than three that number is smaller, and
/// a hardcoded 3 would show open slots that no reviewer exists to fill.
///
/// Clamped at zero: an admin can manually assign a fourth reviewer under FR-8,
/// and a negative count would render as an open slot on an applicant who has
/// more coverage than the target, not less.
export function openSlotsOf(target: number, activeAssignmentCount: number): number {
  return Math.max(0, target - activeAssignmentCount);
}

/// Convenience wrapper so callers do not have to remember which two numbers
/// `planShape` needs to produce the target.
export function targetFor(applicantCount: number, roundReviewerCount: number): number {
  return planShape(applicantCount, roundReviewerCount).target;
}

export type ClaimRefusal = "NO_OPEN_SLOTS" | "ALREADY_ASSIGNED" | "SECOND_SPARKLET";

export type ClaimEligibility = { eligible: true } | { eligible: false; reason: ClaimRefusal };

export interface ClaimReviewer {
  id: string;
  isSparklet: boolean;
}

export interface ClaimApplicant {
  openSlots: number;
  /// Reviewers currently holding an ACTIVE assignment on this applicant. A
  /// RETURNED_TO_POOL row is not one of these — decision 28 allows a reviewer to
  /// reclaim an applicant they returned.
  assignedReviewerIds: readonly string[];
  /// Whether one of those active reviewers is a Sparklet.
  hasSparklet: boolean;
}

/// Whether this reviewer may take one of this applicant's open slots.
///
/// **The Sparklet rule is here even though FR-9 does not mention it.** "At most
/// one Sparklet reviews any given applicant" is an invariant of the system
/// rather than a property of generation — FR-7's precheck exists to protect it,
/// and a claim that breaks it produces exactly the state the precheck refuses to
/// generate. It is checked here so the pool list can filter, and again inside
/// the claim transaction so the list being stale cannot get past it.
///
/// **The order of the refusals is deliberate**, because each one has to mean
/// something specific to whoever reads it:
///
///   1. `ALREADY_ASSIGNED` is a fact about this reviewer that nobody else can
///      change, so it is worth saying before anything transient.
///   2. `NO_OPEN_SLOTS` is the one that changes under the reviewer's feet, and
///      the one a losing claimant in a race needs to see.
///   3. `SECOND_SPARKLET` is last because it only matters once a slot exists to
///      take.
export function claimEligibility(
  reviewer: ClaimReviewer,
  applicant: ClaimApplicant,
): ClaimEligibility {
  if (applicant.assignedReviewerIds.includes(reviewer.id)) {
    return { eligible: false, reason: "ALREADY_ASSIGNED" };
  }
  if (applicant.openSlots <= 0) {
    return { eligible: false, reason: "NO_OPEN_SLOTS" };
  }
  if (reviewer.isSparklet && applicant.hasSparklet) {
    return { eligible: false, reason: "SECOND_SPARKLET" };
  }
  return { eligible: true };
}

// ---------------------------------------------------------------------------
// FR-9 bullet 2 — the applicant detail view, projected for §6
// ---------------------------------------------------------------------------

/// `FieldLike` plus what it takes to render one. Extending rather than
/// redeclaring keeps these usable by `resolveField` and `visibleFieldIds`
/// unchanged.
export interface ReviewFieldLike extends FieldLike {
  displayName: string;
  ordinal: number;
}

export interface ReviewFieldGroupLike extends FieldGroupLike {
  displayName: string;
}

export interface ApplicantViewField {
  fieldId: string;
  displayName: string;
  /// The group's heading when this column is a member of one, so several
  /// columns forming one question render as one question. Null when ungrouped.
  groupDisplayName: string | null;
  value: string;
}

/// **A discriminated union rather than optional properties**, so a component
/// cannot reach for a name that is not there. `view.displayName` does not
/// typecheck until `view.identified` has been narrowed to true, which makes §6's
/// blind-review rule a compile error rather than a code review.
export type ApplicantView =
  | {
      identified: false;
      /// "Applicant 47", from sourceRowIndex. The only identity a written
      /// reviewer gets.
      label: string;
      fields: ApplicantViewField[];
    }
  | {
      identified: true;
      label: string;
      displayName: string;
      email: string | null;
      fields: ApplicantViewField[];
    };

export interface ApplicantSource {
  sourceRowIndex: number;
  displayName: string;
  email: string | null;
  data: Record<string, unknown>;
}

/// A value the reviewer should actually see rendered. `Applicant.data` holds
/// verbatim CSV strings, so an unchecked one-hot column is `""` and an
/// unanswered optional question is missing entirely.
function presentableValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === "string" ? raw : String(raw);
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/// Build one applicant's detail view for one viewer. PRD §6, server-side.
///
/// The projection happens here rather than in the page so that what a reviewer
/// may see is decided in one tested place. A hidden field is **absent from the
/// returned object**, not present and hidden — which is what makes it absent
/// from the RSC payload too. §6: "A reviewer request for a hidden field returns
/// no data."
///
/// Empty values are dropped rather than rendered blank. Thirty headings over
/// "(no answer)" on a phone is scrolling that buys a reviewer nothing, and FR-3
/// already warns at import when an instance has no RESPONSE field at all.
export function buildApplicantView(
  applicant: ApplicantSource,
  fields: readonly ReviewFieldLike[],
  groups: readonly ReviewFieldGroupLike[],
  viewer: Viewer,
): ApplicantView {
  const visible = visibleFieldIds(fields, groups, viewer);
  const data = projectApplicantData(applicant.data, visible);

  const groupsById = new Map(groups.map((group) => [group.id, group]));

  const rendered: ApplicantViewField[] = fields
    .filter((field) => visible.has(field.id))
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((field) => {
      const value = presentableValue(data[field.id]);
      if (value === null) return null;
      const group = field.groupId === null ? null : (groupsById.get(field.groupId) ?? null);
      return {
        fieldId: field.id,
        displayName: field.displayName,
        groupDisplayName: group?.displayName ?? null,
        value,
      };
    })
    .filter((entry): entry is ApplicantViewField => entry !== null);

  const label = `Applicant ${applicant.sourceRowIndex}`;
  const promoted = resolvePromoted(viewer);

  if (!promoted.name) {
    // Deliberately does not spread `applicant`. Building the identified shape
    // and deleting keys would put the name in the object first, and the whole
    // point is that it is never there.
    return { identified: false, label, fields: rendered };
  }

  return {
    identified: true,
    label,
    displayName: applicant.displayName,
    email: promoted.email ? applicant.email : null,
    fields: rendered,
  };
}
