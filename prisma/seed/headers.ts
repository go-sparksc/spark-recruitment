import { readFileSync } from "node:fs";
import path from "node:path";

// The seed reads the real header row rather than transcribing it. Transcription
// would quietly normalize the things that actually matter — the curly
// apostrophes, the newlines inside quoted headers, the trailing spaces — and
// Phase 1 would then be built against headers cleaner than the ones it will meet.
//
// fixtures/sample-headers.csv is the header row of the application export with
// zero applicant rows. It is deliberately exempted from the *.csv gitignore rule.
const FIXTURE_PATH = path.join(process.cwd(), "fixtures", "sample-headers.csv");

export const EXPECTED_COLUMN_COUNT = 37;

/// Minimal RFC 4180 parse of the first record only. A header can contain commas,
/// doubled quotes, and newlines when quoted, so splitting on "," or reading one
/// line is wrong. Phase 1 will need a real CSV parser; this reads one row.
function parseFirstRecord(text: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      break; // end of the header record
    } else {
      field += char;
    }
  }

  fields.push(field);
  return fields;
}

export function readSourceHeaders(): string[] {
  let text: string;
  try {
    text = readFileSync(FIXTURE_PATH, "utf8");
  } catch {
    throw new Error(
      `Could not read ${FIXTURE_PATH}. The seed derives its field catalog from the ` +
        `real export's header row; without it the seed would be a fiction.`,
    );
  }

  const headers = parseFirstRecord(text.replace(/^﻿/, ""));

  if (headers.length !== EXPECTED_COLUMN_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_COLUMN_COUNT} columns in sample-headers.csv, parsed ${headers.length}. ` +
        `If the export's shape genuinely changed, update EXPECTED_COLUMN_COUNT and the field ` +
        `catalog in prisma/seed/fields.ts together — they are indexed against each other.`,
    );
  }

  return headers;
}
