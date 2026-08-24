"use client";

import { useActionState, useState } from "react";

import { manuallyReject } from "../actions";
import type { PassActionState } from "../actions";
import { Button } from "@/components/ui/button";

/// FR-17's manual reject, clause 17l. Decision 71.
///
/// **Confirmed, and the confirm names the applicant.** This is the one control
/// in the second round that decides an applicant outright without a vote, it
/// cannot be undone from this page, and the rows either side of it belong to
/// different people — a mis-tap here rejects the wrong person and the only route
/// back is an override on a later surface. The other destructive control in this
/// phase, closing a pass, is confirmed for the same reason.
export function RejectControl({
  instanceId,
  passId,
  applicantId,
  applicantName,
}: {
  instanceId: string;
  passId: string;
  applicantId: string;
  applicantName: string;
}) {
  const [state, formAction, pending] = useActionState<PassActionState, FormData>(
    manuallyReject,
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
          <p className="text-sm">
            Reject {applicantName}? They are excluded from this and every later pass, and any
            vote still in flight on them stops counting.
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Rejecting…" : "Reject"}
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
          Reject
        </Button>
      )}

      {state.error ? <p className="text-destructive mt-2 text-sm">{state.error}</p> : null}
      {state.message ? (
        <p className="text-muted-foreground mt-2 text-sm">{state.message}</p>
      ) : null}
    </form>
  );
}
