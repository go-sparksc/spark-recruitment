import { describe, expect, it } from "vitest";

import { parseRoster, type ExistingReviewer } from "@/lib/roster";

// BUILD_PLAN phase 2's roster block is the spec. Its five cases are the first
// five describes below, worded as it words them; CLAUDE.md is explicit that if a
// test contradicts those cases the test is wrong. The hazards after them are the
// parsing details FR-6 implies but does not enumerate.

const reviewer = (
  id: string,
  firstName: string,
  lastName: string,
  servesThisRound = false,
): ExistingReviewer => ({ id, firstName, lastName, servesThisRound });

describe("Paste with trailing blank lines and a line of only spaces", () => {
  // "those lines dropped, no empty reviewer rows created"
  const text = "Ada Lovelace\n   \nGrace Hopper\n\n\n";

  it("drops them and creates no entry", () => {
    const result = parseRoster(text);

    expect(result.ready.map((e) => `${e.firstName} ${e.lastName}`)).toEqual([
      "Ada Lovelace",
      "Grace Hopper",
    ]);
    expect(result.needsConfirmation).toEqual([]);
  });

  it("counts every dropped line rather than discarding it silently", () => {
    // The line of spaces plus the three trailing newlines, which split into two
    // empty lines and the final empty string. Counted so the UI can say so: an
    // admin who pastes 30 names and gets 29 reviewers needs to be told why.
    expect(parseRoster(text).droppedLineCount).toBe(4);
  });

  it("makes no entry with a blank first or last name", () => {
    const all = [...parseRoster(text).ready, ...parseRoster(text).needsConfirmation];
    for (const entry of all) expect(entry.firstName).not.toBe("");
  });
});

describe('"Mary Anne Chen"', () => {
  // "first name 'Mary Anne', last name 'Chen'. Split on the LAST space, not the
  // first" — the case that rules out the obvious implementation.
  it("splits on the last space", () => {
    const [entry] = parseRoster("Mary Anne Chen").ready;

    expect(entry.firstName).toBe("Mary Anne");
    expect(entry.lastName).toBe("Chen");
    expect(entry.flags).toEqual([]);
  });

  it("splits on the last space however many there are", () => {
    const [entry] = parseRoster("Jean Baptiste Emmanuel Zorg").ready;

    expect(entry.firstName).toBe("Jean Baptiste Emmanuel");
    expect(entry.lastName).toBe("Zorg");
  });
});

describe('"Cher"', () => {
  // "cannot split. Lands in the confirmation queue, does not import with a
  // blank last name"
  const result = parseRoster("Cher");

  it("lands in the confirmation queue", () => {
    expect(result.needsConfirmation).toHaveLength(1);
    expect(result.needsConfirmation[0].flags).toEqual(["UNSPLITTABLE"]);
  });

  it("does not import", () => {
    expect(result.ready).toEqual([]);
  });

  it("keeps the word as the first name, leaving the last name empty", () => {
    // Empty rather than a copy of the first name. Reviewer.lastName is non-null,
    // so the queue has to collect one; duplicating the first name would satisfy
    // the schema and quietly assert something nobody said.
    expect(result.needsConfirmation[0].firstName).toBe("Cher");
    expect(result.needsConfirmation[0].lastName).toBe("");
  });
});

describe('"Alex Kim" appearing twice in one paste', () => {
  // "both import, both flagged for confirmation. Not deduplicated silently; two
  // reviewers may share a name and §5 puts no unique constraint on it"
  const result = parseRoster("Alex Kim\nAlex Kim");

  it("keeps both", () => {
    expect(result.needsConfirmation).toHaveLength(2);
    expect(result.ready).toEqual([]);
  });

  it("flags both, not only the second", () => {
    // The admin is deciding about a pair. Showing only the later line hides half
    // of what they are deciding about.
    for (const entry of result.needsConfirmation) {
      expect(entry.flags).toEqual(["DUPLICATE_IN_PASTE"]);
    }
    expect(result.needsConfirmation.map((e) => e.lineNumber)).toEqual([1, 2]);
  });

  it("does not merge them into one entry", () => {
    expect(result.needsConfirmation[0].firstName).toBe("Alex");
    expect(result.needsConfirmation[1].firstName).toBe("Alex");
  });
});

