// RFC 4180 parsing for the applicant export.
//
// Wraps csv-parse rather than hand-rolling, because the real export carries
// quoted newlines inside both headers and cells, CRLF record separators,
// doubled quotes, and a possible BOM. prisma/seed/headers.ts has a minimal
// one-record reader for the seed's narrow need; anything that reads data rows
// needs a real parser. prisma/fixtures/README.md enumerates what breaks a naive
// one.

import { parse } from "csv-parse/sync";

export interface ParsedCsv {
  /// Header text exactly as it appears in the file — newlines, curly quotes,
  /// trailing spaces and all. Becomes Field.sourceHeader verbatim; FR-2's
  /// display name is a separate, cleaned value.
  headers: string[];
  /// One entry per record, each the same length as `headers`.
  rows: string[][];
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

export function parseCsv(input: string | Buffer): ParsedCsv {
  let records: string[][];

  try {
    records = parse(input, {
      // A BOM would otherwise become part of the first header, so the email
      // column would not match its own name.
      bom: true,
      // NOT trim. Quinn Spacey's padded email in the fixture has to survive to
      // the preview so the admin is told it was trimmed, rather than the
      // importer silently fixing it. Normalisation happens at promotion.
      trim: false,
      // A ragged row means the file is not what it claims to be. Better to
      // refuse than to import rows whose columns have quietly shifted.
      relax_column_count: false,
      skip_empty_lines: false,
      columns: false,
    });
  } catch (error) {
    throw new CsvParseError(
      `Could not read the CSV: ${(error as Error).message}. ` +
        `Check that it is comma-separated and that quoted fields are closed.`,
    );
  }

  if (records.length === 0) throw new CsvParseError("The file is empty.");

  const [headers, ...rows] = records;

  if (headers.length === 0) throw new CsvParseError("The file has no header row.");

  // A trailing newline yields one empty record; drop it rather than importing a
  // blank applicant.
  const dataRows = rows.filter((row) => !(row.length === 1 && row[0] === ""));

  if (dataRows.length === 0) {
    throw new CsvParseError("The file has a header row but no applicants beneath it.");
  }

  const ragged = dataRows.findIndex((row) => row.length !== headers.length);
  if (ragged !== -1) {
    throw new CsvParseError(
      `Row ${ragged + 1} has ${dataRows[ragged].length} columns but the header has ` +
        `${headers.length}. Every row must have the same number of columns.`,
    );
  }

  return { headers, rows: dataRows };
}

/// Duplicate header text is legal — real form exports emit it — so Field.
/// sourceHeader is not unique. Reported so the mapping table can warn rather
/// than leaving the admin to spot two identically named rows.
export function duplicateHeaders(headers: readonly string[]): string[] {
  const seen = new Map<string, number>();
  for (const header of headers) seen.set(header, (seen.get(header) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([header]) => header);
}
