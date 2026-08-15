// FR-9 clause 4 — the autosave queue, as a pure state machine.
//
// No DOM, no timers, no network, no React. Same posture as lib/assignment.ts,
// lib/passes.ts, lib/roster.ts and lib/review.ts: the part of the phase that can
// actually be verified lives away from the surface that renders it.
//
// **Why this is a module and not a hook.** FR-9's fourth bullet — "autosave on
// every change; a dropped connection mid-review must not lose work" — is the one
// requirement in Phase 3 whose failure modes are invisible on a working
// connection. Debounce coalescing, one-flight-per-key, and retry backoff are all
// timing behaviour, and timing behaviour tested by hand on a phone in airplane
// mode is tested once, by someone who already knows what it should do. Here the
// clock is an argument, so every case in the block below is a test rather than a
// walkthrough step.
//
// The reducer decides WHAT should happen and returns it as effects. It never
// performs a save, writes to localStorage, or sets a timer — use-autosave.ts
// does all three. That split is the whole point: the interpreter is small enough
// to read, and everything worth getting wrong is in here where a test can hold
// it still.

/// Everything a reviewer can type into the score card. Deliberately narrow:
/// these values are compared with `===` and mirrored to localStorage as JSON,
/// and both of those are only correct for primitives.
export type DraftValue = string | number | null;

export type SaveStatus =
  /// Never edited, or edited back to what the server already had.
  | "clean"
  /// Changed and waiting for its debounce to expire.
  | "dirty"
  /// A save is in flight.
  | "saving"
  /// The server confirmed the current value.
  | "saved"
  /// The last attempt failed. Retrying on backoff.
  | "failed";

export type QueueEvent =
  | { type: "edit"; key: string; value: DraftValue }
  /// pagehide / visibilitychange:hidden. On a phone, backgrounding is the common
  /// case rather than the exception, so a pending debounce is fired rather than
  /// waited out — see PRD decision 26.
  | { type: "flush" }
  /// A scheduled wake-up arrived. Carries no data; `nowMs` is what matters.
  | { type: "tick" }
  /// The browser came back online.
  | { type: "online" }
  | { type: "settled"; key: string; ok: boolean };

export type Effect =
  /// Send this value for this key. One per key at a time, guaranteed by reduce.
  | { type: "save"; key: string; value: DraftValue }
  /// Write the localStorage mirror. Emitted on every edit, because decision 26
  /// makes the mirror — not the dialog — the thing that makes "never a silent
  /// loss" true.
  | { type: "mirror"; key: string; value: DraftValue }
  /// Drop this key from the mirror. Emitted ONLY on a confirmed save with
  /// nothing newer pending.
  | { type: "unmirror"; key: string };

interface KeyState {
  /// What the reviewer last entered.
  value: DraftValue;
  /// The last value the server confirmed.
  savedValue: DraftValue;
  /// The value handed to the in-flight save, meaningful only while `sending`.
  sendingValue: DraftValue;
  sending: boolean;
  /// Absolute ms at which a save should be issued. Null when nothing is pending.
  dueAt: number | null;
  /// Consecutive failures. Indexes into `backoffMs`.
  failures: number;
  /// Whether the server has ever confirmed this key, which is what separates
  /// "saved" from "clean" for a field the reviewer never touched.
  confirmed: boolean;
}

export interface QueueState {
  keys: Readonly<Record<string, KeyState>>;
  debounceMs: number;
  backoffMs: readonly number[];
}

export interface QueueOptions {
  /// 600 ms, per plans/phase-3.md. Long enough to coalesce a word, short enough
  /// that putting the phone down saves almost immediately.
  debounceMs?: number;
  /// Capped rather than unbounded: a reviewer who walks back into signal should
  /// wait at most this long, and `online` short-circuits it anyway.
  backoffMs?: readonly number[];
}

export const DEFAULT_DEBOUNCE_MS = 600;
export const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 15000];

