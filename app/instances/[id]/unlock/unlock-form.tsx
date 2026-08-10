"use client";

import { useActionState } from "react";

import { unlock, type UnlockState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function UnlockForm({ instanceId, next }: { instanceId: string; next: string }) {
  const [state, formAction, pending] = useActionState<UnlockState, FormData>(unlock, {});

  return (
    <form action={formAction} className="mt-8 space-y-4">
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="next" value={next} />

      <div className="space-y-2">
        <Label htmlFor="password">Instance password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          aria-describedby={state.error ? "unlock-error" : undefined}
        />
      </div>

      {state.error ? (
        <p id="unlock-error" role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Checking…" : "Unlock"}
      </Button>
    </form>
  );
}
