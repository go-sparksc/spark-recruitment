import Link from "next/link";
import { notFound } from "next/navigation";

import {
  ColumnControls,
  GroupPanel,
  ProposalCard,
  type ColumnView,
  type GroupView,
} from "./mapping-controls";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PromotedRole } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { resolveField } from "@/lib/fields";
import type { GroupProposal } from "@/lib/import/detect-groups";
import { duplicateHeaders } from "@/lib/import/parse-csv";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Map columns — Spark SC Recruitment" };

export default async function MappingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireInstance(id, `/instances/${id}/mapping`);

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      importCommittedAt: true,
      importProposals: true,
      fields: { orderBy: { ordinal: "asc" } },
      fieldGroups: { orderBy: { ordinal: "asc" } },
      _count: { select: { importRows: true } },
    },
  });

  if (!instance) notFound();

  const proposals = ((instance.importProposals as { proposals?: GroupProposal[] } | null)
    ?.proposals ?? []) as GroupProposal[];
  const duplicates = new Set(duplicateHeaders(instance.fields.map((f) => f.sourceHeader)));
  const groupsById = new Map(instance.fieldGroups.map((g) => [g.id, g]));

  // Resolved as admin, purely to read back the effective category and inclusion
  // a grouped column inherits. The same helper every reviewer surface will use,
  // so the mapping table cannot disagree with what reviewers actually get.
  const columns: ColumnView[] = instance.fields.map((field) => {
    const group = field.groupId === null ? null : (groupsById.get(field.groupId) ?? null);
    const resolved = resolveField(field, group, "ADMIN");
    return {
      id: field.id,
      ordinal: field.ordinal,
      sourceHeader: field.sourceHeader,
      displayName: field.displayName,
      category: field.category,
      isIncluded: field.isIncluded,
      groupId: field.groupId,
      groupRole: field.groupRole,
      promotedRole: field.promotedRole,
      visibleToWrittenReviewer: field.visibleToWrittenReviewer,
      visibleToFirstRoundReviewer: field.visibleToFirstRoundReviewer,
      effectiveCategory: resolved.category,
      effectiveIncluded: resolved.isIncluded,
      inheritedFromGroup: resolved.inheritedFromGroup,
    };
  });

  const groups: GroupView[] = instance.fieldGroups.map((group) => ({
    id: group.id,
    key: group.key,
    displayName: group.displayName,
    category: group.category,
    isIncluded: group.isIncluded,
    isMultiSelect: group.isMultiSelect,
    visibleToWrittenReviewer: group.visibleToWrittenReviewer,
    visibleToFirstRoundReviewer: group.visibleToFirstRoundReviewer,
    members: instance.fields
      .filter((f) => f.groupId === group.id)
      .map((f) => ({ id: f.id, displayName: f.displayName, groupRole: f.groupRole })),
  }));

  const groupOptions = groups.map((g) => ({ id: g.id, displayName: g.displayName }));

  // FR-2: both designations are required and neither column can be excluded.
  const emailColumn = instance.fields.find((f) => f.promotedRole === PromotedRole.EMAIL);
  const nameColumns = instance.fields.filter((f) => f.promotedRole === PromotedRole.NAME);
  const outstanding = [
    emailColumn ? null : "Designate the email column — it is the join key for the first-round imports.",
    nameColumns.length > 0
      ? null
      : "Designate the name column, or both first and last name columns.",
    proposals.length > 0
      ? `${proposals.length} detected group${proposals.length === 1 ? "" : "s"} still need naming or dismissing.`
      : null,
  ].filter((x): x is string => x !== null);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-16">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← Instances
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{instance.name}</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {instance.fields.length} columns and {instance._count.importRows} applicants read from the
        file. Nothing is created until you commit.
      </p>

      {outstanding.length > 0 ? (
        <Card className="mt-8 border-amber-500/40">
          <CardHeader>
            <CardTitle className="text-base">Before you can commit</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {outstanding.map((item) => (
                <li key={item}>· {item}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {proposals.length > 0 ? (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Detected groups</CardTitle>
            <CardDescription>
              A suggestion, not a decision. Nothing is stored until you name it — naming creates the
              group and fixes the key exports will use. Dismiss it if the columns are unrelated.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {proposals.map((proposal, index) => (
              <ProposalCard
                key={`${index}-${proposal.columnIndexes.join(",")}`}
                instanceId={instance.id}
                proposal={{
                  index,
                  headers: proposal.headers,
                  columnCount: proposal.columnIndexes.length,
                }}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}

      {groups.length > 0 ? (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Groups</CardTitle>
            <CardDescription>
              Category, inclusion and visibility are set here and apply to every member, so a group
              cannot end up half hidden and half visible.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {groups.map((group) => (
              <GroupPanel
                key={group.id}
                instanceId={instance.id}
                group={group}
                otherGroups={groupOptions.filter((g) => g.id !== group.id)}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Columns</CardTitle>
          <CardDescription>
            Every column starts as Other and included. Categories are never guessed from header
            text.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 text-right">#</TableHead>
                <TableHead className="w-72">Source header</TableHead>
                <TableHead>Mapping</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {columns.map((column) => (
                <TableRow key={column.id} className="align-top">
                  <TableCell className="text-muted-foreground pt-4 text-right tabular-nums">
                    {column.ordinal + 1}
                  </TableCell>
                  <TableCell className="pt-4">
                    {/* Verbatim, newlines and trailing spaces intact — this is
                        what the file contains and why sourceHeader is stored raw. */}
                    <span className="font-mono text-xs break-words whitespace-pre-wrap">
                      {column.sourceHeader}
                    </span>
                    {duplicates.has(column.sourceHeader) ? (
                      <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                        duplicate header
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <ColumnControls
                      instanceId={instance.id}
                      column={column}
                      groups={groupOptions}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
}
