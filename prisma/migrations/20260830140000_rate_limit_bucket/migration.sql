-- The shared rate-limit store for §8's password gates. PRD decision 92.
--
-- Phase 1 shipped an in-process Map and decision 19 recorded what it did not
-- cover. The first item on that list is why this table exists: state in the
-- process resets on every deploy, and on a serverless host each instance keeps
-- its own copy -- so an attacker whose requests land on different instances gets
-- the full allowance from each. One row per key in Postgres is what makes the
-- limit real.
--
-- The ONLY table in this schema that belongs to no instance. It carries no
-- instanceId, is keyed by client address, and belongs to the deployment rather
-- than to any cycle, which is why lib/export.ts names it in NON_INSTANCE_TABLES
-- (decision 96) instead of adding it to FR-20's export.
--
-- No state machine lives here. lib/rate-limit.ts decides every transition and
-- lib/rate-limit-store.ts locks the row and writes back what it returns.
-- Expressing "is this bucket spent?" a second time in a CASE expression is a
-- place the two copies can come to disagree about when a key resets.

CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "lockoutCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- Pruning scans for spent buckets on the two timestamps, never by key -- the
-- primary key serves every lookup, and this serves the only other query.
CREATE INDEX "RateLimitBucket_lockedUntil_windowStartedAt_idx"
    ON "RateLimitBucket"("lockedUntil", "windowStartedAt");

-- A bucket exists because a failure was recorded against it, so a row claiming
-- zero failures is not a state the machine can produce. bucketAfterFailure()
-- returns 1 for a fresh or rolled-over key and never decrements.
--
-- Written as a constraint rather than trusted to the application for the reason
-- every other CHECK in this schema is: the seed, the checks, and any future
-- maintenance script write through raw SQL, and none of them go through the
-- TypeScript that maintains the invariant.
ALTER TABLE "RateLimitBucket"
    ADD CONSTRAINT "RateLimitBucket_failures_positive" CHECK ("failures" >= 1);

-- lockoutCount is a lifetime tally for whoever reads this table during an
-- incident. It only ever increments, and only on the transition into lockout.
ALTER TABLE "RateLimitBucket"
    ADD CONSTRAINT "RateLimitBucket_lockoutCount_nonnegative" CHECK ("lockoutCount" >= 0);
