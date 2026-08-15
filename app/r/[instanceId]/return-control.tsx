"use client";

import { useId } from "react";

import { returnToPool } from "./actions";
import { clearDraft } from "./a/[assignmentId]/draft-store";
import { MAX_RETURN_NOTE_LENGTH } from "@/lib/review";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/// FR-9 clause 5: "'Return to pool' on any applicant, with a required reason
/// (conflict of interest / other)."
///
/// **One component, rendered on the list AND on the detail screen**, because
/// "any applicant" is where the clause is met and the list is where it matters
/// most: a reviewer who recognizes a name has to be able to hand it back
/// without opening the applicant they are trying not to read.
///
/// **`<details>` rather than a modal, and that is the whole trick.** It opens
/// natively, so the control works with no JavaScript and works identically
/// before React attaches — decision 33's standard met without a dialog, a
/// portal or a state machine. `required` on the radio group is the browser's
/// half of clause 5b; `validateReturn` on the server is the half that is a
/// boundary.
///
/// The only thing the client wrapper adds is decision 38's draft clear, hung on
/// `onSubmit` as a side effect exactly as `sign-out-button.tsx` does, so the
/// submit path is unchanged rather than merely still present.
export function ReturnControl({
  instanceId,
  assignmentId,
  label,
  className,
}: {
  instanceId: string;
  assignmentId: string;
  /// "Applicant 47". Named in the question so a reviewer with fifteen rows on
  /// screen can see which one they are about to hand back.
  label: string;
  className?: string;
}) {
  // Fifteen of these render on the list at once. Without a unique id per
  // instance every label points at the first row's radios.
  const id = useId();

  return (
    <details className={className}>
      <summary className="text-muted-foreground hover:text-foreground flex min-h-11 cursor-pointer items-center justify-end px-4 text-xs">
        Return to pool
      </summary>

      <form
        action={returnToPool}
        onSubmit={() => {
          // Decision 38. Not awaited and not blocking: draft-store swallows its
          // own storage errors, and a browser with no localStorage must still
          // be able to return an applicant.
          clearDraft(assignmentId);
        }}
        className="space-y-3 px-4 pt-1 pb-4"
      >
        <input type="hidden" name="instanceId" value={instanceId} />
        <input type="hidden" name="assignmentId" value={assignmentId} />

        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-medium">Hand {label} back — why?</legend>

          {/* min-h-11 on the label, not the input: the whole line is the tap
              target. A 16px radio is not a phone control. */}
          <label
            htmlFor={`${id}-coi`}
            className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-md px-2 text-sm"
          >
            <input
              id={`${id}-coi`}
              type="radio"
              name="reason"
              value="CONFLICT_OF_INTEREST"
              required
              className="size-4"
            />
            I know this applicant
          </label>

          <label
            htmlFor={`${id}-other`}
            className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-md px-2 text-sm"
          >
            <input
              id={`${id}-other`}
              type="radio"
              name="reason"
              value="OTHER"
              required
              className="size-4"
            />
            Something else
          </label>
        </fieldset>

        {/* Optional for BOTH reasons, per decision 27 — including "Something
            else", which is the half that ships as required by accident. The
            placeholder says so, because a box under a radio reads as required
            unless it tells you otherwise. */}
        <Textarea
          name="note"
          rows={2}
          maxLength={MAX_RETURN_NOTE_LENGTH}
          placeholder="Anything an admin should know (optional)"
          className="text-base"
        />

        <div className="flex items-center gap-3">
          <Button type="submit" variant="outline" size="sm">
            Return to pool
          </Button>
          <span className="text-muted-foreground text-xs">
            It goes back to the pool for someone else.
          </span>
        </div>
      </form>
    </details>
  );
}