export function createQueue(options: QueueOptions = {}): QueueState {
  return {
    keys: {},
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
  };
}

/// A key the queue has not seen. `savedValue` is seeded from what the server
/// rendered, so a field the reviewer never touches is `clean` rather than
/// pending — the queue must not save fifteen untouched fields on mount.
function seed(value: DraftValue): KeyState {
  return {
    value,
    savedValue: value,
    sendingValue: value,
    sending: false,
    dueAt: null,
    failures: 0,
    confirmed: false,
  };
}

function keyOf(state: QueueState, key: string): KeyState {
  return state.keys[key] ?? seed(null);
}

/// Issue saves for every key whose debounce has expired and which has nothing in
/// flight. Shared by `tick`, `flush` and `online` rather than written three
/// times, because "only one save per key at a time" has to hold on all three
/// paths and a second copy is where it stops holding.
function issueDue(
  keys: Record<string, KeyState>,
  nowMs: number,
): { keys: Record<string, KeyState>; effects: Effect[] } {
  const next: Record<string, KeyState> = { ...keys };
  const effects: Effect[] = [];

  for (const [key, entry] of Object.entries(keys)) {
    if (entry.sending) continue;
    if (entry.dueAt === null || entry.dueAt > nowMs) continue;

    // Nothing to send: the value was edited back to what the server already
    // has. Clear the pending state rather than issuing a no-op write.
    if (entry.value === entry.savedValue) {
      next[key] = { ...entry, dueAt: null, failures: 0 };
      continue;
    }

    next[key] = { ...entry, sending: true, sendingValue: entry.value, dueAt: null };
    effects.push({ type: "save", key, value: entry.value });
  }

  return { keys: next, effects };
}

