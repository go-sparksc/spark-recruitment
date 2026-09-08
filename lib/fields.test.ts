import { describe, expect, it } from "vitest";

import { FieldCategory, FieldGroupRole, PromotedRole } from "@/generated/prisma/enums";
import {
  cleanHeader,
  groupMustChooseVisibility,
  mustChooseVisibility,
  projectApplicantData,
  resolveField,
  resolvePromoted,
  slugify,
  uniqueSlug,
  visibleFieldIds,
  type ChoosableFieldLike,
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

const REVIEWERS: Viewer[] = ["WRITTEN_REVIEWER", "FIRST_ROUND_REVIEWER", "SECOND_ROUND_REVIEWER"];

function field(overrides: Partial<ChoosableFieldLike> = {}): ChoosableFieldLike {
  return {
    id: "f1",
    category: FieldCategory.OTHER,
    isIncluded: true,
    groupId: null,
    groupRole: null,
    promotedRole: null,
    isReviewerVisible: null,
    ...overrides,
  };
}

function group(overrides: Partial<FieldGroupLike> = {}): FieldGroupLike {
  return {
    id: "g1",
    category: FieldCategory.OTHER,
    isIncluded: true,
    isReviewerVisible: null,
    ...overrides,
  };
}

describe("resolveField — §6's binary flag", () => {
  // Decision 108: one flag, no per-round distinction. If this disagrees with
  // the PRD, the PRD is right and this is the bug.

  for (const category of Object.values(FieldCategory)) {
    const locked = category === FieldCategory.DEMOGRAPHIC;

    it(`${category} with the flag set is ${locked ? "still hidden" : "visible"} to every reviewer round`, () => {
      const f = field({ category, isReviewerVisible: true });
      for (const viewer of REVIEWERS) {
        expect(resolveField(f, null, viewer).isVisible).toBe(!locked);
      }
    });

    it(`${category} with the flag unset is hidden from every reviewer round`, () => {
      const f = field({ category });
      for (const viewer of REVIEWERS) {
        expect(resolveField(f, null, viewer).isVisible).toBe(false);
      }
    });

    it(`${category} is visible to ADMIN`, () => {
      expect(resolveField(field({ category }), null, "ADMIN").isVisible).toBe(true);
    });
  }

  it("resolves the same for all three reviewer rounds — there is no per-round rule", () => {
    for (const isReviewerVisible of [true, false, null]) {
      const resolved = REVIEWERS.map(
        (viewer) => resolveField(field({ isReviewerVisible }), null, viewer).isVisible,
      );
      expect(new Set(resolved).size).toBe(1);
    }
  });

  it("shows written responses to first-round reviewers — decision 108's first reversal", () => {
    // The old matrix hid RESPONSE from this round specifically. It no longer does.
    expect(
      resolveField(
        field({ category: FieldCategory.RESPONSE, isReviewerVisible: true }),
        null,
        "FIRST_ROUND_REVIEWER",
      ).isVisible,
    ).toBe(true);
  });

  it("hides demographics from second-round reviewers — decision 108's second reversal", () => {
    // The old matrix showed DEMOGRAPHIC to this round. FR-16's "complete
    // applicant profile" no longer includes it.
    expect(
      resolveField(
        field({ category: FieldCategory.DEMOGRAPHIC }),
        null,
        "SECOND_ROUND_REVIEWER",
      ).isVisible,
    ).toBe(false);
  });

  it("hides an OTHER column from second-round reviewers unless it is ticked", () => {
    // Decision 108's third change: OTHER used to be unconditionally visible to
    // this round. Now it is one tick like anything else.
    expect(
      resolveField(field({ category: FieldCategory.OTHER }), null, "SECOND_ROUND_REVIEWER")
        .isVisible,
    ).toBe(false);
    expect(
      resolveField(
        field({ category: FieldCategory.OTHER, isReviewerVisible: true }),
        null,
        "SECOND_ROUND_REVIEWER",
      ).isVisible,
    ).toBe(true);
  });
});

describe("resolveField — the DEMOGRAPHIC lock", () => {
  it("ignores a stored true on a DEMOGRAPHIC field, for every reviewer round", () => {
    // The lock lives in the resolver, not only in the mapping UI, so a value
    // that arrives some other way is inert. Decision 18's property, carried
    // into the binary model by decision 108. This is the bias control.
    const f = field({ category: FieldCategory.DEMOGRAPHIC, isReviewerVisible: true });

    for (const viewer of REVIEWERS) {
      expect(resolveField(f, null, viewer).isVisible).toBe(false);
    }
  });

  it("ignores a stored true on a DEMOGRAPHIC group, for every reviewer round", () => {
    const member = field({ groupId: "g1", groupRole: FieldGroupRole.OPTION });
    const g = group({ category: FieldCategory.DEMOGRAPHIC, isReviewerVisible: true });

    for (const viewer of REVIEWERS) {
      expect(resolveField(member, g, viewer).isVisible).toBe(false);
    }
  });

  it("still shows a locked demographic field to ADMIN", () => {
    // Locked out of the reviewer rounds, not out of FR-10 and FR-19.
    expect(
      resolveField(
        field({ category: FieldCategory.DEMOGRAPHIC, isReviewerVisible: true }),
        null,
        "ADMIN",
      ).isVisible,
    ).toBe(true);
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

  it("ignores a member's own visibility flag when grouped", () => {
    // Member tries to make itself visible; the group has not been chosen, so
    // the column stays hidden and the member's value is never read.
    const member = field({
      category: FieldCategory.OTHER,
      groupId: "g1",
      groupRole: FieldGroupRole.OPTION,
      isReviewerVisible: true,
    });

    expect(resolveField(member, group(), "WRITTEN_REVIEWER").isVisible).toBe(false);
  });

  it("takes the group's visibility even when the member is silent", () => {
    const member = field({ groupId: "g1", groupRole: FieldGroupRole.OPTION });
    const g = group({ isReviewerVisible: true });

    expect(resolveField(member, g, "WRITTEN_REVIEWER").isVisible).toBe(true);
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

  it("hides an excluded field even with the visibility flag set", () => {
    const excluded = field({
      category: FieldCategory.OTHER,
      isIncluded: false,
      isReviewerVisible: true,
    });

    expect(resolveField(excluded, null, "WRITTEN_REVIEWER").isVisible).toBe(false);
  });

  it("hides an excluded RESPONSE from a written reviewer who would otherwise see it", () => {
    expect(
      resolveField(
        field({ category: FieldCategory.RESPONSE, isIncluded: false, isReviewerVisible: true }),
        null,
        "WRITTEN_REVIEWER",
      ).isVisible,
    ).toBe(false);
  });
});

describe("mustChooseVisibility — FR-2's no-default rule", () => {
  it("asks for a choice on an included, ungrouped, non-demographic column", () => {
    expect(mustChooseVisibility(field(), null)).toBe(true);
  });

  it("stops asking once either state has been chosen", () => {
    expect(mustChooseVisibility(field({ isReviewerVisible: true }), null)).toBe(false);
    expect(mustChooseVisibility(field({ isReviewerVisible: false }), null)).toBe(false);
  });

  it("does not ask about a grouped member — the choice belongs to the group", () => {
    const member = field({ groupId: "g1", groupRole: FieldGroupRole.OPTION });
    expect(mustChooseVisibility(member, group())).toBe(false);
  });

  it("does not ask about a DEMOGRAPHIC column — §6 locks it", () => {
    expect(mustChooseVisibility(field({ category: FieldCategory.DEMOGRAPHIC }), null)).toBe(false);
  });

  it("does not ask about an excluded column", () => {
    expect(mustChooseVisibility(field({ isIncluded: false }), null)).toBe(false);
  });

  it("does not ask about a promoted column — its Field row is deleted at commit", () => {
    expect(mustChooseVisibility(field({ promotedRole: PromotedRole.EMAIL }), null)).toBe(false);
    expect(mustChooseVisibility(field({ promotedRole: PromotedRole.NAME }), null)).toBe(false);
  });

  it("asks about a RESPONSE column like any other — it is a blocker, not a lock", () => {
    // FR-3 refuses the commit if this one is answered "Backend only", but the
    // question is still asked rather than answered for the admin.
    expect(mustChooseVisibility(field({ category: FieldCategory.RESPONSE }), null)).toBe(true);
  });

  it("asks about an included non-demographic group, and not otherwise", () => {
    expect(groupMustChooseVisibility(group())).toBe(true);
    expect(groupMustChooseVisibility(group({ isReviewerVisible: false }))).toBe(false);
    expect(groupMustChooseVisibility(group({ isIncluded: false }))).toBe(false);
    expect(groupMustChooseVisibility(group({ category: FieldCategory.DEMOGRAPHIC }))).toBe(false);
  });

  it("an unchosen column resolves hidden while it waits to be decided", () => {
    // The no-default rule is a gate, not a leak: unset is not a third visible
    // state, so an instance that has not answered yet still shows nothing.
    const unchosen = field();
    expect(mustChooseVisibility(unchosen, null)).toBe(true);
    for (const viewer of REVIEWERS) {
      expect(resolveField(unchosen, null, viewer).isVisible).toBe(false);
    }
  });
});

describe("visibleFieldIds and projectApplicantData", () => {
  const fields: FieldLike[] = [
    field({ id: "essay", category: FieldCategory.RESPONSE, isReviewerVisible: true }),
    field({ id: "major", category: FieldCategory.OTHER, isReviewerVisible: true }),
    field({ id: "unchosen", category: FieldCategory.OTHER }),
    field({ id: "pronouns", category: FieldCategory.DEMOGRAPHIC, isReviewerVisible: true }),
    field({
      id: "junk",
      category: FieldCategory.OTHER,
      isIncluded: false,
      isReviewerVisible: true,
    }),
    field({
      id: "eth1",
      category: FieldCategory.RESPONSE, // deliberately wrong; the group overrides it
      groupId: "g1",
      groupRole: FieldGroupRole.OPTION,
      isReviewerVisible: true,
    }),
    field({
      id: "writein",
      category: FieldCategory.RESPONSE,
      groupId: "g1",
      groupRole: FieldGroupRole.FREE_TEXT,
      isReviewerVisible: true,
    }),
  ];
  const groups: FieldGroupLike[] = [group({ id: "g1", category: FieldCategory.DEMOGRAPHIC })];

  it("gives every reviewer round the same set", () => {
    // The heart of decision 108: the round no longer changes the answer.
    const sets = REVIEWERS.map((viewer) => [...visibleFieldIds(fields, groups, viewer)].sort());
    expect(sets[0]).toEqual(["essay", "major"]);
    expect(sets[1]).toEqual(sets[0]);
    expect(sets[2]).toEqual(sets[0]);
  });

  it("gives an admin everything except the excluded column", () => {
    expect(visibleFieldIds(fields, groups, "ADMIN")).toEqual(
      new Set(["essay", "major", "unchosen", "pronouns", "eth1", "writein"]),
    );
  });

  it("keeps a grouped member hidden behind its DEMOGRAPHIC group, despite its own flag", () => {
    const visible = visibleFieldIds(fields, groups, "SECOND_ROUND_REVIEWER");
    expect(visible.has("eth1")).toBe(false);
    expect(visible.has("writein")).toBe(false);
  });

  it("drops hidden keys from the data rather than blanking them", () => {
    // §6: a hidden field returns no data. An empty string in the payload still
    // tells the client the field exists.
    const data = {
      essay: "an answer",
      pronouns: "she/her",
      junk: "NET-1000",
      eth1: "White",
      unchosen: "Fall 2027",
    };
    const projected = projectApplicantData(data, visibleFieldIds(fields, groups, "WRITTEN_REVIEWER"));

    expect(projected).toEqual({ essay: "an answer" });
    expect(Object.keys(projected)).not.toContain("pronouns");
    expect(Object.keys(projected)).not.toContain("unchosen");
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
