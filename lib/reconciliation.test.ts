// FR-13's cascade. These cases ARE the spec — plans/phase-5.md enumerates them,
// and if one of them disagrees with lib/reconciliation.ts, the implementation is
// wrong.
//
// Same standing as lib/assignment.test.ts and lib/roster.test.ts. BUILD_PLAN
// weights this cascade with the assignment algorithm and the pass state machine,
// and the reason is the workbook being replaced: its `1R Notes` sheet keys on
// free-text names typed by interviewers, and one typo silently orphans a record.
//
// Two of the cases below are REGRESSION GUARDS rather than behaviour — they
// assert facts about the metric, not about the module — and they are what stops
// anyone reinstating PRD decision 45's whole-string rule without noticing it
// cannot work. See the "decision 52" block at the bottom.

import { describe, expect, it } from "vitest";

import {
  FUZZY_THRESHOLD,
  findBatchCollisions,
  jaroWinkler,
  matchRow,
  normalizeMatchName,
  type Candidate,
} from "@/lib/reconciliation";

/// A pool member. Email defaults to null, since most cases are about names.
function applicant(
  applicantId: string,
  displayName: string,
  email: string | null = null,
): Candidate {
  return { applicantId, displayName, email };
}

// ---------------------------------------------------------------------------
// Normalization — tested before any tier, because every tier depends on it
// ---------------------------------------------------------------------------

