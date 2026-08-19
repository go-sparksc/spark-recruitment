-- PRD decision 40. The scale's floor, so a rubric can run 1..4 rather than
-- 0..maxPoints.
--
-- DEFAULT 0 is what makes this migration change the meaning of no existing row:
-- every rubric already in the database was scored on a floor of 0, and it keeps
-- one. New rubrics opt in through FR-4's builder, which now starts at 1..4.
--
-- No backfill of Score is needed or wanted. FR-4 locks the rubric once any Score
-- exists, so changing a scale already requires the reset that discards them.

-- AlterTable
ALTER TABLE "RubricCategory" ADD COLUMN     "minPoints" INTEGER NOT NULL DEFAULT 0;
