-- PRD decision 116. One written reviewer's read that an application looks
-- AI-written, ticked on FR-9's score card and surfaced to the admin on FR-10.
--
-- On the assignment rather than the applicant: it is one person's judgment of
-- one application, and three reviewers disagreeing is itself the signal. Admin
-- only under section 6, including the second round — see the schema comment.
--
-- `DEFAULT false` rather than nullable, so every existing assignment means "no
-- flag raised" rather than "nobody has been asked". There is no third state
-- here: a reviewer who did not tick the box has not raised a suspicion, which is
-- exactly what false says.

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "suspectedAiUse" BOOLEAN NOT NULL DEFAULT false;
