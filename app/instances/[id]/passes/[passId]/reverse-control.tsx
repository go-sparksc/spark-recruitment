"use client";

import { useActionState, useState } from "react";

import { reverseManualReject } from "../actions";
import type { PassActionState } from "../actions";
import { Button } from "@/components/ui/button";

/// Decision 107's reversal of a manual reject, clause 17aa.
///
/// **Confirmed, and the confirm names the applicant**, for the same reason the
/// reject beside it is: this is the second control on this page that moves a
/// person's status without a vote, and the rows either side of it belong to
/// different people. A mis-tap here reinstates the wrong person into a live
/// deliberation, and the only route back from that is rejecting them again —
/// which writes two more rows into the log the club will read later.
export function ReverseControl({
  instanceId,
  passId,
  applicantId,
  applicantName,
  applicantHandle,
}: {
  instanceId: string;
  passId: string;
  applicantId: string;
  applicantName: string;
  /// "Applicant 47". Same reason as the reject control: names repeat, and this
  /// instance has two "Diego Hoffmann".
  applicantHandle: string;
}) {
  const [state, formAction, pending] = useActionState<PassActionState, FormData>(
    reverseManualReject,
    {},
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <form action={formAction} className="mt-2">
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="passId" value={passId} />
      <input type="hidden" name="applicantId" value={applicantId} />

      {confirming ? (
        <div className="space-y-2">
          {/* The four things decision 107 requires this to say: they come back
              to this pass and every later one, their row is cleared rather
              than restored, the votes on them are untouched, and the rejection
              is not erased from the record. */}
          <p className="text-sm">
            Reverse the rejection of {applicantName} ({applicantHandle})? They return to this
            pass as active with no resolution and will be included in every later pass. Any votes
            already cast on them still stand, and reviewers can vote on them again. The rejection
            itself stays in the activity log.
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Reversing…" : "Reverse rejection"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
          Reverse rejection
        </Button>
      )}

      {state.error ? <p className="text-destructive mt-2 text-sm">{state.error}</p> : null}
      {state.message ? (
        <p className="text-muted-foreground mt-2 text-sm">{state.message}</p>
      ) : null}
    </form>
  );
}
