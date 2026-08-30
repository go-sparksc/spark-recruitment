// The attempt-counter state machine for the password endpoints. PRD decision 92.
//
// Pure: no database, no clock, no environment. `lib/rate-limit-store.ts` is the
// half that touches Prisma, on the same split as lib/export.ts /
// lib/instance-io.ts. Every transition below is decided here and nowhere else.
//
// **The machine deliberately did not move into SQL** when the store became
// Postgres in Phase 8. Expressing "is this bucket spent?" a second time in a
// CASE expression would create two copies that can disagree about when a key
// resets — so the store locks the row, hands the record to these functions, and
// writes back what they return. See decision 92.
//
// This was `createAttemptLimiter`, a closure over a Map, until Phase 8. The
// transitions are unchanged; what changed is that the state arrives as an
// argument instead of living in the process. Decision 19 has the history of why
// the in-process version was never the answer.

export interface AttemptLimiterPolicy {
  /// Failures allowed inside one window before the key locks.
  maxAttempts: number;
  /// How long failures are remembered.
  windowMs: number;
  /// How long a locked key stays locked.
  lockoutMs: number;
}

/// One key's state. Mirrors the `RateLimitBucket` row, minus the key itself and
/// minus `lockoutCount` — that is a running tally for whoever reads the table
/// later, and nothing here branches on it, so it stays out of the machine.
///
/// Times are milliseconds since the epoch. `lockedUntil` is null rather than 0
/// when the key is not locked, matching the nullable column and leaving no
/// sentinel value to misread.
export interface AttemptBucket {
  failures: number;
  windowStartedAt: number;
  lockedUntil: number | null;
}

export interface AttemptVerdict {
  allowed: boolean;
  /// Failures left before lockout. Zero once locked.
  remaining: number;
  /// Milliseconds until the caller may retry. Zero when allowed.
  retryAfterMs: number;
}

/// True once a bucket stops binding: its lockout has been served, or its window
/// has rolled over. Either way the next failure starts a fresh count.
///
/// Distinct from `isExpired` below, and the pair is not redundant. A bucket past
/// its lockout but still inside its window is spent (it no longer refuses
/// anyone) yet not expired (deleting it would be safe, but the distinction is
/// what keeps the two questions from being answered by one predicate that is
/// subtly wrong for one of them).
function isSpent(bucket: AttemptBucket, policy: AttemptLimiterPolicy, at: number): boolean {
  if (bucket.lockedUntil !== null) return at >= bucket.lockedUntil;
  return at - bucket.windowStartedAt >= policy.windowMs;
}

/// True once a bucket can no longer affect any verdict, so the row can be
/// deleted. Both the lockout and the window must be done.
///
/// The null check is written out rather than leaning on a comparison, because
/// `at >= null` coerces to `at >= 0` in JavaScript and would silently call every
/// unlocked bucket expired regardless of its window.
export function isExpired(
  bucket: AttemptBucket,
  policy: AttemptLimiterPolicy,
  at: number,
): boolean {
  const lockDone = bucket.lockedUntil === null || at >= bucket.lockedUntil;
  return lockDone && at - bucket.windowStartedAt >= policy.windowMs;
}

/// What to tell a caller holding this key right now. A null bucket is an
/// untouched key and gets the full allowance.
export function verdictFor(
  bucket: AttemptBucket | null,
  policy: AttemptLimiterPolicy,
  at: number,
): AttemptVerdict {
  if (!bucket) return { allowed: true, remaining: policy.maxAttempts, retryAfterMs: 0 };

  if (bucket.lockedUntil !== null && at < bucket.lockedUntil) {
    return { allowed: false, remaining: 0, retryAfterMs: bucket.lockedUntil - at };
  }

  if (isSpent(bucket, policy, at)) {
    return { allowed: true, remaining: policy.maxAttempts, retryAfterMs: 0 };
  }

  return {
    allowed: true,
    remaining: Math.max(0, policy.maxAttempts - bucket.failures),
    retryAfterMs: 0,
  };
}

export interface FailureOutcome {
  /// The state to persist.
  bucket: AttemptBucket;
  /// The verdict for the caller who just failed.
  verdict: AttemptVerdict;
  /// True only on the transition INTO lockout, so the caller writes exactly one
  /// audit row per lockout rather than one per attempt while locked.
  justLocked: boolean;
}

/// Fold one failure into a key's state.
export function bucketAfterFailure(
  existing: AttemptBucket | null,
  policy: AttemptLimiterPolicy,
  at: number,
): FailureOutcome {
  // Already locked: the attempt was refused before any password was checked, so
  // counting it slows no attacker. Extending the lock would only move the
  // release time for whoever shares this key — which turns the defence into a
  // denial of service against the admin, since anything retrying in a loop
  // could hold the lock open indefinitely. Leave it exactly as it is.
  if (existing && existing.lockedUntil !== null && at < existing.lockedUntil) {
    return { bucket: existing, verdict: verdictFor(existing, policy, at), justLocked: false };
  }

  const bucket: AttemptBucket =
    !existing || isSpent(existing, policy, at)
      ? { failures: 1, windowStartedAt: at, lockedUntil: null }
      : { ...existing, failures: existing.failures + 1 };

  const justLocked = bucket.failures >= policy.maxAttempts;
  if (justLocked) bucket.lockedUntil = at + policy.lockoutMs;

  return { bucket, verdict: verdictFor(bucket, policy, at), justLocked };
}

/// 10 failures in 15 minutes, then locked for 15 minutes.
///
/// Chosen against the actual users: an admin mistyping a password a few times is
/// normal, ten is not, and a fifteen-minute lockout is survivable for someone
/// who genuinely forgot. Against an attacker it caps a single origin at roughly
/// 40 guesses an hour, which does not make a weak password safe — it makes a
/// strong one impractical to guess. Pick a strong one.
export const PASSWORD_ATTEMPT_POLICY: AttemptLimiterPolicy = {
  maxAttempts: 10,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
};
