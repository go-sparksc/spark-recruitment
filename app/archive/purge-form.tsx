"use client";

import { useActionState } from "react";

import { purgeInstance, type PurgeState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/// The typed-name confirmation, mirroring the instance delete form.
///
/// A plain button would make an irreversible action one misclick away on a
/// screen that lists several cycles side by side — and the cycle above the one
/// you meant is always another real cycle.
export function PurgeForm({
  instanceId,
  instanceName,
}: {
  instanceId: string;
  instanceName: string;
}) {
  const [state, formAction, pending] = useActionState<PurgeState, FormData>(purgeInstance, {});

  if (state.done) {
    return (
      <p role="status" className="text-sm">
        {state.done}
      </p>
    );
  }

  return (
    <form action={formAction} className="mt-4 space-y-3">
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="expectedName" value={instanceName} />

      <div className="space-y-2">
        <Label htmlFor={`confirm-${instanceId}`} className="text-xs font-normal">
          Type <span className="font-medium">{instanceName}</span> to confirm
        </Label>
        <Input
          id={`confirm-${instanceId}`}
          name="confirmName"
          autoComplete="off"
          required
          aria-describedby={state.error ? `error-${instanceId}` : undefined}
        />
      </div>

      {state.error ? (
        <p id={`error-${instanceId}`} role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? "Archiving…" : "Archive and delete applicant data"}
      </Button>
    </form>
  );
}