/// The whole state machine. `nowMs` is an argument rather than a call to
/// Date.now so the tests can move time by hand, matching lib/rate-limit.ts.
export function reduce(
  state: QueueState,
  event: QueueEvent,
  nowMs: number,
): { state: QueueState; effects: Effect[] } {
  switch (event.type) {
    case "edit": {
      const entry = keyOf(state, event.key);

      // The debounce restarts on every edit, which is what makes two edits
      // inside the window collapse into one save carrying the second value.
      // Failures reset too: the reviewer has given us something new, and making
      // them serve out a backoff earned by the previous value would look like
      // the app ignoring them.
      const next: KeyState = {
        ...entry,
        value: event.value,
        dueAt: nowMs + state.debounceMs,
        failures: 0,
      };

      return {
        state: { ...state, keys: { ...state.keys, [event.key]: next } },
        // Mirrored before anything is sent, and mirrored on every change. This
        // is the effect that survives the OS killing the tab.
        effects: [{ type: "mirror", key: event.key, value: event.value }],
      };
    }

    case "tick": {
      const { keys, effects } = issueDue({ ...state.keys }, nowMs);
      return { state: { ...state, keys }, effects };
    }

    case "flush": {
      // Bring every pending debounce forward to now, then issue. Anything
      // already in flight is left alone — it is already on its way.
      const brought: Record<string, KeyState> = {};
      for (const [key, entry] of Object.entries(state.keys)) {
        brought[key] = entry.dueAt === null ? entry : { ...entry, dueAt: nowMs };
      }
      const { keys, effects } = issueDue(brought, nowMs);
      return { state: { ...state, keys }, effects };
    }

    case "online": {
      // A reviewer walking back into signal should not have to touch anything,
      // and should not wait out a backoff that was earned while there was no
      // network at all. Every failed key becomes due immediately and its backoff
      // resets.
      const revived: Record<string, KeyState> = {};
      for (const [key, entry] of Object.entries(state.keys)) {
        revived[key] =
          entry.failures > 0 ? { ...entry, dueAt: nowMs, failures: 0 } : entry;
      }
      const { keys, effects } = issueDue(revived, nowMs);
      return { state: { ...state, keys }, effects };
    }

    case "settled": {
      const entry = state.keys[event.key];
      // A settle for a key with nothing in flight is a stale callback from a
      // save that was already accounted for. Ignoring it is what stops a late
      // failure from marking a key failed after a later save succeeded.
      if (!entry || !entry.sending) return { state, effects: [] };

      if (!event.ok) {
        const failures = entry.failures + 1;
        const wait = state.backoffMs[Math.min(failures, state.backoffMs.length) - 1];
        const next: KeyState = {
          ...entry,
          sending: false,
          failures,
          dueAt: nowMs + wait,
        };
        // No unmirror. The mirror is the only remaining copy of this value and
        // dropping it here is precisely the silent loss decision 26 forbids.
        return { state: { ...state, keys: { ...state.keys, [event.key]: next } }, effects: [] };
      }

      const stillPending = entry.value !== entry.sendingValue;
      const next: KeyState = {
        ...entry,
        sending: false,
        savedValue: entry.sendingValue,
        failures: 0,
        confirmed: true,
        // An edit that arrived mid-flight keeps whatever debounce it set, rather
        // than being sent the instant the previous save lands — otherwise a
        // reviewer typing through a slow connection gets a save per round trip
        // instead of a save per pause.
        dueAt: stillPending ? (entry.dueAt ?? nowMs) : null,
      };

      return {
        state: { ...state, keys: { ...state.keys, [event.key]: next } },
        // Cleared only when the confirmed value is the current one. With a newer
        // edit pending, the mirror still holds work the server has never seen.
        effects: stillPending ? [] : [{ type: "unmirror", key: event.key }],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/// What to render beside a field.
///
/// **The order of these branches is the requirement.** `failed` is checked
/// before `confirmed`, so a key whose last attempt failed can never render as
/// saved — FR-9 clause 4b, and the difference between an honest status line and
/// one that tells a reviewer their work is safe when it is not.
export function statusOf(state: QueueState, key: string): SaveStatus {
  const entry = state.keys[key];
  if (!entry) return "clean";
  if (entry.sending) return "saving";
  if (entry.failures > 0) return "failed";
  if (entry.dueAt !== null) return "dirty";
  return entry.confirmed ? "saved" : "clean";
}

/// Whether everything has come to rest. The 1500 ms navigation guard in decision
/// 26 waits on exactly this.
export function isSettled(state: QueueState): boolean {
  return Object.values(state.keys).every(
    (entry) => !entry.sending && entry.dueAt === null && entry.failures === 0,
  );
}

/// True while a `beforeunload` handler should be registered — anything dirty,
/// debouncing, in flight, or waiting on a retry.
///
/// Note what this does NOT promise. `beforeunload` is dismissible and its
/// message is not ours to write; browsers have shown their own generic text
/// since 2017. It reduces how often the mirror is needed and nothing more.
export const hasUnsavedWork = (state: QueueState): boolean => !isSettled(state);

/// When the interpreter should next wake up, or null if there is nothing
/// pending. One timer for the whole queue rather than a `schedule` effect per
/// key: the queue already knows every deadline it holds, and a single derived
/// wake-up cannot drift out of step with the state the way a set of
/// individually-cancelled timers can.
export function nextDueAt(state: QueueState): number | null {
  let earliest: number | null = null;
  for (const entry of Object.values(state.keys)) {
    if (entry.dueAt === null) continue;
    if (earliest === null || entry.dueAt < earliest) earliest = entry.dueAt;
  }
  return earliest;
}

/// The value to render for a key, so the card can restore a mirrored draft
/// without the caller reaching into the state shape.
export function valueOf(state: QueueState, key: string): DraftValue | undefined {
  return state.keys[key]?.value;
}

/// Seed a key with what the server rendered, so an untouched field is `clean`
/// and is never saved back unchanged on mount.
export function withInitial(state: QueueState, key: string, value: DraftValue): QueueState {
  if (state.keys[key]) return state;
  return { ...state, keys: { ...state.keys, [key]: seed(value) } };
}
