import { describe, expect, it } from "vitest";

import { ApplicantStatus, FieldGroupRole, Round } from "@/generated/prisma/enums";
import {
  ARCHIVE_SUMMARY_VERSION,
  buildArchiveSummary,
  purgePlan,
  retentionCandidates,
  type ArchiveSummaryInput,
  type RetainableInstance,
} from "@/lib/archive";
import type { DemographicColumn } from "@/lib/demographics";

// ---------------------------------------------------------------------------
// retentionCandidates
// ---------------------------------------------------------------------------

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

const cycle = (id: string, dayOfMonth: number, archivedAt: Date | null = null): RetainableInstance => ({
  id,
  name: id,
  createdAt: day(dayOfMonth),
  archivedAt,
});

const ids = (rows: readonly RetainableInstance[]) => rows.map((row) => row.id);

describe("retentionCandidates", () => {
  it("keeps the newest N and offers the rest", () => {
    const split = retentionCandidates([cycle("a", 1), cycle("b", 2), cycle("c", 3)], 2);

    expect(ids(split.retained)).toEqual(["c", "b"]);
    expect(ids(split.candidates)).toEqual(["a"]);
  });

  it("offers nothing when there are exactly N cycles", () => {
    // The boundary. Off by one here purges the oldest live cycle the first time
    // a club runs its second recruitment.
    const split = retentionCandidates([cycle("a", 1), cycle("b", 2)], 2);

    expect(split.candidates).toEqual([]);
    expect(split.cutoff).toBeNull();
  });

  it("offers nothing when there are fewer than N cycles", () => {
    const split = retentionCandidates([cycle("a", 1)], 2);

    expect(split.candidates).toEqual([]);
    expect(split.cutoff).toBeNull();
  });

  it("offers exactly one at N+1", () => {
    const split = retentionCandidates([cycle("a", 1), cycle("b", 2), cycle("c", 3)], 2);

    expect(ids(split.candidates)).toEqual(["a"]);
  });

  it("puts the cutoff at the oldest RETAINED cycle", () => {
    // Orphaned instance-deletion audit rows age out against this date. Taking it
    // from the newest candidate instead would leave a window of rows belonging
    // to no cycle and older than everything kept.
    const split = retentionCandidates([cycle("a", 1), cycle("b", 2), cycle("c", 3)], 2);

    expect(split.cutoff).toEqual(day(2));
  });

  it("never re-offers an already-archived cycle", () => {
    // The trap decision 95 exists to close. Rank is computed on createdAt, so a
    // purged cycle re-enters candidacy the moment enough newer ones exist — and
    // a second purge would recompute the summary against the data the first one
    // emptied, overwriting correct numbers with zeros and failing nothing.
    const split = retentionCandidates(
      [cycle("old", 1, day(9)), cycle("b", 2), cycle("c", 3), cycle("d", 4)],
      2,
    );

    expect(ids(split.candidates)).toEqual(["b"]);
    expect(ids(split.alreadyArchived)).toEqual(["old"]);
  });

  it("still counts an archived cycle toward rank and cutoff", () => {
    // It is a real cycle. Dropping it from the ordering would pull an older live
    // cycle into candidacy one purge earlier than its age warrants.
    const split = retentionCandidates([cycle("a", 1), cycle("b", 2, day(9)), cycle("c", 3)], 2);

    expect(ids(split.retained)).toEqual(["c", "b"]);
    expect(ids(split.candidates)).toEqual(["a"]);
    expect(split.cutoff).toEqual(day(2));
  });

  it("breaks ties on id so the split cannot move between two renders", () => {
    // One of those renders is the confirmation page for an irreversible action.
    const a = { ...cycle("aaa", 5), createdAt: day(5) };
    const b = { ...cycle("bbb", 5), createdAt: day(5) };

    expect(ids(retentionCandidates([b, a], 1).retained)).toEqual(["aaa"]);
    expect(ids(retentionCandidates([a, b], 1).retained)).toEqual(["aaa"]);
  });

  it("refuses a threshold below 1 rather than obeying it", () => {
    // A threshold of 0 makes the running cycle a purge candidate.
    expect(() => retentionCandidates([cycle("a", 1)], 0)).toThrow(/at least 1/);
    expect(() => retentionCandidates([cycle("a", 1)], -1)).toThrow(/at least 1/);
  });

  it("refuses a non-integer threshold", () => {
    expect(() => retentionCandidates([cycle("a", 1)], 2.5)).toThrow(/whole number/);
    expect(() => retentionCandidates([cycle("a", 1)], Number.NaN)).toThrow(/whole number/);
  });

  it("handles an empty database", () => {
    const split = retentionCandidates([], 2);

    expect(split).toEqual({ retained: [], candidates: [], alreadyArchived: [], cutoff: null });
  });
});

