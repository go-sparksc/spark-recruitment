"use client";

import { useState, useTransition } from "react";

import { submitFirstRoundVote } from "./actions";

/// FR-14's vote, and clause 14g's "explicit submit".
///
/// **On the applicant's page and nowhere else**, per decision 113, which is the
/// second round's pattern applied one round earlier. It used to render here and
/// on the list; the list now shows the reviewer's own vote as a marker instead.
///
/// Two buttons that each submit on tap rather than a selection plus a separate
/// Submit. That difference from FR-17's second round survives decision 113 and
/// is worth separating from what 113 changed: 113 is about *where* a vote may be
/// cast — only somewhere the evidence is on screen — and this is about how many
/// taps it costs once you are there. By the time a reviewer is on this page they
/// have the interview scores and notes in front of them, so the tap is the
/// explicit action FR-14 asks for and a second confirming tap buys nothing.
///
/// **Tapping the current vote again does not clear it.** Decision 63 allows a
/// change of mind, not an un-vote: there is no way to return to "no row", and
/// silently offering one would let a reviewer think they had abstained when the
/// row still stands. A reviewer who wants to abstain simply never votes.
export function VoteButtons({
  instanceId,
  applicantId,
  current,
}: {
  instanceId: string;
  applicantId: string;
  current: "YES" | "NO" | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  // Shown immediately so the tap feels answered before the round trip lands.
  const [optimistic, setOptimistic] = useState<"YES" | "NO" | null>(current);

  const vote = (value: "YES" | "NO") =>
    start(async () => {
      setOptimistic(value);
      const formData = new FormData();
      formData.set("instanceId", instanceId);
      formData.set("applicantId", applicantId);
      formData.set("value", value);

      const state = await submitFirstRoundVote(formData);
      setError(state.error);
      // The server refused, so put the button back where it was rather than
      // leaving a vote showing that was never recorded.
      if (state.error) setOptimistic(current);
    });

  // min-h-14: this is the control the whole screen exists for and it is tapped
  // on a phone. There was a `compact` variant for the list row; decision 113
  // removed that caller, and the prop went with it rather than staying as dead
  // configuration for a size nothing asks for.
  const base =
    "min-h-14 flex-1 rounded-md border text-base font-medium transition-colors";

  const style = (value: "YES" | "NO") => {
    const chosen = optimistic === value;
    if (value === "YES") {
      return chosen
        ? `${base} border-emerald-600 bg-emerald-600 text-white`
        : `${base} hover:bg-muted active:bg-muted`;
    }
    return chosen
      ? `${base} border-destructive bg-destructive text-white`
      : `${base} hover:bg-muted active:bg-muted`;
  };

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          aria-pressed={optimistic === "YES"}
          onClick={() => vote("YES")}
          className={style("YES")}
        >
          Yes
        </button>
        <button
          type="button"
          disabled={pending}
          aria-pressed={optimistic === "NO"}
          onClick={() => vote("NO")}
          className={style("NO")}
        >
          No
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
