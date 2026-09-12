import { describe, expect, it } from "vitest";

import { classStanding, parseTerm, termIndex, type Term } from "@/lib/class-standing";

// Decision 119's table is the spec. Every expected value below is written out
// as a literal term string rather than computed from `termIndex`, so a wrong
// index formula cannot make the tests agree with it.

const SPRING_2026: Term = { season: "SPRING", year: 2026 };
const FALL_2026: Term = { season: "FALL", year: 2026 };

describe("ranges, counted from a Spring current semester (Spring 2026)", () => {
  it.each([
    ["Spring 2026", 0, "Senior"],
    ["Fall 2026", 1, "Senior"],
    ["Spring 2027", 2, "Junior"],
    ["Fall 2027", 3, "Junior"],
    ["Spring 2028", 4, "Sophomore"],
    ["Fall 2028", 5, "Sophomore"],
    ["Spring 2029", 6, "Freshman"],
    ["Fall 2029", 7, "Freshman"],
    ["Spring 2030", 8, "Freshman"],
    ["Fall 2030", 9, "Freshman"],
  ])("%s (%i out) is %s", (answer, _out, expected) => {
    expect(classStanding(answer, SPRING_2026)).toBe(expected);
  });
});

describe("ranges, counted from a Fall current semester (Fall 2026)", () => {
  // The same boundaries from the other season, so an off-by-one in how Fall is
  // indexed cannot hide behind a suite that only ever starts in Spring.
  it.each([
    ["Fall 2026", 0, "Senior"],
    ["Spring 2027", 1, "Senior"],
    ["Fall 2027", 2, "Junior"],
    ["Spring 2028", 3, "Junior"],
    ["Fall 2028", 4, "Sophomore"],
    ["Spring 2029", 5, "Sophomore"],
    ["Fall 2029", 6, "Freshman"],
    ["Spring 2030", 7, "Freshman"],
    ["Fall 2030", 8, "Freshman"],
    ["Spring 2031", 9, "Freshman"],
  ])("%s (%i out) is %s", (answer, _out, expected) => {
    expect(classStanding(answer, FALL_2026)).toBe(expected);
  });
});

describe("a parseable term in the past is Non-standard, not Senior", () => {
  it("one semester back from Spring", () => {
    expect(classStanding("Fall 2025", SPRING_2026)).toBe("Non-standard");
  });

  it("one semester back from Fall", () => {
    expect(classStanding("Spring 2026", FALL_2026)).toBe("Non-standard");
  });

  it("years back", () => {
    expect(classStanding("Spring 2019", FALL_2026)).toBe("Non-standard");
  });
});

describe("blank is Unknown", () => {
  it.each([
    ["the empty string", ""],
    ["spaces only", "   "],
    ["a newline only", "\n"],
    ["null", null],
    ["a missing key", undefined],
  ])("%s", (_label, answer) => {
    expect(classStanding(answer, FALL_2026)).toBe("Unknown");
  });
});

describe("anything else non-blank is Non-standard", () => {
  it.each([
    // Summer is not in the real dropdown's eight choices, so it is off-format
    // like everything else here — not a carve-out.
    "Summer 2027",
    // Month names: the synthetic fixtures' old vocabulary, never the real one.
    "May 2027",
    "December 2027",
    // The dropdown's last option. Contains a valid term; must not match on it.
    "Spring 2030 or later",
    "Spring '27",
    "Spring 27",
    "2027 Spring",
    "Spring2027",
    "Autumn 2027",
    "Spring 2027 (MBA)",
    "Spring 2027.",
    "Graduate student",
  ])("%s", (answer) => {
    expect(classStanding(answer, FALL_2026)).toBe("Non-standard");
  });
});

describe("normalization: case and whitespace do not change a valid answer", () => {
  it.each([
    "SPRING 2028",
    "spring 2028",
    "sPrInG 2028",
    "  Spring 2028  ",
    "Spring    2028",
    "Spring\t2028",
    // A non-breaking space, written as an escape because the literal is invisible
    // in an editor and easy to destroy on save.
    "Spring\u00a02028",
  ])("%j reads the same as Spring 2028", (answer) => {
    expect(classStanding(answer, FALL_2026)).toBe("Junior");
  });
});

describe("beyond 9 semesters out is Non-standard, not Freshman (decision 119, amended)", () => {
  // Freshman is 6–9: the ceiling is a five-year program's maximum, since Spark's
  // pool includes them. The table first read "6 or more", so an obvious typo
  // read as a confident Freshman. 10 is the first value past the ceiling and is
  // checked from both seasons, next to the 9 in the range tables above that
  // still reads Freshman.
  it.each([
    ["Spring 2031", "10 out from Spring 2026", SPRING_2026],
    ["Fall 2031", "10 out from Fall 2026", FALL_2026],
    ["Spring 2032", "12 out from Spring 2026", SPRING_2026],
    ["Fall 2032", "12 out from Fall 2026", FALL_2026],
  ])("%s (%s) is Non-standard", (answer, _label, current) => {
    expect(classStanding(answer, current)).toBe("Non-standard");
  });

  it("the far-future typo that motivated the ceiling", () => {
    expect(classStanding("Spring 2207", FALL_2026)).toBe("Non-standard");
  });
});

describe("parseTerm", () => {
  it("returns season and year for a term", () => {
    expect(parseTerm("Fall 2027")).toEqual({ season: "FALL", year: 2027 });
    expect(parseTerm("spring 2031")).toEqual({ season: "SPRING", year: 2031 });
  });

  it("returns null for blank as well as off-format — telling them apart is classStanding's job", () => {
    expect(parseTerm("")).toBeNull();
    expect(parseTerm("Summer 2027")).toBeNull();
    expect(parseTerm("Spring 2030 or later")).toBeNull();
  });
});

describe("termIndex", () => {
  it("puts consecutive terms exactly one apart, across a year boundary", () => {
    const spring = termIndex({ season: "SPRING", year: 2027 });
    const fall = termIndex({ season: "FALL", year: 2027 });
    const nextSpring = termIndex({ season: "SPRING", year: 2028 });
    expect(fall - spring).toBe(1);
    expect(nextSpring - fall).toBe(1);
  });
});

describe("a non-string value is read as its text", () => {
  // Applicant.data is JSONB. A real import writes strings, but the type allows
  // anything, and a number must not throw.
  it("a bare number is off-format, not a crash", () => {
    expect(classStanding(2027, FALL_2026)).toBe("Non-standard");
  });
});