// ---------------------------------------------------------------------------
// buildArchiveSummary
// ---------------------------------------------------------------------------

const ETHNICITY: DemographicColumn = {
  key: "grp_eth",
  label: "Ethnicity",
  members: [
    { id: "f_asian", displayName: "East Asian", groupRole: FieldGroupRole.OPTION },
    { id: "f_black", displayName: "Black", groupRole: FieldGroupRole.OPTION },
    // FREE_TEXT, so §10.7 excludes it from the count while keeping it a member.
    { id: "f_writein", displayName: "Self-describe", groupRole: FieldGroupRole.FREE_TEXT },
  ],
};

const applicant = (
  id: string,
  status: ApplicantStatus,
  stageReached: Round,
  data: Record<string, string> = {},
) => ({ id, data, status, stageReached });

const input = (overrides: Partial<ArchiveSummaryInput> = {}): ArchiveSummaryInput => ({
  name: "S26 Recruitment",
  currentStage: "COMPLETE",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  archivedAt: new Date("2026-09-01T00:00:00.000Z"),
  applicants: [
    applicant("a1", ApplicantStatus.SPARKLET, Round.SECOND_ROUND, { f_asian: "East Asian" }),
    applicant("a2", ApplicantStatus.REJECTED, Round.FIRST_ROUND, { f_black: "Black" }),
    applicant("a3", ApplicantStatus.REJECTED, Round.WRITTEN, {}),
    applicant("a4", ApplicantStatus.ACTIVE, Round.SECOND_ROUND, { f_asian: "East Asian" }),
  ],
  demographicColumns: [ETHNICITY],
  reviewers: [{ isSparklet: true }, { isSparklet: false }, { isSparklet: false }],
  writtenRubric: [{ name: "Motivation", maxPoints: 4 }],
  interviewRubric: [{ name: "Communication", maxPoints: 4 }],
  reviewCounts: {
    scores: 100,
    reviewNotes: 20,
    interviewResults: 8,
    firstRoundVotes: 40,
    passVotes: 12,
    decisions: 6,
  },
  ...overrides,
});

