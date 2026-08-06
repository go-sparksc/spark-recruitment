import {
  ENDING_TEMPLATE,
  ESSAY_POOLS,
  ETHNICITY_WEIGHTS,
  FIRST_NAMES,
  GRADUATION_DATES,
  HEARD_ABOUT,
  LAST_NAMES,
  MAJORS,
  MINORS,
  PRONOUNS,
  SELF_DESCRIBED_ETHNICITIES,
  TAGS,
  WRITE_IN_MAJORS,
  type EssayKey,
} from "./corpus";
import type { FieldSpec } from "./fields";
import type { Rng } from "./rng";

const MAJORS_WITHOUT_OTHER = MAJORS.filter((major) => major !== "Other");

// Blank rates, chosen to reproduce the real export rather than to look tidy.
// Several columns there are empty for 60-90% of rows, and code that has only
// ever seen dense data handles them badly.
const P_MAJOR_IS_OTHER = 0.12; // -> "Other Major:" ~88% blank
const P_HAS_SECOND_MAJOR = 0.28; // -> "Second Major:" ~72% blank
const P_SECOND_MAJOR_IS_OTHER = 0.25; // -> "Other Second Major:" ~93% blank
const P_HAS_MINOR = 0.35; // -> "Minor:" ~65% blank
const P_HAS_ANYTHING_ELSE = 0.38; // -> "Anything else" ~62% blank
const P_SELF_DESCRIBES_ETHNICITY = 0.2; // -> ~80% blank
const P_HAS_TAG = 0.15; // -> "Tags" ~85% blank

const P_DECLINES_ETHNICITY = 0.03;
const P_SECOND_ETHNICITY = 0.22; // the multi-select case, per PRD open decision 7
const P_THIRD_ETHNICITY = 0.04;

const P_FIRST_GENERATION = 0.22;

export interface ApplicantProfile {
  sourceRowIndex: number;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  /// Keyed by FieldSpec.key.
  values: Record<string, string>;
  /// Which of the ten one-hot ethnicity columns this applicant checked.
  ethnicities: string[];
}

