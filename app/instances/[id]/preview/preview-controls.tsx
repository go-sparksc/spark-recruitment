"use client";

import { useState, useTransition } from "react";

import { commitImport, setRowDiscarded, setRowEmail, type ActionState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<ActionState | void>) => {
    setError(null);
    start(async () => {
      const result = await action();
      if (result?.error) setError(result.error);
    });
  };

  return { run, pending, error };
}

export function RowControls({
  instanceId,
  rowIndex,
  discarded,
  rawEmail,
  editable,
}: {
  instanceId: string;
  rowIndex: number;
  discarded: boolean;
  rawEmail: string;
  editable: boolean;
}) {
  const [email, setEmail] = useState(rawEmail);
  const { run, pending, error } = useAction();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {editable ? (
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => email !== rawEmail && run(() => setRowEmail(instanceId, rowIndex, email))}
          className="h-8 w-64 font-mono text-xs"
          aria-label={`Email for row ${rowIndex}`}
          disabled={pending || discarded}
        />
      ) : null}

      <Button
        size="sm"
        variant={discarded ? "outline" : "ghost"}
        disabled={pending}
        onClick={() => run(() => setRowDiscarded(instanceId, rowIndex, !discarded))}
      >
        {discarded ? "Restore" : "Discard"}
      </Button>

      {error ? (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function CommitButton({
  instanceId,
  canCommit,
  keptCount,
  warningCount,
}: {
  instanceId: string;
  canCommit: boolean;
  keptCount: number;
  warningCount: number;
}) {
  const { run, pending, error } = useAction();

  return (
    <div className="space-y-2">
      <Button
        disabled={pending || !canCommit}
        onClick={() => run(() => commitImport(instanceId))}
      >
        {pending
          ? "Creating applicants…"
          : `Commit — create ${keptCount} applicant${keptCount === 1 ? "" : "s"}`}
      </Button>
      <p className="text-muted-foreground text-xs">
        {canCommit
          ? warningCount > 0
            ? "The warnings above do not block this, but they will be much harder to fix afterwards."
            : "This is final. Correcting it afterwards means deleting the instance and importing again."
          : "Resolve the problems above first."}
      </p>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
