-- Rename Pass_one_open_per_instance -> Pass_instanceId_statusOpen_key.
--
-- Same index, same predicate, conventional name. Every other index in this
-- schema reads Table_columns_key, and the partial-index precedent this one
-- follows -- Field_instanceId_emailPromotion_key -- names the indexed column and
-- then what the predicate selects. This now does the same: instanceId, and the
-- OPEN half of status. The original name described the rule in prose instead,
-- which reads well in a plan and badly in \d output next to twenty siblings.
--
-- A NEW migration rather than an edit to 20260824000000_pass_one_open, which is
-- already applied. Prisma stores a checksum of each migration.sql in
-- _prisma_migrations; editing an applied file makes `migrate deploy` fail with a
-- modified-migration error on every machine that has already run it, including
-- the one that ran it an hour ago.
--
-- DROP + CREATE rather than ALTER INDEX ... RENAME TO. The rename is one
-- statement and would avoid rebuilding, but spelling the index out in full is
-- what leaves the predicate legible here rather than only in a file two
-- migrations back. Prisma wraps each migration in a transaction, so there is no
-- window in which the constraint is absent, and on single-digit Pass rows the
-- rebuild costs nothing.

DROP INDEX "Pass_one_open_per_instance";

CREATE UNIQUE INDEX "Pass_instanceId_statusOpen_key"
    ON "Pass"("instanceId") WHERE "status" = 'OPEN';
