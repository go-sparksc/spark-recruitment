// A module-level store carrying "is there unsaved work" between two client
// islands that cannot see each other any other way.
//
// The score card owns the autosave queue. The prev/next links need to know
// whether it has settled, and they live in a different subtree of a SERVER
// component — so React context cannot reach them, because the provider would
// have to wrap children the server page renders. The alternatives were to hoist
// the whole detail page into one client component, which would drag the §6
// projection across the boundary with it, or this.
//
// Same idiom score-card.tsx already used for its open/closed state:
// `useSyncExternalStore` over a listener set, with a server snapshot that keeps
// the first paint identical on both sides so hydration stays quiet.

export interface GuardSnapshot {
  /// Everything is saved: nothing dirty, debouncing, in flight, or retrying.
  settled: boolean;
  /// At least one save has failed and is waiting on a retry. Changes which
  /// choices the dialog offers.
  failed: boolean;
}

/// Frozen and reused, because `useSyncExternalStore` compares snapshots by
/// identity and a fresh object every read is an infinite render loop.
const SETTLED: GuardSnapshot = Object.freeze({ settled: true, failed: false });

let current: GuardSnapshot = SETTLED;
let flush: (() => void) | null = null;

const listeners = new Set<() => void>();

export function subscribeToGuard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function guardSnapshot(): GuardSnapshot {
  return current;
}

/// The server never has unsaved work, by definition.
export function guardServerSnapshot(): GuardSnapshot {
  return SETTLED;
}

/// Called by the autosave hook whenever its queue changes. Compares before
/// publishing so a keystroke that does not change the settled/failed pair does
/// not re-render every link on the page.
export function publishGuard(next: GuardSnapshot): void {
  if (next.settled === current.settled && next.failed === current.failed) return;
  current = next.settled && !next.failed ? SETTLED : Object.freeze({ ...next });
  for (const listener of listeners) listener();
}

/// The score card registers its flush so a guarded link can ask for a pending
/// debounce to be sent NOW rather than waiting the window out. Returns an
/// unregister for the unmount path.
export function registerFlush(fn: () => void): () => void {
  flush = fn;
  return () => {
    if (flush === fn) flush = null;
  };
}

export function requestFlush(): void {
  flush?.();
}

/// Reset on unmount, so navigating to an applicant with no unsaved work does not
/// inherit the previous one's state and block a link for 1500 ms.
export function resetGuard(): void {
  current = SETTLED;
  for (const listener of listeners) listener();
}
