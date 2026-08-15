"use client";

import { useState, useTransition } from "react";

import {
  assignReviewer,
  generate,
  swapReviewer,
  unassignReviewer,
  type ActionState,
  type GenerateResult,
  type PrecheckView,
} from "./actions";
import { Button } from "@/components/ui/button";
import { Round } from "@/generated/prisma/enums";

export interface ApplicantRow {
  id: string;
  /// "Applicant 47" — the anonymous label a written reviewer sees.
  label: string;
  /// The real name. Admin-only by §6, and the only way to find one person.
  name: string;
  reviewers: { assignmentId: string; id: string; name: string; isSparklet: boolean; origin: string }[];
  /// Reviewers who handed this applicant back, per PRD decision 39. Read-only:
  /// the row records a recusal that generation must keep honouring.
  returned: { assignmentId: string; name: string; reason: string; note: string | null }[];
}

export interface PagingView {
  basePath: string;
  query: string;
  shortOnly: boolean;
  page: number;
  pageCount: number;
  /// Applicants matching the current search and filter.
  matchCount: number;
  /// Applicants in the instance, so the header can say what is being hidden.
  totalCount: number;
}

export interface ReviewerOption {
  id: string;
  name: string;
  isSparklet: boolean;
  load: number;
}

/// FR-7's generate flow, as three steps rather than one button.
///
/// The precheck renders before anything is generated; a failure offers two
/// actions rather than prose; and a regeneration over existing overrides warns
/// with both counts before it runs. Collapsing any of those into the button
/// would make the decision FR-7 gives the admin invisible.
export function GeneratePanel({
  instanceId,
  round,
  precheck,
}: {
  instanceId: string;
  round: Round;
  precheck: PrecheckView;
}) {
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [confirming, setConfirming] = useState<"RELAXED" | "REGENERATE" | null>(null);
  const [pending, start] = useTransition();

  const { report } = precheck;
  const preservedCount = precheck.manualCount + precheck.claimedCount;
  const hasExisting = precheck.autoCount + preservedCount > 0;

  const run = (options: { relaxSparkletLoad?: boolean; discardPreserved?: boolean }) =>
    start(async () => {
      setResult(await generate(instanceId, round, options));
      setConfirming(null);
    });

  return (
    <section className="space-y-4">
      <div className="space-y-2 rounded-md border p-4">
        <h2 className="text-sm font-medium">Before generating</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <Stat label="Applicants" value={precheck.applicantCount} />
          <Stat
            label="Reviewers this round"
            value={`${precheck.reviewerCount} (${precheck.sparkletCount} Sparklet${precheck.sparkletCount === 1 ? "" : "s"})`}
          />
          <Stat label="Reviewers each" value={report.target} />
          <Stat label="Slots in the full grid" value={report.totalSlots} />
          <Stat label="Held open as the pool" value={report.poolSize} />
          <Stat label="To be assigned" value={report.assignedSlots} />
          <Stat label="Applicants at full strength" value={report.fullApplicantCount} />
          <Stat label="Applicants one short" value={report.shortApplicantCount} />
          <Stat label="Load per reviewer" value={`${report.loadFloor}–${report.loadCeiling}`} />
        </dl>
        <p className="text-muted-foreground text-sm">
          The pool is a conflict-of-interest buffer. Those {report.shortApplicantCount} applicants
          each start with one reviewer fewer, and any reviewer can claim an open slot.
        </p>
      </div>

      {!report.feasible ? (
        <div className="border-destructive/40 space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">This roster cannot be assigned evenly.</p>
          <p className="text-sm">{report.message}</p>

          {confirming === "RELAXED" ? (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm">
                Sparklets will take at most one applicant each. Your{" "}
                {precheck.reviewerCount - precheck.sparkletCount} non-Sparklet reviewers would carry
                about {report.relaxedNonSparkletAverage?.toFixed(1)} assignments each, capped at{" "}
                {report.relaxedNonSparkletCeiling} — against the {report.loadCeiling} an even split
                would give.
              </p>
              <p className="text-muted-foreground text-sm">
                The one-Sparklet-per-applicant rule still holds. It is the load that gives, not the
                rule.
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled={pending} onClick={() => run({ relaxSparkletLoad: true })}>
                  {pending ? "Generating…" : `Generate with a cap of ${report.relaxedNonSparkletCeiling}`}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <a
                href={`/instances/${instanceId}/reviewers?round=${round}`}
                className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
              >
                Add non-Sparklet reviewers
              </a>
              {report.relaxedNonSparkletCeiling !== null ? (
                <Button size="sm" variant="outline" onClick={() => setConfirming("RELAXED")}>
                  Allow uneven Sparklet load
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : confirming === "REGENERATE" ? (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">
            This round already has {precheck.autoCount + preservedCount} assignments.
          </p>
          <p className="text-sm">
            Regenerating replaces the {precheck.autoCount} generated ones.
            {preservedCount > 0
              ? ` ${precheck.manualCount} manual override${precheck.manualCount === 1 ? "" : "s"} and ${precheck.claimedCount} claimed slot${precheck.claimedCount === 1 ? "" : "s"} are kept by default, and count against their reviewers' load.`
              : " There are no manual overrides or claimed slots to keep."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={() => run({})}>
              {pending ? "Generating…" : preservedCount > 0 ? "Regenerate, keeping them" : "Regenerate"}
            </Button>
            {preservedCount > 0 ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => run({ discardPreserved: true })}
              >
                Discard them and regenerate
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          disabled={pending}
          onClick={() => (hasExisting ? setConfirming("REGENERATE") : run({}))}
        >
          {pending ? "Generating…" : hasExisting ? "Regenerate assignments" : "Generate assignments"}
        </Button>
      )}

      {result?.message ? <p className="text-sm text-emerald-600">{result.message}</p> : null}

      {/* Violations the preserved set already carries, shown on load rather than
          only after a generate. An admin landing on a page whose overrides put
          two Sparklets on one applicant needs to know before deciding what to
          do, not as a consequence of pressing a button. */}
      {result === null && report.preexistingViolations.length > 0 ? (
        <ViolationList violations={report.preexistingViolations} />
      ) : null}

      {result?.violations?.length ? <ViolationList violations={result.violations} /> : null}
    </section>
  );
}

function ViolationList({ violations }: { violations: { detail: string }[] }) {
  return (
    <div className="border-destructive/40 space-y-2 rounded-md border p-4">
      <p className="text-sm font-medium">
        {violations.length} existing assignment{violations.length === 1 ? "" : "s"} already{" "}
        {violations.length === 1 ? "breaks" : "break"} a rule.
      </p>
      <ul className="space-y-1 text-sm">
        {violations.map((v, i) => (
          <li key={i}>· {v.detail}</li>
        ))}
      </ul>
      <p className="text-muted-foreground text-sm">
        Left exactly as they are. Generation reports these rather than fixing them by deleting an
        override somebody made on purpose.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

/// FR-8, all three verbs: assign, unassign, and swap.
///
/// Swap is one server action rather than an unassign followed by an assign from
/// here — two round trips can half-fail and leave the applicant short with
/// nothing in the log saying a swap was meant.
export function OverridePanel({
  instanceId,
  round,
  applicants,
  reviewers,
  paging,
}: {
  instanceId: string;
  round: Round;
  applicants: ApplicantRow[];
  reviewers: ReviewerOption[];
  paging: PagingView;
}) {
  const [state, setState] = useState<ActionState>({});
  /// Which picker is open: assigning to an applicant, or swapping out one of its
  /// reviewers. Null when none is.
  const [picker, setPicker] = useState<{ applicantId: string; swapOut?: string } | null>(null);
  const [find, setFind] = useState("");
  const [pending, start] = useTransition();

  const act = (fn: () => Promise<ActionState>) =>
    start(async () => {
      setState(await fn());
      setPicker(null);
      setFind("");
    });

  const href = (over: Partial<{ page: number; q: string; only: string }>) => {
    const p = new URLSearchParams();
    const q = over.q ?? paging.query;
    const only = over.only ?? (paging.shortOnly ? "short" : "");
    const page = over.page ?? 1;
    if (q !== "") p.set("q", q);
    if (only !== "") p.set("only", only);
    if (page > 1) p.set("page", String(page));
    const qs = p.toString();
    return qs === "" ? paging.basePath : `${paging.basePath}?${qs}`;
  };

  return (
    <section className="space-y-3">
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Assignments</h2>

        {/* A plain GET form, so a search survives the revalidate that follows
            every override and can be linked or bookmarked. */}
        <form method="get" action={paging.basePath} className="flex flex-wrap items-center gap-2">
          <input
            name="q"
            defaultValue={paging.query}
            placeholder="Name or applicant number"
            aria-label="Search applicants by name or number"
            className="border-input h-9 w-64 rounded-md border px-3 text-sm"
          />
          {paging.shortOnly ? <input type="hidden" name="only" value="short" /> : null}
          <Button size="sm" variant="outline" type="submit">
            Search
          </Button>
          {paging.query !== "" ? (
            <a href={href({ q: "" })} className="text-muted-foreground text-sm hover:underline">
              Clear
            </a>
          ) : null}
          <a
            href={href({ only: paging.shortOnly ? "" : "short", page: 1 })}
            className={
              paging.shortOnly
                ? "bg-foreground text-background rounded-md px-3 py-1.5 text-sm"
                : "hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
            }
          >
            Only short a reviewer
          </a>
        </form>

        <p className="text-muted-foreground text-sm">
          {paging.matchCount === paging.totalCount
            ? `${paging.totalCount} applicants`
            : `${paging.matchCount} of ${paging.totalCount} applicants`}
          {paging.pageCount > 1 ? ` · page ${paging.page} of ${paging.pageCount}` : ""}
          {paging.shortOnly ? " · short a reviewer, which is the open pool" : ""}
        </p>
      </div>

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      {state.message ? <p className="text-sm text-emerald-600">{state.message}</p> : null}

      {applicants.length === 0 ? (
        <p className="text-muted-foreground rounded-md border p-4 text-sm">
          No applicant matches. {paging.shortOnly ? "Every applicant has a full set of reviewers." : "Try a different name or number."}
        </p>
      ) : null}

      <ul className="divide-y">
        {applicants.map((applicant) => {
          const open = picker?.applicantId === applicant.id;
          return (
            <li key={applicant.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{applicant.label}</span>
                <span className="text-muted-foreground text-sm">{applicant.name}</span>
                <span className="text-muted-foreground text-xs">
                  {applicant.reviewers.length} reviewer{applicant.reviewers.length === 1 ? "" : "s"}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {applicant.reviewers.map((reviewer) => (
                  <span
                    key={reviewer.assignmentId}
                    className="bg-muted inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
                  >
                    {reviewer.name}
                    {reviewer.isSparklet ? (
                      <em className="not-italic opacity-70">· Sparklet</em>
                    ) : null}
                    {reviewer.origin !== "AUTO" ? (
                      <em className="not-italic opacity-70">· {reviewer.origin.toLowerCase()}</em>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Swap ${reviewer.name} on ${applicant.label}`}
                      disabled={pending}
                      className="ml-1 underline opacity-60 hover:opacity-100"
                      onClick={() => {
                        setPicker({ applicantId: applicant.id, swapOut: reviewer.id });
                        setFind("");
                      }}
                    >
                      swap
                    </button>
                    <button
                      type="button"
                      aria-label={`Unassign ${reviewer.name} from ${applicant.label}`}
                      disabled={pending}
                      className="hover:text-destructive opacity-60"
                      onClick={() =>
                        act(() => unassignReviewer(instanceId, round, applicant.id, reviewer.id))
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}

                {open ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground text-xs">
                      {picker?.swapOut
                        ? `Replace ${applicant.reviewers.find((r) => r.id === picker.swapOut)?.name} with:`
                        : "Add:"}
                    </span>
                    <input
                      autoFocus
                      value={find}
                      placeholder="Type a name"
                      aria-label="Find a reviewer"
                      className="border-input h-8 w-44 rounded-md border px-2 text-sm"
                      onChange={(e) => setFind(e.target.value)}
                    />
                    {reviewers
                      .filter((r) => r.name.toLowerCase().includes(find.trim().toLowerCase()))
                      .filter((r) => !applicant.reviewers.some((a) => a.id === r.id))
                      .slice(0, 5)
                      .map((r) => (
                        <Button
                          key={r.id}
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            act(() =>
                              picker?.swapOut
                                ? swapReviewer(
                                    instanceId,
                                    round,
                                    applicant.id,
                                    picker.swapOut,
                                    r.id,
                                  )
                                : assignReviewer(instanceId, round, applicant.id, r.id),
                            )
                          }
                        >
                          {r.name}
                          <span className="ml-1 opacity-60">
                            {r.load}
                            {r.isSparklet ? " · S" : ""}
                          </span>
                        </Button>
                      ))}
                    <Button size="sm" variant="ghost" onClick={() => setPicker(null)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setPicker({ applicantId: applicant.id });
                      setFind("");
                    }}
                  >
                    Assign
                  </Button>
                )}
              </div>

              {/* PRD decision 39. Read-only by design: a returned row is the
                  record of a recusal and generation must keep honouring it
                  (decision 23), so there is no × here. To put one of these
                  reviewers back, use Assign — it reactivates this row. */}
              {applicant.returned.length > 0 ? (
                <ul className="text-muted-foreground space-y-0.5 text-xs">
                  {applicant.returned.map((entry) => (
                    <li key={entry.assignmentId}>
                      Returned · {entry.name} — {entry.reason}
                      {entry.note ? <span className="italic"> — “{entry.note}”</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      {paging.pageCount > 1 ? (
        <nav className="flex items-center gap-3 text-sm" aria-label="Applicant pages">
          {paging.page > 1 ? (
            <a href={href({ page: paging.page - 1 })} className="rounded-md border px-3 py-1.5 hover:bg-muted">
              ← Previous
            </a>
          ) : null}
          <span className="text-muted-foreground">
            Page {paging.page} of {paging.pageCount}
          </span>
          {paging.page < paging.pageCount ? (
            <a href={href({ page: paging.page + 1 })} className="rounded-md border px-3 py-1.5 hover:bg-muted">
              Next →
            </a>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}

/// The distribution the BUILD_PLAN gate asks to eyeball, on screen as well as on
/// the console — a successor will not be reading server logs.
export function LoadTable({ reviewers }: { reviewers: ReviewerOption[] }) {
  if (reviewers.length === 0) return null;

  const loads = reviewers.map((r) => r.load);
  const min = Math.min(...loads);
  const max = Math.max(...loads);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Load per reviewer</h2>
        <p className="text-muted-foreground text-sm">
          {min === max ? `Everyone carries ${min}.` : `Between ${min} and ${max}.`} A spread wider
          than one means the roster constrained it.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b text-left">
            <tr>
              <th className="py-2 pr-4 font-medium">Reviewer</th>
              <th className="py-2 pr-4 font-medium">Sparklet</th>
              <th className="py-2 font-medium">Assigned</th>
            </tr>
          </thead>
          <tbody>
            {[...reviewers]
              .sort((a, b) => b.load - a.load || a.name.localeCompare(b.name))
              .map((reviewer) => (
                <tr key={reviewer.id} className="border-b last:border-0">
                  <td className="py-1.5 pr-4">{reviewer.name}</td>
                  <td className="py-1.5 pr-4">{reviewer.isSparklet ? "Yes" : ""}</td>
                  <td className="py-1.5">{reviewer.load}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
