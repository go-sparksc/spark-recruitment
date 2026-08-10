// FR-3's preview. Pure — rows and field config in, findings out.
//
// This is the only point at which a bad file can be caught cheaply. After
// commit the import is final, and the correction path is deleting the instance
// and starting again, so everything worth catching has to surface here.

import { FieldCategory } from "@/generated/prisma/enums";
import { resolveField, type FieldGroupLike, type FieldLike } from "@/lib/fields";

/// Trim, NFC, lowercase. Blank becomes null.
///
/// Lowercase because USC addresses are case-insensitive and this is the FR-12
/// and FR-13 join key. Comparing verbatim instead would let two rows differing
/// only in case pass the preview and then violate UNIQUE (instanceId, email) at
/// commit — after the admin has approved the import, which is the worst possible
/// moment and reads like a bug in the tool.
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.normalize("NFC").trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

export interface PreviewRowInput {
  rowIndex: number;
  discarded: boolean;
  /// Verbatim value of the designated email column, if any.
  rawEmail: string;
  /// Verbatim values of the designated name columns, in ordinal order.
  rawNameParts: string[];
}

export interface PreviewRow {
  rowIndex: number;
  discarded: boolean;
  rawEmail: string;
  email: string | null;
  displayName: string;
  /// The verbatim value differs from the normalized one by more than case —
  /// i.e. it carried surrounding whitespace. Reported, never silently fixed.
  emailWasPadded: boolean;
}

export interface DuplicateGroup {
  email: string;
  rowIndexes: number[];
}

export interface PreviewFindings {
  rows: PreviewRow[];
  keptCount: number;
  discardedCount: number;

  /// Blocking. Two kept rows normalizing to the same address would violate
  /// UNIQUE (instanceId, email).
  duplicates: DuplicateGroup[];
  /// Blocking. Applicant.displayName is non-null.
  blankNameRowIndexes: number[];

  /// Reported, not blocking. email is nullable and Postgres permits many nulls,
  /// so a blank address is a real state — FR-3 only asks that it be visible.
  blankEmailRowIndexes: number[];
  /// Reported. The value is trimmed on import and the admin is told so.
  paddedEmailRowIndexes: number[];

  /// Warnings. Each describes a plausible instance the system should not
  /// overrule, so neither blocks. See FR-3.
  unconfirmedProposalCount: number;
  hasIncludedResponseField: boolean;

  blockers: string[];
  warnings: string[];
  canCommit: boolean;
}

export interface PreviewInput {
  rows: PreviewRowInput[];
  fields: FieldLike[];
  groups: FieldGroupLike[];
  unconfirmedProposalCount: number;
  /// Null when the admin has not designated an email column yet.
  hasEmailColumn: boolean;
  hasNameColumn: boolean;
}

export function buildPreview(input: PreviewInput): PreviewFindings {
  const rows: PreviewRow[] = input.rows.map((row) => {
    const email = normalizeEmail(row.rawEmail);
    // Padding is compared against the trimmed form only. A change of case is
    // normalization the admin does not need to be told about; surrounding
    // whitespace is a property of the file worth surfacing.
    const trimmed = typeof row.rawEmail === "string" ? row.rawEmail.trim() : "";
    return {
      rowIndex: row.rowIndex,
      discarded: row.discarded,
      rawEmail: row.rawEmail,
      email,
      displayName: row.rawNameParts.map((part) => part.trim()).filter((p) => p !== "").join(" "),
      emailWasPadded: typeof row.rawEmail === "string" && row.rawEmail !== trimmed,
    };
  });

  const kept = rows.filter((row) => !row.discarded);

  // Only kept rows can collide: discarding one of a pair is how FR-3 expects a
  // duplicate to be resolved.
  const byEmail = new Map<string, number[]>();
  for (const row of kept) {
    if (row.email === null) continue;
    byEmail.set(row.email, [...(byEmail.get(row.email) ?? []), row.rowIndex]);
  }
  const duplicates = [...byEmail]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([email, rowIndexes]) => ({ email, rowIndexes }))
    .sort((a, b) => a.rowIndexes[0] - b.rowIndexes[0]);

  const blankNameRowIndexes = kept.filter((r) => r.displayName === "").map((r) => r.rowIndex);
  const blankEmailRowIndexes = kept.filter((r) => r.email === null).map((r) => r.rowIndex);
  const paddedEmailRowIndexes = kept.filter((r) => r.emailWasPadded).map((r) => r.rowIndex);

  // Resolved through the one shared helper, so a RESPONSE *group* counts and the
  // preview cannot disagree with what a written reviewer will actually get.
  const groupsById = new Map(input.groups.map((g) => [g.id, g]));
  const hasIncludedResponseField = input.fields.some((field) => {
    const group = field.groupId === null ? null : (groupsById.get(field.groupId) ?? null);
    const resolved = resolveField(field, group, "ADMIN");
    return resolved.isIncluded && resolved.category === FieldCategory.RESPONSE;
  });

  const blockers: string[] = [];
  if (!input.hasEmailColumn) {
    blockers.push("No email column is designated. It is the join key for the first-round imports.");
  }
  if (!input.hasNameColumn) {
    blockers.push("No name column is designated.");
  }
  if (kept.length === 0) {
    blockers.push("Every row is discarded. There would be no applicants to import.");
  }
  if (duplicates.length > 0) {
    blockers.push(
      `${duplicates.length} email address${duplicates.length === 1 ? " is" : "es are"} used by more than one row. ` +
        `Edit one of each pair or discard it.`,
    );
  }
  if (blankNameRowIndexes.length > 0) {
    blockers.push(
      `${blankNameRowIndexes.length} row${blankNameRowIndexes.length === 1 ? " has" : "s have"} no name. ` +
        `Every applicant needs one, even if the email is blank.`,
    );
  }

  const warnings: string[] = [];
  if (input.unconfirmedProposalCount > 0) {
    warnings.push(
      `${input.unconfirmedProposalCount} detected group${input.unconfirmedProposalCount === 1 ? " has" : "s have"} ` +
        `not been named or dismissed. Unconfirmed, those columns import as separate questions and will not ` +
        `appear in any demographic breakdown.`,
    );
  }
  if (!hasIncludedResponseField) {
    warnings.push(
      "No column is categorised as a Response. Written reviewers see only Response fields (§6), " +
        "so every profile in the written round will be empty.",
    );
  }
  if (blankEmailRowIndexes.length > 0) {
    warnings.push(
      `${blankEmailRowIndexes.length} row${blankEmailRowIndexes.length === 1 ? "" : "s"} ` +
        `have no email address. They will import, but cannot be matched by the first-round score import.`,
    );
  }
  if (paddedEmailRowIndexes.length > 0) {
    warnings.push(
      `${paddedEmailRowIndexes.length} email address${paddedEmailRowIndexes.length === 1 ? "" : "es"} ` +
        `had surrounding spaces in the file. They will be trimmed on import.`,
    );
  }

  return {
    rows,
    keptCount: kept.length,
    discardedCount: rows.length - kept.length,
    duplicates,
    blankNameRowIndexes,
    blankEmailRowIndexes,
    paddedEmailRowIndexes,
    unconfirmedProposalCount: input.unconfirmedProposalCount,
    hasIncludedResponseField,
    blockers,
    warnings,
    canCommit: blockers.length === 0,
  };
}
