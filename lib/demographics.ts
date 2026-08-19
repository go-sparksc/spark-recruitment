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

import { FieldCategory, FieldGroupRole } from "@/generated/prisma/enums";
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

/// One applicant's answer in one column.
export interface ApplicantDemographic {
  /// The option labels they selected. Empty means the §10.7 "Not specified"
  /// bucket. **An array rather than a joined string** because this is what
  /// FR-11's 1/n weighting counts, and a string would have to be re-split to
  /// count it — which is how the two surfaces come to disagree about what an
  /// applicant selected.
  selected: string[];
  /// The free-text write-in, where there is one. **Never counted**, per §10.7:
  /// it is a real answer the tally cannot read, which is why its author belongs
  /// in "Not specified" and why the text is still worth showing.
  writeIn: string;
}

/// What one applicant's row shows in each column.
export function applicantDemographics(
  data: ApplicantData,
  columns: readonly DemographicColumn[],
): Record<string, ApplicantDemographic> {
  const cells: Record<string, ApplicantDemographic> = {};

  for (const column of columns) {
    if (column.members === null) {
      // An ungrouped demographic field is single-valued, so it is the n = 1
      // case of the same rule rather than a separate one. A blank falls through
      // to "Not specified" exactly as an unchecked group does.
      const value = data[column.key];
      const text = typeof value === "string" ? value.trim() : "";
      cells[column.key] = { selected: text === "" ? [] : [text], writeIn: "" };
      continue;
    }

    cells[column.key] = {
      selected: checkedOptions(data, column.members).map((member) => member.displayName),
      writeIn: freeTextValues(data, column.members).join("; "),
    };
  }

  return cells;
}

// ---------------------------------------------------------------------------
// FR-11's breakdown — PRD §10.7's fractional counting
// ---------------------------------------------------------------------------

/// The bucket for an applicant who selected nothing. §10.7 names it, and it is
/// load-bearing rather than cosmetic: `1/n` is undefined at n = 0, and without
/// the bucket those applicants vanish from the breakdown entirely while the
/// weighted column silently sums to the responder count rather than the
/// headcount.
export const NOT_SPECIFIED = "Not specified";

export interface DemographicTally {
  label: string;
  /// §10.7's `1/n`. One decimal in the UI, alongside the headcount, because a
  /// panel showing fractional people with no explanation reads as a bug.
  weighted: number;
  /// How many applicants selected this at all. Sums to more than the applicant
  /// count when people select several, which is the whole reason `weighted`
  /// exists beside it.
  headcount: number;
}

/// §10.7, stated once. An applicant selecting *n* options contributes `1/n` to
/// each; one selecting none contributes a whole person to `NOT_SPECIFIED`.
///
/// **The invariant is that the weighted column sums to the number of
/// applicants** — not to the number who answered. That is what the
/// `NOT_SPECIFIED` bucket buys, and it is asserted in the tests over a set
/// containing single-selectors, multi-selectors and non-responders together,
/// because it only fails when all three are present.
///
/// Takes selections rather than applicants and field groups: the rule is
/// arithmetic over lists, and keeping it that way means FR-19's funnel
/// breakdown can reuse it without arriving with the same shaped inputs.
///
/// `labels` fixes the order and keeps a zero row visible — "nobody selected
/// this" is a finding, and a breakdown that silently omits empty options makes
/// two cohorts impossible to compare side by side.
export function tallySelections(
  selections: readonly (readonly string[])[],
  labels: readonly string[],
): DemographicTally[] {
  const weighted = new Map<string, number>();
  const headcount = new Map<string, number>();

  const add = (label: string, share: number) => {
    weighted.set(label, (weighted.get(label) ?? 0) + share);
    headcount.set(label, (headcount.get(label) ?? 0) + 1);
  };

  for (const selected of selections) {
    if (selected.length === 0) {
      add(NOT_SPECIFIED, 1);
      continue;
    }
    // De-duplicated first: the same label twice would take 2/n of a person and
    // break the invariant. Unreachable through one-hot columns, which is
    // exactly why it is worth not depending on.
    const distinct = [...new Set(selected)];
    const share = 1 / distinct.length;
    for (const label of distinct) add(label, share);
  }

  // Declared labels first and in order, then anything observed but undeclared —
  // which an ungrouped field always is, since its values are data rather than
  // configuration — then the bucket, last, where a reader expects it.
  const seen = new Set(labels);
  const extras = [...weighted.keys()]
    .filter((label) => !seen.has(label) && label !== NOT_SPECIFIED)
    .sort();

  const ordered = [...labels, ...extras];
  const rows = ordered.map((label) => ({
    label,
    weighted: weighted.get(label) ?? 0,
    headcount: headcount.get(label) ?? 0,
  }));

  if ((headcount.get(NOT_SPECIFIED) ?? 0) > 0) {
    rows.push({
      label: NOT_SPECIFIED,
      weighted: weighted.get(NOT_SPECIFIED) ?? 0,
      headcount: headcount.get(NOT_SPECIFIED) ?? 0,
    });
  }

  return rows;
}

/// The option labels a grouped column can take, for `tallySelections`'s ordering
/// argument. Empty for an ungrouped field, whose values are data rather than
/// configuration and are discovered from the applicants themselves.
export function columnLabels(column: DemographicColumn): string[] {
  if (column.members === null) return [];
  return column.members
    .filter((member) => member.groupRole === FieldGroupRole.OPTION)
    .map((member) => member.displayName);
}
