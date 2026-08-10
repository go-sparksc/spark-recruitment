-- Phase 1, Slice 3. FR-2's two required designations.
--
-- "Two columns require explicit designation and cannot be excluded: email
-- (used as the join key for later imports) and display name (first + last, or
-- a single name column)."
--
-- Modelled as a role on Field rather than columns on Instance, because the fact
-- is about a column and belongs on the column. Section 6 says the promoted
-- values are NOT Field rows once imported — at FR-3 commit these columns become
-- Applicant.email and Applicant.displayName and their Field rows go away. This
-- marker only has to survive the draft.
--
-- Hand-written for the partial unique index and the CHECK, neither of which
-- Prisma can express. Both are asserted by prisma/checks/field-groups.ts.

CREATE TYPE "PromotedRole" AS ENUM ('EMAIL', 'NAME');

ALTER TABLE "Field" ADD COLUMN "promotedRole" "PromotedRole";

-- At most one email column per instance. Two would make the FR-12 join key
-- ambiguous, and FR-3's duplicate detection would not know which to compare.
-- A PARTIAL unique index, so the many NULLs do not collide: Prisma has no
-- syntax for the WHERE clause, which is why this is here and not in the schema.
CREATE UNIQUE INDEX "Field_instanceId_emailPromotion_key"
    ON "Field"("instanceId") WHERE "promotedRole" = 'EMAIL';

-- Name may be one column or two ("First Name" + "Last Name"), so it gets no
-- uniqueness. Order comes from Field.ordinal.

-- FR-2's "cannot be excluded", enforced rather than remembered. A promoted
-- column also cannot belong to a group: the group would own its category and
-- inclusion, and a group whose member is secretly the email column has no
-- coherent meaning.
ALTER TABLE "Field" ADD CONSTRAINT "Field_promoted_is_included_and_ungrouped"
    CHECK (
        "promotedRole" IS NULL
        OR ("groupId" IS NULL AND "isIncluded" = true)
    );
