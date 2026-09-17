// A throwaway instance shaped like a real cycle stopped at FR-12's upload step.
// PRD decision 120.
//
// Run with:
//
//   SEED_INSTANCE_ID=throwaway_f26_shape npx tsx prisma/throwaway.ts \
//     --notes="<path to the notes sheet CSV>" \
//     --scores="<path to the evaluation sheet CSV>"
//
// WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT.
//
// It creates an instance, an interview rubric taken from the evaluation sheet's
// own score headers, a first-round reviewer roster, and one applicant per
// distinct name in the notes sheet, every one of them at
// `stageReached = FIRST_ROUND`.
//
// It does **not** import the interview data. The two CSVs are meant to be
// uploaded through the real admin screens, because that upload is the thing
// under test. A script that pre-imported them would be a second implementation
// of `commitInterviewSheet`, and a green run would prove that second copy works.
//
// WHY IT READS THE REAL FILES RATHER THAN SHIPPING A FIXTURE.
//
// FR-13 matches an interview row to an applicant by name, so a throwaway whose
// applicants are called "Applicant 1" tests the importer against a pool the real
// sheets can never match — every row would land unresolved and the reconcile
// screen would be the only thing exercised. The applicant names have to be the
// sheet's names for any of this to mean anything.
//
// So the names are read from the CSV at the path you pass, at run time, and
// **nothing real is ever written into the repository**: no fixture is generated,
// no file is copied, and `.gitignore` already covers `*.csv`, `*.xlsx`, `/data`
// and `/uploads`. Everything about each applicant other than their name — email,
// every field value — is synthetic and generated here. CLAUDE.md's rule 3 is
// about applicant records entering the repo; this keeps them in the database of
// a cycle you are about to delete.
//
// The instance this creates is disposable by construction. Delete it from the
// dashboard when the test is done.

import { existsSync, readFileSync } from "node:fs";

import { ApplicantStatus, FieldCategory, Round, TermSeason } from "../generated/prisma/enums";
import { createSeedClient, SEED_INSTANCE_ID } from "./seed/client";
import { createRng } from "../lib/rng";
import { hashSecret } from "../lib/password";
import { parseCsv } from "../lib/import/parse-csv";

const prisma = createSeedClient();

const INSTANCE_NAME = process.env.SEED_INSTANCE_NAME ?? "F26 shape test (throwaway)";
const PASSWORD = "throwaway-dev-password";
const ROUND_CODES: Record<Round, string> = {
  [Round.WRITTEN]: "written-throwaway",
  [Round.FIRST_ROUND]: "firstround-throwaway",
  [Round.SECOND_ROUND]: "secondround-throwaway",
};

/// **The guard that makes this script safe to run.** `SEED_INSTANCE_ID` is
/// overridable by environment and every script that reads it deletes and
/// recreates "its own" instance — `prisma/seed/client.ts` says so in plain terms,
/// and says that pointing it at a real instance would destroy it.
///
/// This script is the most likely of them to be run with the variable set by
/// hand, in a hurry, on the day of a real cycle. So it refuses any id that is not
/// visibly disposable, and refuses a second time if the target holds committed
/// interview data. Neither check is clever; both are cheap, and the thing they
/// prevent is unrecoverable.
const REQUIRED_PREFIX = "throwaway_";

const SYNTHETIC_QUESTIONS = [
  { header: "What are you studying?", answers: ["Computer Science", "Business Administration", "Biomedical Engineering", "Design", "Economics"] },
  { header: "Why do you want to join Spark SC?", answers: ["Synthetic answer — the written application is not what this test is about.", "Synthetic answer — see the interview sheets for the content under test."] },
  { header: "When do you graduate?", answers: ["Spring 2027", "Fall 2027", "Spring 2028", "Fall 2028", "Spring 2029"] },
];

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found?.slice(prefix.length);
}

