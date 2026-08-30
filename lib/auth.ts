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
import { PASSWORD_ATTEMPT_POLICY } from "@/lib/rate-limit";
import { checkKey, pruneSpent, recordFailure, resetKey } from "@/lib/rate-limit-store";
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

/// Best-effort client identifier for rate limiting. On Vercel x-forwarded-for is
/// set by the platform; locally it usually is not. Falling back to a shared
/// bucket is deliberate — an attacker who strips the header lands in the same
/// bucket as everyone else rather than escaping the limiter entirely.
///
/// Exported because lib/reviewer-auth.ts keys its gate the same way: a second
/// copy of this parsing is a place the two gates can come to disagree about who
/// a caller is. Scopes keep their buckets apart, so sharing the shape costs no
/// gate any of another's allowance.
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
  /// Set when the cycle has been archived and purged, so the caller can say so
  /// instead of reporting a wrong code. Reviewer sign-in only — PRD decision 95.
  archived?: boolean;
}

/// Verify the app-level password and start a session.
///
/// The limiter is consulted BEFORE the argon2 verify, so a locked-out caller
/// costs nothing to refuse and learns nothing about the password.
/// `name` is the signature decision 16 asks for, already collapsed to "First
/// Last" by `adminDisplayName`. It is recorded, never verified — see
/// SessionPayload.nm. Deliberately not part of the rate-limit key either: a
/// second field an attacker controls would let them mint a fresh allowance per
/// guess just by changing the name.
export async function signInAsAdmin(name: string, password: string): Promise<AttemptResult> {
  const key = await attemptKey("admin");
  const verdict = await checkKey(key, PASSWORD_ATTEMPT_POLICY);
  if (!verdict.allowed) {
    return { ok: false, lockedForSeconds: Math.ceil(verdict.retryAfterMs / 1000) };
  }

  const valid = await verifySecret(adminPasswordHash(), password);
  if (!valid) {
    // null: the app-level gate belongs to no instance, so its lockout row is
    // orphaned by design and sits outside every export. Decision 92.
    const { verdict: after } = await recordFailure(key, null, PASSWORD_ATTEMPT_POLICY);
    return {
      ok: false,
      ...(after.allowed ? {} : { lockedForSeconds: Math.ceil(after.retryAfterMs / 1000) }),
    };
  }

  await resetKey(key);
  // Opportunistic, and deliberately not awaited for correctness — a failed prune
  // must not fail a correct sign-in. See pruneSpent for why there is no cron.
  await pruneSpent(PASSWORD_ATTEMPT_POLICY).catch(() => {});
  await writeSession(newSession(name, nowSeconds()));
  return { ok: true };
}

/// Verify one instance's password and add it to the session.
export async function unlockInstance(instanceId: string, password: string): Promise<AttemptResult> {
  // Keep the session requireAdmin already read. Re-reading it below and falling
  // back to a fresh one would mint a session with no name on it, which
  // decodeSession now refuses — so the admin would unlock the instance and be
  // signed out by their next request.
  const session = await requireAdmin();

  const key = await attemptKey(`instance:${instanceId}`);
  const verdict = await checkKey(key, PASSWORD_ATTEMPT_POLICY);
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
    // This gate belongs to an instance, so its lockout row carries that id and
    // shows up in the instance's audit view and its FR-20 export.
    const { verdict: after } = await recordFailure(key, instanceId, PASSWORD_ATTEMPT_POLICY);
    return {
      ok: false,
      ...(after.allowed ? {} : { lockedForSeconds: Math.ceil(after.retryAfterMs / 1000) }),
    };
  }

  await resetKey(key);
  await writeSession(withInstance(session, instanceId));
  return { ok: true };
}

/// Grant access to an instance the caller just created. They typed its password
/// a moment ago; asking again immediately is friction with no security value.
///
/// Takes the session rather than re-reading it, for the reason unlockInstance
/// gives: there is no correct nameless session to fall back to, and every caller
/// has already been through requireAdmin.
export async function grantInstance(
  session: SessionPayload,
  instanceId: string,
): Promise<void> {
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
  const session = await requireInstanceUnlocked(instanceId, next);

  // An archived cycle is read-only. Its live screens would render blank names
  // and empty essays beside real scores, which reads as data loss rather than as
  // retention — so every surface that goes through this gate lands on the
  // archive summary instead. PRD decision 95.
  //
  // The check is here rather than on each page for the same reason the gate
  // itself is: a server action is a POST endpoint reachable without rendering
  // the page that hosts it, and an action that mutated a purged cycle would be
  // writing against applicant rows that no longer hold applicants.
  const archived = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { archivedAt: true },
  });
  if (archived?.archivedAt != null) redirect(`/instances/${instanceId}/archive`);

  return session;
}

/// The instance gate WITHOUT the archived check.
///
/// Three callers, and each would break under `requireInstance`:
///
///   - the archive summary page itself, which would redirect to itself forever;
///   - FR-20's export, which is the escape hatch an archived cycle most needs —
///     decision 95 keeps `Instance.passwordHash` precisely so these two stay
///     openable;
///   - the audit view, whose whole subject is what was done to the cycle,
///     including the purge.
///
/// **Not a way around the read-only rule.** Anything that mutates, or that
/// renders applicant data the purge emptied, calls `requireInstance`. If you are
/// reaching for this to make a page load, the page wants the archive summary
/// instead.
export async function requireInstanceUnlocked(
  instanceId: string,
  next?: string,
): Promise<SessionPayload> {
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
