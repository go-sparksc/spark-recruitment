import "dotenv/config";

// Does the shared rate-limit store actually hold under concurrency? PRD decision 92.
//
// Run with:  npm run check:rate-limit
//        or  npx tsx --conditions=react-server prisma/checks/rate-limit.ts
//
// The `--conditions=react-server` flag is not optional. lib/rate-limit-store.ts
// carries `import "server-only"`, which throws outside a React Server Component;
// the flag resolves that package to its empty build. Re-implementing the store's
// queries here would verify a second copy of the code under test, which is not a
// test — the same reasoning prisma/checks/round-trip.ts records.
//
// **The first case is the only reason this file exists.** Everything else here
// is also covered by lib/rate-limit.test.ts against the pure machine; the
// concurrency property cannot be, because it is a property of the row lock
// rather than of the transitions. An in-process Map passed every unit test in
// Phase 1 and still gave an attacker the full allowance per serverless instance
// — decision 19's first bullet. This is the case that would have caught it.
//
// Everything this script creates, it deletes, and it verifies that it did. It
// touches no instance and no seed data: every key is prefixed and the AuditLog
// rows it produces are found by that prefix.

import {
  isExpired,
  type AttemptBucket,
  type AttemptLimiterPolicy,
} from "../../lib/rate-limit";
import { checkKey, pruneSpent, recordFailure, resetKey } from "../../lib/rate-limit-store";
import { createSeedClient } from "../seed/client";

const prisma = createSeedClient();

/// Every key this script writes starts here, so cleanup can find them all and
/// nothing it does can collide with a real bucket.
const P = "check-rate-limit:";

/// Deliberately roomier than PASSWORD_ATTEMPT_POLICY so the concurrency case can
/// fire many failures without tripping a lockout partway and changing what is
/// being measured.
const ROOMY: AttemptLimiterPolicy = { maxAttempts: 100, windowMs: 60_000, lockoutMs: 60_000 };

/// Small, for the lockout cases.
const TIGHT: AttemptLimiterPolicy = { maxAttempts: 3, windowMs: 1_000, lockoutMs: 5_000 };

const CONCURRENT_FAILURES = 12;

let failures = 0;

function pass(label: string, detail: string) {
  console.log(`PASS  ${label}\n        ${detail}`);
}

function fail(label: string, detail: string) {
  failures += 1;
  console.log(`FAIL  ${label}\n        ${detail}`);
}

function bucketOf(row: {
  failures: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
}): AttemptBucket {
  return {
    failures: row.failures,
    windowStartedAt: row.windowStartedAt.getTime(),
    lockedUntil: row.lockedUntil?.getTime() ?? null,
  };
}

async function readBucket(key: string) {
  return prisma.rateLimitBucket.findUnique({ where: { key } });
}

