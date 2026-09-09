"use client";

import { useState, useTransition } from "react";

import { resetWrittenScores, saveRubric, type RubricState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MAX_CRITERION_LENGTH,
  MAX_SCALE_VALUES,
  rubricRange,
  scaleValues,
  validateRubric,
} from "@/lib/rubric";

export interface RubricRow {
  name: string;
  minPoints: number;
  maxPoints: number;
  /// Decision 114, keyed by score value. A plain object rather than a Map so it
  /// survives the server-action boundary as-is.
  levels: Record<number, string>;
}

/// What a new category starts as, per decision 40: the 1-4 instrument, not the
/// 0-5 one the builder used to default to. An existing rubric loaded from the
/// database keeps whatever floor it was saved with, including 0.
///
/// **`levels` starts empty rather than pre-filled with four blanks.** An empty
/// map and a map of empty strings save identically — the action drops blanks —
/// and starting empty keeps "nobody has written this yet" distinguishable from
/// "somebody cleared it" while the form is open.
const NEW_CATEGORY: RubricRow = { name: "", minPoints: 1, maxPoints: 4, levels: {} };

export function RubricBuilder({
  instanceId,
  initial,
  lockedByScoreCount,
}: {
  instanceId: string;
  initial: RubricRow[];
  /// Non-zero means grading has started and FR-4 locks the rubric.
  lockedByScoreCount: number;
}) {
  const [rows, setRows] = useState<RubricRow[]>(
    initial.length > 0 ? initial : [NEW_CATEGORY],
  );
  const [state, setState] = useState<RubricState>({});
  const [pending, start] = useTransition();
  const [confirmingReset, setConfirmingReset] = useState(false);

  const locked = lockedByScoreCount > 0;
  // The same validator the server runs, so the two cannot disagree about what
  // is valid — the server is still the one that decides.
  const localErrors = validateRubric(rows);
  const range = rubricRange(rows);

  const update = (index: number, patch: Partial<RubricRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = () =>
    start(async () => {
      setState(await saveRubric(instanceId, rows));
    });

  const reset = () =>
    start(async () => {
      setState(await resetWrittenScores(instanceId));
      setConfirmingReset(false);
    });

  return (
    <div className="space-y-6">
      {locked ? (
        <div className="border-destructive/40 space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">
            Grading has started — {lockedByScoreCount} score
            {lockedByScoreCount === 1 ? " has" : "s have"} been submitted.
          </p>
          <p className="text-muted-foreground text-sm">
            The rubric is locked. Changing it now would leave those scores measured against
            categories that no longer exist, so it has to be an explicit decision.
          </p>
          {confirmingReset ? (
            <div className="space-y-2">
              <p className="text-destructive text-sm">
                This deletes all {lockedByScoreCount} submitted scores. Reviewers will have to grade
                again. There is no undo.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" disabled={pending} onClick={reset}>
                  {pending ? "Resetting…" : "Delete every written score"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingReset(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirmingReset(true)}>
              Reset written scores
            </Button>
          )}
        </div>
      ) : null}

      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={index} className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`name-${index}`} className="text-xs">
                Category {index + 1}
              </Label>
              <Input
                id={`name-${index}`}
                value={row.name}
                disabled={locked || pending}
                onChange={(e) => update(index, { name: e.target.value })}
                placeholder="e.g. Written quality"
                className="h-9 w-64"
              />
            </div>
            {/* Both bounds, per decision 40. The floor is first because that is
                the order the scale reads in — "1 to 4", not "4 from 1" — and
                because an admin who only glances at one field should see the
                one that changed. */}
            <div className="space-y-1.5">
              <Label htmlFor={`min-points-${index}`} className="text-xs">
                Lowest score
              </Label>
              <Input
                id={`min-points-${index}`}
                type="number"
                min={0}
                value={Number.isFinite(row.minPoints) ? row.minPoints : ""}
                disabled={locked || pending}
                onChange={(e) =>
                  update(index, {
                    minPoints: e.target.value === "" ? Number.NaN : Number(e.target.value),
                  })
                }
                className="h-9 w-24"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`points-${index}`} className="text-xs">
                Highest score
              </Label>
              <Input
                id={`points-${index}`}
                type="number"
                min={1}
                value={Number.isFinite(row.maxPoints) ? row.maxPoints : ""}
                disabled={locked || pending}
                onChange={(e) =>
                  update(index, { maxPoints: e.target.value === "" ? Number.NaN : Number(e.target.value) })
                }
                className="h-9 w-24"
              />
            </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked || pending || rows.length === 1}
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>

            {/* PRD decision 114, which is decision 32 carried the rest of the
                way. A blurb per category said what the category asked for and
                left every reviewer to invent the boundary between a 2 and a 3
                privately — and the boundaries are where the variance FR-10 has
                to surface actually comes from. One line per score value states
                the boundaries instead.

                Each is optional, on decision 32's original terms: an admin
                mid-setup should not be blocked, and a cycle that briefs its
                reviewers elsewhere may leave them empty. */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium">
                What each score means{" "}
                <span className="text-muted-foreground font-normal">
                  — optional, shown beside the reviewer&rsquo;s score buttons
                </span>
              </p>

              {scaleValues(row.minPoints, row.maxPoints).length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  Set a lowest and highest score first.
                </p>
              ) : scaleValues(row.minPoints, row.maxPoints).length > MAX_SCALE_VALUES ? (
                // Decision 114's width cap. The control is absent rather than
                // rendered eleven-plus times — the Slice 4 rule, that a surface
                // explains rather than offering something that fails.
                <p className="text-muted-foreground text-xs">
                  This category offers {scaleValues(row.minPoints, row.maxPoints).length} different
                  scores, which is too many to write a line about each. Narrow the range to{" "}
                  {MAX_SCALE_VALUES} values or fewer.
                </p>
              ) : (
                scaleValues(row.minPoints, row.maxPoints).map((value) => (
                  <div key={value} className="flex items-center gap-2">
                    <Label
                      htmlFor={`level-${index}-${value}`}
                      className="text-muted-foreground w-6 shrink-0 text-right text-xs tabular-nums"
                    >
                      {value}
                    </Label>
                    <Input
                      id={`level-${index}-${value}`}
                      value={row.levels[value] ?? ""}
                      disabled={locked || pending}
                      onChange={(e) =>
                        update(index, {
                          levels: { ...row.levels, [value]: e.target.value },
                        })
                      }
                      maxLength={MAX_CRITERION_LENGTH}
                      placeholder={
                        value === row.maxPoints
                          ? "e.g. Ran a project end to end, past the point it stopped being fun"
                          : value === row.minPoints
                            ? "e.g. An idea never acted on"
                            : ""
                      }
                      className="h-9 flex-1"
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={locked || pending}
          onClick={() => setRows((current) => [...current, NEW_CATEGORY])}
        >
          Add category
        </Button>
        <span className="text-muted-foreground text-sm">
          {rows.length} categor{rows.length === 1 ? "y" : "ies"} · {range.min}–{range.max} points
          per reviewer
        </span>
      </div>

      {localErrors.length > 0 ? (
        <ul className="text-destructive space-y-1 text-sm">
          {localErrors.map((e) => (
            <li key={e}>· {e}</li>
          ))}
        </ul>
      ) : null}

      {state.errors?.length ? (
        <ul role="alert" className="text-destructive space-y-1 text-sm">
          {state.errors.map((e) => (
            <li key={e}>· {e}</li>
          ))}
        </ul>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      {state.saved ? <p className="text-sm text-emerald-600">Saved.</p> : null}

      <Button disabled={locked || pending || localErrors.length > 0} onClick={save}>
        {pending ? "Saving…" : "Save rubric"}
      </Button>
    </div>
  );
}
