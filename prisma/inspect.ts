// The Phase 0 gate, made runnable.
//
// BUILD_PLAN: "You can query a synthetic applicant and see its JSONB `data` with
// field IDs resolving against the `Field` table." That is the first section
// below. The rest verifies the structural properties the seed exists to
// reproduce, because a seed that looks right at a glance and is subtly uniform
// is worse than no seed — Phase 1 would be built against it.

import { SEED_INSTANCE_ID, createSeedClient } from "./seed/client";

const prisma = createSeedClient();

const RULE = "-".repeat(78);

function truncate(value: string, max: number): string {
  const flat = value.replace(/\n/g, "\\n");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

async function main() {
  const instance = await prisma.instance.findUnique({
    where: { id: SEED_INSTANCE_ID },
    include: { rubricCategories: { orderBy: { ordinal: "asc" } } },
  });

  if (!instance) {
    throw new Error(`No seed instance found. Run \`npm run seed\` first.`);
  }

  const fields = await prisma.field.findMany({
    where: { instanceId: instance.id },
    orderBy: { ordinal: "asc" },
  });

  const fieldGroups = await prisma.fieldGroup.findMany({
    where: { instanceId: instance.id },
    orderBy: { ordinal: "asc" },
  });

  const applicants = await prisma.applicant.findMany({
    where: { instanceId: instance.id },
    orderBy: { sourceRowIndex: "asc" },
  });

  const reviewers = await prisma.reviewer.findMany({ where: { instanceId: instance.id } });

  const rows = applicants.map((applicant) => applicant.data as Record<string, string>);

  console.log(RULE);
  console.log(`Instance   ${instance.name}`);
  console.log(
    `Counts     ${fields.length} fields · ${applicants.length} applicants · ` +
      `${reviewers.length} reviewers (${reviewers.filter((r) => r.isSparklet).length} Sparklets) · ` +
      `${instance.rubricCategories.length} rubric categories`,
  );
  console.log(`Password   ${instance.passwordHash.slice(0, 24)}…  (argon2id, never plaintext)`);

  // --- The gate: one applicant's JSONB resolved against the Field table -------
  const sample = applicants[0];
  const sampleData = sample.data as Record<string, string>;

  console.log(RULE);
  console.log(`Applicant #${sample.sourceRowIndex}: ${sample.displayName} <${sample.email}>`);
  console.log(`  id ${sample.id} · status ${sample.status} · stageReached ${sample.stageReached}`);
  console.log("");
  console.log("  JSONB data keys resolved through the Field table:");
  console.log("");
  console.log(
    `  ${"cat".padEnd(4)} ${"inc".padEnd(3)} ${"display name".padEnd(34)} value`,
  );

  for (const field of fields) {
    const value = sampleData[field.id] ?? "";
    const category = field.category.slice(0, 4).toLowerCase();
    const included = field.isIncluded ? "yes" : "NO ";
    console.log(
      `  ${category.padEnd(4)} ${included} ${truncate(field.displayName, 34).padEnd(34)} ` +
        `${value === "" ? "(blank)" : truncate(value, 60)}`,
    );
  }

  const unresolved = Object.keys(sampleData).filter(
    (key) => !fields.some((field) => field.id === key),
  );
  console.log("");
  console.log(
    unresolved.length === 0
      ? "  Every data key resolves to a Field row. No key is header text."
      : `  ${unresolved.length} data key(s) do NOT resolve against Field: ${unresolved.join(", ")}`,
  );

  // --- Header shape ----------------------------------------------------------
  const lengths = fields.map((field) => field.sourceHeader.length);
  const withNewlines = fields.filter((field) => field.sourceHeader.includes("\n"));
  const withCurlyQuotes = fields.filter((field) => /[‘’“”]/.test(field.sourceHeader));
  const notTrimmed = fields.filter((field) => field.sourceHeader !== field.sourceHeader.trim());
  // Distinct from the above: a space sitting before the trailing newline, which
  // survives a naive `header.replace(/\n/g, "")` and quietly breaks equality checks.
  const withTrailingSpace = fields.filter((field) =>
    /\s$/.test(field.sourceHeader.replace(/\n+$/, "")),
  );
  const over200 = fields.filter((field) => field.sourceHeader.length > 200);

  console.log(RULE);
  console.log("Header shape — the things that break naive CSV handling");
  console.log(`  longest sourceHeader      ${Math.max(...lengths)} chars`);
  console.log(`  headers over 200 chars    ${over200.length}`);
  console.log(`  containing a newline      ${withNewlines.length}`);
  console.log(`  containing a curly quote  ${withCurlyQuotes.length}`);
  console.log(`  differing from .trim()    ${notTrimmed.length}`);
  console.log(`  space before the newline  ${withTrailingSpace.length}`);
  console.log("");
  for (const field of [...fields].sort((a, b) => b.sourceHeader.length - a.sourceHeader.length).slice(0, 3)) {
    console.log(`  ${String(field.sourceHeader.length).padStart(3)}  ${truncate(field.sourceHeader, 68)}`);
  }

  // --- Field groups ----------------------------------------------------------
  // Membership now comes from FieldGroup rather than a groupKey string repeated
  // across members, and category/inclusion/visibility live on the group so it
  // cannot end up half hidden and half visible (PRD section 5).
  console.log(RULE);
  console.log("Field groups — one logical question spread across several columns");
  for (const group of fieldGroups) {
    const members = fields.filter((field) => field.groupId === group.id);
    // Only OPTION members are counted. The FREE_TEXT write-in is a member for
    // display and reconciliation, and section 10.7 keeps it out of 1/n — being
    // a member is what lets FR-19 find it, being FREE_TEXT is what excludes it.
    const options = members.filter((member) => member.groupRole === "OPTION");
    const freeText = members.filter((member) => member.groupRole === "FREE_TEXT");

    console.log(
      `  "${group.key}" (${group.displayName}): ${members.length} columns — ` +
        `${options.length} OPTION, ${freeText.length} FREE_TEXT`,
    );
    console.log(
      `    category ${group.category} · isMultiSelect ${group.isMultiSelect} · ` +
        `isIncluded ${group.isIncluded}`,
    );
    for (const member of freeText) {
      console.log(`    write-in column, not counted: ${truncate(member.displayName, 46)}`);
    }

    const counts = new Map<number, number>();
    const perOption = new Map<string, number>();

    for (const row of rows) {
      let checked = 0;
      for (const member of options) {
        if ((row[member.id] ?? "") !== "") {
          checked += 1;
          perOption.set(member.displayName, (perOption.get(member.displayName) ?? 0) + 1);
        }
      }
      counts.set(checked, (counts.get(checked) ?? 0) + 1);
    }

    const multi = [...counts.entries()]
      .filter(([checked]) => checked > 1)
      .reduce((sum, [, n]) => sum + n, 0);

    console.log(
      `    boxes checked per applicant: ` +
        [...counts.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([checked, n]) => `${checked}→${n}`)
          .join("  "),
    );
    console.log(
      `    ${multi} of ${rows.length} applicants (${Math.round((multi / rows.length) * 100)}%) ` +
        `checked more than one — PRD open decision 7 applies to these`,
    );
    console.log(
      `    ${counts.get(0) ?? 0} checked none — the "Not specified" bucket, ` +
        `counted as whole people (decision 7)`,
    );
    for (const member of options) {
      console.log(
        `      ${String(perOption.get(member.displayName) ?? 0).padStart(3)}  ${member.displayName}`,
      );
    }
  }

  // --- Sparse and constant columns -------------------------------------------
  console.log(RULE);
  console.log("Column density — sparse columns and junk columns");
  console.log(`  ${"blank%".padStart(7)}  ${"distinct".padStart(8)}  inc  display name`);

  for (const field of fields) {
    const values = rows.map((row) => row[field.id] ?? "");
    const blanks = values.filter((value) => value === "").length;
    const blankPct = Math.round((blanks / values.length) * 100);
    const distinct = new Set(values).size;

    const flags: string[] = [];
    if (blankPct >= 60) flags.push("SPARSE");
    if (distinct === 1) flags.push("CONSTANT");

    if (flags.length === 0) continue;

    console.log(
      `  ${String(blankPct).padStart(6)}%  ${String(distinct).padStart(8)}  ` +
        `${field.isIncluded ? "yes" : "NO "}  ${truncate(field.displayName, 40).padEnd(40)} ${flags.join(" ")}`,
    );
  }

  const excluded = fields.filter((field) => !field.isIncluded);
  console.log("");
  console.log(`  Excluded by default (${excluded.length}): ${excluded.map((f) => f.displayName).join(", ")}`);
  console.log("  Their values are still stored, so excluding a column stays reversible.");

  // --- Reviewer roster -------------------------------------------------------
  console.log(RULE);
  console.log("Reviewer roster");
  for (const round of ["WRITTEN", "FIRST_ROUND", "SECOND_ROUND"] as const) {
    const serving = reviewers.filter((reviewer) => reviewer.rounds.includes(round));
    console.log(
      `  ${round.padEnd(13)} ${String(serving.length).padStart(2)} reviewers, ` +
        `${serving.filter((r) => r.isSparklet).length} Sparklets`,
    );
  }
  console.log("");
  console.log(
    `  Rubric: ${instance.rubricCategories.map((c) => `${c.name} (${c.maxPoints})`).join(", ")}`,
  );
  console.log(RULE);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
