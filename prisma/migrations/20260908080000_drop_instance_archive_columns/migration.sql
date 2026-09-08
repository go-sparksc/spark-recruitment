-- Archive-and-purge is removed. PRD decision 109, reversing decisions 94 and 95.
--
-- §8 required an admin-triggered "archive and purge" that froze a cycle's
-- aggregate statistics and destroyed its essays, emails and demographics past a
-- threshold. That requirement is withdrawn: Spark SC already retains all of this
-- data indefinitely in Drive, Sheets and Typeform, so purging the copy here
-- reduced no standing exposure while destroying cycle detail the club wants to
-- keep. FR-5's manual instance deletion is untouched and is now the only way to
-- remove a cycle.
--
-- Both columns are dropped because nothing reads or writes them any more. They
-- are not left dormant on purpose: archivedAt already spent Phase 0 through
-- Phase 8 as a column nothing wrote, and that is the state this avoids
-- repeating.
--
-- SAFE BECAUSE NO CYCLE WAS EVER ARCHIVED. Verified immediately before writing
-- this, against the development database:
--
--     SELECT id, name, "archivedAt" FROM "Instance" WHERE "archivedAt" IS NOT NULL;
--     -> 0 rows
--
-- That query is the gate, and it must be re-run against any other database this
-- is applied to. A non-empty result means a real cycle was purged, and
-- archiveSummary is then the ONLY surviving record of that cycle's demographics
-- -- the purge emptied Applicant.data, which is what the funnel is computed
-- from. Dropping it there destroys statistics that cannot be recomputed. Stop
-- and export first.

-- Dropped explicitly, ahead of the columns it spans. Postgres would cascade it
-- with either column anyway; naming it keeps the migration readable and does not
-- depend on that behaviour. `prisma migrate diff` cannot generate this line --
-- the constraint was hand-written in 20260830160000_instance_archive_summary and
-- has never been in schema.prisma.
ALTER TABLE "Instance" DROP CONSTRAINT IF EXISTS "Instance_archive_pair";

-- AlterTable
ALTER TABLE "Instance" DROP COLUMN "archiveSummary",
DROP COLUMN "archivedAt";
