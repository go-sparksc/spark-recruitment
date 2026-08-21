// FR-12's column mapping, for both interview sheets. Pure — no database, no
// Prisma client.
//
// "The category columns are matched to `InterviewCategory` rows by the same
// mapping table FR-2 uses for applicant columns, so a cycle that changes its
// interview rubric does not need a code change."
//
// The vocabulary is closed but half-open: the fixed roles are known at compile
// time, and a category role carries a row id that is not. That is why the stored
// mapping is JSON keyed by column index rather than a Postgres enum — see PRD §5
// on `InterviewImport.mapping`.
//
// Nothing here proposes a role it is not sure of. Header matching is EXACT after
// trimming, never a prefix or a substring: the applicant fixture's `Black` and
// `Black or African American` columns are the standing reminder of what loose
// matching does, and a wrongly proposed category silently swaps two interview
// scores.

export type InterviewSheet = "SCORES" | "NOTES";

/// What a column contributes. `IGNORED` is a real answer, not the absence of
/// one — an interview sheet carries timestamps and row numbers that nothing
/// should import, and marking them is how the admin says they looked.
export type InterviewRole =
  | { kind: "APPLICANT_EMAIL" }
  | { kind: "APPLICANT_NAME" }
  | { kind: "INTERVIEWER_NAME" }
  | { kind: "AVERAGE" }
  | { kind: "NOTES" }
  | { kind: "CATEGORY"; interviewCategoryId: string }
  | { kind: "IGNORED" };

/// `{ columnIndex: encodedRole }`. Column index is a string because it is a JSON
/// object key, and pretending otherwise at the boundary is how a `"3"` and a `3`
/// end up as two entries for one column.
export type StoredMapping = Record<string, string>;

const CATEGORY_PREFIX = "CATEGORY:";

export function encodeRole(role: InterviewRole): string {
  return role.kind === "CATEGORY" ? `${CATEGORY_PREFIX}${role.interviewCategoryId}` : role.kind;
}

/// **Fails to IGNORED rather than throwing.** A mapping is stored JSON, and a
/// category that was deleted between staging and preview leaves a role naming a
/// row that no longer exists. Ignoring that column produces a preview the admin
/// can see and fix; throwing produces a screen they cannot reach at all.
///
/// `knownCategoryIds` is what makes that check possible, and passing it is not
/// optional — omitting it would let a stale id through to the commit, where it
/// becomes a foreign key violation on a screen with no way back.
export function parseRole(raw: unknown, knownCategoryIds: ReadonlySet<string>): InterviewRole {
  if (typeof raw !== "string") return { kind: "IGNORED" };

  if (raw.startsWith(CATEGORY_PREFIX)) {
    const interviewCategoryId = raw.slice(CATEGORY_PREFIX.length);
    return knownCategoryIds.has(interviewCategoryId)
      ? { kind: "CATEGORY", interviewCategoryId }
      : { kind: "IGNORED" };
  }

  switch (raw) {
    case "APPLICANT_EMAIL":
    case "APPLICANT_NAME":
    case "INTERVIEWER_NAME":
    case "AVERAGE":
    case "NOTES":
      return { kind: raw };
    default:
      return { kind: "IGNORED" };
  }
}

export interface MappedColumns {
  emailColumn: number | null;
  nameColumn: number | null;
  interviewerColumn: number | null;
  averageColumn: number | null;
  notesColumn: number | null;
  /// Column index per category id. A category absent from this map has no
  /// column, which `validateMapping` refuses for the scores sheet.
  categoryColumns: Map<string, number>;
}

/// Resolve a stored mapping into the columns the importer reads.
///
/// **Last wins on a duplicated role**, and `validateMapping` refuses that case
/// separately. Resolving it silently here rather than throwing keeps the preview
/// renderable while the admin is mid-edit, which is when a duplicate mostly
/// exists.
export function resolveMapping(
  mapping: StoredMapping,
  knownCategoryIds: ReadonlySet<string>,
): MappedColumns {
  const columns: MappedColumns = {
    emailColumn: null,
    nameColumn: null,
    interviewerColumn: null,
    averageColumn: null,
    notesColumn: null,
    categoryColumns: new Map(),
  };

  for (const [key, raw] of Object.entries(mapping)) {
    const columnIndex = Number(key);
    if (!Number.isInteger(columnIndex) || columnIndex < 0) continue;

    const role = parseRole(raw, knownCategoryIds);
    switch (role.kind) {
      case "APPLICANT_EMAIL":
        columns.emailColumn = columnIndex;
        break;
      case "APPLICANT_NAME":
        columns.nameColumn = columnIndex;
        break;
      case "INTERVIEWER_NAME":
        columns.interviewerColumn = columnIndex;
        break;
      case "AVERAGE":
        columns.averageColumn = columnIndex;
        break;
      case "NOTES":
        columns.notesColumn = columnIndex;
        break;
      case "CATEGORY":
        columns.categoryColumns.set(role.interviewCategoryId, columnIndex);
        break;
      case "IGNORED":
        break;
    }
  }

  return columns;
}

export interface CategoryLike {
  id: string;
  name: string;
  maxPoints: number;
}

