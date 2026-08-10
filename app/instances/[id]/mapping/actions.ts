"use server";

import { revalidatePath } from "next/cache";

import { Prisma } from "@/generated/prisma/client";
import { FieldCategory, FieldGroupRole, PromotedRole } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { uniqueSlug } from "@/lib/fields";
import { prisma } from "@/lib/prisma";
import type { GroupProposal } from "@/lib/import/detect-groups";

export interface ActionState {
  error?: string;
}

const ok: ActionState = {};

/// Every action starts here. Two checks, both of which a caller could otherwise
/// skip by invoking the action directly rather than through the page:
///   - the per-instance gate, since a server action is reachable without
///     rendering the page that hosts it;
///   - the commit state, because FR-3 makes the import final. Editing the
///     mapping after commit would change what field ids mean while
///     Applicant.data still points at the old ones.
async function openDraft(instanceId: string) {
  await requireInstance(instanceId, `/instances/${instanceId}/mapping`);

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { id: true, importCommittedAt: true, importProposals: true },
  });

  if (!instance) throw new Error("No such instance.");
  if (instance.importCommittedAt !== null) {
    throw new Error(
      "This instance's CSV has already been committed and its mapping is final. " +
        "Correcting it means deleting the instance and importing again.",
    );
  }

  return instance;
}

function readProposals(value: unknown): GroupProposal[] {
  return ((value as { proposals?: GroupProposal[] } | null)?.proposals ?? []) as GroupProposal[];
}

function refresh(instanceId: string) {
  revalidatePath(`/instances/${instanceId}/mapping`);
}

// ---------------------------------------------------------------------------
// Column-level edits
// ---------------------------------------------------------------------------

export async function updateField(
  instanceId: string,
  fieldId: string,
  patch: {
    displayName?: string;
    category?: FieldCategory;
    isIncluded?: boolean;
    visibleToWrittenReviewer?: boolean | null;
    visibleToFirstRoundReviewer?: boolean | null;
  },
): Promise<ActionState> {
  await openDraft(instanceId);

  const field = await prisma.field.findFirst({
    where: { id: fieldId, instanceId },
    select: { groupId: true, promotedRole: true },
  });
  if (!field) return { error: "No such column." };

  // The group owns category, inclusion and visibility for its members (§5), so
  // writing them onto a member would store values the resolver never reads —
  // which is worse than refusing, because the UI would look like it worked.
  if (field.groupId !== null) {
    const forbidden =
      patch.category !== undefined ||
      patch.isIncluded !== undefined ||
      patch.visibleToWrittenReviewer !== undefined ||
      patch.visibleToFirstRoundReviewer !== undefined;
    if (forbidden) {
      return { error: "This column belongs to a group. Set category and visibility on the group." };
    }
  }

  if (field.promotedRole !== null && patch.isIncluded === false) {
    return { error: "The email and name columns cannot be excluded (FR-2)." };
  }

  if (patch.displayName !== undefined && patch.displayName.trim() === "") {
    return { error: "A display name cannot be empty." };
  }

  await prisma.field.update({
    where: { id: fieldId },
    data: {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName.trim() } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.isIncluded !== undefined ? { isIncluded: patch.isIncluded } : {}),
      ...(patch.visibleToWrittenReviewer !== undefined
        ? { visibleToWrittenReviewer: patch.visibleToWrittenReviewer }
        : {}),
      ...(patch.visibleToFirstRoundReviewer !== undefined
        ? { visibleToFirstRoundReviewer: patch.visibleToFirstRoundReviewer }
        : {}),
    },
  });

  refresh(instanceId);
  return ok;
}

