-- Decision 108: field visibility becomes one binary flag.
--
-- Replaces the two nullable per-round columns on Field and FieldGroup with a
-- single nullable isReviewerVisible. True = visible to all three reviewer
-- rounds, false = to none, NULL = not yet chosen (FR-2 has no default, FR-3
-- blocks the commit until every eligible column has one, and NULL resolves
-- hidden meanwhile so it cannot leak).
--
-- ORDER IS LOAD-BEARING. `prisma migrate diff` generates only the ADD and the
-- two DROPs, in that order, with no backfill — running its output verbatim
-- would discard every stored visibility value. Each table therefore reads:
-- ADD, then UPDATE off the old columns, then DROP. Do not reorder.

-- 1. Add the new column, both tables, before anything reads the old ones.
ALTER TABLE "Field" ADD COLUMN "isReviewerVisible" BOOLEAN;
ALTER TABLE "FieldGroup" ADD COLUMN "isReviewerVisible" BOOLEAN;

-- 2. Backfill.
--
-- Clause order matters as much as statement order:
--
--   * DEMOGRAPHIC is tested first so §6's lock applies on draft instances too.
--   * The never-touched test sits above RESPONSE so that a draft's untouched
--     Response columns are still chosen explicitly rather than defaulted to
--     visible. A row where either old boolean was non-null was set by a person
--     and falls through to the rules below, which is what stops the no-default
--     rule from discarding work an admin had already done.
--   * A split row — the two old booleans disagreeing once §6's default is
--     applied — becomes NULL rather than a guess. "Visible to written
--     reviewers only" has no binary equivalent, and picking a direction
--     silently would either widen exposure or hide a column an admin
--     deliberately showed. The 2026-09-07 survey found zero such rows; the
--     clause is here because the next import can produce one.
--
-- Committed instances always land on a concrete value, so no instance that has
-- already committed is retroactively blocked by FR-3's new gate.
UPDATE "Field" f SET "isReviewerVisible" = CASE
  WHEN f."category" = 'DEMOGRAPHIC' THEN false
  WHEN i."importCommittedAt" IS NULL
   AND f."visibleToWrittenReviewer" IS NULL
   AND f."visibleToFirstRoundReviewer" IS NULL THEN NULL
  WHEN f."category" = 'RESPONSE' THEN true
  WHEN COALESCE(f."visibleToWrittenReviewer", false)
     <> COALESCE(f."visibleToFirstRoundReviewer", false) THEN NULL
  ELSE COALESCE(f."visibleToWrittenReviewer", false)
END
FROM "Instance" i
WHERE i."id" = f."instanceId";

UPDATE "FieldGroup" g SET "isReviewerVisible" = CASE
  WHEN g."category" = 'DEMOGRAPHIC' THEN false
  WHEN i."importCommittedAt" IS NULL
   AND g."visibleToWrittenReviewer" IS NULL
   AND g."visibleToFirstRoundReviewer" IS NULL THEN NULL
  WHEN g."category" = 'RESPONSE' THEN true
  WHEN COALESCE(g."visibleToWrittenReviewer", false)
     <> COALESCE(g."visibleToFirstRoundReviewer", false) THEN NULL
  ELSE COALESCE(g."visibleToWrittenReviewer", false)
END
FROM "Instance" i
WHERE i."id" = g."instanceId";

-- 3. Only now are the old columns unreachable.
ALTER TABLE "Field" DROP COLUMN "visibleToWrittenReviewer";
ALTER TABLE "Field" DROP COLUMN "visibleToFirstRoundReviewer";
ALTER TABLE "FieldGroup" DROP COLUMN "visibleToWrittenReviewer";
ALTER TABLE "FieldGroup" DROP COLUMN "visibleToFirstRoundReviewer";
