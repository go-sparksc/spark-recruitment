"use client";

import { useActionState } from "react";

import { setCurrentSemester, type SetSemesterState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/// Decision 119's set-once control. Rendered only while the instance has no
/// semester; once one is written the page shows it read-only instead, and the
/// action refuses a second write whatever the page shows.
///
/// A create-and-disappear form, so React 19's post-action form reset is harmless
/// here: on success the server re-renders the card without this form at all, and
/// on a refusal there is nothing typed worth keeping over the error.
export function SemesterForm({ instanceId }: { instanceId: string }) {
  const [state, formAction, pending] = useActionState<SetSemesterState, FormData>(
    setCurrentSemester,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="instanceId" value={instanceId} />

      <div className="flex gap-3">
        <select
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

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Setting…" : "Set semester permanently"}
      </Button>
    </form>
  );
}
