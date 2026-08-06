import { FieldCategory } from "../../generated/prisma/enums";
import { readSourceHeaders } from "./headers";

export const ETHNICITY_GROUP_KEY = "ethnicity";

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
  groupKey: string | null;
  isMultiSelect: boolean;
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
  isMultiSelect?: boolean;
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

  // The ten one-hot ethnicity columns. Any number may be checked, so they share a
  // groupKey and carry isMultiSelect: the UI and the demographic breakdowns treat
  // them as one logical question rather than ten independent yes/no fields.
  ...([18, 19, 20, 21, 22, 23, 24, 25, 26, 27] as const).map(
    (column): CatalogEntry => ({
      key: "ethnicityOneHot",
      column,
      category: FieldCategory.DEMOGRAPHIC,
      groupKey: ETHNICITY_GROUP_KEY,
      isMultiSelect: true,
    }),
  ),

  // Free text, and deliberately NOT part of the one-hot group. Putting it in the
  // group would make isMultiSelect inconsistent within the group and would break
  // any aggregation that assumes group members are checkbox columns.
  {
    key: "ethnicitySelfDescribed",
    column: 28,
    category: FieldCategory.DEMOGRAPHIC,
    displayName: "Ethnicity (self-described)",
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
      isMultiSelect: entry.isMultiSelect ?? false,
      isIncluded: entry.isIncluded ?? true,
      ordinal,
      ...(entry.groupKey === ETHNICITY_GROUP_KEY
        ? { optionLabel: cleanHeader(sourceHeader) }
        : {}),
    };
  });
}
