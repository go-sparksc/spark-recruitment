// PRD decision 120's transcript, as three pure functions. No database, no
// Prisma, no React.
//
// The notes sheet is one row per applicant, written by one shared notetaker,
// with one column per interview question. This module owns the two places that
// shape is turned into something else: the prose blob stored in
// `InterviewNotes.body`, and the sections the three profile pages render.
//
// Both live here rather than beside their callers because the commit path is a
// server action and the render path is a server component, and a function that
// has to be reachable from both is a function that should be reachable from a
// test. `lib/first-round.ts` is the standing example.

/// One question and its answer, as the sheet gives them.
export interface TranscriptEntry {
  prompt: string;
  body: string;
}

/// The same thing, ready to render: `label` is what goes in a `<summary>`.
export interface TranscriptSection extends TranscriptEntry {
  label: string;
}

/// How long a `<summary>` line may get before it stops being one line.
///
/// Not a layout constant — the pages set their own widths. It is a readability
/// floor: past roughly this length a disclosure summary wraps on a laptop and
/// the list of nine stops scanning as a list.
const LABEL_MAX = 80;
const ELLIPSIS = "…";

/// Turn a question prompt into a one-line label.
///
/// The real prompts are not labels. They carry their number, an instruction to
/// the interviewer, a duration, and sometimes a second paragraph of guidance —
/// F26's fourth question runs to just over 300 characters. Rendering nine of
/// those as `<summary>` lines gives nine wrapped paragraphs and no way to scan.
///
/// Three steps, in order, each the least aggressive thing that helps:
///
///   1. drop a leading `4. ` — the position is already the order they render in;
///   2. keep only the first line, which is where the question itself lives and
///      below which the sheet puts guidance aimed at the interviewer;
///   3. cut at the first sentence end if that leaves something substantial,
///      otherwise hard-truncate.
///
/// **Never used as a key and never stored.** The full prompt is what
/// `InterviewQuestion.prompt` holds and what the disclosure shows when opened;
/// this is a display convenience over it, so shortening two prompts to the same
/// label is untidy rather than wrong.
export function shortenPrompt(prompt: string): string {
  const firstLine = prompt.replace(/\r\n/g, "\n").split("\n")[0] ?? "";
  // Strips "4. " and "4) ", not "4.5" — the digits must be followed by a
  // separator and whitespace.
  const unnumbered = firstLine.trim().replace(/^\d+\s*[.)]\s+/, "");

  // A parenthesised aside at the end is the duration — "(2-3 min)", "(< 1 min)".
  // It is the same for every question and tells a reader nothing at this size.
  const undurationed = unnumbered.replace(/\s*\([^()]*\bmin\b[^()]*\)\s*$/i, "").trim();

  if (undurationed.length <= LABEL_MAX) return undurationed;

  // Prefer a sentence boundary, but only one that leaves a label worth reading.
  // Half the budget is the floor: cutting "Spark's mission is to ignite
  // entrepreneurial ambition, empower students to turn their interests into
  // ventures, and build a dynamic community of makers and innovators." at its
  // first full stop would leave the whole preamble and none of the question.
  const sentenceEnd = undurationed.slice(0, LABEL_MAX).search(/[.?!]\s/);
  if (sentenceEnd >= LABEL_MAX / 2) return undurationed.slice(0, sentenceEnd + 1);

  // Hard truncate on a word boundary where there is one nearby.
  const cut = undurationed.slice(0, LABEL_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace >= LABEL_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd() + ELLIPSIS;
}

/// The prose written to `InterviewNotes.body` when a sheet carries one column
/// per question rather than a single Notes column.
///
/// **This is redundant with the InterviewAnswer rows on purpose.** Every
/// consumer written before decision 120 reads `body` — FR-20's export,
/// `lib/export.ts`, the admin surfaces — and decision 120 was built to be
/// abandonable, with "import one combined blob into the existing Notes field" as
/// the fallback. Writing that blob anyway means the fallback needs no code and
/// costs one column of duplicated text per applicant.
///
/// Entries with an empty body are dropped rather than rendered as a heading with
/// nothing under it: F26's ninth question is blank for five applicants, and
/// "9. Do you have any questions for us?" followed by silence reads as an answer
/// that was not recorded rather than a question that was not asked.
export function flattenTranscript(entries: readonly TranscriptEntry[]): string {
  return entries
    .filter((entry) => entry.body.trim() !== "")
    .map((entry) => `${entry.prompt.trim()}\n${entry.body.trim()}`)
    .join("\n\n");
}

/// Pair stored answers to their questions for rendering.
///
/// Ordered by the question's `ordinal`, which is the sheet's own left-to-right
/// order — never by the answers' own order, which is whatever the database
/// returned. A question with no answer row, or an answer that is blank, is
/// dropped for `flattenTranscript`'s reason.
///
/// An answer whose question is not in `questions` is dropped too. That is not a
/// case the commit can produce — the foreign key sees to it — but this function
/// takes two independently-queried lists, and silently rendering an answer under
/// the wrong prompt is a worse failure than not rendering it.
export function buildTranscript(
  questions: readonly { id: string; ordinal: number; prompt: string }[],
  answers: readonly { interviewQuestionId: string; body: string }[],
): TranscriptSection[] {
  const byQuestion = new Map(answers.map((answer) => [answer.interviewQuestionId, answer.body]));

  return [...questions]
    .sort((a, b) => a.ordinal - b.ordinal)
    .flatMap((question) => {
      const body = byQuestion.get(question.id);
      if (body === undefined || body.trim() === "") return [];
      return [{ prompt: question.prompt, body, label: shortenPrompt(question.prompt) }];
    });
}
