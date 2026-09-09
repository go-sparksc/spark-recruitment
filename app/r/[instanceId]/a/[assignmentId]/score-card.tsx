"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";

import {
  saveAiFlag,
  saveAiFlagForm,
  saveNote,
  saveNoteForm,
  saveScore,
  saveScoreForm,
} from "../../actions";
import { readDraft } from "./draft-store";
import { useAutosave } from "./use-autosave";
import { type DraftValue, type SaveStatus } from "@/lib/autosave";
import { MAX_NOTE_LENGTH } from "@/lib/review";
import { scaleValues } from "@/lib/rubric";
import { Textarea } from "@/components/ui/textarea";

export interface RubricRow {
  id: string;
  name: string;
  /// The scale's floor, per PRD decision 40. Both controls render from it, so a
  /// 1-4 category never draws a 0 — and the stored number stays the number the
  /// reviewer actually saw, which is what FR-10 then computes variance over.
  minPoints: number;
  maxPoints: number;
  /// What the reviewer is actually scoring against, per PRD decision 114 — what
  /// each offered value means, keyed by the value. A value the admin left blank
  /// simply has no entry, which FR-4 permits.
  levels: Readonly<Record<number, string>>;
  points: number | null;
}

/// Above this, a segmented row stops being a control and becomes a wall of
/// buttons — `MAX_POINTS_CEILING` is 1000, so a 100-point category is legal.
/// Ten is the point at which the row still fits a phone without wrapping.
///
/// Measured against the **span**, not the maximum: since decision 40 a 90-100
/// category is eleven buttons, and choosing the fallback for it on the strength
/// of its maximum would hand a reviewer a number box for a scale that fits.
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
  suspectedAiUse,
}: {
  instanceId: string;
  assignmentId: string;
  rubric: RubricRow[];
  noteBody: string;
  /// Decision 116. This reviewer's own flag on this assignment, and nobody
  /// else's — §6 keeps it admin-only, so no other reviewer's is loaded.
  suspectedAiUse: boolean;
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
        // overscroll-contain is F-11's neighbour and F-12 proper: without it
        // `overflow-y-auto` chains. At a scroll boundary — or while the page
        // behind is still carrying momentum — the gesture is handed to the
        // parent, so scrolling the rubric scrolls the essays instead. Found on
        // a phone by the board member; a desktop mouse wheel rarely produces it.
        // Irrelevant at lg, where this is `overflow-visible` and has no scroll
        // region to chain out of.
        className={`${open ? "block" : "hidden"} max-h-[70vh] overflow-y-auto overscroll-contain lg:block lg:max-h-none lg:overflow-visible`}
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

        {/* PRD decision 116. Last, under the note, because it is the least
            common thing a reviewer does here and the scores are what the screen
            is for.

            **A form bound to a server action, not an onClick.** Decision 33: a
            `<button type="button">` is inert before hydration and says nothing,
            while a form React ships with `method="POST"` submits natively. This
            control is a single tap that a reviewer may make immediately, so it
            is built the way the note and the scores are. */}
        <div className="border-t px-4 py-3">
          <AiFlagField
            instanceId={instanceId}
            assignmentId={assignmentId}
            flagged={suspectedAiUse}
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
  const segmented = row.maxPoints - row.minPoints <= SEGMENTED_LIMIT;
  const scaleLabel = `${row.minPoints} to ${row.maxPoints}`;
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

      {/* The rubric proper, per decision 114 — one line per score value rather
          than one blurb for the category, which is what decision 32 was
          reaching for. Values the admin left blank are omitted rather than
          shown empty: a bare number with nothing after it reads as guidance
          that failed to load.

          Above the buttons, not beside them. A reviewer reads what the numbers
          mean once and then taps; interleaving the prose into the segmented row
          would push the control off a phone screen, and `overflow-x-auto` below
          exists precisely to stop that row growing. */}
      {scaleValues(row.minPoints, row.maxPoints).some((value) => row.levels[value]) ? (
        <dl className="mt-1 space-y-0.5">
          {scaleValues(row.minPoints, row.maxPoints).map((value) =>
            row.levels[value] ? (
              <div key={value} className="flex gap-2 text-sm leading-snug">
                <dt className="text-foreground w-4 shrink-0 text-right font-medium tabular-nums">
                  {value}
                </dt>
                <dd className="text-muted-foreground">{row.levels[value]}</dd>
              </div>
            ) : null,
          )}
        </dl>
      ) : null}

      {segmented ? (
        // overflow-x-auto rather than wrapping: a row that wraps changes the
        // card's height as scores land, which moves the next category out from
        // under the reviewer's thumb mid-tap.
        <div
          role="group"
          aria-label={`${row.name}, ${scaleLabel}`}
          className="-mx-1 mt-2 flex gap-1.5 overflow-x-auto px-1 pb-1"
        >
          <SegmentButton
            label="—"
            title="Clear this score"
            value=""
            selected={points === null}
            muted
          />
          {/* Drawn from the floor, per decision 40: a 1-4 category offers four
              buttons and no 0. The `—` above stays regardless — clearing a
              score is the absence of a Score row, not a zero, so it survives
              the floor rising off zero. */}
          {Array.from({ length: row.maxPoints - row.minPoints + 1 }, (_, offset) => {
            const value = row.minPoints + offset;
            return (
              <SegmentButton
                key={value}
                label={String(value)}
                value={String(value)}
                selected={points === value}
              />
            );
          })}
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            name="points"
            // Uncontrolled, for the same reason the note is: React must not
            // overwrite a value typed before it attached.
            defaultValue={points ?? ""}
            min={row.minPoints}
            max={row.maxPoints}
            step={1}
            inputMode="numeric"
            aria-label={`${row.name}, ${scaleLabel}`}
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

// ---------------------------------------------------------------------------
// PRD decision 116 — suspected AI use
// ---------------------------------------------------------------------------

/// One reviewer's read that this application looks AI-written.
///
/// **Not on the autosave queue, unlike the scores and the note, and that is a
/// decision rather than an omission.** The queue exists for work built up over
/// many edits — a note typed a word at a time, a score changed twice — where
/// losing the last keystroke costs real thinking. A checkbox is one deliberate
/// act with two states, so a form posting on change is both simpler and strictly
/// more reliable: it works before hydration, with JavaScript off, and needs no
/// draft mirror to survive the tab being killed.
///
/// `requestSubmit()` on change, so ticking is the whole interaction. The button
/// below is the pre-hydration fallback on exactly the note field's terms:
/// present while the page cannot submit for you, gone once it can.
///
/// **`intercept` is what stops the box unticking itself, and it is not optional.**
/// React 19 requests a form reset whenever a form with a *function* action is
/// submitted — `requestFormReset(formFiber); return action(formData)` in
/// react-dom-client. The reset lands when the action's transition completes and
/// restores every uncontrolled field to the `defaultChecked` of the committed
/// render. `saveAiFlagForm` deliberately never revalidates, so no corrected
/// value ever arrives: the write succeeds, the box springs back, and the screen
/// then disagrees with the database until the page is reloaded. Measured at
/// ~1.3s after the tap on a local server, which is why it reads as intermittent
/// rather than as a control that plainly does not work.
///
/// `preventDefault` first, exactly as `ScoreField` and `NoteField` do it — that
/// is why neither of them has ever shown this, and why the note textarea would
/// start clearing itself mid-sentence if anyone removed the interceptor there
/// as redundant. The native POST is untouched: before hydration React has
/// attached no handler, so the fallback button still submits for real.
///
/// **The wording is load-bearing.** "Looks AI-written to me" rather than "AI
/// detected" — nothing detects anything, §11 keeps that out of scope, and the
/// label must not let a reviewer believe the system agreed with them. The line
/// underneath says where it goes, because someone filing an unverified claim
/// about a person is entitled to know who reads it.
function AiFlagField({
  instanceId,
  assignmentId,
  flagged,
}: {
  instanceId: string;
  assignmentId: string;
  flagged: boolean;
}) {
  const hydrated = useHydrated();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function intercept(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const data = new FormData(event.currentTarget);
    start(async () => {
      const result = await saveAiFlag(data);
      setError(result.ok ? null : (result.error ?? "Could not save. Try again."));
    });
  }

  return (
    <form ref={formRef} action={saveAiFlagForm} onSubmit={intercept}>
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="assignmentId" value={assignmentId} />

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="suspectedAiUse"
          defaultChecked={flagged}
          disabled={pending}
          onChange={() => formRef.current?.requestSubmit()}
          className="mt-0.5 size-4 shrink-0"
        />
        <span>
          This looks AI-written to me
          <span className="text-muted-foreground block text-xs">
            Goes to the admin running recruitment, with your name. No other reviewer sees it, and
            nothing is decided by it on its own.
          </span>
        </span>
      </label>

      {!hydrated ? (
        <button type="submit" className="hover:bg-muted mt-2 h-11 rounded-md border px-3 text-sm">
          Save flag
        </button>
      ) : null}

      {/* Silent failure is the one outcome this control must not have: the
          reviewer has no other signal that their read was recorded, and the
          form-action version surfaced a refusal as a thrown error boundary. */}
      {error !== null ? (
        <p role="alert" className="text-destructive mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}
