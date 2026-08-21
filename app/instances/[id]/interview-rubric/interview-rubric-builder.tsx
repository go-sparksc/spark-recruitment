"use client";

import { useState, useTransition } from "react";

import {
  resetInterviewScores,
  saveInterviewRubric,
  type InterviewRubricState,
} from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateInterviewRubric, type InterviewCategoryInput } from "@/lib/rubric";

/// The S26 interview sheet's shape, offered as a starting point rather than
/// assumed anywhere: FR-12a and clause 12g both require that a cycle changing
/// its interview rubric needs no code change, and nothing downstream reads these
/// names — FR-12's mapping step is what binds a column to a category.
const NEW_CATEGORY: InterviewCategoryInput = { name: "", maxPoints: 4 };

export function InterviewRubricBuilder({
  instanceId,
  initial,
  lockedByScoreCount,
}: {
  instanceId: string;
  initial: InterviewCategoryInput[];
  /// Non-zero means a scores sheet has been imported and FR-12a locks the
  /// rubric.
  lockedByScoreCount: number;
}) {
  const [rows, setRows] = useState<InterviewCategoryInput[]>(
    initial.length > 0 ? initial : [NEW_CATEGORY],
  );
  const [state, setState] = useState<InterviewRubricState>({});
  const [pending, start] = useTransition();
  const [confirmingReset, setConfirmingReset] = useState(false);

  const locked = lockedByScoreCount > 0;
  // The same validator the server runs, so the two cannot disagree about what is
  // valid. The server still decides — this only saves a round trip.
  const localErrors = validateInterviewRubric(rows);

  const update = (index: number, patch: Partial<InterviewCategoryInput>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = () =>
    start(async () => {
      setState(await saveInterviewRubric(instanceId, rows));
    });

  const reset = () =>
    start(async () => {
      setState(await resetInterviewScores(instanceId));
      setConfirmingReset(false);
    });

  return (
    <div className="space-y-6">
      {locked ? (
        <div className="border-destructive/40 space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">
            Interview scores have been imported — {lockedByScoreCount} category score
            {lockedByScoreCount === 1 ? "" : "s"} across the cohort.
          </p>
          <p className="text-muted-foreground text-sm">
            The rubric is locked. Changing it now would leave those scores measured against
            categories that no longer exist.
          </p>
          {confirmingReset ? (
            <div className="space-y-2">
              {/* Deliberately says what comes back, not only what goes away.
                  Unlike FR-4's reset — which destroys work thirty reviewers
                  typed — this deletes imported data that still exists in the
                  file it came from, and decision 47 makes re-importing it
                  ordinary. An admin who cannot tell those two situations apart
                  will treat both as unrecoverable. */}
              <p className="text-destructive text-sm">
                This discards every imported interview score and average. Interview notes are kept.
                Re-upload the scores sheet afterwards to bring them back.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" disabled={pending} onClick={reset}>
                  {pending ? "Discarding…" : "Discard imported interview scores"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingReset(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirmingReset(true)}>
              Discard imported scores
            </Button>
          )}
        </div>
      ) : null}

      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-end gap-3 rounded-md border p-3">
            <div className="space-y-1.5">
              <Label htmlFor={`interview-name-${index}`} className="text-xs">
                Category {index + 1}
              </Label>
              <Input
                id={`interview-name-${index}`}
                value={row.name}
                disabled={locked || pending}
                onChange={(e) => update(index, { name: e.target.value })}
                placeholder="e.g. Communication"
                className="h-9 w-64"
              />
            </div>
            {/* One bound, not two. FR-12a asks for max points per category and
                nothing else; these scores arrive from a spreadsheet rather than
                an input control, so decision 40's floor — which exists to stop a
                reviewer scoring nothing — has nothing to act on here. */}
            <div className="space-y-1.5">
              <Label htmlFor={`interview-points-${index}`} className="text-xs">
                Out of
              </Label>
              <Input
                id={`interview-points-${index}`}
                type="number"
                min={1}
                value={Number.isFinite(row.maxPoints) ? row.maxPoints : ""}
                disabled={locked || pending}
                onChange={(e) =>
                  update(index, {
                    maxPoints: e.target.value === "" ? Number.NaN : Number(e.target.value),
                  })
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
          {rows.length} categor{rows.length === 1 ? "y" : "ies"} · the scores sheet needs one
          column per category
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
        {pending ? "Saving…" : "Save interview rubric"}
      </Button>
    </div>
  );
}
