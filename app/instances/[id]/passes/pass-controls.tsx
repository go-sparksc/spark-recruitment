"use client";

import { useActionState, useState } from "react";

import { closePass, closeSecondRound, createPass, type PassActionState } from "./actions";
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
  closeRoundBlockedBecause,
  unresolvedOnFinalPass,
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
  /// Null when the round can be closed. Computed server-side by
  /// `closeRoundBlock`, the same function the action consults.
  closeRoundBlockedBecause: string | null;
  /// What the close would stamp NEEDS_ADMIN on, per decision 73. Shown in the
  /// confirm because it is the number that should stop an admin who meant to run
  /// one more pass.
  unresolvedOnFinalPass: number;
}) {
  const [createState, createAction, creating] = useActionState<PassActionState, FormData>(
    createPass,
    {},
  );
  const [closeState, closeAction, closing] = useActionState<PassActionState, FormData>(
    closePass,
    {},
  );
  // **Keyed to the pass, not a bare boolean.** As a boolean this survived the
  // pass changing underneath it: close pass 1, create pass 2, and the page came
  // back rendering "Close pass 2?" already expanded, one stray click from
  // closing a pass the admin had just made. Confirm state must not outlive the
  // thing it confirms, so it stores WHICH pass was being confirmed and the
  // render derives from the pass that is actually open now.
  const [confirmingCloseFor, setConfirmingCloseFor] = useState<string | null>(null);
  const confirmingClose = openPass !== null && confirmingCloseFor === openPass.id;

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
                  onClick={() => setConfirmingCloseFor(null)}
                  disabled={closing}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="outline" onClick={() => setConfirmingCloseFor(openPass.id)}>
              Close pass {openPass.ordinal}
            </Button>
          )}
        </form>
      )}

      <Feedback state={createState} />
      <Feedback state={closeState} />

      <CloseRound
        instanceId={instanceId}
        blockedBecause={closeRoundBlockedBecause}
        unresolvedOnFinalPass={unresolvedOnFinalPass}
      />
    </div>
  );
}

/// FR-17's "Close second round". The one control here that ends the cycle.
///
/// **Confirmed, and the confirm carries the number.** It moves the instance to
/// COMPLETE, closes the final pass, and stamps NEEDS_ADMIN on everyone still
/// undecided — and unlike closing a pass, there is no next thing after it. The
/// count is in the confirm because "12 applicants will need an admin decision"
/// is the fact that should stop an admin who meant to run one more pass.
function CloseRound({
  instanceId,
  blockedBecause,
  unresolvedOnFinalPass,
}: {
  instanceId: string;
  blockedBecause: string | null;
  unresolvedOnFinalPass: number;
}) {
  const [state, formAction, pending] = useActionState<PassActionState, FormData>(
    closeSecondRound,
    {},
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="mt-8 border-t pt-6">
      <h2 className="text-sm font-medium">Close the second round</h2>

      {blockedBecause !== null ? (
        <p className="text-muted-foreground mt-1 text-sm">{blockedBecause}</p>
      ) : (
        <form action={formAction} className="mt-2 space-y-3">
          <input type="hidden" name="instanceId" value={instanceId} />

          {confirming ? (
            <>
              <p className="text-sm">
                This ends the cycle. The final pass closes if it is still open, and{" "}
                {unresolvedOnFinalPass === 0
                  ? "every applicant on it has already been decided"
                  : `${unresolvedOnFinalPass} applicant${
                      unresolvedOnFinalPass === 1 ? "" : "s"
                    } still undecided on it will be marked as needing an admin decision`}
                . It cannot be reopened.
              </p>
              <div className="flex gap-2">
                <Button type="submit" disabled={pending}>
                  {pending ? "Closing…" : "Close second round"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirming(false)}
                  disabled={pending}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
              Close second round
            </Button>
          )}
        </form>
      )}

      <Feedback state={state} />
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
