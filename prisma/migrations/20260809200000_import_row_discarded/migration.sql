-- Phase 1, Slice 4. FR-3: "Admin resolves or discards these before commit."
--
-- A flag rather than deleting the row, for two reasons:
--
--   * Discarding is reversible until commit. The preview is the only cheap
--     point at which a bad file is caught, so an admin who discards the wrong
--     Avery should be able to put it back without re-uploading.
--   * rowIndex must not move. It becomes Applicant.sourceRowIndex and is the
--     anonymous label a written reviewer sees ("Applicant 47"), so it points at
--     a record in the source file. Deleting rows and renumbering would break
--     that correspondence; a discarded row simply leaves a gap, which is the
--     honest outcome.

ALTER TABLE "ImportRow" ADD COLUMN "discarded" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "ImportRow_instanceId_discarded_idx" ON "ImportRow"("instanceId", "discarded");
