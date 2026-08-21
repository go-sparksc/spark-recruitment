// FR-13's four-tier reconciliation cascade. Pure — no database, no Prisma client.
//
// The `1R Notes` sheet this replaces keys on free-text applicant names typed by
// interviewers, and a typo there silently orphans a record. This module is the
// machine that makes that impossible: it takes plain strings in and returns a
// tier out, and the caller decides what to do with the answer.
//
// Same posture as lib/assignment.ts and lib/roster.ts, and for the same reason —
// the part of the phase that can actually be verified lives away from the
// surface that renders it. The cases in lib/reconciliation.test.ts ARE the
// spec. If a test disagrees with this file, this file is wrong.
//
// Three rules govern everything below, and each exists because the obvious
// alternative is silently wrong:
//
//   - **The pool is the caller's business.** PRD decision 48 scopes matching to
//     `stageReached != WRITTEN`, and that query lives in the caller. Nothing
//     here knows what a Round is, which is what makes it impossible for this
//     module to widen the pool by accident.
//   - **Ambiguity queues at every tier, not just the fuzzy one.** Two applicants
//     with the same exact name is a real state the schema permits, and
//     auto-resolving to whichever one Postgres returned first is the same defect
//     as a wrong fuzzy guess wearing a more confident face.
//   - **Nothing here decides what commits.** A FUZZY outcome is a proposal. PRD
//     decision 53 requires a human tick before it becomes data, for reasons the
//     arithmetic below makes unavoidable.

import { normalizeEmail } from "@/lib/import/preview";

/// How a row was resolved. MANUAL is not produced here — it is what the admin
/// writes when they map a row out of the unresolved queue by hand — but it
/// shares the database column, so it shares the type.
export type MatchTier = "EMAIL" | "NAME" | "FUZZY";

/// One applicant in the scoped pool.
///
/// Deliberately not the Prisma model: this is the shape the rules operate on,
/// so a test can build one from two strings rather than from an applicant, and
/// a caller cannot pass a half-loaded row by accident.
export interface Candidate {
  applicantId: string;
  email: string | null;
  displayName: string;
}

/// One staged row's identity columns, verbatim.
///
/// `undefined` means the sheet has no such column at all; `null` or `""` means
/// the column exists and this row's cell is empty. Both are treated as absent —
/// the distinction matters to the admin reading the preview, not to the match —
/// and both are tested.
export interface RowIdentity {
  email?: string | null;
  name?: string | null;
}

export interface ScoredCandidate {
  applicantId: string;
  /// Only ever set for FUZZY. PRD §5 holds the database to the same rule with a
  /// CHECK: a confidence beside an exact match would read as meaningful.
  confidence: number | null;
}

export type MatchOutcome =
  | { kind: "MATCHED"; applicantId: string; tier: MatchTier; confidence: number | null }
  /// More than one candidate at the SAME tier. The row goes to the manual queue
  /// with all of them shown, per PRD decision 45 — an ambiguous match is worse
  /// than an unresolved one, because a wrong silent guess costs a cycle and a
  /// row that waits for a human costs a minute.
  | { kind: "AMBIGUOUS"; tier: MatchTier; candidates: ScoredCandidate[] }
  /// NO_IDENTITY: the row carried nothing to match on. NO_CANDIDATES: it did,
  /// and nothing matched.
  ///
  /// Two reasons rather than one because they need different screens. A row with
  /// no name and no email cannot be resolved by looking harder — something is
  /// wrong with the file or with the mapping — whereas a row that simply found
  /// nobody is the admin's to map by hand. Collapsing them would put a pool
  /// search in front of a row that has nothing to search with.
  | { kind: "UNRESOLVED"; reason: "NO_IDENTITY" | "NO_CANDIDATES" };

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/// Everything that is not a letter, a digit, or whitespace.
///
/// Unicode-aware on purpose. `[^a-z0-9\s]` would delete the accented letters out
/// of "José" and leave "jos", which is worse than the apostrophe problem it was
/// written to solve — this is a USC applicant pool, and names carrying diacritics
/// are ordinary in it.
const NOT_NAME_CHARACTER = /[^\p{L}\p{N}\s]/gu;

const WHITESPACE = /\s+/g;

/// U+001F, the ASCII unit separator, used to join the two halves of decision
/// 50's collision key.
///
/// Built from its codepoint rather than written as a literal character or as an
/// escape. lib/roster.ts explains why a raw control character must not sit in
/// source — this file was written once with one in it, and it renders as an
/// invisible gap that a reader cannot tell from a typo. Spelling the codepoint
/// puts the value where it can be read and reviewed.
///
/// A plain space would not do: it can appear inside a normalized interviewer
/// name, so ("a1", "kim lee") and ("a1 kim", "lee") would collapse to one key.
/// Nothing survives `normalizeInterviewerName` except letters, digits and single
/// spaces, so this character cannot occur in either half.
const UNIT_SEPARATOR = String.fromCharCode(0x1f);

