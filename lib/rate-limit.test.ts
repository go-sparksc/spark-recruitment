import { describe, expect, it } from "vitest";

import { createAttemptLimiter } from "@/lib/rate-limit";

/// Controllable clock, so lockout expiry is tested without sleeping.
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const OPTIONS = { maxAttempts: 3, windowMs: 1000, lockoutMs: 5000 };

describe("createAttemptLimiter", () => {
  it("allows attempts until the limit is reached", () => {
    const clock = fakeClock();
    const limiter = createAttemptLimiter({ ...OPTIONS, now: clock.now });

    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 3 });
    expect(limiter.recordFailure("a")).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.recordFailure("a")).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("locks on the nth failure and reports how long to wait", () => {
    const clock = fakeClock();
    const limiter = createAttemptLimiter({ ...OPTIONS, now: clock.now });

    limiter.recordFailure("a");
    limiter.recordFailure("a");
    const third = limiter.recordFailure("a");

    expect(third).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 5000 });
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("keeps the lock for the full lockout, then releases it", () => {
    const clock = fakeClock();
    const limiter = createAttemptLimiter({ ...OPTIONS, now: clock.now });

    for (let i = 0; i < 3; i += 1) limiter.recordFailure("a");

    clock.advance(4999);
    expect(limiter.check("a")).toMatchObject({ allowed: false, retryAfterMs: 1 });

    clock.advance(1);
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 3 });
  });

  it("does not extend a lockout when a locked-out key keeps trying", () => {
    // Otherwise an attacker who keeps hammering locks the real admin out
    // indefinitely, turning the defence into the denial of service.
    const clock = fakeClock();
    const limiter = createAttemptLimiter({ ...OPTIONS, now: clock.now });

    for (let i = 0; i < 3; i += 1) limiter.recordFailure("a");
    clock.advance(2000);
    limiter.recordFailure("a");
    limiter.recordFailure("a");

    clock.advance(3000); // 5000ms after the original lock
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("rolls the window over so old failures stop counting", () => {
    const clock = fakeClock();
    const limiter = createAttemptLimiter({ ...OPTIONS, now: clock.now });

    limiter.recordFailure("a");
    limiter.recordFailure("a");
    clock.advance(1001);

    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 3 });
    expect(limiter.recordFailure("a")).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("clears the record on success", () => {
    const clock = fakeClock();
    const limiter = createAttemptLimiter({ ...OPTIONS, now: clock.now });

    limiter.recordFailure("a");
    limiter.recordFailure("a");
    limiter.reset("a");

    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 3 });
  });

  it("tracks keys independently", () => {
    const clock = fakeClock();
    const limiter = createAttemptLimiter({ ...OPTIONS, now: clock.now });

    for (let i = 0; i < 3; i += 1) limiter.recordFailure("a");

    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("prunes spent buckets so a stream of distinct keys cannot grow the map", () => {
    const clock = fakeClock();
    const limiter = createAttemptLimiter({ ...OPTIONS, now: clock.now });

    for (let i = 0; i < 50; i += 1) limiter.recordFailure(`key${i}`);
    expect(limiter.size()).toBe(50);

    clock.advance(10_000);
    limiter.check("anything");

    expect(limiter.size()).toBe(0);
  });

  it("does not prune a bucket that is still locked", () => {
    const clock = fakeClock();
    const limiter = createAttemptLimiter({ ...OPTIONS, now: clock.now });

    for (let i = 0; i < 3; i += 1) limiter.recordFailure("a");
    clock.advance(2000); // past the window, inside the lockout
    limiter.prune();

    expect(limiter.size()).toBe(1);
    expect(limiter.check("a").allowed).toBe(false);
  });
});
