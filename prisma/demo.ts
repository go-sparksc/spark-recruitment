// Training material. PRD decision 97, BUILD_PLAN Phase 8.
//
// Run with:  npm run seed:demo
//
// Produces the two things a board member needs to learn this tool, and nothing
// else:
//
//   1. `prisma/fixtures/demo-cycle.csv` — 25 applicants, the file the trainee
//      uploads as their OWN cycle. Twenty-five rather than 150 because the gate
//      asks them to run a complete cycle start to finish, and a mock cycle at
//      production scale is not clickable in one sitting. A trainee who shortcuts
//      the scoring is no longer testing the documentation.
//
//   2. A reference cycle carried all the way to COMPLETE, for comparing against
//      when a screen does not look the way ADMIN_GUIDE.md says it should.
//
// **No second synthetic dataset**, per decision 97 — and the reuse is at the
// level of code rather than of data. The CSV's rows come from
// `buildApplicantProfiles` and `buildApplicantData`, the same two functions the
// seed itself uses, so the one-hot ethnicity encoding cannot drift between the
// file a trainee imports and the data the seed produces. The reference cycle is
// `prisma/seed.ts` → `advance.ts` → `passes.ts` run verbatim under a second
// instance id.
//
// **The reference cycle stays at 150 applicants**, unlike the CSV. It is for
// looking at, not for clicking through, and `advance.ts` and `passes.ts` carry
// cohort sizes (FIRST_ROUND_ADVANCE_COUNT and the pass plans) written against
// that scale — running them over 25 applicants would ask for more advancing
// applicants than exist. Shrinking the reference would mean rewriting the seed's
// internals, which decision 97's "reuse the existing seed" rules out.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { FieldCategory, FieldGroupRole } from "../generated/prisma/enums";
import { toCsv, type CsvValue } from "../lib/export-csv";
import { createRng } from "../lib/rng";
import { buildApplicantData, buildApplicantProfiles, type ApplicantProfile } from "./seed/applicants";
import { buildFieldSpecs, type FieldSpec } from "./seed/fields";

/// Fixed, so the file regenerates byte-identically. A demo CSV that changed on
/// every run would make ADMIN_GUIDE.md's screenshots wrong the first time anyone
/// re-ran this.
const DEMO_RNG_SEED = 20260830;
const DEMO_APPLICANT_COUNT = 25;

const DEMO_INSTANCE_ID = "demo_reference";
const DEMO_INSTANCE_NAME = "Demo Cycle (finished — for reference)";

const CSV_PATH = path.join(process.cwd(), "prisma", "fixtures", "demo-cycle.csv");

// ---------------------------------------------------------------------------
// The CSV
// ---------------------------------------------------------------------------

/// The columns a real export has, in order: the four promoted ones, then every
/// field in the seed's catalog.
///
/// Header text comes from `buildFieldSpecs`, which reads the real export's
/// header row — so this file carries the same hazards Phase 1 was built against:
/// the 200-character prompt, curly apostrophes, an embedded newline, a trailing
/// space.
function buildDemoCsv(): string {
  const specs = buildFieldSpecs();
  const rng = createRng(DEMO_RNG_SEED);
  const profiles = buildApplicantProfiles(rng, DEMO_APPLICANT_COUNT);

  ensureEveryOptionIsChecked(specs, profiles);

  const headers = [
    "#",
    "First Name",
    "Last Name",
    "Email Address",
    ...specs.map((spec) => spec.sourceHeader),
  ];

  // Keyed by ordinal rather than by a database id, which is the one liberty this
  // takes: `buildApplicantData` maps a profile onto whatever `id` its specs
  // carry, so giving each spec its ordinal yields column -> value directly and
  // the one-hot encoding stays in the seed's own function rather than being
  // written a second time here.
  const specsByColumn = specs.map((spec) => ({ ...spec, id: String(spec.ordinal) }));

  const rows: CsvValue[][] = profiles.map((profile) => {
    const values = buildApplicantData(profile, specsByColumn);

    return [
      profile.sourceRowIndex,
      profile.firstName,
      profile.lastName,
      safeEmail(profile.email),
      ...specs.map((spec) => safeCell(spec, values[String(spec.ordinal)] ?? "")),
    ];
  });

  return toCsv(headers, rows);
}

