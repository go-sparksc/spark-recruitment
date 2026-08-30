// Signed-cookie session encoding. PRD §8.
//
// Two independent facts live in one cookie: whether the holder cleared the
// app-level gate, and which instances they have unlocked. They are separate
// because the gates are separate — FR-5 puts password reset and instance
// deletion behind the app password ALONE, which is what makes its recovery path
// exist.
//
// No session table: §5 has no session model and adding one is a schema change
// no requirement asks for. The cost is that a session cannot be revoked
// server-side before it expires, and the mitigation is the one you would reach
// for anyway — rotating SESSION_SECRET invalidates every session at once, which
// is exactly what you do if a shared password leaks. Both rotate together.
//
// Pure: no cookie jar, no Next imports, no environment reads. lib/auth.ts binds
// this to the request.

import { decodeSignedToken, encodeSignedToken } from "@/lib/signed-token";

export interface SessionPayload {
  /// Cleared the app-level gate.
  adm: boolean;
  /// The name typed at sign-in, "First Last". PRD decision 16.
  ///
  /// **Not a credential and not an identity claim the app verifies.** It is
  /// checked against nothing — there is no admin roster to check it against —
  /// and anyone holding the shared password can type anything. What it buys is
  /// attribution on the audit row: among 2-6 E-Board members who already trust
  /// each other, "who ran this" stops being unanswerable. Treating it as
  /// authentication would be worse than not having it, because it would imply a
  /// guarantee one shared password cannot make.
  nm: string;
  /// Instance ids unlocked with their own passwords.
  ins: string[];
  /// Absolute expiry, unix seconds. Not sliding: a session that renews itself
  /// indefinitely on a shared password is worse than one that asks again after
  /// a working day.
  exp: number;
}

/// Longest name accepted at sign-in. Long enough for a real name with a
/// hyphenated surname; short enough that the cookie stays small and the audit
/// table cannot be used as free storage by anyone holding the app password.
export const MAX_ADMIN_NAME_LENGTH = 60;

export const SESSION_COOKIE = "spark_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export function encodeSession(payload: SessionPayload, secret: string): string {
  return encodeSignedToken(payload, secret);
}

/// Returns null for anything that is not a currently valid session: malformed,
/// wrong signature, expired, or structurally wrong. The caller cannot tell those
/// apart, and should not — every one of them means "not signed in".
///
/// The signature check lives in lib/signed-token.ts, shared with the reviewer
/// session. What stays here is the shape and the expiry, which are this session
/// type's own and differ from the reviewer's.
export function decodeSession(
  token: string | undefined,
  secret: string,
  nowSeconds: number,
): SessionPayload | null {
  const parsed = decodeSignedToken(token, secret);

  if (typeof parsed !== "object" || parsed === null) return null;
  const { adm, nm, ins, exp } = parsed as Record<string, unknown>;

  if (typeof adm !== "boolean" || typeof exp !== "number") return null;
  // Required, not defaulted. A session minted before Phase 8 carries no name, and
  // treating it as valid would put unattributed rows in the audit table for the
  // remaining life of that cookie — silently, and for up to twelve hours after
  // the deploy. Refusing it costs each admin one sign-in, once, which is the
  // whole point: the name is collected there.
  if (typeof nm !== "string" || nm.length === 0) return null;
  if (!Array.isArray(ins) || !ins.every((id) => typeof id === "string")) return null;
  if (nowSeconds >= exp) return null;

  return { adm, nm, ins, exp };
}

export function newSession(name: string, nowSeconds: number): SessionPayload {
  return { adm: true, nm: name, ins: [], exp: nowSeconds + SESSION_TTL_SECONDS };
}

/// Collapse a typed first and last name into what the audit row stores.
///
/// Pure, and here rather than in the action, because it decides what appears in
/// the audit table and that is worth testing without a form in front of it.
/// Returns null when there is not enough to attribute anything to — the caller
/// turns that into a form error rather than storing a blank signature.
export function adminDisplayName(first: string, last: string): string | null {
  const joined = `${first.trim()} ${last.trim()}`.replace(/\s+/g, " ").trim();

  if (joined.length === 0) return null;
  return joined.slice(0, MAX_ADMIN_NAME_LENGTH);
}

/// Unlocking an instance adds it to the existing session rather than minting a
/// new one, so the expiry stays absolute from sign-in.
export function withInstance(session: SessionPayload, instanceId: string): SessionPayload {
  if (session.ins.includes(instanceId)) return session;
  return { ...session, ins: [...session.ins, instanceId] };
}

/// Where to send someone after signing in.
///
/// Only a path on this origin is acceptable. `//evil.example` and
/// `https://evil.example` are both open redirects, and the first is easy to miss
/// because it looks relative.
export function safeRedirect(next: string | null | undefined, fallback = "/"): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//")) return fallback;
  if (next.includes("\\")) return fallback;
  return next;
}
