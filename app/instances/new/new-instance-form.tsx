"use client";

import { useActionState } from "react";

import { createInstance, type CreateInstanceState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function NewInstanceForm() {
  const [state, formAction, pending] = useActionState<CreateInstanceState, FormData>(
    createInstance,
    {},
  );

  return (
    <form action={formAction} className="mt-8 space-y-6">
      <div className="space-y-2">
        <Label htmlFor="name">Instance name</Label>
        <Input id="name" name="name" required placeholder="S26 Recruitment" autoFocus />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Instance password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />
        <p className="text-muted-foreground text-xs">
          At least 8 characters. Shared with the other admins for this cycle. It is stored only as a
          hash and cannot be recovered — an admin with the app password resets it.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="file">Application export (.csv)</Label>
        <Input id="file" name="file" type="file" accept=".csv,text/csv" required />
        <p className="text-muted-foreground text-xs">
          An instance accepts exactly one file and the import is final, so you will get a preview
          before anything commits.
        </p>
      </div>

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Reading the file…" : "Upload and map columns"}
      </Button>
    </form>
  );
}
