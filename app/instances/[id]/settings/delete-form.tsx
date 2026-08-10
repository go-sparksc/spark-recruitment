"use client";

import { useActionState, useState } from "react";

import { deleteInstance, type DeleteState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function DeleteInstanceForm({
  instanceId,
  instanceName,
}: {
  instanceId: string;
  instanceName: string;
}) {
  const [state, formAction, pending] = useActionState<DeleteState, FormData>(deleteInstance, {});
  const [typed, setTyped] = useState("");

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="instanceId" value={instanceId} />

      <div className="space-y-2">
        <Label htmlFor="confirmName">
          Type <span className="font-mono">{instanceName}</span> to confirm
        </Label>
        <Input
          id="confirmName"
          name="confirmName"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          aria-describedby={state.error ? "delete-error" : undefined}
        />
      </div>

      {state.error ? (
        <p id="delete-error" role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      {/* Disabled until the name matches, and the server checks it again — the
          client guard is a courtesy, not the control. */}
      <Button type="submit" variant="destructive" disabled={pending || typed !== instanceName}>
        {pending ? "Deleting…" : "Delete this instance permanently"}
      </Button>
    </form>
  );
}
