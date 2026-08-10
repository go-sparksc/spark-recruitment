"use client";

import { useActionState } from "react";

import { login, type LoginState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    <form action={formAction} className="mt-8 space-y-4">
      <input type="hidden" name="next" value={next} />

      <div className="space-y-2">
        <Label htmlFor="password">Admin password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          aria-describedby={state.error ? "password-error" : undefined}
        />
      </div>

      {state.error ? (
        <p id="password-error" role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Checking…" : "Sign in"}
      </Button>
    </form>
  );
}
