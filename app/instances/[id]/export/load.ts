import "server-only";

// The queries behind FR-20's three CSVs. Everything between the query and the
// file lives in `lib/export-csv.ts`, per CLAUDE.md's Phase 5 lesson — a page (or
// a route handler) that reshapes query results before rendering them puts the
// reshaping where nothing can test it. These functions return the pure builders'
// input shapes and do no arithmetic of their own.

import { ApplicantStatus, Round } from "@/generated/prisma/enums";
import type {
  CsvApplicantRow,
  CsvDecisionRow,
  CsvFinalClassRow,
  CsvRubricCategory,
} from "@/lib/export-csv";
import { prisma } from "@/lib/prisma";

/// "All applicants with scores."
///
/// Written-round assignments only: `Score` hangs off `Assignment`, and the
/// written round is the only one that produces them. Returned in
/// `sourceRowIndex` order — the file is read alongside the source CSV, and
/// decision 11 makes that index point at a record in it.
///
/// **Returned rows include every assignment's scores, complete or not**, and the
/// builder is what drops the incomplete ones. Filtering here would move a rule
/// with a stated rationale into a query where no test can see it.
export async function loadApplicantsCsv(instanceId: string): Promise<{
  applicants: CsvApplicantRow[];
  categories: CsvRubricCategory[];
}> {
  const [applicants, categories] = await Promise.all([
    prisma.applicant.findMany({
      where: { instanceId },
      orderBy: { sourceRowIndex: "asc" },
      select: {
        sourceRowIndex: true,
        displayName: true,
        email: true,
        status: true,
        stageReached: true,
        assignments: {
          where: { round: Round.WRITTEN },
          select: { scores: { select: { rubricCategoryId: true, points: true } } },
        },
      },
    }),
    prisma.rubricCategory.findMany({
      where: { instanceId },
      orderBy: { ordinal: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return {
    categories,
    applicants: applicants.map((applicant) => ({
      sourceRowIndex: applicant.sourceRowIndex,
      displayName: applicant.displayName,
      email: applicant.email,
      status: applicant.status,
      stageReached: applicant.stageReached,
      reviews: applicant.assignments.map((assignment) => ({
        points: Object.fromEntries(
          assignment.scores.map((score) => [score.rubricCategoryId, score.points]),
        ),
      })),
    })),
  };
}

/// "Decisions by stage."
///
/// Ordered by stage in cycle order and then by applicant, so the file reads the
/// way the cycle ran rather than the way Postgres returned it. `Round`'s enum
/// order is that order, and Prisma sorts an enum column by its declared order.
export async function loadDecisionsCsv(instanceId: string): Promise<CsvDecisionRow[]> {
  const decisions = await prisma.decision.findMany({
    where: { applicant: { instanceId } },
    orderBy: [{ stage: "asc" }, { applicant: { sourceRowIndex: "asc" } }],
    select: {
      stage: true,
      outcome: true,
      actor: true,
      decidedAt: true,
      applicant: { select: { sourceRowIndex: true, displayName: true, email: true } },
    },
  });

  return decisions.map((decision) => ({
    sourceRowIndex: decision.applicant.sourceRowIndex,
    displayName: decision.applicant.displayName,
    email: decision.applicant.email,
    stage: decision.stage,
    outcome: decision.outcome,
    actor: decision.actor,
    decidedAt: decision.decidedAt,
  }));
}

/// "Final class with emails."
///
/// `status = SPARKLET`, which is what FR-19's New Sparklet group renders and
/// what decision 69's `Decision` rows record the making of. Read from `status`
/// rather than from the pass rows deliberately: an applicant an admin resolves
/// by hand after the round closes is a Sparklet too, and FR-17 is explicit that
/// the pass row records what happened *in that pass* rather than what the
/// applicant is now.
export async function loadFinalClassCsv(instanceId: string): Promise<CsvFinalClassRow[]> {
  return prisma.applicant.findMany({
    where: { instanceId, status: ApplicantStatus.SPARKLET },
    orderBy: { sourceRowIndex: "asc" },
    select: { sourceRowIndex: true, displayName: true, email: true },
  });
}