/// Make sure every one-hot ethnicity column is checked by at least one
/// applicant.
///
/// **Without this the demo file teaches the wrong thing.** The seed picks
/// ethnicities by weight, so across only 25 rows the rarest options — Central
/// Asian and Native Hawaiian/Pacific Islander, on the seed's distribution — come
/// out checked by nobody. A column that is entirely empty has no value
/// signature, so FR-2's group detection cannot recognise it, and the run of ten
/// one-hot columns is offered to the admin as THREE separate groups split around
/// the empty ones.
///
/// The detector is right to do that; `prisma/fixtures/README.md` documents the
/// empty-column trap for `s26-shape.csv` deliberately. It is the fixture that is
/// wrong for its purpose: a trainee following the guide would create three
/// "Ethnicity" groups, and §10.7's 1/n weighting has to run over one group of
/// ten or every demographic number is wrong.
///
/// Found by clicking through the mapping screen while writing ADMIN_GUIDE.md,
/// which is the Phase 8 gate doing its job a slice early.
///
/// Deterministic: options are filled in catalog order onto applicants chosen by
/// index, so the file stays byte-stable across runs.
function ensureEveryOptionIsChecked(
  specs: readonly FieldSpec[],
  profiles: ApplicantProfile[],
): void {
  const labels = specs
    .filter((spec) => spec.groupRole === FieldGroupRole.OPTION && spec.optionLabel)
    .map((spec) => spec.optionLabel as string);

  const checked = new Set(profiles.flatMap((profile) => profile.ethnicities));
  const missing = labels.filter((label) => !checked.has(label));

  missing.forEach((label, i) => {
    // Spread across distinct applicants rather than piling onto one, so the
    // added checks read as ordinary multi-select answers rather than as one
    // implausible person who ticked every rare box.
    const profile = profiles[i % profiles.length];
    if (!profile.ethnicities.includes(label)) profile.ethnicities.push(label);
  });

  if (missing.length > 0) {
    console.log(`  filled ${missing.length} unchecked ethnicity column(s): ${missing.join(", ")}`);
  }
}

/// The seed writes `@usc.edu` addresses, because it is imitating the real
/// export and those rows never leave the database. **This file is committed**,
/// which is a different rule: `prisma/fixtures/README.md` requires every address
/// use `example.com`, the domain RFC 2606 reserves for documentation, so that
/// nothing in the repository can collide with a real USC address.
///
/// A synthetic name at a real domain is exactly the kind of near-miss that
/// makes a fixture unsafe to commit.
function safeEmail(email: string): string {
  return email.replace(/@usc\.edu$/i, "@example.com");
}

/// Free-text cells are prefixed `SYNTHETIC`, matching every other committed
/// fixture, so a cell that leaks into a screenshot or a log is self-identifying.
///
/// **Applied to prose only.** The ten one-hot ethnicity columns must contain
/// their own header label verbatim — that is what "checked" means (§10.7), and a
/// prefix would silently break the demographic counting on the very file the
/// trainee is learning from. Structured answers (major, graduation date,
/// pronouns) are left alone for the same reason: they are drawn from fixed
/// vocabularies that the mapping step matches against.
function safeCell(spec: { category: FieldCategory; groupRole: FieldGroupRole | null }, value: string): string {
  if (value.trim() === "") return value;

  const isProse =
    spec.category === FieldCategory.RESPONSE || spec.groupRole === FieldGroupRole.FREE_TEXT;

  return isProse ? `SYNTHETIC ${value}` : value;
}

// ---------------------------------------------------------------------------
// The reference cycle
// ---------------------------------------------------------------------------

/// Run one of the seed scripts under the demo instance's identity.
///
/// `spawnSync` with an env override rather than a `VAR=x` command prefix: npm
/// scripts run through cmd.exe on Windows, where that prefix is not a thing —
/// the same reason `.env.example` explains for NODE_OPTIONS.
function runSeedScript(script: string): void {
  const result = spawnSync(
    process.execPath,
    [path.join("node_modules", "tsx", "dist", "cli.mjs"), script],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        SEED_INSTANCE_ID: DEMO_INSTANCE_ID,
        SEED_INSTANCE_NAME: DEMO_INSTANCE_NAME,
        // The reference cycle is training material and gets screenshotted into
        // ADMIN_GUIDE.md, where the final-class screen shows addresses. RFC 2606
        // domains only, for the reason prisma/fixtures/README.md gives about the
        // CSVs: a synthetic name at a real domain is safe in a local database
        // and unsafe in an image in the repository.
        SEED_EMAIL_DOMAIN: "example.com",
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(`${script} exited with ${result.status ?? "a signal"}`);
  }
}

function main(): void {
  const csv = buildDemoCsv();
  writeFileSync(CSV_PATH, csv, "utf8");
  console.log(`Wrote ${CSV_PATH}`);
  console.log(`  ${DEMO_APPLICANT_COUNT} applicants, ${csv.split("\n")[0].split(",").length}+ columns`);
  console.log("");

  console.log(`Building the reference cycle as "${DEMO_INSTANCE_NAME}" (${DEMO_INSTANCE_ID})…`);
  console.log("");
  runSeedScript(path.join("prisma", "seed.ts"));
  runSeedScript(path.join("prisma", "advance.ts"));
  runSeedScript(path.join("prisma", "passes.ts"));

  console.log("");
  console.log("Demo material ready.");
  console.log(`  reference cycle   /instances/${DEMO_INSTANCE_ID}`);
  console.log(`  CSV to import     prisma/fixtures/demo-cycle.csv`);
  console.log("");
  console.log("The development seed (seed_s26_demo) is untouched — the two coexist.");
}

main();
