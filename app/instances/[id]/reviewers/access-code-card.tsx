"use client";

import { useActionState, useState, useSyncExternalStore } from "react";

import { setRoundCode, type ActionState } from "./actions";
import { Round } from "@/generated/prisma/enums";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ROUND_LABELS: Record<Round, string> = {
  [Round.WRITTEN]: "written round",
  [Round.FIRST_ROUND]: "first round",
  [Round.SECOND_ROUND]: "second round",
};

/// PRD decision 31. The one thing standing between an instance built through
/// FR-2 and a reviewer dashboard nobody can reach.
///
/// An uncontrolled form driven by `useActionState`, matching `ResetPasswordForm`
/// — the codebase's other "type a new secret" form. React resets a form once its
/// action completes, so the field a code was typed into clears itself on success.
/// An earlier version held the value in `useState` and cleared it by hand, and
/// the old value stayed on screen after a successful rotation; a secret field
/// still showing what you replaced reads as "the change did not take".
///
/// The parent renders this with `key={round}`, so switching rounds remounts it.
/// Without that the round nav is a client navigation, this component stays
/// mounted, and one round's success message and typed value carry over onto
/// another round's card.
export function AccessCodeCard({
  instanceId,
  round,
  hasCode,
}: {
  instanceId: string;
  round: Round;
  hasCode: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(setRoundCode, {});
  const [copied, setCopied] = useState(false);

  // The absolute link is assembled in the browser, because what an admin wants
  // to paste into Slack is the origin they are actually looking at. The server
  // knows only whatever Host header reached it.
  //
  // useSyncExternalStore rather than an effect: window.location is an external
  // value that never changes for the life of the page, so there is nothing to
  // subscribe to and nothing to set. The server snapshot is "", which is what
  // makes the first paint match on both sides and keeps hydration quiet.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );

  const path = `/r/${instanceId}?round=${round}`;
  const link = origin === "" ? path : `${origin}${path}`;

  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Reviewer access code</h2>
        <p className="text-muted-foreground text-xs">
          {hasCode
            ? `The ${ROUND_LABELS[round]} has a code. It cannot be read back — if it has been lost, set a new one.`
            : `The ${ROUND_LABELS[round]} has no code yet, so no reviewer can sign in to it.`}
        </p>
      </div>

      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="instanceId" value={instanceId} />
        <input type="hidden" name="round" value={round} />

        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor="round-code" className="text-xs">
            {hasCode ? "New code" : "Code"}
          </Label>
          <Input
            id="round-code"
            name="code"
            required
            minLength={6}
            // States the constraint rather than showing an example value.
            //
            // This used to read `written-s26`, which is prisma/seed.ts's real
            // written-round code. React clears this field when the action
            // succeeds, so the placeholder became visible for the first time
            // immediately below a green success message — grey text in a
            // just-cleared field, at that moment, is indistinguishable from a
            // value, and this one looked like the CORRECT value. An admin who
            // trusted it would paste a dead code to thirty reviewers.
            //
            // Any example would have the same shape of problem, so there is no
            // example. `minLength` is otherwise invisible until the browser
            // rejects a short one, so the hint earns its place saying that.
            placeholder="at least 6 characters"
            // Not type="password": an admin is choosing a value to paste into
            // Slack, not entering an existing secret, and hiding it invites the
            // typo that locks thirty reviewers out.
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : hasCode ? "Rotate" : "Set code"}
        </Button>
      </form>

      {state.error ? (
        <p role="alert" className="text-destructive text-xs">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <div className="space-y-1">
          <p className="text-xs text-emerald-600">{state.message}</p>
          {/* The success message is the exact moment the field goes empty, and an
              empty secret field reads as "nothing was saved" unless something
              says otherwise. The card's prose above already says a code cannot
              be read back, but that is above the fold of the admin's attention
              here — they are looking at the box they just typed into. */}
          <p className="text-muted-foreground text-xs">
            The box is empty because codes are never shown again, not because the change was lost.
            Copy the code from wherever you composed it, or set a new one.
          </p>
        </div>
      ) : null}

      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">Share this link with the code:</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="bg-muted rounded px-2 py-1 text-xs break-all">{link}</code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
    </section>
  );
}
