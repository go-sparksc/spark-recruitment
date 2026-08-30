// §8's archive-and-purge, decided. PRD decisions 94 and 95.
//
// Pure — no database, no Prisma client, no `server-only`. The rule CLAUDE.md
// puts on lib/assignment.ts, lib/passes.ts and lib/export.ts applies here for
// the same reason: this module decides which cycles are old enough to purge and
// what "aggregate statistics" survives one, and both have to be decidable
// without a database in front of them. lib/archive-io.ts is the half that
// touches Prisma.
//
// §8 gives the requirement in one sentence — "keeps aggregate statistics and
// deletes essays, emails, and demographics for cycles older than a configurable
// threshold" — and every operative word in it needed a definition. Decision 95
// is that definition; this file is its implementation.

import { ApplicantStatus } from "@/generated/prisma/enums";
import type { DemographicColumn } from "@/lib/demographics";
import { buildFunnel, FUNNEL_COHORTS, type Funnel, type FunnelApplicant } from "@/lib/funnel";

// ---------------------------------------------------------------------------
// Which cycles are candidates
// ---------------------------------------------------------------------------

export interface RetainableInstance {
  id: string;
  name: string;
  createdAt: Date;
  /// Non-null once purged. Such an instance is never a candidate again.
  archivedAt: Date | null;
}

export interface RetentionSplit<T extends RetainableInstance> {
  /// The newest `retentionCycles` cycles. Never purged.
  retained: T[];
  /// Older than the threshold and not yet purged. These are offered.
  candidates: T[];
  /// Older than the threshold and already purged. Shown as done, not offered.
  alreadyArchived: T[];
  /// `createdAt` of the oldest retained cycle, or null when nothing is old
  /// enough to purge. Orphaned `AuditLog` rows older than this age out with the
  /// cycles, per §8's requirement that the instance-deletion records not
  /// accumulate forever.
  cutoff: Date | null;
}

/// Split cycles into what is kept and what may be purged.
///
/// Ordered by `createdAt` descending; the newest `retentionCycles` are retained
/// and everything past that rank is old enough. Ties are broken by `id` so the
/// split is deterministic — two cycles created in the same second must not swap
/// places between two renders of the same screen, one of which is the
/// confirmation page for an irreversible action.
///
/// **An already-archived instance is never a candidate.** It still occupies its
/// rank and still counts toward the cutoff, because it is a real cycle and
/// dropping it from the ordering would pull an older live cycle into candidacy a
/// purge earlier than its age warrants. But it comes back in `alreadyArchived`,
/// because rank is computed on `createdAt` and a purged cycle would otherwise
/// re-enter the candidate list the moment enough newer cycles exist — and a
/// second purge would recompute the summary against the data the first one
/// emptied, overwriting correct numbers with zeros. Silently, since every row it
/// read would be legitimately present and legitimately empty.
///
/// This is one of two defences; the other is in lib/archive-io.ts, which
/// re-reads `archivedAt` inside its own transaction. A UI affordance is not a
/// safety mechanism, and the irreversible action does not depend on one.
export function retentionCandidates<T extends RetainableInstance>(
  instances: readonly T[],
  retentionCycles: number,
): RetentionSplit<T> {
  if (!Number.isInteger(retentionCycles) || retentionCycles < 1) {
    // Refused rather than obeyed. A threshold of 0 makes every cycle including
    // the current one a purge candidate, which turns a retention control into a
    // delete-everything button — see decision 94 on why this is not editable
    // from inside the app either.
    throw new Error(
      `RETENTION_CYCLES must be a whole number of at least 1; got ${retentionCycles}. ` +
        `A threshold below 1 would make the running cycle a purge candidate.`,
    );
  }

  const ordered = [...instances].sort((a, b) => {
    const byDate = b.createdAt.getTime() - a.createdAt.getTime();
    return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
  });

  const retained = ordered.slice(0, retentionCycles);
  const older = ordered.slice(retentionCycles);

  return {
    retained,
    candidates: older.filter((instance) => instance.archivedAt === null),
    alreadyArchived: older.filter((instance) => instance.archivedAt !== null),
    cutoff: older.length === 0 ? null : (retained[retained.length - 1]?.createdAt ?? null),
  };
}

// ---------------------------------------------------------------------------
// What survives
// ---------------------------------------------------------------------------

/// Bumped when the shape below changes in a way a reader of an older summary
/// could not interpret. Adding a key is not a version change; moving or
/// re-meaning one is.
export const ARCHIVE_SUMMARY_VERSION = 1;

export interface ArchiveSummary {
  summaryVersion: number;
  /// When the purge ran. Duplicated from `Instance.archivedAt` so the JSON is
  /// self-describing if it is ever read outside the row it lives on.
  generatedAt: string;
  instance: {
    name: string;
    /// The stage the cycle had reached when it was purged. A cycle archived
    /// mid-flight is a real thing and the summary should not imply otherwise.
    currentStage: string;
    createdAt: string;
  };
  /// The funnel's four cohorts, which are also FR-19's stage counts.
  cohortSizes: Record<string, number>;
  applicants: {
    total: number;
    sparklets: number;
    rejected: number;
    /// Still ACTIVE at the purge. In a COMPLETE cycle these are FR-19's
    /// Unresolved group; in one archived earlier they are simply in flight.
    active: number;
  };
  reviewers: {
    total: number;
    sparklets: number;
  };
  rubric: {
    /// Category names and maximums. Structure, not applicant data — this is the
    /// instrument the club used, and it is worth keeping so a future cycle can
    /// see what a past score was out of.
    written: { name: string; maxPoints: number }[];
    interview: { name: string; maxPoints: number }[];
  };
  reviewCounts: {
    scores: number;
    reviewNotes: number;
    interviewResults: number;
    firstRoundVotes: number;
    passVotes: number;
    decisions: number;
  };
  /// FR-19's demographic breakdown, rendered. **The reason this column exists**:
  /// every number in it comes from `Applicant.data`, which the purge empties, so
  /// computing it afterwards would return zeros for a cycle that had real ones.
  funnel: Funnel;
}

