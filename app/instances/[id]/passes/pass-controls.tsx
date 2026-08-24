"use client";

import { useActionState, useState } from "react";

import { closePass, createPass, type PassActionState } from "./actions";
import { Button } from "@/components/ui/button";

/// FR-17's two state changes: create a pass, close the open one.
///
/// **Close carries a confirm step and create does not.** Creating is additive
/// and reversible in the only sense that matters — an empty pass can be closed
/// again — while closing is one-way: 17y says a closed pass cannot be reopened,
/// and an admin who closes pass 2 by mistake has no path back to it. The confirm
/// names what carries forward, because that is the consequence they cannot undo.
export function PassControls({
  instanceId,
  openPass,
  createBlockedBecause,
  poolSize,
}: {
  instanceId: string;
  openPass: { id: string; ordinal: number } | null;
  /// Null when a pass can be created. Computed server-side by
  /// `passCreationBlock`, the same function the action refuses with — a client's
  /// copy of the stage or the roster is only as fresh as the payload it arrived
  /// in.
  createBlockedBecause: string | null;
  poolSize: number;
}) {
  const [createState, createAction, creating] = useActionState<PassActionState, FormData>(
    createPass,
    {},
  );
  const [closeState, closeAction, closing] = useActionState<PassActionState, FormData>(
    closePass,
    {},
  );
  const [confirmingClose, setConfirmingClose] = useState(false);

  return (
    <div className="mt-8 space-y-4">
      {openPass === null ? (
        <form action={createAction} className="space-y-3">
          <input type="hidden" name="instanceId" value={instanceId} />

          {createBlockedBecause === null ? (
            <>
              <Button type="submit" disabled={creating}>
                {creating ? "Creating…" : "Create pass"}
              </Button>
              <p className="text-muted-foreground text-sm">
                Membership is fixed when the pass is created: the {poolSize} applicant
                {poolSize === 1 ? "" : "s"} active right now.
              </p>
            </>
          ) : (
            // No button at all rather than a disabled one with a tooltip. The
            // reason is the useful part, and a control that cannot be used is
            // a question the page has already answered.
            <p className="text-muted-foreground text-sm">{createBlockedBecause}</p>
          )}
        </form>
      ) : (
        <form action={closeAction} className="space-y-3">
          <input type="hidden" name="instanceId" value={instanceId} />
          <input type="hidden" name="passId" value={openPass.id} />

          {confirmingClose ? (
            <div className="space-y-3">
              <p className="text-sm">
                Close pass {openPass.ordinal}? Applicants it has not resolved stay active and
                carry into the next pass. A closed pass cannot be reopened.
              </p>
              <div className="flex gap-2">
                <Button type="submit" disabled={closing}>
                  {closing ? "Closing…" : `Close pass ${openPass.ordinal}`}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmingClose(false)}
                  disabled={closing}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="outline" onClick={() => setConfirmingClose(true)}>
              Close pass {openPass.ordinal}
            </Button>
          )}
        </form>
      )}

      <Feedback state={createState} />
      <Feedback state={closeState} />
    </div>
  );
}

function Feedback({ state }: { state: PassActionState }) {
  if (state.error) {
    return <p className="text-destructive text-sm">{state.error}</p>;
  }
  if (state.message) {
    return <p className="text-muted-foreground text-sm">{state.message}</p>;
  }
  return null;
}
