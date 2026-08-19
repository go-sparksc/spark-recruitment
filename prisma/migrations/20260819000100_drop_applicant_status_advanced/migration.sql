-- PRD decision 41. ADVANCED leaves ApplicantStatus.
--
-- It meant "selected, not yet active in the next round" and nothing downstream
-- ever read it or cleared it. FR-11's finalize leaves an advanced applicant
-- ACTIVE and moves stageReached instead.
--
-- Nothing in the application has ever written it, so this is expected to be a
-- no-op over the data. The guard below says so out loud rather than relying on
-- that: the USING cast further down would fail on a stranded row anyway, but it
-- would fail with a message about a cast, which is not the thing a reader would
-- need to know. This fails with the count and the fix.
DO $$
DECLARE
  stranded integer;
BEGIN
  SELECT count(*) INTO stranded FROM "Applicant" WHERE "status" = 'ADVANCED';
  IF stranded > 0 THEN
    RAISE EXCEPTION
      'Cannot drop ApplicantStatus.ADVANCED: % applicant row(s) still hold it. '
      'Per PRD decision 41 these should be ACTIVE with stageReached = FIRST_ROUND. '
      'Move them before re-running this migration.', stranded;
  END IF;
END $$;

-- AlterEnum
BEGIN;
CREATE TYPE "ApplicantStatus_new" AS ENUM ('ACTIVE', 'REJECTED', 'SPARKLET');
ALTER TABLE "Applicant" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Applicant" ALTER COLUMN "status" TYPE "ApplicantStatus_new" USING ("status"::text::"ApplicantStatus_new");
ALTER TYPE "ApplicantStatus" RENAME TO "ApplicantStatus_old";
ALTER TYPE "ApplicantStatus_new" RENAME TO "ApplicantStatus";
DROP TYPE "ApplicantStatus_old";
ALTER TABLE "Applicant" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
COMMIT;
