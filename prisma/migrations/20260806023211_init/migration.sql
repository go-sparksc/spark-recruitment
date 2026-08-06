-- CreateEnum
CREATE TYPE "InstanceStage" AS ENUM ('WRITTEN', 'FIRST_ROUND', 'SECOND_ROUND', 'COMPLETE');

-- CreateEnum
CREATE TYPE "Round" AS ENUM ('WRITTEN', 'FIRST_ROUND', 'SECOND_ROUND');

-- CreateEnum
CREATE TYPE "FieldCategory" AS ENUM ('DEMOGRAPHIC', 'RESPONSE', 'OTHER');

-- CreateEnum
CREATE TYPE "ApplicantStatus" AS ENUM ('ACTIVE', 'ADVANCED', 'REJECTED', 'SPARKLET');

-- CreateEnum
CREATE TYPE "AssignmentOrigin" AS ENUM ('AUTO', 'MANUAL', 'CLAIMED_FROM_POOL');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ACTIVE', 'RETURNED_TO_POOL');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('CONFLICT_OF_INTEREST', 'OTHER');

-- CreateEnum
CREATE TYPE "VoteValue" AS ENUM ('YES', 'NO', 'SKIP');

-- CreateEnum
CREATE TYPE "PassStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PassResolution" AS ENUM ('SPARKLET', 'REJECTED', 'CARRIED', 'NEEDS_ADMIN');

-- CreateEnum
CREATE TYPE "DecisionOutcome" AS ENUM ('ADVANCE', 'REJECT', 'SPARKLET');

-- CreateEnum
CREATE TYPE "DecisionActor" AS ENUM ('SYSTEM', 'ADMIN');

