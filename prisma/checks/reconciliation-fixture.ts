// Scratch verification: do the FR-13 fixtures still resolve the way
// prisma/fixtures/README.md says they do?
//
// Run with:  npx tsx prisma/checks/reconciliation-fixture.ts
//
// WHY THIS SCRIPT IS LOAD-BEARING. BUILD_PLAN's Phase 5 gate is "import a scores
// file where three names are deliberately wrong, and confirm all three land in
// the unresolved queue rather than being guessed at". That gate is a browser
// exercise, and until Slice 5 builds the screen there is nothing to click. This
// runs the same three moving parts the screen will — the seeded pool, the
// committed fixture, and lib/reconciliation.ts — and asserts the result.
//
// It also outlives the screen, because it catches a failure the screen cannot:
// the fixture and the pinned cohort drifting apart. If someone renames a pinned
// applicant, or an editor strips the padding off row 11's email, the affected
// rows quietly start landing in the unresolved queue and the gate goes on
// "passing" while testing nothing. The README's checklist says to verify these
// by hand; this is that checklist, executed.
//
// UNLIKE the other scripts in this directory, this one WRITES NOTHING. It reads
// the seeded pool and two committed files, so there is nothing to clean up and
// nothing it can leave behind.

import { readFileSync } from "node:fs";

import { parseCsv } from "../../lib/import/parse-csv";
import { findBatchCollisions, matchRow, type Candidate } from "../../lib/reconciliation";
import { SEED_INSTANCE_ID, createSeedClient } from "../seed/client";

const prisma = createSeedClient();

/// What each fixture row should come back as. Mirrors the tables in
/// prisma/fixtures/README.md — if the two disagree, one of them is a bug.
type Expectation =
  | { kind: "MATCHED"; tier: "EMAIL" | "NAME" | "FUZZY"; displayName: string }
  | { kind: "AMBIGUOUS"; tier: "EMAIL" | "NAME" | "FUZZY"; count: number }
  | { kind: "UNRESOLVED"; reason: "NO_IDENTITY" | "NO_CANDIDATES" };

const SCORES_EXPECTED: Record<number, Expectation> = {
  1: { kind: "MATCHED", tier: "EMAIL", displayName: "Cecilia Fang" },
  2: { kind: "MATCHED", tier: "FUZZY", displayName: "Cecilia Fang" },
  3: { kind: "AMBIGUOUS", tier: "FUZZY", count: 2 },
  4: { kind: "MATCHED", tier: "EMAIL", displayName: "Megan Woods" },
  5: { kind: "MATCHED", tier: "NAME", displayName: "Casey O'Brien" },
  6: { kind: "MATCHED", tier: "EMAIL", displayName: "Casey O'Brien" },
  7: { kind: "UNRESOLVED", reason: "NO_CANDIDATES" },
  8: { kind: "MATCHED", tier: "EMAIL", displayName: "Nia Chen" },
  9: { kind: "MATCHED", tier: "NAME", displayName: "Jordan Lee" },
  10: { kind: "MATCHED", tier: "EMAIL", displayName: "Jordan Lee" },
  11: { kind: "MATCHED", tier: "EMAIL", displayName: "Priya Raman" },
  12: { kind: "UNRESOLVED", reason: "NO_CANDIDATES" },
  13: { kind: "UNRESOLVED", reason: "NO_IDENTITY" },
  14: { kind: "UNRESOLVED", reason: "NO_CANDIDATES" },
  15: { kind: "MATCHED", tier: "EMAIL", displayName: "Wren Ashford" },
  16: { kind: "MATCHED", tier: "NAME", displayName: "Wren Ashford" },
  17: { kind: "MATCHED", tier: "EMAIL", displayName: "Maegan Woods" },
  18: { kind: "MATCHED", tier: "NAME", displayName: "Priya Raman" },
};

