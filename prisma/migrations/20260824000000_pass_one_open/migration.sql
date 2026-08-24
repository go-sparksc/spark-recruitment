-- FR-17: "Exactly one pass is OPEN at a time." Phase 6, Slice 6, clause 17c.
--
-- The rule is what makes clause 17d — "a submitted vote lands in the currently
-- open pass" — a well-defined sentence. The vote action resolves the open pass
-- itself rather than taking a pass id from the request, and that resolution has
-- no tiebreak: with two open passes it silently picks one, and half a round's
-- votes land in a pass nobody is looking at.
--
-- A guard in the create action is not enough on its own. Two admins creating a
-- pass at the same moment both read zero open passes and both insert — the same
-- check-then-act race prisma/checks/claim-race.ts exists for. The action keeps
-- its guard, because that is what produces the message an admin should read; the
-- index is what makes the guard's answer true.
--
-- PARTIAL, so closed passes accumulate without colliding: a cycle ends with three
-- or four CLOSED passes on one instance and only the OPEN one is unique. Prisma
-- has no syntax for the WHERE clause, which is why this is here and not in
-- schema.prisma — the same posture as Field_instanceId_emailPromotion_key.
--
-- Asserted by prisma/checks/passes.ts, which also inserts a CLOSED pass beside
-- the OPEN one: a total unique index on "instanceId" would raise 23505 for the
-- duplicate too, so rejecting the duplicate alone does not prove partiality.

CREATE UNIQUE INDEX "Pass_one_open_per_instance"
    ON "Pass"("instanceId") WHERE "status" = 'OPEN';