/// FR-2's designation. Setting EMAIL clears any previous email column, since the
/// database permits only one per instance and silently failing the unique index
/// would be a worse experience than moving the designation.
export async function setPromotedRole(
  instanceId: string,
  fieldId: string,
  role: PromotedRole | null,
): Promise<ActionState> {
  await openDraft(instanceId);

  const field = await prisma.field.findFirst({
    where: { id: fieldId, instanceId },
    select: { groupId: true },
  });
  if (!field) return { error: "No such column." };

  if (role !== null && field.groupId !== null) {
    return {
      error:
        "A grouped column cannot be the email or name column. Remove it from its group first.",
    };
  }

  await prisma.$transaction(async (tx) => {
    if (role === PromotedRole.EMAIL) {
      await tx.field.updateMany({
        where: { instanceId, promotedRole: PromotedRole.EMAIL },
        data: { promotedRole: null },
      });
    }
    await tx.field.update({
      where: { id: fieldId },
      // Designating a column also forces it included, which the CHECK requires
      // and FR-2 demands.
      data: { promotedRole: role, ...(role !== null ? { isIncluded: true } : {}) },
    });
  });

  refresh(instanceId);
  return ok;
}

// ---------------------------------------------------------------------------
// Proposals: name (which creates the group) or dismiss
// ---------------------------------------------------------------------------

export async function nameProposal(
  instanceId: string,
  proposalIndex: number,
  displayName: string,
): Promise<ActionState> {
  const instance = await openDraft(instanceId);

  const name = displayName.trim();
  if (name === "") return { error: "Give the group a name." };

  const proposals = readProposals(instance.importProposals);
  const proposal = proposals[proposalIndex];
  if (!proposal) return { error: "That suggestion is no longer there." };

  // Belt and braces against a double submit. Clearing the proposal is what
  // normally prevents a second run, but that is one write away from being
  // skipped — as it was — and the damage is silent: two groups with near
  // identical keys, one of them orphaned. If any target column is already
  // grouped, this proposal has been acted on.
  const alreadyGrouped = await prisma.field.count({
    where: { instanceId, ordinal: { in: proposal.columnIndexes }, groupId: { not: null } },
  });
  if (alreadyGrouped > 0) {
    return { error: "Those columns already belong to a group. Reload the page." };
  }

  const existing = await prisma.fieldGroup.findMany({
    where: { instanceId },
    select: { key: true },
  });

  // The key is frozen here and never re-slugged — this is the only moment it is
  // decided, which is why the group is not created until someone names it.
  const key = uniqueSlug(name, new Set(existing.map((g) => g.key)));

  await prisma.$transaction(async (tx) => {
    const group = await tx.fieldGroup.create({
      data: {
        instanceId,
        key,
        displayName: name,
        category: FieldCategory.OTHER,
        isMultiSelect: proposal.isMultiSelect,
        isIncluded: true,
        ordinal: Math.min(...proposal.columnIndexes),
      },
      select: { id: true },
    });

    await tx.field.updateMany({
      where: { instanceId, ordinal: { in: proposal.columnIndexes } },
      data: { groupId: group.id, groupRole: FieldGroupRole.OPTION },
    });

    await tx.instance.update({
      where: { id: instanceId },
      data: { importProposals: nextProposals(proposals, proposalIndex) },
    });
  });

  refresh(instanceId);
  return ok;
}

export async function dismissProposal(
  instanceId: string,
  proposalIndex: number,
): Promise<ActionState> {
  const instance = await openDraft(instanceId);

  const proposals = readProposals(instance.importProposals);
  if (!proposals[proposalIndex]) return { error: "That suggestion is no longer there." };

  await prisma.instance.update({
    where: { id: instanceId },
    data: { importProposals: nextProposals(proposals, proposalIndex) },
  });

  refresh(instanceId);
  return ok;
}

/// Removing the last proposal writes a database NULL rather than an empty
/// array, so the Instance_importProposals_cleared_at_commit CHECK sees a
/// genuinely empty value at commit rather than `{"proposals":[]}`.
///
/// `Prisma.DbNull`, NOT `undefined` and not `null`. Prisma reads `undefined` in
/// a `data` object as "leave this column alone", so returning it here silently
/// skipped the write: the group was created, the action reported success, and
/// the proposal stayed on screen — which made a second click create a second
/// group. `null` is ambiguous for a Json column and Prisma rejects it, which is
/// exactly why DbNull exists.
function nextProposals(proposals: GroupProposal[], removeIndex: number) {
  const remaining = proposals.filter((_, i) => i !== removeIndex);
  return remaining.length > 0 ? { proposals: remaining } : Prisma.DbNull;
}

