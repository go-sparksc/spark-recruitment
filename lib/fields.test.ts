import { describe, expect, it } from "vitest";

import { FieldCategory, FieldGroupRole } from "@/generated/prisma/enums";
import {
  cleanHeader,
  projectApplicantData,
  resolveField,
  resolvePromoted,
  slugify,
  uniqueSlug,
  visibleFieldIds,
  type FieldGroupLike,
  type FieldLike,
  type Viewer,
} from "@/lib/fields";

const VIEWERS: Viewer[] = [
  "WRITTEN_REVIEWER",
  "FIRST_ROUND_REVIEWER",
  "SECOND_ROUND_REVIEWER",
  "ADMIN",
];

function field(overrides: Partial<FieldLike> = {}): FieldLike {
  return {
    id: "f1",
    category: FieldCategory.OTHER,
    isIncluded: true,
    groupId: null,
    groupRole: null,
    visibleToWrittenReviewer: null,
    visibleToFirstRoundReviewer: null,
    ...overrides,
  };
}

function group(overrides: Partial<FieldGroupLike> = {}): FieldGroupLike {
  return {
    id: "g1",
    category: FieldCategory.OTHER,
    isIncluded: true,
    visibleToWrittenReviewer: null,
    visibleToFirstRoundReviewer: null,
    ...overrides,
  };
}

describe("resolveField — the §6 matrix with no overrides", () => {
  // The table in PRD §6, transcribed. If this disagrees with the PRD, the PRD
  // is right and this is the bug.
  const expected: Record<FieldCategory, Record<Viewer, boolean>> = {
    [FieldCategory.DEMOGRAPHIC]: {
      WRITTEN_REVIEWER: false,
      FIRST_ROUND_REVIEWER: false,
      SECOND_ROUND_REVIEWER: true,
      ADMIN: true,
    },
    [FieldCategory.RESPONSE]: {
      WRITTEN_REVIEWER: true,
      FIRST_ROUND_REVIEWER: false,
      SECOND_ROUND_REVIEWER: true,
      ADMIN: true,
    },
    [FieldCategory.OTHER]: {
      WRITTEN_REVIEWER: false,
      FIRST_ROUND_REVIEWER: false,
      SECOND_ROUND_REVIEWER: true,
      ADMIN: true,
    },
  };

  for (const category of Object.values(FieldCategory)) {
    for (const viewer of VIEWERS) {
      it(`${category} is ${expected[category][viewer] ? "visible" : "hidden"} to ${viewer}`, () => {
        expect(resolveField(field({ category }), null, viewer).isVisible).toBe(
          expected[category][viewer],
        );
      });
    }
  }

  it("hides demographics from written and first-round reviewers — the bias control", () => {
    const demographic = field({ category: FieldCategory.DEMOGRAPHIC });
    expect(resolveField(demographic, null, "WRITTEN_REVIEWER").isVisible).toBe(false);
    expect(resolveField(demographic, null, "FIRST_ROUND_REVIEWER").isVisible).toBe(false);
  });

  it("hides written responses from first-round reviewers", () => {
    expect(
      resolveField(field({ category: FieldCategory.RESPONSE }), null, "FIRST_ROUND_REVIEWER")
        .isVisible,
    ).toBe(false);
  });
});

describe("resolveField — the group wins over the member", () => {
  it("takes category, inclusion and visibility from the group, never the member", () => {
    // Member says RESPONSE + included; group says DEMOGRAPHIC + included. A
    // written reviewer sees RESPONSE and not DEMOGRAPHIC, so the group's answer
    // is the one that changes the outcome.
    const member = field({
      category: FieldCategory.RESPONSE,
      isIncluded: true,
      groupId: "g1",
      groupRole: FieldGroupRole.OPTION,
    });
    const g = group({ category: FieldCategory.DEMOGRAPHIC, isIncluded: true });

    const resolved = resolveField(member, g, "WRITTEN_REVIEWER");

    expect(resolved.category).toBe(FieldCategory.DEMOGRAPHIC);
    expect(resolved.isVisible).toBe(false);
    expect(resolved.inheritedFromGroup).toBe(true);
  });

  it("takes the group's exclusion even when the member says included", () => {
    const member = field({ isIncluded: true, groupId: "g1", groupRole: FieldGroupRole.OPTION });
    const g = group({ isIncluded: false });

    const resolved = resolveField(member, g, "ADMIN");

    expect(resolved.isIncluded).toBe(false);
    expect(resolved.isVisible).toBe(false);
  });

  it("ignores a member's own per-round override when grouped", () => {
    // Member tries to make itself visible to written reviewers; the group is
    // silent, so the §6 default applies and the member's value is not read.
    const member = field({
      category: FieldCategory.OTHER,
      groupId: "g1",
      groupRole: FieldGroupRole.OPTION,
      visibleToWrittenReviewer: true,
    });

    expect(resolveField(member, group(), "WRITTEN_REVIEWER").isVisible).toBe(false);
  });

  it("throws when a grouped field is resolved without its group", () => {
    // Resolving against the member's own columns would quietly apply the wrong
    // rules, which is exactly the half-hidden group §5 forbids.
    expect(() =>
      resolveField(field({ groupId: "g1", groupRole: FieldGroupRole.OPTION }), null, "ADMIN"),
    ).toThrow(/no group was supplied/);
  });

  it("throws when the supplied group is not the field's group", () => {
    expect(() =>
      resolveField(
        field({ groupId: "g1", groupRole: FieldGroupRole.OPTION }),
        group({ id: "g2" }),
        "ADMIN",
      ),
    ).toThrow(/was supplied/);
  });
});

