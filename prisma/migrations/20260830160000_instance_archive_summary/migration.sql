-- The frozen half of §8's archive-and-purge. PRD decisions 94 and 95.
--
-- "Keeps aggregate statistics and deletes essays, emails, and demographics."
-- Those two clauses are in tension, and this column is how they are reconciled:
-- FR-19's demographic funnel is COMPUTED FROM Applicant.data, which the purge
-- empties. A purge that did not freeze the numbers first would destroy the very
-- statistics the same sentence says to keep, and would do it while appearing to
-- comply -- every query would still run, and every answer would be zero.
--
-- So buildArchiveSummary() renders the funnel and the stage counts into this
-- column inside the purge transaction, BEFORE anything is deleted.
--
-- JSONB rather than a table of counts, for the reason Applicant.data is JSONB:
-- the shape depends on how many demographic questions that cycle's form asked,
-- which varies cycle to cycle and cannot be a fixed set of columns. A
-- `summaryVersion` key inside it carries the shape forward.
--
-- Nullable with no default. Null means "not archived", which is also what
-- archivedAt (added in Phase 0, unused until now) means. The two are written
-- together in one transaction and neither is meaningful without the other.

ALTER TABLE "Instance" ADD COLUMN "archiveSummary" JSONB;

-- archivedAt and archiveSummary are set together or not at all.
--
-- Worth a constraint rather than a convention because the failure is silent in
-- both directions: an instance with archivedAt but no summary is one whose
-- statistics the purge destroyed, and one with a summary but no archivedAt is
-- live but carrying frozen numbers that will drift from its rows. Neither is a
-- state any code path produces today, and this is what keeps that true.
ALTER TABLE "Instance"
    ADD CONSTRAINT "Instance_archive_pair"
    CHECK (("archivedAt" IS NULL) = ("archiveSummary" IS NULL));
