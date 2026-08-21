import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  ColumnRoleSelect,
  CommitForm,
  DiscardStagedButton,
  FuzzyRow,
  SkippedRow,
  UnresolvedRow,
  type PoolOption,
} from "./sheet-controls";
import { SHEET_LABEL, loadInterviewSheet, parseSheetParam } from "../load";
import { InstanceCrumbs } from "../../instance-crumbs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Interview sheet — Spark SC Recruitment" };

/// FR-12 and FR-13 for one sheet: map the columns, reconcile the rows, read the
/// findings, import.
///
/// One page rather than three, because reconciliation cannot start until the
/// mapping names the email and name columns, and the preview cannot mean
/// anything until reconciliation is done. Three routes would be three round
/// trips through work that is strictly ordered anyway.
export default async function InterviewSheetPage({
  params,
}: {
  params: Promise<{ id: string; sheet: string }>;
}) {
  const { id, sheet: sheetParam } = await params;
  await requireInstance(id, `/instances/${id}/interviews`);

  const sheet = parseSheetParam(sheetParam);
  if (!sheet) notFound();

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!instance) notFound();

  const loaded = await loadInterviewSheet(id, sheet);
  // Nothing staged — including straight after a successful import, which deletes
  // the staging row. Back to the hub rather than an empty screen.
  if (!loaded) redirect(`/instances/${id}/interviews`);

  const { findings, headers, mapping, categories, mappingErrors, candidatesByRow, sampleByColumn } =
    loaded;
  const lowerSheet = sheet.toLowerCase();

  const pool: PoolOption[] = loaded.pool.map((candidate) => ({
    applicantId: candidate.applicantId,
    label: candidate.email
      ? `${candidate.displayName} — ${candidate.email}`
      : candidate.displayName,
  }));
  const poolById = new Map(pool.map((option) => [option.applicantId, option]));

  const awaiting = findings.rows.filter((row) => !row.skipped && row.awaitingConfirmation);
  const unresolved = findings.rows.filter(
    (row) => !row.skipped && row.applicantId === null,
  );
  const skipped = findings.rows.filter((row) => row.skipped);
  const resolved = findings.rows.filter(
    (row) => !row.skipped && row.applicantId !== null && !row.awaitingConfirmation,
  );

  const label = (row: (typeof findings.rows)[number]) =>
    row.rawName.trim() || row.rawEmail.trim();

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <InstanceCrumbs instanceId={instance.id} instanceName={instance.name} />

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{SHEET_LABEL[sheet]}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {findings.rows.length} row{findings.rows.length === 1 ? "" : "s"} staged ·{" "}
            <Link href={`/instances/${id}/interviews`} className="hover:underline">
              Both sheets
            </Link>
          </p>
        </div>
        <DiscardStagedButton instanceId={id} sheet={lowerSheet} />
      </div>

      {/* ---- Step 1: the columns ---- */}
      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Columns</CardTitle>
          <CardDescription>
            What each column in the file means. Pre-filled where a heading matched exactly —
            anything else is left unimported rather than guessed at.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <tbody>
              {headers.map((header, columnIndex) => (
                <ColumnRoleSelect
                  key={columnIndex}
                  instanceId={id}
                  sheet={lowerSheet}
                  columnIndex={columnIndex}
                  header={header}
                  sample={sampleByColumn[columnIndex]}
                  value={mapping[String(columnIndex)] ?? "IGNORED"}
                  categories={categories.map((c) => ({ id: c.id, name: c.name }))}
                />
              ))}
            </tbody>
          </table>

          {mappingErrors.length > 0 ? (
            <ul className="text-destructive mt-4 space-y-1 text-sm">
              {mappingErrors.map((error) => (
                <li key={error}>· {error}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-emerald-600">Every column the import needs is mapped.</p>
          )}
        </CardContent>
      </Card>

      {/* ---- Step 2: the rows ---- */}
      {mappingErrors.length === 0 ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Rows</CardTitle>
            <CardDescription>
              {resolved.length} matched automatically. Matching only ever considers applicants who
              reached the first round.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {awaiting.length > 0 ? (
              <section>
                <h2 className="text-sm font-medium">
                  Close matches — {awaiting.length} waiting on you
                </h2>
                <p className="text-muted-foreground mt-1 text-sm">
                  A near-miss on a name is a suggestion, not a match. Nothing here imports until you
                  say it is the same person.
                </p>
                <ul className="mt-2">
                  {awaiting.map((row) => (
                    <FuzzyRow
                      key={row.rowIndex}
                      instanceId={id}
                      sheet={lowerSheet}
                      rowIndex={row.rowIndex}
                      rowName={label(row)}
                      candidateName={
                        poolById.get(row.applicantId ?? "")?.label ?? "an applicant"
                      }
                      confidence={row.matchConfidence}
                    />
                  ))}
                </ul>
              </section>
            ) : null}

            {unresolved.length > 0 ? (
              <section>
                <h2 className="text-sm font-medium">Not matched — {unresolved.length}</h2>
                <ul className="mt-2">
                  {unresolved.map((row) => {
                    const outcome = candidatesByRow.get(row.rowIndex);
                    const alternatives =
                      outcome?.kind === "AMBIGUOUS"
                        ? outcome.candidates
                            .map((c) => poolById.get(c.applicantId))
                            .filter((option): option is PoolOption => option !== undefined)
                        : [];

                    const reason =
                      outcome?.kind === "AMBIGUOUS"
                        ? `${outcome.candidates.length} applicants match equally well`
                        : outcome?.kind === "UNRESOLVED" && outcome.reason === "NO_IDENTITY"
                          ? "no name or email on this row"
                          : "no applicant in the first round matches";

                    return (
                      <UnresolvedRow
                        key={row.rowIndex}
                        instanceId={id}
                        sheet={lowerSheet}
                        rowIndex={row.rowIndex}
                        rowLabel={label(row)}
                        reason={reason}
                        alternatives={alternatives}
                        pool={pool}
                      />
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {skipped.length > 0 ? (
              <section>
                <h2 className="text-sm font-medium">Not importing — {skipped.length}</h2>
                <ul className="mt-2">
                  {skipped.map((row) => (
                    <SkippedRow
                      key={row.rowIndex}
                      instanceId={id}
                      sheet={lowerSheet}
                      rowIndex={row.rowIndex}
                      rowLabel={label(row)}
                    />
                  ))}
                </ul>
              </section>
            ) : null}

            {awaiting.length === 0 && unresolved.length === 0 ? (
              <p className="text-sm text-emerald-600">
                Every row is either matched to an applicant or set aside.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ---- Step 3: findings and commit ---- */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Before importing</CardTitle>
          <CardDescription>
            {findings.resolvedCount} row{findings.resolvedCount === 1 ? "" : "s"} would be imported
            {findings.skippedCount > 0 ? `, ${findings.skippedCount} set aside` : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {findings.blockers.length > 0 ? (
            <ul className="text-destructive space-y-2 text-sm">
              {findings.blockers.map((blocker) => (
                <li key={blocker}>· {blocker}</li>
              ))}
            </ul>
          ) : null}

          {findings.warnings.length > 0 ? (
            <ul className="text-muted-foreground space-y-2 text-sm">
              {findings.warnings.map((warning) => (
                <li key={warning}>· {warning}</li>
              ))}
            </ul>
          ) : null}

          {findings.blockers.length === 0 && findings.warnings.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing to flag.</p>
          ) : null}

          <CommitForm
            instanceId={id}
            sheet={lowerSheet}
            rowCount={findings.resolvedCount}
            disabled={!findings.canCommit}
          />
        </CardContent>
      </Card>
    </main>
  );
}
