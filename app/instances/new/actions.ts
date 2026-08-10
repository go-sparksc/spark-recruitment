"use server";

import { redirect } from "next/navigation";

import { FieldCategory } from "@/generated/prisma/enums";
import { grantInstance, requireAdmin } from "@/lib/auth";
import { cleanHeader } from "@/lib/fields";
import { detectGroups } from "@/lib/import/detect-groups";
import { CsvParseError, parseCsv } from "@/lib/import/parse-csv";
import { hashSecret } from "@/lib/password";
import { prisma } from "@/lib/prisma";

export interface CreateInstanceState {
  error?: string;
}

/// Guards the upload before any parsing. 20MB is far beyond a real export
/// (the S26 file is well under 1MB) and well inside the 8MB server-action body
/// limit in next.config.ts, so this exists to reject an obvious mistake — a
/// video, a zip — with a sentence rather than a stack trace.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export async function createInstance(
  _prev: CreateInstanceState,
  formData: FormData,
): Promise<CreateInstanceState> {
  // Inside the action, not only in the page. A server action is reachable
  // without rendering the page that hosts it.
  await requireAdmin();

  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const file = formData.get("file");

  if (name === "") return { error: "Give the instance a name, such as “S26 Recruitment”." };
  if (password.length < 8) return { error: "The instance password must be at least 8 characters." };
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file to import." };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: "That file is larger than 8MB. A real application export is far smaller." };
  }

  let parsed;
  try {
    parsed = parseCsv(Buffer.from(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof CsvParseError) return { error: error.message };
    throw error;
  }

  const { headers, rows } = parsed;

  // Detection runs here so the mapping table has something to show immediately,
  // but it produces PROPOSALS ONLY. No FieldGroup row exists until the admin
  // names one, which is also when its immutable key is assigned. See PRD FR-2
  // and open decisions 12 and 13.
  const proposals = detectGroups(headers, rows);

  const passwordHash = await hashSecret(password);

  const instance = await prisma.$transaction(async (tx) => {
    const created = await tx.instance.create({
      data: {
        name,
        passwordHash,
        // Every column starts OTHER, included, ungrouped. The importer never
        // guesses a category from header text: a wrong silent guess is worse
        // than an unset one, and OTHER carries the same effective visibility as
        // DEMOGRAPHIC under section 6.
        fields: {
          create: headers.map((sourceHeader, ordinal) => ({
            sourceHeader,
            displayName: cleanHeader(sourceHeader),
            category: FieldCategory.OTHER,
            ordinal,
          })),
        },
        importProposals: proposals.length > 0 ? { proposals } : undefined,
      },
      select: { id: true },
    });

    // rowIndex is 1-based and assigned from parse order. It becomes
    // Applicant.sourceRowIndex and is never renumbered, so discarding a
    // duplicate at preview leaves a gap and "Applicant 47" keeps pointing at
    // record 47 of the file the admin uploaded.
    await tx.importRow.createMany({
      data: rows.map((cells, index) => ({
        instanceId: created.id,
        rowIndex: index + 1,
        cells: Object.fromEntries(cells.map((value, column) => [String(column), value])),
      })),
    });

    return created;
  });

  // They typed this password a moment ago; asking again immediately is friction
  // with no security value.
  await grantInstance(instance.id);

  redirect(`/instances/${instance.id}/mapping`);
}
