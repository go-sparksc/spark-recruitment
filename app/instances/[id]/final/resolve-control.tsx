"use client";

import { useActionState, useState } from "react";

import { decideApplicant, type FinalActionState } from "./actions";
import { Button } from "@/components/ui/button";

type Pending = "SPARKLET" | "REJECT" | null;

/// FR-19's admit-or-reject, on the one screen decision 70 leaves it to.
///
/// **Both outcomes are confirmed, and both confirms name the applicant.** This
/// decides someone the round could not decide, it is the last word on their
/// cycle, and the rows either side of it belong to different people. Phase 6
/// found two applicants called "Diego Hoffmann" indistinguishable on the FR-18
/// grid — the spreadsheet's core defect arriving at the presentation layer after
/// the data model had correctly refused it — so the handle rides in the confirm
/// beside the name rather than only in the row above.
///
/// **The confirm state is per-applicant by construction.** Phase 6's gate found
/// a confirm outliving the thing it confirmed: a bare boolean survived the pass
/// changing underneath it and came back expanded against a different target.
/// That cannot happen here, because this component is mounted once per applicant
/// and keyed by their id — when a resolved applicant leaves the group their
/// control unmounts with them, and every other row's confirm still refers to the
/// person it was opened for.
export function ResolveControl({
  instanceId,
  applicantId,
  applicantName,
  applicantHandle,
}: {
  instanceId: string;
  applicantId: string;
  applicantName: string;
  /// "Applicant 47".
  applicantHandle: string;
}) {
  const [state, formAction, pending] = useActionState<FinalActionState, FormData>(
    decideApplicant,
    {},
  );
  const [confirming, setConfirming] = useState<Pending>(null);

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="applicantId" value={applicantId} />

      {confirming === null ? (
        <div className="flex gap-2">
          {/*
            `type="button"` here only opens the confirm — the submit inside it is
            what mutates. Decision 33's rule is about controls that change data,
            and neither of these does until the second step.
          */}
          <Button type="button" size="sm" onClick={() => setConfirming("SPARKLET")}>
            Admit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setConfirming("REJECT")}
          >
            Reject
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">
            {confirming === "SPARKLET"
              ? `Admit ${applicantName} (${applicantHandle}) as a Sparklet?`
              : `Reject ${applicantName} (${applicantHandle})?`}{" "}
            {/*
              Said out loud because it is the surprising half: the pass row keeps
              saying the pass could not decide them, which is true and is what
              decision 89 preserves. An admin who later reads NEEDS_ADMIN beside
              a SPARKLET status should have met that here first.
            */}
            This is recorded as your decision. Their row in the final pass still reads
            &ldquo;needs an admin&rdquo;, because that is what the pass itself concluded.
          </p>
          <input type="hidden" name="outcome" value={confirming} />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant={confirming === "REJECT" ? "outline" : "default"}
              disabled={pending}
            >
              {pending
                ? confirming === "SPARKLET"
                  ? "Admitting…"
                  : "Rejecting…"
                : confirming === "SPARKLET"
                  ? "Admit"
                  : "Reject"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setConfirming(null)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {state.error ? <p className="text-destructive mt-2 text-sm">{state.error}</p> : null}
      {state.message ? <p className="text-muted-foreground mt-2 text-sm">{state.message}</p> : null}
    </form>
  );
}
