// FR-6's bulk paste parser. Pure — no database, no Prisma client.
//
// The roster is where a round's data starts, so a name that lands wrong here is
// wrong everywhere downstream. Three rules do the work, and each exists because
// the obvious alternative is silently lossy:
//
//   - A line splits on its LAST space, not its first. "Mary Anne Chen" is one
//     person with a two-word first name, and splitting on the first space files
//     her under "Anne Chen".
//   - A line with no space cannot be split and does not import. Importing "Cher"
//     with a blank last name would satisfy the schema and lose the fact that
//     nobody ever supplied one.
//   - Two lines producing the same name are not deduplicated. Two reviewers may
//     genuinely share a name, and §5 puts no unique constraint on it — which is
//     the whole reason every vote in this schema references reviewerId.
//
// Nothing here knows about Sparklets or rounds. FR-6: "All pasted reviewers
// arrive as non-Sparklets and as members of the round being staffed; the
// Sparklet flag and any additional rounds are set afterward in the roster grid."
// The types below have no field for either, so that cannot be got wrong by a
// caller.

/// Why an entry needs the admin before it can be written.
///
/// UNSPLITTABLE blocks: there is no last name and `Reviewer.lastName` is
/// non-null, so the admin supplies one or drops the line.
///
/// DUPLICATE_IN_PASTE is confirm-to-keep: both rows import once acknowledged.
///
/// MATCHES_EXISTING_REVIEWER is a choice between two different writes — add the
/// round to the reviewer who is already there, or create a second row because
/// two people share a name. Neither is a safe default: one silently merges two
/// people, the other silently splits one.
export type RosterFlag = "UNSPLITTABLE" | "DUPLICATE_IN_PASTE" | "MATCHES_EXISTING_REVIEWER";

/// A reviewer already on the instance. Instance-scoped, not round-scoped, per
/// PRD open decision 22: `Reviewer` is one row carrying a `rounds` array, so an
/// Alex Kim serving FIRST_ROUND *is* the same person as an Alex Kim being added
/// to WRITTEN. Comparing per-round would answer "is this a new person?" with "is
/// this person already staffed here?" and produce two rows for one human — the
/// name-keying defect this system exists to remove, reintroduced at the roster.
///
/// The caller flattens round membership to a boolean, which keeps this module
/// free of the Round enum and of any opinion about which round is being staffed.
export interface ExistingReviewer {
  id: string;
  firstName: string;
  lastName: string;
  servesThisRound: boolean;
}

export interface RosterEntry {
  /// 1-based position among ALL the paste's lines, including the blanks that
  /// were dropped, so the number matches what the admin counts in the textarea.
  /// Dropped blanks leave gaps, for the same reason `sourceRowIndex` does.
  lineNumber: number;
  /// The line exactly as pasted, before trimming or whitespace collapsing. The
  /// confirmation queue shows this rather than the parsed halves, so an admin
  /// looking at a flagged line sees what they actually pasted.
  raw: string;
  firstName: string;
  /// Empty only when UNSPLITTABLE. Never written to the database in that state.
  lastName: string;
  flags: RosterFlag[];
  /// Set with MATCHES_EXISTING_REVIEWER. The queue needs the id to offer "add
  /// this round to them", and the boolean to know whether that would do nothing.
  match?: { reviewerId: string; alreadyServesThisRound: boolean };
}

export interface ParsedRoster {
  /// Unflagged. These import as-is on commit.
  ready: RosterEntry[];
  /// The confirmation queue. Order follows the paste.
  needsConfirmation: RosterEntry[];
  /// Blank and whitespace-only lines, dropped silently per FR-6. Counted rather
  /// than discarded so the UI can say "3 blank lines ignored" — silence about a
  /// line that vanished is how an admin ends up with 29 of 30 reviewers and no
  /// idea which one is missing.
  droppedLineCount: number;
}

/// Slack pastes carry non-breaking spaces, and a name split on a character the
/// admin cannot see is a bug nobody can explain — the line looks identical to
/// one that works. JavaScript's `\s` already covers every Unicode space
/// separator, U+00A0 and U+3000 among them, so this needs no character list of
/// its own; a run of any of them collapses to one ordinary space before the split.
const WHITESPACE = /\s+/g;