async function lockoutRows(key: string) {
  return prisma.auditLog.findMany({
    where: { action: "RATE_LIMIT_LOCKOUT", entityId: key },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------

/// The case the in-process limiter could never pass.
async function checkConcurrentFailuresAllCount() {
  const key = `${P}concurrent`;
  await resetKey(key);

  // Fired together, not awaited in sequence. Without the row lock these
  // interleave: several transactions read the same `failures` and write the same
  // incremented value, and the count lands below CONCURRENT_FAILURES.
  await Promise.all(
    Array.from({ length: CONCURRENT_FAILURES }, () => recordFailure(key, null, ROOMY)),
  );

  const row = await readBucket(key);

  if (!row) {
    fail("concurrent failures all count", "no bucket row was written at all");
    return;
  }

  if (row.failures === CONCURRENT_FAILURES) {
    pass(
      "concurrent failures all count",
      `${CONCURRENT_FAILURES} simultaneous failures recorded ${row.failures} — no attempt was lost to a lost update`,
    );
  } else {
    fail(
      "concurrent failures all count",
      `${CONCURRENT_FAILURES} simultaneous failures recorded only ${row.failures}. ` +
        `${CONCURRENT_FAILURES - row.failures} free guess(es) per burst — the row lock is not holding.`,
    );
  }
}

/// A locked key is refused, and the refusal costs no password check.
async function checkLockedKeyIsRefused() {
  const key = `${P}lockout`;
  await resetKey(key);

  let lockedOn = 0;
  for (let i = 1; i <= TIGHT.maxAttempts; i += 1) {
    const result = await recordFailure(key, null, TIGHT);
    if (result.justLocked) lockedOn = i;
  }

  const verdict = await checkKey(key, TIGHT);

  if (lockedOn !== TIGHT.maxAttempts) {
    fail("locked key is refused", `justLocked fired on attempt ${lockedOn}, expected ${TIGHT.maxAttempts}`);
  } else if (verdict.allowed) {
    fail("locked key is refused", "checkKey still allows the key after it locked");
  } else {
    pass(
      "locked key is refused",
      `locked on attempt ${lockedOn}; checkKey now refuses with ${verdict.retryAfterMs}ms to wait`,
    );
  }
}

/// Exactly one audit row per lockout, not one per attempt while locked.
async function checkLockoutIsLoggedOnce() {
  const key = `${P}lockout`; // reuses the bucket the previous case locked

  const before = await lockoutRows(key);

  // Keep hammering. Each of these is refused before any password check, and none
  // of them is a new lockout.
  for (let i = 0; i < 5; i += 1) await recordFailure(key, null, TIGHT);

  const after = await lockoutRows(key);

  if (before.length === 1 && after.length === 1) {
    const payload = after[0].previousValue as { failures?: number; lockoutCount?: number } | null;
    pass(
      "lockout is logged exactly once",
      `one RATE_LIMIT_LOCKOUT row after 5 further attempts; actor=${after[0].actor}, ` +
        `instanceId=${after[0].instanceId}, payload=${JSON.stringify(payload)}`,
    );
  } else {
    fail(
      "lockout is logged exactly once",
      `expected 1 row before and after, saw ${before.length} then ${after.length}. ` +
        `A row per attempt buries the lockout it exists to make visible.`,
    );
  }
}

/// Hammering a locked key does not move its release time.
async function checkLockIsNotExtended() {
  const key = `${P}no-extend`;
  await resetKey(key);

  for (let i = 0; i < TIGHT.maxAttempts; i += 1) await recordFailure(key, null, TIGHT);

  const locked = await readBucket(key);
  const originalRelease = locked?.lockedUntil?.getTime() ?? 0;

  for (let i = 0; i < 4; i += 1) await recordFailure(key, null, TIGHT);

  const after = await readBucket(key);
  const releaseNow = after?.lockedUntil?.getTime() ?? 0;

  if (originalRelease !== 0 && releaseNow === originalRelease) {
    pass(
      "a locked key's lockout is not extended",
      `release time unchanged across 4 further attempts (${new Date(originalRelease).toISOString()})`,
    );
  } else {
    fail(
      "a locked key's lockout is not extended",
      `release moved from ${originalRelease} to ${releaseNow}. Anything retrying in a loop ` +
        `could then hold the lock open against the real admin.`,
    );
  }
}

/// The lockout row for an instance-scoped gate carries that instance.
async function checkInstanceScopedLockoutCarriesTheInstance() {
  const key = `${P}scoped`;
  await resetKey(key);

  const instance = await prisma.instance.findFirst({ select: { id: true } });
  if (!instance) {
    fail("instance-scoped lockout carries its instance", "no instance in the database to scope to");
    return;
  }

  for (let i = 0; i < TIGHT.maxAttempts; i += 1) {
    await recordFailure(key, instance.id, TIGHT);
  }

  const rows = await lockoutRows(key);

  if (rows.length === 1 && rows[0].instanceId === instance.id) {
    pass(
      "instance-scoped lockout carries its instance",
      `row written with instanceId=${instance.id}, so it appears in that instance's audit view and export`,
    );
  } else {
    fail(
      "instance-scoped lockout carries its instance",
      `expected 1 row on ${instance.id}, saw ${rows.length} with instanceId=${rows[0]?.instanceId}`,
    );
  }
}

/// resetKey clears the record, so a correct password starts clean.
async function checkResetClearsTheRecord() {
  const key = `${P}reset`;
  await resetKey(key);

  await recordFailure(key, null, TIGHT);
  await recordFailure(key, null, TIGHT);
  await resetKey(key);

  const row = await readBucket(key);
  const verdict = await checkKey(key, TIGHT);

  if (!row && verdict.allowed && verdict.remaining === TIGHT.maxAttempts) {
    pass("reset clears the record", `bucket gone, allowance back to ${verdict.remaining}`);
  } else {
    fail(
      "reset clears the record",
      `row=${row ? "still present" : "gone"}, remaining=${verdict.remaining}`,
    );
  }
}

/// pruneSpent drops what can no longer bind, keeps what can, and agrees with the
/// pure `isExpired` over the rows actually in the table.
///
/// This is the one place two copies of "spent" exist — `isExpired` in TypeScript
/// and the where-clause in pruneSpent — so it is the one place they can drift.
async function checkPruneMatchesIsExpired() {
  const spentKey = `${P}prune-spent`;
  const liveKey = `${P}prune-live`;
  const lockedKey = `${P}prune-locked`;

  const now = new Date();
  const longAgo = new Date(now.getTime() - 10 * TIGHT.windowMs);

  await prisma.rateLimitBucket.deleteMany({
    where: { key: { in: [spentKey, liveKey, lockedKey] } },
  });

  await prisma.rateLimitBucket.createMany({
    data: [
      // Window rolled over, never locked: expired.
      { key: spentKey, failures: 2, windowStartedAt: longAgo, lockedUntil: null },
      // Window still open: not expired.
      { key: liveKey, failures: 1, windowStartedAt: now, lockedUntil: null },
      // Window rolled over but still locked: NOT expired, and the case a
      // one-sided predicate gets wrong — deleting it would release the lock early.
      {
        key: lockedKey,
        failures: 3,
        windowStartedAt: longAgo,
        lockedUntil: new Date(now.getTime() + TIGHT.lockoutMs),
      },
    ],
  });

  const before = await prisma.rateLimitBucket.findMany({
    where: { key: { in: [spentKey, liveKey, lockedKey] } },
  });
  const expectedGone = before
    .filter((row) => isExpired(bucketOf(row), TIGHT, now.getTime()))
    .map((row) => row.key)
    .sort();

  await pruneSpent(TIGHT, now);

  const remaining = await prisma.rateLimitBucket.findMany({
    where: { key: { in: [spentKey, liveKey, lockedKey] } },
    select: { key: true },
  });
  const actuallyGone = [spentKey, liveKey, lockedKey]
    .filter((key) => !remaining.some((row) => row.key === key))
    .sort();

  if (JSON.stringify(expectedGone) === JSON.stringify(actuallyGone)) {
    pass(
      "prune agrees with isExpired",
      `both say ${JSON.stringify(actuallyGone)} is spent; the locked-but-stale bucket survived`,
    );
  } else {
    fail(
      "prune agrees with isExpired",
      `isExpired says ${JSON.stringify(expectedGone)} should go, pruneSpent removed ` +
        `${JSON.stringify(actuallyGone)}. The SQL predicate and the pure one have drifted.`,
    );
  }
}

// ---------------------------------------------------------------------------

async function cleanup() {
  await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: P } } });
  await prisma.auditLog.deleteMany({
    where: { action: "RATE_LIMIT_LOCKOUT", entityId: { startsWith: P } },
  });
}

