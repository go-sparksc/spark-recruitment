"use client";

import { useState, useTransition } from "react";

import { flagConflict } from "./actions";

/// FR-16's conflict flag, with decision 76's one-way warning in front of it.
///
/// **A confirm step, which almost nothing else on a reviewer surface has.**
/// CLAUDE.md is blunt that every extra tap is a review that does not get
/// finished, and this is the one control where that is outweighed: the action
/// deletes a vote the reviewer may already have cast (decision 68), takes them
/// out of the denominator for the rest of the round, and cannot be undone by
/// them afterwards. Return-to-pool in the written round is recoverable by
/// claiming the applicant back; this is not.
///
/// The confirm names all three consequences rather than asking "are you sure",
/// which is a question nobody can answer.
export function ConflictControl({
  instanceId,
  applicantId,
  applicantName,
  flagged,
  /// `row` is the list's treatment: a quiet right-aligned control that does not
  /// compete with the applicant's name. Thirty of these render at once, and a
  /// full-width button under every row turns a list of thirty applicants into a
  /// list of thirty buttons — which is what the first version did. `section` is
  /// the profile's, where it is the only control on screen and should look like
  /// one. Same component either way, per FR-9's precedent with ReturnControl.
  variant = "section",
}: {
  instanceId: string;
  applicantId: string;
  applicantName: string;
  flagged: boolean;
  variant?: "row" | "section";
}) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(flagged);

  const flag = () =>
    start(async () => {
      const formData = new FormData();
      formData.set("instanceId", instanceId);
      formData.set("applicantId", applicantId);

      const state = await flagConflict(formData);
      setError(state.error);
      if (!state.error) {
        setDone(true);
        setConfirming(false);
      }
    });

  // Already flagged: a statement, not a control. There is nothing this reviewer
  // can do here, and a disabled button invites tapping to find out why.
  if (done) {
    return variant === "row" ? (
      <p className="text-muted-foreground flex min-h-11 items-center justify-end text-xs">
        Conflict flagged — you will not vote on them
      </p>
    ) : (
      <p className="text-muted-foreground text-sm">
        You have a conflict of interest with {applicantName}. You will not vote on them in any
        pass. Ask an admin if this was a mistake.
      </p>
    );
  }

  if (!confirming) {
    return (
      <div className={variant === "row" ? undefined : "space-y-1"}>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={
            variant === "row"
              ? "text-muted-foreground hover:text-foreground flex min-h-11 w-full cursor-pointer items-center justify-end text-xs"
              : "hover:bg-muted active:bg-muted min-h-11 w-full rounded-md border text-sm font-medium"
          }
        >
          Flag a conflict of interest
        </button>
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm">
        Flagging a conflict with <span className="font-medium">{applicantName}</span> means:
      </p>
      <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
        <li>you will not vote on them in this pass or any later one</li>
        <li>any vote you have already cast on them is deleted</li>
        <li>you cannot undo this yourself — an admin has to</li>
      </ul>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={flag}
          className="border-destructive bg-destructive min-h-11 flex-1 rounded-md border text-sm font-medium text-white"
        >
          {pending ? "Flagging…" : "Flag conflict"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(false)}
          className="hover:bg-muted active:bg-muted min-h-11 flex-1 rounded-md border text-sm font-medium"
        >
          Cancel
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
