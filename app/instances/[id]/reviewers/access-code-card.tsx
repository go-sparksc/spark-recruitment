"use client";

import { useState, useSyncExternalStore, useTransition } from "react";

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
export function AccessCodeCard({
  instanceId,
  round,
  hasCode,
}: {
  instanceId: string;
  round: Round;
  hasCode: boolean;
}) {
  const [code, setCode] = useState("");
  const [state, setState] = useState<ActionState>({});
  const [pending, startTransition] = useTransition();
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

  function submit() {
    startTransition(async () => {
      const result = await setRoundCode(instanceId, round, code);
      setState(result);
      if (!result.error) setCode("");
    });
  }

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

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor="round-code" className="text-xs">
            {hasCode ? "New code" : "Code"}
          </Label>
          <Input
            id="round-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="written-s26"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
          />
        </div>
        <Button type="button" onClick={submit} disabled={pending || code === ""}>
          {pending ? "Saving…" : hasCode ? "Rotate" : "Set code"}
        </Button>
      </div>

      {state.error ? (
        <p role="alert" className="text-destructive text-xs">
          {state.error}
        </p>
      ) : null}
      {state.message ? <p className="text-xs">{state.message}</p> : null}

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
