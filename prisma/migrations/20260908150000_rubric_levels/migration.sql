-- PRD decision 114. `RubricCategory.description` — one blurb for the whole
-- category — becomes one criterion per offered score value.
--
-- Hand-finished from `prisma migrate diff`, which emitted the DROP without the
-- backfill. The order below is the whole point: create, carry the prose over,
-- and only then drop the column it came from.

-- CreateTable
CREATE TABLE "RubricLevel" (
    "id" TEXT NOT NULL,
    "rubricCategoryId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "criterion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RubricLevel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- "One criterion per offered value", as a database guarantee rather than a
-- convention held in a form component.
CREATE UNIQUE INDEX "RubricLevel_rubricCategoryId_points_key" ON "RubricLevel"("rubricCategoryId", "points");

-- AddForeignKey
ALTER TABLE "RubricLevel" ADD CONSTRAINT "RubricLevel_rubricCategoryId_fkey" FOREIGN KEY ("rubricCategoryId") REFERENCES "RubricCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill, and it is a judgment call recorded as one.
--
-- Decision 32 defined `description` as "what this category is asking for, AND
-- what the top of its scale means", so the top value is where the existing prose
-- is least wrong. It is not right: an admin re-reading it should expect to
-- rewrite it rather than find it correct.
--
-- The census taken before this was written found 17 of 18 rows non-null, but 12
-- were the same four strings `prisma/seed/` regenerates and 4 were keyboard mash
-- on a walkthrough instance. Exactly one row held prose a person wrote for its
-- purpose. The rule is kept anyway, because the next cycle's admin will write
-- descriptions that are real and the migration should not be what quietly
-- decides their fate.
--
-- Whitespace-only descriptions are skipped: they carry nothing, and a blank
-- criterion would render as an empty line under a score button.
INSERT INTO "RubricLevel" ("id", "rubricCategoryId", "points", "criterion", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    "id",
    "maxPoints",
    "description",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "RubricCategory"
WHERE "description" IS NOT NULL
  AND btrim("description") <> '';

-- AlterTable
ALTER TABLE "RubricCategory" DROP COLUMN "description";
