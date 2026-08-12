// The reviewer's signed cookie. PRD §8 and FR-9.
//
// **A separate cookie from the admin session, not a field on it.** An admin
// session must never confer reviewer identity and a reviewer session must never
// confer admin access. Two cookies makes that structural: there is no payload
// shape in which one turns into the other, and no code path where forgetting a
// check promotes a reviewer. One cookie carrying both would make it a question
// of remembering to look at the right field.
//
// Signed with the same SESSION_SECRET as the admin session, deliberately, so
// that rotating the secret invalidates both at once — which is exactly what you
// want if anything leaks. The envelope is shared through lib/signed-token.ts;
// the shape and the expiry below are this session's own.
//
// Pure: no cookie jar, no Next imports, no environment reads. lib/reviewer-auth.ts
// binds this to the request.

import { Round } from "@/generated/prisma/enums";
import { decodeSignedToken, encodeSignedToken } from "@/lib/signed-token";

export interface ReviewerSessionPayload {
  /// Instance this reviewer signed into. Scoped rather than global: a reviewer
  /// on one cycle is not a reviewer on the next, and the access code is
  /// per-instance-per-round.
  ins: string;
  /// The round they signed in for. FR-9 gives each round a distinct roster and
  /// distinct field visibility, so the round is part of who you are here, not a
  /// preference.
  rd: Round;
  /// Reviewer id. Every score and note this session writes references it, never
  /// the name that was picked from the dropdown.
  rev: string;
  /// Absolute expiry, unix seconds. Not sliding.
  exp: number;
}

export const REVIEWER_COOKIE = "spark_reviewer";

/// Seven days, against the admin session's twelve hours.
///
/// The two are different because the sessions are. An admin session holds the
/// app-level gate and reaches every instance; a reviewer session reaches fifteen
/// applicants in one round of one cycle. And the written round runs for about a
/// week, so a twelve-hour reviewer session would expire mid-round — sending
/// someone back to Slack to find the code again, which under FR-9's premise is a
/// review that does not get completed.
///
/// Deliberately not longer than the round it serves. A session that outlives the
/// round is one that still opens applicant essays after the reason to read them
/// has passed.
export const REVIEWER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const ROUNDS: readonly string[] = Object.values(Round);

/// Returns null for anything that is not a currently valid reviewer session:
/// malformed, wrong signature, expired, structurally wrong, or for a different
/// instance than the caller asked about.
///
/// `instanceId` is a required argument rather than something the caller checks
/// afterwards. A reviewer holding a valid session for instance A must not be
/// able to read instance B by changing the URL, and making the comparison part
/// of decoding means a caller cannot forget it.
export function decodeReviewerSession(
  token: string | undefined,
  secret: string,
  instanceId: string,
  nowSeconds: number,
): ReviewerSessionPayload | null {
  const parsed = decodeSignedToken(token, secret);

  if (typeof parsed !== "object" || parsed === null) return null;
  const { ins, rd, rev, exp } = parsed as Record<string, unknown>;

  if (typeof ins !== "string" || ins === "") return null;
  if (typeof rev !== "string" || rev === "") return null;
  if (typeof rd !== "string" || !ROUNDS.includes(rd)) return null;
  if (typeof exp !== "number") return null;
  if (nowSeconds >= exp) return null;
  if (ins !== instanceId) return null;

  return { ins, rd: rd as Round, rev, exp };
}

export function encodeReviewerSession(payload: ReviewerSessionPayload, secret: string): string {
  return encodeSignedToken(payload, secret);
}

export function newReviewerSession(
  instanceId: string,
  round: Round,
  reviewerId: string,
  nowSeconds: number,
): ReviewerSessionPayload {
  return {
    ins: instanceId,
    rd: round,
    rev: reviewerId,
    exp: nowSeconds + REVIEWER_SESSION_TTL_SECONDS,
  };
}