// ---------------------------------------------------------------------------
// Groups: rename, edit, split, merge, assign, ungroup
// ---------------------------------------------------------------------------

export async function updateGroup(
  instanceId: string,
  groupId: string,
  patch: {
    displayName?: string;
    category?: FieldCategory;
    isIncluded?: boolean;
    isMultiSelect?: boolean;
    visibleToWrittenReviewer?: boolean | null;
    visibleToFirstRoundReviewer?: boolean | null;
  },
): Promise<ActionState> {
  await openDraft(instanceId);

  const group = await prisma.fieldGroup.findFirst({
    where: { id: groupId, instanceId },
    select: { id: true },
  });
  if (!group) return { error: "No such group." };

  if (patch.displayName !== undefined && patch.displayName.trim() === "") {
    return { error: "A group name cannot be empty." };
  }

  await prisma.fieldGroup.update({
    where: { id: groupId },
    // `key` is deliberately absent. A rename changes displayName only; the key
    // was frozen when the group was created and FR-19/FR-20 reference it.
    data: {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName.trim() } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.isIncluded !== undefined ? { isIncluded: patch.isIncluded } : {}),
      ...(patch.isMultiSelect !== undefined ? { isMultiSelect: patch.isMultiSelect } : {}),
      ...(patch.visibleToWrittenReviewer !== undefined
        ? { visibleToWrittenReviewer: patch.visibleToWrittenReviewer }
        : {}),
      ...(patch.visibleToFirstRoundReviewer !== undefined
        ? { visibleToFirstRoundReviewer: patch.visibleToFirstRoundReviewer }
        : {}),
    },
  });

  refresh(instanceId);
  return ok;
}

/// Move some members into a new group. The new group is named here, so it takes
/// its own frozen key. A split that would empty the original deletes it.
export async function splitGroup(
  instanceId: string,
  groupId: string,
  fieldIds: string[],
  newName: string,
): Promise<ActionState> {
  await openDraft(instanceId);

  const name = newName.trim();
  if (name === "") return { error: "Give the new group a name." };
  if (fieldIds.length === 0) return { error: "Choose at least one column to split off." };

  const group = await prisma.fieldGroup.findFirst({
    where: { id: groupId, instanceId },
    select: { id: true, isMultiSelect: true, category: true, isIncluded: true },
  });
  if (!group) return { error: "No such group." };

  const members = await prisma.field.findMany({
    where: { groupId, instanceId },
    select: { id: true, ordinal: true, groupRole: true },
    orderBy: { ordinal: "asc" },
  });

  const moving = members.filter((m) => fieldIds.includes(m.id));
  if (moving.length !== fieldIds.length) return { error: "Some columns are not in that group." };

  const existing = await prisma.fieldGroup.findMany({
    where: { instanceId },
    select: { key: true },
  });

  await prisma.$transaction(async (tx) => {
    const created = await tx.fieldGroup.create({
      data: {
        instanceId,
        key: uniqueSlug(name, new Set(existing.map((g) => g.key))),
        displayName: name,
        // The new group inherits the original's settings rather than resetting
        // to defaults: a split is a correction to the grouping, not a decision
        // to re-categorise half of it.
        category: group.category,
        isMultiSelect: group.isMultiSelect,
        isIncluded: group.isIncluded,
        ordinal: Math.min(...moving.map((m) => m.ordinal)),
      },
      select: { id: true },
    });

    await tx.field.updateMany({
      where: { id: { in: moving.map((m) => m.id) } },
      data: { groupId: created.id },
    });

    if (moving.length === members.length) {
      await tx.fieldGroup.delete({ where: { id: groupId } });
    }
  });

  refresh(instanceId);
  return ok;
}

