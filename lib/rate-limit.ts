// A fixed-window attempt counter with lockout, for the password endpoints.
//
// THIS IS A STOPGAP, NOT THE ANSWER. See PRD open decision 19. It holds state
// in the process, which means it resets on deploy and is not shared between
// serverless instances — an attacker whose requests land on different instances
// gets the full allowance from each. It raises the cost of a brute-force
// attempt against a shared password from "free" to "annoying". BUILD_PLAN
// Phase 8 owns the real fix.
//
// Pure apart from the clock, which is injectable so the lockout can be tested
// without sleeping.

export interface AttemptLimiterOptions {
  /// Failures allowed inside one window before the key locks.
  maxAttempts: number;
  /// How long failures are remembered.
  windowMs: number;
  /// How long a locked key stays locked.
  lockoutMs: number;
  /// Injectable for tests. Defaults to Date.now.
  now?: () => number;
}

export interface AttemptVerdict {
  allowed: boolean;
  /// Failures left before lockout. Zero once locked.
  remaining: number;
  /// Milliseconds until the caller may retry. Zero when allowed.
  retryAfterMs: number;
}

interface Bucket {
  failures: number;
  windowStartedAt: number;
  lockedUntil: number;
}

export interface AttemptLimiter {
  check(key: string): AttemptVerdict;
  recordFailure(key: string): AttemptVerdict;
  /// Call on success, so a correct password clears the record immediately.
  reset(key: string): void;
  /// Drops buckets that can no longer affect a verdict. Called opportunistically
  /// on each check so a long-lived process cannot grow this map without bound
  /// from a stream of distinct keys.
  prune(): void;
  size(): number;
}

export function createAttemptLimiter(options: AttemptLimiterOptions): AttemptLimiter {
  const { maxAttempts, windowMs, lockoutMs } = options;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  function expired(bucket: Bucket, at: number): boolean {
    return at >= bucket.lockedUntil && at - bucket.windowStartedAt >= windowMs;
  }

  function prune(): void {
    const at = now();
    for (const [key, bucket] of buckets) if (expired(bucket, at)) buckets.delete(key);
  }

  /// True once a bucket stops binding: its lockout has been served, or its
  /// window has rolled over. Either way the next failure starts fresh.
  function spent(bucket: Bucket, at: number): boolean {
    if (bucket.lockedUntil > 0) return at >= bucket.lockedUntil;
    return at - bucket.windowStartedAt >= windowMs;
  }

  function verdict(bucket: Bucket | undefined, at: number): AttemptVerdict {
    if (!bucket) return { allowed: true, remaining: maxAttempts, retryAfterMs: 0 };
    if (at < bucket.lockedUntil) {
      return { allowed: false, remaining: 0, retryAfterMs: bucket.lockedUntil - at };
    }
    if (spent(bucket, at)) return { allowed: true, remaining: maxAttempts, retryAfterMs: 0 };
    return {
      allowed: true,
      remaining: Math.max(0, maxAttempts - bucket.failures),
      retryAfterMs: 0,
    };
  }

  return {
    check(key) {
      prune();
      return verdict(buckets.get(key), now());
    },

    recordFailure(key) {
      const at = now();
      const existing = buckets.get(key);

      // Already locked: the attempt was refused before any password was checked,
      // so counting it slows no attacker. Extending the lock would only move the
      // release time for whoever shares this key — which turns the defence into
      // a denial of service against the admin, since anything retrying in a loop
      // could hold the lock open indefinitely. Leave it exactly as it is.
      if (existing && at < existing.lockedUntil) return verdict(existing, at);

      const bucket: Bucket =
        !existing || spent(existing, at)
          ? { failures: 1, windowStartedAt: at, lockedUntil: 0 }
          : { ...existing, failures: existing.failures + 1 };

      if (bucket.failures >= maxAttempts) bucket.lockedUntil = at + lockoutMs;

      buckets.set(key, bucket);
      return verdict(bucket, at);
    },

    reset(key) {
      buckets.delete(key);
    },

    prune,
    size: () => buckets.size,
  };
}

/// 10 failures in 15 minutes, then locked for 15 minutes.
///
/// Chosen against the actual users: an admin mistyping a password a few times is
/// normal, ten is not, and a fifteen-minute lockout is survivable for someone
/// who genuinely forgot. Against an attacker it caps a single origin at roughly
/// 40 guesses an hour, which does not make a weak password safe — it makes a
/// strong one impractical to guess. Pick a strong one.
export const PASSWORD_ATTEMPT_POLICY = {
  maxAttempts: 10,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
} as const;
