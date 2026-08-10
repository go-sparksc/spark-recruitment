import { FieldCategory, FieldGroupRole } from "../../generated/prisma/enums";
import { readSourceHeaders } from "./headers";

export const ETHNICITY_GROUP_KEY = "ethnicity";

/// The group's own row. PRD v1.2 moved category, inclusion and the section 6
/// visibility toggles off the members and onto the group, so a group cannot end
/// up half hidden and half visible and the 10.7 counting can never run over a
/// partially excluded set.
///
/// `key` is immutable once assigned; `displayName` is what a rename changes.
export const ETHNICITY_GROUP = {
  key: ETHNICITY_GROUP_KEY,
  displayName: "Ethnicity",
  category: FieldCategory.DEMOGRAPHIC,
  isMultiSelect: true,
  isIncluded: true,
} as const;

/// Column indexes promoted out of `data` into first-class Applicant columns.
/// FR-2: email and display name require explicit designation and cannot be
/// excluded. The leading "#" is the export's own row counter and becomes
/// sourceRowIndex. None of these four get a Field row.
export const PROMOTED_COLUMNS = {
  rowNumber: 0,
  firstName: 1,
  lastName: 2,
  email: 3,
} as const;

/// BUILD_PLAN phase 1 warns about headers of 200+ characters, but the real
/// export tops out at 159. Rather than pad a real prompt and misrepresent the
/// export, the seed carries all 37 headers verbatim and adds this one synthetic
/// prompt so the length case is genuinely exercised. It mirrors the real
/// prompts' shape: trailing space, trailing newline, curly apostrophe.
export const SYNTHETIC_LONG_PROMPT_HEADER =
  "Describe a time you changed your mind about something you believed strongly. " +
  "What was the belief, what specific evidence or conversation moved you, and how " +
  "has that experience changed the way you evaluate your own assumptions today? " +
  "Please be concrete rather than abstract. \n";

export type FieldKey =
  | "graduationDate"
  | "major"
  | "otherMajor"
  | "secondMajor"
  | "otherSecondMajor"
  | "minor"
  | "heardAbout"
  | "essayJourney"
  | "essayExperience"
  | "essayCared"
  | "essayProblem"
  | "essayMission"
  | "essayChangedMind"
  | "anythingElse"
  | "pronouns"
  | "ethnicityOneHot"
  | "ethnicitySelfDescribed"
  | "firstGeneration"
  | "responseType"
  | "startDate"
  | "stageDate"
  | "submitDate"
  | "networkId"
  | "tags"
  | "ending";

export interface FieldSpec {
  key: FieldKey;
  sourceHeader: string;
  displayName: string;
  category: FieldCategory;
  /// The group's `key`, resolved to a FieldGroup id by the seed. Null when the
  /// column stands alone.
  groupKey: string | null;
  /// Set together with groupKey and null together with it — a raw-SQL CHECK
  /// enforces that pairing at the database.
  groupRole: FieldGroupRole | null;
  isIncluded: boolean;
  ordinal: number;
  /// Set only on the ten one-hot ethnicity columns: the value written when checked.
  optionLabel?: string;
}

/// FR-2's default display name: a cleaned version of the header. Collapses the
/// newlines and trailing spaces and drops the trailing colon.
export function cleanHeader(header: string): string {
  return header.replace(/\s+/g, " ").trim().replace(/\s*:$/, "");
}

interface CatalogEntry {
  key: FieldKey;
  /// Index into the fixture's header row, or "synthetic" for the long prompt.
  column: number | "synthetic";
  category: FieldCategory;
  /// Overrides the cleaned header. The essay prompts get short labels because a
  /// 159-character column name is unusable in a table, and FR-2 lets the admin
  /// rename them anyway.
  displayName?: string;
  groupKey?: string;
  groupRole?: FieldGroupRole;
  isIncluded?: boolean;
}