describe("A 30-line paste with no Sparklets marked", () => {
  // "all 30 import as non-Sparklet, scoped to the round being staffed"
  const text = Array.from({ length: 30 }, (_, i) => `Reviewer${i} Surname${i}`).join("\n");

  it("imports all 30 unflagged", () => {
    const result = parseRoster(text);

    expect(result.ready).toHaveLength(30);
    expect(result.needsConfirmation).toEqual([]);
    expect(result.droppedLineCount).toBe(0);
  });

  it("carries no Sparklet flag and no round for the caller to get wrong", () => {
    // The assertion is on the shape, not a value: FR-6 puts the Sparklet flag and
    // any additional rounds in the roster grid afterwards, and the way to keep a
    // paste from setting either is for the type to have nowhere to put them.
    const [entry] = parseRoster(text).ready;

    expect(Object.keys(entry).sort()).toEqual(["firstName", "flags", "lastName", "lineNumber", "raw"]);
  });
});

describe("a name already on the instance (PRD decision 22)", () => {
  // Not in the BUILD_PLAN block: FR-6 covers only the within-paste case. The
  // likelier accident is re-pasting the same Slack message, and Reviewer is
  // instance-scoped with a rounds array, so a match is the same person.
  const existing = [reviewer("rev_1", "Alex", "Kim", false)];

  it("flags a match against a reviewer serving another round", () => {
    const result = parseRoster("Alex Kim", existing);

    expect(result.ready).toEqual([]);
    expect(result.needsConfirmation[0].flags).toEqual(["MATCHES_EXISTING_REVIEWER"]);
    expect(result.needsConfirmation[0].match).toEqual({
      reviewerId: "rev_1",
      alreadyServesThisRound: false,
    });
  });

  it("reports when the add would be a no-op", () => {
    const result = parseRoster("Alex Kim", [reviewer("rev_1", "Alex", "Kim", true)]);

    expect(result.needsConfirmation[0].match?.alreadyServesThisRound).toBe(true);
  });

  it("matches regardless of case and surrounding whitespace", () => {
    const result = parseRoster("  alex   KIM  ", existing);

    expect(result.needsConfirmation[0].flags).toContain("MATCHES_EXISTING_REVIEWER");
  });

  it("does not flag a different person", () => {
    expect(parseRoster("Alexis Kim", existing).ready).toHaveLength(1);
    expect(parseRoster("Alex Kimura", existing).ready).toHaveLength(1);
  });

  it("carries both flags when a line is duplicated in the paste and on the roster", () => {
    const result = parseRoster("Alex Kim\nAlex Kim", existing);

    for (const entry of result.needsConfirmation) {
      expect(entry.flags).toEqual(["DUPLICATE_IN_PASTE", "MATCHES_EXISTING_REVIEWER"]);
    }
  });

  it("never matches an unsplittable line", () => {
    // "Cher" against an existing Cher Bono is not a match. Claiming it was would
    // be guessing at the very name the admin has not supplied yet.
    const result = parseRoster("Cher", [reviewer("rev_2", "Cher", "Bono")]);

    expect(result.needsConfirmation[0].flags).toEqual(["UNSPLITTABLE"]);
    expect(result.needsConfirmation[0].match).toBeUndefined();
  });

  it("does not flag anything when the roster is empty", () => {
    expect(parseRoster("Alex Kim").ready).toHaveLength(1);
  });
});

