import { describe, expect, it } from "vitest";

import {
  createQueue,
  isSettled,
  nextDueAt,
  reduce,
  statusOf,
  withInitial,
  type DraftValue,
  type Effect,
  type QueueEvent,
  type QueueState,
} from "@/lib/autosave";

// These cases are the spec for FR-9 clause 4, per plans/phase-3.md's Slice 5
// walkthrough. Each one corresponds to something a reviewer would otherwise have
// to reproduce by hand on a phone in airplane mode: step 4 is the online retry,
// step 5 is the mirror, step 6 is coalescing. If a test here contradicts the
// walkthrough, the test is wrong.

const NOTE = "note";

/// Drives a sequence of [event, time] pairs and collects every effect, so a test
/// reads as the timeline it is describing rather than as nine reassignments.
function drive(
  start: QueueState,
  steps: readonly (readonly [QueueEvent, number])[],
): { state: QueueState; effects: Effect[] } {
  let state = start;
  const effects: Effect[] = [];
  for (const [event, at] of steps) {
    const result = reduce(state, event, at);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

type SaveEffect = Extract<Effect, { type: "save" }>;

/// A type predicate rather than a bare filter, so a test can read `.attempt` off
/// the result without casting.
const saves = (effects: readonly Effect[]): SaveEffect[] =>
  effects.filter((e): e is SaveEffect => e.type === "save");

const edit = (value: DraftValue, key = NOTE): QueueEvent => ({ type: "edit", key, value });

// ---------------------------------------------------------------------------
// Debounce and coalescing — walkthrough step 6
// ---------------------------------------------------------------------------

describe("the debounce", () => {
  it("issues exactly one save, after the window, carrying the edited value", () => {
    const { effects } = drive(createQueue(), [
      [edit("a note"), 0],
      [{ type: "tick" }, 599],
      [{ type: "tick" }, 600],
    ]);

    expect(saves(effects)).toEqual([
      { type: "save", key: NOTE, value: "a note", attempt: 1 },
    ]);
  });

  it("collapses two edits inside the window into one save carrying the second", () => {
    // "Fix a typo in the note twice in under a second. Reload: the second value
    // is what persisted." The debounce restarts on the second edit, so the save
    // lands at 200 + 600 rather than at 600.
    const { effects } = drive(createQueue(), [
      [edit("teh"), 0],
      [edit("the"), 200],
      [{ type: "tick" }, 600],
      [{ type: "tick" }, 800],
    ]);

    expect(saves(effects)).toEqual([{ type: "save", key: NOTE, value: "the", attempt: 1 }]);
  });

  it("mirrors every edit, including the ones coalescing discards", () => {
    // The save is coalesced; the mirror is not. Decision 26 makes the mirror the
    // guarantee, so it has to hold the latest keystroke at all times — including
    // during the 600 ms in which no save has been attempted at all.
    const { effects } = drive(createQueue(), [
      [edit("t"), 0],
      [edit("th"), 100],
      [edit("the"), 200],
    ]);

    expect(effects).toEqual([
      { type: "mirror", key: NOTE, value: "t" },
      { type: "mirror", key: NOTE, value: "th" },
      { type: "mirror", key: NOTE, value: "the" },
    ]);
    expect(saves(effects)).toEqual([]);
  });

  it("issues nothing for a value edited back to what the server already has", () => {
    const seeded = withInitial(createQueue(), NOTE, "original");
    const { state, effects } = drive(seeded, [
      [edit("original typo"), 0],
      [edit("original"), 100],
      [{ type: "tick" }, 700],
    ]);

    expect(saves(effects)).toEqual([]);
    expect(isSettled(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One flight per key
// ---------------------------------------------------------------------------

describe("in-flight coalescing", () => {
  it("never has two saves in flight for one key, and re-sends once the first lands", () => {
    const { effects } = drive(createQueue(), [
      [edit("first"), 0],
      [{ type: "tick" }, 600], // save "first"
      [edit("second"), 700], // arrives mid-flight; due at 1300
      [{ type: "tick" }, 800], // must NOT issue a second save
      [{ type: "settled", key: NOTE, ok: true }, 900],
      [{ type: "tick" }, 1000], // still inside the second edit's own debounce
      [{ type: "tick" }, 1300],
    ]);

    expect(saves(effects)).toEqual([
      { type: "save", key: NOTE, value: "first", attempt: 1 },
      { type: "save", key: NOTE, value: "second", attempt: 2 },
    ]);
  });

  it("does not clear the mirror while a newer edit is still unsent", () => {
    const { effects } = drive(createQueue(), [
      [edit("first"), 0],
      [{ type: "tick" }, 600],
      [edit("second"), 700],
      [{ type: "settled", key: NOTE, ok: true }, 900],
    ]);

    // "first" saved, but "second" has never reached the server. Dropping the
    // mirror here would lose it to a force-quit.
    expect(effects.filter((e) => e.type === "unmirror")).toEqual([]);
  });

  it("clears the mirror once the confirmed value is the current one", () => {
    const { effects } = drive(createQueue(), [
      [edit("only"), 0],
      [{ type: "tick" }, 600],
      [{ type: "settled", key: NOTE, ok: true }, 900],
    ]);

    expect(effects.filter((e) => e.type === "unmirror")).toEqual([
      { type: "unmirror", key: NOTE },
    ]);
  });

  it("ignores a stale settle for a key with nothing in flight", () => {
    const { state } = drive(createQueue(), [
      [edit("a"), 0],
      [{ type: "tick" }, 600],
      [{ type: "settled", key: NOTE, ok: true }, 700],
      [{ type: "settled", key: NOTE, ok: false }, 800], // late failure, already settled
    ]);

    expect(statusOf(state, NOTE)).toBe("saved");
  });
});

// ---------------------------------------------------------------------------
// Failure, backoff, and reconnect — walkthrough step 4
// ---------------------------------------------------------------------------

describe("retry", () => {
  it("backs off 1, 2, 4, 8 then holds at 15 seconds", () => {
    let state = createQueue();
    let at = 0;
    const due: number[] = [];

    state = reduce(state, edit("a"), at).state;
    at = 600;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      state = reduce(state, { type: "tick" }, at).state; // issues the save
      at += 50;
      state = reduce(state, { type: "settled", key: NOTE, ok: false }, at).state;
      const next = nextDueAt(state);
      expect(next).not.toBeNull();
      due.push(next! - at);
      at = next!;
    }

    expect(due).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });

  it("never reports saved after a failure, even once a save has succeeded before", () => {
    const { state } = drive(createQueue(), [
      [edit("first"), 0],
      [{ type: "tick" }, 600],
      [{ type: "settled", key: NOTE, ok: true }, 700], // confirmed: true
      [edit("second"), 1000],
      [{ type: "tick" }, 1600],
      [{ type: "settled", key: NOTE, ok: false }, 1700],
    ]);

    expect(statusOf(state, NOTE)).toBe("failed");
  });

  it("retries immediately on `online` and resets the backoff", () => {
    let state = createQueue();
    state = reduce(state, edit("a"), 0).state;
    state = reduce(state, { type: "tick" }, 600).state;
    state = reduce(state, { type: "settled", key: NOTE, ok: false }, 650).state;

    // Waiting until 1650 without the event.
    expect(nextDueAt(state)).toBe(1650);

    const online = reduce(state, { type: "online" }, 700);
    expect(saves(online.effects)).toEqual([
      { type: "save", key: NOTE, value: "a", attempt: 2 },
    ]);

    // And the next failure starts the backoff over at 1 s rather than at 2 s.
    const failed = reduce(online.state, { type: "settled", key: NOTE, ok: false }, 750);
    expect(nextDueAt(failed.state)).toBe(1750);
  });
});

// ---------------------------------------------------------------------------
// The offline → online transition
//
// Every case here is a regression test for one defect, found on a real phone in
// the Slice 5 walkthrough: airplane mode on, score tapped, "Unsaved — will
// retry" shown correctly; airplane mode off, and the card then sat on "Saving…"
// indefinitely and never recovered.
//
// The cause was that an in-flight save had no deadline. A fetch issued while the
// radio is down does not reliably reject — it can hang forever — and the retry
// path skipped any key that was `sending`, so the one state that most needed
// rescuing was the one state nothing could reach.
// ---------------------------------------------------------------------------

describe("recovering from a save that never answers", () => {
  /// Drives to the exact state the walkthrough reached: one failure recorded,
  /// then a retry issued that never comes back.
  function stuckInFlight() {
    let state = createQueue();
    state = reduce(state, edit(3), 0).state;
    state = reduce(state, { type: "tick" }, 600).state; // save issued
    state = reduce(state, { type: "settled", key: NOTE, ok: false }, 650).state; // rejected
    state = reduce(state, { type: "tick" }, 1650).state; // retry issued, never answers
    return state;
  }

  it("issues the retry when the connection returns", () => {
    // THE BUG: this returned no effects at all, so nothing was ever sent and the
    // status never moved off "Saving…" again.
    const { effects } = reduce(stuckInFlight(), { type: "online" }, 5000);

    expect(saves(effects)).toEqual([
      { type: "save", key: NOTE, value: 3, attempt: expect.any(Number) },
    ]);
  });

  it("leaves no deadline in the past for the interpreter to spin on", () => {
    // THE OTHER HALF: `online` set a due-date and then skipped the key for being
    // in flight, so `nextDueAt` kept returning a timestamp that had already
    // passed. The hook re-armed at zero delay forever and made no progress.
    const { state } = reduce(stuckInFlight(), { type: "online" }, 5000);

    const due = nextDueAt(state);
    expect(due).not.toBeNull();
    expect(due!).toBeGreaterThan(5000);
  });

  it("gives up on an unanswered save and retries it, with no online event at all", () => {
    // The reviewer whose connection returns without the browser firing `online`
    // — a captive portal, a flaky tower — must still recover.
    let state = createQueue({ saveTimeoutMs: 10000 });
    state = reduce(state, edit(3), 0).state;
    const first = reduce(state, { type: "tick" }, 600);
    state = first.state;
    expect(saves(first.effects)).toHaveLength(1);

    // Nine seconds in: still waiting, nothing abandoned.
    const early = reduce(state, { type: "tick" }, 9000);
    expect(saves(early.effects)).toEqual([]);
    expect(statusOf(early.state, NOTE)).toBe("saving");

    // Past the deadline: abandoned, counted as a failure, retry scheduled.
    state = reduce(state, { type: "tick" }, 10700).state;
    expect(statusOf(state, NOTE)).toBe("failed");

    const retry = reduce(state, { type: "tick" }, nextDueAt(state)!);
    expect(saves(retry.effects)).toHaveLength(1);
  });

  it("ignores a reply from an attempt it already gave up on", () => {
    // The hung request answering minutes later, after a retry has replaced it.
    // Believing it would report "Saved" for a value that is no longer current.
    let state = createQueue({ saveTimeoutMs: 10000 });
    state = reduce(state, edit("first"), 0).state;

    const issued = reduce(state, { type: "tick" }, 600);
    state = issued.state;
    const stale = saves(issued.effects)[0];

    state = reduce(state, { type: "tick" }, 10700).state; // abandoned
    state = reduce(state, edit("second"), 10800).state;

    const late = reduce(
      state,
      { type: "settled", key: NOTE, ok: true, attempt: stale.attempt },
      11000,
    );

    expect(statusOf(late.state, NOTE)).not.toBe("saved");
    expect(late.effects.filter((e) => e.type === "unmirror")).toEqual([]);
  });

  it("does not abandon a healthy save just because the reviewer backgrounded the app", () => {
    // `flush` asks for pending work to go sooner. It must never be read as
    // giving up on a request already on its way.
    let state = createQueue({ saveTimeoutMs: 10000 });
    state = reduce(state, edit(3), 0).state;
    state = reduce(state, { type: "tick" }, 600).state;

    const flushed = reduce(state, { type: "flush" }, 700);

    expect(saves(flushed.effects)).toEqual([]);
    expect(statusOf(flushed.state, NOTE)).toBe("saving");
    expect(nextDueAt(flushed.state)).toBe(600 + 10000);
  });
});

// ---------------------------------------------------------------------------
// Flush — backgrounding the app
// ---------------------------------------------------------------------------

describe("flush", () => {
  it("brings a pending debounce forward instead of waiting it out", () => {
    const { effects } = drive(createQueue(), [
      [edit("half typed"), 0],
      [{ type: "flush" }, 100],
    ]);

    expect(saves(effects)).toEqual([
      { type: "save", key: NOTE, value: "half typed", attempt: 1 },
    ]);
  });

  it("leaves an in-flight save alone rather than sending it twice", () => {
    const { effects } = drive(createQueue(), [
      [edit("a"), 0],
      [{ type: "tick" }, 600],
      [{ type: "flush" }, 650],
    ]);

    expect(saves(effects)).toHaveLength(1);
  });

  it("does not save fields the reviewer never touched", () => {
    // Fifteen assigned applicants, four categories each: a flush that wrote back
    // every seeded value would be sixty pointless writes on a backgrounded phone.
    let state = createQueue();
    state = withInitial(state, "score:c1", 3);
    state = withInitial(state, "score:c2", null);
    state = withInitial(state, NOTE, "unchanged");

    const { effects } = drive(state, [[{ type: "flush" }, 5000]]);
    expect(effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The selectors the UI and the navigation guard read
// ---------------------------------------------------------------------------

describe("statusOf and isSettled", () => {
  it("walks clean → dirty → saving → saved", () => {
    let state = withInitial(createQueue(), NOTE, "");
    expect(statusOf(state, NOTE)).toBe("clean");
    expect(isSettled(state)).toBe(true);

    state = reduce(state, edit("typing"), 0).state;
    expect(statusOf(state, NOTE)).toBe("dirty");
    expect(isSettled(state)).toBe(false);

    state = reduce(state, { type: "tick" }, 600).state;
    expect(statusOf(state, NOTE)).toBe("saving");
    expect(isSettled(state)).toBe(false);

    state = reduce(state, { type: "settled", key: NOTE, ok: true }, 700).state;
    expect(statusOf(state, NOTE)).toBe("saved");
    expect(isSettled(state)).toBe(true);
  });

  it("is unsettled while a retry is pending, which is what the 1500 ms guard waits on", () => {
    const { state } = drive(createQueue(), [
      [edit("a"), 0],
      [{ type: "tick" }, 600],
      [{ type: "settled", key: NOTE, ok: false }, 650],
    ]);

    expect(statusOf(state, NOTE)).toBe("failed");
    expect(isSettled(state)).toBe(false);
  });

  it("tracks keys independently, so one failing score does not mark the note unsaved", () => {
    let state = createQueue();
    state = reduce(state, edit("3", "score:c1"), 0).state;
    state = reduce(state, edit("a note"), 0).state;
    state = reduce(state, { type: "tick" }, 600).state;
    state = reduce(state, { type: "settled", key: "score:c1", ok: false }, 650).state;
    state = reduce(state, { type: "settled", key: NOTE, ok: true }, 660).state;

    expect(statusOf(state, "score:c1")).toBe("failed");
    expect(statusOf(state, NOTE)).toBe("saved");
    expect(isSettled(state)).toBe(false);
  });
});