// Ordered as the columns appear in the export, with the synthetic prompt slotted
// in beside the other essay questions.
const CATALOG: readonly CatalogEntry[] = [
  { key: "graduationDate", column: 4, category: FieldCategory.OTHER },
  { key: "major", column: 5, category: FieldCategory.OTHER },
  { key: "otherMajor", column: 6, category: FieldCategory.OTHER },
  { key: "secondMajor", column: 7, category: FieldCategory.OTHER },
  { key: "otherSecondMajor", column: 8, category: FieldCategory.OTHER },
  { key: "minor", column: 9, category: FieldCategory.OTHER },
  { key: "heardAbout", column: 10, category: FieldCategory.OTHER },

  { key: "essayJourney", column: 11, category: FieldCategory.RESPONSE, displayName: "Life journey" },
  {
    key: "essayExperience",
    column: 12,
    category: FieldCategory.RESPONSE,
    displayName: "Formative experience",
  },
  {
    key: "essayCared",
    column: 13,
    category: FieldCategory.RESPONSE,
    displayName: "Something you cared about",
  },
  {
    key: "essayProblem",
    column: 14,
    category: FieldCategory.RESPONSE,
    displayName: "Problem noticed, first experiment",
  },
  {
    key: "essayMission",
    column: 15,
    category: FieldCategory.RESPONSE,
    displayName: "Fit with Spark's mission",
  },
  {
    key: "essayChangedMind",
    column: "synthetic",
    category: FieldCategory.RESPONSE,
    displayName: "Changing your mind",
  },
  { key: "anythingElse", column: 16, category: FieldCategory.RESPONSE, displayName: "Anything else" },

  { key: "pronouns", column: 17, category: FieldCategory.DEMOGRAPHIC, displayName: "Pronouns" },

  // The ten one-hot ethnicity columns. Any number may be checked, so they belong
  // to one group that the UI and the demographic breakdowns treat as a single
  // logical question rather than ten independent yes/no fields.
  ...([18, 19, 20, 21, 22, 23, 24, 25, 26, 27] as const).map(
    (column): CatalogEntry => ({
      key: "ethnicityOneHot",
      column,
      category: FieldCategory.DEMOGRAPHIC,
      groupKey: ETHNICITY_GROUP_KEY,
      groupRole: FieldGroupRole.OPTION,
    }),
  ),

  // The free-text write-in, and it IS a member of the group — reversing the
  // Phase 0 decision to keep it out, per PRD v1.2 section 5 and 10.7.
  //
  // Membership is what lets FR-19 find it to display beneath the breakdown;
  // groupRole FREE_TEXT is what keeps it out of the checked predicate and out of
  // 1/n. The Phase 0 worry — that it would make the group's members
  // inconsistent — is answered by the role, which is exactly the distinction the
  // aggregations branch on. Pax Writein in the fixture is the case this exists
  // for: zero boxes checked, a real answer written in, and still counted under
  // "Not specified" because the write-in cannot be read as a category.
  {
    key: "ethnicitySelfDescribed",
    column: 28,
    category: FieldCategory.DEMOGRAPHIC,
    displayName: "Ethnicity (self-described)",
    groupKey: ETHNICITY_GROUP_KEY,
    groupRole: FieldGroupRole.FREE_TEXT,
  },
  {
    key: "firstGeneration",
    column: 29,
    category: FieldCategory.DEMOGRAPHIC,
    displayName: "First-generation college student",
  },

  // Junk from the form tool. Excluded by default: the value is kept so nothing is
  // lost, but it never reaches a review surface.
  { key: "responseType", column: 30, category: FieldCategory.OTHER, isIncluded: false },

  { key: "startDate", column: 31, category: FieldCategory.OTHER },
  { key: "stageDate", column: 32, category: FieldCategory.OTHER },
  { key: "submitDate", column: 33, category: FieldCategory.OTHER },

  { key: "networkId", column: 34, category: FieldCategory.OTHER, isIncluded: false },
  { key: "tags", column: 35, category: FieldCategory.OTHER },
  { key: "ending", column: 36, category: FieldCategory.OTHER, isIncluded: false },
];

export function buildFieldSpecs(): FieldSpec[] {
  const headers = readSourceHeaders();

  return CATALOG.map((entry, ordinal) => {
    const sourceHeader =
      entry.column === "synthetic" ? SYNTHETIC_LONG_PROMPT_HEADER : headers[entry.column];

    return {
      key: entry.key,
      sourceHeader,
      displayName: entry.displayName ?? cleanHeader(sourceHeader),
      category: entry.category,
      groupKey: entry.groupKey ?? null,
      groupRole: entry.groupRole ?? null,
      isIncluded: entry.isIncluded ?? true,
      ordinal,
      // Only the OPTION members carry a label to write when checked. The
      // FREE_TEXT member holds whatever the applicant typed.
      ...(entry.groupRole === FieldGroupRole.OPTION
        ? { optionLabel: cleanHeader(sourceHeader) }
        : {}),
    };
  });
}
