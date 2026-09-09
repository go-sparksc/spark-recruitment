// The one place field visibility is decided. PRD §6.
//
// "Resolving a field to its effective category, inclusion, and visibility
// belongs in one shared helper, not re-derived per surface." Phase 3 builds
// three reviewer surfaces at once; three copies of this logic would disagree
// within a cycle, and the disagreement would be invisible until a reviewer saw
// something they should not have.
//
// Pure — no database access, no Prisma client. The structural types are
// narrower than the Prisma models so this is testable against plain objects,
// and so a caller cannot accidentally pass a half-loaded row.

import { FieldCategory, FieldGroupRole, PromotedRole } from "@/generated/prisma/enums";

/// Who is asking. Not the same as `Round`: ADMIN is not a round, and a viewer
/// is a role rather than a stage of the cycle.
export type Viewer =
  | "WRITTEN_REVIEWER"
  | "FIRST_ROUND_REVIEWER"
  | "SECOND_ROUND_REVIEWER"
  | "ADMIN";

export interface FieldLike {
  id: string;
  category: FieldCategory;
  isIncluded: boolean;
  groupId: string | null;
  groupRole: FieldGroupRole | null;
  isReviewerVisible: boolean | null;
}

/// `FieldLike` plus the one column only `mustChooseVisibility` needs. Kept
/// separate so the eight reviewer-facing selects that feed `resolveField` do not
/// have to fetch a promotion flag they never read.
export interface ChoosableFieldLike extends FieldLike {
  promotedRole: PromotedRole | null;
}

export interface FieldGroupLike {
  id: string;
  category: FieldCategory;
  isIncluded: boolean;
  isReviewerVisible: boolean | null;
}

export interface ResolvedField {
  category: FieldCategory;
  isIncluded: boolean;
  isVisible: boolean;
  /// True when the values above came from the group rather than the field.
  /// Surfaced so the mapping table can render a grouped member's own controls
  /// read-only rather than implying they do anything.
  inheritedFromGroup: boolean;
}

/// DEMOGRAPHIC is hidden from every reviewer round and cannot be configured
/// otherwise. This is the one place `category` still decides visibility, and it
/// is deliberate: goal 3 puts the bias controls in the system rather than in an
/// admin remembering. Enforcing it here rather than only in the mapping UI is
/// what makes a stored `true` inert if it ever arrives some other way — the
/// property decision 18 gave the old per-round override columns, carried into
/// the binary model by decision 108.
function lockedHidden(category: FieldCategory): boolean {
  return category === FieldCategory.DEMOGRAPHIC;
}

/// Resolve one field for one viewer.
///
/// Precedence, in order:
///   1. Grouped → the GROUP's category, inclusion and visibility win, always.
///      The member's own values are never read. This is what makes a group
///      impossible to leave half hidden and half visible, and it is why §10.7's
///      1/n can never run over a partially excluded set.
///   2. Not included → invisible to everyone, whatever else is set.
///   3. ADMIN sees everything that survives step 2.
///   4. DEMOGRAPHIC → hidden from every reviewer round, whatever is stored.
///   5. `isReviewerVisible === true` → visible to all three reviewer rounds.
///      `false` and `null` are both hidden; null means "not yet chosen", which
///      FR-2 requires an admin to resolve and FR-3 blocks the commit over.
///      Resolving it hidden is what keeps an unchosen column from leaking
///      while it waits to be decided.
///
/// `group` must be the group named by `field.groupId`. Passing a mismatched
/// group throws rather than silently resolving against the wrong rules — a
/// caller that has loaded the wrong row is a bug worth surfacing loudly.
export function resolveField(
  field: FieldLike,
  group: FieldGroupLike | null,
  viewer: Viewer,
): ResolvedField {
  if (field.groupId !== null && group === null) {
    throw new Error(
      `Field ${field.id} belongs to group ${field.groupId} but no group was supplied. ` +
        `Resolving it against its own columns would ignore the group's category, ` +
        `inclusion and visibility, which PRD §5 makes authoritative.`,
    );
  }
  if (group !== null && field.groupId !== group.id) {
    throw new Error(
      `Field ${field.id} belongs to group ${field.groupId ?? "none"}, but group ${group.id} ` +
        `was supplied.`,
    );
  }

  const source = group ?? field;
  const inheritedFromGroup = group !== null;

  const category = source.category;
  const isIncluded = source.isIncluded;

  // 2. Exclusion is absolute. FR-2: the value is retained but the column is out
  //    of every surface. Admin configuration screens read Field rows directly
  //    rather than through this helper, which is how an excluded column stays
  //    re-includable without being visible anywhere data is shown.
  if (!isIncluded) {
    return { category, isIncluded, isVisible: false, inheritedFromGroup };
  }

  // 3. Admin sees everything that is included. §6's admin column is flat.
  if (viewer === "ADMIN") {
    return { category, isIncluded, isVisible: true, inheritedFromGroup };
  }

  // 4-5. The lock, then the flag. No per-round distinction: decision 108.
  const isVisible = lockedHidden(category) ? false : source.isReviewerVisible === true;

  return { category, isIncluded, isVisible, inheritedFromGroup };
}

