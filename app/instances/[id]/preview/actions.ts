"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { Prisma } from "@/generated/prisma/client";
import { PromotedRole } from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import { loadPreview } from "./load";
import { normalizeEmail } from "@/lib/import/preview";
import { prisma } from "@/lib/prisma";

export interface ActionState {
  error?: string;
}

const ok: ActionState = {};

async function openDraft(instanceId: string) {
  await requireInstance(instanceId, `/instances/${instanceId}/preview`);

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { id: true, importCommittedAt: true },
  });

  if (!instance) throw new Error("No such instance.");
  if (instance.importCommittedAt !== null) {
    throw new Error("This instance's CSV has already been committed.");
  }
  return instance;
}

export async function setRowDiscarded(
  instanceId: string,
  rowIndex: number,
  discarded: boolean,
): Promise<ActionState> {
  await openDraft(instanceId);

  await prisma.importRow.update({
    where: { instanceId_rowIndex: { instanceId, rowIndex } },
    data: { discarded },
  });

  revalidatePath(`/instances/${instanceId}/preview`);
  return ok;
}

/// FR-3's "resolve": correct an address in place rather than discarding a real
/// applicant. Writes back into the verbatim cell, so the preview keeps showing
/// exactly what will be imported.
export async function setRowEmail(
  instanceId: string,
  rowIndex: number,
  email: string,
): Promise<ActionState> {
  await openDraft(instanceId);

  const emailField = await prisma.field.findFirst({
    where: { instanceId, promotedRole: PromotedRole.EMAIL },
    select: { ordinal: true },
  });
  if (!emailField) return { error: "No email column is designated." };

  const row = await prisma.importRow.findUnique({
    where: { instanceId_rowIndex: { instanceId, rowIndex } },
    select: { cells: true },
  });
  if (!row) return { error: "No such row." };

  const cells = { ...(row.cells as Record<string, string>) };
  cells[String(emailField.ordinal)] = email;

  await prisma.importRow.update({
    where: { instanceId_rowIndex: { instanceId, rowIndex } },
    data: { cells },
  });

  revalidatePath(`/instances/${instanceId}/preview`);
  return ok;
}

/// FR-3's commit. One transaction, and final.
export async function commitImport(instanceId: string): Promise<ActionState> {
  await openDraft(instanceId);

  const loaded = await loadPreview(instanceId);
  if (!loaded) return { error: "No such instance." };
  if (!loaded.findings.canCommit) {
    return { error: "Some problems still need resolving before this can be committed." };
  }

  const { emailOrdinal, nameOrdinals, fields, rows } = loaded;

  // The designated columns are promoted OUT of the data: §6 is explicit that
  // Applicant.displayName and Applicant.email are not Field rows, which is why
  // no per-field visibility toggle covers them.
  const promotedFieldIds = fields.filter((f) => f.promotedRole !== null).map((f) => f.id);
  const dataFields = fields.filter((f) => f.promotedRole === null);

  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      if (row.discarded) continue;

      const cells = row.cells;
      const email = normalizeEmail(emailOrdinal === null ? "" : cells[String(emailOrdinal)]);
      const displayName = nameOrdinals
        .map((o) => (cells[String(o)] ?? "").trim())
        .filter((part) => part !== "")
        .join(" ");

      await tx.applicant.create({
        data: {
          instanceId,
          // Assigned at parse and never renumbered, so a discarded row leaves a
          // gap and "Applicant 47" still means record 47 of the source file.
          sourceRowIndex: row.rowIndex,
          email,
          displayName,
          // Keyed by Field id, never by header text — renaming a column later
          // cannot orphan a value. Excluded columns keep their values (FR-2);
          // exclusion is a presentation decision, not a lossy one.
          data: Object.fromEntries(
            dataFields.map((f) => [f.id, cells[String(f.ordinal)] ?? ""]),
          ),
        },
      });
    }

    // The promoted columns' Field rows go away; their values now live on the
    // Applicant. Leaving them would mean a Field whose id appears in no
    // applicant's data.
    if (promotedFieldIds.length > 0) {
      await tx.field.deleteMany({ where: { id: { in: promotedFieldIds } } });
    }

    await tx.importRow.deleteMany({ where: { instanceId } });

    await tx.instance.update({
      where: { id: instanceId },
      data: {
        importCommittedAt: new Date(),
        // DbNull, not undefined: undefined would leave the column untouched and
        // the CHECK would reject the whole update.
        importProposals: Prisma.DbNull,
      },
    });
  });

  revalidatePath("/");
  redirect(`/instances/${instanceId}/mapping`);
}