function stripDiacritics(value: string): string {
  // Strip combining marks so "Tomás Sørensen" yields a usable email local part.
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function buildEssay(rng: Rng, key: EssayKey): string {
  const pool = ESSAY_POOLS[key];
  const middles = rng.shuffle(pool.middles).slice(0, rng.int(2, 3));
  return [rng.pick(pool.openers), ...middles, rng.pick(pool.closers)].join(" ");
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function pickEthnicities(rng: Rng): Set<string> {
  const chosen = new Set<string>();
  if (rng.chance(P_DECLINES_ETHNICITY)) return chosen;

  chosen.add(rng.weighted(ETHNICITY_WEIGHTS));

  // An applicant may check any number of the ten columns. This is the case that
  // makes the demographic breakdowns in FR-11 and FR-19 non-trivial, so the seed
  // has to produce it often enough to notice.
  if (rng.chance(P_SECOND_ETHNICITY)) {
    chosen.add(rng.weighted(ETHNICITY_WEIGHTS));
  }
  if (chosen.size > 1 && rng.chance(P_THIRD_ETHNICITY)) {
    chosen.add(rng.weighted(ETHNICITY_WEIGHTS));
  }

  return chosen;
}

/// Values keyed by FieldSpec.key, plus the ethnicity set, which is handled
/// separately because ten one-hot columns share a single key.
function buildValues(rng: Rng) {
  const major = rng.chance(P_MAJOR_IS_OTHER) ? "Other" : rng.pick(MAJORS_WITHOUT_OTHER);

  const hasSecondMajor = rng.chance(P_HAS_SECOND_MAJOR);
  const secondMajor = hasSecondMajor
    ? rng.chance(P_SECOND_MAJOR_IS_OTHER)
      ? "Other"
      : rng.pick(MAJORS_WITHOUT_OTHER)
    : "";

  // The application window: three weeks, with stage and submit trailing start.
  const startedAt = new Date(
    Date.UTC(2026, 0, 5, 9, 0, 0) + rng.int(0, 21 * 24 * 60) * 60_000,
  );
  const stagedAt = new Date(startedAt.getTime() + rng.int(2, 90) * 60_000);
  const submittedAt = new Date(stagedAt.getTime() + rng.int(0, 240) * 60_000);

  const ethnicities = pickEthnicities(rng);

  const scalar: Record<string, string> = {
    graduationDate: rng.pick(GRADUATION_DATES),
    major,
    otherMajor: major === "Other" ? rng.pick(WRITE_IN_MAJORS) : "",
    secondMajor,
    otherSecondMajor: secondMajor === "Other" ? rng.pick(WRITE_IN_MAJORS) : "",
    minor: rng.chance(P_HAS_MINOR) ? rng.pick(MINORS) : "",
    heardAbout: rng.pick(HEARD_ABOUT),

    essayJourney: buildEssay(rng, "essayJourney"),
    essayExperience: buildEssay(rng, "essayExperience"),
    essayCared: buildEssay(rng, "essayCared"),
    essayProblem: buildEssay(rng, "essayProblem"),
    essayMission: buildEssay(rng, "essayMission"),
    essayChangedMind: buildEssay(rng, "essayChangedMind"),
    anythingElse: rng.chance(P_HAS_ANYTHING_ELSE) ? buildEssay(rng, "anythingElse") : "",

    pronouns: rng.pick(PRONOUNS),
    ethnicitySelfDescribed: rng.chance(P_SELF_DESCRIBES_ETHNICITY)
      ? rng.pick(SELF_DESCRIBED_ETHNICITIES)
      : "",
    firstGeneration: rng.chance(P_FIRST_GENERATION) ? "Yes" : "No",

    // Junk columns. "Response Type" and "Ending" are identical on every row —
    // zero variance across 150 rows is what makes a column obviously excludable.
    responseType: "Completed",
    startDate: formatTimestamp(startedAt),
    stageDate: formatTimestamp(stagedAt),
    submitDate: formatTimestamp(submittedAt),
    networkId: Array.from({ length: 12 }, () => rng.int(0, 15).toString(16)).join(""),
    tags: rng.chance(P_HAS_TAG) ? rng.pick(TAGS) : "",
    ending: ENDING_TEMPLATE,
  };

  return { scalar, ethnicities };
}

export function buildApplicantProfiles(rng: Rng, count: number): ApplicantProfile[] {
  const usedEmails = new Set<string>();
  const profiles: ApplicantProfile[] = [];

  for (let i = 0; i < count; i += 1) {
    const firstName = rng.pick(FIRST_NAMES);
    const lastName = rng.pick(LAST_NAMES);

    const base = stripDiacritics(`${firstName[0]}${lastName}`)
      .toLowerCase()
      .replace(/[^a-z]/g, "");

    let local = base;
    let suffix = 1;
    while (usedEmails.has(local)) {
      suffix += 1;
      local = `${base}${suffix}`;
    }
    usedEmails.add(local);

    const { scalar, ethnicities } = buildValues(rng);

    profiles.push({
      sourceRowIndex: i + 1,
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`,
      email: `${local}@usc.edu`,
      values: scalar,
      ethnicities: [...ethnicities],
    });
  }

  return profiles;
}

/// Turns a profile into the JSONB payload: { fieldId: value }. Never keyed by
/// header text, so renaming a column in Phase 1 cannot orphan a value.
export function buildApplicantData(
  profile: ApplicantProfile,
  specs: readonly (FieldSpec & { id: string })[],
): Record<string, string> {
  const ethnicities = new Set(profile.ethnicities);
  const data: Record<string, string> = {};

  for (const spec of specs) {
    if (spec.key === "ethnicityOneHot") {
      const label = spec.optionLabel ?? "";
      // One-hot columns carry the option's own label when checked and are empty
      // when not, which is what the form tool actually exports.
      data[spec.id] = ethnicities.has(label) ? label : "";
      continue;
    }
    data[spec.id] = profile.values[spec.key] ?? "";
  }

  return data;
}