export interface ArchiveSummaryInput {
  name: string;
  currentStage: string;
  createdAt: Date;
  archivedAt: Date;
  /// `FunnelApplicant` already carries `status` and `stageReached`, which is why
  /// this takes that type rather than a wider one: the cohort counts and the
  /// status counts below must be computed over exactly the same population.
  applicants: readonly FunnelApplicant[];
  demographicColumns: readonly DemographicColumn[];
  reviewers: readonly { isSparklet: boolean }[];
  writtenRubric: readonly { name: string; maxPoints: number }[];
  interviewRubric: readonly { name: string; maxPoints: number }[];
  reviewCounts: ArchiveSummary["reviewCounts"];
}

/// Freeze everything §8 says to retain.
///
/// **Reuses `buildFunnel` rather than recomputing the breakdown.** §10.7 requires
/// the checked predicate and the 1/n weighting live in exactly one place, because
/// every demographic number in FR-11 and FR-19 rests on them; a summary that
/// counted demographics its own way would be the second copy that rule exists to
/// prevent, and it would be the copy nobody could check afterwards, since the
/// data it was computed from is gone.
export function buildArchiveSummary(input: ArchiveSummaryInput): ArchiveSummary {
  const funnel = buildFunnel(input.applicants, input.demographicColumns);

  const cohortSizes: Record<string, number> = {};
  for (const { key } of FUNNEL_COHORTS) cohortSizes[key] = funnel.cohortSizes[key];

  return {
    summaryVersion: ARCHIVE_SUMMARY_VERSION,
    generatedAt: input.archivedAt.toISOString(),
    instance: {
      name: input.name,
      currentStage: input.currentStage,
      createdAt: input.createdAt.toISOString(),
    },
    cohortSizes,
    applicants: {
      total: input.applicants.length,
      sparklets: input.applicants.filter((a) => a.status === ApplicantStatus.SPARKLET).length,
      rejected: input.applicants.filter((a) => a.status === ApplicantStatus.REJECTED).length,
      active: input.applicants.filter((a) => a.status === ApplicantStatus.ACTIVE).length,
    },
    reviewers: {
      total: input.reviewers.length,
      sparklets: input.reviewers.filter((r) => r.isSparklet).length,
    },
    rubric: {
      written: input.writtenRubric.map((c) => ({ name: c.name, maxPoints: c.maxPoints })),
      interview: input.interviewRubric.map((c) => ({ name: c.name, maxPoints: c.maxPoints })),
    },
    reviewCounts: input.reviewCounts,
    funnel,
  };
}

// ---------------------------------------------------------------------------
// What is destroyed
// ---------------------------------------------------------------------------

/// One table's fate under a purge, as data rather than as prose buried inside a
/// transaction — so `prisma/checks/archive-purge.ts` can assert against the same
/// list the purge executes rather than a second description of it.
export interface PurgeStep {
  table: string;
  action: "DELETE" | "CLEAR_COLUMNS";
  /// For CLEAR_COLUMNS, which columns are emptied.
  columns?: string[];
  why: string;
}

/// Everything §8's "deletes essays, emails, and demographics" resolves to.
///
/// The list is exhaustive by intent: a table not named here keeps its rows, and
/// the reasoning for each omission is in decision 95. The short form is that
/// scores, votes, decisions, assignments and passes are numbers and outcomes —
/// they are the substrate the retained aggregates rest on — and `Field`,
/// `FieldGroup` and `Reviewer` hold the club's own form and the club's own
/// members rather than an applicant's answers.
export function purgePlan(): PurgeStep[] {
  return [
    {
      table: "Applicant",
      action: "CLEAR_COLUMNS",
      columns: ["email", "data", "displayName"],
      why:
        "email and data are §8's named categories outright — data holds every essay and " +
        "every demographic answer. displayName becomes 'Applicant <sourceRowIndex>', the " +
        "anonymous label written reviewers already see, so a non-null column stays " +
        "meaningful instead of holding a placeholder.",
    },
    {
      table: "ImportRow",
      action: "DELETE",
      why:
        "cells holds the verbatim CSV — every essay, address and demographic answer in " +
        "its rawest form, and the copy most easily forgotten because nothing reads it " +
        "after commit.",
    },
    {
      table: "InterviewImportRow",
      action: "DELETE",
      why: "The same verbatim-cells problem, for FR-12's two interview sheets.",
    },
    {
      table: "ReviewNote",
      action: "DELETE",
      why: "Free text written about an applicant, which is an essay by another name.",
    },
    {
      table: "InterviewNotes",
      action: "DELETE",
      why: "As ReviewNote, plus interviewerName.",
    },
    {
      table: "RoundAccessCode",
      action: "DELETE",
      why:
        "Not applicant data — a live credential with no reader. signInReviewer is the " +
        "only path that checks codeHash, and an archived cycle has nothing for a " +
        "reviewer to do. Rows rather than the column because codeHash is non-null and " +
        "making it nullable would describe a state only the purge produces.",
    },
    {
      table: "AuditLog",
      action: "CLEAR_COLUMNS",
      columns: ["previousValue"],
      why:
        "§8 says in as many words that these payloads can carry applicant data. The rest " +
        "of the row — who, what, when — is the record of an override and survives.",
    },
  ];
}