/// NFC, whitespace runs collapsed to one space, trimmed. **Case is preserved.**
///
/// This is what gets stored. `checkReviewerName` returns these values and every
/// write path persists exactly them, so a normalizer that folded case would put
/// the whole roster — and FR-20's export of it — in lower case. Folding belongs
/// in `nameKey` below, which is compared and never stored.
function normalizeNamePart(value: string): string {
  return value.normalize("NFC").replace(WHITESPACE, " ").trim();
}

/// The comparison key. Case-folded, and never stored.
///
/// The separator is U+001F, the ASCII unit separator, which normalization can
/// never produce inside a name: every run of whitespace collapses to a plain
/// space and nothing else is stripped. A space would instead make the key
/// ambiguous — ("Ann Marie", "Smith") and ("Ann", "Marie Smith") both fold to
/// "ann marie smith", and two different people would be reported as the same one.
///
/// That pair is reachable, on three of the four ways a name enters the roster:
/// manual add, a rename in the grid, and the two free-text inputs the paste queue
/// offers for a line it could not split. Only a paste itself cannot produce it,
/// because every line splits on its LAST space, so a pasted "Ann Marie Smith" is
/// always ("Ann Marie", "Smith"). All four paths go through `checkReviewerName`,
/// which is why one key is enough to keep them agreeing.
///
/// A multi-word surname is not the problem and is rejected nowhere — "de la Cruz"
/// and "van der Berg" are names. The rule is only that two different splits of
/// the same words must not be mistaken for each other.
///
/// Deliberately not U+0000. It behaves identically at runtime, but a literal NUL
/// in the first 8000 bytes trips git's binary heuristic, and this file was
/// committed once as "Bin 0 -> 7884 bytes" — undiffable and unreviewable —
/// because one got in. Both are written as escapes; U+001F leaves nothing to go
/// wrong if someone later replaces the escape with the character itself.
function nameKey(firstName: string, lastName: string): string {
  return `${firstName}\u001F${lastName}`.normalize("NFC").toLowerCase();
}

/// Reviewers on the instance whose name matches, ignoring one id so a rename
/// does not collide with the row being renamed.
///
/// Shared by `parseRoster` and `checkReviewerName`, so every entry path compares
/// names the same way. Existing names are normalized before comparison too: they
/// were stored normalized, but a row that predates this function, or one written
/// by the seed, should not silently fail to match.
function findMatches(
  firstName: string,
  lastName: string,
  existing: readonly ExistingReviewer[],
  ignoreReviewerId?: string,
): ExistingReviewer[] {
  const key = nameKey(firstName, lastName);
  return existing.filter(
    (reviewer) =>
      reviewer.id !== ignoreReviewerId &&
      nameKey(normalizeNamePart(reviewer.firstName), normalizeNamePart(reviewer.lastName)) === key,
  );
}

export type NameCheck =
  | { ok: false; reason: string }
  /// The values to store. Callers write THESE, never their own input — that is
  /// what makes it impossible to validate one string and persist another.
  | { ok: true; firstName: string; lastName: string; matches: ExistingReviewer[] };

/// The one gate every reviewer name passes through before it is written.
///
/// Four paths create or change a name: a pasted line, the paste queue's two
/// free-text inputs for an unsplittable line, manual add, and a rename in the
/// grid. Only the first goes through `parseRoster`, and `parseRoster` is the
/// wrong home for this anyway — it is line-oriented and three of the four never
/// see a line. So the shared part lives here and they all call it.
///
/// **Matches are reported, not refused.** FR-6 is explicit that two reviewers
/// sharing a name is not an error, and §5 puts no unique constraint on it. The
/// caller decides whether to ask for confirmation; blocking here would invent a
/// rule the PRD does not have.
export function checkReviewerName(
  proposed: { firstName: string; lastName: string },
  existing: readonly ExistingReviewer[] = [],
  options: { ignoreReviewerId?: string } = {},
): NameCheck {
  const firstName = normalizeNamePart(proposed.firstName ?? "");
  const lastName = normalizeNamePart(proposed.lastName ?? "");

  // Both halves are required. `Reviewer.lastName` is non-null, and a blank first
  // name makes the roster dropdown in FR-9 unreadable.
  if (firstName === "" && lastName === "") return { ok: false, reason: "Enter a name." };
  if (firstName === "") return { ok: false, reason: "This reviewer needs a first name." };
  if (lastName === "") return { ok: false, reason: "This reviewer needs a last name." };

  return {
    ok: true,
    firstName,
    lastName,
    matches: findMatches(firstName, lastName, existing, options.ignoreReviewerId),
  };
}

