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
///
/// PRD decision 120 adds four: a per-category note column beside each score
/// column, the interviewer's overall note, their recommendation, and TRANSCRIPT
/// — the one role a sheet may use more than once, because a notes sheet
/// legitimately carries one column per interview question.
export type InterviewRole =
  | { kind: "APPLICANT_EMAIL" }
  | { kind: "APPLICANT_NAME" }
  | { kind: "INTERVIEWER_NAME" }
  | { kind: "AVERAGE" }
  | { kind: "NOTES" }
  | { kind: "CATEGORY"; interviewCategoryId: string }
  | { kind: "CATEGORY_NOTE"; interviewCategoryId: string }
  | { kind: "OVERALL_NOTE" }
  | { kind: "RECOMMENDATION" }
  | { kind: "TRANSCRIPT" }
  | { kind: "IGNORED" };

/// The one role a sheet may carry more than one of. Everything else is refused
/// twice over by `validateMapping`, because `resolveMapping` would otherwise
/// pick between two columns silently by document order.
///
/// Kept as a named constant rather than an inline comparison so the proposer,
/// the resolver and the validator cannot disagree about which role that is.
export const REPEATABLE_ROLE: InterviewRole["kind"] = "TRANSCRIPT";

/// `{ columnIndex: encodedRole }`. Column index is a string because it is a JSON
/// object key, and pretending otherwise at the boundary is how a `"3"` and a `3`
/// end up as two entries for one column.
export type StoredMapping = Record<string, string>;

const CATEGORY_PREFIX = "CATEGORY:";
/// Must not be a prefix of CATEGORY_PREFIX, nor CATEGORY_PREFIX a prefix of it,
/// or `parseRole`'s `startsWith` checks would read one as the other. "CATEGORY:"
/// and "CATEGORY_NOTE:" diverge at the ninth character, so neither prefixes the
/// other — but the check below is ordered longest-first regardless, because a
/// later edit to either string should not be able to make that silently untrue.
const CATEGORY_NOTE_PREFIX = "CATEGORY_NOTE:";

export function encodeRole(role: InterviewRole): string {
  if (role.kind === "CATEGORY") return `${CATEGORY_PREFIX}${role.interviewCategoryId}`;
  if (role.kind === "CATEGORY_NOTE") return `${CATEGORY_NOTE_PREFIX}${role.interviewCategoryId}`;
  return role.kind;
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

  // Longest prefix first. See the note on CATEGORY_NOTE_PREFIX: the two do not
  // currently prefix one another, and this ordering is what keeps that from
  // mattering if either string is ever edited.
  if (raw.startsWith(CATEGORY_NOTE_PREFIX)) {
    const interviewCategoryId = raw.slice(CATEGORY_NOTE_PREFIX.length);
    return knownCategoryIds.has(interviewCategoryId)
      ? { kind: "CATEGORY_NOTE", interviewCategoryId }
      : { kind: "IGNORED" };
  }

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
    case "OVERALL_NOTE":
    case "RECOMMENDATION":
    case "TRANSCRIPT":
      return { kind: raw };
    default:
      return { kind: "IGNORED" };
  }
}

export interface MappedColumns {
  emailColumn: number | null;
  nameColumn: number | null;
  interviewerColumn: number | null;
  /// Optional since PRD decision 120. Null means the sheet states no average,
  /// and the importer computes one from the categories — see
  /// `lib/import/interview-preview.ts`, which is where that choice is made and
  /// recorded.
  averageColumn: number | null;
  notesColumn: number | null;
  overallNoteColumn: number | null;
  recommendationColumn: number | null;
  /// Column index per category id. A category absent from this map has no
  /// column, which `validateMapping` refuses for the scores sheet.
  categoryColumns: Map<string, number>;
  /// Column index per category id, for that category's note. Unlike
  /// `categoryColumns` an absent category is fine: a note column is optional,
  /// per category, and a sheet may carry some and not others.
  categoryNoteColumns: Map<string, number>;
  /// Ascending, and the only column list rather than a single index. Order is
  /// the sheet's own left-to-right order, which becomes `InterviewQuestion.ordinal`
  /// and therefore the order the transcript renders in.
  transcriptColumns: number[];
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
    overallNoteColumn: null,
    recommendationColumn: null,
    categoryColumns: new Map(),
    categoryNoteColumns: new Map(),
    transcriptColumns: [],
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
      case "OVERALL_NOTE":
        columns.overallNoteColumn = columnIndex;
        break;
      case "RECOMMENDATION":
        columns.recommendationColumn = columnIndex;
        break;
      case "CATEGORY":
        columns.categoryColumns.set(role.interviewCategoryId, columnIndex);
        break;
      case "CATEGORY_NOTE":
        columns.categoryNoteColumns.set(role.interviewCategoryId, columnIndex);
        break;
      case "TRANSCRIPT":
        columns.transcriptColumns.push(columnIndex);
        break;
      case "IGNORED":
        break;
    }
  }

  // `Object.entries` follows JSON key insertion order, not numeric order, and a
  // mapping edited one column at a time arrives in the order the admin touched
  // them. Sorting here is what makes `InterviewQuestion.ordinal` the sheet's
  // left-to-right order rather than the order somebody clicked.
  columns.transcriptColumns.sort((a, b) => a - b);

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
  // PRD decision 120. The last two are F26's exact wording; like every entry
  // above, they are spellings observed in a real sheet rather than a pattern.
  "additional notes": "OVERALL_NOTE",
  "should this applicant move on to 1r deliberations?": "RECOMMENDATION",
  "move on to deliberations?": "RECOMMENDATION",
};