describe("resolveField — exclusion beats everything", () => {
  it("hides an excluded field from every viewer, including admin", () => {
    for (const viewer of VIEWERS) {
      expect(resolveField(field({ isIncluded: false }), null, viewer).isVisible).toBe(false);
    }
  });

  it("hides an excluded field even with an explicit visible override", () => {
    const excluded = field({
      category: FieldCategory.OTHER,
      isIncluded: false,
      visibleToWrittenReviewer: true,
    });

    expect(resolveField(excluded, null, "WRITTEN_REVIEWER").isVisible).toBe(false);
  });

  it("hides an excluded RESPONSE from a written reviewer who would otherwise see it", () => {
    expect(
      resolveField(
        field({ category: FieldCategory.RESPONSE, isIncluded: false }),
        null,
        "WRITTEN_REVIEWER",
      ).isVisible,
    ).toBe(false);
  });
});

describe("resolveField — per-round overrides", () => {
  it("honours an override on OTHER for the written round", () => {
    expect(
      resolveField(
        field({ category: FieldCategory.OTHER, visibleToWrittenReviewer: true }),
        null,
        "WRITTEN_REVIEWER",
      ).isVisible,
    ).toBe(true);
  });

  it("honours an override on OTHER for the first round, independently", () => {
    const f = field({
      category: FieldCategory.OTHER,
      visibleToWrittenReviewer: true,
      visibleToFirstRoundReviewer: false,
    });

    expect(resolveField(f, null, "WRITTEN_REVIEWER").isVisible).toBe(true);
    expect(resolveField(f, null, "FIRST_ROUND_REVIEWER").isVisible).toBe(false);
  });

  it("ignores an override on DEMOGRAPHIC — §6 makes only OTHER configurable", () => {
    // Otherwise this is a route to showing ethnicity to written reviewers, which
    // no requirement asks for and goal 3 argues against. See PRD decision 18.
    const f = field({
      category: FieldCategory.DEMOGRAPHIC,
      visibleToWrittenReviewer: true,
      visibleToFirstRoundReviewer: true,
    });

    expect(resolveField(f, null, "WRITTEN_REVIEWER").isVisible).toBe(false);
    expect(resolveField(f, null, "FIRST_ROUND_REVIEWER").isVisible).toBe(false);
  });

  it("ignores an override on RESPONSE", () => {
    const f = field({
      category: FieldCategory.RESPONSE,
      visibleToWrittenReviewer: false,
      visibleToFirstRoundReviewer: true,
    });

    expect(resolveField(f, null, "WRITTEN_REVIEWER").isVisible).toBe(true);
    expect(resolveField(f, null, "FIRST_ROUND_REVIEWER").isVisible).toBe(false);
  });

  it("has no override path for second-round reviewers or admins", () => {
    const f = field({
      category: FieldCategory.OTHER,
      visibleToWrittenReviewer: false,
      visibleToFirstRoundReviewer: false,
    });

    expect(resolveField(f, null, "SECOND_ROUND_REVIEWER").isVisible).toBe(true);
    expect(resolveField(f, null, "ADMIN").isVisible).toBe(true);
  });

  it("falls through to the §6 default when the override is null", () => {
    expect(
      resolveField(field({ category: FieldCategory.OTHER }), null, "WRITTEN_REVIEWER").isVisible,
    ).toBe(false);
  });
});

