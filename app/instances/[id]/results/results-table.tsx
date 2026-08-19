import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatAverage, formatVariance, isUnderTarget } from "@/lib/results";

export interface ResultRow {
  id: string;
  sourceRowIndex: number;
  displayName: string;
  average: number | null;
  variance: number | null;
  completedCount: number;
  /// Keyed by `DemographicColumn.key`.
  demographics: Record<string, string>;
}

export interface RankedRow extends ResultRow {
  rank: number;
}

export interface ResultsFilters {
  incompleteOnly: boolean;
  minVariance: number | null;
  basePath: string;
}

/// A server component. Nothing here is interactive — both filters are links and
/// a GET form, so the whole page works before hydration and a filtered view is
/// linkable and survives a revalidate. FR-11's checkbox column arrives in slice 4
/// and is the first thing on this page that needs the client.
export function ResultsTable({
  rows,
  columns,
  target,
  totalCount,
  incompleteCount,
  filters,
  instanceId,
}: {
  rows: readonly RankedRow[];
  columns: readonly { key: string; label: string }[];
  target: number;
  totalCount: number;
  incompleteCount: number;
  filters: ResultsFilters;
  instanceId: string;
}) {
  // Omits defaults so a URL stays clean and an unfiltered view has no query
  // string at all. Same shape as assignment-controls.tsx's href builder.
  const href = (over: Partial<{ only: string; minVar: string }>) => {
    const params = new URLSearchParams();
    const only = over.only ?? (filters.incompleteOnly ? "incomplete" : "");
    const minVar = over.minVar ?? (filters.minVariance === null ? "" : String(filters.minVariance));
    if (only !== "") params.set("only", only);
    if (minVar !== "") params.set("minVar", minVar);
    const query = params.toString();
    return query === "" ? filters.basePath : `${filters.basePath}?${query}`;
  };

  const filtered = filters.incompleteOnly || filters.minVariance !== null;

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <Stat label="Applicants" value={totalCount} />
        <Stat label={`Under ${target}/${target}`} value={incompleteCount} />
        <Stat label="Showing" value={filtered ? `${rows.length} of ${totalCount}` : totalCount} />
      </dl>

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

        {/* A plain GET form, so the threshold survives the revalidate that
            follows finalize and can be linked. It is still "not persisted" in
            FR-10's sense: nothing writes it to the instance, a cookie, or
            localStorage — it lives only in the URL the admin is looking at. */}
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
              <TableHead className="w-12 text-right">#</TableHead>
              <TableHead>Applicant</TableHead>
              <TableHead className="text-right">Average</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead className="text-right">Reviews</TableHead>
              {columns.map((column) => (
                <TableHead key={column.key}>{column.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
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
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    className="text-muted-foreground max-w-[16rem] truncate text-sm"
                    title={row.demographics[column.key] || undefined}
                  >
                    {row.demographics[column.key] || "—"}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ReviewCountCell({
  completedCount,
  target,
}: {
  completedCount: number;
  target: number;
}) {
  const short = isUnderTarget(completedCount, target);
  const label = `${completedCount}/${target}`;

  if (!short) {
    return <TableCell className="text-right tabular-nums">{label}</TableCell>;
  }

  return (
    <TableCell className="text-right">
      <span
        className="bg-amber-100 text-amber-900 rounded px-1.5 py-0.5 text-sm tabular-nums dark:bg-amber-950 dark:text-amber-200"
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
