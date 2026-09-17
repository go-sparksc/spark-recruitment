// PRD decision 120. The nine prompts below are F26's real notes-sheet headers,
// verbatim, because the point of `shortenPrompt` is that it survives THEM — a
// label rule tested against "Question 1" proves nothing about a 300-character
// header that carries its own instructions to the interviewer.
//
// They are question text, not applicant data: no name, no answer, nothing from
// any application. Rule 3 is about applicant records, and these are the form.

import { describe, expect, it } from "vitest";

import { buildTranscript, flattenTranscript, shortenPrompt } from "@/lib/transcript";

const F26_PROMPTS = [
  "1. Tell us a bit about yourself. (1-2 minutes)\nLast opportunity to give background on yourself. If you didn’t get the chance to share in your application, please use this time to do so. We’d love to learn as much as we can about you!",
  "2. Why do YOU want to be a part of Spark SC? (2-3 min)\nEmphasize “you”. Personal connection to our work, our mission, and our community",
  "3. What’s a project or pursuit that kept you up at night, where has that taken you? (2-3 min)",
  "4. Spark’s mission is to ignite entrepreneurial ambition, empower students to turn their interests into ventures, and build a dynamic community of makers and innovators. Looking at the broader USC community, what is one gap you’ve noticed on/off campus, and what Spark committee would you propose to address it? (2-3 min)",
  "5.  Tell us about a time you wanted to make something happen, but you didn’t have the resources, knowledge, or support you needed. How did you respond? (2-3min)",
  "6. You have one minute. Teach us something. (1 min)\nDoesn’t actually have to be one minute, just see what they do with it. This could be literally anything that they come up with (language, game, recipe, skill, etc)",
  "7. Are you free on Mondays from 7:00PM to 9:30PM?\n7:00PM - 8:00PM Spark labs, 8:00PM - 9:30PM Board",
  "8. FUN QUESTION:  If you could be any snack in the universe, what snack would you be? (< 1 min)",
  "9. Do you have any questions for us? (1-3 min)",
];

