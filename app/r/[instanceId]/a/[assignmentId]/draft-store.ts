// The localStorage mirror from PRD decisions 26 and 37.
//
// **This is the guarantee, not the dialogs.** Decision 26 is explicit that the
// "still saving" hold and `beforeunload` only reduce how often a restore is
// needed; what makes "never a silent loss" true is that every change is written
// here before any save is attempted, and removed only once the server has
// confirmed it. It is the one component that survives the operating system
// killing the tab.
//
// Decision 37 governs what clears it: a confirmed save, signing out, and a
// 7-day TTL. Nothing here ever stores an applicant's name, email, or even their
// anonymous label — a reader of this storage sees an opaque assignment id and
// some prose, with nothing in it saying who the prose is about. That property is
// load-bearing rather than incidental; preserve it.

import { type DraftValue } from "@/lib/autosave";

const PREFIX = "spark-review:draft:";

/// Matches REVIEWER_SESSION_TTL_SECONDS. A draft that outlives the session that
/// could have saved it is not a draft any more. See decision 37.
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface DraftRecord {
  /// Bumped if the shape ever changes, so an old record is dropped rather than
  /// half-read into a new one.
  v: 1;
  updatedAt: number;
  fields: Record<string, DraftValue>;
}

/// Every entry point is wrapped, because `localStorage` is not reliably there.
/// Safari in private browsing throws on write, a full quota throws on write, and
/// a locked-down browser can throw on mere access. **The mirror failing must
/// never take the score card down with it** — a reviewer with no localStorage
/// should still be able to score, they simply lose the offline guarantee.
function withStorage<T>(fallback: T, run: (storage: Storage) => T): T {
  try {
    if (typeof window === "undefined") return fallback;
    const storage = window.localStorage;
    if (!storage) return fallback;
    return run(storage);
  } catch {
    return fallback;
  }
}

const keyFor = (assignmentId: string) => `${PREFIX}${assignmentId}`;

function parse(raw: string | null): DraftRecord | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<DraftRecord>;
    if (record.v !== 1 || typeof record.updatedAt !== "number") return null;
    if (typeof record.fields !== "object" || record.fields === null) return null;
    return { v: 1, updatedAt: record.updatedAt, fields: record.fields };
  } catch {
    return null;
  }
}

/// What was typed and never confirmed, for this assignment.
///
/// Returns `{}` rather than throwing for a record that is missing, corrupt, of
/// an old shape, or past its TTL. An expired record is deleted on the way past,
/// so the TTL is enforced by reading rather than needing a sweep — which matters
/// because there is no background task on a page nobody has opened.
export function readDraft(assignmentId: string, nowMs = Date.now()): Record<string, DraftValue> {
  return withStorage<Record<string, DraftValue>>({}, (storage) => {
    const record = parse(storage.getItem(keyFor(assignmentId)));
    if (!record) return {};

    if (nowMs - record.updatedAt > DRAFT_TTL_MS) {
      storage.removeItem(keyFor(assignmentId));
      return {};
    }

    return record.fields;
  });
}

export function writeDraftField(
  assignmentId: string,
  key: string,
  value: DraftValue,
  nowMs = Date.now(),
): void {
  withStorage(undefined, (storage) => {
    const existing = parse(storage.getItem(keyFor(assignmentId)));
    const record: DraftRecord = {
      v: 1,
      updatedAt: nowMs,
      fields: { ...(existing?.fields ?? {}), [key]: value },
    };
    storage.setItem(keyFor(assignmentId), JSON.stringify(record));
  });
}

/// Drop one field. Called only on a confirmed save with nothing newer pending —
/// see lib/autosave.ts, which is where that condition is decided and tested.
export function clearDraftField(assignmentId: string, key: string, nowMs = Date.now()): void {
  withStorage(undefined, (storage) => {
    const existing = parse(storage.getItem(keyFor(assignmentId)));
    if (!existing) return;

    const fields = { ...existing.fields };
    delete fields[key];

    // An empty record is removed rather than left as an empty husk, so the
    // storage holds one key per assignment with genuinely unsaved work and
    // nothing else.
    if (Object.keys(fields).length === 0) {
      storage.removeItem(keyFor(assignmentId));
      return;
    }

    storage.setItem(keyFor(assignmentId), JSON.stringify({ v: 1, updatedAt: nowMs, fields }));
  });
}

/// Every draft for one assignment. Decision 38's return-to-pool clear.
///
/// **Why the whole key rather than `clearDraftField` per key:** a return is not
/// a save. The reviewer no longer holds the assignment afterwards, so the save
/// path refuses every subsequent write for it and nothing in this record can
/// ever be flushed. Left behind it would sit for the full TTL as reviewer-
/// authored text about an applicant they have just recused themselves from,
/// which is the exposure decision 37 exists to bound in its least defensible
/// form.
///
/// Carries decision 37's caveat unchanged: this runs as a client-side side
/// effect on the return's submit, so a return tapped before hydration returns
/// the applicant and leaves the draft. The TTL is the backstop.
export function clearDraft(assignmentId: string): void {
  withStorage(undefined, (storage) => {
    storage.removeItem(keyFor(assignmentId));
  });
}

/// Every draft, for every assignment. Decision 37's sign-out clear.
///
/// Note what this cannot cover, per that decision: sign-out is a server action
/// and this runs as a side effect of its submit, so a sign-out tapped before the
/// page hydrates signs the reviewer out and leaves the drafts behind. Clearing
/// browser storage is not something a server action can do. The TTL is the
/// backstop for exactly that case.
export function clearAllDrafts(): void {
  withStorage(undefined, (storage) => {
    const doomed: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(PREFIX)) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  });
}

/// Drop every expired record, wherever it came from. Called on mount so that
/// opening any applicant tidies up after abandoned ones — the TTL otherwise only
/// applies to drafts someone happens to revisit.
export function purgeExpiredDrafts(nowMs = Date.now()): void {
  withStorage(undefined, (storage) => {
    const doomed: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(PREFIX)) continue;
      const record = parse(storage.getItem(key));
      if (record === null || nowMs - record.updatedAt > DRAFT_TTL_MS) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  });
}