/// FR-6: "blank and whitespace-only lines are dropped silently. A line is split
/// on its last space, everything before becoming the first name and everything
/// after the last."
export function parseRoster(
  text: string,
  existing: readonly ExistingReviewer[] = [],
): ParsedRoster {
  const lines = text.split(/\r\n|\r|\n/);

  const entries: RosterEntry[] = [];
  let droppedLineCount = 0;

  lines.forEach((raw, index) => {
    // The same normalization every other entry path gets, so a pasted name and
    // a typed one that look alike are alike. NFC first matters: a decomposed
    // accent must not survive as a separate code point into the split, the
    // comparison, or the database.
    const collapsed = normalizeNamePart(raw);

    if (collapsed === "") {
      droppedLineCount += 1;
      return;
    }

    const lastSpace = collapsed.lastIndexOf(" ");
    const entry: RosterEntry = {
      lineNumber: index + 1,
      raw,
      // A line with no space keeps its whole text as the first name. Putting it
      // in `firstName` rather than `lastName` is deliberate: the queue prompts
      // for a last name, and a one-word name is far more often a first one.
      firstName: lastSpace === -1 ? collapsed : collapsed.slice(0, lastSpace),
      lastName: lastSpace === -1 ? "" : collapsed.slice(lastSpace + 1),
      flags: lastSpace === -1 ? ["UNSPLITTABLE"] : [],
    };

    entries.push(entry);
  });

  // Duplicates within the paste. Both sides are flagged, not just the second:
  // the admin is deciding about a pair, and showing them only the later line
  // hides half of what they are deciding about.
  const countsInPaste = new Map<string, number>();
  for (const entry of entries) {
    const key = nameKey(entry.firstName, entry.lastName);
    countsInPaste.set(key, (countsInPaste.get(key) ?? 0) + 1);
  }

  for (const entry of entries) {
    // An unsplittable line has no last name to compare, so it is not compared.
    // "Cher" against an existing Cher Bono is not a match, and claiming it was
    // would be guessing at the very name the admin has not supplied yet.
    if (entry.flags.includes("UNSPLITTABLE")) continue;

    const key = nameKey(entry.firstName, entry.lastName);

    if ((countsInPaste.get(key) ?? 0) > 1) {
      entry.flags.push("DUPLICATE_IN_PASTE");
    }

    // Through the shared finder, so a pasted line and a typed one reach the
    // same verdict about the same roster. First match wins: two existing rows
    // already sharing a name is a state the schema permits, either is an equally
    // correct thing to offer the round to, and both are visible in the grid.
    const [match] = findMatches(entry.firstName, entry.lastName, existing);
    if (match) {
      entry.flags.push("MATCHES_EXISTING_REVIEWER");
      entry.match = {
        reviewerId: match.id,
        alreadyServesThisRound: match.servesThisRound,
      };
    }
  }

  return {
    ready: entries.filter((entry) => entry.flags.length === 0),
    needsConfirmation: entries.filter((entry) => entry.flags.length > 0),
    droppedLineCount,
  };
}

// ---------------------------------------------------------------------------
// Removing a reviewer — PRD §10 decision 24
// ---------------------------------------------------------------------------
//
// `Assignment.reviewerId` is `onDelete: Cascade`, so deleting a reviewer takes
// every assignment they hold, and `Score` and `ReviewNote` cascade from the
// assignment in turn. One click can therefore destroy submitted reviewer work
// with no undo and no trace, which is the single largest data-loss risk in the
// product outside instance deletion.
//
// The decision is pure and lives here rather than in the server action so it can
// be tested without a database. That matters more than usual: no `Score` row can
// exist until Phase 3 builds the scoring UI, so there is nothing to demonstrate
// the guard against by hand. Until then these tests ARE the guarantee — the same
// posture `saveRubric` takes toward FR-4's lock, and the reason the counts are
// an input rather than something this function goes and fetches.

