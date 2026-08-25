"use client";

import { useActionState, useState } from "react";

import { CoiCell } from "./coi-cell";
import { removeConflict, type PassActionState } from "../actions";
import { Button } from "@/components/ui/button";
import type { EffectiveVote, PassTally } from "@/lib/passes";

export interface GridReviewer {
  id: string;
  name: string;
}

export interface GridRow {
  applicantId: string;
  applicantName: string;
  /// "Applicant 47", from `sourceRowIndex`. Rendered beside the name because
  /// names collide — this instance has two "Diego Hoffmann" — and every control
  /// on this page acts on one specific person.
  applicantHandle: string;
  cells: EffectiveVote[];
  conflicts: boolean[];
  tally: PassTally;
  resolutionLabel: string;
  /// False once the pass has settled this applicant. Decision 76 does not reopen
  /// a terminal row, so its conflicts render without a control.
  mutable: boolean;
}

/// FR-18's reviewer-by-applicant grid. Clauses 18a–18d, and 18f's control.
///
/// **The scroll is the container's, not the page's.** Eleven reviewers against
/// forty applicants does not fit a phone, and a page body that scrolls sideways
/// takes the header and every other control with it. `overflow-x-auto` on the
/// wrapper keeps the sideways movement inside the table.
export function PassGrid({
  instanceId,
  reviewers,
  rows,
  removable,
}: {
  instanceId: string;
  reviewers: GridReviewer[];
  rows: GridRow[];
  /// False on a closed pass. §7.4 does not reopen one, so its conflicts are a
  /// record rather than something to edit.
  removable: boolean;
}) {
  const [selected, setSelected] = useState<{ applicantId: string; reviewerId: string } | null>(
    null,
  );
  const [state, formAction, pending] = useActionState<PassActionState, FormData>(
    removeConflict,
    {},
  );

  const selectedRow = rows.find((row) => row.applicantId === selected?.applicantId) ?? null;
  const selectedReviewerIndex = reviewers.findIndex((r) => r.id === selected?.reviewerId);
  const selectedReviewer = selectedReviewerIndex < 0 ? null : reviewers[selectedReviewerIndex];

  // **The same rule the close confirm follows: the panel lives only as long as
  // the thing it confirms.** `selected` is an id pair, so it survived the
  // removal it performed — the panel stayed open afterwards, still offering to
  // remove a conflict that was already gone. Deriving from `row.conflicts`
  // instead means the panel closes itself when the revalidated props come back
  // without that conflict, and cannot be shown for a cell that is not one.
  const stillConflicted =
    selectedRow !== null &&
    selectedReviewerIndex >= 0 &&
    selectedRow.conflicts[selectedReviewerIndex] === true;

  return (
    <div className="mt-8 space-y-4">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-muted/40">
              <th scope="col" className="sticky left-0 z-10 bg-inherit px-3 py-2 text-left font-medium">
                Applicant
              </th>
              {reviewers.map((reviewer) => (
                <th
                  key={reviewer.id}
                  scope="col"
                  // Vertical-ish: the names are long and the columns are narrow,
                  // so the header carries the full name as a title and shows
                  // initials. Eleven full names across is what makes the table
                  // unreadable, not the cells.
                  className="border-l px-2 py-2 text-center font-medium"
                  title={reviewer.name}
                >
                  {initials(reviewer.name)}
                </th>
              ))}
              <th scope="col" className="border-l px-3 py-2 text-right font-medium">
                Y / N / S
              </th>
              <th scope="col" className="border-l px-3 py-2 text-left font-medium">
                Resolution
              </th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <tr key={row.applicantId} className="border-t">
                <th
                  scope="row"
                  className="bg-background sticky left-0 z-10 px-3 py-2 text-left font-normal whitespace-nowrap"
                >
                  {row.applicantName}
                  <span className="text-muted-foreground ml-2 text-xs">
                    {row.applicantHandle}
                  </span>
                </th>

                {reviewers.map((reviewer, index) => (
                  <CoiCell
                    key={reviewer.id}
                    vote={row.cells[index]}
                    isConflict={row.conflicts[index]}
                    applicantName={row.applicantName}
                    reviewerName={reviewer.name}
                    selected={
                      selected?.applicantId === row.applicantId &&
                      selected?.reviewerId === reviewer.id
                    }
                    removable={removable && row.mutable}
                    onSelect={() =>
                      setSelected({ applicantId: row.applicantId, reviewerId: reviewer.id })
                    }
                  />
                ))}

                {/* 18c. All three numbers, always — a skip count that appears
                    only when non-zero makes an eleven-reviewer row look like it
                    has fewer reviewers than it does. */}
                <td className="border-l px-3 py-2 text-right tabular-nums whitespace-nowrap">
                  {row.tally.yes} / {row.tally.no} / {row.tally.skip}
                </td>

                {/* 18d. */}
                <td className="text-muted-foreground border-l px-3 py-2 whitespace-nowrap">
                  {row.resolutionLabel}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {stillConflicted && selected && selectedRow && selectedReviewer ? (
        <form action={formAction} className="space-y-3 rounded-md border p-4">
          <input type="hidden" name="instanceId" value={instanceId} />
          <input type="hidden" name="applicantId" value={selected.applicantId} />
          <input type="hidden" name="reviewerId" value={selected.reviewerId} />

          <p className="text-sm font-medium">
            Remove {selectedReviewer.name}&rsquo;s conflict on {selectedRow.applicantName} (
            {selectedRow.applicantHandle})?
          </p>

          {/* The three things decision 76 requires this to say. */}
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
            <li>
              Conflicts are held per round, not per pass, so this removes it from every pass —
              not only this one.
            </li>
            <li>
              Any vote they had cast was deleted when they flagged the conflict and does not come
              back. They return as not having voted, so this applicant now needs a vote from them.
            </li>
            <li>
              Applicants this pass has already resolved are unaffected — removing a conflict never
              reopens a decided applicant.
            </li>
          </ul>

          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Removing…" : "Remove conflict"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSelected(null)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      {state.message ? <p className="text-muted-foreground text-sm">{state.message}</p> : null}
    </div>
  );
}

/// Initials for the column head, with the full name on the `title`. Two letters
/// where there are two names, and whatever there is where there are not — a
/// mononym is a name FR-6 explicitly allows.
function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}
