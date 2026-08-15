"use client";

// The interpreter for lib/autosave.ts.
//
// Everything the reducer deliberately refuses to do lives here and nowhere else:
// one timer, the server-action call, and the localStorage mirror. The split is
// what lets the timing rules be tested against a fake clock — see
// lib/autosave.test.ts, which is the actual specification of the behaviour this
// file carries out.
//
// Read that file before changing this one. A rule added here rather than there
// is a rule with no test.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createQueue,
  isSettled,
  nextDueAt,
  reduce,
  statusOf,
  valueOf,
  withInitial,
  type DraftValue,
  type Effect,
  type QueueEvent,
  type QueueState,
  type SaveStatus,
} from "@/lib/autosave";
import { clearDraftField, purgeExpiredDrafts, writeDraftField } from "./draft-store";
import { publishGuard, registerFlush, resetGuard } from "./guard-store";

export interface UseAutosave {
  /// Record a change. The queue decides when, or whether, it reaches the server.
  edit: (key: string, value: DraftValue) => void;
  /// What to render beside the field.
  status: (key: string) => SaveStatus;
  /// The current value, for fields whose display is driven by state rather than
  /// left to the DOM.
  value: (key: string) => DraftValue | undefined;
  /// Send anything pending immediately.
  flush: () => void;
}

export function useAutosave({
  assignmentId,
  initial,
  send,
}: {
  assignmentId: string;
  /// Seeded from what the server rendered, so an untouched field is `clean` and
  /// is never written back unchanged.
  initial: Readonly<Record<string, DraftValue>>;
  send: (key: string, value: DraftValue) => Promise<{ ok: boolean; error?: string }>;
}): UseAutosave {
  const [state, setState] = useState<QueueState>(() => {
    let seeded = createQueue();
    for (const [key, value] of Object.entries(initial)) seeded = withInitial(seeded, key, value);
    return seeded;
  });

  // The reducer needs the latest state synchronously, and `setState` is not.
  // Every dispatch reads and writes this ref, and `state` exists only to
  // re-render — which is why nothing below ever reads `state` to make a
  // decision.
  const stateRef = useRef(state);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `send` is re-created on every render of the card, and a dispatch that
  // depended on it would tear down the timer each time. Held in a ref and
  // updated in an effect rather than during render, so the render stays pure.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  // A save resolves by dispatching `settled`, which means dispatch has to reach
  // itself. Through a ref rather than directly: the callback cannot close over
  // the binding it is being assigned to.
  const dispatchRef = useRef<((event: QueueEvent) => void) | null>(null);

  const dispatch = useCallback(
    (event: QueueEvent) => {
      const result = reduce(stateRef.current, event, Date.now());
      stateRef.current = result.state;
      setState(result.state);

      for (const effect of result.effects) {
        runEffect(effect);
      }

      function runEffect(effect: Effect) {
        switch (effect.type) {
          case "mirror":
            writeDraftField(assignmentId, effect.key, effect.value);
            return;

          case "unmirror":
            clearDraftField(assignmentId, effect.key);
            return;

          case "save": {
            // A rejected promise and a returned `{ ok: false }` are the same
            // thing to the queue: it did not land, so keep the mirror and retry.
            // The distinction matters to nobody here — a dropped connection
            // rejects, a refused value returns.
            // `attempt` is carried back so the queue can tell this reply from
            // one belonging to a request it has already given up on. A save
            // issued as the radio came back can answer minutes later, long
            // after a retry has replaced it, and believing it would report
            // "Saved" for a value that is no longer current.
            void sendRef.current(effect.key, effect.value)
              .then((result) => {
                dispatchRef.current?.({
                  type: "settled",
                  key: effect.key,
                  ok: result.ok,
                  attempt: effect.attempt,
                });
              })
              .catch(() => {
                dispatchRef.current?.({
                  type: "settled",
                  key: effect.key,
                  ok: false,
                  attempt: effect.attempt,
                });
              });
            return;
          }
        }
      }
    },
    [assignmentId],
  );

  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  // One timer for the whole queue, re-armed on every state change, rather than a
  // timer per key. `nextDueAt` already knows every deadline the queue holds, so
  // there is exactly one thing to cancel and nothing that can drift out of step.
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    const due = nextDueAt(state);
    if (due === null) return;

    timerRef.current = setTimeout(
      () => dispatch({ type: "tick" }),
      Math.max(0, due - Date.now()),
    );

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [state, dispatch]);

  // Tell the navigation guard where things stand. Publishing from an effect
  // rather than inside `dispatch` keeps it in step with what has actually
  // rendered.
  useEffect(() => {
    const settled = isSettled(state);
    const failed = Object.keys(state.keys).some((key) => statusOf(state, key) === "failed");
    publishGuard({ settled, failed });
  }, [state]);

  const flush = useCallback(() => dispatch({ type: "flush" }), [dispatch]);

  useEffect(() => registerFlush(flush), [flush]);
  useEffect(() => () => resetGuard(), []);

  useEffect(() => {
    purgeExpiredDrafts();
  }, []);

  // Backgrounding, reconnecting, and leaving.
  useEffect(() => {
    const onHide = () => {
      // On a phone this is the common case rather than the exception: the
      // reviewer switches apps mid-note. Firing the pending debounce here is
      // what stops most of these from ever becoming a warning — decision 26.
      if (document.visibilityState === "hidden") flush();
    };
    const onPageHide = () => flush();
    const onOnline = () => dispatch({ type: "online" });

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Registered only while something is genuinely unsaved. The message is not
      // ours to write — every browser has shown its own generic text since 2017
      // — and the reviewer can dismiss it. Decision 26 claims nothing more for
      // it than that: the mirror is what makes the promise true, and this only
      // reduces how often the mirror is needed.
      if (isSettled(stateRef.current)) return;
      event.preventDefault();
    };

    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dispatch, flush]);

  return {
    edit: useCallback(
      (key: string, value: DraftValue) => dispatch({ type: "edit", key, value }),
      [dispatch],
    ),
    status: useCallback((key: string) => statusOf(state, key), [state]),
    value: useCallback((key: string) => valueOf(state, key), [state]),
    flush,
  };
}
