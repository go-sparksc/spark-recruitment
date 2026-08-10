// Field group semantics: what "checked" means, and which members count.
//
// PRD §10.7 requires the checked predicate live in exactly one place rather
// than being re-derived per surface, because every demographic number in FR-11
// and FR-19 is built on it and two copies would drift apart silently.
//
// Pure — no database access, no Prisma client. The structural types below are
// deliberately narrower than the Prisma models so this can be tested against
// plain objects.

import { FieldGroupRole } from "@/generated/prisma/enums";

/// The shape of `Applicant.data`: { fieldId: value }.
export type ApplicantData = Record<string, unknown>;

export interface GroupMember {
  id: string;
  displayName: string;
  groupRole: FieldGroupRole | null;
}

/// PRD §10.7, stated once.
///
/// The one-hot columns store the column's own label when checked and an empty
/// string when not, which is what the form exports actually emit. Checked means
/// a non-empty value; empty string, `null`, and an absent key are all unchecked.
///
/// Whitespace-only counts as unchecked. A cell holding " " is not an answer, and
/// treating it as one would inflate every breakdown that reads this.
export function isChecked(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/// The OPTION members of a group that this applicant checked.
///
/// FREE_TEXT members are filtered out before the predicate runs. That is the
/// whole reason `groupRole` exists: the write-in is a member so FR-19 can find
/// it to display beneath the breakdown, and it is FREE_TEXT so it never reaches
/// the count. An applicant who checks no box but writes into it has given a real
/// answer that the count cannot read — they belong in "Not specified", and this
/// function returning empty for them is what puts them there.
export function checkedOptions(
  data: ApplicantData,
  members: readonly GroupMember[],
): GroupMember[] {
  return members.filter(
    (member) => member.groupRole === FieldGroupRole.OPTION && isChecked(data[member.id]),
  );
}

/// `n` for the §10.7 `1/n` weighting. Zero means the "Not specified" bucket,
/// where the applicant is counted as one whole person; `1/n` is undefined at
/// n = 0 and the bucket is what keeps weighted totals summing to the headcount.
export function checkedCount(data: ApplicantData, members: readonly GroupMember[]): number {
  return checkedOptions(data, members).length;
}

/// The non-empty FREE_TEXT values on a group, which FR-19 displays beneath the
/// breakdown rather than discarding. Never counted.
export function freeTextValues(data: ApplicantData, members: readonly GroupMember[]): string[] {
  return members
    .filter((member) => member.groupRole === FieldGroupRole.FREE_TEXT)
    .map((member) => data[member.id])
    .filter((value): value is string => isChecked(value))
    .map((value) => value.trim());
}
