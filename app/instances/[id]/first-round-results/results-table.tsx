"use client";

import { useActionState, useMemo, useState } from "react";

import { finalizeFirstRound, type FinalizeFirstRoundState } from "./actions";
import { Breakdown, type SelectionColumn } from "../results/selection-panel";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { tallySelections } from "@/lib/demographics";
import type { FirstRoundResultRow } from "@/lib/first-round";
import { formatYesPercent, hasNoVotes } from "@/lib/results";

/// FR-15's ranked table and selection, in one client component.
///
/// **A sibling of the written round's table rather than a parameterisation of
/// it.** The two rank on different instruments — a mean of scores against a
/// percentage of votes — and their columns, their markers and their finalize
/// actions all differ. Sharing the shell would mean a component with two modes
/// and a prop for each difference, which is how a change meant for one round
/// silently lands in the other.
///
/// What IS shared is the thing FR-15 actually says mirrors FR-11: the live
/// demographic `Breakdown`, imported from the written round's panel. That is a
/// presentational component over tallies with no round-specific vocabulary in it.
export function FirstRoundResultsTable({
  instanceId,
  rows,
  columns,
  selectable,
}: {
  instanceId: string;
  rows: readonly FirstRoundResultRow[];
  columns: readonly SelectionColumn[];
  /// False once the round is finalized. Decided on the server from
  /// `currentStage`, not here — a client's copy of the stage is only as fresh as
  /// the payload it arrived in, and a tab left open across a finalize would go
  /// on offering checkboxes over a decision already made. Clause 11e's reasoning,
  /// and the action re-checks the same field.
  selectable: boolean;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<FinalizeFirstRoundState, FormData>(
    finalizeFirstRound,
    {},
  );

  const pool = useMemo(() => rows.filter((row) => row.inPool), [rows]);
  const chosen = useMemo(() => pool.filter((row) => selected.has(row.id)), [pool, selected]);

  // FR-15, same sentence as decision 44's for the written round: the
  // confirmation names the applicants nobody voted on. **Literal zero**, not a
  // shortfall against a target — decision 46 is explicit there is no target here.
  const unvotedRejects = useMemo(
    () => pool.filter((row) => !selected.has(row.id) && hasNoVotes(row.nonSkipCount)),
    [pool, selected],
  );

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-6">
      <Table>
        <TableHeader>
          <TableRow>
            {selectable ? <TableHead className="w-10" /> : null}
            <TableHead className="w-12">#</TableHead>
            <TableHead>Applicant</TableHead>
            <TableHead className="text-right">Yes</TableHead>
            <TableHead className="text-right">Votes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              {selectable ? (
                <TableCell>
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    disabled={!row.inPool || pending}
                    onChange={() => toggle(row.id)}
                    aria-label={`Advance ${row.displayName}`}
                    className="size-4"
                  />
                </TableCell>
              ) : null}
              <TableCell className="text-muted-foreground tabular-nums">{row.rank}</TableCell>
              <TableCell className="font-medium">{row.displayName}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatYesPercent(row.yesPercent)}
              </TableCell>
              {/* FR-15: raw counts alongside the percentage, because "2/2 and
                  14/14 are not the same signal". The marker for zero votes goes
                  HERE, on the count cell — not on the row. Decision 46, and the
                  same treatment FR-10's under-target count gets: an applicant
                  nobody voted on is not a worse applicant, and the number is
                  what should be distrusted. */}
              <TableCell
                className={
                  hasNoVotes(row.nonSkipCount)
                    ? "text-right tabular-nums text-amber-600"
                    : "text-right tabular-nums"
                }
                title={
                  hasNoVotes(row.nonSkipCount) ? "No reviewer voted on this applicant" : undefined
                }
              >
                {row.yesCount}/{row.nonSkipCount}
                {hasNoVotes(row.nonSkipCount) ? " ⚠" : ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {selectable ? (
        <div className="space-y-4 rounded-md border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className="text-sm font-medium">
              {chosen.length} selected to advance
              <span className="text-muted-foreground font-normal">
                {" · "}
                {pool.length - chosen.length} of {pool.length} would be rejected
              </span>
            </p>
            {chosen.length > 0 ? (
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-muted-foreground hover:text-foreground text-sm underline"
              >
                Clear selection
              </button>
            ) : null}
          </div>

          {/* FR-15 mirrors FR-11: composition visible during selection rather
              than audited after. Always rendered, including at zero selected, so
              the pool column is readable before any decision is made. */}
          <div className="grid gap-6 sm:grid-cols-2">
            {columns.map((column) => (
              <Breakdown
                key={column.key}
                label={column.label}
                selection={tallySelections(
                  chosen.map((row) => row.selections[column.key] ?? []),
                  column.labels,
                )}
                pool={tallySelections(
                  pool.map((row) => row.selections[column.key] ?? []),
                  column.labels,
                )}
              />
            ))}
          </div>

          {state.error ? (
            <p role="alert" className="text-destructive text-sm">
              {state.error}
            </p>
          ) : null}
          {state.message ? <p className="text-sm text-emerald-600">{state.message}</p> : null}

          {confirming ? (
            <form action={formAction} className="space-y-3 border-t pt-3">
              <input type="hidden" name="instanceId" value={instanceId} />
              {chosen.map((row) => (
                <input key={row.id} type="hidden" name="selected" value={row.id} />
              ))}

              <p className="text-sm">
                Advance {chosen.length} and reject {pool.length - chosen.length}. This writes a
                decision for every applicant in the round and cannot be undone from this screen.
              </p>

              {/* FR-15's own sentence, and decision 44's reasoning: rejecting an
                  applicant nobody voted on records a decision nobody made. Named,
                  not counted — a number is something to click past. */}
              {unvotedRejects.length > 0 ? (
                <p className="text-destructive text-sm">
                  {unvotedRejects.length} of those being rejected had no votes at all:{" "}
                  {unvotedRejects.map((row) => row.displayName).join(", ")}. Rejecting them records
                  a decision nobody made.
                </p>
              ) : null}

              <div className="flex gap-2">
                <Button type="submit" disabled={pending}>
                  {pending ? "Finalizing…" : "Finalize the first round"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button onClick={() => setConfirming(true)} disabled={pool.length === 0}>
              Finalize the first round
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
