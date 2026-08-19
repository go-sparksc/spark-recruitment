// Demographics for the admin surfaces. Pure — no database, no Prisma client.
//
// Two jobs, both built on lib/field-groups.ts's shared checked predicate rather
// than beside it. PRD §10.7 is explicit that the predicate lives in exactly one
// place, because every demographic number in FR-11 and FR-19 rests on it and two
// copies would drift apart silently — which is not hypothetical: prisma/inspect.ts
// re-derives it inline and disagrees about whitespace.
//
//   1. FR-10's inline columns — what one applicant's row shows.
//   2. FR-11's breakdown — §10.7's 1/n weighting over a set of applicants.
//      (Added in slice 4.)
//
// A group collapses to ONE column rather than one per one-hot option. Ten
// ethnicity columns inline would make the ranked table unreadable, and the group
// is the unit the admin thinks in — which is also why §5 puts category and
// inclusion on the group.

import { FieldCategory } from "@/generated/prisma/enums";
import { checkedOptions, freeTextValues, type ApplicantData, type GroupMember } from "@/lib/field-groups";
import { resolveField, type FieldGroupLike, type FieldLike, type Viewer } from "@/lib/fields";

/// A `Field` row, plus the display name the column header needs.
export interface DemographicField extends FieldLike {
  displayName: string;
  ordinal: number;
}

/// A `FieldGroup` row, plus its display name.
export interface DemographicGroup extends FieldGroupLike {
  displayName: string;
  ordinal: number;
}

export interface DemographicColumn {
  /// The group id for a grouped column, the field id for an ungrouped one.
  key: string;
  label: string;
  /// Set for a grouped column. FR-11's breakdown runs over these; an ungrouped
  /// single-value field has no 1/n to compute.
  members: GroupMember[] | null;
}

/// The demographic columns this viewer may see, in the order the source CSV had
/// them.
///
/// **Visibility runs through `resolveField`**, the §6 helper, rather than being
/// re-derived — so an excluded group or a field an admin hid is absent here for
/// the same reason it is absent everywhere else. In practice ADMIN sees every
/// included demographic field; routing through the helper is what keeps that
/// true if §6 ever changes.
export function demographicColumns(
  fields: readonly DemographicField[],
  groups: readonly DemographicGroup[],
  viewer: Viewer = "ADMIN",
): DemographicColumn[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const columns = new Map<string, DemographicColumn & { ordinal: number }>();

  for (const field of fields) {
    const group = field.groupId === null ? null : (groupById.get(field.groupId) ?? null);
    const resolved = resolveField(field, group, viewer);
    if (!resolved.isIncluded || !resolved.isVisible) continue;
    if (resolved.category !== FieldCategory.DEMOGRAPHIC) continue;

    if (group === null) {
      columns.set(field.id, {
        key: field.id,
        label: field.displayName,
        members: null,
        ordinal: field.ordinal,
      });
      continue;
    }

    const existing = columns.get(group.id);
    const member: GroupMember = {
      id: field.id,
      displayName: field.displayName,
      groupRole: field.groupRole,
    };
    if (existing) {
      existing.members?.push(member);
    } else {
      columns.set(group.id, {
        key: group.id,
        label: group.displayName,
        members: [member],
        // Sorts where its first member sits, matching how the seed places it.
        ordinal: group.ordinal,
      });
    }
  }

  return [...columns.values()]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(({ key, label, members }) => ({ key, label, members }));
}

/// What one applicant's row shows in each column.
///
/// For a grouped column that is the labels they checked, comma-separated. An
/// applicant who checked nothing but wrote into the free-text member shows that
/// text instead — they have given a real answer the count cannot read, and
/// showing it here is the difference between "declined" and "said something we
/// could not tabulate". Empty string means neither.
export function applicantDemographics(
  data: ApplicantData,
  columns: readonly DemographicColumn[],
): Record<string, string> {
  const cells: Record<string, string> = {};

  for (const column of columns) {
    if (column.members === null) {
      const value = data[column.key];
      cells[column.key] = typeof value === "string" ? value.trim() : "";
      continue;
    }

    const checked = checkedOptions(data, column.members);
    if (checked.length > 0) {
      cells[column.key] = checked.map((member) => member.displayName).join(", ");
      continue;
    }
    cells[column.key] = freeTextValues(data, column.members).join("; ");
  }

  return cells;
}
