"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore } from "react";

import {
  guardServerSnapshot,
  guardSnapshot,
  requestFlush,
  subscribeToGuard,
} from "./guard-store";

/// How long an in-app navigation waits for a save to land before it says
/// anything, per PRD decision 26. The reasoning for the number is there in full:
/// roughly 5× the realistic worst case on a working connection, below the ~2 s
/// at which a person concludes the app is stuck, above the ~1 s that still reads
/// as an uninterrupted flow.
const HOLD_MS = 1500;

const POLL_MS = 50;

/// A link that will not carry the reviewer away from unsaved work without
/// saying so.
///
/// **Only in-app navigation is genuinely holdable, and this is it.** A tab close
/// is not — `beforeunload` is synchronous, dismissible, and its text is the
/// browser's — and decision 26 is explicit that the localStorage mirror rather
/// than any dialog is what makes "never a silent loss" true. So the copy below
/// is careful never to imply that leaving loses the work: it does not.
export function GuardedLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  // Subscribed for `failed`, which decides what the dialog offers. The settled
  // check itself is read straight from the store inside the handlers below,
  // because a click needs the value as it is at that instant rather than as it
  // was at the last render.
  const { failed } = useSyncExternalStore(subscribeToGuard, guardSnapshot, guardServerSnapshot);

  const [holding, setHolding] = useState(false);
  const [asked, setAsked] = useState(false);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);

  function stopWaiting() {
    for (const timer of timers.current) clearInterval(timer);
    timers.current = [];
  }

  function leave() {
    stopWaiting();
    setHolding(false);
    setAsked(false);
    router.push(href);
  }

  /// Poll the store rather than subscribe: this runs inside an event handler and
  /// needs the value as it changes, not as it renders. Fifty milliseconds is far
  /// below the threshold it is measuring against.
  function waitThenAsk() {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (guardSnapshot().settled) {
        leave();
        return;
      }
      if (Date.now() - startedAt >= HOLD_MS) {
        stopWaiting();
        setAsked(true);
      }
    }, POLL_MS);
    timers.current.push(timer);
  }

  function onClick(event: React.MouseEvent<HTMLAnchorElement>) {
    // Let the browser have the ones it should keep: a middle click, a
    // cmd/ctrl-click into a new tab, a right click.
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    // Nothing outstanding: this is the overwhelmingly common case and it must
    // cost nothing. `<Link>` navigates exactly as it would without the guard.
    if (guardSnapshot().settled) return;

    event.preventDefault();
    setHolding(true);
    // Send the pending debounce now rather than waiting it out, so the hold is
    // measuring a real request rather than a timer we set ourselves.
    requestFlush();
    waitThenAsk();
  }

  return (
    <>
      <Link href={href} onClick={onClick} className={className}>
        {children}
      </Link>

      {holding ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="guard-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
        >
          <div className="bg-background w-full max-w-sm rounded-lg border p-4 shadow-lg">
            <h2 id="guard-title" className="text-base font-medium">
              {asked && failed ? "Could not save that yet" : "Still saving"}
            </h2>

            {/* The honest version, and the reason decision 26 insists the mirror
                is the guarantee: leaving does NOT lose the change. It is kept on
                this device and retried. What leaving costs is that an admin
                cannot see it until it lands. */}
            <p className="text-muted-foreground mt-2 text-sm">
              {asked && failed
                ? "Your last change has not reached the server. It is saved on this device and will be sent when the connection comes back."
                : "Your last change has not reached the server yet."}
            </p>

            {asked ? (
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAsked(false);
                    requestFlush();
                    waitThenAsk();
                  }}
                  className="hover:bg-muted h-11 flex-1 rounded-md border px-3 text-sm font-medium"
                >
                  {failed ? "Retry" : "Wait"}
                </button>
                <button
                  type="button"
                  onClick={leave}
                  className="bg-foreground text-background h-11 flex-1 rounded-md px-3 text-sm font-medium"
                >
                  Leave anyway
                </button>
              </div>
            ) : (
              <p className="text-muted-foreground mt-4 text-xs">One moment…</p>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