async function confirmRestored() {
  const buckets = await prisma.rateLimitBucket.count({ where: { key: { startsWith: P } } });
  const rows = await prisma.auditLog.count({
    where: { action: "RATE_LIMIT_LOCKOUT", entityId: { startsWith: P } },
  });

  if (buckets === 0 && rows === 0) {
    console.log("Cleanup     verified — no probe rows remain");
  } else {
    failures += 1;
    console.log(`Cleanup     FAILED — ${buckets} bucket(s) and ${rows} audit row(s) remain`);
  }
}

async function main() {
  console.log(`Policy      roomy ${JSON.stringify(ROOMY)}`);
  console.log(`            tight ${JSON.stringify(TIGHT)}`);
  console.log("");

  await checkConcurrentFailuresAllCount();
  await checkLockedKeyIsRefused();
  await checkLockoutIsLoggedOnce();
  await checkLockIsNotExtended();
  await checkInstanceScopedLockoutCarriesTheInstance();
  await checkResetClearsTheRecord();
  await checkPruneMatchesIsExpired();
}

main()
  .catch((error) => {
    failures += 1;
    console.error("\nUnexpected error:", error);
  })
  .finally(async () => {
    // Cleanup runs even if main() threw partway through, so a crash cannot leave
    // probe buckets or probe audit rows behind.
    try {
      await cleanup();
      await confirmRestored();
    } catch (error) {
      failures += 1;
      console.error("Cleanup itself failed:", error);
    }

    console.log("");
    console.log(failures === 0 ? "RESULT: all checks passed" : `RESULT: ${failures} check(s) failed`);

    process.exitCode = failures === 0 ? 0 : 1;
    await prisma.$disconnect();
  });
