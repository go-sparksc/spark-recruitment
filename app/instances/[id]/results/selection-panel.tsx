"use client";

import { useActionState, useMemo, useState } from "react";

import { finalizeWritten, type FinalizeState } from "./actions";
import { Button } from "@/components/ui/button";
import {
  NOT_SPECIFIED,
  tallySelections,
  type DemographicTally,
} from "@/lib/demographics";

export interface SelectionApplicant {
  id: string;
  displayName: string;
  sourceRowIndex: number;
  completedCount: number;
  /// Column key -> the labels this applicant selected. The array, not a joined
  /// string, so the 1/n weighting counts what the table displays.
  selections: Record<string, string[]>;
}

export interface SelectionColumn {
  key: string;
  label: string;
  /// Fixes the order and keeps unselected options visible, so the selection
  /// panel and the pool panel are the same shape and can be read side by side.
  labels: string[];
}

/// FR-11. The checkbox column lives on the ranked table; this is everything
/// around it — the live breakdown, the counts, and the two-step finalize.
///
/// **Client state, not URL state.** Forty cuids do not belong in a query string,
/// and the panel has to recompute on every keystroke-equivalent tap to be
/// "live" in FR-11's sense. That makes this the first thing on the page that
/// does not work before hydration, which is honest rather than ideal: a
/// checkbox does not either.
export function useSelection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return { selected, toggle, clear: () => setSelected(new Set()) };
}

export function SelectionPanel({
  instanceId,
  applicants,
  columns,
  selected,
  onClear,
  target,
}: {
  instanceId: string;
  /// The whole pool, not the filtered view. The right-hand column of the
  /// breakdown is "against the applicant pool" per FR-11, and a filtered
  /// denominator would make the comparison meaningless.
  applicants: readonly SelectionApplicant[];
  columns: readonly SelectionColumn[];
  selected: ReadonlySet<string>;
  onClear: () => void;
  target: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<FinalizeState, FormData>(
    finalizeWritten,
    {},
  );

  const chosen = useMemo(
    () => applicants.filter((applicant) => selected.has(applicant.id)),
    [applicants, selected],
  );

  const rejectedCount = applicants.length - chosen.length;

  // Decision 44. Named, not just counted: rejecting someone nobody read is the
  // failure decision 1's warning exists to prevent, and finalize is the last
  // moment it can be prevented.
  const unreviewedRejects = useMemo(
    () => applicants.filter((a) => !selected.has(a.id) && a.completedCount === 0),
    [applicants, selected],
  );

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-sm font-medium">
          {chosen.length} selected to advance
          <span className="text-muted-foreground font-normal">
            {" · "}
            {rejectedCount} of {applicants.length} would be rejected
          </span>
        </p>
        {chosen.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="text-muted-foreground hover:text-foreground text-sm underline"
          >
            Clear selection
          </button>
        ) : null}
      </div>

      {/* FR-11: "composition is visible during selection rather than audited
          after." Always rendered, including at zero selected, so the pool
          column is readable before any decision has been made. */}
      <div className="grid gap-6 sm:grid-cols-2">
        {columns.map((column) => (
          <Breakdown
            key={column.key}
            label={column.label}
            selection={tallySelections(
              chosen.map((a) => a.selections[column.key] ?? []),
              column.labels,
            )}
            pool={tallySelections(
              applicants.map((a) => a.selections[column.key] ?? []),
              column.labels,
            )}
          />
        ))}
      </div>

      <p className="text-muted-foreground text-xs">
        Weighted counts follow PRD §10.7: an applicant selecting <em>n</em> options contributes
        1/<em>n</em> to each, and one who selected none counts as a whole person under “
        {NOT_SPECIFIED}”. The weighted column therefore sums to the number of applicants, while the
        headcount beside it counts every person who selected that option.
      </p>

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      {state.message ? <p className="text-sm text-emerald-600">{state.message}</p> : null}

      {confirming ? (
        <div className="border-destructive/40 space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">You are about to finalize the written round.</p>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
            <li>
              <span className="text-foreground font-medium">{chosen.length}</span> applicant
              {chosen.length === 1 ? "" : "s"} advance to the first round.
            </li>
            <li>
              <span className="text-foreground font-medium">{rejectedCount}</span> applicant
              {rejectedCount === 1 ? "" : "s"} are rejected.
            </li>
            <li>Every applicant gets a written-round decision recorded, either way.</li>
            <li>This screen becomes read-only afterwards.</li>
          </ul>

          {unreviewedRejects.length > 0 ? (
            <div className="border-destructive/40 space-y-1 rounded-md border p-3">
              <p className="text-destructive text-sm font-medium">
                {unreviewedRejects.length} of those {rejectedCount}{" "}
                {unreviewedRejects.length === 1 ? "has" : "have"} no completed reviews:
              </p>
              <ul className="text-muted-foreground space-y-0.5 text-sm">
                {unreviewedRejects.slice(0, 12).map((applicant) => (
                  <li key={applicant.id}>
                    Applicant {applicant.sourceRowIndex} · {applicant.displayName}
                  </li>
                ))}
                {unreviewedRejects.length > 12 ? (
                  <li>…and {unreviewedRejects.length - 12} more.</li>
                ) : null}
              </ul>
              <p className="text-muted-foreground text-sm">
                Rejecting them records a decision nobody made. Claim-from-pool is how they still get
                read.
              </p>
            </div>
          ) : null}

          <form action={formAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="instanceId" value={instanceId} />
            {chosen.map((applicant) => (
              <input key={applicant.id} type="hidden" name="selected" value={applicant.id} />
            ))}
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Finalizing…" : `Yes — finalize ${applicants.length} decisions`}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              No, keep selecting
            </Button>
          </form>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setConfirming(true)} disabled={applicants.length === 0}>
            Finalize written round…
          </Button>
          <span className="text-muted-foreground text-sm">
            {chosen.length === 0
              ? "Nothing is selected yet — finalizing now would reject everyone."
              : `${chosen.length} advance, ${rejectedCount} rejected.`}
          </span>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        {target}/{target} is a complete review. Applicants under that are marked in the table.
      </p>
    </div>
  );
}

export function Breakdown({
  label,
  selection,
  pool,
}: {
  label: string;
  selection: readonly DemographicTally[];
  pool: readonly DemographicTally[];
}) {
  const poolByLabel = new Map(pool.map((row) => [row.label, row]));
  // Union, ordered by the pool — the selection can only ever contain labels the
  // pool also has, but a "Not specified" row present in one and not the other
  // would silently misalign the two columns.
  const rows = pool.map((row) => ({
    label: row.label,
    selection: selection.find((s) => s.label === row.label) ?? {
      label: row.label,
      weighted: 0,
      headcount: 0,
    },
    pool: poolByLabel.get(row.label)!,
  }));

  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left text-xs">
          <tr>
            <th className="font-normal">&nbsp;</th>
            <th className="pl-2 text-right font-normal">Selected</th>
            <th className="pl-2 text-right font-normal">Pool</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b last:border-0">
              <td className="py-0.5 pr-2">{row.label}</td>
              <td className="py-0.5 pl-2 text-right tabular-nums">
                {row.selection.weighted.toFixed(1)}
                <span className="text-muted-foreground text-xs"> / {row.selection.headcount}</span>
              </td>
              <td className="text-muted-foreground py-0.5 pl-2 text-right tabular-nums">
                {row.pool.weighted.toFixed(1)}
                <span className="text-xs"> / {row.pool.headcount}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
