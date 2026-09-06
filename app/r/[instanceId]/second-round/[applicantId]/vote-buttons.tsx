"use client";

import { useActionState, useState } from "react";

import { submitPassVote, type VoteState } from "../actions";
import { Button } from "@/components/ui/button";
import { VoteValue } from "@/generated/prisma/enums";
import type { VoteAvailability } from "@/lib/passes";

/// FR-17's vote control. Decision 82 puts it here, on the profile, and nowhere
/// else — a pass vote is the outcome of reading everything above it.
///
/// **Selecting is not submitting.** 17g: "A vote requires an explicit submit
/// action. Selecting yes/no without submitting records nothing." So the choice
/// lives in local state and the form posts only when Submit is pressed. Nothing
/// autosaves here, deliberately unlike the written round's score card — a score
/// is a draft a reviewer builds up, and a vote is a decision they make.
export function VoteButtons({
  instanceId,
  applicantId,
  availability,
}: {
  instanceId: string;
  applicantId: string;
  /// Computed on the server by `voteAvailability`, the same function the action
  /// refuses with. A client's copy of the pass state is only as fresh as the
  /// payload it arrived in.
  availability: VoteAvailability;
}) {
  const [state, formAction, pending] = useActionState<VoteState, FormData>(submitPassVote, {});
  const [choice, setChoice] = useState<VoteValue | null>(
    availability.kind === "OPEN" ? availability.current : null,
  );

  if (availability.kind === "NO_PASS") {
    return (
      <p className="text-muted-foreground rounded-md border p-4 text-sm">
        Voting opens when an admin starts a pass.
      </p>
    );
  }

  if (availability.kind === "NOT_IN_PASS") {
    return (
      <p className="text-muted-foreground rounded-md border p-4 text-sm">
        This applicant is not in the open pass.
      </p>
    );
  }

  if (availability.kind === "CONFLICT") {
    // 17e: automatically SKIP, and 17f: cannot vote. No control at all rather
    // than a disabled one — the reason is the useful part.
    return (
      <p className="text-muted-foreground rounded-md border p-4 text-sm">
        You have flagged a conflict on this applicant, so you are recorded as skipping them. You
        cannot vote on them in any pass.
      </p>
    );
  }

  if (availability.kind === "SETTLED") {
    // Deliberately does not say WHICH way it went — and cannot, since the
    // availability value carries no outcome to say. Decisions 74, 83 and 83a:
    // naming it would tell this reviewer how the others voted.
    return (
      <p className="text-muted-foreground rounded-md border p-4 text-sm">
        This pass has finished with this applicant, so votes can no longer change.
      </p>
    );
  }

  const submitted = availability.current;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="applicantId" value={applicantId} />
      <input type="hidden" name="value" value={choice ?? ""} />

      <div className="grid grid-cols-2 gap-2">
        {[VoteValue.YES, VoteValue.NO].map((option) => (
          <Button
            key={option}
            type="button"
            variant={choice === option ? "default" : "outline"}
            // min-h-12: a thumb target, the same ergonomics the rest of the
            // reviewer dashboard is built to.
            className="min-h-12"
            aria-pressed={choice === option}
            onClick={() => setChoice(option)}
            disabled={pending}
          >
            {option === VoteValue.YES ? "Yes" : "No"}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || choice === null}>
          {pending ? "Submitting…" : submitted === null ? "Submit vote" : "Change vote"}
        </Button>

        {submitted !== null && choice === submitted ? (
          <span className="text-muted-foreground text-sm">
            You voted {submitted === VoteValue.YES ? "yes" : "no"}.
          </span>
        ) : null}
      </div>

      {choice === null ? (
        <p className="text-muted-foreground text-sm">Choose yes or no, then submit.</p>
      ) : null}

      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      {state.message ? <p className="text-muted-foreground text-sm">{state.message}</p> : null}
    </form>
  );
}
