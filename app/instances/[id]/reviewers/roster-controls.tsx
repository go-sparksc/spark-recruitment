"use client";

import { useState, useTransition } from "react";

import {
  addReviewer,
  addRound,
  commitPaste,
  previewPaste,
  previewRemoval,
  removeReviewer,
  renameReviewer,
  setSparklet,
  type ActionState,
  type NameState,
  type PasteResolution,
} from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Round } from "@/generated/prisma/enums";
import type { ParsedRoster, RosterEntry } from "@/lib/roster";

export interface ReviewerRow {
  id: string;
  firstName: string;
  lastName: string;
  isSparklet: boolean;
  rounds: Round[];
  assignmentCount: number;
}

const ROUNDS: { value: Round; label: string }[] = [
  { value: Round.WRITTEN, label: "Written" },
  { value: Round.FIRST_ROUND, label: "First round" },
  { value: Round.SECOND_ROUND, label: "Second round" },
];

const roundLabel = (round: Round) => ROUNDS.find((r) => r.value === round)?.label ?? round;

/// One queued line plus what the admin has decided about it. `firstName` and
/// `lastName` are editable here, which is how an UNSPLITTABLE line gets a last
/// name before it can be committed.
interface QueueItem {
  entry: RosterEntry;
  firstName: string;
  lastName: string;
  choice: "PENDING" | "CREATE" | "ADD_ROUND" | "DROP";
}

