import "server-only";

// The Prisma half of §8's attempt limiter. PRD decision 92.
//
// lib/rate-limit.ts holds the state machine and is pure. This module holds the
// row, the lock, and the clock — the same split as lib/export.ts /
// lib/instance-io.ts, and for the same reason: what counts as a locked key has
// to be decidable without a database in front of it.
//
// **Why a lock and not an UPDATE ... SET failures = failures + 1.** The
// increment is not the interesting part; the transition is. Whether a failure
// starts a fresh window, extends the current one, or trips the lockout depends
// on the bucket's current state, and that decision lives in TypeScript. So the
// row is locked, read, handed to the machine, and written back. Two simultaneous
// failures that both read `failures = 3` and both write `4` would hand an
// attacker a free guess per concurrent request — a shared store that lost that
// race would be a slower version of the hole it was built to close.
//
// prisma/checks/rate-limit.ts asserts that property against a real database,
// because no unit test can reach it.

import { SYSTEM_ACTOR } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  bucketAfterFailure,
  verdictFor,
  type AttemptBucket,
  type AttemptLimiterPolicy,
  type AttemptVerdict,
} from "@/lib/rate-limit";

/// The shape the raw insert returns. Prisma maps `TIMESTAMP(3)` to `Date` and
/// `INTEGER` to `number`.
interface BucketRow {
  failures: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
  lockoutCount: number;
}

function toBucket(row: BucketRow): AttemptBucket {
  return {
    failures: row.failures,
    windowStartedAt: row.windowStartedAt.getTime(),
    lockedUntil: row.lockedUntil?.getTime() ?? null,
  };
}

/// Whether a caller holding this key may attempt a password right now.
///
/// Deliberately an unlocked read. A check that raced with a concurrent failure
/// could let one extra attempt through, which costs an attacker one guess out of
/// ten; taking a write lock every time a gate is consulted would cost every
/// honest caller a round trip. The lock is on `recordFailure`, where the count is
/// actually decided.
export async function checkKey(
  key: string,
  policy: AttemptLimiterPolicy,
  now = new Date(),
): Promise<AttemptVerdict> {
  const row = await prisma.rateLimitBucket.findUnique({
    where: { key },
    select: { failures: true, windowStartedAt: true, lockedUntil: true, lockoutCount: true },
  });

  return verdictFor(row ? toBucket(row) : null, policy, now.getTime());
}

export interface FailureRecord {
  verdict: AttemptVerdict;
  /// True only on the transition into lockout.
  justLocked: boolean;
  /// Lifetime lockouts for this key, after this failure.
  lockoutCount: number;
}

/// Fold one failed attempt into a key, under a row lock, and log the lockout if
/// this is the attempt that trips it.
///
/// `instanceId` is the instance whose gate this is, or null for the app-level
/// password — which has no instance, so its lockout row is orphaned by design
/// and sits outside every export. Decision 92 states that gap rather than hiding
/// it.
export async function recordFailure(
  key: string,
  instanceId: string | null,
  policy: AttemptLimiterPolicy,
  now = new Date(),
): Promise<FailureRecord> {
  const at = now.getTime();

  return prisma.$transaction(async (tx) => {
    // One statement that both creates the row and locks it.
    //
    // The insert values are the state a first failure produces, so the common
    // create path needs no second write. On conflict the DO UPDATE is a
    // self-assignment: it changes nothing and exists solely to take the row
    // lock, which `DO NOTHING` would not do — and which would also return no
    // row, leaving nothing to read. `xmax = 0` is the standard way to ask which
    // path ran; it is zero only for a tuple this transaction inserted.
    const [row] = await tx.$queryRaw<(BucketRow & { inserted: boolean })[]>`
      INSERT INTO "RateLimitBucket"
        ("key", "failures", "windowStartedAt", "lockedUntil", "lockoutCount", "updatedAt")
      VALUES (${key}, 1, ${now}, NULL, 0, ${now})
      ON CONFLICT ("key") DO UPDATE SET "key" = "RateLimitBucket"."key"
      RETURNING "failures", "windowStartedAt", "lockedUntil", "lockoutCount", (xmax = 0) AS "inserted"
    `;

    // On the insert path the key had no history, so the machine is asked what a
    // first failure means rather than being handed the row we just wrote. That
    // distinction matters only when a single failure locks (maxAttempts <= 1),
    // which this application's policy never sets — but reading the inserted row
    // back as "existing state" would silently double-count it if it ever did.
    const existing = row.inserted ? null : toBucket(row);
    const outcome = bucketAfterFailure(existing, policy, at);
    const lockoutCount = (row.inserted ? 0 : row.lockoutCount) + (outcome.justLocked ? 1 : 0);

    // The insert already persisted the first-failure state. Write again only if
    // this is not that case, or if the machine produced something the insert did
    // not — a lockout on the very first failure being the only such case.
    if (!row.inserted || outcome.justLocked) {
      await tx.rateLimitBucket.update({
        where: { key },
        data: {
          failures: outcome.bucket.failures,
          windowStartedAt: new Date(outcome.bucket.windowStartedAt),
          lockedUntil:
            outcome.bucket.lockedUntil === null ? null : new Date(outcome.bucket.lockedUntil),
          lockoutCount,
        },
      });
    }

    // Inside the same transaction as the lockout it describes, so the row and
    // the log can never disagree about whether a key locked.
    if (outcome.justLocked) {
      await tx.auditLog.create({
        data: {
          instanceId,
          // Nobody did this; the limiter did. actorName stays null, which means
          // something different from a person whose name went unrecorded.
          ...SYSTEM_ACTOR,
          action: "RATE_LIMIT_LOCKOUT",
          entityType: "RateLimitBucket",
          entityId: key,
          // Counts only. The key already carries the client address, and nothing
          // here should add anything a retention pass would then have to strip.
          previousValue: { failures: outcome.bucket.failures, lockoutCount },
        },
      });
    }

    return { verdict: outcome.verdict, justLocked: outcome.justLocked, lockoutCount };
  });
}

/// Clear a key's record. Called on a correct password, so an admin who mistyped
/// four times and then succeeded starts clean.
export async function resetKey(key: string): Promise<void> {
  // deleteMany rather than delete: the row usually does not exist, since nobody
  // who signs in first try has one, and `delete` throws P2025 on exactly that
  // happy path.
  await prisma.rateLimitBucket.deleteMany({ where: { key } });
}

/// Drop buckets that can no longer affect a verdict — both halves of
/// `isExpired`: the lockout served or never set, AND the window rolled over.
///
/// Runs opportunistically on each successful **admin** sign-in, and inside the
/// archive purge, rather than on a schedule. At the scale §8 describes this
/// table holds a handful of rows, and a cron job would be infrastructure to
/// maintain for something that cleans itself whenever anyone logs in.
///
/// Deliberately not on the reviewer gate: thirty reviewers sign in within a few
/// minutes of the access code reaching Slack, and putting a table-wide
/// `deleteMany` on that path would spend the one busy moment in the cycle
/// tidying rows nobody is reading.
///
/// This predicate is `isExpired` expressed as a query. That is a second copy,
/// and prisma/checks/rate-limit.ts is where the two are held to each other over
/// real rows. Returns the number removed.
export async function pruneSpent(
  policy: AttemptLimiterPolicy,
  now = new Date(),
): Promise<number> {
  const { count } = await prisma.rateLimitBucket.deleteMany({
    where: {
      windowStartedAt: { lte: new Date(now.getTime() - policy.windowMs) },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    },
  });

  return count;
}
