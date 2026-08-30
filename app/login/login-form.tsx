"use client";

import { useActionState } from "react";

import { login, type LoginState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_ADMIN_NAME_LENGTH } from "@/lib/session";

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    <form action={formAction} className="mt-8 space-y-4">
      <input type="hidden" name="next" value={next} />

      {/* Name first, password last, matching the order the sentence below
          explains them in. autoComplete uses the given/family tokens rather
          than "name" so a browser fills these from the person's own profile
          and never from a saved credential for this site — the name is not
          part of the credential and must not be stored as though it were. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="firstName">First name</Label>
          <Input
            id="firstName"
            name="firstName"
            autoComplete="given-name"
            maxLength={MAX_ADMIN_NAME_LENGTH}
            autoFocus
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="lastName">Last name</Label>
          <Input
            id="lastName"
            name="lastName"
            autoComplete="family-name"
            maxLength={MAX_ADMIN_NAME_LENGTH}
            required
          />
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        Your name is not a password and is not checked. It is recorded against anything you
        change, so the club can tell who did what.
      </p>

      <div className="space-y-2">
        <Label htmlFor="password">Admin password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
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
