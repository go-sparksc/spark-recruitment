import { describe, expect, it } from "vitest";

import { buildApplicantProfiles } from "./applicants";
import {
  ETHNICITY_GROUP_KEY,
  buildFieldSpecs,
  cleanHeader,
} from "./fields";
import { EXPECTED_COLUMN_COUNT, readSourceHeaders } from "./headers";
import { createRng } from "./rng";
import { SPARKLET_COUNT, buildReviewerSpecs } from "./roster";

// Light smoke coverage. The two pieces with real logic — lib/assignment.ts and
// lib/passes.ts — get real tests in phases 2 and 6. What these guard is the
// structural claim the seed makes: that it reproduces the awkward shapes of the
// real export rather than a tidy version of them.

describe("createRng", () => {
  it("is deterministic for a given seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const draw = (rng: ReturnType<typeof createRng>) =>
      Array.from({ length: 20 }, () => rng.int(0, 1000));

    expect(draw(a)).toEqual(draw(b));
  });

  it("diverges for different seeds", () => {
    const a = Array.from({ length: 20 }, ((rng) => () => rng.int(0, 1000))(createRng(1)));
    const b = Array.from({ length: 20 }, ((rng) => () => rng.int(0, 1000))(createRng(2)));

    expect(a).not.toEqual(b);
  });
});

describe("readSourceHeaders", () => {
  const headers = readSourceHeaders();

  it("parses the fixture as one record despite newlines inside quoted headers", () => {
    expect(headers).toHaveLength(EXPECTED_COLUMN_COUNT);
  });

  it("preserves the header text verbatim", () => {
    // If any of these ever come back zero, something upstream is normalizing the
    // headers, and Phase 1 is being built against cleaner input than it will meet.
    expect(headers.filter((header) => header.includes("\n")).length).toBeGreaterThan(0);
    expect(headers.filter((header) => /[‘’]/.test(header)).length).toBeGreaterThan(0);
    expect(headers.filter((header) => header !== header.trim()).length).toBeGreaterThan(0);
  });
});

describe("cleanHeader", () => {
  it("collapses whitespace and drops the trailing colon", () => {
    expect(cleanHeader("Graduation Date:")).toBe("Graduation Date");
    expect(cleanHeader("What’s something\nyou’ve worked on? \n")).toBe(
      "What’s something you’ve worked on?",
    );
  });
});

describe("buildFieldSpecs", () => {
  const specs = buildFieldSpecs();

  it("covers every source column except the four promoted ones, plus the long prompt", () => {
    expect(specs).toHaveLength(EXPECTED_COLUMN_COUNT - 4 + 1);
  });

  it("has contiguous ordinals", () => {
    expect(specs.map((spec) => spec.ordinal)).toEqual(specs.map((_, index) => index));
  });

  it("includes a header over 200 characters", () => {
    // BUILD_PLAN phase 1 warns about these; the real export tops out at 159, so
    // the seed supplies one deliberately.
    expect(Math.max(...specs.map((spec) => spec.sourceHeader.length))).toBeGreaterThan(200);
  });

  it("groups the ten ethnicity columns as one multi-select question", () => {
    const group = specs.filter((spec) => spec.groupKey === ETHNICITY_GROUP_KEY);

    expect(group).toHaveLength(10);
    expect(group.every((spec) => spec.isMultiSelect)).toBe(true);
    expect(group.every((spec) => spec.optionLabel)).toBe(true);
  });

  it("keeps the free-text ethnicity column out of the one-hot group", () => {
    const selfDescribed = specs.find((spec) => spec.key === "ethnicitySelfDescribed");

    expect(selfDescribed?.groupKey).toBeNull();
    expect(selfDescribed?.isMultiSelect).toBe(false);
  });

  it("excludes exactly the junk columns by default", () => {
    expect(specs.filter((spec) => !spec.isIncluded).map((spec) => spec.key)).toEqual([
      "responseType",
      "networkId",
      "ending",
    ]);
  });
});

describe("buildApplicantProfiles", () => {
  const profiles = buildApplicantProfiles(createRng(20260805), 150);

  it("generates unique emails, which the database also enforces", () => {
    expect(new Set(profiles.map((profile) => profile.email)).size).toBe(profiles.length);
  });

  it("leaves the sparse columns sparse", () => {
    const blankRate = (key: string) =>
      profiles.filter((profile) => profile.values[key] === "").length / profiles.length;

    for (const key of ["otherMajor", "secondMajor", "tags"]) {
      expect(blankRate(key)).toBeGreaterThan(0.6);
      expect(blankRate(key)).toBeLessThan(0.97);
    }
  });

  it("gives the junk 'ending' column the same value on every row", () => {
    expect(new Set(profiles.map((profile) => profile.values.ending)).size).toBe(1);
  });

  it("produces applicants who checked more than one ethnicity", () => {
    const multi = profiles.filter((profile) => profile.ethnicities.length > 1).length;

    expect(multi).toBeGreaterThan(0);
  });
});

describe("buildReviewerSpecs", () => {
  const reviewers = buildReviewerSpecs(createRng(20260805));

  it("produces the BUILD_PLAN phase 2 roster", () => {
    expect(reviewers).toHaveLength(30);
    expect(reviewers.filter((reviewer) => reviewer.isSparklet)).toHaveLength(SPARKLET_COUNT);
  });

  it("keeps Sparklets under the one-third ceiling the assignment rule requires", () => {
    // 3 slots per applicant, at most 1 Sparklet each, so non-Sparklets must fill
    // 2 of every 3. Above one third, even load and the Sparklet rule conflict.
    expect(SPARKLET_COUNT / reviewers.length).toBeLessThan(1 / 3);
  });

  it("puts every reviewer in the written round", () => {
    expect(reviewers.every((reviewer) => reviewer.rounds.includes("WRITTEN"))).toBe(true);
  });
});