export function RosterControls({
  instanceId,
  round,
  reviewers,
}: {
  instanceId: string;
  round: Round;
  reviewers: ReviewerRow[];
}) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedRoster | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [state, setState] = useState<ActionState>({});
  const [pending, start] = useTransition();

  const preview = () =>
    start(async () => {
      const result = await previewPaste(instanceId, round, text);
      setParsed(result);
      setQueue(
        result.needsConfirmation.map((entry) => ({
          entry,
          firstName: entry.firstName,
          lastName: entry.lastName,
          // Nothing is pre-selected, for any flag kind. A default here is the
          // system answering the question it just asked: pre-picking "keep both"
          // silently splits one person in two, and pre-picking "add the round"
          // silently merges two people into one.
          choice: "PENDING",
        })),
      );
      setState({});
    });

  const unresolved = queue.filter((item) => item.choice === "PENDING").length;
  const missingLastName = queue.filter(
    (item) => item.choice === "CREATE" && item.lastName.trim() === "",
  ).length;
  const canCommit =
    parsed !== null && unresolved === 0 && missingLastName === 0 && !pending;

  const commit = () =>
    start(async () => {
      if (parsed === null) return;

      const resolutions: PasteResolution[] = [
        ...parsed.ready.map(
          (entry): PasteResolution => ({
            kind: "CREATE",
            firstName: entry.firstName,
            lastName: entry.lastName,
          }),
        ),
        ...queue.flatMap((item): PasteResolution[] => {
          if (item.choice === "CREATE") {
            return [
              { kind: "CREATE", firstName: item.firstName, lastName: item.lastName },
            ];
          }
          if (item.choice === "ADD_ROUND" && item.entry.match) {
            return [{ kind: "ADD_ROUND", reviewerId: item.entry.match.reviewerId }];
          }
          return [];
        }),
      ];

      const result = await commitPaste(instanceId, round, resolutions);
      setState(result);
      if (!result.error) {
        setText("");
        setParsed(null);
        setQueue([]);
      }
    });

  const update = (index: number, patch: Partial<QueueItem>) =>
    setQueue((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  return (
    <div className="space-y-10">
      <AddReviewerForm instanceId={instanceId} round={round} roundLabel={roundLabel(round)} />

      <section className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="paste">Or paste names, one per line</Label>
          <p className="text-muted-foreground text-sm">
            Everyone pasted joins the {roundLabel(round).toLowerCase()} as a non-Sparklet. Set the
            Sparklet flag and any other rounds in the grid below.
          </p>
        </div>
        <textarea
          id="paste"
          value={text}
          disabled={pending}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          className="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-sm"
          placeholder={"Mary Anne Chen\nAlex Kim"}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={pending || text.trim() === ""} onClick={preview}>
            {pending ? "Checking…" : "Check this paste"}
          </Button>
          {parsed !== null ? (
            <span className="text-muted-foreground text-sm">
              {parsed.ready.length} ready · {parsed.needsConfirmation.length} need confirming ·{" "}
              {parsed.droppedLineCount} blank line
              {parsed.droppedLineCount === 1 ? "" : "s"} ignored
            </span>
          ) : null}
        </div>
      </section>

      {parsed !== null && parsed.needsConfirmation.length > 0 ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-medium">Needs confirming</h2>
            <p className="text-muted-foreground text-sm">
              Nothing here imports until you say what it is. Two reviewers really can share a name,
              so neither answer is assumed.
            </p>
          </div>

          {queue.map((item, index) => (
            <div key={item.entry.lineNumber} className="space-y-3 rounded-md border p-4">
              <div className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="text-muted-foreground">Line {item.entry.lineNumber}</span>
                <code className="bg-muted rounded px-1.5 py-0.5">{item.entry.raw}</code>
              </div>

              {item.entry.flags.includes("UNSPLITTABLE") ? (
                <div className="space-y-2">
                  <p className="text-sm">
                    This line has no last name. Every reviewer needs one, so give it one or drop
                    the line.
                  </p>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor={`first-${index}`} className="text-xs">
                        First name
                      </Label>
                      <Input
                        id={`first-${index}`}
                        value={item.firstName}
                        className="h-9 w-48"
                        onChange={(e) => update(index, { firstName: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`last-${index}`} className="text-xs">
                        Last name
                      </Label>
                      <Input
                        id={`last-${index}`}
                        value={item.lastName}
                        className="h-9 w-48"
                        onChange={(e) => update(index, { lastName: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {item.entry.flags.includes("DUPLICATE_IN_PASTE") ? (
                <p className="text-sm">
                  This name appears more than once in the paste. If they are two different people,
                  keep both.
                </p>
              ) : null}

              {item.entry.flags.includes("MATCHES_EXISTING_REVIEWER") ? (
                <p className="text-sm">
                  {item.entry.match?.alreadyServesThisRound
                    ? `Someone with this name is already in the ${roundLabel(round).toLowerCase()}. Adding the round again would do nothing.`
                    : `Someone with this name is already on this instance, in another round. Add this round to them, or create a second reviewer if they are a different person.`}
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {item.entry.match ? (
                  <Button
                    size="sm"
                    variant={item.choice === "ADD_ROUND" ? "default" : "outline"}
                    onClick={() => update(index, { choice: "ADD_ROUND" })}
                  >
                    Add this round to them
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant={item.choice === "CREATE" ? "default" : "outline"}
                  onClick={() => update(index, { choice: "CREATE" })}
                >
                  {item.entry.match ? "Create a second reviewer" : "Keep this one"}
                </Button>
                <Button
                  size="sm"
                  variant={item.choice === "DROP" ? "destructive" : "ghost"}
                  onClick={() => update(index, { choice: "DROP" })}
                >
                  Drop
                </Button>
              </div>

              {item.choice === "CREATE" && item.lastName.trim() === "" ? (
                <p className="text-destructive text-sm">This one still needs a last name.</p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      {parsed !== null ? (
        <div className="space-y-2">
          {unresolved > 0 ? (
            <p className="text-muted-foreground text-sm">
              {unresolved} line{unresolved === 1 ? "" : "s"} still to confirm.
            </p>
          ) : null}
          {state.error ? (
            <p role="alert" className="text-destructive text-sm">
              {state.error}
            </p>
          ) : null}
          <Button disabled={!canCommit} onClick={commit}>
            {pending ? "Importing…" : "Import"}
          </Button>
        </div>
      ) : null}

      {state.message ? <p className="text-sm text-emerald-600">{state.message}</p> : null}

      <RosterGrid instanceId={instanceId} reviewers={reviewers} onResult={setState} />
    </div>
  );
}

/// FR-6's primary path: first name, last name, Sparklet checkbox.
function AddReviewerForm({
  instanceId,
  round,
  roundLabel,
}: {
  instanceId: string;
  round: Round;
  roundLabel: string;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [isSparklet, setIsSparklet] = useState(false);
  const [state, setState] = useState<NameState>({});
  const [pending, start] = useTransition();

  const submit = (confirmDuplicate: boolean) =>
    start(async () => {
      const result = await addReviewer(
        instanceId,
        round,
        { firstName, lastName, isSparklet },
        confirmDuplicate,
      );
      setState(result);
      if (result.message) {
        setFirstName("");
        setLastName("");
        setIsSparklet(false);
      }
    });

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Add a reviewer</h2>
        <p className="text-muted-foreground text-sm">
          Joins the {roundLabel.toLowerCase()}. Add them to other rounds in the grid below.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="add-first" className="text-xs">
            First name
          </Label>
          <Input
            id="add-first"
            value={firstName}
            disabled={pending}
            className="h-9 w-48"
            onChange={(e) => setFirstName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="add-last" className="text-xs">
            Last name
          </Label>
          <Input
            id="add-last"
            value={lastName}
            disabled={pending}
            className="h-9 w-48"
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isSparklet}
            disabled={pending}
            onChange={(e) => setIsSparklet(e.target.checked)}
          />
          Sparklet
        </label>
        <Button
          size="sm"
          disabled={pending || (firstName.trim() === "" && lastName.trim() === "")}
          onClick={() => submit(false)}
        >
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>

      {state.needsConfirmation ? (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm">
            {state.needsConfirmation.matchCount === 1 ? "Someone" : "More than one reviewer"} on
            this instance is already called {state.needsConfirmation.firstName}{" "}
            {state.needsConfirmation.lastName}. Two reviewers can share a name — add anyway?
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => submit(true)}>
              Add anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setState({})}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      {state.message ? <p className="text-sm text-emerald-600">{state.message}</p> : null}
    </section>
  );
}

/// Inline rename. A pasted typo has to be fixable, and before this the only
/// remedy was Remove and paste again.
function NameCell({
  instanceId,
  reviewer,
  onResult,
}: {
  instanceId: string;
  reviewer: ReviewerRow;
  onResult: (state: ActionState) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState(reviewer.firstName);
  const [lastName, setLastName] = useState(reviewer.lastName);
  const [state, setState] = useState<NameState>({});
  const [pending, start] = useTransition();

  const save = (confirmDuplicate: boolean) =>
    start(async () => {
      const result = await renameReviewer(
        instanceId,
        reviewer.id,
        { firstName, lastName },
        confirmDuplicate,
      );
      setState(result);
      if (result.message) {
        setEditing(false);
        setState({});
        onResult(result);
      }
    });

  const cancel = () => {
    setFirstName(reviewer.firstName);
    setLastName(reviewer.lastName);
    setState({});
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <span>
          {reviewer.firstName} {reviewer.lastName}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Edit
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="First name"
          value={firstName}
          disabled={pending}
          className="h-8 w-36"
          onChange={(e) => setFirstName(e.target.value)}
        />
        <Input
          aria-label="Last name"
          value={lastName}
          disabled={pending}
          className="h-8 w-36"
          onChange={(e) => setLastName(e.target.value)}
        />
        <Button size="sm" disabled={pending} onClick={() => save(false)}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      </div>

      {state.needsConfirmation ? (
        <div className="space-y-2">
          <p className="text-sm">
            Another reviewer is already called {state.needsConfirmation.firstName}{" "}
            {state.needsConfirmation.lastName}. Rename anyway?
          </p>
          <Button size="sm" disabled={pending} onClick={() => save(true)}>
            Rename anyway
          </Button>
        </div>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function RosterGrid({
  instanceId,
  reviewers,
  onResult,
}: {
  instanceId: string;
  reviewers: ReviewerRow[];
  onResult: (state: ActionState) => void;
}) {
  const [pending, start] = useTransition();
  /// The reviewer and round a confirmation is currently open for, plus the
  /// verdict the server gave for it. Null when nothing is being confirmed.
  const [confirming, setConfirming] = useState<{
    reviewerId: string;
    round: Round | null;
    verdict: { allowed: boolean; text: string };
  } | null>(null);

  const sparkletCount = reviewers.filter((r) => r.isSparklet).length;

  const ask = (reviewerId: string, round: Round | null) =>
    start(async () => {
      const verdict = await previewRemoval(instanceId, reviewerId, round);
      setConfirming({
        reviewerId,
        round,
        verdict: {
          allowed: verdict.allowed,
          text: verdict.allowed ? verdict.consequence : verdict.reason,
        },
      });
    });

  const confirm = () =>
    start(async () => {
      if (confirming === null) return;
      onResult(await removeReviewer(instanceId, confirming.reviewerId, confirming.round));
      setConfirming(null);
    });

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">
          Roster — {reviewers.length} reviewer{reviewers.length === 1 ? "" : "s"}, {sparkletCount}{" "}
          Sparklet{sparkletCount === 1 ? "" : "s"}
        </h2>
        <p className="text-muted-foreground text-sm">
          At most one Sparklet reviews any given applicant, so this count decides whether
          assignment is possible at all.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b text-left">
            <tr>
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Sparklet</th>
              {ROUNDS.map((r) => (
                <th key={r.value} className="py-2 pr-4 font-medium">
                  {r.label}
                </th>
              ))}
              <th className="py-2 pr-4 font-medium">Assigned</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {reviewers.map((reviewer) => (
              <tr key={reviewer.id} className="border-b last:border-0">
                <td className="py-2 pr-4">
                  <NameCell instanceId={instanceId} reviewer={reviewer} onResult={onResult} />
                </td>
                <td className="py-2 pr-4">
                  <input
                    type="checkbox"
                    aria-label={`${reviewer.firstName} ${reviewer.lastName} is a Sparklet`}
                    checked={reviewer.isSparklet}
                    disabled={pending}
                    onChange={(e) =>
                      start(async () => {
                        onResult(await setSparklet(instanceId, reviewer.id, e.target.checked));
                      })
                    }
                  />
                </td>
                {ROUNDS.map((r) => {
                  const serves = reviewer.rounds.includes(r.value);
                  return (
                    <td key={r.value} className="py-2 pr-4">
                      <input
                        type="checkbox"
                        aria-label={`${reviewer.firstName} ${reviewer.lastName} serves the ${r.label} round`}
                        checked={serves}
                        disabled={pending}
                        onChange={() =>
                          start(async () => {
                            // Unchecking can destroy assignments, so it goes
                            // through the same guard as removal. Checking cannot,
                            // so it just happens.
                            if (serves) {
                              ask(reviewer.id, r.value);
                            } else {
                              onResult(await addRound(instanceId, reviewer.id, r.value));
                            }
                          })
                        }
                      />
                    </td>
                  );
                })}
                <td className="text-muted-foreground py-2 pr-4">{reviewer.assignmentCount}</td>
                <td className="py-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => ask(reviewer.id, null)}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirming !== null ? (
        <div
          role="alertdialog"
          aria-label="Confirm removal"
          className="space-y-3 rounded-md border p-4"
        >
          <p className={confirming.verdict.allowed ? "text-sm" : "text-destructive text-sm"}>
            {confirming.verdict.text}
          </p>
          <div className="flex gap-2">
            {confirming.verdict.allowed ? (
              <Button size="sm" variant="destructive" disabled={pending} onClick={confirm}>
                {pending ? "Removing…" : "Remove"}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              {confirming.verdict.allowed ? "Cancel" : "Close"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
