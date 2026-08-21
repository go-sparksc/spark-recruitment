"use client";

import { useState, useTransition } from "react";

import { submitFirstRoundVote } from "./actions";

/// FR-14's vote, and clause 14g's "explicit submit".
///
/// Two buttons that each submit on tap rather than a selection plus a separate
/// Submit. That is a deliberate difference from FR-17's second round, where the
/// PRD is explicit that selecting without submitting records nothing — a pass
/// vote is deliberated and a first-round vote is a reaction to a score sheet, so
/// the tap IS the explicit action. It also halves the taps, and CLAUDE.md is
/// blunt about what an extra tap costs on this surface.
///
/// **Tapping the current vote again does not clear it.** Decision 63 allows a
/// change of mind, not an un-vote: there is no way to return to "no row", and
/// silently offering one would let a reviewer think they had abstained when the
/// row still stands. A reviewer who wants to abstain simply never votes.
export function VoteButtons({
  instanceId,
  applicantId,
  current,
  /// Rendered large on the detail screen, compact in the list.
  size = "large",
}: {
  instanceId: string;
  applicantId: string;
  current: "YES" | "NO" | null;
  size?: "large" | "compact";
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

  // min-h-12 even in the compact form: this is the control the whole screen
  // exists for and it is tapped on a phone.
  const base =
    size === "large"
      ? "min-h-14 flex-1 rounded-md border text-base font-medium transition-colors"
      : "min-h-12 flex-1 rounded-md border text-sm font-medium transition-colors";

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
