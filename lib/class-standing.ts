// Decision 119's class standing. Pure — no database, no Prisma client.
//
// Two inputs: the applicant's answer in the designated graduation-date column,
// and the instance's current semester. The decision's table is the spec, and
// `lib/class-standing.test.ts` walks every row of it.
//
// Nothing here decides whether class standing is shown. That is the source
// column's visibility, resolved by `lib/fields.ts`; this module only answers
// "what does this answer say", for a caller that has already established the
// viewer may read the answer at all.

/// The two seasons the real form's dropdown offers. A string union rather than
/// the Prisma `TermSeason` enum so this module stays importable from a test with
/// no generated client; the enum's values are these same strings, so a row read
/// through Prisma is assignable here unchanged.
export type Season = "SPRING" | "FALL";

export interface Term {
  season: Season;
  year: number;
}

export type ClassStanding =
  | "Senior"
  | "Junior"
  | "Sophomore"
  | "Freshman"
  | "Non-standard"
  | "Unknown";

/// Whole-string match, and nothing looser. Decision 119: trimmed, internal
/// whitespace collapsed, case ignored, and the *entire* value a season word then
/// a four-digit year.
///
/// **No substring matching, on purpose.** `Spring 2030 or later` contains a valid
/// term and must not parse as one — the dropdown's last option is deliberately
/// Non-standard. The same anchoring is what turns `Summer 2027`, `May 2027` and
/// `Spring '27` into Non-standard without a rule for any of them: they are simply
/// not in the vocabulary, and decision 119 says a successor should not add
/// carve-outs.
///
/// Any four digits, not `20\d\d`. The decision says "a four-digit year", and a
/// narrower pattern would be a second, unrecorded rule.
const TERM_PATTERN = /^(spring|fall) (\d{4})$/;

/// `Spring 2027` → `{ season: "SPRING", year: 2027 }`. Null for anything that is
/// not exactly a term, blank included — telling blank apart from off-format is
/// `classStanding`'s job, because the two mean different things.
export function parseTerm(raw: string): Term | null {
  const normalized = raw.trim().replace(/\s+/g, " ").toLowerCase();
  const match = TERM_PATTERN.exec(normalized);
  if (match === null) return null;
  return { season: match[1] === "fall" ? "FALL" : "SPRING", year: Number(match[2]) };
}

/// The furthest a five-year program's student can be from graduating: a student
/// who starts in a Fall graduates in the Spring five years later, 9 semesters
/// on. Decision 119, as amended on 2026-09-12. Spark's pool includes legitimate
/// five-year programs, so the four-year maximum of 7 was rejected. The table
/// first read Freshman as "6 or more", so an obvious typo like `Spring 2207` read
/// as a confident Freshman.
///
/// **This does not make five-year students' labels right**, and a successor
/// should not read it that way. The ranges below are still a four-year count, so
/// a five-year student in years two to four reads one class younger than they
/// are. The decision records why no ceiling can fix that.
export const MAX_SEMESTERS_OUT = 9;

/// A term's position on one line: `year × 2`, plus one for Fall. Spring precedes
/// Fall within a calendar year, so consecutive terms differ by exactly one, and
/// "semesters out" is a subtraction.
export function termIndex(term: Term): number {
  return term.year * 2 + (term.season === "FALL" ? 1 : 0);
}

/// Decision 119's table, for one answer against the cycle's current semester.
///
/// `raw` is `unknown` because it comes straight out of `Applicant.data`, which
/// holds verbatim CSV strings but is JSONB and so types as anything. Missing and
/// null are blank, exactly as an unanswered optional question is.
///
/// **Blank is Unknown; every other failure is Non-standard.** The two are not
/// interchangeable: Unknown is "nothing to read", Non-standard is "read the raw
/// answer yourself", and the raw answer is rendered right above the label.
///
/// **A parseable term in the past is Non-standard, not Senior.** Someone whose
/// graduation date has already gone by is not on a four-year undergraduate
/// timeline, and Non-standard exists so the tool never prints a wrong label.
///
/// **So is one beyond `MAX_SEMESTERS_OUT`**, for the same reason from the other
/// side. Freshman covers 6–9, not "6 or more". Past 9 the answer fits no program
/// in the pool, whether it is a typo or a real plan, and the raw answer above the
/// label is what a reviewer should read.
export function classStanding(raw: unknown, current: Term): ClassStanding {
  const text = raw === null || raw === undefined ? "" : typeof raw === "string" ? raw : String(raw);
  if (text.trim() === "") return "Unknown";

  const graduation = parseTerm(text);
  if (graduation === null) return "Non-standard";

  const semestersOut = termIndex(graduation) - termIndex(current);
  if (semestersOut < 0 || semestersOut > MAX_SEMESTERS_OUT) return "Non-standard";
  if (semestersOut <= 1) return "Senior";
  if (semestersOut <= 3) return "Junior";
  if (semestersOut <= 5) return "Sophomore";
  return "Freshman";
}