/// PRD decision 45's normalization, unchanged by decision 52. Applied to both
/// sides of every comparison, at tiers 2 and 3 alike.
///
/// Order is load-bearing:
///
///   1. **NFC first.** A decomposed "é" is a plain "e" followed by a combining
///      mark, and the mark is punctuation as far as step 3 is concerned — so
///      without composing first, "José" from one file and "José" from another
///      compare as "jose" and "josé" and never match.
///   2. Case-fold.
///   3. **Delete** non-alphanumerics rather than replacing them with a space.
///      Replacing turns "O'Brien" into "o brien", whose orphaned "o" is then
///      eaten by step 5, leaving "brien" — which matches nobody and looks like a
///      bug in the fuzzy scorer rather than in the normalizer.
///   4. Collapse whitespace runs and trim, after the deletions rather than
///      before, since deleting ", " leaves a gap.
///   5. Drop standalone single-letter tokens, so "Jordan A. Lee" and "Jordan
///      Lee" collapse to the same string and resolve at tier 2 rather than
///      leaning on the fuzzy threshold to absorb an inserted middle initial. A
///      threshold loose enough to swallow a whole extra token would also swallow
///      genuinely different short names.
///
/// Step 5 runs after step 3 so that "A." and "A" are one rule rather than two.
///
/// **Returns "" for a name that normalizes away entirely** — "J. R.", ".", or
/// whitespace. Callers treat that as absent. It is never compared, because an
/// empty string is trivially similar to short names and would match half the
/// pool at once.
export function normalizeMatchName(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";

  return raw
    .normalize("NFC")
    .toLowerCase()
    .replace(NOT_NAME_CHARACTER, "")
    .replace(WHITESPACE, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 1)
    .join(" ");
}

/// Interviewer names, for PRD decision 50's collision key only.
///
/// Deliberately NOT `normalizeMatchName`: this is a grouping key, not a person
/// being identified against a pool, and dropping single-letter tokens from it
/// would merge "Alex K" and "Alex" into one interviewer. Case and whitespace are
/// folded because "Alex Kim" and "alex  kim" typed into two rows of the same
/// sheet are one person, and the upsert key would treat them as two.
function normalizeInterviewerName(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFC").toLowerCase().replace(WHITESPACE, " ").trim();
}

// ---------------------------------------------------------------------------
// Jaro-Winkler
// ---------------------------------------------------------------------------

/// Standard Jaro-Winkler: matching window `⌊max(|a|,|b|)/2⌋ - 1`, prefix scale
/// 0.1 capped at four characters.
///
/// Implemented here rather than pulled from a package because it is thirty lines,
/// it is the arithmetic the whole phase turns on, and a dependency that silently
/// changes its prefix cap between minor versions would move every threshold in
/// this file without anything failing.
///
/// The tests pin it to published reference pairs — MARTHA/MARHTA 0.961,
/// DWAYNE/DUANE 0.840, DIXON/DICKSONX 0.813, CRATE/TRACE 0.733 — so a refactor
/// that changes the metric fails loudly rather than quietly re-tuning decision 52.
export function jaroWinkler(a: string, b: string): number {
  const jaro = jaroSimilarity(a, b);
  if (jaro === 0) return 0;

  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1;

  return jaro + prefix * 0.1 * (1 - jaro);
}

