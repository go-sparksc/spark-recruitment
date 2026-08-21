"use client";

import { useState, useTransition } from "react";

import {
  commitInterviewSheet,
  confirmFuzzyMatch,
  discardStagedSheet,
  mapRowManually,
  setColumnRole,
  setRowSkipped,
  type InterviewImportState,
} from "../actions";
import { Button } from "@/components/ui/button";

export interface CategoryOption {
  id: string;
  name: string;
}

export interface PoolOption {
  applicantId: string;
  label: string;
}

/// Clause 12f. One dropdown per column, pre-filled with what `proposeMapping`
/// suggested — a proposal the admin confirms or changes, never a silent
/// decision, which is the same posture FR-2's mapping table takes.
export function ColumnRoleSelect({
  instanceId,
  sheet,
  columnIndex,
  header,
  sample,
  value,
  categories,
}: {
  instanceId: string;
  sheet: string;
  columnIndex: number;
  header: string;
  /// The first non-empty value in this column. A header alone is often
  /// ambiguous — "Name" could be either party — and one real cell settles it
  /// faster than reading the file in another window.
  sample: string;
  value: string;
  categories: CategoryOption[];
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  const change = (role: string) =>
    start(async () => {
      const state = await setColumnRole(instanceId, sheet, columnIndex, role);
      setError(state.error);
    });

  return (
    <tr className="border-t">
      <td className="py-2 pr-4 align-top">
        <span className="font-medium">{header || <em>(no heading)</em>}</span>
        {sample ? (
          <span className="text-muted-foreground block max-w-xs truncate text-xs">{sample}</span>
        ) : (
          <span className="text-muted-foreground block text-xs">(empty in every row)</span>
        )}
        {error ? <span className="text-destructive block text-xs">{error}</span> : null}
      </td>
      <td className="py-2 align-top">
        <select
          value={value}
          disabled={pending}
          onChange={(e) => change(e.target.value)}
          aria-label={`Role for column ${columnIndex + 1}`}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="IGNORED">Not imported</option>
          <option value="APPLICANT_EMAIL">Applicant email</option>
          <option value="APPLICANT_NAME">Applicant name</option>
          <option value="INTERVIEWER_NAME">Interviewer name</option>
          {sheet === "scores" ? <option value="AVERAGE">Average</option> : null}
          {sheet === "notes" ? <option value="NOTES">Notes</option> : null}
          {sheet === "scores"
            ? categories.map((category) => (
                <option key={category.id} value={`CATEGORY:${category.id}`}>
                  Category — {category.name}
                </option>
              ))
            : null}
        </select>
      </td>
    </tr>
  );
}

/// FR-13's tier 3, presented for confirmation per decision 53.
///
/// The score is shown because it is the only thing distinguishing a nickname
/// from a different person with a similar name, and the admin is the one who can
/// tell them apart.
export function FuzzyRow({
  instanceId,
  sheet,
  rowIndex,
  rowName,
  candidateName,
  confidence,
}: {
  instanceId: string;
  sheet: string;
  rowIndex: number;
  rowName: string;
  candidateName: string;
  confidence: number | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  const act = (fn: () => Promise<InterviewImportState>) =>
    start(async () => setError((await fn()).error));

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-t py-3">
      <span className="text-sm">
        <span className="text-muted-foreground">Row {rowIndex}</span>{" "}
        <span className="font-medium">{rowName}</span>{" "}
        <span className="text-muted-foreground">→</span>{" "}
        <span className="font-medium">{candidateName}</span>
        {confidence !== null ? (
          <span className="text-muted-foreground tabular-nums"> ({confidence.toFixed(3)})</span>
        ) : null}
        {error ? <span className="text-destructive block text-xs">{error}</span> : null}
      </span>
      <span className="flex gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() => act(() => confirmFuzzyMatch(instanceId, sheet, rowIndex))}
        >
          Yes, same person
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => act(() => setRowSkipped(instanceId, sheet, rowIndex, true))}
        >
          Don&rsquo;t import
        </Button>
      </span>
    </li>
  );
}

