// Who to record on an AuditLog row. PRD decisions 16 and 93.
//
// Pure: takes a session, returns two columns. No Prisma, no cookies — every
// caller already holds the session, because every one of them has been through
// requireAdmin() or requireInstance() before it gets here.
//
// This exists so that twenty `auditLog.create` call sites do not each spell out
// their own actor. They previously wrote `actor: "admin"` by hand, and a literal
// repeated twenty times is a literal that gets updated nineteen times.

import type { SessionPayload } from "@/lib/session";

/// The two actor columns of an `AuditLog` row, ready to spread into `data`.
export interface AuditActor {
  actor: string;
  actorName: string | null;
}

/// An action a person took, signed with the name they gave at sign-in.
///
/// `actor` stays the ROLE. It is not the place the name goes — see decision 93,
/// and note that `Decision.actor` is a different column of the same name whose
/// `SYSTEM` value must never carry a person.
export function auditActor(session: SessionPayload): AuditActor {
  return { actor: "admin", actorName: session.nm };
}

/// An action nobody took: a rate-limit lockout, or anything else the application
/// does on its own. `actorName` is null because there is genuinely no person,
/// which is a different thing from a person whose name was not recorded.
export const SYSTEM_ACTOR: AuditActor = { actor: "system", actorName: null };

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
//
// These live here rather than inside the audit page because CLAUDE.md's Phase 5
// lesson applies: a page that transforms query results before rendering them
// puts the transformation somewhere it can be tested, and keeps only the query.

/// How to name whoever acted, for a reader.
///
/// **Three cases, and collapsing any two of them loses information.**
///
///   - A name: the admin signed in after Phase 8 and typed it.
///   - `"admin"` with no name: the action predates decision 16's name prompt.
///     "An admin" is the honest rendering, and is exactly what §8 could promise
///     before that decision — not a gap to be papered over with "Unknown".
///   - `"system"`: nobody acted. The limiter wrote it. Rendering this as
///     "an admin" would invent a person, which is the one thing an attribution
///     table must never do.
export function actorLabel(row: AuditActor): string {
  if (row.actorName !== null && row.actorName.trim() !== "") return row.actorName;
  return row.actor === "system" ? "The system" : "An admin (before names were recorded)";
}

/// Turn `RESET_INSTANCE_PASSWORD` into `Reset instance password`.
///
/// Actions are written as SCREAMING_SNAKE constants at the call sites and are
/// not a closed set — a new action should read correctly here without anyone
/// remembering to add it to a lookup table, which is why this transforms rather
/// than maps.
export function humanizeAction(action: string): string {
  const words = action.toLowerCase().split("_").filter(Boolean);
  if (words.length === 0) return action;

  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? " " + words.slice(1).join(" ") : "");
}

export interface AuditPageWindow {
  /// Rows to skip, for the query.
  skip: number;
  /// Rows to take, for the query.
  take: number;
  /// The page actually being shown, 1-based and clamped into range.
  page: number;
  pageCount: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/// Where one page of the audit log starts and ends.
///
/// Clamps rather than trusting the URL: `?page=0`, `?page=-3` and `?page=999`
/// are all things a reader will produce by editing the address bar, and a
/// negative `skip` is a Prisma error rather than an empty page.
export function auditPageWindow(total: number, requested: number, perPage: number): AuditPageWindow {
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, Math.floor(requested) || 1), pageCount);

  return {
    skip: (page - 1) * perPage,
    take: perPage,
    page,
    pageCount,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
  };
}

/// Rows per page on the audit screen. Enough that a cycle's routine activity
/// fits in one or two pages; few enough that the page stays readable on the
/// phone an admin is holding when something looks wrong.
export const AUDIT_PAGE_SIZE = 50;
