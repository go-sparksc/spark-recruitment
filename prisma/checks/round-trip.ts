// FR-20's gate, made runnable: export, delete, reimport, confirm intact.
//
// Run with:  npm run check:round-trip
//        or  npx tsx --conditions=react-server prisma/checks/round-trip.ts [instanceId]
//
// The `--conditions=react-server` flag is not optional. `lib/instance-io.ts`
// carries `import "server-only"`, which throws outside a React Server Component;
// the flag resolves that package to its empty build. The alternative — this
// script re-implementing the reads and writes — would verify a second copy of
// the code under test, which is not a test.
//
// **This is the destructive check.** It deletes the instance and rebuilds it
// from the file. Two safeguards, because a failed restore would otherwise lose a
// cycle's data:
//
//   1. The serialized export is written to a temp file BEFORE anything is
//      deleted, and its path is printed. If the restore fails, that file is the
//      instance and the recovery is to fix the bug and re-run the write.
//   2. The delete mirrors `deleteInstance`'s own order — purge the instance's
//      AuditLog rows, then delete the instance. Not an incidental detail: the
//      FK is ON DELETE SET NULL, so a raw delete leaves those rows orphaned with
//      their original ids, and the restore then collides on the primary key. §8
//      wants audit rows to outlive their instance; a round trip wants them gone.
//      The application's delete already does exactly this, so modelling it here
//      is faithfulness rather than convenience.
//
// What "intact" means is `diffSnapshots` over the manifest, plus three
// assertions that would each survive an empty diff if the diff itself were
// broken — the resolution histogram, the JSONB key integrity, and the group
// keys. See PRD decisions 86-88 and plans/phase-7.md.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diffSnapshots,
  formatDifferences,
  parseExport,
  rowCounts,
  serializeExport,
  type InstanceSnapshot,
} from "../../lib/export";
import { readSnapshot, writeSnapshot } from "../../lib/instance-io";
import { SEED_INSTANCE_ID, createSeedClient } from "../seed/client";

const prisma = createSeedClient();

const instanceId = process.argv[2] ?? SEED_INSTANCE_ID;

let failures = 0;

function pass(label: string, detail: string) {
  console.log(`PASS  ${label}\n        ${detail}`);
}

function fail(label: string, detail: string) {
  failures += 1;
  console.log(`FAIL  ${label}\n        ${detail}`);
}

/// `PassApplicant.resolution` across every pass, as a histogram keyed by pass
/// ordinal. The specific thing decision 88 is about: `NEEDS_ADMIN`, `CARRIED`
/// and `null` are three distinct outcomes and an omit-nulls export collapses
/// them. Counted rather than diffed so a collapse fails loudly here even if the
/// field-level comparison were itself wrong.
function resolutionHistogram(snapshot: InstanceSnapshot): string {
  const passOrdinal = new Map<string, unknown>(
    snapshot.tables.Pass.map((row) => [String(row.id), row.ordinal]),
  );
  const counts = new Map<string, number>();

  for (const row of snapshot.tables.PassApplicant) {
    const key = `pass ${String(passOrdinal.get(String(row.passId)))} · ${String(row.resolution)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key} = ${count}`)
    .join(", ");
}

/// Every key of every applicant's `data` object must name a `Field` that exists.
///
/// This is the assertion that covers the whole class decision 88 is written
/// about, rather than one column of it: `Applicant.data` is keyed by `Field.id`,
/// so any restore that regenerated field ids would leave every applicant's
/// answers pointing at nothing — while every row count still matched and every
/// individual column still round-tripped.
function danglingDataKeys(snapshot: InstanceSnapshot): string[] {
  const fieldIds = new Set(snapshot.tables.Field.map((row) => String(row.id)));
  const dangling = new Set<string>();

  for (const applicant of snapshot.tables.Applicant) {
    const data = applicant.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    for (const key of Object.keys(data)) {
      if (!fieldIds.has(key)) dangling.add(key);
    }
  }

  return [...dangling];
}

