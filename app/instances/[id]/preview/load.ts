import "server-only";

// Assembling the preview from the database, shared by the page and the commit
// action so they cannot disagree about whether the import is ready.

import { PromotedRole } from "@/generated/prisma/enums";
import type { GroupProposal } from "@/lib/import/detect-groups";
import { buildPreview, type PreviewFindings } from "@/lib/import/preview";
import { prisma } from "@/lib/prisma";

export interface LoadedPreview {
  instance: { id: string; name: string; importCommittedAt: Date | null };
  findings: PreviewFindings;
  emailOrdinal: number | null;
  nameOrdinals: number[];
  fields: {
    id: string;
    ordinal: number;
    displayName: string;
    promotedRole: PromotedRole | null;
  }[];
  rows: { rowIndex: number; discarded: boolean; cells: Record<string, string> }[];
}

export async function loadPreview(instanceId: string): Promise<LoadedPreview | null> {
  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: {
      id: true,
      name: true,
      importCommittedAt: true,
      importProposals: true,
      fields: { orderBy: { ordinal: "asc" } },
      fieldGroups: true,
      importRows: { orderBy: { rowIndex: "asc" } },
    },
  });

  if (!instance) return null;

  const emailField = instance.fields.find((f) => f.promotedRole === PromotedRole.EMAIL);
  const nameFields = instance.fields
    .filter((f) => f.promotedRole === PromotedRole.NAME)
    .sort((a, b) => a.ordinal - b.ordinal);

  const rows = instance.importRows.map((row) => ({
    rowIndex: row.rowIndex,
    discarded: row.discarded,
    cells: row.cells as Record<string, string>,
  }));

  const proposals = ((instance.importProposals as { proposals?: GroupProposal[] } | null)
    ?.proposals ?? []) as GroupProposal[];

  const findings = buildPreview({
    rows: rows.map((row) => ({
      rowIndex: row.rowIndex,
      discarded: row.discarded,
      rawEmail: emailField ? (row.cells[String(emailField.ordinal)] ?? "") : "",
      rawNameParts: nameFields.map((f) => row.cells[String(f.ordinal)] ?? ""),
    })),
    fields: instance.fields,
    groups: instance.fieldGroups,
    unconfirmedProposalCount: proposals.length,
    hasEmailColumn: emailField !== undefined,
    hasNameColumn: nameFields.length > 0,
  });

  return {
    instance: {
      id: instance.id,
      name: instance.name,
      importCommittedAt: instance.importCommittedAt,
    },
    findings,
    emailOrdinal: emailField?.ordinal ?? null,
    nameOrdinals: nameFields.map((f) => f.ordinal),
    fields: instance.fields.map((f) => ({
      id: f.id,
      ordinal: f.ordinal,
      displayName: f.displayName,
      promotedRole: f.promotedRole,
    })),
    rows,
  };
}