describe("paste hazards", () => {
  it("handles CRLF and lone CR line endings", () => {
    // A paste from Windows Slack, and one from an older editor. Neither should
    // produce a name with a stray carriage return welded onto it.
    expect(parseRoster("Ada Lovelace\r\nGrace Hopper").ready).toHaveLength(2);
    expect(parseRoster("Ada Lovelace\rGrace Hopper").ready).toHaveLength(2);
    expect(parseRoster("Ada Lovelace\r\nGrace Hopper").ready[0].lastName).toBe("Lovelace");
  });

  it("splits on a non-breaking space", () => {
    // U+00A0 is what a Slack paste often carries. It is invisible, so a line
    // that failed to split on it would look identical to one that worked. That
    // is also why these are escapes rather than literals: an editor normalising
    // the file would turn a literal into an ordinary space and the test would
    // pass having proved nothing.
    const [nbsp] = parseRoster("Ada\u00A0Lovelace").ready;

    expect(nbsp.firstName).toBe("Ada");
    expect(nbsp.lastName).toBe("Lovelace");

    const [ideographic] = parseRoster("Ada\u3000Lovelace").ready;

    expect(ideographic.lastName).toBe("Lovelace");
  });

  it("collapses doubled interior spaces before splitting", () => {
    const [entry] = parseRoster("Mary  Anne   Chen").ready;

    expect(entry.firstName).toBe("Mary Anne");
    expect(entry.lastName).toBe("Chen");
  });

  it("treats a trailing space as trailing, not as a split point", () => {
    // The trap: lastIndexOf(" ") on an untrimmed "Chen " finds the trailing space
    // and yields a blank last name — exactly the state FR-6 forbids, reached by
    // the route that looks like it works.
    const result = parseRoster("Chen ");

    expect(result.ready).toEqual([]);
    expect(result.needsConfirmation[0].flags).toEqual(["UNSPLITTABLE"]);
    expect(result.needsConfirmation[0].lastName).toBe("");
  });

  it("keeps the raw line verbatim for the queue to display", () => {
    // The confirmation queue shows what was pasted, not what parsing made of it.
    expect(parseRoster("  Chen  ").needsConfirmation[0].raw).toBe("  Chen  ");
  });

  it("numbers lines by their position in the paste, including dropped blanks", () => {
    // So the number matches what the admin counts in the textarea.
    const result = parseRoster("\n\nCher\n\nAlex Kim");

    expect(result.needsConfirmation[0].lineNumber).toBe(3);
    expect(result.ready[0].lineNumber).toBe(5);
  });

  it("returns empty for an empty paste", () => {
    expect(parseRoster("")).toEqual({ ready: [], needsConfirmation: [], droppedLineCount: 1 });
    expect(parseRoster("   \n  ").droppedLineCount).toBe(2);
  });

  it("does not split names on the letter s", () => {
    // Guards a real bug: writing the whitespace class as /s+/ rather than /\s+/
    // matches the letter, and every name containing an s comes apart.
    const [entry] = parseRoster("Jess Sassoon").ready;

    expect(entry.firstName).toBe("Jess");
    expect(entry.lastName).toBe("Sassoon");
  });

  it("normalizes decomposed accents so two spellings of one name match", () => {
    // "Jose" with an acute, typed as e + U+0301, against the single code point
    // U+00E9. Escapes for the same reason as above: as literals these two lines
    // look identical, so a normalising editor could silently make them equal and
    // the assertion would hold without testing anything.
    const decomposed = "Jos\u0065\u0301 Ramos";
    const composed = "Jos\u00E9 Ramos";

    expect(decomposed).not.toBe(composed);

    const result = parseRoster(decomposed, [reviewer("rev_3", "Jos\u00E9", "Ramos")]);

    expect(result.needsConfirmation[0].flags).toContain("MATCHES_EXISTING_REVIEWER");
    expect(parseRoster(decomposed).ready[0].firstName).toBe(
      parseRoster(composed).ready[0].firstName,
    );
  });
});
