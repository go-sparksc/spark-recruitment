"use client";

import { useState, useTransition } from "react";

import { resetWrittenScores, saveRubric, type RubricState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_DESCRIPTION_LENGTH, rubricTotal, validateRubric } from "@/lib/rubric";

export interface RubricRow {
  name: string;
  maxPoints: number;
  description: string;
}

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
    initial.length > 0 ? initial : [{ name: "", maxPoints: 5, description: "" }],
  );
  const [state, setState] = useState<RubricState>({});
  const [pending, start] = useTransition();
  const [confirmingReset, setConfirmingReset] = useState(false);

  const locked = lockedByScoreCount > 0;
  // The same validator the server runs, so the two cannot disagree about what
  // is valid — the server is still the one that decides.
  const localErrors = validateRubric(rows);

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
            <div className="space-y-1.5">
              <Label htmlFor={`points-${index}`} className="text-xs">
                Max points
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

            {/* PRD decision 32. Optional, but prompted hard: a name and a
                maximum are a scale, not a rubric, and this is the only guidance
                a written reviewer ever sees. Left empty it costs nothing here
                and surfaces two phases later as FR-10 variance nobody can
                explain. */}
            <div className="space-y-1.5">
              <Label htmlFor={`description-${index}`} className="text-xs">
                What reviewers should look for{" "}
                <span className="text-muted-foreground font-normal">
                  — optional, shown beside their score box
                </span>
              </Label>
              <textarea
                id={`description-${index}`}
                value={row.description}
                disabled={locked || pending}
                onChange={(e) => update(index, { description: e.target.value })}
                rows={2}
                maxLength={MAX_DESCRIPTION_LENGTH}
                placeholder="e.g. Evidence of starting something and seeing it through. A 5 is a project they ran end to end; a 1 is an idea never acted on."
                className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
              />
              <p className="text-muted-foreground text-xs tabular-nums">
                {row.description.length}/{MAX_DESCRIPTION_LENGTH}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={locked || pending}
          onClick={() => setRows((current) => [...current, { name: "", maxPoints: 5, description: "" }])}
        >
          Add category
        </Button>
        <span className="text-muted-foreground text-sm">
          {rows.length} categor{rows.length === 1 ? "y" : "ies"} · {rubricTotal(rows)} points per
          reviewer
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
