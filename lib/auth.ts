import "server-only";

// Request-bound authorization. PRD §8 and FR-5.
//
// requireAdmin() and requireInstance() are called in every page AND inside every
// server action. Not only in proxy.ts: Next's own guidance is that proxy-layer
// checks are not an authorization boundary, because a server action is reachable
// without passing through one. The proxy does a cheap redirect for signed-out
// visitors and nothing security-critical depends on it.
//
// The pure halves live in lib/session.ts and lib/rate-limit.ts and are tested
// there. This module is the part that touches cookies, headers and env, which is
// why it is thin.

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { verifySecret } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { createAttemptLimiter, PASSWORD_ATTEMPT_POLICY } from "@/lib/rate-limit";
import {
  decodeSession,
  encodeSession,
  newSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  withInstance,
  type SessionPayload,
} from "@/lib/session";

/// Fails closed. A missing secret must stop the app rather than quietly leaving
/// the instance list — which §8 says must not be publicly enumerable — open.
function requireEnv(name: "ADMIN_PASSWORD_HASH" | "SESSION_SECRET"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in; ` +
        `run \`npm run hash-secret\` to generate ADMIN_PASSWORD_HASH.`,
    );
  }
  return value;
}

/// Next expands `$VAR` inside .env files, and an argon2id digest is five
/// $-delimited fields. Unescaped, what arrives here is a mangled string and
/// argon2 reports "password hash string missing field" — which reads like a
/// corrupted secret rather than a quoting mistake, and costs an hour. Catch it
/// where the fix can be named.
function adminPasswordHash(): string {
  const value = requireEnv("ADMIN_PASSWORD_HASH");
  if (!value.startsWith("$argon2")) {
    throw new Error(
      "ADMIN_PASSWORD_HASH does not look like an argon2 digest. In a .env file every " +
        "dollar sign must be escaped as \\$, because Next expands $VAR references. " +
        "Run `npm run hash-secret -- \"your password\"`, which prints it already escaped. " +
        "Values set in a hosting dashboard are not expanded and must not be escaped.",
    );
  }
  return value;
}

// Module-level so it survives between requests within a process. See PRD open
// decision 19 for what this does and does not cover.
//
// Exported because lib/reviewer-auth.ts gates the round access code through the
// same limiter rather than standing up a second one. Buckets are namespaced by
// scope, so the two never share an allowance; what sharing the instance buys is
// one bounded map and one prune, instead of two that grow independently.
export const limiter = createAttemptLimiter(PASSWORD_ATTEMPT_POLICY);

/// Best-effort client identifier for rate limiting. On Vercel x-forwarded-for is
/// set by the platform; locally it usually is not. Falling back to a shared
/// bucket is deliberate — an attacker who strips the header lands in the same
/// bucket as everyone else rather than escaping the limiter entirely.
///
/// Exported for the same reason as the limiter: a second copy of this parsing is
/// a place the two gates can come to disagree about who a caller is.
export async function attemptKey(scope: string): Promise<string> {
  const forwarded = (await headers()).get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  return `${scope}:${ip}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function readSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return decodeSession(token, requireEnv("SESSION_SECRET"), nowSeconds());
}

async function writeSession(session: SessionPayload): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, encodeSession(session, requireEnv("SESSION_SECRET")), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export interface AttemptResult {
  ok: boolean;
  /// Populated when the attempt was refused without checking the password.
  lockedForSeconds?: number;
}

/// Verify the app-level password and start a session.
///
/// The limiter is consulted BEFORE the argon2 verify, so a locked-out caller
/// costs nothing to refuse and learns nothing about the password.
export async function signInAsAdmin(password: string): Promise<AttemptResult> {
  const key = await attemptKey("admin");
  const verdict = limiter.check(key);
  if (!verdict.allowed) {
    return { ok: false, lockedForSeconds: Math.ceil(verdict.retryAfterMs / 1000) };
  }

  const valid = await verifySecret(adminPasswordHash(), password);
  if (!valid) {
    const after = limiter.recordFailure(key);
    return {
      ok: false,
      ...(after.allowed ? {} : { lockedForSeconds: Math.ceil(after.retryAfterMs / 1000) }),
    };
  }

  limiter.reset(key);
  await writeSession(newSession(nowSeconds()));
  return { ok: true };
}

/// Verify one instance's password and add it to the session.
export async function unlockInstance(instanceId: string, password: string): Promise<AttemptResult> {
  await requireAdmin();

  const key = await attemptKey(`instance:${instanceId}`);
  const verdict = limiter.check(key);
  if (!verdict.allowed) {
    return { ok: false, lockedForSeconds: Math.ceil(verdict.retryAfterMs / 1000) };
  }

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { passwordHash: true },
  });
  if (!instance) return { ok: false };

  const valid = await verifySecret(instance.passwordHash, password);
  if (!valid) {
    const after = limiter.recordFailure(key);
    return {
      ok: false,
      ...(after.allowed ? {} : { lockedForSeconds: Math.ceil(after.retryAfterMs / 1000) }),
    };
  }

  limiter.reset(key);
  const session = (await readSession()) ?? newSession(nowSeconds());
  await writeSession(withInstance(session, instanceId));
  return { ok: true };
}

/// Grant access to an instance the caller just created. They typed its password
/// a moment ago; asking again immediately is friction with no security value.
export async function grantInstance(instanceId: string): Promise<void> {
  const session = (await readSession()) ?? newSession(nowSeconds());
  await writeSession(withInstance(session, instanceId));
}

/// The app-level gate. Redirects rather than throwing, so a signed-out admin
/// following a bookmark lands on the login form and returns where they meant to
/// go.
export async function requireAdmin(next?: string): Promise<SessionPayload> {
  const session = await readSession();
  if (!session?.adm) {
    redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  }
  return session;
}

/// The per-instance gate. Callers that need only app-level access — password
/// reset and instance deletion, per FR-5 — call requireAdmin() instead, and
/// deliberately not this.
export async function requireInstance(instanceId: string, next?: string): Promise<SessionPayload> {
  const session = await requireAdmin(next);
  if (!session.ins.includes(instanceId)) {
    redirect(`/instances/${instanceId}/unlock${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  }
  return session;
}

/// For the proxy and for rendering: does not redirect.
export async function isSignedIn(): Promise<boolean> {
  return (await readSession())?.adm === true;
}
