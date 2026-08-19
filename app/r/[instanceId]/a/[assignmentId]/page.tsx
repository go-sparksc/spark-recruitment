import { notFound } from "next/navigation";

import { ReturnControl } from "../../return-control";
import { GuardedLink } from "./guarded-link";
import { ScoreCard, type RubricRow } from "./score-card";
import { AssignmentStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";
// completionOf is no longer read here: the card counts scored categories from
// its own queue so the summary moves as the reviewer taps, rather than being
// frozen at whatever the server rendered. The list page still uses it, which is
// where the count has to agree with the database.
import { buildApplicantView } from "@/lib/review";

export const metadata = { title: "Review an applicant — Spark SC" };

/// FR-9 bullet 2: "An applicant detail view: anonymous label (e.g. 'Applicant
/// 47'), all RESPONSE fields, rubric always visible alongside. No name, per §6."
///
/// The §6 projection happens in `buildApplicantView`, which is tested against
/// plain objects in lib/review.test.ts. A hidden field is absent from the object
/// this page renders, so it is absent from the RSC payload too — §6 requires
/// that a request for a hidden field return no data, not that the client hide it.
export default async function ApplicantDetailPage({
  params,
}: {
  params: Promise<{ instanceId: string; assignmentId: string }>;
}) {
  const { instanceId, assignmentId } = await params;
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  // An assignment id in a URL is an untrusted reference until it has been shown
  // to belong to this reviewer, in this round, and to still be theirs. Scoping
  // the lookup rather than fetching and then checking means a mismatched id is a
  // 404 by construction.
  const assignment = await prisma.assignment.findFirst({
    where: {
      id: assignmentId,
      instanceId,
      round: session.rd,
      reviewerId: reviewer.id,
      status: AssignmentStatus.ACTIVE,
    },
    select: {
      id: true,
      applicant: {
        select: {
          sourceRowIndex: true,
          // Loaded because buildApplicantView takes them and decides. For a
          // written reviewer it returns a shape that has no field for either,
          // so neither can reach the payload — see the union in lib/review.ts.
          displayName: true,
          email: true,
          data: true,
        },
      },
      scores: { select: { rubricCategoryId: true, points: true } },
      // FR-9 clause 3b. One row per assignment, so this is the reviewer's own
      // note and never another reviewer's — §6 keeps those hidden from each
      // other, and the relation is what enforces it rather than a filter.
      note: { select: { body: true } },
    },
  });

  if (!assignment) notFound();

  const [fields, groups, categories, siblings] = await Promise.all([
    prisma.field.findMany({
      where: { instanceId },
      orderBy: { ordinal: "asc" },
      select: {
        id: true,
        displayName: true,
        ordinal: true,
        category: true,
        isIncluded: true,
        groupId: true,
        groupRole: true,
        visibleToWrittenReviewer: true,
        visibleToFirstRoundReviewer: true,
      },
    }),
    prisma.fieldGroup.findMany({
      where: { instanceId },
      select: {
        id: true,
        displayName: true,
        category: true,
        isIncluded: true,
        visibleToWrittenReviewer: true,
        visibleToFirstRoundReviewer: true,
      },
    }),
    prisma.rubricCategory.findMany({
      where: { instanceId },
      orderBy: { ordinal: "asc" },
      select: { id: true, name: true, minPoints: true, maxPoints: true, description: true },
    }),
    // Prev/next, so a reviewer working through fifteen never returns to the list.
    prisma.assignment.findMany({
      where: {
        instanceId,
        round: session.rd,
        reviewerId: reviewer.id,
        status: AssignmentStatus.ACTIVE,
      },
      orderBy: { applicant: { sourceRowIndex: "asc" } },
      select: { id: true },
    }),
  ]);

  const view = buildApplicantView(
    {
      sourceRowIndex: assignment.applicant.sourceRowIndex,
      displayName: assignment.applicant.displayName,
      email: assignment.applicant.email,
      data: (assignment.applicant.data ?? {}) as Record<string, unknown>,
    },
    fields,
    groups,
    "WRITTEN_REVIEWER",
  );

  const pointsByCategory = new Map(
    assignment.scores.map((score) => [score.rubricCategoryId, score.points]),
  );

  const rubric: RubricRow[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    minPoints: category.minPoints,
    maxPoints: category.maxPoints,
    description: category.description,
    points: pointsByCategory.get(category.id) ?? null,
  }));

  const position = siblings.findIndex((sibling) => sibling.id === assignment.id);
  const previous = position > 0 ? siblings[position - 1] : null;
  const next = position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : null;

  return (
    // No large bottom padding: the score card is sticky rather than fixed, so it
    // occupies its own space at the end of the flow and covers nothing once the
    // page is scrolled to the bottom.
    <main className="mx-auto w-full max-w-5xl px-4 pt-5 pb-10">
      <div className="flex items-center justify-between gap-3">
        <GuardedLink
          href={`/r/${instanceId}/list`}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← All applicants
        </GuardedLink>
        {position >= 0 ? (
          <span className="text-muted-foreground text-sm tabular-nums">
            {position + 1} of {siblings.length}
          </span>
        ) : null}
      </div>

      <h1 className="mt-2 text-xl font-semibold tracking-tight">{view.label}</h1>

      {/* F-15. `lg:gap-8` separates the two columns at lg and does nothing
          below it, where they simply stack — so on a phone the return control
          sat flush against the score card's top border with no space at all.
          space-y-6 supplies that gap below lg and lg:space-y-0 hands the job
          back to the grid above it. */}
      <div className="mt-5 space-y-6 lg:grid lg:grid-cols-[1fr_20rem] lg:items-start lg:gap-8 lg:space-y-0">
        <article className="space-y-6">
          {view.fields.length === 0 ? (
            <p className="text-muted-foreground rounded-md border p-4 text-sm">
              This applicant has no written responses to show. That usually means the import
              excluded them — tell an admin rather than scoring a blank profile.
            </p>
          ) : (
            view.fields.map((field) => (
              <section key={field.fieldId} className="space-y-1.5">
                {/* F-18. Was `text-sm font-medium`, which made the question
                    both lighter and *smaller* than the answer under it — so a
                    screen of essays read as one undifferentiated column. Same
                    size as the answer now, separated by weight alone: enough to
                    find the question when skimming, without a 200-character
                    essay prompt shouting over the response a reviewer is
                    actually there to read. */}
                <h2 className="text-[0.95rem] font-semibold">
                  {field.groupDisplayName ? `${field.groupDisplayName} — ` : ""}
                  {field.displayName}
                </h2>
                {/* whitespace-pre-wrap: essay answers carry the paragraph breaks
                    the applicant typed, and collapsing them turns five
                    paragraphs into a wall. */}
                <p className="text-[0.95rem] leading-relaxed whitespace-pre-wrap">{field.value}</p>
              </section>
            ))
          )}

          <nav className="flex items-center justify-between gap-3 pt-2">
            {previous ? (
              <GuardedLink
                href={`/r/${instanceId}/a/${previous.id}`}
                className="hover:bg-muted rounded-md border px-3 py-2 text-sm"
              >
                ← Previous
              </GuardedLink>
            ) : (
              <span />
            )}
            {next ? (
              <GuardedLink
                href={`/r/${instanceId}/a/${next.id}`}
                className="hover:bg-muted rounded-md border px-3 py-2 text-sm"
              >
                Next →
              </GuardedLink>
            ) : (
              <span />
            )}
          </nav>

          {/* Clause 5a's other half. Outside the score card, whose forms this
              one cannot nest inside, and deliberately NOT wrapped in
              GuardedLink: per decision 38 a return does not wait for a save it
              has just guaranteed will be refused. */}
          <ReturnControl
            instanceId={instanceId}
            assignmentId={assignment.id}
            label={view.label}
            className="rounded-md border"
          />
        </article>

        <ScoreCard
          instanceId={instanceId}
          assignmentId={assignment.id}
          rubric={rubric}
          noteBody={assignment.note?.body ?? ""}
        />
      </div>
    </main>
  );
}