/// Read one column out of a CSV, in file order, keeping the first occurrence of
/// each distinct value. The notes sheet is one row per applicant, so this is the
/// applicant list; deduplicating anyway means a re-exported sheet with a stray
/// duplicate row does not produce two applicants with one name — which FR-13
/// would then report as an ambiguous match on every row.
function distinctColumn(csvPath: string, headerName: string): string[] {
  if (!existsSync(csvPath)) {
    throw new Error(`No file at ${csvPath}`);
  }
  const parsed = parseCsv(readFileSync(csvPath));
  const columnIndex = parsed.headers.findIndex(
    (header) => header.trim().toLowerCase() === headerName.toLowerCase(),
  );
  if (columnIndex === -1) {
    throw new Error(
      `No "${headerName}" column in ${csvPath}. Its headers are:\n  ` +
        parsed.headers.map((h) => JSON.stringify(h.slice(0, 60))).join("\n  "),
    );
  }

  const seen = new Set<string>();
  const values: string[] = [];
  for (const row of parsed.rows) {
    const value = (row[columnIndex] ?? "").trim();
    if (value === "" || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    values.push(value);
  }
  return values;
}

/// The evaluation sheet's score headers, which become the interview rubric.
///
/// **Taken as the columns that are neither the fixed ones nor a `Notes on …`**,
/// rather than by position, so a sheet with a different number of categories
/// still works. This is a fixture builder and is allowed to infer; the importer
/// it is setting up for is not, and still asks the admin to confirm every column.
function scoreHeaders(csvPath: string): string[] {
  if (!existsSync(csvPath)) throw new Error(`No file at ${csvPath}`);
  const parsed = parseCsv(readFileSync(csvPath));

  const fixed = new Set([
    "timestamp",
    "your name",
    "applicant name",
    "applicant email",
    "email address",
    "interviewer name",
    "average",
    "additional notes",
  ]);

  return parsed.headers.filter((header) => {
    const key = header.trim().toLowerCase();
    if (fixed.has(key)) return false;
    if (key.startsWith("notes on ")) return false;
    // The recommendation column is a question, so it ends in a question mark
    // where a category name does not. Narrow and stated rather than clever.
    if (key.endsWith("?")) return false;
    return header.trim() !== "";
  });
}

async function main() {
  const notesPath = arg("notes");
  const scoresPath = arg("scores");

  if (!notesPath || !scoresPath) {
    throw new Error(
      "Both --notes=<path> and --scores=<path> are required.\n" +
        "They are read at run time and never copied into the repository.",
    );
  }

  if (!SEED_INSTANCE_ID.startsWith(REQUIRED_PREFIX)) {
    throw new Error(
      `SEED_INSTANCE_ID is "${SEED_INSTANCE_ID}", which does not start with "${REQUIRED_PREFIX}".\n` +
        "This script deletes and recreates whatever id it is given. Set it to something\n" +
        `like ${REQUIRED_PREFIX}f26_shape, and never to a real cycle's id.`,
    );
  }

  const existingResults = await prisma.interviewResult.count({
    where: { applicant: { instanceId: SEED_INSTANCE_ID } },
  });
  const existingCommit = await prisma.instance.count({
    where: { id: SEED_INSTANCE_ID, importCommittedAt: { not: null } },
  });
  if (existingResults > 0 || existingCommit > 0) {
    throw new Error(
      `Instance ${SEED_INSTANCE_ID} already holds committed data ` +
        `(${existingResults} interview result rows). Refusing to delete it.\n` +
        "Delete it from the dashboard first if that is really what you want.",
    );
  }

  const applicantNames = distinctColumn(notesPath, "Applicant Name");
  const interviewerNames = distinctColumn(scoresPath, "Your Name");
  const categories = scoreHeaders(scoresPath);

  if (applicantNames.length === 0) throw new Error("The notes sheet produced no applicant names.");
  if (categories.length === 0) throw new Error("The evaluation sheet produced no score columns.");

  console.log(`Applicants   ${applicantNames.length} names read from the notes sheet`);
  console.log(`Interviewers ${interviewerNames.length} distinct names in the evaluation sheet`);
  console.log(`Rubric       ${categories.length} categories, named exactly as the sheet spells them:`);
  for (const name of categories) console.log(`               ${JSON.stringify(name)}`);
  console.log("");

  await prisma.instance.deleteMany({ where: { id: SEED_INSTANCE_ID } });

  const [passwordHash, ...codeHashes] = await Promise.all([
    hashSecret(PASSWORD),
    ...Object.values(ROUND_CODES).map((code) => hashSecret(code)),
  ]);

  await prisma.instance.create({
    data: {
      id: SEED_INSTANCE_ID,
      name: INSTANCE_NAME,
      passwordHash,
      // Already past the written round: FR-12's pool is `stageReached != WRITTEN`
      // and the interview screens belong to the first round.
      currentStage: "FIRST_ROUND",
      // Committed, so the instance behaves like one whose applicant CSV is in.
      importCommittedAt: new Date(),
      // Decision 119, so the class-standing line renders rather than being
      // silently absent and looking like a bug during the test.
      currentTermSeason: TermSeason.FALL,
      currentTermYear: 2026,
      fields: {
        create: SYNTHETIC_QUESTIONS.map((question, ordinal) => ({
          id: `${SEED_INSTANCE_ID}_field_${ordinal}`,
          sourceHeader: question.header,
          displayName: question.header,
          category: FieldCategory.RESPONSE,
          ordinal,
          isReviewerVisible: true,
          isGraduationDate: question.header === "When do you graduate?",
        })),
      },
      interviewCategories: {
        create: categories.map((name, ordinal) => ({
          id: `${SEED_INSTANCE_ID}_cat_${ordinal}`,
          name,
          // Every score in the real file is 1-4. Not read from the data on
          // purpose: a max inferred from the values would move if one interviewer
          // never awarded a 4, and decision 55's out-of-range flag is one of the
          // things this test should be able to see fire.
          maxPoints: 4,
          ordinal,
        })),
      },
      roundAccessCodes: {
        create: Object.keys(ROUND_CODES).map((round, index) => ({
          id: `${SEED_INSTANCE_ID}_code_${index}`,
          round: round as Round,
          codeHash: codeHashes[index],
        })),
      },
    },
  });

  const rng = createRng(20260917);

  await prisma.applicant.createMany({
    data: applicantNames.map((displayName, index) => ({
      id: `${SEED_INSTANCE_ID}_app_${String(index).padStart(3, "0")}`,
      instanceId: SEED_INSTANCE_ID,
      sourceRowIndex: index + 2,
      // Synthetic. Deliberately NOT derived from the real name: an address built
      // out of it would be a second copy of the name in a column the sheets do
      // not carry, and FR-13's email tier would then match on data the real
      // import will not have.
      email: `applicant${index}@example.invalid`,
      displayName,
      data: Object.fromEntries(
        SYNTHETIC_QUESTIONS.map((question, ordinal) => [
          `${SEED_INSTANCE_ID}_field_${ordinal}`,
          rng.pick(question.answers),
        ]),
      ),
      status: ApplicantStatus.ACTIVE,
      // The whole point: FR-12's pool is scoped to applicants who reached the
      // first round (decision 48), so an applicant left at WRITTEN is invisible
      // to the importer and every row naming them lands unresolved.
      stageReached: Round.FIRST_ROUND,
    })),
  });

  // A roster large enough to open the first- and second-round dashboards. Names
  // are taken from the evaluation sheet so that a tester comparing the reviewer
  // list against an interview card sees the same people — including, on purpose,
  // the variant spellings the real sheets carry.
  await prisma.reviewer.createMany({
    data: interviewerNames.map((full, index) => {
      const parts = full.trim().split(/\s+/);
      return {
        id: `${SEED_INSTANCE_ID}_rev_${String(index).padStart(3, "0")}`,
        instanceId: SEED_INSTANCE_ID,
        firstName: parts[0] ?? full,
        lastName: parts.slice(1).join(" "),
        isSparklet: true,
        rounds: [Round.FIRST_ROUND, Round.SECOND_ROUND],
      };
    }),
  });

  console.log(`Created     ${INSTANCE_NAME}`);
  console.log(`  id            ${SEED_INSTANCE_ID}`);
  console.log(`  password      ${PASSWORD}`);
  console.log(`  first round   ${ROUND_CODES[Round.FIRST_ROUND]}`);
  console.log(`  second round  ${ROUND_CODES[Round.SECOND_ROUND]}`);
  console.log("");
  console.log("Next: upload both sheets at /instances/" + SEED_INSTANCE_ID + "/interviews");
  console.log("");
  console.log("Nothing real was written to the repository. Delete this instance when done.");
}

main()
  .catch((error) => {
    console.error("\n" + (error as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
