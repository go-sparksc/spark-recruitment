-- Phase 5, Slice 1. FR-12a, FR-12 and FR-13's tables.
--
-- Five things land here:
--
--   InterviewCategory       FR-12a's interview rubric. Deliberately NOT
--                           RubricCategory: different instrument, different
--                           categories, different lock condition. See PRD
--                           decision 54.
--   InterviewCategoryScore  One row per category per result, which is what
--                           settles PRD open decision 6 — the S26 `1R Scores`
--                           sheet carries a score per category plus an average,
--                           not the single number Phase 0 modelled.
--   InterviewImport         Per-sheet staging header, carrying the file's
--                           headers and the admin's column mapping.
--   InterviewImportRow      Per-row staging, with FR-13's match columns.
--   InterviewResult's new UNIQUE (applicantId, interviewerName), which is what
--                           makes a re-committed scores sheet an upsert rather
--                           than a duplicate. PRD decision 47.
--
-- Hand-finished for the three CHECK constraints at the bottom, which Prisma
-- cannot express. They are asserted by prisma/checks/interview-import.ts, the
-- only thing in the repo that will notice if a later migration drops them.

-- CreateEnum
CREATE TYPE "ImportSheet" AS ENUM ('SCORES', 'NOTES');

-- CreateEnum
CREATE TYPE "MatchTier" AS ENUM ('EMAIL', 'NAME', 'FUZZY', 'MANUAL');

-- CreateTable
CREATE TABLE "InterviewCategory" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxPoints" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewCategoryScore" (
    "id" TEXT NOT NULL,
    "interviewResultId" TEXT NOT NULL,
    "interviewCategoryId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewCategoryScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewImport" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "sheet" "ImportSheet" NOT NULL,
    "headers" JSONB NOT NULL,
    "mapping" JSONB NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewImportRow" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "sheet" "ImportSheet" NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "cells" JSONB NOT NULL,
    "matchedApplicantId" TEXT,
    "matchTier" "MatchTier",
    "matchConfidence" DOUBLE PRECISION,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InterviewCategory_instanceId_ordinal_key" ON "InterviewCategory"("instanceId", "ordinal");

-- CreateIndex
CREATE INDEX "InterviewCategoryScore_interviewCategoryId_idx" ON "InterviewCategoryScore"("interviewCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewCategoryScore_interviewResultId_interviewCategoryI_key" ON "InterviewCategoryScore"("interviewResultId", "interviewCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewImport_instanceId_sheet_key" ON "InterviewImport"("instanceId", "sheet");

-- CreateIndex
CREATE INDEX "InterviewImportRow_importId_rowIndex_idx" ON "InterviewImportRow"("importId", "rowIndex");

-- CreateIndex
CREATE INDEX "InterviewImportRow_matchedApplicantId_idx" ON "InterviewImportRow"("matchedApplicantId");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewImportRow_instanceId_sheet_rowIndex_key" ON "InterviewImportRow"("instanceId", "sheet", "rowIndex");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewResult_applicantId_interviewerName_key" ON "InterviewResult"("applicantId", "interviewerName");

-- AddForeignKey
ALTER TABLE "InterviewCategory" ADD CONSTRAINT "InterviewCategory_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewCategoryScore" ADD CONSTRAINT "InterviewCategoryScore_interviewResultId_fkey" FOREIGN KEY ("interviewResultId") REFERENCES "InterviewResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewCategoryScore" ADD CONSTRAINT "InterviewCategoryScore_interviewCategoryId_fkey" FOREIGN KEY ("interviewCategoryId") REFERENCES "InterviewCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewImport" ADD CONSTRAINT "InterviewImport_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewImportRow" ADD CONSTRAINT "InterviewImportRow_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewImportRow" ADD CONSTRAINT "InterviewImportRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "InterviewImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewImportRow" ADD CONSTRAINT "InterviewImportRow_matchedApplicantId_fkey" FOREIGN KEY ("matchedApplicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECK constraints. Hand-written; Prisma has no syntax for these.
-- ---------------------------------------------------------------------------

-- A row is resolved or it is not. Half-resolved is not a state: a row pointing
-- at an applicant with no tier cannot say who or what decided that, and a tier
-- with no applicant is a match to nobody.
--
-- This is also why matchedApplicantId cascades rather than SET NULL — SET NULL
-- would clear one side and leave the other, raising this CHECK at a moment
-- unrelated to the delete that caused it.
ALTER TABLE "InterviewImportRow" ADD CONSTRAINT "InterviewImportRow_matchTier_iff_matchedApplicant"
    CHECK (("matchedApplicantId" IS NULL) = ("matchTier" IS NULL));

-- PRD section 5: matchConfidence is "set only when matchTier = FUZZY".
--
-- Both directions matter. A confidence sitting beside an EMAIL match reads as
-- meaningful and is not; a FUZZY match without one hides the number PRD
-- decision 53 requires an admin to see before ticking the row.
--
-- IS DISTINCT FROM rather than =, so a NULL matchTier compares false instead of
-- yielding NULL. A CHECK that evaluates to NULL PASSES in Postgres, which would
-- make an unresolved row carrying a stray confidence legal.
ALTER TABLE "InterviewImportRow" ADD CONSTRAINT "InterviewImportRow_confidence_iff_fuzzy"
    CHECK (("matchTier" IS NOT DISTINCT FROM 'FUZZY'::"MatchTier") = ("matchConfidence" IS NOT NULL));

-- PRD decision 51. "This row matches nobody in the pool" and "this row matches
-- her" are contradictory answers to the same question, and commit reads both.
ALTER TABLE "InterviewImportRow" ADD CONSTRAINT "InterviewImportRow_skipped_is_not_matched"
    CHECK (NOT ("skipped" AND "matchedApplicantId" IS NOT NULL));
