"use client";

import Link from "next/link";

import {
  SelectionPanel,
  useSelection,
  type SelectionApplicant,
  type SelectionColumn,
} from "./selection-panel";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ApplicantDemographic } from "@/lib/demographics";
import { formatAverage, formatVariance, isUnderTarget } from "@/lib/results";

export interface ResultRow {
  id: string;
  sourceRowIndex: number;
  displayName: string;
  average: number | null;
  variance: number | null;
  completedCount: number;
  /// Whether the round advanced this applicant. Drives the "moved on" filter,
  /// which is offered only once the round is finalized — before that nobody has
  /// moved on and the control would empty the table.
  advanced: boolean;
  /// How many of this applicant's reviewers ticked decision 116's box. A count
  /// rather than a boolean: one reviewer suspecting and two not is a different
  /// signal from all three suspecting, and collapsing them would throw away the
  /// disagreement that makes the flag worth having.
  aiFlagCount: number;
  /// Keyed by `DemographicColumn.key`.
  demographics: Record<string, ApplicantDemographic>;
}

export interface RankedRow extends ResultRow {
  rank: number;
}

export interface ResultsFilters {
  incompleteOnly: boolean;
  minVariance: number | null;
  /// Only the applicants the round advanced. Shares the `only` query parameter
  /// with `incompleteOnly`, which is why both are links rather than checkboxes:
  /// they ask opposite questions and cannot both be on.
  advancedOnly: boolean;
  basePath: string;
}