/// Header text the importer will propose a fixed role for, by exact match after
/// trimming and case-folding.
///
/// FR-12 names `Applicant Email`, `Applicant Name`, `Interviewer Name`,
/// `Average` and `Notes`. The extra spellings are the ones the S26 sheets
/// actually use — `Your Name` is what the notes sheet calls its interviewer
/// column, per §5's note on `InterviewNotes.interviewerName`.
///
/// **A proposal, never a decision.** FR-2's mapping table exists because the
/// importer must not guess silently, and every one of these is shown to the
/// admin as a pre-filled dropdown they can change.
const HEADER_PROPOSALS: Record<string, InterviewRole["kind"]> = {
  "applicant email": "APPLICANT_EMAIL",
  email: "APPLICANT_EMAIL",
  "email address": "APPLICANT_EMAIL",
  "applicant name": "APPLICANT_NAME",
  name: "APPLICANT_NAME",
  "interviewer name": "INTERVIEWER_NAME",
  "your name": "INTERVIEWER_NAME",
  interviewer: "INTERVIEWER_NAME",
  average: "AVERAGE",
  notes: "NOTES",
};

/// The mapping the admin starts from.
///
/// Categories are matched on their configured name, exactly, after the same trim
/// and case-fold. A category whose column is named differently in the file
/// simply arrives unmapped, which the validator then refuses — the admin picks
/// it from a dropdown and nothing was guessed.
///
/// A fixed role is proposed at most once even if two headers match: the second
/// column stays `IGNORED` rather than silently overriding the first, so the
/// duplicate is visible in the table instead of being resolved by column order.
export function proposeMapping(
  headers: readonly string[],
  categories: readonly CategoryLike[],
  sheet: InterviewSheet,
): StoredMapping {
  const byName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const mapping: StoredMapping = {};
  const usedFixedRoles = new Set<string>();

  headers.forEach((header, columnIndex) => {
    const key = header.trim().toLowerCase();

    const categoryId = byName.get(key);
    // Categories only exist on the scores sheet. Proposing one on the notes
    // sheet would offer a role its validator refuses.
    if (sheet === "SCORES" && categoryId !== undefined) {
      mapping[String(columnIndex)] = encodeRole({
        kind: "CATEGORY",
        interviewCategoryId: categoryId,
      });
      return;
    }

    const fixed = HEADER_PROPOSALS[key];
    if (fixed !== undefined && !usedFixedRoles.has(fixed) && roleAppliesTo(fixed, sheet)) {
      usedFixedRoles.add(fixed);
      mapping[String(columnIndex)] = fixed;
      return;
    }

    mapping[String(columnIndex)] = "IGNORED";
  });

  return mapping;
}

/// `AVERAGE` on a notes sheet and `NOTES` on a scores sheet are not roles those
/// sheets have. Kept as one predicate so the proposer and the validator cannot
/// disagree about which sheet owns which role.
function roleAppliesTo(kind: InterviewRole["kind"], sheet: InterviewSheet): boolean {
  if (kind === "AVERAGE") return sheet === "SCORES";
  if (kind === "INTERVIEWER_NAME") return true;
  if (kind === "NOTES") return sheet === "NOTES";
  if (kind === "CATEGORY") return sheet === "SCORES";
  return true;
}

/// Everything that stops a sheet being reconciled, as sentences.
///
/// Clause by clause: 12a (one of email or name), 12b (interviewer name on
/// scores), 12c (one column per configured category), 12d (average), 12m (notes
/// column). Each is a blocker rather than a warning because the importer cannot
/// produce a row without it — this is not a judgement call about data quality.
export function validateMapping(
  mapping: StoredMapping,
  headers: readonly string[],
  categories: readonly CategoryLike[],
  sheet: InterviewSheet,
): string[] {
  const knownIds = new Set(categories.map((c) => c.id));
  const columns = resolveMapping(mapping, knownIds);
  const errors: string[] = [];

  // Clause 12a and 12m's shared half: "Applicant Email (or Applicant Name if
  // email is unavailable)". Either alone is sufficient — FR-13's cascade skips
  // the tier it has no value for.
  if (columns.emailColumn === null && columns.nameColumn === null) {
    errors.push(
      "No column is marked as the applicant's email or name. Without one, no row can be " +
        "matched to an applicant.",
    );
  }

  if (sheet === "SCORES") {
    if (columns.interviewerColumn === null) {
      errors.push(
        "No column is marked as the interviewer's name. It is half of what makes a re-upload " +
          "replace a row rather than duplicate it.",
      );
    }
    if (columns.averageColumn === null) {
      errors.push("No column is marked as the Average.");
    }

    const unmapped = categories.filter((category) => !columns.categoryColumns.has(category.id));
    if (unmapped.length > 0) {
      errors.push(
        `${unmapped.length} interview categor${unmapped.length === 1 ? "y has" : "ies have"} ` +
          `no column: ${unmapped.map((c) => c.name).join(", ")}.`,
      );
    }
  }

  if (sheet === "NOTES" && columns.notesColumn === null) {
    errors.push("No column is marked as the Notes.");
  }

  // A role used twice is resolved last-wins by `resolveMapping`, which is a
  // silent choice between two columns. Refused here so the admin makes it.
  const counts = new Map<string, number[]>();
  for (const [key, raw] of Object.entries(mapping)) {
    const role = parseRole(raw, knownIds);
    if (role.kind === "IGNORED") continue;
    const encoded = encodeRole(role);
    counts.set(encoded, [...(counts.get(encoded) ?? []), Number(key)]);
  }
  for (const [encoded, columnIndexes] of counts) {
    if (columnIndexes.length < 2) continue;
    const label = encoded.startsWith(CATEGORY_PREFIX)
      ? (categories.find((c) => c.id === encoded.slice(CATEGORY_PREFIX.length))?.name ??
        "a category")
      : encoded.toLowerCase().replace(/_/g, " ");
    errors.push(
      `More than one column is marked as ${label}: ` +
        `${columnIndexes.map((i) => `“${headers[i] ?? `column ${i + 1}`}”`).join(" and ")}.`,
    );
  }

  return errors;
}
