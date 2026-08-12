"use client";

import { useSyncExternalStore } from "react";

export interface RubricRow {
  id: string;
  name: string;
  maxPoints: number;
  /// What the reviewer is actually scoring against, per PRD decision 32. Null
  /// where the admin left it blank, which FR-4 permits.
  description: string | null;
  /// Null until Slice 5 puts inputs here and a reviewer fills them in.
  points: number | null;
}

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

/// FR-9 bullet 2: "rubric always visible alongside".
///
/// On a phone "alongside" cannot be literal, so the card is pinned to the bottom
/// of the viewport and collapsed to a single line — always on screen while the
/// responses scroll behind it. One tap opens it, and the choice is remembered
/// across applicants, so a reviewer working through fifteen taps it once.
///
/// From `lg` up it becomes a sticky right-hand rail and is always open, which is
/// the literal reading of the requirement where the screen has room for it.
///
/// Read-only in this slice. Slice 5 replaces the values with inputs and adds the
/// note; the layout ships first so the §6 boundary can be walked before autosave
/// exists to complicate it.
export function ScoreCard({
  rubric,
  scored,
}: {
  rubric: RubricRow[];
  scored: number;
}) {
  const [open, toggle] = useCardOpen();

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
      aria-label="Rubric"
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
          {open ? "Hide rubric" : "Show rubric"}
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
        className={`${open ? "block" : "hidden"} max-h-[55vh] overflow-y-auto lg:block lg:max-h-none lg:overflow-visible`}
      >
        <div className="hidden px-4 pt-4 text-sm font-medium lg:block">Rubric · {summary}</div>

        <ul className="divide-y px-4 pb-4 lg:pb-4">
          {rubric.map((row) => (
            <li key={row.id} className="py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[0.95rem] font-medium">{row.name}</span>
                <span className="text-muted-foreground shrink-0 text-[0.95rem] tabular-nums">
                  {row.points ?? "—"} / {row.maxPoints}
                </span>
              </div>
              {/* The rubric proper, per decision 32. Omitted rather than shown
                  blank where the admin left it empty — an empty paragraph under
                  a heading reads as guidance that failed to load. */}
              {row.description ? (
                <p className="text-muted-foreground mt-1 text-sm leading-snug">{row.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
