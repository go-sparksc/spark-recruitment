import "server-only";

// Request-bound authorization for reviewers. PRD §8 and FR-9.
//
// The mirror of lib/auth.ts, for the other kind of caller. Reviewers never pass
// the app-level gate and never see the instance list; they arrive on a
// per-instance link, pick a round and a name, and enter that round's access
// code.
//
// requireReviewer() is called in every reviewer page AND inside every reviewer
// action, for the same reason requireAdmin() is: a server action is a POST
// endpoint reachable without passing through the page that renders its form, so
// render-time gating is not a boundary.
//
// The pure half lives in lib/reviewer-session.ts and is tested there. This
// module is the part that touches cookies, headers and env, which is why it is
// thin.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Round } from "@/generated/prisma/enums";
import { attemptKey, limiter, type AttemptResult } from "@/lib/auth";
import { verifySecret } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import {
  decodeReviewerSession,
  encodeReviewerSession,
  newReviewerSession,
  REVIEWER_COOKIE,
  REVIEWER_SESSION_TTL_SECONDS,
  type ReviewerSessionPayload,
} from "@/lib/reviewer-session";

/// Fails closed, same as lib/auth.ts. A missing secret must stop the app rather
/// than quietly accepting unsigned cookies.
function sessionSecret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) {
    throw new Error(
      "SESSION_SECRET is not set. Copy .env.example to .env and fill it in.",
    );
  }
  return value;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function signInPath(instanceId: string, round?: Round): string {
  return round ? `/r/${instanceId}?round=${round}` : `/r/${instanceId}`;
}

/// Read the reviewer session for one instance, without redirecting.
///
/// The instance id is passed through to `decodeReviewerSession`, which refuses a
/// session issued for a different instance — so a reviewer cannot reach another
/// cycle by editing the URL.
export async function readReviewer(instanceId: string): Promise<ReviewerSessionPayload | null> {
  const token = (await cookies()).get(REVIEWER_COOKIE)?.value;
  return decodeReviewerSession(token, sessionSecret(), instanceId, nowSeconds());
}

async function writeReviewerSession(session: ReviewerSessionPayload): Promise<void> {
  (await cookies()).set(REVIEWER_COOKIE, encodeReviewerSession(session, sessionSecret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: REVIEWER_SESSION_TTL_SECONDS,
  });
}

export async function signOutReviewer(): Promise<void> {
  (await cookies()).delete(REVIEWER_COOKIE);
}

/// Verify a round access code and start a reviewer session.
///
/// The limiter is consulted BEFORE the argon2 verify, so a locked-out caller
/// costs nothing to refuse and learns nothing about the code. Keyed on the
/// instance, the round and the client address together: one round's code being
/// hammered must not lock reviewers out of another round, and §8's shared code
/// means every reviewer of a round shares one bucket per address anyway.
///
/// Returns the same shape as the admin gates and says nothing about WHICH part
/// was wrong. A caller who learns that the name was fine but the code was not
/// has been told the roster is real.
export async function signInReviewer(
  instanceId: string,
  round: Round,
  reviewerId: string,
  code: string,
): Promise<AttemptResult> {
  const key = await attemptKey(`reviewer:${instanceId}:${round}`);
  const verdict = limiter.check(key);
  if (!verdict.allowed) {
    return { ok: false, lockedForSeconds: Math.ceil(verdict.retryAfterMs / 1000) };
  }

  const [accessCode, reviewer] = await Promise.all([
    prisma.roundAccessCode.findUnique({
      where: { instanceId_round: { instanceId, round } },
      select: { codeHash: true },
    }),
    // Scoped to the instance AND the round. A reviewer who serves only the
    // second round is not a written-round reviewer, and picking their name from
    // a stale page must not sign them in here.
    prisma.reviewer.findFirst({
      where: { id: reviewerId, instanceId, rounds: { has: round } },
      select: { id: true },
    }),
  ]);

  // A missing code and a missing reviewer both fail, and both fail the same way
  // as a wrong code. Counting them as failures is deliberate: otherwise an
  // unlimited stream of requests with a bogus reviewer id costs nothing.
  if (!accessCode || !reviewer || !(await verifySecret(accessCode.codeHash, code))) {
    const after = limiter.recordFailure(key);
    return {
      ok: false,
      ...(after.allowed ? {} : { lockedForSeconds: Math.ceil(after.retryAfterMs / 1000) }),
    };
  }

  limiter.reset(key);
  await writeReviewerSession(newReviewerSession(instanceId, round, reviewer.id, nowSeconds()));
  return { ok: true };
}

/// The reviewer gate. Redirects rather than throwing, so a reviewer following an
/// expired bookmark lands on the sign-in form instead of an error.
export async function requireReviewer(instanceId: string): Promise<ReviewerSessionPayload> {
  const session = await readReviewer(instanceId);
  if (!session) redirect(signInPath(instanceId));
  return session;
}

/// The reviewer, re-read from the database rather than trusted from the cookie
/// for anything but their id.
///
/// The session carries a reviewer id and nothing else about them. Their name,
/// their Sparklet flag, and whether they still serve this round can all change
/// after the session is issued — an admin can rename them, flag them, or
/// withdraw them from the round — and a cookie minted last Tuesday must not
/// keep answering for any of it.
///
/// Returns null when the reviewer has been removed or withdrawn from the round
/// since signing in. Callers send them back to sign-in rather than rendering a
/// dashboard for a roster they are no longer on.
export async function currentReviewer(session: ReviewerSessionPayload) {
  return prisma.reviewer.findFirst({
    where: { id: session.rev, instanceId: session.ins, rounds: { has: session.rd } },
    select: { id: true, firstName: true, lastName: true, isSparklet: true },
  });
}

/// requireReviewer plus the database row, which is what nearly every reviewer
/// page actually needs. Redirects to sign-in if the roster has moved under them.
export async function requireReviewerOnRoster(instanceId: string) {
  const session = await requireReviewer(instanceId);
  const reviewer = await currentReviewer(session);

  if (!reviewer) {
    // Their session is authentic but they are no longer on this round's roster.
    // Clearing it stops an endless redirect between here and a sign-in page that
    // would otherwise see a valid session and bounce them straight back.
    await signOutReviewer();
    redirect(signInPath(instanceId, session.rd));
  }

  return { session, reviewer };
}
