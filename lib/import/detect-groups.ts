// Group detection. PRD FR-2 and open decision 12.
//
// Detection produces a PROPOSAL, never a FieldGroup. The admin names it — which
// is what creates it and freezes its immutable key — or dismisses it. Doing
// neither is a third state that FR-3 warns about before commit, because
// committing past a proposal imports the columns as independent questions and
// leaves the §10.7 breakdown with nothing to read.
//
// Pure — headers and rows in, proposals out. No database, no Prisma.

/// A run of adjacent columns that look like one one-hot question.
///
/// A type alias rather than an interface on purpose: TypeScript gives implicit
/// index signatures to aliases but not to interfaces, and without one this is
/// not assignable to Prisma's JSON input type — which is where it goes, into
/// Instance.importProposals.
export type GroupProposal = {
  /// Column indexes into the header row, ascending and contiguous.
  columnIndexes: number[];
  /// The headers themselves, for rendering the proposal without a second lookup.
  headers: string[];
  /// Always true for a detected run: a set of one-hot columns is multi-checkable
  /// by construction. Carried so the admin confirms it rather than inheriting it
  /// silently.
  isMultiSelect: true;
};

/// Non-empty after trimming, NFC-normalised. Matches lib/field-groups.ts's
/// checked predicate — detection and counting must agree on what a filled cell
/// is, or a column could be detected on evidence the counter later ignores.
function normalize(value: string): string {
  return value.normalize("NFC").trim();
}

/// A column is a candidate when every non-empty value in it is the same literal
/// AND that literal is the column's own header.
///
/// Three guards, each killing a rule that looks reasonable until it meets the
/// fixture:
///
///   - At least one non-empty value. "Every non-empty value is the same literal"
///     is vacuously true over nothing, so an entirely empty column would qualify
///     on no evidence at all. `Other Major:` and `Tags` are empty across every
///     row of the fixture and would otherwise group with each other.
///   - Exactly one distinct value. Anything else is a free-text or categorical
///     column.
///   - That value EQUALS THE HEADER, compared exactly. A column of all "Yes" is
///     single-valued and is not a checkbox. And `Black` is a strict prefix of
///     `Black or African American`, so startsWith, includes, or a loose LIKE
///     maps one onto the other — only exact comparison separates them.
function isOneHotCandidate(header: string, column: readonly string[]): boolean {
  const target = normalize(header);
  if (target === "") return false;

  let sawValue = false;

  for (const raw of column) {
    const value = normalize(raw);
    if (value === "") continue;
    if (value !== target) return false;
    sawValue = true;
  }

  return sawValue;
}

/// Runs of two or more adjacent candidates.
///
/// The run minimum matters: `Anything else you would like us to know about you?`
/// has exactly one non-empty value in the fixture, which makes it single-valued
/// by accident. A one-column "group" is not a question spread across columns.
export const MIN_GROUP_SIZE = 2;

export function detectGroups(headers: readonly string[], rows: readonly string[][]): GroupProposal[] {
  const candidates = headers.map((header, index) =>
    isOneHotCandidate(
      header,
      rows.map((row) => row[index] ?? ""),
    ),
  );

  const proposals: GroupProposal[] = [];
  let runStart: number | null = null;

  const closeRun = (endExclusive: number) => {
    if (runStart === null) return;
    const length = endExclusive - runStart;
    if (length >= MIN_GROUP_SIZE) {
      const columnIndexes = Array.from({ length }, (_, i) => runStart! + i);
      proposals.push({
        columnIndexes,
        headers: columnIndexes.map((i) => headers[i]),
        isMultiSelect: true,
      });
    }
    runStart = null;
  };

  for (let i = 0; i < headers.length; i += 1) {
    if (candidates[i]) {
      if (runStart === null) runStart = i;
    } else {
      closeRun(i);
    }
  }
  closeRun(headers.length);

  return proposals;
}