async function main() {
  console.log("");
  console.log(`Round trip for instance ${instanceId}`);
  console.log("-".repeat(78));

  // --- 1. Export ------------------------------------------------------------
  const before = await readSnapshot(prisma, instanceId);
  const text = serializeExport(before);

  const backupDir = mkdtempSync(join(tmpdir(), "spark-round-trip-"));
  const backupPath = join(backupDir, "instance.json");
  writeFileSync(backupPath, text, "utf8");

  console.log(`  exported ${(text.length / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`  backup   ${backupPath}`);
  console.log(`  passes   ${resolutionHistogram(before) || "(none)"}`);
  console.log("");

  const populated = rowCounts(before).filter((entry) => entry.rows > 0);
  if (populated.length === 0) {
    fail("export is non-empty", "the instance exported zero rows in every table");
    return;
  }

  // --- 2. Delete ------------------------------------------------------------
  //
  // AuditLog first, in deleteInstance's own order and for its stated reason. See
  // the header: SET NULL would otherwise orphan these rows with their original
  // ids and the restore would collide on the primary key.
  const auditPurged = await prisma.auditLog.deleteMany({ where: { instanceId } });
  await prisma.instance.delete({ where: { id: instanceId } });

  const survivors = await prisma.instance.count({ where: { id: instanceId } });
  if (survivors !== 0) {
    fail("delete", "the instance is still present after delete");
    return;
  }
  // A spot check that the cascade actually reached the far end of the graph,
  // rather than the instance row alone disappearing.
  const orphanedVotes = await prisma.passVote.count({ where: { pass: { instanceId } } });
  const orphanedScores = await prisma.score.count({ where: { assignment: { instanceId } } });
  pass(
    "delete",
    `instance gone, cascade took its rows (PassVote ${orphanedVotes}, Score ${orphanedScores}), ` +
      `${auditPurged.count} audit rows purged first`,
  );

  // --- 3. Restore -----------------------------------------------------------
  //
  // Parsed from the TEXT, not from `before`. Restoring the in-memory object
  // would test the database round trip while skipping the file, which is the
  // half FR-20 actually promises: the club has a file, and the file is enough.
  const parsed = parseExport(text);
  const written = await writeSnapshot(prisma, parsed);
  const writtenTotal = written.reduce((sum, entry) => sum + entry.rows, 0);
  pass("restore", `${writtenTotal} rows written across ${written.length} tables`);

  // --- 4. Compare -----------------------------------------------------------
  const after = await readSnapshot(prisma, instanceId);
  const differences = diffSnapshots(before, after);

  if (differences.length === 0) {
    pass("intact", "every column of every row of all 24 tables is unchanged");
  } else {
    // Grouped by table and column, because the informative failure is "every row
    // of every table differs on updatedAt" — the signature plans/phase-7.md
    // names for Prisma overwriting @updatedAt on create — and a flat list of
    // four thousand lines hides it.
    const byColumn = new Map<string, number>();
    for (const difference of differences) {
      const key = `${difference.table}.${difference.column ?? "(row)"}`;
      byColumn.set(key, (byColumn.get(key) ?? 0) + 1);
    }
    fail(
      "intact",
      `${differences.length} differences across ${byColumn.size} columns:\n` +
        [...byColumn.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([key, count]) => `          ${key} × ${count}`)
          .join("\n") +
        `\n\n        first few:\n${formatDifferences(differences.slice(0, 10))}`,
    );
  }

  // --- 5. Three assertions the diff alone would not earn --------------------
  const beforeHistogram = resolutionHistogram(before);
  const afterHistogram = resolutionHistogram(after);
  if (beforeHistogram === afterHistogram) {
    pass("resolutions", `${afterHistogram || "(no passes)"} — NULL, CARRIED and NEEDS_ADMIN intact`);
  } else {
    fail("resolutions", `before: ${beforeHistogram}\n        after:  ${afterHistogram}`);
  }

  const dangling = danglingDataKeys(after);
  if (dangling.length === 0) {
    pass(
      "applicant data keys",
      `every key of every Applicant.data resolves to a live Field.id ` +
        `(${after.tables.Field.length} fields, ${after.tables.Applicant.length} applicants)`,
    );
  } else {
    fail("applicant data keys", `${dangling.length} keys name no Field: ${dangling.slice(0, 5).join(", ")}`);
  }

  const beforeKeys = before.tables.FieldGroup.map((row) => String(row.key)).sort();
  const afterKeys = after.tables.FieldGroup.map((row) => String(row.key)).sort();
  if (JSON.stringify(beforeKeys) === JSON.stringify(afterKeys)) {
    pass("field group keys", `unchanged: ${afterKeys.join(", ") || "(no groups)"} — decision 13 holds`);
  } else {
    fail("field group keys", `before: ${beforeKeys.join(", ")}\n        after:  ${afterKeys.join(", ")}`);
  }

  console.log("");
  console.log("-".repeat(78));
  if (failures === 0) {
    console.log(`  ${populated.length} tables, ${writtenTotal} rows, round trip clean.`);
    console.log(`  The backup at ${backupPath} is no longer needed.`);
  } else {
    console.log(`  ${failures} FAILED. The instance was rebuilt from ${backupPath};`);
    console.log(`  that file is the export as it was taken and is safe to restore from again.`);
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = failures === 0 ? 0 : 1;
  });
