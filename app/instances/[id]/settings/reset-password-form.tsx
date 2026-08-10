"use client";

import { useActionState } from "react";

import { resetInstancePassword, type ResetPasswordState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ResetPasswordForm({ instanceId }: { instanceId: string }) {
  const [state, formAction, pending] = useActionState<ResetPasswordState, FormData>(
    resetInstancePassword,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="instanceId" value={instanceId} />

      <div className="space-y-2">
        <Label htmlFor="password">New instance password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          minLength={8}
          required
          autoComplete="new-password"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          minLength={8}
          required
          autoComplete="new-password"
        />
      </div>

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      {state.saved ? (
        <p className="text-sm text-emerald-600">
          Password reset. Share the new one with the other admins for this cycle.
        </p>
      ) : null}

      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Resetting…" : "Reset instance password"}
      </Button>
    </form>
  );
}