/// Members of `mergedId` move into `survivingId`, and `mergedId` is deleted.
/// The survivor's key, category, inclusion and visibility win — they are group
/// properties, and a merge is where two answers to each become one.
export async function mergeGroups(
  instanceId: string,
  survivingId: string,
  mergedId: string,
): Promise<ActionState> {
  await openDraft(instanceId);

  if (survivingId === mergedId) return { error: "Choose two different groups." };

  const groups = await prisma.fieldGroup.findMany({
    where: { instanceId, id: { in: [survivingId, mergedId] } },
    select: { id: true },
  });
  if (groups.length !== 2) return { error: "No such group." };

  await prisma.$transaction(async (tx) => {
    await tx.field.updateMany({
      where: { instanceId, groupId: mergedId },
      data: { groupId: survivingId },
    });
    await tx.fieldGroup.delete({ where: { id: mergedId } });
  });

  refresh(instanceId);
  return ok;
}

/// Assign an ungrouped column to a group, move it between groups, or remove it.
/// `groupId: null` ungroups. groupId and groupRole are always written together —
/// the Field_groupRole_iff_groupId CHECK rejects a half-set row.
export async function assignToGroup(
  instanceId: string,
  fieldId: string,
  groupId: string | null,
  role: FieldGroupRole | null,
): Promise<ActionState> {
  await openDraft(instanceId);

  const field = await prisma.field.findFirst({
    where: { id: fieldId, instanceId },
    select: { promotedRole: true },
  });
  if (!field) return { error: "No such column." };

  if (groupId !== null && field.promotedRole !== null) {
    return { error: "The email and name columns cannot belong to a group." };
  }

  if (groupId !== null) {
    if (role === null) return { error: "Choose whether this column is an option or the write-in." };
    const group = await prisma.fieldGroup.findFirst({
      where: { id: groupId, instanceId },
      select: { id: true },
    });
    if (!group) return { error: "No such group." };
  }

  await prisma.field.update({
    where: { id: fieldId },
    data: { groupId, groupRole: groupId === null ? null : role },
  });

  // Removing the last member leaves an empty group, which nothing can use and
  // which would still appear in FR-19. Clean it up rather than leaving a shell.
  if (groupId === null) {
    const empties = await prisma.fieldGroup.findMany({
      where: { instanceId, fields: { none: {} } },
      select: { id: true },
    });
    if (empties.length > 0) {
      await prisma.fieldGroup.deleteMany({ where: { id: { in: empties.map((g) => g.id) } } });
    }
  }

  refresh(instanceId);
  return ok;
}

/// Create a group from a single ungrouped column, named on the spot. The path
/// for a question the detector missed entirely — a form that exports Y/TRUE/1
/// produces no proposals at all, and the admin has to start somewhere.
export async function createGroupFromField(
  instanceId: string,
  fieldId: string,
  name: string,
  role: FieldGroupRole,
): Promise<ActionState> {
  await openDraft(instanceId);

  const trimmed = name.trim();
  if (trimmed === "") return { error: "Give the group a name." };

  const field = await prisma.field.findFirst({
    where: { id: fieldId, instanceId },
    select: { ordinal: true, promotedRole: true },
  });
  if (!field) return { error: "No such column." };
  if (field.promotedRole !== null) {
    return { error: "The email and name columns cannot belong to a group." };
  }

  const existing = await prisma.fieldGroup.findMany({
    where: { instanceId },
    select: { key: true },
  });

  await prisma.$transaction(async (tx) => {
    const group = await tx.fieldGroup.create({
      data: {
        instanceId,
        key: uniqueSlug(trimmed, new Set(existing.map((g) => g.key))),
        displayName: trimmed,
        category: FieldCategory.OTHER,
        isMultiSelect: true,
        isIncluded: true,
        ordinal: field.ordinal,
      },
      select: { id: true },
    });

    await tx.field.update({
      where: { id: fieldId },
      data: { groupId: group.id, groupRole: role },
    });
  });

  refresh(instanceId);
  return ok;
}
