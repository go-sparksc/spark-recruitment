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

import { FieldCategory, FieldGroupRole } from "@/generated/prisma/enums";

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
  visibleToWrittenReviewer: boolean | null;
  visibleToFirstRoundReviewer: boolean | null;
}

export interface FieldGroupLike {
  id: string;
  category: FieldCategory;
  isIncluded: boolean;
  visibleToWrittenReviewer: boolean | null;
  visibleToFirstRoundReviewer: boolean | null;
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

/// The §6 matrix for the three categories, as data rather than as branches.
/// OTHER's reviewer-round entries are the default that a non-null override
/// replaces; DEMOGRAPHIC's and RESPONSE's are fixed. See `overridable` below.
const CATEGORY_DEFAULTS: Record<FieldCategory, Record<Viewer, boolean>> = {
  [FieldCategory.DEMOGRAPHIC]: {
    WRITTEN_REVIEWER: false,
    FIRST_ROUND_REVIEWER: false,
    SECOND_ROUND_REVIEWER: true,
    ADMIN: true,
  },
  [FieldCategory.RESPONSE]: {
    WRITTEN_REVIEWER: true,
    FIRST_ROUND_REVIEWER: false,
    SECOND_ROUND_REVIEWER: true,
    ADMIN: true,
  },
  [FieldCategory.OTHER]: {
    WRITTEN_REVIEWER: false,
    FIRST_ROUND_REVIEWER: false,
    SECOND_ROUND_REVIEWER: true,
    ADMIN: true,
  },
};

/// Only OTHER is configurable per round. §6 spells DEMOGRAPHIC and RESPONSE as
/// flat "Hidden" and "Visible" while OTHER alone reads "Configurable, default
/// hidden", and goal 3 puts the bias controls in the system rather than in an
/// admin remembering. Honouring an override on a DEMOGRAPHIC field would be a
/// path to showing ethnicity to written reviewers that no requirement asks for.
///
/// The mapping table only offers the toggles on OTHER, so a stored override on
/// another category is unreachable through the UI; this makes it inert if it
/// arrives some other way. See PRD open decision 18.
function overridable(category: FieldCategory): boolean {
  return category === FieldCategory.OTHER;
}

/// Only the reviewer rounds have override columns. Second-round reviewers and
/// admins see every category under §6, so there is nothing to configure.
function overrideFor(
  source: { visibleToWrittenReviewer: boolean | null; visibleToFirstRoundReviewer: boolean | null },
  viewer: Viewer,
): boolean | null {
  if (viewer === "WRITTEN_REVIEWER") return source.visibleToWrittenReviewer;
  if (viewer === "FIRST_ROUND_REVIEWER") return source.visibleToFirstRoundReviewer;
  return null;
}

/// Resolve one field for one viewer.
///
/// Precedence, in order:
///   1. Grouped → the GROUP's category, inclusion and visibility win, always.
///      The member's own values are never read. This is what makes a group
///      impossible to leave half hidden and half visible, and it is why §10.7's
///      1/n can never run over a partially excluded set.
///   2. Not included → invisible to everyone, whatever else is set.
///   3. A non-null per-round override, but only where the category allows one.
///   4. The §6 category default.
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

  // 3. Override, where the category permits one.
  const override = overridable(category) ? overrideFor(source, viewer) : null;
  const isVisible = override ?? CATEGORY_DEFAULTS[category][viewer];

  return { category, isIncluded, isVisible, inheritedFromGroup };
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
