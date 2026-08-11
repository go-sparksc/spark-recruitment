"use client";

import { useState, useTransition } from "react";

import {
  assignReviewer,
  generate,
  unassignReviewer,
  type ActionState,
  type GenerateResult,
  type PrecheckView,
} from "./actions";
import { Button } from "@/components/ui/button";
import { Round } from "@/generated/prisma/enums";

export interface ApplicantRow {
  id: string;
  label: string;
  reviewers: { assignmentId: string; id: string; name: string; isSparklet: boolean; origin: string }[];
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

      {result?.violations?.length ? (
        <div className="border-destructive/40 space-y-2 rounded-md border p-4">
          <p className="text-sm font-medium">
            {result.violations.length} existing assignment
            {result.violations.length === 1 ? "" : "s"} already broke a rule.
          </p>
          <ul className="space-y-1 text-sm">
            {result.violations.map((v, i) => (
              <li key={i}>· {v.detail}</li>
            ))}
          </ul>
          <p className="text-muted-foreground text-sm">
            Left exactly as they were. Generation reports these rather than fixing them by deleting
            an override somebody made on purpose.
          </p>
        </div>
      ) : null}
    </section>
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

/// FR-8. Assign, unassign, and swap — a swap being an unassign then an assign,
/// which keeps both halves audited separately rather than as one opaque action.
export function OverridePanel({
  instanceId,
  round,
  applicants,
  reviewers,
}: {
  instanceId: string;
  round: Round;
  applicants: ApplicantRow[];
  reviewers: ReviewerOption[];
}) {
  const [state, setState] = useState<ActionState>({});
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pending, start] = useTransition();

  const act = (fn: () => Promise<ActionState>) =>
    start(async () => {
      setState(await fn());
      setOpenFor(null);
      setQuery("");
    });

  const shown = applicants.slice(0, 60);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Assignments</h2>
        <p className="text-muted-foreground text-sm">
          Showing {shown.length} of {applicants.length} applicants. Applicants short a reviewer are
          listed first — those are the open pool slots.
        </p>
      </div>

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      {state.message ? <p className="text-sm text-emerald-600">{state.message}</p> : null}

      <ul className="divide-y">
        {shown.map((applicant) => (
          <li key={applicant.id} className="space-y-2 py-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-medium">{applicant.label}</span>
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
                  {reviewer.isSparklet ? <em className="not-italic opacity-70">· Sparklet</em> : null}
                  {reviewer.origin !== "AUTO" ? (
                    <em className="not-italic opacity-70">· {reviewer.origin.toLowerCase()}</em>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`Unassign ${reviewer.name} from ${applicant.label}`}
                    disabled={pending}
                    className="hover:text-destructive ml-1 opacity-60"
                    onClick={() =>
                      act(() => unassignReviewer(instanceId, round, applicant.id, reviewer.id))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}

              {openFor === applicant.id ? (
                <span className="flex flex-wrap items-center gap-2">
                  <input
                    autoFocus
                    value={query}
                    placeholder="Type a name"
                    aria-label="Find a reviewer"
                    className="border-input h-8 w-44 rounded-md border px-2 text-sm"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {reviewers
                    .filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase()))
                    .filter((r) => !applicant.reviewers.some((a) => a.id === r.id))
                    .slice(0, 5)
                    .map((r) => (
                      <Button
                        key={r.id}
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => act(() => assignReviewer(instanceId, round, applicant.id, r.id))}
                      >
                        {r.name}
                        <span className="ml-1 opacity-60">
                          {r.load}
                          {r.isSparklet ? " · S" : ""}
                        </span>
                      </Button>
                    ))}
                  <Button size="sm" variant="ghost" onClick={() => setOpenFor(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setOpenFor(applicant.id)}
                >
                  Assign
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
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