/// Headers that are never an interview question, however unmapped they look.
/// PRD decision 120.
///
/// **This exists because of what `IGNORED` means here.** Its own doc above says
/// IGNORED is "a real answer, not the absence of one — an interview sheet carries
/// timestamps and row numbers that nothing should import, and marking them is how
/// the admin says they looked." The bulk transcript control cannot honour that:
/// a column the admin deliberately ignored and a column nobody has reached are
/// the same stored value, so a sweep over IGNORED columns picks up both.
///
/// Every Google Forms export opens with `Timestamp`, so without this the first
/// question of every transcript is a date — found by running the real F26 notes
/// sheet through the importer, which produced ten questions instead of nine.
///
/// Exact match after trim and case-fold, like every other header rule in this
/// file. It is not a guess about what a question is; it is the one header the
/// module already named as the example of what never imports.
export const NON_QUESTION_HEADERS: ReadonlySet<string> = new Set([
  "timestamp",
  "row",
  "row number",
  "id",
  "submission id",
  "email address",
]);

/// Whether a column is one the bulk transcript control should leave alone.
/// Shared by the action and the screen so the count on the button and the columns
/// the action touches cannot disagree.
export function isBulkTranscriptCandidate(header: string, role: string | undefined): boolean {
  if ((role ?? "IGNORED") !== "IGNORED") return false;
  if (NON_QUESTION_HEADERS.has(header.trim().toLowerCase())) return false;
  // A column with no heading at all is a spreadsheet artifact far more often
  // than it is a question somebody forgot to label.
  return header.trim() !== "";
}

