"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import { saveNote, saveNoteForm, saveScore, saveScoreForm } from "../../actions";
import { readDraft } from "./draft-store";
import { useAutosave } from "./use-autosave";
import { type DraftValue, type SaveStatus } from "@/lib/autosave";
import { MAX_NOTE_LENGTH } from "@/lib/review";
import { Textarea } from "@/components/ui/textarea";

export interface RubricRow {
  id: string;
  name: string;
  maxPoints: number;
  /// What the reviewer is actually scoring against, per PRD decision 32. Null
  /// where the admin left it blank, which FR-4 permits.
  description: string | null;
  points: number | null;
}

/// Above this, a segmented row stops being a control and becomes a wall of
/// buttons — `MAX_POINTS_CEILING` is 1000, so a 100-point category is legal.
/// Ten is the point at which the row still fits a phone without wrapping.
const SEGMENTED_LIMIT = 10;

const scoreKey = (categoryId: string) => `score:${categoryId}`;
const NOTE_KEY = "note";

// ---------------------------------------------------------------------------
// Whether the card is expanded, remembered across applicants
// ---------------------------------------------------------------------------

const OPEN_KEY = "spark-review:score-card-open";

/// localStorage does not fire `storage` in the document that wrote it, so the
/// card needs its own notification to re-render after a toggle. Small enough to
/// live here rather than become a utility nobody else uses.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/// useSyncExternalStore rather than an effect: localStorage is external state,
/// and the server snapshot below is what keeps the first paint identical on both
/// sides so hydration stays quiet.
function useCardOpen(): [boolean, () => void] {
  const open = useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(OPEN_KEY) === "1",
    () => false,
  );

  function toggle() {
    window.localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    for (const listener of listeners) listener();
  }

  return [open, toggle];
}

// ---------------------------------------------------------------------------
// Whether React has attached
// ---------------------------------------------------------------------------

/// Nothing to subscribe to: the value changes once, when React hydrates, and the
/// re-render that follows is the notification.
const NEVER_CHANGES = () => () => {};

