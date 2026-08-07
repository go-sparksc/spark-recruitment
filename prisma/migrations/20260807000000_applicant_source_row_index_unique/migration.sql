-- PRD v1.1, open decision 4 (blind written review).
--
-- `sourceRowIndex` used to be provenance metadata. Section 6 now hides applicant
-- names from written reviewers, who instead see an anonymous label built from it
-- ("Applicant 47"), which makes it user-facing identity. Two applicants sharing a
-- label would mean two reviewers scoring different people under one name.
--
-- Same class of guarantee as Applicant_instanceId_email_key.

-- CreateIndex
CREATE UNIQUE INDEX "Applicant_instanceId_sourceRowIndex_key" ON "Applicant"("instanceId", "sourceRowIndex");