const NOTES_EXPECTED: Record<number, Expectation> = {
  1: { kind: "MATCHED", tier: "EMAIL", displayName: "Casey O'Brien" },
  2: { kind: "MATCHED", tier: "FUZZY", displayName: "Cecilia Fang" },
  3: { kind: "AMBIGUOUS", tier: "FUZZY", count: 2 },
  4: { kind: "UNRESOLVED", reason: "NO_CANDIDATES" },
  5: { kind: "MATCHED", tier: "EMAIL", displayName: "Jordan Lee" },
  6: { kind: "MATCHED", tier: "NAME", displayName: "Jordan Lee" },
  7: { kind: "UNRESOLVED", reason: "NO_IDENTITY" },
  8: { kind: "MATCHED", tier: "EMAIL", displayName: "Priya Raman" },
};

/// The gate's own sentence: three names deliberately wrong, all three unresolved.
const GATE_ROWS = [7, 12, 14];

let failures = 0;

function pass(label: string, detail: string) {
  console.log(`PASS  ${label}\n        ${detail}`);
}

function fail(label: string, detail: string) {
  failures += 1;
  console.log(`FAIL  ${label}\n        ${detail}`);
}

function describe(outcome: ReturnType<typeof matchRow>, names: Map<string, string>): string {
  if (outcome.kind === "MATCHED") {
    return `${outcome.tier} -> ${names.get(outcome.applicantId) ?? outcome.applicantId}${
      outcome.confidence === null ? "" : ` (${outcome.confidence.toFixed(3)})`
    }`;
  }
  if (outcome.kind === "AMBIGUOUS") {
    return `AMBIGUOUS/${outcome.tier} over ${outcome.candidates
      .map((c) => names.get(c.applicantId) ?? c.applicantId)
      .join(", ")}`;
  }
  return `UNRESOLVED/${outcome.reason}`;
}

function matches(
  outcome: ReturnType<typeof matchRow>,
  expected: Expectation,
  names: Map<string, string>,
): boolean {
  if (outcome.kind !== expected.kind) return false;
  if (outcome.kind === "MATCHED" && expected.kind === "MATCHED") {
    return outcome.tier === expected.tier && names.get(outcome.applicantId) === expected.displayName;
  }
  if (outcome.kind === "AMBIGUOUS" && expected.kind === "AMBIGUOUS") {
    return outcome.tier === expected.tier && outcome.candidates.length === expected.count;
  }
  if (outcome.kind === "UNRESOLVED" && expected.kind === "UNRESOLVED") {
    return outcome.reason === expected.reason;
  }
  return false;
}

/// Column index for a header, by exact text. Exact, never `includes` — the
/// applicant fixture's `Black` / `Black or African American` pair is the standing
/// reminder of what loose header matching does.
function columnOf(headers: readonly string[], name: string): number {
  const index = headers.findIndex((header) => header.trim() === name);
  if (index === -1) throw new Error(`Fixture is missing a "${name}" column.`);
  return index;
}

async function runSheet(
  label: string,
  path: string,
  interviewerColumn: string,
  expected: Record<number, Expectation>,
  pool: Candidate[],
  names: Map<string, string>,
  sheet: "SCORES" | "NOTES",
) {
  const { headers, rows } = parseCsv(readFileSync(path));

  const emailColumn = columnOf(headers, "Applicant Email");
  const nameColumn = columnOf(headers, "Applicant Name");
  const interviewer = columnOf(headers, interviewerColumn);

  console.log(`\n--- ${label}: ${rows.length} rows ---`);

  const resolved: { rowIndex: number; applicantId: string; interviewerName: string }[] = [];
  let wrong = 0;

  rows.forEach((cells, index) => {
    const rowIndex = index + 1;
    const outcome = matchRow({ email: cells[emailColumn], name: cells[nameColumn] }, pool);
    const want = expected[rowIndex];
    const ok = want !== undefined && matches(outcome, want, names);

    if (!ok) wrong += 1;
    console.log(
      `  ${ok ? "ok  " : "WRONG"} row ${String(rowIndex).padStart(2)}  ${describe(outcome, names)}`,
    );

    if (outcome.kind === "MATCHED") {
      resolved.push({
        rowIndex,
        applicantId: outcome.applicantId,
        interviewerName: cells[interviewer],
      });
    }
  });

  if (wrong === 0) {
    pass(`${label}: every row resolves as documented`, `${rows.length} rows against README.md`);
  } else {
    fail(`${label}: rows disagree with README.md`, `${wrong} of ${rows.length} rows`);
  }

  return findBatchCollisions(resolved, sheet);
}