function jaroSimilarity(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length === 0 || b.length === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const matchedA = new Array<boolean>(a.length).fill(false);
  const matchedB = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (matchedB[j] || a[i] !== b[j]) continue;
      matchedA[i] = true;
      matchedB[j] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) return 0;

  // Transpositions: matched characters that appear in a different order. Counted
  // as half, which is the definition, not a fudge — a swapped pair is one
  // transposition across two positions.
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!matchedA[i]) continue;
    while (!matchedB[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }

  return (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
}

// ---------------------------------------------------------------------------
// The fuzzy tier — PRD decision 52
// ---------------------------------------------------------------------------

/// Jaro-Winkler over the GIVEN-NAME REMAINDER, not the whole name.
///
/// PRD decision 45 specified the whole normalized name at 0.85, and that rule
/// rejects its own worked example while admitting the example it names as a
/// counter-case: "cici fang"/"cecilia fang" scores 0.842 and "mia chen"/"nia
/// chen" scores 0.917. No threshold separates them, because the pair that must
/// match scores strictly LOWER than the pair that must not. Decision 52
/// replaced it with the three conditions below.
export const FUZZY_THRESHOLD = 0.78;

/// The score for one candidate, or null if the pair is not fuzzy-matchable.
///
/// Three conditions, all required:
///
///   1. **The surname — the last token — must be exactly equal.** A fuzzy
///      surname is a different family. It is also the half an interviewer copies
///      off a form rather than recalls, so it is the reliable half; whole-string
///      scoring averages that certainty into the unreliable half and throws it
///      away, which is exactly what pushed the Cici/Cecilia pair under the bar.
///   2. **The given-name remainders must share their first character.** A
///      difference at the initial is a different person — mia/nia, sam/pam,
///      jon/ron; a difference after it is a spelling variant — cecelia/cecilia,
///      meagan/megan, cici/cecilia. This gate carries the Mia/Nia case
///      structurally, rather than by a threshold that happens to land right.
///   3. Jaro-Winkler over the remainder, at or above `FUZZY_THRESHOLD`.
///
/// **A single-token name is never fuzzy-matchable.** There is no surname to hold
/// fixed, so condition 1 has nothing to check and the whole rule degrades to a
/// bare similarity score — the thing decision 52 exists to stop. Such a row goes
/// to the manual queue, which costs a minute.
///
/// Both arguments must already be normalized. Taking normalized strings rather
/// than raw ones is what keeps a caller from comparing a normalized row against
/// a raw display name and getting a plausible-looking wrong number.
function fuzzyScore(normalizedRowName: string, normalizedCandidateName: string): number | null {
  const rowTokens = normalizedRowName.split(" ").filter((t) => t !== "");
  const candidateTokens = normalizedCandidateName.split(" ").filter((t) => t !== "");

  if (rowTokens.length < 2 || candidateTokens.length < 2) return null;

  if (rowTokens[rowTokens.length - 1] !== candidateTokens[candidateTokens.length - 1]) return null;

  const rowGiven = rowTokens.slice(0, -1).join(" ");
  const candidateGiven = candidateTokens.slice(0, -1).join(" ");

  if (rowGiven[0] !== candidateGiven[0]) return null;

  const score = jaroWinkler(rowGiven, candidateGiven);
  return score >= FUZZY_THRESHOLD ? score : null;
}

// ---------------------------------------------------------------------------
// The cascade
// ---------------------------------------------------------------------------

/// FR-13: "exact email match first, then exact name match, then fuzzy name match
/// above a similarity threshold presented for confirmation, then an unresolved
/// queue the admin maps by hand."
///
/// **The cascade stops at the first tier that produces any candidate at all**,
/// including an ambiguous one. A row with two exact-name matches does not fall
/// through to the fuzzy tier hoping for a tiebreak: the tier that found them is
/// the strongest evidence available, and a weaker tier cannot overrule it.
///
/// `pool` is the SCOPED pool — PRD decision 48, `stageReached != WRITTEN`. This
/// function does not know that and cannot check it. An applicant the caller
/// left out is simply not matchable, which is the entire point: a fuzzy match
/// against a written-round rejection is a wrong match the scoping removes for
/// free, and it can only be removed by whoever runs the query.
export function matchRow(row: RowIdentity, pool: readonly Candidate[]): MatchOutcome {
  const email = normalizeEmail(row.email);
  const name = normalizeMatchName(row.name);

  // --- Tier 1: exact email ------------------------------------------------
  //
  // Skipped entirely when the row has no address, which FR-12 explicitly allows
  // ("Applicant Email (or Applicant Name if email is unavailable)").
  if (email !== null) {
    const hits = pool.filter((candidate) => normalizeEmail(candidate.email) === email);
    if (hits.length === 1) {
      return { kind: "MATCHED", applicantId: hits[0].applicantId, tier: "EMAIL", confidence: null };
    }
    if (hits.length > 1) {
      return { kind: "AMBIGUOUS", tier: "EMAIL", candidates: exactCandidates(hits) };
    }
    // Zero hits falls through to the name tiers. An interviewer who typed the
    // address wrong still typed the name, and PRD decision 48 means an address
    // that matches nobody IN SCOPE may still match someone outside it — which is
    // not a match, and must not become one.
  }

  if (name === "") {
    // Nothing left to try. The distinction is what the admin sees next: a row
    // that never had an identity, versus one whose identity found nobody.
    return { kind: "UNRESOLVED", reason: email === null ? "NO_IDENTITY" : "NO_CANDIDATES" };
  }

  // --- Tier 2: exact name -------------------------------------------------
  const exact = pool.filter((candidate) => normalizeMatchName(candidate.displayName) === name);
  if (exact.length === 1) {
    return { kind: "MATCHED", applicantId: exact[0].applicantId, tier: "NAME", confidence: null };
  }
  if (exact.length > 1) {
    return { kind: "AMBIGUOUS", tier: "NAME", candidates: exactCandidates(exact) };
  }

  // --- Tier 3: fuzzy name -------------------------------------------------
  const scored: ScoredCandidate[] = [];
  for (const candidate of pool) {
    const confidence = fuzzyScore(name, normalizeMatchName(candidate.displayName));
    if (confidence !== null) scored.push({ applicantId: candidate.applicantId, confidence });
  }

  if (scored.length === 1) {
    return {
      kind: "MATCHED",
      applicantId: scored[0].applicantId,
      tier: "FUZZY",
      confidence: scored[0].confidence,
    };
  }
  if (scored.length > 1) {
    // Best first, so the manual queue leads with the likeliest — but ordered
    // rather than chosen. PRD decision 45: more than one above threshold is the
    // manual queue, never the closest one.
    //
    // applicantId breaks a score tie, which is reachable: two applicants whose
    // names differ from the row in symmetric ways score identically, and a list
    // that reordered itself between two loads of the same page would make the
    // admin doubt what they were looking at.
    scored.sort(
      (a, b) =>
        (b.confidence ?? 0) - (a.confidence ?? 0) || a.applicantId.localeCompare(b.applicantId),
    );
    return { kind: "AMBIGUOUS", tier: "FUZZY", candidates: scored };
  }

  // --- Tier 4 -------------------------------------------------------------
  //
  // No "did you mean" list. The row had something to match on and it matched
  // nobody, so the manual queue offers a search over the whole scoped pool
  // instead — a different affordance from a ranked guess, and one that reads as
  // one.
  return { kind: "UNRESOLVED", reason: "NO_CANDIDATES" };
}

/// Deterministic order, and no confidence — PRD §5 permits one only on FUZZY.
function exactCandidates(hits: readonly Candidate[]): ScoredCandidate[] {
  return hits
    .map((candidate) => ({ applicantId: candidate.applicantId, confidence: null }))
    .sort((a, b) => a.applicantId.localeCompare(b.applicantId));
}

// ---------------------------------------------------------------------------
// PRD decision 49, keyed per decision 50
// ---------------------------------------------------------------------------

export interface ResolvedRow {
  rowIndex: number;
  applicantId: string;
  /// Required for SCORES, ignored for NOTES.
  interviewerName?: string | null;
}

export interface BatchCollision {
  applicantId: string;
  /// The normalized interviewer name the rows collided on, or null on the notes
  /// sheet where the applicant alone is the key. Carried so the preview can say
  /// which interviewer's row is about to be overwritten rather than only naming
  /// the applicant.
  interviewerName: string | null;
  /// Every row in the collision, in file order. Both sides, not just the later
  /// one: the admin is deciding about a pair, and showing them half of it hides
  /// half of what they are deciding.
  rowIndexes: number[];
}

/// Rows in ONE upload batch that would overwrite each other at commit.
///
/// **Keyed on the sheet's upsert key, per PRD decision 50.** Decision 49 reads
/// "more than one resolved row in the batch", which taken literally fires on
/// every correctly imported applicant on the scores sheet — FR-12 expects two
/// rows per applicant, one per interviewer. The set worth warning about is the
/// set where a second row would overwrite a first, which is
/// `(applicantId, interviewerName)` for scores and `applicantId` for notes:
/// exactly the keys the commit upserts on.
///
/// Two interviewers who genuinely share a name collide here and will merge into
/// one `InterviewResult` at commit. That is the accepted cost of a sheet whose
/// only interviewer key is free text — and surfacing it here is what keeps it
/// from being silent.
///
/// The caller passes RESOLVED rows only. An unresolved or skipped row has no
/// applicant to collide on, and commit is blocked while any remain anyway
/// (PRD decision 51).
export function findBatchCollisions(
  rows: readonly ResolvedRow[],
  sheet: "SCORES" | "NOTES",
): BatchCollision[] {
  const groups = new Map<string, { applicantId: string; interviewerName: string | null; rowIndexes: number[] }>();

  for (const row of rows) {
    const interviewerName = sheet === "SCORES" ? normalizeInterviewerName(row.interviewerName) : null;
    // U+001F, the unit separator — the same choice lib/roster.ts makes and for
    // the same reason. Normalization can never produce it, so it cannot make two
    // different pairs collapse to one key.
    const key =
      interviewerName === null
        ? row.applicantId
        : `${row.applicantId}${UNIT_SEPARATOR}${interviewerName}`;

    const existing = groups.get(key);
    if (existing) existing.rowIndexes.push(row.rowIndex);
    else groups.set(key, { applicantId: row.applicantId, interviewerName, rowIndexes: [row.rowIndex] });
  }

  return [...groups.values()]
    .filter((group) => group.rowIndexes.length > 1)
    .map((group) => ({ ...group, rowIndexes: [...group.rowIndexes].sort((a, b) => a - b) }))
    .sort((a, b) => a.rowIndexes[0] - b.rowIndexes[0]);
}
