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
  /// Instance ids unlocked with their own passwords.
  ins: string[];
  /// Absolute expiry, unix seconds. Not sliding: a session that renews itself
  /// indefinitely on a shared password is worse than one that asks again after
  /// a working day.
  exp: number;
}

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
  const { adm, ins, exp } = parsed as Record<string, unknown>;

  if (typeof adm !== "boolean" || typeof exp !== "number") return null;
  if (!Array.isArray(ins) || !ins.every((id) => typeof id === "string")) return null;
  if (nowSeconds >= exp) return null;

  return { adm, ins, exp };
}

export function newSession(nowSeconds: number): SessionPayload {
  return { adm: true, ins: [], exp: nowSeconds + SESSION_TTL_SECONDS };
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