-- CreateTable
CREATE TABLE "Instance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "currentStage" "InstanceStage" NOT NULL DEFAULT 'WRITTEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Field" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "sourceHeader" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "category" "FieldCategory" NOT NULL,
    "groupKey" TEXT,
    "isMultiSelect" BOOLEAN NOT NULL DEFAULT false,
    "ordinal" INTEGER NOT NULL,
    "isIncluded" BOOLEAN NOT NULL DEFAULT true,
    "visibleToWrittenReviewer" BOOLEAN,
    "visibleToFirstRoundReviewer" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RubricCategory" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxPoints" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RubricCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundAccessCode" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "round" "Round" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoundAccessCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Applicant" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "sourceRowIndex" INTEGER NOT NULL,
    "email" TEXT,
    "displayName" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "status" "ApplicantStatus" NOT NULL DEFAULT 'ACTIVE',
    "stageReached" "Round" NOT NULL DEFAULT 'WRITTEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Applicant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reviewer" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "isSparklet" BOOLEAN NOT NULL DEFAULT false,
    "rounds" "Round"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "round" "Round" NOT NULL,
    "applicantId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "origin" "AssignmentOrigin" NOT NULL DEFAULT 'AUTO',
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "returnReason" "ReturnReason",
    "returnNote" TEXT,
    "returnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Score" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "rubricCategoryId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewNote" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewResult" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "interviewerName" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewNotes" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "interviewerName" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewNotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FirstRoundVote" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "value" "VoteValue" NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FirstRoundVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConflictOfInterest" (
    "id" TEXT NOT NULL,
    "round" "Round" NOT NULL,
    "applicantId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConflictOfInterest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pass" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" "PassStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Pass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PassApplicant" (
    "id" TEXT NOT NULL,
    "passId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "resolution" "PassResolution",
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PassApplicant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PassVote" (
    "id" TEXT NOT NULL,
    "passId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "value" "VoteValue" NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PassVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "stage" "Round" NOT NULL,
    "outcome" "DecisionOutcome" NOT NULL,
    "actor" "DecisionActor" NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "previousValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Field_instanceId_category_idx" ON "Field"("instanceId", "category");

-- CreateIndex
CREATE INDEX "Field_instanceId_groupKey_idx" ON "Field"("instanceId", "groupKey");

-- CreateIndex
CREATE UNIQUE INDEX "Field_instanceId_ordinal_key" ON "Field"("instanceId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "RubricCategory_instanceId_ordinal_key" ON "RubricCategory"("instanceId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "RoundAccessCode_instanceId_round_key" ON "RoundAccessCode"("instanceId", "round");

-- CreateIndex
CREATE INDEX "Applicant_instanceId_status_idx" ON "Applicant"("instanceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Applicant_instanceId_email_key" ON "Applicant"("instanceId", "email");

-- CreateIndex
CREATE INDEX "Reviewer_instanceId_idx" ON "Reviewer"("instanceId");

-- CreateIndex
CREATE INDEX "Assignment_instanceId_round_idx" ON "Assignment"("instanceId", "round");

-- CreateIndex
CREATE INDEX "Assignment_reviewerId_round_status_idx" ON "Assignment"("reviewerId", "round", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_round_applicantId_reviewerId_key" ON "Assignment"("round", "applicantId", "reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "Score_assignmentId_rubricCategoryId_key" ON "Score"("assignmentId", "rubricCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewNote_assignmentId_key" ON "ReviewNote"("assignmentId");

-- CreateIndex
CREATE INDEX "InterviewResult_applicantId_idx" ON "InterviewResult"("applicantId");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewNotes_applicantId_key" ON "InterviewNotes"("applicantId");

-- CreateIndex
CREATE INDEX "FirstRoundVote_applicantId_idx" ON "FirstRoundVote"("applicantId");

-- CreateIndex
CREATE UNIQUE INDEX "FirstRoundVote_applicantId_reviewerId_key" ON "FirstRoundVote"("applicantId", "reviewerId");

-- CreateIndex
CREATE INDEX "ConflictOfInterest_applicantId_round_idx" ON "ConflictOfInterest"("applicantId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "ConflictOfInterest_round_applicantId_reviewerId_key" ON "ConflictOfInterest"("round", "applicantId", "reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "Pass_instanceId_ordinal_key" ON "Pass"("instanceId", "ordinal");

-- CreateIndex
CREATE INDEX "PassApplicant_passId_resolution_idx" ON "PassApplicant"("passId", "resolution");

-- CreateIndex
CREATE UNIQUE INDEX "PassApplicant_passId_applicantId_key" ON "PassApplicant"("passId", "applicantId");

-- CreateIndex
CREATE INDEX "PassVote_passId_applicantId_idx" ON "PassVote"("passId", "applicantId");

-- CreateIndex
CREATE UNIQUE INDEX "PassVote_passId_applicantId_reviewerId_key" ON "PassVote"("passId", "applicantId", "reviewerId");

-- CreateIndex
CREATE INDEX "Decision_applicantId_idx" ON "Decision"("applicantId");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_applicantId_stage_key" ON "Decision"("applicantId", "stage");

-- CreateIndex
CREATE INDEX "AuditLog_instanceId_createdAt_idx" ON "AuditLog"("instanceId", "createdAt");

-- AddForeignKey
ALTER TABLE "Field" ADD CONSTRAINT "Field_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RubricCategory" ADD CONSTRAINT "RubricCategory_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundAccessCode" ADD CONSTRAINT "RoundAccessCode_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Applicant" ADD CONSTRAINT "Applicant_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reviewer" ADD CONSTRAINT "Reviewer_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "Reviewer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_rubricCategoryId_fkey" FOREIGN KEY ("rubricCategoryId") REFERENCES "RubricCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewNote" ADD CONSTRAINT "ReviewNote_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewResult" ADD CONSTRAINT "InterviewResult_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewNotes" ADD CONSTRAINT "InterviewNotes_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstRoundVote" ADD CONSTRAINT "FirstRoundVote_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstRoundVote" ADD CONSTRAINT "FirstRoundVote_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "Reviewer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConflictOfInterest" ADD CONSTRAINT "ConflictOfInterest_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConflictOfInterest" ADD CONSTRAINT "ConflictOfInterest_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "Reviewer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassApplicant" ADD CONSTRAINT "PassApplicant_passId_fkey" FOREIGN KEY ("passId") REFERENCES "Pass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassApplicant" ADD CONSTRAINT "PassApplicant_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassVote" ADD CONSTRAINT "PassVote_passId_fkey" FOREIGN KEY ("passId") REFERENCES "Pass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassVote" ADD CONSTRAINT "PassVote_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassVote" ADD CONSTRAINT "PassVote_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "Reviewer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
