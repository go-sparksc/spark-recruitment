"use client";

import { useActionState, useState, useTransition } from "react";

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

/// Decision 35's second step. The first step is a plain `<Link>` to `?confirm=1`
/// on the page itself — it mutates nothing and is server-rendered, so it cannot
/// be a dead tap in the hydration window — and this form is what that link
/// reveals.
///
/// `useActionState` over an `onClick`, so errors render AND the form submits
/// natively before React has hydrated. The DeleteInstanceForm shape, which is
/// the other irreversible action in the product.
export function CommitForm({
  instanceId,
  keptCount,
}: {
  instanceId: string;
  keptCount: number;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(commitImport, {});

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="instanceId" value={instanceId} />
      <Button type="submit" disabled={pending}>
        {pending
          ? "Creating applicants…"
          : `Yes — create ${keptCount} applicant${keptCount === 1 ? "" : "s"} and commit`}
      </Button>
      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
