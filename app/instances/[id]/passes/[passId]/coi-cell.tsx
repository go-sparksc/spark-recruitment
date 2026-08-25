"use client";

import type { EffectiveVote } from "@/lib/passes";

/// FR-18's four cell values: blank / yes / no / skip.
///
/// **Blank is genuinely blank**, per §7.4's own list — an outstanding reviewer is
/// the absence of a vote, and a glyph would make "has not voted" look like a
/// third thing they might have said. The letters are short because the grid is
/// eleven reviewers wide before it is anything else, and each carries a
/// `title`/`aria-label` so the meaning is available to a screen reader and to
/// anyone who has not learned the letters.
const CELL: Record<EffectiveVote, { glyph: string; label: string; className: string }> = {
  YES: { glyph: "Y", label: "Yes", className: "font-medium" },
  NO: { glyph: "N", label: "No", className: "font-medium" },
  SKIP: { glyph: "S", label: "Skip", className: "text-muted-foreground" },
  OUTSTANDING: { glyph: "", label: "No vote yet", className: "" },
};

/// One cell. A conflict skip is a button; everything else is static text.
///
/// Decision 76's control lives here because the grid is the only surface that
/// renders conflicts at all, and it renders them exactly where the question gets
/// asked — a skip cell in a row that will not resolve.
///
/// **The confirm is not in the cell.** It has three things to say (the removal is
/// round-wide, the deleted vote does not return, a terminal row does not reopen)
/// and a 2rem-wide table cell cannot say them. The button selects; the panel
/// beneath the grid explains and acts. That also keeps the table's column widths
/// from jumping when a confirm opens.
export function CoiCell({
  vote,
  isConflict,
  applicantName,
  reviewerName,
  selected,
  removable,
  onSelect,
}: {
  vote: EffectiveVote;
  isConflict: boolean;
  applicantName: string;
  reviewerName: string;
  selected: boolean;
  /// False on a closed pass and on a row the pass has already settled. The
  /// conflict still shows; it simply cannot be lifted from here.
  removable: boolean;
  onSelect: () => void;
}) {
  const cell = CELL[vote];
  const description = `${reviewerName} — ${applicantName}: ${cell.label}`;

  if (!isConflict || !removable) {
    return (
      <td
        className={`border-l px-2 py-2 text-center text-sm tabular-nums ${cell.className}`}
        title={description}
        aria-label={description}
      >
        {cell.glyph || <span aria-hidden>·</span>}
      </td>
    );
  }

  return (
    <td className="border-l p-0 text-center">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        title={`${description} (conflict — click to remove)`}
        className={
          selected
            ? "bg-foreground text-background h-full w-full px-2 py-2 text-sm"
            : "hover:bg-muted text-muted-foreground h-full w-full px-2 py-2 text-sm underline decoration-dotted underline-offset-4"
        }
      >
        {cell.glyph}
      </button>
    </td>
  );
}