describe("normalizeMatchName", () => {
  it("trims, collapses whitespace runs, and case-folds", () => {
    expect(normalizeMatchName("  Jordan   Lee  ")).toBe("jordan lee");
    expect(normalizeMatchName("JORDAN LEE")).toBe("jordan lee");
  });

  it("drops a standalone middle initial, with or without its period", () => {
    expect(normalizeMatchName("Jordan A. Lee")).toBe("jordan lee");
    expect(normalizeMatchName("Jordan A Lee")).toBe("jordan lee");
  });

  it("strips punctuation without leaving an orphaned letter behind", () => {
    // The apostrophe is DELETED, not replaced with a space. Replacing would give
    // "o brien", whose "o" the single-letter rule then eats, leaving "brien".
    expect(normalizeMatchName("O'Brien, Casey")).toBe("obrien casey");
    expect(normalizeMatchName("OBrien, Casey")).toBe("obrien casey");
    expect(normalizeMatchName("O'Brien, Casey")).toBe(normalizeMatchName("OBrien, Casey"));
  });

  it("removes hyphens, which the fuzzy tier then has to cover", () => {
    expect(normalizeMatchName("Mary-Jane Smith")).toBe("maryjane smith");
    // Deliberately NOT equal. A hyphenated name written unhyphenated in the
    // other file is a fuzzy-tier problem, not a normalization one, and pretending
    // otherwise would mean splitting on hyphens — which would also split
    // genuinely hyphenated surnames into two people.
    expect(normalizeMatchName("Mary Jane Smith")).not.toBe(normalizeMatchName("Mary-Jane Smith"));
  });

  it("keeps accented letters rather than deleting them", () => {
    // A non-Unicode-aware [^a-z0-9\s] would leave "jos".
    expect(normalizeMatchName("José Álvarez")).toBe("josé álvarez");
  });

  it("treats a decomposed accent as identical to a composed one", () => {
    const composed = "José Alvarez"; // é as one codepoint
    const decomposed = "José Alvarez"; // e + combining acute
    expect(normalizeMatchName(decomposed)).toBe(normalizeMatchName(composed));
  });

  it("returns the empty string for a name that normalizes away entirely", () => {
    expect(normalizeMatchName("...")).toBe("");
    expect(normalizeMatchName("   ")).toBe("");
    expect(normalizeMatchName("J. R.")).toBe("");
    expect(normalizeMatchName("")).toBe("");
    expect(normalizeMatchName(null)).toBe("");
    expect(normalizeMatchName(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Jaro-Winkler — pinned to published reference values
// ---------------------------------------------------------------------------

describe("jaroWinkler", () => {
  // If a refactor changes the metric, these fail before any behaviour does —
  // which matters because decision 52's threshold was chosen against exactly
  // this implementation.
  it.each([
    ["martha", "marhta", 0.961],
    ["dwayne", "duane", 0.84],
    ["dixon", "dicksonx", 0.813],
    ["crate", "trace", 0.733],
    ["trate", "trace", 0.906],
  ])("scores %s / %s at ~%s", (a, b, expected) => {
    expect(jaroWinkler(a, b)).toBeCloseTo(expected, 2);
  });

  it("is 1 for identical non-empty strings and 0 when either side is empty", () => {
    expect(jaroWinkler("jordan", "jordan")).toBe(1);
    expect(jaroWinkler("", "jordan")).toBe(0);
    expect(jaroWinkler("jordan", "")).toBe(0);
    expect(jaroWinkler("", "")).toBe(0);
  });

  it("is symmetric", () => {
    expect(jaroWinkler("cici", "cecilia")).toBeCloseTo(jaroWinkler("cecilia", "cici"), 10);
  });
});

// ---------------------------------------------------------------------------
// Tier 1 — exact email
// ---------------------------------------------------------------------------

describe("tier 1: exact email", () => {
  it("matches on email and stops the cascade there", () => {
    // The pool is rigged so that falling through would match somebody ELSE by
    // name. A cascade that did not stop would return b-2.
    const pool = [
      applicant("a-1", "Jordan Lee", "jordan.lee@usc.edu"),
      applicant("b-2", "Casey Kim", "casey.kim@usc.edu"),
    ];

    expect(matchRow({ email: "jordan.lee@usc.edu", name: "Casey Kim" }, pool)).toEqual({
      kind: "MATCHED",
      applicantId: "a-1",
      tier: "EMAIL",
      confidence: null,
    });
  });

  it("matches a padded, mixed-case address after normalization", () => {
    const pool = [applicant("a-1", "Jordan Lee", "jordan.lee@usc.edu")];

    expect(matchRow({ email: "  Jordan.Lee@USC.EDU  " }, pool)).toEqual({
      kind: "MATCHED",
      applicantId: "a-1",
      tier: "EMAIL",
      confidence: null,
    });
  });

  it("does not match an applicant the caller left out of the scoped pool", () => {
    // PRD decision 48. The written-round rejection whose address this is never
    // reaches this function — the caller's `stageReached != WRITTEN` filter
    // removed them — so a technically correct match elsewhere in the instance is
    // correctly invisible here.
    const pool = [applicant("in-scope", "Casey Kim", "casey.kim@usc.edu")];

    expect(matchRow({ email: "rejected.applicant@usc.edu" }, pool)).toEqual({
      kind: "UNRESOLVED",
      reason: "NO_CANDIDATES",
    });
  });

  it("skips the tier when the row has no address, blank or absent", () => {
    const pool = [applicant("a-1", "Jordan Lee", "jordan.lee@usc.edu")];
    const expected = { kind: "MATCHED", applicantId: "a-1", tier: "NAME", confidence: null };

    expect(matchRow({ email: "", name: "Jordan Lee" }, pool)).toEqual(expected);
    expect(matchRow({ email: null, name: "Jordan Lee" }, pool)).toEqual(expected);
    expect(matchRow({ name: "Jordan Lee" }, pool)).toEqual(expected);
  });

  it("queues rather than picking when two pool members share an address", () => {
    // UNIQUE (instanceId, email) makes this unreachable through the app. The
    // branch is tested anyway: the constraint is instance-scoped and this pool is
    // a subset, so nothing here should depend on that reasoning holding.
    const pool = [
      applicant("a-1", "Jordan Lee", "shared@usc.edu"),
      applicant("b-2", "Jordan Li", "shared@usc.edu"),
    ];

    expect(matchRow({ email: "shared@usc.edu" }, pool)).toEqual({
      kind: "AMBIGUOUS",
      tier: "EMAIL",
      candidates: [
        { applicantId: "a-1", confidence: null },
        { applicantId: "b-2", confidence: null },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — exact name
// ---------------------------------------------------------------------------

describe("tier 2: exact name", () => {
  it("matches on the normalized name when the row has no email", () => {
    const pool = [applicant("a-1", "Jordan Lee"), applicant("b-2", "Casey Kim")];

    expect(matchRow({ name: "Jordan Lee" }, pool)).toEqual({
      kind: "MATCHED",
      applicantId: "a-1",
      tier: "NAME",
      confidence: null,
    });
  });

  it("queues when two pool members share an exact name", () => {
    // Ambiguity queues at ANY tier, not only the fuzzy one. Auto-resolving to
    // whichever row came back first is the same defect as a wrong fuzzy guess,
    // wearing a more confident face.
    const pool = [applicant("a-1", "Jordan Lee"), applicant("b-2", "Jordan Lee")];

    expect(matchRow({ name: "Jordan Lee" }, pool)).toEqual({
      kind: "AMBIGUOUS",
      tier: "NAME",
      candidates: [
        { applicantId: "a-1", confidence: null },
        { applicantId: "b-2", confidence: null },
      ],
    });
  });

  it("resolves a middle initial at TIER 2, not tier 3", () => {
    // Asserted on the tier, not just on the applicant. The whole point of
    // stripping single-letter tokens is that this pair never reaches the fuzzy
    // threshold — a threshold loose enough to absorb an inserted token would
    // also absorb genuinely different short names.
    const pool = [applicant("a-1", "Jordan Lee")];
    const outcome = matchRow({ name: "Jordan A. Lee" }, pool);

    expect(outcome).toEqual({
      kind: "MATCHED",
      applicantId: "a-1",
      tier: "NAME",
      confidence: null,
    });
  });

  it("resolves apostrophe variance at TIER 2, not tier 3", () => {
    // Same reasoning: this must not depend on 0.78 absorbing the punctuation.
    const pool = [applicant("a-1", "OBrien, Casey")];

    expect(matchRow({ name: "O'Brien, Casey" }, pool)).toEqual({
      kind: "MATCHED",
      applicantId: "a-1",
      tier: "NAME",
      confidence: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — fuzzy name, PRD decision 52
// ---------------------------------------------------------------------------

describe("tier 3: fuzzy name", () => {
  it("matches Cici to Cecilia when nobody else is close", () => {
    // BUILD_PLAN's headline case, and the one decision 45's own threshold
    // rejected.
    const pool = [applicant("a-1", "Cecilia Fang"), applicant("b-2", "Casey Kim")];
    const outcome = matchRow({ name: "Cici Fang" }, pool);

    expect(outcome.kind).toBe("MATCHED");
    if (outcome.kind !== "MATCHED") return;
    expect(outcome.applicantId).toBe("a-1");
    expect(outcome.tier).toBe("FUZZY");
    expect(outcome.confidence).toBeCloseTo(0.796, 3);
  });

  it("matches a transposed vowel", () => {
    const pool = [applicant("a-1", "Cecilia Fang")];
    const outcome = matchRow({ name: "Cecelia Fang" }, pool);

    expect(outcome.kind).toBe("MATCHED");
    if (outcome.kind !== "MATCHED") return;
    expect(outcome.tier).toBe("FUZZY");
    expect(outcome.confidence).toBeCloseTo(0.894, 3);
  });

  it("does NOT match Mia to Nia", () => {
    // The given-name initials differ, so the pair is never scored. This is the
    // case that proves the rule is structural rather than a threshold that
    // happened to land right — see the decision 52 guard below for why no
    // threshold could have done this.
    const pool = [applicant("a-1", "Nia Chen")];

    expect(matchRow({ name: "Mia Chen" }, pool)).toEqual({
      kind: "UNRESOLVED",
      reason: "NO_CANDIDATES",
    });
  });

  it("queues rather than picking when two candidates clear the threshold", () => {
    // PRD decision 45: more than one above threshold goes to the manual queue,
    // never to the closest one. Both are shown, best first.
    const pool = [applicant("a-1", "Megan Woods"), applicant("b-2", "Maegan Woods")];
    const outcome = matchRow({ name: "Meagan Woods" }, pool);

    expect(outcome.kind).toBe("AMBIGUOUS");
    if (outcome.kind !== "AMBIGUOUS") return;
    expect(outcome.tier).toBe("FUZZY");
    expect(outcome.candidates.map((c) => c.applicantId)).toEqual(["b-2", "a-1"]);
    expect(outcome.candidates[0].confidence).toBeCloseTo(0.95, 2);
    expect(outcome.candidates[1].confidence).toBeCloseTo(0.902, 3);
  });

  it("requires the surname to match exactly", () => {
    // Fang and Fong are two families. Whole-string scoring rates this pair 0.956
    // — higher than the Cici/Cecilia pair it is supposed to be worse than.
    const pool = [applicant("a-1", "Cecilia Fong")];

    expect(matchRow({ name: "Cici Fang" }, pool)).toEqual({
      kind: "UNRESOLVED",
      reason: "NO_CANDIDATES",
    });
  });

  it("does not match two short names differing at the initial", () => {
    const pool = [applicant("a-1", "Pam Park")];

    expect(matchRow({ name: "Sam Park" }, pool)).toEqual({
      kind: "UNRESOLVED",
      reason: "NO_CANDIDATES",
    });
  });

  it("rejects a differing initial that the threshold alone would have accepted", () => {
    // The case above and the Mia/Nia case both score 0.7778, which is under 0.78
    // by two thousandths — so they would be excluded even with no gate, and they
    // prove nothing about it. This pair is the one that does: "sara"/"kara"
    // scores 0.833, comfortably over the threshold, and only the initial gate
    // keeps two different people apart.
    expect(jaroWinkler("sara", "kara")).toBeGreaterThan(FUZZY_THRESHOLD);

    expect(matchRow({ name: "Sara Chen" }, [applicant("a-1", "Kara Chen")])).toEqual({
      kind: "UNRESOLVED",
      reason: "NO_CANDIDATES",
    });
  });

  it("still proposes a same-initial near-miss, which is what decision 53 is for", () => {
    // "ana"/"ann" scores 0.822 — over the threshold, same initial, same surname —
    // so the rule cannot tell these two people apart and does not try to. It is
    // a PROPOSAL: matchTier FUZZY with a confidence, shown in the confirm list.
    //
    // This is the residual risk decision 53 exists to absorb, recorded here as a
    // test rather than left to be discovered. Anyone tempted to auto-commit a
    // single fuzzy candidate should read this case first: the arithmetic offers
    // no way to exclude it that does not also exclude Cici/Cecilia, which scores
    // LOWER at 0.796.
    const outcome = matchRow({ name: "Ana Chen" }, [applicant("a-1", "Ann Chen")]);

    expect(outcome.kind).toBe("MATCHED");
    if (outcome.kind !== "MATCHED") return;
    expect(outcome.tier).toBe("FUZZY");
    expect(outcome.confidence).toBeCloseTo(0.822, 3);
    expect(outcome.confidence).toBeGreaterThan(0.796); // higher than Cici/Cecilia
  });

  it("never fuzzy-matches a single-token name", () => {
    // No surname to hold fixed means the rule degrades to a bare similarity
    // score, which is the thing decision 52 exists to stop. Costs a minute in the
    // manual queue.
    expect(matchRow({ name: "Cher" }, [applicant("a-1", "Cher Bono")])).toEqual({
      kind: "UNRESOLVED",
      reason: "NO_CANDIDATES",
    });
    expect(matchRow({ name: "Cici Fang" }, [applicant("a-1", "Fang")])).toEqual({
      kind: "UNRESOLVED",
      reason: "NO_CANDIDATES",
    });
  });
});

// ---------------------------------------------------------------------------
// Tier 4 — the unresolved queue
// ---------------------------------------------------------------------------

describe("tier 4: unresolved", () => {
  it("distinguishes a row with no identity from one that found nobody", () => {
    const pool = [applicant("a-1", "Jordan Lee", "jordan.lee@usc.edu")];

    // Nothing to match on at all — the file or the mapping is wrong, and no
    // amount of searching the pool fixes it.
    expect(matchRow({}, pool)).toEqual({ kind: "UNRESOLVED", reason: "NO_IDENTITY" });
    expect(matchRow({ email: "", name: "" }, pool)).toEqual({
      kind: "UNRESOLVED",
      reason: "NO_IDENTITY",
    });

    // Had an identity, found nobody — the admin's to map by hand.
    expect(matchRow({ email: "nobody@usc.edu", name: "Nobody Here" }, pool)).toEqual({
      kind: "UNRESOLVED",
      reason: "NO_CANDIDATES",
    });
  });

  it("carries no candidate list, so there is no false 'did you mean'", () => {
    const pool = [applicant("a-1", "Jordan Lee"), applicant("b-2", "Casey Kim")];
    const outcome = matchRow({ name: "Someone Entirely Different" }, pool);

    expect(outcome).toEqual({ kind: "UNRESOLVED", reason: "NO_CANDIDATES" });
    expect(outcome).not.toHaveProperty("candidates");
  });

  it("treats a name that normalizes to nothing as blank, never as an empty comparison", () => {
    // An empty string is trivially similar to short names. Fed to the scorer it
    // would match half the pool at once.
    const pool = [applicant("a-1", "Jordan Lee"), applicant("b-2", "Casey Kim")];

    expect(matchRow({ name: "." }, pool)).toEqual({ kind: "UNRESOLVED", reason: "NO_IDENTITY" });
    expect(matchRow({ name: "J. R." }, pool)).toEqual({ kind: "UNRESOLVED", reason: "NO_IDENTITY" });
  });

  it("handles an empty pool without crashing", () => {
    expect(matchRow({ email: "jordan.lee@usc.edu", name: "Jordan Lee" }, [])).toEqual({
      kind: "UNRESOLVED",
      reason: "NO_CANDIDATES",
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

describe("cross-cutting", () => {
  it("resolves both of an applicant's rows to the SAME id through different tiers", () => {
    // The case the whole phase exists for: two interviewers, one applicant, one
    // of them typed the address wrong. Both rows must land on one applicantId or
    // the applicant silently ends up with one interview score instead of two.
    const pool = [
      applicant("a-1", "Cecilia Fang", "cecilia.fang@usc.edu"),
      applicant("b-2", "Casey Kim", "casey.kim@usc.edu"),
    ];

    const correct = matchRow(
      { email: "cecilia.fang@usc.edu", name: "Cecilia Fang" },
      pool,
    );
    const typoed = matchRow({ email: "cecila.fang@usc.ed", name: "Cecilia Fang" }, pool);

    expect(correct).toEqual({
      kind: "MATCHED",
      applicantId: "a-1",
      tier: "EMAIL",
      confidence: null,
    });
    expect(typoed).toEqual({
      kind: "MATCHED",
      applicantId: "a-1",
      tier: "NAME",
      confidence: null,
    });

    expect(correct.kind === "MATCHED" && correct.applicantId).toBe(
      typoed.kind === "MATCHED" && typoed.applicantId,
    );
  });

  it("never reports a confidence on a non-fuzzy tier", () => {
    // PRD §5, and a CHECK constraint holds the database to the same rule.
    const pool = [applicant("a-1", "Jordan Lee", "jordan.lee@usc.edu")];

    for (const row of [{ email: "jordan.lee@usc.edu" }, { name: "Jordan Lee" }]) {
      const outcome = matchRow(row, pool);
      expect(outcome.kind).toBe("MATCHED");
      if (outcome.kind !== "MATCHED") continue;
      expect(outcome.confidence).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// PRD decision 52 — regression guards, not behaviour
// ---------------------------------------------------------------------------

describe("decision 52's premise", () => {
  // These two assert facts about Jaro-Winkler, not about this module. They exist
  // so that anyone reinstating decision 45's whole-string rule discovers, from a
  // failing test rather than from a wrongly imported cycle, that it cannot work.
  it("whole-string scoring rejects the pair that must match", () => {
    expect(jaroWinkler("cici fang", "cecilia fang")).toBeLessThan(0.85);
  });

  it("whole-string scoring accepts the pair that must not match", () => {
    expect(jaroWinkler("mia chen", "nia chen")).toBeGreaterThan(0.85);
  });

  it("means no whole-string threshold can separate them", () => {
    // The required match scores strictly LOWER than the required non-match, so
    // there is no cut point between them in the needed direction. This is the
    // argument for scoring the given name against an exact surname instead.
    expect(jaroWinkler("cici fang", "cecilia fang")).toBeLessThan(
      jaroWinkler("mia chen", "nia chen"),
    );
  });

  it("keeps the threshold where the resolved decision put it", () => {
    expect(FUZZY_THRESHOLD).toBe(0.78);
  });
});

// ---------------------------------------------------------------------------
// PRD decisions 49 and 50 — batch collisions
// ---------------------------------------------------------------------------

describe("findBatchCollisions", () => {
  it("does NOT flag two scores rows for one applicant from different interviewers", () => {
    // FR-12's expected shape. Decision 49 read literally would fire here, on
    // every correctly imported applicant — which is why decision 50 keys it on
    // the upsert key instead.
    const rows = [
      { rowIndex: 1, applicantId: "a-1", interviewerName: "Alex Kim" },
      { rowIndex: 2, applicantId: "a-1", interviewerName: "Robin Diaz" },
    ];

    expect(findBatchCollisions(rows, "SCORES")).toEqual([]);
  });

  it("flags two scores rows for one applicant from the SAME interviewer", () => {
    const rows = [
      { rowIndex: 1, applicantId: "a-1", interviewerName: "Alex Kim" },
      { rowIndex: 2, applicantId: "a-1", interviewerName: "Robin Diaz" },
      { rowIndex: 3, applicantId: "a-1", interviewerName: "Alex Kim" },
    ];

    expect(findBatchCollisions(rows, "SCORES")).toEqual([
      { applicantId: "a-1", interviewerName: "alex kim", rowIndexes: [1, 3] },
    ]);
  });

  it("compares interviewer names case- and whitespace-insensitively", () => {
    const rows = [
      { rowIndex: 4, applicantId: "a-1", interviewerName: "Alex Kim" },
      { rowIndex: 9, applicantId: "a-1", interviewerName: "  alex   KIM " },
    ];

    expect(findBatchCollisions(rows, "SCORES")).toEqual([
      { applicantId: "a-1", interviewerName: "alex kim", rowIndexes: [4, 9] },
    ]);
  });

  it("flags two notes rows for one applicant regardless of interviewer", () => {
    // FR-12: one row per applicant on this sheet, and the upsert key is the
    // applicant alone.
    const rows = [
      { rowIndex: 1, applicantId: "a-1", interviewerName: "Alex Kim" },
      { rowIndex: 2, applicantId: "a-1", interviewerName: "Robin Diaz" },
    ];

    expect(findBatchCollisions(rows, "NOTES")).toEqual([
      { applicantId: "a-1", interviewerName: null, rowIndexes: [1, 2] },
    ]);
  });

  it("reports every row in the collision, in file order, groups ordered by first row", () => {
    // Both sides, not just the later one — the admin is deciding about a set,
    // and showing half of it hides half of what they are deciding.
    const rows = [
      { rowIndex: 7, applicantId: "b-2" },
      { rowIndex: 2, applicantId: "a-1" },
      { rowIndex: 9, applicantId: "b-2" },
      { rowIndex: 5, applicantId: "a-1" },
      { rowIndex: 3, applicantId: "b-2" },
    ];

    expect(findBatchCollisions(rows, "NOTES")).toEqual([
      { applicantId: "a-1", interviewerName: null, rowIndexes: [2, 5] },
      { applicantId: "b-2", interviewerName: null, rowIndexes: [3, 7, 9] },
    ]);
  });

  it("finds nothing in a clean batch, or an empty one", () => {
    expect(findBatchCollisions([], "SCORES")).toEqual([]);
    expect(
      findBatchCollisions(
        [
          { rowIndex: 1, applicantId: "a-1" },
          { rowIndex: 2, applicantId: "b-2" },
        ],
        "NOTES",
      ),
    ).toEqual([]);
  });

  it("keys on the applicant as well as the interviewer", () => {
    // One interviewer scoring two different applicants is the ordinary case and
    // must not collide.
    const rows = [
      { rowIndex: 1, applicantId: "a-1", interviewerName: "Alex Kim" },
      { rowIndex: 2, applicantId: "b-2", interviewerName: "Alex Kim" },
    ];

    expect(findBatchCollisions(rows, "SCORES")).toEqual([]);
  });
});
