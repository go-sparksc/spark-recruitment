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

      {/* Decision 119. No preselected season and no prefilled year: the value is
          permanent, so a default nobody chose would be a guess that sticks. */}
      <fieldset className="space-y-2">
        <legend className="text-sm leading-none font-medium">Current semester</legend>
        <div className="flex gap-3">
          <select
            id="currentTermSeason"
            name="currentTermSeason"
            required
            defaultValue=""
            aria-label="Season"
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
          >
            <option value="" disabled>
              Season…
            </option>
            <option value="SPRING">Spring</option>
            <option value="FALL">Fall</option>
          </select>
          <Input
            id="currentTermYear"
            name="currentTermYear"
            required
            inputMode="numeric"
            pattern="[0-9]{4}"
            maxLength={4}
            placeholder="Year"
            aria-label="Year"
            className="w-28"
          />
        </div>
        <p className="text-muted-foreground text-xs">
          The semester this cycle runs in. Class standing is counted from it, and it{" "}
          <strong>cannot be changed later</strong> — a wrong one mislabels every applicant, and the
          only fix is deleting the instance. Check it before you continue.
        </p>
      </fieldset>

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