async function main() {
  // PRD decision 48's scoping, done here exactly as the FR-12 import will do it.
  // Widening this query is the single easiest way to reintroduce the wrong-match
  // class the decision removes.
  const scoped = await prisma.applicant.findMany({
    where: { instanceId: SEED_INSTANCE_ID, stageReached: { not: "WRITTEN" } },
    select: { id: true, email: true, displayName: true },
  });

  if (scoped.length === 0) {
    throw new Error(
      "No applicants have reached the first round. Run `npm run seed` — it finalizes the " +
        "written round and pins the cohort these fixtures name.",
    );
  }

  const pool: Candidate[] = scoped.map((a) => ({
    applicantId: a.id,
    email: a.email,
    displayName: a.displayName,
  }));
  const names = new Map(scoped.map((a) => [a.id, a.displayName]));

  console.log(`Instance    ${SEED_INSTANCE_ID}`);
  console.log(`Scoped pool ${pool.length} applicants with stageReached != WRITTEN`);

  const scoresCollisions = await runSheet(
    "Scores sheet",
    "prisma/fixtures/s26-1r-scores.csv",
    "Interviewer Name",
    SCORES_EXPECTED,
    pool,
    names,
    "SCORES",
  );

  const notesCollisions = await runSheet(
    "Notes sheet",
    "prisma/fixtures/s26-1r-notes.csv",
    "Your Name",
    NOTES_EXPECTED,
    pool,
    names,
    "NOTES",
  );

  console.log("");

  // --- BUILD_PLAN's gate, stated as an assertion ----------------------------
  const gateOutcomes = GATE_ROWS.map((rowIndex) => SCORES_EXPECTED[rowIndex]);
  const allUnresolved = gateOutcomes.every((o) => o.kind === "UNRESOLVED");
  if (allUnresolved && failures === 0) {
    pass(
      "BUILD_PLAN gate: three deliberately wrong names, none guessed at",
      `scores rows ${GATE_ROWS.join(", ")} — Mia Chen, Cecilia Fong, Bartholomew Quiggleston`,
    );
  } else {
    fail("BUILD_PLAN gate", "at least one deliberately wrong name did not land unresolved");
  }

  // --- PRD decisions 49 and 50 ---------------------------------------------
  const scoresCollided = scoresCollisions.map((c) => c.rowIndexes.join("+")).join(", ");
  if (scoresCollisions.length === 1 && scoresCollisions[0].rowIndexes.join("+") === "9+10") {
    pass(
      "Decision 50: scores collide on (applicant, interviewer), not on applicant",
      "rows 9 and 10 — same applicant, same interviewer, reached by different tiers",
    );
  } else {
    fail("Decision 50 on the scores sheet", `expected one collision on rows 9+10, got [${scoresCollided}]`);
  }

  // Rows 1 and 2 both resolve to Cecilia Fang from DIFFERENT interviewers, which
  // is FR-12's expected shape and must NOT be flagged. The assertion above covers
  // it by exclusion; stated here so the reason is on the record.
  const notesCollided = notesCollisions.map((c) => c.rowIndexes.join("+")).join(", ");
  if (notesCollisions.length === 1 && notesCollisions[0].rowIndexes.join("+") === "5+6") {
    pass(
      "Decision 50: notes collide on applicant alone",
      "rows 5 and 6 — one applicant, two rows, which the scores key would have allowed",
    );
  } else {
    fail("Decision 50 on the notes sheet", `expected one collision on rows 5+6, got [${notesCollided}]`);
  }
}

main()
  .catch((error) => {
    failures += 1;
    console.error("\nUnexpected error:", error);
  })
  .finally(async () => {
    console.log("");
    console.log(failures === 0 ? "RESULT: all checks passed" : `RESULT: ${failures} check(s) failed`);
    process.exitCode = failures === 0 ? 0 : 1;
    await prisma.$disconnect();
  });