/// The header a category's note column would have, if the sheet names it the way
/// F26's does. PRD decision 120.
///
/// **This is still an exact match, not a prefix search.** The key is built from
/// the configured category's own name and the whole header is compared against
/// it. A column called "Notes on Initiative" does not match a category called
/// "Initiative and Scrappiness", which is the `Black` / `Black or African
/// American` rule this module opens with, applied to a derived key rather than
/// a literal one.
function categoryNoteKey(categoryName: string): string {
  return `notes on ${categoryName.trim().toLowerCase()}`;
}

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
  const byNoteName = new Map(categories.map((c) => [categoryNoteKey(c.name), c.id]));
  const mapping: StoredMapping = {};
  const usedFixedRoles = new Set<string>();
  const usedCategoryNotes = new Set<string>();

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

    // Checked after the plain category name, and it cannot shadow one: a header
    // cannot equal both `x` and `notes on x` for the same x. Proposed at most
    // once per category, for the same reason a fixed role is — a second column
    // with the same header stays IGNORED and visible rather than overriding.
    const noteCategoryId = byNoteName.get(key);
    if (
      sheet === "SCORES" &&
      noteCategoryId !== undefined &&
      !usedCategoryNotes.has(noteCategoryId)
    ) {
      usedCategoryNotes.add(noteCategoryId);
      mapping[String(columnIndex)] = encodeRole({
        kind: "CATEGORY_NOTE",
        interviewCategoryId: noteCategoryId,
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
  // PRD decision 120. The three evaluative roles belong to the scores sheet
  // because they are one interviewer's judgement, and the transcript belongs to
  // the notes sheet because it is the shared notetaker's record.
  if (kind === "CATEGORY_NOTE") return sheet === "SCORES";
  if (kind === "OVERALL_NOTE") return sheet === "SCORES";
  if (kind === "RECOMMENDATION") return sheet === "SCORES";
  if (kind === "TRANSCRIPT") return sheet === "NOTES";
  return true;
}

/// Everything that stops a sheet being reconciled, as sentences.
///
/// Clause by clause: 12a (one of email or name), 12b (interviewer name on
/// scores), 12c (one column per configured category), 12m (notes column, which
/// PRD decision 120 widens to "notes column or transcript questions"). Each is a
/// blocker rather than a warning because the importer cannot produce a row
/// without it — this is not a judgement call about data quality.
///
/// **12d (average) is no longer here.** Decision 120 made the column optional;
/// see the comment where the check used to be.
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

    // Clause 12d, withdrawn as a blocker by PRD decision 120. A sheet with no
    // Average column states no number to import, so there is nothing to refuse;
    // the score is computed from the categories and labelled as computed. The
    // case that DOES still block — no average column and a row whose categories
    // are all unreadable, so no score can be produced at all — is per-row and
    // therefore lives in the preview, not here.

    const unmapped = categories.filter((category) => !columns.categoryColumns.has(category.id));
    if (unmapped.length > 0) {
      errors.push(
        `${unmapped.length} interview categor${unmapped.length === 1 ? "y has" : "ies have"} ` +
          `no column: ${unmapped.map((c) => c.name).join(", ")}.`,
      );
    }

    // A note column whose category has no score column would import nothing:
    // decision 59 writes no InterviewCategoryScore row without a readable score,
    // and the note lives on that row. Blocked rather than warned because it is a
    // mapping mistake with one obvious fix, not a property of the data.
    const orphanNotes = categories.filter(
      (category) =>
        columns.categoryNoteColumns.has(category.id) && !columns.categoryColumns.has(category.id),
    );
    if (orphanNotes.length > 0) {
      errors.push(
        `${orphanNotes.length} categor${orphanNotes.length === 1 ? "y has" : "ies have"} a notes ` +
          `column but no score column: ${orphanNotes.map((c) => c.name).join(", ")}. A category's ` +
          `note is stored on its score, so it would import nowhere.`,
      );
    }
  }

  // PRD decision 120: either contract satisfies the notes sheet — one Notes
  // column, or one column per interview question. Both is allowed and means the
  // sheet carries a summary alongside the questions.
  if (sheet === "NOTES" && columns.notesColumn === null && columns.transcriptColumns.length === 0) {
    errors.push(
      "No column is marked as the Notes, and none is marked as a transcript question. Mark the " +
        "single notes column, or mark each question column as a transcript question.",
    );
  }

  // A role used twice is resolved last-wins by `resolveMapping`, which is a
  // silent choice between two columns. Refused here so the admin makes it.
  //
  // TRANSCRIPT is exempt and is the only exemption — a notes sheet carries one
  // column per question, and `resolveMapping` collects them into a list rather
  // than overwriting a single index, so there is no silent choice to refuse.
  const counts = new Map<string, number[]>();
  for (const [key, raw] of Object.entries(mapping)) {
    const role = parseRole(raw, knownIds);
    if (role.kind === "IGNORED") continue;
    if (role.kind === REPEATABLE_ROLE) continue;
    const encoded = encodeRole(role);
    counts.set(encoded, [...(counts.get(encoded) ?? []), Number(key)]);
  }
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? "a category";
  for (const [encoded, columnIndexes] of counts) {
    if (columnIndexes.length < 2) continue;
    // Longest prefix first, as in `parseRole`, and for the same reason.
    const label = encoded.startsWith(CATEGORY_NOTE_PREFIX)
      ? `notes on ${categoryName(encoded.slice(CATEGORY_NOTE_PREFIX.length))}`
      : encoded.startsWith(CATEGORY_PREFIX)
        ? categoryName(encoded.slice(CATEGORY_PREFIX.length))
        : encoded.toLowerCase().replace(/_/g, " ");
    errors.push(
      `More than one column is marked as ${label}: ` +
        `${columnIndexes.map((i) => `“${headers[i] ?? `column ${i + 1}`}”`).join(" and ")}.`,
    );
  }

  return errors;
}
