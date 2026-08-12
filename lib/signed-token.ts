// The HMAC envelope both session types sit inside. Pure — no cookie jar, no Next
// imports, no environment reads.
//
// Extracted when Phase 3 added a second session. There are now two kinds of
// signed cookie in this app — the admin one in lib/session.ts and the reviewer
// one in lib/reviewer-session.ts — and a second hand-rolled copy of "base64url
// the JSON, HMAC it, compare in constant time" is a place the two can silently
// disagree about what a valid token is. The same argument that put field
// visibility in one helper (§6) and reviewer-name checking in one gate
// (decision 25) applies with more force to a signature check.
//
// What lives here is the envelope and nothing else. Each session type keeps its
// own payload shape, its own structural validation, and its own expiry rule,
// because those genuinely differ and merging them would mean one module deciding
// what counts as a valid session for the other.

import { createHmac, timingSafeEqual } from "node:crypto";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function encodeSignedToken(payload: unknown, secret: string): string {
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

/// Returns the decoded payload, or null for anything that is not a
/// correctly-signed piece of JSON: absent, malformed, wrong signature, or not
/// parseable. The caller cannot tell those apart and should not — every one of
/// them means "no valid token".
///
/// **This deliberately does not validate shape or expiry.** Both are the
/// caller's, because both differ per session type. A token that parses here is
/// authentic, not necessarily currently usable.
export function decodeSignedToken(token: string | undefined, secret: string): unknown {
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

  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