/// FR-10's table and FR-11's selection, on one screen.
///
/// One page rather than two because an admin checking a box has to see the
/// variance and the review count on the row they are checking. A separate
/// selection screen would either repeat those columns or ask for the decision
/// without the numbers that inform it.
///
/// A client component because FR-11's panel must be live. The filters inside it
/// are still a plain GET form and plain links, so a filtered view is linkable
/// and survives the revalidate that follows finalize.
export function ResultsTable({
  rows,
  pool,
  columns,
  target,
  totalCount,
  incompleteCount,
  filters,
  instanceId,
  selectable,
}: {
  /// The filtered, ranked view — what the table draws.
  rows: readonly RankedRow[];
  /// The whole pool, unfiltered. FR-11's breakdown compares the selection
  /// "against the applicant pool", and a filtered denominator would not be one.
  pool: readonly SelectionApplicant[];
  columns: readonly SelectionColumn[];
  target: number;
  totalCount: number;
  incompleteCount: number;
  filters: ResultsFilters;
  instanceId: string;
  /// Clause 11e, decided on the server from `Instance.currentStage`. False once
  /// the round is finalized: the checkbox column and the panel are **not
  /// rendered**, rather than rendered disabled, so there is no control to
  /// re-enable and no selection state to submit.
  selectable: boolean;
}) {
  const { selected, toggle, clear } = useSelection();

  // Omits defaults so a URL stays clean and an unfiltered view has no query
  // string at all. Same shape as assignment-controls.tsx's href builder.
  // `only` carries one of two mutually exclusive values, which is why the two
  // filters that use it are links rather than checkboxes: "incomplete" and
  // "advanced" ask opposite questions (who still needs reading, who already got
  // through), and a URL that claimed both would have to mean neither.
  const currentOnly = filters.incompleteOnly ? "incomplete" : filters.advancedOnly ? "advanced" : "";

  const href = (over: Partial<{ only: string; minVar: string }>) => {
    const params = new URLSearchParams();
    const only = over.only ?? currentOnly;
    const minVar = over.minVar ?? (filters.minVariance === null ? "" : String(filters.minVariance));
    if (only !== "") params.set("only", only);
    if (minVar !== "") params.set("minVar", minVar);
    const query = params.toString();
    return query === "" ? filters.basePath : `${filters.basePath}?${query}`;
  };

  const filtered = currentOnly !== "" || filters.minVariance !== null;

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <Stat label="Applicants" value={totalCount} />
        <Stat label={`Under ${target}/${target}`} value={incompleteCount} />
        <Stat label="Showing" value={filtered ? `${rows.length} of ${totalCount}` : totalCount} />
        {selectable ? <Stat label="Selected" value={selected.size} /> : null}
      </dl>

      {selectable ? (
        <SelectionPanel
          instanceId={instanceId}
          applicants={pool}
          columns={columns}
          selected={selected}
          onClear={clear}
          target={target}
        />
      ) : (
        // Clause 11e. The ranking, the filters and the profiles stay; only the
        // affordances for making a decision go, because the decision is made.
        <p className="rounded-md border p-4 text-sm">
          <span className="font-medium">Written round finalized.</span>{" "}
          <span className="text-muted-foreground">
            These results are kept as the record of that decision. Ranking, filters and applicant
            profiles all still work; selection does not, because there is nothing left to select.
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <Link
          href={href({ only: filters.incompleteOnly ? "" : "incomplete" })}
          className={
            filters.incompleteOnly
              ? "bg-foreground text-background rounded-md px-3 py-1.5 text-sm"
              : "hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
          }
        >
          Incomplete
        </Link>

        {/* Offered only once the round is finalized, which is exactly when
            `selectable` goes false. Before that nobody has moved on, so the
            control would empty the table and read as a bug rather than as an
            answer — the Slice 4 rule again, that a surface should not offer
            something that cannot work yet. */}
        {selectable ? null : (
          <Link
            href={href({ only: filters.advancedOnly ? "" : "advanced" })}
            className={
              filters.advancedOnly
                ? "bg-foreground text-background rounded-md px-3 py-1.5 text-sm"
                : "hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
            }
          >
            Moved on
          </Link>
        )}

        {/* A plain GET form, so the threshold survives a revalidate and can be
            linked. Still "not persisted" in FR-10's sense: nothing writes it to
            the instance, a cookie, or localStorage — it lives only in the URL
            the admin is currently looking at. */}
        <form method="get" action={filters.basePath} className="flex items-end gap-2">
          <div className="space-y-1">
            <label htmlFor="minVar" className="text-muted-foreground block text-xs">
              Variance at least
            </label>
            <input
              id="minVar"
              name="minVar"
              type="number"
              step="0.001"
              min="0"
              inputMode="decimal"
              defaultValue={filters.minVariance === null ? "" : filters.minVariance}
              placeholder="off"
              className="border-input h-9 w-28 rounded-md border px-3 text-sm"
            />
          </div>
          {filters.incompleteOnly ? <input type="hidden" name="only" value="incomplete" /> : null}
          <Button size="sm" variant="outline" type="submit">
            Apply
          </Button>
        </form>

        {filtered ? (
          <Link
            href={filters.basePath}
            className="text-muted-foreground hover:text-foreground text-sm underline"
          >
            Clear filters
          </Link>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground rounded-md border p-4 text-sm">
          No applicant matches these filters.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {selectable ? <TableHead className="w-10" /> : null}
              <TableHead className="w-12 text-right">#</TableHead>
              <TableHead>Applicant</TableHead>
              <TableHead className="text-right">Average</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead className="text-right">Reviews</TableHead>
              {/* Decision 116. Abbreviated because the column is narrow and
                  almost always empty; the title says what it is. */}
              <TableHead className="text-right" title="Reviewers who thought the writing looked AI-generated">
                AI?
              </TableHead>
              {columns.map((column) => (
                <TableHead key={column.key}>{column.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} data-state={selected.has(row.id) ? "selected" : undefined}>
                {selectable ? (
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                      aria-label={`Advance ${row.displayName}`}
                      className="border-input size-4 rounded"
                    />
                  </TableCell>
                ) : null}
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {row.rank}
                </TableCell>
                <TableCell className="font-medium">
                  <Link
                    href={`/instances/${instanceId}/results/${row.id}`}
                    className="hover:underline"
                  >
                    {row.displayName}
                  </Link>
                  <span className="text-muted-foreground ml-2 text-xs tabular-nums">
                    #{row.sourceRowIndex}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatAverage(row.average)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatVariance(row.variance)}
                </TableCell>
                {/* FR-10: the marker is on this cell and not on the row. An
                    applicant with two thorough reviews is not a worse
                    applicant, so "trust this number less" has to read on the
                    number. */}
                <ReviewCountCell completedCount={row.completedCount} target={target} />
                {/* Decision 116. On its own cell, not appended to the review
                    count — that cell already carries FR-10's under-target
                    marker, and two unrelated warnings sharing one number is how
                    an admin comes to read the wrong one. Blank rather than "0",
                    so the column reads as exceptions rather than as a statistic
                    every applicant has. */}
                <TableCell className="text-right tabular-nums">
                  {row.aiFlagCount > 0 ? (
                    <span
                      className="text-amber-700"
                      // Decision 118's sibling problem, and 116 records the
                      // reasoning: the denominator is COMPLETED reviews, not
                      // assigned reviewers. `suspectedAiUse` defaults to false,
                      // so a reviewer who never opened the application reads
                      // identically to one who read it and did not suspect —
                      // "1 of 3 assigned" would claim three people considered it
                      // when perhaps one has. It stays in the tooltip rather
                      // than the cell so it cannot be misread as a fraction
                      // against the review-count column's target.
                      title={`${row.aiFlagCount} of ${row.completedCount} completed review${row.completedCount === 1 ? "" : "s"} thought the writing looked AI-generated. Open the applicant to see who, and read the application again.`}
                    >
                      ⚑ {row.aiFlagCount}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                {columns.map((column) => (
                  <DemographicCell key={column.key} cell={row.demographics[column.key]} />
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function DemographicCell({ cell }: { cell: ApplicantDemographic | undefined }) {
  const selected = cell?.selected ?? [];
  const writeIn = cell?.writeIn ?? "";

  // **Wraps rather than truncating.** These used to be `truncate`, which is
  // `white-space: nowrap` plus an ellipsis, with the full value only on the
  // native `title` — so a multi-select ethnicity like "East Asian, White,
  // Middle Eastern" was clipped with no way to read the rest on a touch screen,
  // where there is no hover. The width cap stays, because an unbounded column
  // pushes the rest of FR-10's table off screen; the cell grows downward
  // instead. `title` is kept as a convenience for a mouse, not as the only way.
  if (selected.length > 0) {
    const text = selected.join(", ");
    return (
      <TableCell
        className="text-muted-foreground max-w-[16rem] text-sm break-words whitespace-normal"
        title={text}
      >
        {text}
      </TableCell>
    );
  }

  // §10.7: a write-in author has given a real answer the count cannot read.
  // Shown in italics so it does not look like a selected option, since it is
  // not one and is not counted as one. Free text is the likelier of the two to
  // be long, so the wrap matters more here than above.
  if (writeIn !== "") {
    return (
      <TableCell
        className="text-muted-foreground max-w-[16rem] text-sm italic break-words whitespace-normal"
        title={writeIn}
      >
        {writeIn}
      </TableCell>
    );
  }

  return <TableCell className="text-muted-foreground text-sm">—</TableCell>;
}

function ReviewCountCell({ completedCount, target }: { completedCount: number; target: number }) {
  const short = isUnderTarget(completedCount, target);
  const label = `${completedCount}/${target}`;

  if (!short) {
    return <TableCell className="text-right tabular-nums">{label}</TableCell>;
  }

  return (
    <TableCell className="text-right">
      <span
        className="rounded bg-amber-100 px-1.5 py-0.5 text-sm tabular-nums text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        title={
          completedCount === 0
            ? "Nobody has completed a review of this applicant."
            : `Only ${completedCount} of ${target} reviews are complete, so the average and variance rest on fewer opinions.`
        }
      >
        {label}
      </span>
    </TableCell>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