/// F-11. `false` on the server and during the hydration render, `true` after —
/// which is what lets a control be present before React attaches and absent
/// afterwards without the two renders disagreeing. Same `useSyncExternalStore`
/// discipline as `useCardOpen` above, and for the same reason: a `typeof window`
/// branch read during render is precisely the mismatch F-13 spent an afternoon
/// ruling out.
function useHydrated(): boolean {
  return useSyncExternalStore(
    NEVER_CHANGES,
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// **A failed save never renders as saved.** lib/autosave.ts guarantees the
/// status itself; this is only its wording, and the wording is held to the same
/// standard: "Unsaved" says the server does not have it, and does not imply the
/// work is gone, because the mirror still holds it.
function statusLabel(status: SaveStatus): string | null {
  switch (status) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "failed":
      return "Unsaved — will retry";
    case "dirty":
    case "clean":
      return null;
  }
}

function StatusText({ status }: { status: SaveStatus }) {
  const label = statusLabel(status);
  if (label === null) return null;

  return (
    <span
      // aria-live so a reviewer using a screen reader hears "Saved" without
      // having to go looking for it. Polite: it must not interrupt them typing.
      aria-live="polite"
      className={
        status === "failed"
          ? "text-destructive shrink-0 text-xs"
          : "text-muted-foreground shrink-0 text-xs"
      }
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------

/// FR-9 bullets 2, 3 and 4: the rubric always visible alongside, score inputs
/// per category, a free-text note, and autosave on every change.
///
/// **Every control here is a form submit bound to a server action**, per PRD
/// decision 33. Before React attaches, a tap POSTs natively and the server
/// saves it — the hydration window is a working control rather than a dead one.
/// After hydration, `onSubmit` calls `preventDefault` first, which suppresses
/// React's own dispatch of the action, and the autosave queue sends it instead;
/// so a score costs one request rather than a full route re-render.
///
/// **The note is uncontrolled on purpose, and this is the part that is not
/// obvious.** A controlled field is overwritten by React's own (empty) state at
/// hydration, which is exactly how decision 33 loses work typed in that window.
/// An uncontrolled one is left alone, so the keystrokes survive in the DOM and
/// the mount effect below adopts them. The opposite choice — controlled — is
/// what sign-in-form.tsx needs, because a form React DISPATCHES gets reset when
/// its action settles. Neither field here is in such a form, which is what makes
/// uncontrolled safe. Changing either half breaks the other.
export function ScoreCard({
  instanceId,
  assignmentId,
  rubric,
  noteBody,
}: {
  instanceId: string;
  assignmentId: string;
  rubric: RubricRow[];
  noteBody: string;
}) {
  const [open, toggle] = useCardOpen();
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const initial: Record<string, DraftValue> = {
    [NOTE_KEY]: noteBody,
    ...Object.fromEntries(rubric.map((row) => [scoreKey(row.id), row.points])),
  };

  const autosave = useAutosave({
    assignmentId,
    initial,
    /// The FormData is built to match the native POST exactly, field for field.
    /// One shape on the wire means the no-JavaScript path and this one are the
    /// same request, so testing either tests both.
    send: async (key, value) => {
      const body = new FormData();
      body.set("instanceId", instanceId);
      body.set("assignmentId", assignmentId);

      if (key === NOTE_KEY) {
        body.set("body", value === null ? "" : String(value));
        return saveNote(body);
      }

      body.set("rubricCategoryId", key.slice("score:".length));
      body.set("points", value === null ? "" : String(value));
      return saveScore(body);
    },
  });

  // Mount reconciliation, in a fixed order: **what is in the DOM beats the
  // mirror, and the mirror beats what the server rendered.**
  //
  // The DOM first because anything there was typed by the reviewer just now, in
  // the hydration window, and is the newest thing in the building — decision
  // 33's first mitigation. The mirror second because it is work the server has
  // never seen (a force-quit, a dead battery), and restoring it marked UNSAVED
  // is the case decision 26 keeps the mirror for. The server's own value last.
  //
  // Runs once. A dependency array with `initial` in it would re-run on every
  // render and fight the reviewer for the cursor.
  useEffect(() => {
    const draft = readDraft(assignmentId);

    const typed = noteRef.current?.value;
    if (typed !== undefined && typed !== noteBody) {
      autosave.edit(NOTE_KEY, typed);
    } else {
      const mirrored = draft[NOTE_KEY];
      if (typeof mirrored === "string" && mirrored !== noteBody && noteRef.current) {
        noteRef.current.value = mirrored;
        autosave.edit(NOTE_KEY, mirrored);
      }
    }

    // Scores have no equivalent DOM read: a tap before hydration already POSTed
    // and re-rendered, so there is no unsent state sitting in the markup. Only
    // the mirror can hold one.
    for (const row of rubric) {
      const key = scoreKey(row.id);
      const mirrored = draft[key];
      if (mirrored === undefined) continue;
      const value = mirrored === null ? null : Number(mirrored);
      if (value !== row.points) autosave.edit(key, value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pointsFor = (row: RubricRow): number | null => {
    const held = autosave.value(scoreKey(row.id));
    if (held === undefined) return row.points;
    return held === null ? null : Number(held);
  };

  const scored = rubric.filter((row) => pointsFor(row) !== null).length;
  const summary = `${scored}/${rubric.length} scored`;

  return (
    <aside
      className={
        // `sticky`, NOT `fixed`. On mobile Chrome a fixed element with bottom-0
        // anchors to the LAYOUT viewport, which stays full height while the URL
        // bar is showing — so the bar renders below the visible area and looks
        // like it is missing entirely. Found on a real phone; desktop Chrome at
        // the same width cannot reproduce it, because it has no collapsing
        // browser chrome. Sticky is laid out in normal flow and its offset is
        // resolved against the scrollport, so the mismatch does not arise.
        //
        // Being in flow also removes the need to pad the page out from under a
        // floating bar: the card takes its own space at the end, so the last
        // response and the prev/next controls are never covered once scrolled to.
        //
        // -mx-4 cancels the page gutter so the bar is full-bleed on narrow.
        // The env() padding keeps it clear of an iPhone home indicator.
        // shadow, not just a hairline border: on a phone this has to read as a
        // raised surface sitting over the essay, or it looks like one more line
        // of page text at the bottom edge.
        "bg-background sticky bottom-0 z-10 -mx-4 border-t shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.25)] " +
        "pb-[env(safe-area-inset-bottom)] " +
        "lg:top-6 lg:bottom-auto lg:z-0 lg:mx-0 lg:rounded-md lg:border lg:shadow-none lg:pb-0"
      }
      aria-label="Rubric and scoring"
    >
      {/* The whole bar is the control, and it says so in words. The first
          version showed only "0/4 scored" and a glyph, and on a real phone that
          read as a label rather than a button — the owner reported hunting for
          the tiny arrow instead of tapping anywhere on the row.

          min-h-14 is a 56px target against the 44px floor, text-base rather than
          text-sm, and the chevron sits in a bordered circle so there is
          something that visibly looks pressable. Hidden from lg up, where the
          card is always open. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex min-h-14 w-full items-center justify-between gap-3 px-4 text-base font-medium lg:hidden"
      >
        <span>
          {open ? "Hide rubric" : "Score this applicant"}
          <span className="text-muted-foreground ml-2 font-normal tabular-nums">{summary}</span>
        </span>
        <span
          aria-hidden
          className="text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full border text-xs"
        >
          {open ? "▼" : "▲"}
        </span>
      </button>

      {/* max-h + scroll so the expanded card can never grow past the screen.
          Because the card is sticky to the BOTTOM, extra height extends upward
          into view — which is what stops expanding it from pushing its own
          contents below the fold and forcing a second scroll. */}
      <div
        className={`${open ? "block" : "hidden"} max-h-[70vh] overflow-y-auto lg:block lg:max-h-none lg:overflow-visible`}
      >
        <div className="hidden px-4 pt-4 text-sm font-medium lg:block">Rubric · {summary}</div>

        <ul className="divide-y px-4">
          {rubric.map((row) => (
            <li key={row.id} className="py-3">
              <ScoreRow
                instanceId={instanceId}
                assignmentId={assignmentId}
                row={row}
                points={pointsFor(row)}
                status={autosave.status(scoreKey(row.id))}
                onPoints={(value) => autosave.edit(scoreKey(row.id), value)}
              />
            </li>
          ))}
        </ul>

        <div className="border-t px-4 py-3">
          <NoteField
            ref={noteRef}
            instanceId={instanceId}
            assignmentId={assignmentId}
            noteBody={noteBody}
            status={autosave.status(NOTE_KEY)}
            onBody={(value) => autosave.edit(NOTE_KEY, value)}
          />
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// One category
// ---------------------------------------------------------------------------

function ScoreRow({
  instanceId,
  assignmentId,
  row,
  points,
  status,
  onPoints,
}: {
  instanceId: string;
  assignmentId: string;
  row: RubricRow;
  points: number | null;
  status: SaveStatus;
  onPoints: (value: number | null) => void;
}) {
  const segmented = row.maxPoints <= SEGMENTED_LIMIT;
  const hydrated = useHydrated();

  /// Post-hydration only — this handler does not exist in the markup React
  /// serialises, which is precisely why the native submit works before it.
  /// `preventDefault` must come first: React's form-action listener is queued
  /// after the onSubmit listeners and checks `defaultPrevented` before
  /// dispatching, so calling it here is what stops the action running twice.
  function intercept(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const raw =
      submitter?.value ??
      (event.currentTarget.elements.namedItem("points") as HTMLInputElement | null)?.value ??
      "";

    onPoints(raw === "" ? null : Number(raw));
  }

  return (
    <form action={saveScoreForm} onSubmit={intercept}>
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <input type="hidden" name="rubricCategoryId" value={row.id} />

      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[0.95rem] font-medium">{row.name}</span>
        <div className="flex shrink-0 items-baseline gap-2">
          <StatusText status={status} />
          <span className="text-muted-foreground text-[0.95rem] tabular-nums">
            {points ?? "—"} / {row.maxPoints}
          </span>
        </div>
      </div>

      {/* The rubric proper, per decision 32. Omitted rather than shown blank
          where the admin left it empty — an empty paragraph under a heading
          reads as guidance that failed to load. */}
      {row.description ? (
        <p className="text-muted-foreground mt-1 text-sm leading-snug">{row.description}</p>
      ) : null}

      {segmented ? (
        // overflow-x-auto rather than wrapping: a row that wraps changes the
        // card's height as scores land, which moves the next category out from
        // under the reviewer's thumb mid-tap.
        <div
          role="group"
          aria-label={`${row.name}, out of ${row.maxPoints}`}
          className="-mx-1 mt-2 flex gap-1.5 overflow-x-auto px-1 pb-1"
        >
          <SegmentButton
            label="—"
            title="Clear this score"
            value=""
            selected={points === null}
            muted
          />
          {Array.from({ length: row.maxPoints + 1 }, (_, value) => (
            <SegmentButton
              key={value}
              label={String(value)}
              value={String(value)}
              selected={points === value}
            />
          ))}
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            name="points"
            // Uncontrolled, for the same reason the note is: React must not
            // overwrite a value typed before it attached.
            defaultValue={points ?? ""}
            min={0}
            max={row.maxPoints}
            step={1}
            inputMode="numeric"
            aria-label={`${row.name}, out of ${row.maxPoints}`}
            onChange={(event) =>
              onPoints(event.target.value === "" ? null : Number(event.target.value))
            }
            className="border-input h-11 w-24 rounded-md border px-3 text-base"
          />
          {/* The no-JavaScript path for the fallback control, on the same rule
              as the note's button below — see F-11 there for the reasoning.
              Fixed alongside it rather than left: this branch only renders above
              `SEGMENTED_LIMIT` points, so the board member could not have
              reached it on a 5-point rubric, and a defect that is merely
              unreachable today is the kind this project keeps rediscovering. */}
          {!hydrated || status === "failed" ? (
            <button
              type="submit"
              className="hover:bg-muted h-11 rounded-md border px-3 text-sm"
            >
              {hydrated ? "Retry now" : "Save"}
            </button>
          ) : null}
        </div>
      )}
    </form>
  );
}

/// A single value in the segmented row.
///
/// `type="submit"` with a `value`, so the browser sends `points=<value>` with no
/// JavaScript involved. `aria-pressed` rather than `aria-checked` because these
/// are buttons in a group rather than radios — the native POST needs a submitter
/// carrying a value, and a radio cannot be one.
function SegmentButton({
  label,
  value,
  selected,
  muted = false,
  title,
}: {
  label: string;
  value: string;
  selected: boolean;
  muted?: boolean;
  title?: string;
}) {
  return (
    <button
      type="submit"
      name="points"
      value={value}
      title={title}
      aria-pressed={selected}
      // min-w-11 and h-11: a 44px target in both directions, which is the floor
      // for a thumb on a phone and the reason this row does not use the small
      // Button variant.
      className={
        "h-11 min-w-11 shrink-0 rounded-md border text-base tabular-nums transition-colors " +
        (selected
          ? "border-foreground bg-foreground text-background font-medium"
          : muted
            ? "text-muted-foreground hover:bg-muted"
            : "hover:bg-muted")
      }
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The note
// ---------------------------------------------------------------------------

function NoteField({
  ref,
  instanceId,
  assignmentId,
  noteBody,
  status,
  onBody,
}: {
  ref: React.RefObject<HTMLTextAreaElement | null>;
  instanceId: string;
  assignmentId: string;
  noteBody: string;
  status: SaveStatus;
  onBody: (value: string) => void;
}) {
  const hydrated = useHydrated();

  function intercept(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onBody(ref.current?.value ?? "");
  }

  return (
    <form action={saveNoteForm} onSubmit={intercept}>
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="assignmentId" value={assignmentId} />

      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor="review-note" className="text-[0.95rem] font-medium">
          Your note
        </label>
        <StatusText status={status} />
      </div>

      <Textarea
        id="review-note"
        name="body"
        ref={ref}
        // Uncontrolled. See the block comment on ScoreCard: this is what makes
        // keystrokes from the hydration window survivable.
        defaultValue={noteBody}
        maxLength={MAX_NOTE_LENGTH}
        rows={3}
        placeholder="Anything the score does not capture."
        onChange={(event) => onBody(event.target.value)}
        className="mt-2"
      />

      {/* F-11, and the reason this is a condition rather than a deletion.
          Before React attaches, this button is the ONLY way to save a note —
          the form posts natively to `saveNoteForm` and the server writes it.
          That is decision 33's third mitigation and removing it outright would
          reopen the dead-control window the decision exists to close. So the
          server still renders it and the no-JavaScript path is untouched.

          What it stops being is a permanent second control. Once hydrated the
          queue owns saving, and a button next to a field reading "Saved" makes
          two different claims about the same work — which is what confused the
          board member, and what makes a reviewer tap it after every note.

          It returns for the one state where pressing something helps. The press
          runs `intercept` -> `onBody` -> `edit`, and the "edit" case in
          lib/autosave.ts resets `failures` to 0 and re-arms the send without
          deduplicating on value, so this is a real retry that also clears the
          backoff — not a button that merely looks like one. */}
      {!hydrated || status === "failed" ? (
        <button
          type="submit"
          className="hover:bg-muted mt-2 h-11 rounded-md border px-3 text-sm"
        >
          {/* "now", against a status line that already says "will retry". */}
          {hydrated ? "Retry now" : "Save note"}
        </button>
      ) : null}
    </form>
  );
}