/// What a removal would destroy. Counts are over the assignments in scope: every
/// assignment the reviewer holds when removing them outright, or only that
/// round's when withdrawing them from one round.
export interface RemovalImpact {
  assignmentCount: number;
  /// Of those, how many carry at least one `Score`.
  scoredAssignmentCount: number;
  /// Of those, how many carry a `ReviewNote`. Counted separately from scores: a
  /// reviewer can leave a note without scoring, and the note is still their work.
  notedAssignmentCount: number;
}

export interface RemovalRequest {
  reviewerName: string;
  /// Null when removing the reviewer from the instance. A round name — "written
  /// round", "first round" — when only that round's membership is withdrawn.
  roundLabel: string | null;
}

export type RemovalVerdict =
  /// `reason` names what blocks it AND the way out. A refusal that does not say
  /// what to do instead is a dead end, and the admin's alternatives here are not
  /// guessable from the message.
  | { allowed: false; reason: string }
  /// `consequence` is shown in the confirmation before the removal happens. It
  /// is never empty: "are you sure?" with no statement of what is lost is the
  /// dialog everyone clicks through.
  | { allowed: true; consequence: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/// Blocked while the reviewer holds scored or noted work; otherwise permitted,
/// with the cost stated.
///
/// **Fails closed.** Any impact that is not a set of consistent, non-negative
/// integers is refused rather than interpreted. A guard against irreversible
/// deletion is the wrong place to be forgiving about its own inputs: a count
/// that arrives as NaN because a query changed shape must not read as zero.
export function checkReviewerRemoval(
  request: RemovalRequest,
  impact: RemovalImpact,
): RemovalVerdict {
  const { assignmentCount, scoredAssignmentCount, notedAssignmentCount } = impact;
  const counts = [assignmentCount, scoredAssignmentCount, notedAssignmentCount];

  if (counts.some((n) => !Number.isInteger(n) || n < 0)) {
    return {
      allowed: false,
      reason:
        "Could not work out what removing this reviewer would delete, so it has been refused. " +
        "This is a bug — report it rather than working around it.",
    };
  }

  // Either sub-count exceeding the total means the caller counted two different
  // sets. Refusing is right even though it looks impossible: the alternative is
  // trusting the smaller number and deleting work the larger one was counting.
  if (scoredAssignmentCount > assignmentCount || notedAssignmentCount > assignmentCount) {
    return {
      allowed: false,
      reason:
        "The counts for this reviewer's work disagree with each other, so removal has been " +
        "refused. This is a bug — report it rather than working around it.",
    };
  }

  const scope = request.roundLabel === null ? "Removing them" : `Removing them from the ${request.roundLabel}`;

  if (scoredAssignmentCount > 0 || notedAssignmentCount > 0) {
    // Both numbers, always, even when one is zero. "4 scored" alone invites the
    // admin to think the notes are safe.
    const held = [
      `${plural(scoredAssignmentCount, "applicant", "applicants")} scored`,
      `${plural(notedAssignmentCount, "note", "notes")} written`,
    ].join(" and ");

    return {
      allowed: false,
      reason:
        `${request.reviewerName} has submitted work: ${held}, across ` +
        `${plural(assignmentCount, "assignment", "assignments")}. ${scope} would delete it, ` +
        `permanently and with no undo. Unassign them from those applicants first, or ` +
        `regenerate the assignments.`,
    };
  }

  if (assignmentCount === 0) {
    return {
      allowed: true,
      // **Names the scope, like every other branch.** This one used to read
      // "X has no assignments. Nothing else is affected." for BOTH a withdrawal
      // from one round and a delete of the reviewer entirely — the same sentence
      // for the reversible action and the irreversible one.
      //
      // It is the branch where that matters most, because it is the one a
      // second-round reviewer always lands in: they hold no written
      // assignments, so `assignmentCount` is 0 and the wording above never
      // reaches them. An admin unchecking one round was shown the text they
      // would have been shown for "Remove", and had no way to tell from the
      // dialog which one they had opened.
      consequence:
        request.roundLabel === null
          ? `${request.reviewerName} has no assignments. Removing them deletes the reviewer ` +
            `entirely, from every round they serve.`
          : `${request.reviewerName} has no assignments in the ${request.roundLabel}. They are ` +
            `withdrawn from that round only and stay on the roster for any other.`,
    };
  }

  return {
    allowed: true,
    consequence:
      `${scope} deletes ${plural(assignmentCount, "assignment", "assignments")}, none of them ` +
      `scored. Those applicants drop to open slots that any reviewer can claim.`,
  };
}
