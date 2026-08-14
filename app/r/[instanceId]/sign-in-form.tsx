"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { signIn, type SignInState } from "./actions";
import { Round } from "@/generated/prisma/enums";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ReviewerOption {
  id: string;
  name: string;
}

/// One screen, one submit, per PRD decision 30. §8 buys impersonation
/// resistance with one extra field, not one extra step — and under FR-9 every
/// extra tap is a review that does not get completed.
export function SignInForm({
  instanceId,
  round,
  reviewers,
}: {
  instanceId: string;
  round: Round;
  reviewers: ReviewerOption[];
}) {
  const [state, formAction, pending] = useActionState<SignInState, FormData>(signIn, {});

  // Controlled, because React resets a form once its action completes — so with
  // uncontrolled inputs a wrong code throws away the name too, and the reviewer
  // starts again from a thirty-name dropdown to fix a one-character typo. Found
  // in the Slice 3 walkthrough, which is the only thing that could have found
  // it: it typechecks, it lints, and the action returns exactly the right error.
  const [reviewerId, setReviewerId] = useState("");
  const [code, setCode] = useState("");

  // Controlled state is not enough on its own, and this is the part that is not
  // obvious. React resets the form once the action settles, which returns the
  // <select> to whichever option carries the `selected` ATTRIBUTE — in
  // server-rendered HTML that is the "Pick your name…" placeholder, because SSR
  // stamps the attribute onto whatever matched `value=""` at render time. React
  // then re-renders, sees its own `value` prop unchanged, concludes there is
  // nothing to write, and leaves the DOM sitting on the placeholder. State says
  // one thing and the control shows another.
  //
  // The <Input> above needs no equivalent: React mirrors a controlled input's
  // value into its `value` attribute, so the reset restores it to the same
  // string it already had. That asymmetry between input and select IS the bug.
  //
  // Confirmed in a browser rather than reasoned about, including the control
  // case that proves the attribute is the cause: reach this page by a client
  // -side transition instead of a server render, where React creates the options
  // without ever setting `selected`, and the reset has nothing to snap back to
  // and the selection survives untouched.
  //
  // No dependency array on purpose — it must run after the post-action render,
  // which changes none of this component's own state. One string compare.
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const el = selectRef.current;
    if (el !== null && el.value !== reviewerId) el.value = reviewerId;
  });

  return (
    <form action={formAction} className="mt-6 space-y-5">
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="round" value={round} />

      <div className="space-y-2">
        <Label htmlFor="reviewerId">Your name</Label>
        <select
          id="reviewerId"
          name="reviewerId"
          ref={selectRef}
          // `required` is load-bearing, not decoration. With the placeholder at
          // value="" it is what stops the browser submitting a nameless form,
          // and it works before React has hydrated — which the disabled submit
          // button it might tempt someone to add would not. Removing it would
          // leave the server check below as the only guard.
          required
          value={reviewerId}
          onChange={(event) => setReviewerId(event.target.value)}
          // h-11 rather than the default: this is the first control a reviewer
          // touches, usually one-handed on a phone, and a 44px target is the
          // floor for a comfortable tap.
          className="border-input bg-background h-11 w-full rounded-md border px-3 text-base"
        >
          <option value="" disabled>
            Pick your name…
          </option>
          {reviewers.map((reviewer) => (
            <option key={reviewer.id} value={reviewer.id}>
              {reviewer.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="code">Access code</Label>
        <Input
          id="code"
          name="code"
          type="text"
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
          // Codes are shared in Slack and typed on a phone keyboard. Every one of
          // these attributes exists because a mobile browser would otherwise
          // capitalise, autocorrect or offer to save a value that is not a
          // password and is not a name.
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          className="h-11 text-base"
          aria-describedby={state.error ? "signin-error" : "code-hint"}
        />
        <p id="code-hint" className="text-muted-foreground text-xs">
          Shared in the Spark SC Slack, with the link that brought you here.
        </p>
      </div>

      {state.error ? (
        <p id="signin-error" role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="h-11 w-full text-base">
        {pending ? "Checking…" : "Start reviewing"}
      </Button>
    </form>
  );
}