/// FR-13's tier 4: "an unresolved queue the admin maps by hand."
///
/// A search over the whole scoped pool rather than a ranked guess. A row that
/// reached here found nobody, and offering a "did you mean" built from the same
/// comparison that already failed would be a suggestion with nothing behind it.
///
/// The alternatives list is only populated when the matcher found MORE than one
/// candidate — the ambiguous case, where the suggestions are real.
export function UnresolvedRow({
  instanceId,
  sheet,
  rowIndex,
  rowLabel,
  reason,
  alternatives,
  pool,
}: {
  instanceId: string;
  sheet: string;
  rowIndex: number;
  rowLabel: string;
  reason: string;
  alternatives: PoolOption[];
  pool: PoolOption[];
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [choice, setChoice] = useState("");

  const act = (fn: () => Promise<InterviewImportState>) =>
    start(async () => setError((await fn()).error));

  return (
    <li className="space-y-2 border-t py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm">
          <span className="text-muted-foreground">Row {rowIndex}</span>{" "}
          <span className="font-medium">{rowLabel || <em>(no name or email)</em>}</span>
        </span>
        <span className="text-muted-foreground text-xs">{reason}</span>
      </div>

      {alternatives.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {alternatives.map((option) => (
            <Button
              key={option.applicantId}
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                act(() => mapRowManually(instanceId, sheet, rowIndex, option.applicantId))
              }
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={choice}
          disabled={pending}
          onChange={(e) => setChoice(e.target.value)}
          aria-label={`Applicant for row ${rowIndex}`}
          className="border-input bg-background h-9 max-w-xs rounded-md border px-2 text-sm"
        >
          <option value="">Choose an applicant…</option>
          {pool.map((option) => (
            <option key={option.applicantId} value={option.applicantId}>
              {option.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={pending || choice === ""}
          onClick={() => act(() => mapRowManually(instanceId, sheet, rowIndex, choice))}
        >
          Map
        </Button>
        {/* PRD decision 51's third outcome. The label covers both uses: a row
            that matches nobody, and one side of a decision 49 collision the
            admin wants to drop. */}
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => act(() => setRowSkipped(instanceId, sheet, rowIndex, true))}
        >
          Don&rsquo;t import this row
        </Button>
      </div>

      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </li>
  );
}

/// A row the admin has set aside, with the way back. Without this, skipping is
/// a one-way door and a mis-click costs a re-upload.
export function SkippedRow({
  instanceId,
  sheet,
  rowIndex,
  rowLabel,
}: {
  instanceId: string;
  sheet: string;
  rowIndex: number;
  rowLabel: string;
}) {
  const [pending, start] = useTransition();

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-t py-2">
      <span className="text-muted-foreground text-sm">
        Row {rowIndex} · {rowLabel || <em>(no name or email)</em>}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => start(async () => void (await setRowSkipped(instanceId, sheet, rowIndex, false)))}
      >
        Import it after all
      </Button>
    </li>
  );
}

export function DiscardStagedButton({
  instanceId,
  sheet,
}: {
  instanceId: string;
  sheet: string;
}) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
        Discard this file
      </Button>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant="destructive"
        disabled={pending}
        onClick={() => start(async () => void (await discardStagedSheet(instanceId, sheet)))}
      >
        {pending ? "Discarding…" : "Discard, nothing imported"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}

/// The commit. A form bound to a server action rather than an onClick handler,
/// for decision 35's reason: this is the click that writes the round's scores,
/// and an inert-then-instant control is how "I do not think I clicked that"
/// happens.
export function CommitForm({
  instanceId,
  sheet,
  rowCount,
  disabled,
}: {
  instanceId: string;
  sheet: string;
  rowCount: number;
  disabled: boolean;
}) {
  const [state, setState] = useState<InterviewImportState>({});
  const [pending, start] = useTransition();

  return (
    <form
      action={(formData) =>
        start(async () => setState(await commitInterviewSheet({}, formData)))
      }
      className="space-y-3"
    >
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="sheet" value={sheet} />

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      {state.message ? <p className="text-sm text-emerald-600">{state.message}</p> : null}

      <Button type="submit" disabled={disabled || pending}>
        {pending ? "Importing…" : `Import ${rowCount} row${rowCount === 1 ? "" : "s"}`}
      </Button>
    </form>
  );
}
