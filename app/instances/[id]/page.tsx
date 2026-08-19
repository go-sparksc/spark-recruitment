import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardContent } from "@/components/ui/card";
import { AssignmentStatus, InstanceStage, Round } from "@/generated/prisma/enums";
import { planShape } from "@/lib/assignment";
import { requireInstance } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Instance — Spark SC Recruitment" };

const STAGE_LABEL: Record<InstanceStage, string> = {
  [InstanceStage.WRITTEN]: "Written round",
  [InstanceStage.FIRST_ROUND]: "First round",
  [InstanceStage.SECOND_ROUND]: "Second round",
  [InstanceStage.COMPLETE]: "Complete",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface HubRow {
  href: string;
  title: string;
  /// What this surface currently holds, read from the database. The point of
  /// the row: a bare link says where you can go, and this says where the cycle
  /// actually is. See decision 36.
  state: string;
  /// Set where the surface exists but there is nothing useful in it yet, so the
  /// hub says so instead of sending an admin to a page of zeroes.
  waiting?: boolean;
}

/// FR-1's second level and decision 36's resolution.
///
/// This page used to be an unconditional `redirect()` to `/mapping`, which is
/// how `/reviewers` and `/assignments` ended up with no inbound link from
/// anywhere in the application — the only way into either was typing the URL.
/// Two whole FR surfaces, built and working and unreachable.
export default async function InstancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireInstance(id, `/instances/${id}`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      currentStage: true,
      importCommittedAt: true,
      _count: {
        select: {
          applicants: true,
          fields: true,
          fieldGroups: true,
          importRows: true,
          reviewers: true,
          rubricCategories: true,
        },
      },
    },
  });

  if (!instance) notFound();

  const counts = instance._count;
  const committed = instance.importCommittedAt !== null;

  const [scoreCount, sparkletCount, writtenReviewerCount, writtenCode, activeAssignments] =
    await Promise.all([
      // Score has no instanceId of its own; it hangs off Assignment. Same read
      // the rubric page does, and it is what FR-4's lock turns on.
      prisma.score.count({ where: { assignment: { instanceId: id } } }),
      prisma.reviewer.count({ where: { instanceId: id, isSparklet: true } }),
      prisma.reviewer.count({ where: { instanceId: id, rounds: { has: Round.WRITTEN } } }),
      prisma.roundAccessCode.findUnique({
        where: { instanceId_round: { instanceId: id, round: Round.WRITTEN } },
        // Never codeHash. §8 puts access codes under the same rule as passwords,
        // and a hash that is never loaded cannot be rendered.
        select: { id: true },
      }),
      prisma.assignment.count({
        where: { instanceId: id, round: Round.WRITTEN, status: AssignmentStatus.ACTIVE },
      }),
    ]);

  // "Applicants short one reviewer" is a count over a relation, which Prisma
  // cannot filter on directly. Same two-query shape the assignments page uses:
  // the ids, and the active counts. Applicants with no assignment at all never
  // appear in the groupBy, so they are added back from the id list.
  //
  // Skipped entirely where nothing has been generated — the answer would be
  // "every applicant", which is true and useless.
  let shortCount = 0;
  if (activeAssignments > 0) {
    const { target } = planShape(counts.applicants, writtenReviewerCount);
    const [applicantIds, grouped] = await Promise.all([
      prisma.applicant.findMany({ where: { instanceId: id }, select: { id: true } }),
      prisma.assignment.groupBy({
        by: ["applicantId"],
        where: { instanceId: id, round: Round.WRITTEN, status: AssignmentStatus.ACTIVE },
        _count: { _all: true },
      }),
    ]);
    const byApplicant = new Map(grouped.map((row) => [row.applicantId, row._count._all]));
    shortCount = applicantIds.filter((a) => (byApplicant.get(a.id) ?? 0) < target).length;
  }

  const rows: HubRow[] = [
    {
      href: `/instances/${id}/mapping`,
      title: "Columns and visibility",
      state:
        counts.fields === 0
          ? "no columns yet"
          : [
              plural(counts.fields, "column"),
              counts.fieldGroups > 0 ? plural(counts.fieldGroups, "group") : null,
              // Not "committed" alone. Decision 34 keeps inclusion and the
              // per-round toggles editable here for the whole cycle, and a row
              // that says only "committed" describes the surface as more frozen
              // than it is — which is the reading that made F-03 invisible.
              committed ? "visibility still editable" : `${plural(counts.importRows, "row")} staged`,
            ]
              .filter((part) => part !== null)
              .join(" · "),
    },
    {
      href: `/instances/${id}/rubric`,
      title: "Rubric",
      state:
        counts.rubricCategories === 0
          ? "not set up yet"
          : `${plural(counts.rubricCategories, "category", "categories")} · ${
              scoreCount > 0 ? `locked, ${plural(scoreCount, "score")} submitted` : "unlocked"
            }`,
      waiting: counts.rubricCategories === 0,
    },
    {
      href: `/instances/${id}/reviewers`,
      title: "Reviewers",
      state:
        counts.reviewers === 0
          ? "none yet"
          : [
              plural(counts.reviewers, "reviewer"),
              `${sparkletCount} Sparklet${sparkletCount === 1 ? "" : "s"}`,
              // Decision 31 put the access-code card on this page, and an
              // instance without a code has an unreachable reviewer dashboard.
              // Worth stating on the hub rather than only behind the link.
              writtenCode ? "written code set" : "written code not set",
            ].join(" · "),
      waiting: counts.reviewers === 0,
    },
    {
      href: `/instances/${id}/assignments`,
      title: "Assignments",
      state:
        counts.applicants === 0
          ? "no applicants yet"
          : activeAssignments === 0
            ? "not generated yet"
            : `${plural(activeAssignments, "assignment")} · ${
                shortCount === 0
                  ? "none short"
                  : `${shortCount} applicant${shortCount === 1 ? "" : "s"} short one`
              }`,
      waiting: counts.applicants === 0 || activeAssignments === 0,
    },
    {
      href: `/instances/${id}/results`,
      title: "Written results",
      state:
        instance.currentStage !== InstanceStage.WRITTEN
          ? "written round finalized"
          : scoreCount === 0
            ? "no scores yet"
            : `${plural(scoreCount, "score")} recorded`,
      // A page of em-dashes is not worth a click. Scores arrive one reviewer at
      // a time, so this stops being "waiting" as soon as anybody has graded.
      waiting: scoreCount === 0,
    },
    {
      href: `/instances/${id}/settings`,
      title: "Settings",
      state: "instance password and deletion",
    },
  ];

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← Instances
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{instance.name}</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {STAGE_LABEL[instance.currentStage]}
        {" · "}
        {committed
          ? `${plural(counts.applicants, "applicant")} imported`
          : "draft — the CSV has not been committed"}
      </p>

      <Card className="mt-8">
        <CardContent className="divide-y p-0">
          {rows.map((row) => (
            <Link
              key={row.href}
              href={row.href}
              className="hover:bg-muted/50 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-6 py-4 transition-colors"
            >
              <span className="font-medium">{row.title}</span>
              <span
                className={
                  row.waiting
                    ? "text-muted-foreground/70 text-sm"
                    : "text-muted-foreground text-sm tabular-nums"
                }
              >
                {row.state}
              </span>
            </Link>
          ))}
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-6 text-xs">
        Roughly the order a cycle uses them. Later rounds add their own surfaces here.
      </p>
    </main>
  );
}