describe("buildArchiveSummary", () => {
  it("counts applicants by status", () => {
    const summary = buildArchiveSummary(input());

    expect(summary.applicants).toEqual({ total: 4, sparklets: 1, rejected: 2, active: 1 });
  });

  it("carries the funnel's cohort sizes, which are FR-19's stage counts", () => {
    const summary = buildArchiveSummary(input());

    expect(summary.cohortSizes).toEqual({
      ALL: 4,
      FIRST_ROUND: 3, // stageReached != WRITTEN
      SECOND_ROUND: 2,
      SPARKLET: 1,
    });
  });

  it("freezes the demographic breakdown, not just the counts", () => {
    // The entire reason the column exists. These numbers come from
    // Applicant.data, which the purge empties minutes later.
    const summary = buildArchiveSummary(input());
    const column = summary.funnel.columns.find((c) => c.key === "grp_eth");

    expect(column).toBeDefined();
    expect(column!.rows.length).toBeGreaterThan(0);

    // The §10.7 invariant has to survive the freeze: within one column and one
    // cohort, weighted values sum to the cohort size.
    const allWeighted = column!.rows.reduce((sum, row) => sum + row.cells.ALL.weighted, 0);
    expect(allWeighted).toBeCloseTo(4, 10);
  });

  it("records the rubric structure, which is the club's instrument not applicant data", () => {
    const summary = buildArchiveSummary(input());

    expect(summary.rubric.written).toEqual([{ name: "Motivation", maxPoints: 4 }]);
    expect(summary.rubric.interview).toEqual([{ name: "Communication", maxPoints: 4 }]);
  });

  it("stamps a version and the archive time", () => {
    const summary = buildArchiveSummary(input());

    expect(summary.summaryVersion).toBe(ARCHIVE_SUMMARY_VERSION);
    expect(summary.generatedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("does not carry a name, an email, or an essay anywhere in it", () => {
    // The summary outlives the purge, so anything personal in it would
    // reintroduce exactly what the purge removed. Asserted over the serialized
    // form, because a nested key is as much of a leak as a top-level one.
    const summary = buildArchiveSummary(
      input({
        applicants: [
          applicant("a1", ApplicantStatus.SPARKLET, Round.SECOND_ROUND, {
            f_asian: "East Asian",
            f_essay: "SYNTHETIC my family emigrated in 2003",
          }),
        ],
      }),
    );

    const json = JSON.stringify(summary);
    expect(json).not.toContain("emigrated");
    expect(json).not.toContain("SYNTHETIC");
    expect(json).not.toContain("@");
  });

  it("survives an instance archived before anyone applied", () => {
    // A cycle abandoned after setup is a real thing to purge, and an empty
    // funnel must not divide by zero.
    const summary = buildArchiveSummary(input({ applicants: [] }));

    expect(summary.applicants.total).toBe(0);
    expect(summary.cohortSizes.ALL).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// purgePlan
// ---------------------------------------------------------------------------

describe("purgePlan", () => {
  it("names every table §8 requires be emptied", () => {
    const tables = purgePlan().map((step) => step.table);

    for (const required of [
      "Applicant",
      "ImportRow",
      "InterviewImportRow",
      "ReviewNote",
      "InterviewNotes",
      "AuditLog",
      "RoundAccessCode",
    ]) {
      expect(tables).toContain(required);
    }
  });

  it("clears Applicant's three carriers rather than deleting the row", () => {
    // Deleting applicants would take the scores and votes with them by cascade,
    // and those are the aggregates §8 says to keep.
    const step = purgePlan().find((s) => s.table === "Applicant");

    expect(step?.action).toBe("CLEAR_COLUMNS");
    expect(step?.columns).toEqual(["email", "data", "displayName"]);
  });

  it("keeps the rest of an AuditLog row while clearing its payload", () => {
    const step = purgePlan().find((s) => s.table === "AuditLog");

    expect(step?.action).toBe("CLEAR_COLUMNS");
    expect(step?.columns).toEqual(["previousValue"]);
  });

  it("does not touch the tables holding the retained aggregates", () => {
    // The other half of the requirement, and the easier one to break: a purge
    // that took Score or Decision with it would leave a summary describing
    // numbers nothing could corroborate.
    const tables = purgePlan().map((step) => step.table);

    for (const kept of [
      "Score",
      "Decision",
      "FirstRoundVote",
      "PassVote",
      "Assignment",
      "Pass",
      "PassApplicant",
      "InterviewResult",
      "Reviewer",
      "Field",
      "FieldGroup",
    ]) {
      expect(tables).not.toContain(kept);
    }
  });

  it("gives a reason for every step", () => {
    // The list is the documentation. A step someone cannot justify is a step
    // that should not be destroying data.
    for (const step of purgePlan()) {
      expect(step.why.length).toBeGreaterThan(20);
    }
  });
});