describe("shortenPrompt", () => {
  it("produces a one-line label for every real F26 prompt", () => {
    for (const prompt of F26_PROMPTS) {
      const label = shortenPrompt(prompt);
      expect(label).not.toContain("\n");
      expect(label.length).toBeLessThanOrEqual(81);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("drops the leading number, which the render order already carries", () => {
    expect(shortenPrompt("9. Do you have any questions for us? (1-3 min)")).toBe(
      "Do you have any questions for us?",
    );
    // Two spaces after the stop, as the real fifth prompt has.
    expect(shortenPrompt("5.  Tell us about a time.")).toBe("Tell us about a time.");
  });

  it("drops the duration, which is the same noise on every question", () => {
    expect(shortenPrompt("3. What kept you up at night? (2-3 min)")).toBe(
      "What kept you up at night?",
    );
    expect(shortenPrompt("8. What snack would you be? (< 1 min)")).toBe(
      "What snack would you be?",
    );
  });

  it("keeps only the first line, dropping guidance aimed at the interviewer", () => {
    // The second line of prompt 2 tells the interviewer what to listen for. It
    // is not the question, and in a summary it reads as though it were.
    expect(shortenPrompt(F26_PROMPTS[1])).toBe("Why do YOU want to be a part of Spark SC?");
  });

  it("does not cut at a sentence boundary that would leave only the preamble", () => {
    // Prompt 4 opens with a 170-character statement of Spark's mission before it
    // asks anything. Cutting at its first full stop would produce a label that
    // is entirely preamble and contains no question at all.
    const label = shortenPrompt(F26_PROMPTS[3]);
    expect(label).not.toBe("Spark’s mission is to ignite entrepreneurial ambition, empower students to turn their interests into ventures, and build a dynamic community of makers and innovators.");
    expect(label.endsWith("…")).toBe(true);
  });

  it("truncates on a word boundary rather than mid-word", () => {
    // Checked against the source rather than by the label's own shape: a cut on
    // a word boundary necessarily ends with a word character before the
    // ellipsis, so the label alone cannot tell the two cases apart. What
    // distinguishes them is whether the next character in the original is a
    // space.
    const label = shortenPrompt(F26_PROMPTS[3]);
    const kept = label.slice(0, -1);
    const source = F26_PROMPTS[3].replace(/^\d+\s*[.)]\s+/, "");

    expect(source.startsWith(kept)).toBe(true);
    expect(source.charAt(kept.length)).toBe(" ");
  });

  it("does not mistake a decimal for a question number", () => {
    expect(shortenPrompt("3.5 litres is how much?")).toBe("3.5 litres is how much?");
  });

  it("leaves a short prompt exactly as it is", () => {
    expect(shortenPrompt("Notes")).toBe("Notes");
  });
});

describe("flattenTranscript", () => {
  it("writes each prompt above its answer, blank-line separated", () => {
    expect(
      flattenTranscript([
        { prompt: "Q1", body: "first answer" },
        { prompt: "Q2", body: "second answer" },
      ]),
    ).toBe("Q1\nfirst answer\n\nQ2\nsecond answer");
  });

  it("drops an unanswered question rather than writing a heading over silence", () => {
    // F26's ninth question is blank for five applicants. A heading with nothing
    // under it reads as an answer that was not recorded, which is a different
    // claim from the one the sheet makes.
    expect(
      flattenTranscript([
        { prompt: "Q1", body: "answered" },
        { prompt: "Q2", body: "   " },
      ]),
    ).toBe("Q1\nanswered");
  });

  it("is empty when nothing was answered", () => {
    expect(flattenTranscript([{ prompt: "Q1", body: "" }])).toBe("");
    expect(flattenTranscript([])).toBe("");
  });

  it("trims each part without disturbing the paragraph breaks inside an answer", () => {
    // whitespace-pre-line renders those breaks, and they are part of what the
    // notetaker wrote.
    expect(flattenTranscript([{ prompt: " Q1 ", body: "  one\n\ntwo  " }])).toBe(
      "Q1\none\n\ntwo",
    );
  });
});

describe("buildTranscript", () => {
  const questions = [
    { id: "q2", ordinal: 1, prompt: "2. Second question (1 min)" },
    { id: "q1", ordinal: 0, prompt: "1. First question (1 min)" },
    { id: "q3", ordinal: 2, prompt: "3. Third question (1 min)" },
  ];

  it("orders by the question's ordinal, never by the answers' order", () => {
    const sections = buildTranscript(questions, [
      { interviewQuestionId: "q3", body: "third" },
      { interviewQuestionId: "q1", body: "first" },
      { interviewQuestionId: "q2", body: "second" },
    ]);

    expect(sections.map((s) => s.body)).toEqual(["first", "second", "third"]);
    expect(sections.map((s) => s.label)).toEqual([
      "First question",
      "Second question",
      "Third question",
    ]);
  });

  it("keeps the full prompt alongside the shortened label", () => {
    const [section] = buildTranscript(questions, [{ interviewQuestionId: "q1", body: "x" }]);
    expect(section.prompt).toBe("1. First question (1 min)");
    expect(section.label).toBe("First question");
  });

  it("drops a question with no answer, and one whose answer is blank", () => {
    const sections = buildTranscript(questions, [
      { interviewQuestionId: "q1", body: "kept" },
      { interviewQuestionId: "q2", body: "  " },
    ]);
    expect(sections.map((s) => s.body)).toEqual(["kept"]);
  });

  it("drops an answer whose question is missing rather than rendering it under another", () => {
    // The foreign key makes this unreachable from the commit path, but this
    // function takes two independently-queried lists. An answer shown under the
    // wrong prompt is worse than an answer not shown.
    const sections = buildTranscript(questions, [{ interviewQuestionId: "gone", body: "orphan" }]);
    expect(sections).toEqual([]);
  });

  it("returns nothing when the instance has no questions configured", () => {
    // The pre-decision-120 case: notes imported from a single Notes column, so
    // there are no question rows. The page falls back to InterviewNotes.body.
    expect(buildTranscript([], [{ interviewQuestionId: "q1", body: "x" }])).toEqual([]);
  });
});