/// Does this column still need an explicit Reviewer-visible / Backend only?
///
/// FR-2 gives visibility no default, and FR-3 blocks the commit until every
/// eligible column has one. "Eligible" excludes four cases, each for its own
/// reason rather than as a convenience:
///
///   - **Grouped members.** The choice belongs to the group, which is asked
///     separately. Asking the member too would let a group be half decided.
///   - **DEMOGRAPHIC.** Locked hidden by §6, so there is nothing to choose.
///   - **Excluded columns.** Invisible to everyone including ADMIN already. The
///     flag stays editable, so re-including one later is where its choice is
///     made — and the mapping table asks for it then, on both a draft and a
///     committed instance.
///   - **Promoted columns.** Their Field rows are deleted at commit, when the
///     values become Applicant.email and Applicant.displayName.
///
/// Callers pass a `Field`; a `FieldGroup` is asked about through
/// `groupMustChooseVisibility` below, since a group has no groupId or
/// promotedRole to test.
export function mustChooseVisibility(
  field: ChoosableFieldLike,
  group: FieldGroupLike | null,
): boolean {
  if (field.groupId !== null || group !== null) return false;
  if (field.promotedRole !== null) return false;
  if (!field.isIncluded) return false;
  if (lockedHidden(field.category)) return false;
  return field.isReviewerVisible === null;
}

/// The group half of `mustChooseVisibility`. Same rules, minus the two that
/// cannot apply to a group.
export function groupMustChooseVisibility(group: FieldGroupLike): boolean {
  if (!group.isIncluded) return false;
  if (lockedHidden(group.category)) return false;
  return group.isReviewerVisible === null;
}

/// Whether this column should arrive ticked Reviewer-visible. PRD decision 110.
///
/// **Only RESPONSE, and only from unset.** FR-3 carries two blockers over an
/// included Responses column — Backend only refuses the commit, and unset
/// refuses the commit — so Reviewer-visible is the single committable answer and
/// the no-default rule was charging an admin a tick to reach a conclusion
/// already forced. For OTHER and DEMOGRAPHIC both states are genuinely
/// available and mean different things, which is the case decision 108 was
/// written about; the rule stands there untouched.
///
/// **From unset only**, so this never overwrites a decision. An admin who
/// deliberately ticks Backend only on a Responses column keeps that `false` and
/// is refused at commit — which is 108's gate doing its job, not this default
/// failing to. Nor does it fire on a column already `true`.
///
/// **Excluded columns are left alone.** An excluded column resolves hidden and
/// is not committable-blocking either way, so defaulting it would write a choice
/// nobody is being asked for — and it would then survive being re-included,
/// which is the one path by which this could hand out visibility unasked.
///
/// A predicate rather than a mutation so the two mapping actions and their tests
/// all read the same sentence. DEMOGRAPHIC cannot reach `true` here anyway: the
/// category is wrong, and both actions refuse a `true` on it independently.
export function shouldDefaultReviewerVisible(source: {
  category: FieldCategory;
  isIncluded: boolean;
  isReviewerVisible: boolean | null;
}): boolean {
  if (source.category !== FieldCategory.RESPONSE) return false;
  if (!source.isIncluded) return false;
  return source.isReviewerVisible === null;
}

/// The ids a viewer may see. Every reviewer-facing query selects through this
/// and projects `Applicant.data` down to the result on the server — §6 requires
/// a hidden field be absent from the response, not hidden by the client.
export function visibleFieldIds(
  fields: readonly FieldLike[],
  groups: readonly FieldGroupLike[],
  viewer: Viewer,
): Set<string> {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const visible = new Set<string>();

  for (const field of fields) {
    const group = field.groupId === null ? null : (byId.get(field.groupId) ?? null);
    if (resolveField(field, group, viewer).isVisible) visible.add(field.id);
  }

  return visible;
}

/// Narrow `Applicant.data` to what this viewer may see. The server-side half of
/// §6: what is not returned cannot be leaked by a client bug.
export function projectApplicantData(
  data: Record<string, unknown>,
  visibleIds: ReadonlySet<string>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const id of Object.keys(data)) {
    if (visibleIds.has(id)) projected[id] = data[id];
  }
  return projected;
}

export interface ResolvedPromoted {
  /// Applicant.displayName
  name: boolean;
  /// Applicant.email
  email: boolean;
  /// Show "Applicant 47" built from sourceRowIndex instead of the name.
  anonymousLabel: boolean;
}

/// `displayName`, `email` and `sourceRowIndex` are promoted columns rather than
/// Field rows, so no per-field toggle covers them and §6 handles them by fixed
/// rule instead.
///
/// Email is not redundant with name: USC addresses are firstname.lastname@usc.edu,
/// so an email is a name in disguise, and FR-2 makes email un-excludable — it
/// exists on every applicant.
export function resolvePromoted(viewer: Viewer): ResolvedPromoted {
  const blind = viewer === "WRITTEN_REVIEWER";
  return { name: !blind, email: !blind, anonymousLabel: blind };
}

/// FR-2's default display name: a cleaned version of the header. Collapses the
/// newlines and trailing spaces that real exports carry, and drops the trailing
/// colon. The raw header is kept verbatim in `Field.sourceHeader`.
///
/// Lives here rather than in the seed because the importer and the seed must
/// produce identical display names from identical headers.
export function cleanHeader(header: string): string {
  return header.replace(/\s+/g, " ").trim().replace(/\s*:$/, "");
}

/// Slug for FieldGroup.key, which is assigned once and never re-slugged. FR-19
/// and FR-20 reference it, so it has to survive a rename of the display name and
/// be safe in a CSV column heading and a JSON key.
///
/// Accents are folded rather than dropped, so "Café" becomes "cafe" and not "caf".
export function slugify(value: string): string {
  const slug = value
    .normalize("NFD")
    // Escapes, not the literal combining marks: raw ones are invisible in an
    // editor and easy to destroy on save.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // A name of only punctuation or non-Latin script slugs to nothing. Better a
  // dull key than an empty one, which would collide with the next such group and
  // read as a bug in an export.
  return slug === "" ? "group" : slug;
}

/// First slug not already taken, suffixed numerically. The caller supplies the
/// keys already in use for the instance.
export function uniqueSlug(value: string, taken: ReadonlySet<string>): string {
  const base = slugify(value);
  if (!taken.has(base)) return base;

  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