describe("visibleFieldIds and projectApplicantData", () => {
  const fields: FieldLike[] = [
    field({ id: "essay", category: FieldCategory.RESPONSE }),
    field({ id: "pronouns", category: FieldCategory.DEMOGRAPHIC }),
    field({ id: "junk", category: FieldCategory.OTHER, isIncluded: false }),
    field({
      id: "eth1",
      category: FieldCategory.RESPONSE, // deliberately wrong; the group overrides it
      groupId: "g1",
      groupRole: FieldGroupRole.OPTION,
    }),
    field({
      id: "writein",
      category: FieldCategory.RESPONSE,
      groupId: "g1",
      groupRole: FieldGroupRole.FREE_TEXT,
    }),
  ];
  const groups: FieldGroupLike[] = [group({ id: "g1", category: FieldCategory.DEMOGRAPHIC })];

  it("gives a written reviewer the responses and nothing else", () => {
    expect(visibleFieldIds(fields, groups, "WRITTEN_REVIEWER")).toEqual(new Set(["essay"]));
  });

  it("gives a first-round reviewer nothing from the applicant profile", () => {
    // §6 hides both demographics and written responses from this round.
    expect(visibleFieldIds(fields, groups, "FIRST_ROUND_REVIEWER")).toEqual(new Set());
  });

  it("gives a second-round reviewer everything except the excluded column", () => {
    expect(visibleFieldIds(fields, groups, "SECOND_ROUND_REVIEWER")).toEqual(
      new Set(["essay", "pronouns", "eth1", "writein"]),
    );
  });

  it("keeps a grouped member hidden from written reviewers despite its own RESPONSE category", () => {
    const visible = visibleFieldIds(fields, groups, "WRITTEN_REVIEWER");
    expect(visible.has("eth1")).toBe(false);
    expect(visible.has("writein")).toBe(false);
  });

  it("drops hidden keys from the data rather than blanking them", () => {
    // §6: a hidden field returns no data. An empty string in the payload still
    // tells the client the field exists.
    const data = { essay: "an answer", pronouns: "she/her", junk: "NET-1000", eth1: "White" };
    const projected = projectApplicantData(data, visibleFieldIds(fields, groups, "WRITTEN_REVIEWER"));

    expect(projected).toEqual({ essay: "an answer" });
    expect(Object.keys(projected)).not.toContain("pronouns");
  });
});

describe("resolvePromoted", () => {
  it("hides name and email from written reviewers and gives them the anonymous label", () => {
    expect(resolvePromoted("WRITTEN_REVIEWER")).toEqual({
      name: false,
      email: false,
      anonymousLabel: true,
    });
  });

  it("shows name and email to everyone else", () => {
    for (const viewer of VIEWERS.filter((v) => v !== "WRITTEN_REVIEWER")) {
      expect(resolvePromoted(viewer)).toEqual({ name: true, email: true, anonymousLabel: false });
    }
  });
});

describe("slugify and uniqueSlug", () => {
  it("makes a key safe for an export column heading", () => {
    expect(slugify("Ethnicity")).toBe("ethnicity");
    expect(slugify("First-generation status?")).toBe("first-generation-status");
    expect(slugify("  Spaces   collapse  ")).toBe("spaces-collapse");
  });

  it("folds accents rather than dropping them", () => {
    // "Café" must not become "caf".
    expect(slugify("Café Group")).toBe("cafe-group");
    expect(slugify("Tomás Sørensen")).toBe("tomas-s-rensen");
  });

  it("never returns an empty slug", () => {
    // A name of only punctuation would otherwise produce "", which collides
    // with the next such group and reads as a bug in an export.
    expect(slugify("!!!")).toBe("group");
    expect(slugify("")).toBe("group");
    expect(slugify("日本語")).toBe("group");
  });

  it("suffixes numerically past taken keys", () => {
    const taken = new Set(["ethnicity", "ethnicity-2"]);
    expect(uniqueSlug("Ethnicity", taken)).toBe("ethnicity-3");
    expect(uniqueSlug("Ethnicity", new Set())).toBe("ethnicity");
  });

  it("keeps two differently-named groups apart even when they slug the same", () => {
    const taken = new Set<string>();
    const first = uniqueSlug("Ethnicity!", taken);
    taken.add(first);
    const second = uniqueSlug("Ethnicity?", taken);

    expect(first).toBe("ethnicity");
    expect(second).toBe("ethnicity-2");
  });
});

describe("cleanHeader", () => {
  it("collapses newlines and trailing space, and drops a trailing colon", () => {
    expect(cleanHeader("Graduation Date:")).toBe("Graduation Date");
    expect(cleanHeader("What is something you have worked on?\nWhat steps did you take?")).toBe(
      "What is something you have worked on? What steps did you take?",
    );
    expect(cleanHeader("How would you uniquely contribute? ")).toBe(
      "How would you uniquely contribute?",
    );
  });

  it("leaves curly quotes and apostrophes alone", () => {
    // Real headers carry U+2018/U+2019 and U+201C/U+201D. Normalising them here
    // would make the display name stop matching the source header.
    expect(cleanHeader("What’s one experience — a “failure” — that changed you?")).toBe(
      "What’s one experience — a “failure” — that changed you?",
    );
  });
});
