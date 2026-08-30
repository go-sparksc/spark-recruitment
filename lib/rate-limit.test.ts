import { describe, expect, it } from "vitest";

import {
  bucketAfterFailure,
  isExpired,
  verdictFor,
  type AttemptBucket,
} from "@/lib/rate-limit";

// These are the Phase 1 cases, carried across Phase 8's refactor one for one.
// The module changed shape — a closure over a Map became functions over a
// record, so the state could move to Postgres per decision 92 — and the
// transitions did not. Every case below asserts the same behaviour it asserted
// before; what moved is where the bucket comes from.
//
// The clock is a plain number now rather than an injected function, because
// nothing here holds state between calls. `at` is the clock.

const POLICY = { maxAttempts: 3, windowMs: 1000, lockoutMs: 5000 };
const T0 = 1_000_000;

/// Fold a run of failures at fixed times, the way the store's caller would.
/// Returns the final bucket, so a test can go on asking about it.
function failAt(bucket: AttemptBucket | null, times: readonly number[]): AttemptBucket {
  let current = bucket;
  for (const at of times) current = bucketAfterFailure(current, POLICY, at).bucket;
  // Every input here records at least one failure, so this cannot be null.
  return current as AttemptBucket;
}

describe("verdictFor", () => {
  it("allows attempts until the limit is reached", () => {
    expect(verdictFor(null, POLICY, T0)).toMatchObject({ allowed: true, remaining: 3 });

    const one = bucketAfterFailure(null, POLICY, T0);
    expect(one.verdict).toMatchObject({ allowed: true, remaining: 2 });

    const two = bucketAfterFailure(one.bucket, POLICY, T0);
    expect(two.verdict).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("gives an untouched key the full allowance", () => {
    expect(verdictFor(null, POLICY, T0)).toEqual({
      allowed: true,
      remaining: 3,
      retryAfterMs: 0,
    });
  });
});

describe("bucketAfterFailure", () => {
  it("locks on the nth failure and reports how long to wait", () => {
    const third = bucketAfterFailure(failAt(null, [T0, T0]), POLICY, T0);

    expect(third.verdict).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 5000 });
    expect(third.justLocked).toBe(true);
    expect(verdictFor(third.bucket, POLICY, T0).allowed).toBe(false);
  });

  it("keeps the lock for the full lockout, then releases it", () => {
    const locked = failAt(null, [T0, T0, T0]);

    expect(verdictFor(locked, POLICY, T0 + 4999)).toMatchObject({
      allowed: false,
      retryAfterMs: 1,
    });
    expect(verdictFor(locked, POLICY, T0 + 5000)).toMatchObject({
      allowed: true,
      remaining: 3,
    });
  });

  it("does not extend a lockout when a locked-out key keeps trying", () => {
    // Otherwise an attacker who keeps hammering locks the real admin out
    // indefinitely, turning the defence into the denial of service.
    const locked = failAt(null, [T0, T0, T0]);
    const stillLocked = failAt(locked, [T0 + 2000, T0 + 2000]);

    // 5000ms after the ORIGINAL lock, not after the last attempt.
    expect(verdictFor(stillLocked, POLICY, T0 + 5000).allowed).toBe(true);
    expect(stillLocked.lockedUntil).toBe(T0 + 5000);
  });

  it("reports justLocked only on the transition into lockout", () => {
    // The audit row is written off this flag. If it were true on every attempt
    // while locked, a bot in a loop would write one row per request and bury
    // the lockout it was meant to make visible.
    const twoFailures = failAt(null, [T0, T0]);

    expect(bucketAfterFailure(twoFailures, POLICY, T0).justLocked).toBe(true);

    const locked = failAt(twoFailures, [T0]);
    expect(bucketAfterFailure(locked, POLICY, T0 + 1).justLocked).toBe(false);
    expect(bucketAfterFailure(locked, POLICY, T0 + 4999).justLocked).toBe(false);
  });

  it("rolls the window over so old failures stop counting", () => {
    const two = failAt(null, [T0, T0]);
    const after = T0 + 1001;

    expect(verdictFor(two, POLICY, after)).toMatchObject({ allowed: true, remaining: 3 });
    expect(bucketAfterFailure(two, POLICY, after).verdict).toMatchObject({
      allowed: true,
      remaining: 2,
    });
  });

  it("starts a fresh window rather than resuming the old one after a rollover", () => {
    const rolled = bucketAfterFailure(failAt(null, [T0, T0]), POLICY, T0 + 1001).bucket;

    expect(rolled).toEqual({ failures: 1, windowStartedAt: T0 + 1001, lockedUntil: null });
  });

  it("clears the record on success", () => {
    // Reset is a delete in the store, so the pure side of "cleared" is that a
    // null bucket carries no history.
    failAt(null, [T0, T0]);

    expect(verdictFor(null, POLICY, T0)).toMatchObject({ allowed: true, remaining: 3 });
  });

  it("tracks keys independently", () => {
    // Independence is the store's row-per-key, but the machine has to be a pure
    // function of the bucket it is handed for that to hold.
    const locked = failAt(null, [T0, T0, T0]);

    expect(verdictFor(locked, POLICY, T0).allowed).toBe(false);
    expect(verdictFor(null, POLICY, T0).allowed).toBe(true);
  });
});

describe("isExpired", () => {
  it("calls a spent bucket expired, so the store can delete it", () => {
    const locked = failAt(null, [T0, T0, T0]);

    expect(isExpired(locked, POLICY, T0 + 10_000)).toBe(true);
  });

  it("does not call a bucket that is still locked expired", () => {
    const locked = failAt(null, [T0, T0, T0]);

    // Past the window, inside the lockout.
    expect(isExpired(locked, POLICY, T0 + 2000)).toBe(false);
    expect(verdictFor(locked, POLICY, T0 + 2000).allowed).toBe(false);
  });

  it("does not call an unlocked bucket inside its window expired", () => {
    // The regression this guards: `at >= bucket.lockedUntil` with a null
    // lockedUntil coerces to `at >= 0`, which is always true, and would expire
    // every unlocked bucket the instant it was created.
    const one = failAt(null, [T0]);

    expect(one.lockedUntil).toBeNull();
    expect(isExpired(one, POLICY, T0 + 1)).toBe(false);
    expect(isExpired(one, POLICY, T0 + 1000)).toBe(true);
  });
});
