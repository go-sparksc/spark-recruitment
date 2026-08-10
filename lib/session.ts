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

import { createHmac, timingSafeEqual } from "node:crypto";

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

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function encodeSession(payload: SessionPayload, secret: string): string {
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

/// Returns null for anything that is not a currently valid session: malformed,
/// wrong signature, expired, or structurally wrong. The caller cannot tell those
/// apart, and should not — every one of them means "not signed in".
export function decodeSession(
  token: string | undefined,
  secret: string,
  nowSeconds: number,
): SessionPayload | null {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;

  const expected = sign(encoded, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch, and a
  // differing length is already a failed signature.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

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
