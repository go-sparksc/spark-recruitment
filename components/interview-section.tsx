// PRD decision 120's interview rendering, in one place.
//
// Three surfaces show an applicant's interview: FR-16's second-round profile,
// FR-14's first-round profile, and the admin results view. Before this decision
// each had its own copy of the markup, which was survivable while an interview
// was a score, four points and one note. It stopped being survivable once an
// interview became two interviewers' per-category prose, two overall notes, two
// recommendations, a provenance flag on each score, and a nine-part transcript:
// three copies of that is three chances for one surface to quietly omit
// something a reviewer is deciding on.
//
// **Server components, deliberately.** There is no state here, and `<details>`
// gives the disclosure behaviour with no JavaScript at all — the same trick
// `return-control.tsx` documents. Nothing in this file may become a client
// component without a reason, because these props carry every note written
// about an applicant and a client boundary is a serialization boundary.

import type { InterviewCard } from "@/lib/second-round";
import type { TranscriptSection } from "@/lib/transcript";
import { formatInterviewScore } from "@/lib/second-round";

/// `whitespace-pre-line` on the reviewer pages, `whitespace-pre-wrap` on the
/// admin one. The codebase splits these by route family and the split predates
/// this decision, so it is honoured rather than unified — a component that
/// changed how admin prose wraps would be doing a second, unrelated job.
export type Whitespace = "pre-line" | "pre-wrap";

function proseClass(whitespace: Whitespace): string {
  return whitespace === "pre-line" ? "whitespace-pre-line" : "whitespace-pre-wrap";
}

export interface InterviewCategoryLike {
  id: string;
  name: string;
  maxPoints: number;
}

/// One bordered card per interviewer.
///
/// The per-category disclosure carries each category's note under its points,
/// because that is where the note was written — decision 120 keeps them together
/// for the same reason it stored them together.
export function InterviewCards({
  cards,
  categories,
  whitespace,
}: {
  cards: readonly InterviewCard[];
  categories: readonly InterviewCategoryLike[];
  whitespace: Whitespace;
}) {
  return (
    <div className="space-y-3">
      {cards.map((card) => (
        <div key={card.resultId} className="rounded-md border p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{card.interviewerName}</span>
            <span className="text-2xl font-semibold tabular-nums">
              {/* Never the bare number. A computed average that reads like a
                  recorded one is what decision 6 actually forbids, and this is
                  the only place any of the three pages formats it. */}
              {formatInterviewScore(card)}
            </span>
          </div>

          {card.recommendation !== null ? (
            <p className="text-muted-foreground mt-1 text-sm">
              Move on to deliberations:{" "}
              <span className="text-foreground font-medium">
                {card.recommendation === "YES" ? "Yes" : "No"}
              </span>
            </p>
          ) : null}

          {/* Clause 14c: collapsed by default, expandable. `<details>` rather
              than state, so it works before hydration. */}
          {card.points.some((value) => value !== null) ? (
            <details className="mt-2">
              <summary className="text-muted-foreground cursor-pointer text-sm">
                Per-category scores
              </summary>
              <ul className="mt-2 space-y-2">
                {categories.map((category, index) => {
                  const points = card.points[index];
                  const note = card.categoryNotes[index];
                  if (points === null && note === null) return null;
                  return (
                    <li key={category.id} className="text-sm">
                      <div className="flex justify-between gap-3">
                        <span>{category.name}</span>
                        <span className="tabular-nums">
                          {points === null ? "—" : `${points} / ${category.maxPoints}`}
                        </span>
                      </div>
                      {note ? (
                        <p className={`text-muted-foreground mt-1 text-sm ${proseClass(whitespace)}`}>
                          {note}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}

          {card.note ? (
            <p className={`mt-3 text-sm ${proseClass(whitespace)}`}>{card.note}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/// The shared notetaker's transcript.
///
/// **One disclosure per question, all collapsed.** F26's transcripts average
/// ~2,500 characters across nine questions, and dropping that inline pushes the
/// vote control below two screens of prose on the one page where a reviewer is
/// deciding. The summary is the shortened prompt; the full prompt is inside,
/// because the shortening drops guidance that is sometimes worth reading.
///
/// `fallbackBody` is what a transcript imported before decision 120 has: a
/// single Notes column, with no questions to split it by. Rendered as one block,
/// exactly as it was before this decision existed.
export function InterviewTranscript({
  interviewerName,
  sections,
  fallbackBody,
  whitespace,
}: {
  interviewerName: string | null;
  sections: readonly TranscriptSection[];
  fallbackBody: string;
  whitespace: Whitespace;
}) {
  return (
    <div className="rounded-md border p-4">
      <h3 className="text-sm font-medium">
        Interview transcript
        {interviewerName ? ` — ${interviewerName}` : ""}
      </h3>

      {sections.length === 0 ? (
        // whitespace-pre-line: the notes sheet carries paragraph breaks inside a
        // quoted field and they are part of what was written.
        <p className={`mt-2 text-sm ${proseClass(whitespace)}`}>{fallbackBody}</p>
      ) : (
        <div className="mt-2 space-y-1">
          {sections.map((section, index) => (
            <details key={index} className="border-t pt-2 first:border-t-0 first:pt-0">
              <summary className="cursor-pointer text-sm font-medium">{section.label}</summary>
              <p className="text-muted-foreground mt-2 text-xs">{section.prompt}</p>
              <p className={`mt-1 pb-2 text-sm ${proseClass(whitespace)}`}>{section.body}</p>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
