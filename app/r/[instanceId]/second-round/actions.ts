"use server";

import { revalidatePath } from "next/cache";

import {
  DecisionActor,
  InstanceStage,
  PassStatus,
  Round,
  VoteValue,
} from "@/generated/prisma/enums";
import {
  SECOND_ROUND_POOL,
  decisionOutcomeFor,
  isMutableResolution,
  resolveApplicant,
  statusFor,
  voteAvailability,
} from "@/lib/passes";
import { prisma } from "@/lib/prisma";
import { requireReviewerOnRoster } from "@/lib/reviewer-auth";

export interface ConflictState {
  error?: string;
}

export interface VoteState {
  error?: string;
  message?: string;
}

/// FR-16: "Reviewer can flag conflict of interest per applicant, which is sticky
/// across all passes."
///
/// **Sticky falls out of the key, not out of a rule.** `ConflictOfInterest` is
/// unique on `(round, applicantId, reviewerId)` and carries no pass dimension,
/// so there is nowhere for a per-pass conflict to be stored even by accident.
/// Decision 68's "in that pass and any later one" is the same fact stated from
/// the other side.
///
/// **Decision 68: flagging deletes any vote already cast in the open pass.** A
/// vote from a reviewer who has since disclosed a conflict cannot go on counting
/// toward unanimity — and because `lib/passes.ts` computes a conflicted reviewer
/// as SKIP whether or not a row survives, the deletion is about the record
/// rather than about the arithmetic. Both halves matter: the arithmetic must be
/// right even if this fails, and the record must not show a vote the system will
/// not count. Same transaction, so a partial failure leaves neither.
///
/// This is one-way for the reviewer, per decision 76. An admin can remove it
/// from FR-18's grid; nothing here can, and the confirm in the UI says so.
export async function flagConflict(formData: FormData): Promise<ConflictState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const applicantId = String(formData.get("applicantId") ?? "");

  // Inside the action, not only on the page: a server action is a POST endpoint
  // reachable without rendering the form that submits to it.
  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  if (session.rd !== Round.SECOND_ROUND) {
    return { error: "You are signed in for a different round." };
  }

  // Decision 100: a conflict flagged after the round has closed would change
  // what FR-19 shows about an applicant the close already left to an admin. The
  // pool check below does not catch it, because an unresolved applicant in a
  // COMPLETE instance is still ACTIVE by design (FR-17).
  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { currentStage: true },
  });
  if (instance?.currentStage === InstanceStage.COMPLETE) {
    return {
      error:
        "The second round is closed, so conflicts can no longer be flagged. Nothing was changed.",
    };
  }

  // **The applicant is re-checked against the pool**, not taken from the
  // request. An id that has since resolved — made a Sparklet, or rejected — is
  // no longer somebody this reviewer can recuse from.
  const applicant = await prisma.applicant.findFirst({
    where: { id: applicantId, instanceId, ...SECOND_ROUND_POOL },
    select: { id: true },
  });

  if (!applicant) {
    return {
      error:
        "That applicant is no longer in the second round. Reload the page to see the list as it " +
        "stands.",
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.conflictOfInterest.upsert({
      where: {
        round_applicantId_reviewerId: {
          round: Round.SECOND_ROUND,
          applicantId: applicant.id,
          reviewerId: reviewer.id,
        },
      },
      create: {
        round: Round.SECOND_ROUND,
        applicantId: applicant.id,
        reviewerId: reviewer.id,
      },
      // Idempotent: flagging twice is one conflict, not an error. A reviewer
      // double-tapping on a phone must not see a failure for doing the thing
      // they meant to do.
      update: {},
    });

    // Decision 68, scoped to passes that are still OPEN.
    //
    // The decision says the reviewer is SKIP "from that point forward, in that
    // pass and any later one" — forward, which a closed pass is not. Deleting a
    // closed pass's vote would rewrite a decision that has already been made
    // and recorded, and §7.4 is explicit that a closed pass is not reopened;
    // corrections there happen through an admin override on the applicant.
    //
    // Nothing is lost by leaving it. A closed pass's `PassApplicant.resolution`
    // is stored, and `buildPassGrid` renders the stored value over the recount,
    // so the conflict flagged today cannot retroactively unmake last week's
    // Sparklet — it just shows, correctly, that the two now differ.
    await tx.passVote.deleteMany({
      where: {
        applicantId: applicant.id,
        reviewerId: reviewer.id,
        pass: { status: PassStatus.OPEN },
      },
    });
  });

  revalidatePath(`/r/${instanceId}/second-round`);
  revalidatePath(`/r/${instanceId}/second-round/${applicant.id}`);
  return {};
}

/// FR-17's vote submission. Clauses 17d, 17e, 17f, 17g, 17h, 17i, 17j, 17k, 17z.
///
/// **The pass is resolved here, not sent from the client.** 17d says a vote
/// "lands in the currently open pass", so the request carries an applicant and a
/// value and nothing else. A pass id in the form would be a pass id a stale tab
/// could hold, and votes would land in a pass that closed ten minutes ago.
///
/// **What this computes over, and what it returns, are deliberately different
/// sets.** Resolving an applicant needs every reviewer's effective vote, so the
/// transaction reads them all. Decision 74 and clause 17z govern what comes
/// *back*: the return value is "Vote recorded" and never a count, never a
/// tally, and never the outcome. Naming the outcome would be the leak in
/// disguise — telling a reviewer their vote made the applicant a Sparklet tells
/// them every other eligible reviewer voted yes, which is precisely the fact
/// decision 74 exists to withhold.
export async function submitPassVote(
  _prev: VoteState,
  formData: FormData,
): Promise<VoteState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const applicantId = String(formData.get("applicantId") ?? "");
  const raw = String(formData.get("value") ?? "");

  const { session, reviewer } = await requireReviewerOnRoster(instanceId);

  if (session.rd !== Round.SECOND_ROUND) {
    return { error: "You are signed in for a different round." };
  }

  // 17g: an explicit submit, and only the two values a reviewer can choose.
  // SKIP is never submitted — decision 67 makes it computed from the conflict,
  // so accepting one here would create the stored row that decision forbids.
  if (raw !== VoteValue.YES && raw !== VoteValue.NO) {
    return { error: "Choose yes or no before submitting." };
  }
  const value = raw as typeof VoteValue.YES | typeof VoteValue.NO;

  // **Still `SECOND_ROUND_POOL` here, deliberately.** Decision 112 widened what
  // a reviewer may *read* to the whole cohort and left what they may *write*
  // exactly where it was: a resolved applicant is not votable. This is the guard
  // that carries "cannot be reached", which the profile's query used to be asked
  // to carry as well and could not do without 404ing the reviewer whose own vote
  // had just resolved them.
  const applicant = await prisma.applicant.findFirst({
    where: { id: applicantId, instanceId, ...SECOND_ROUND_POOL },
    // `status` is ACTIVE by the predicate above. Selected and passed through
    // rather than assumed, so that if this query's predicate ever changes, the
    // availability below follows it instead of quietly disagreeing with it.
    select: { id: true, status: true },
  });

  // **Decision 71's permissive half, and it is not an error.** An admin may have
  // manually rejected this applicant while the reviewer was mid-tap. That vote
  // "becomes moot — not blocked": nothing downstream reads it, the applicant is
  // already excluded from future passes, and a red failure would tell a reviewer
  // they did something wrong when they did not. The page revalidates and the
  // control is gone.
  if (!applicant) {
    revalidatePath(`/r/${instanceId}/second-round`);
    revalidatePath(`/r/${instanceId}/second-round/${applicantId}`);
    return { message: "This applicant has already been decided. Nothing was recorded." };
  }

  const [openPass, conflict] = await Promise.all([
    prisma.pass.findFirst({
      where: { instanceId, status: PassStatus.OPEN },
      select: { id: true },
    }),
    prisma.conflictOfInterest.findUnique({
      where: {
        round_applicantId_reviewerId: {
          round: Round.SECOND_ROUND,
          applicantId: applicant.id,
          reviewerId: reviewer.id,
        },
      },
      select: { id: true },
    }),
  ]);

  const membership = openPass
    ? await prisma.passApplicant.findUnique({
        where: { passId_applicantId: { passId: openPass.id, applicantId: applicant.id } },
        select: { id: true, resolution: true },
      })
    : null;

  // The same function the profile renders the control from, so a control that is
  // absent and an action that refuses cannot be answering different questions.
  const availability = voteAvailability({
    applicantStatus: applicant.status,
    hasOpenPass: openPass !== null,
    isMember: membership !== null,
    hasConflict: conflict !== null,
    storedResolution: membership?.resolution ?? null,
    currentVote: null,
  });

  switch (availability.kind) {
    case "RESOLVED":
      // Unreachable through the query above, which already filtered to ACTIVE
      // and returned decision 71's permissive message when it matched nothing.
      // Handled rather than defaulted so that adding a state to the union is a
      // typecheck failure here, which is the property this switch exists for —
      // and if the predicate above is ever widened, this refuses rather than
      // falling through to a write.
      return { error: "This applicant has already been decided, so votes can no longer change." };
    case "NO_PASS":
      return { error: "No pass is open. Voting opens when an admin starts one." };
    case "NOT_IN_PASS":
      return { error: "This applicant is not in the open pass. Reload the page." };
    case "CONFLICT":
      // 17f, the action half. You are recorded as skipping, per 17e, and no row
      // is written to say so.
      return { error: "You have flagged a conflict on this applicant and cannot vote on them." };
    case "SETTLED":
      return {
        error: "The pass has already concluded on this applicant, so votes can no longer change.",
      };
    case "OPEN":
      break;
  }

  // `openPass` and `membership` are non-null on the OPEN branch; narrowing the
  // union does not narrow them, so this is the assertion rather than a `!`.
  if (!openPass || !membership) {
    return { error: "No pass is open. Voting opens when an admin starts one." };
  }

  await prisma.$transaction(async (tx) => {
    // Decision 75: resubmitting updates the existing row through
    // UNIQUE (passId, applicantId, reviewerId). Decision 26's reasoning about
    // misclicks, applied to a round where the window shuts on its own.
    await tx.passVote.upsert({
      where: {
        passId_applicantId_reviewerId: {
          passId: openPass.id,
          applicantId: applicant.id,
          reviewerId: reviewer.id,
        },
      },
      create: {
        passId: openPass.id,
        applicantId: applicant.id,
        reviewerId: reviewer.id,
        value,
      },
      update: { value },
    });

    // Recomputed inside the same transaction as the write that changed it.
    // Reading the votes before the upsert commits would resolve against a state
    // that no longer exists by the time the resolution is stored.
    const [roster, votes, conflicts, current] = await Promise.all([
      tx.reviewer.findMany({
        where: { instanceId, rounds: { has: Round.SECOND_ROUND } },
        select: { id: true },
      }),
      tx.passVote.findMany({
        where: { passId: openPass.id, applicantId: applicant.id },
        select: { applicantId: true, reviewerId: true, value: true },
      }),
      tx.conflictOfInterest.findMany({
        where: { round: Round.SECOND_ROUND, applicantId: applicant.id },
        select: { applicantId: true, reviewerId: true },
      }),
      tx.passApplicant.findUnique({
        where: { passId_applicantId: { passId: openPass.id, applicantId: applicant.id } },
        select: { resolution: true },
      }),
    ]);

    // 17h: resolved when every non-SKIP reviewer has submitted. The roster is
    // the denominator, per decisions 66 and 78 as amended by 84.
    const { resolution } = resolveApplicant(applicant.id, {
      reviewerIds: roster.map((entry) => entry.id),
      applicantIds: [applicant.id],
      votes,
      conflicts,
    });

    // A terminal row is never recomputed — the rule that protects a manual
    // reject (decision 71) and a Sparklet alike.
    if (!isMutableResolution(current?.resolution ?? null)) return;

    await tx.passApplicant.update({
      where: { passId_applicantId: { passId: openPass.id, applicantId: applicant.id } },
      data: { resolution, resolvedAt: resolution === null ? null : new Date() },
    });

    // 17i and 17j: the status change and the exclusion from future passes, which
    // falls out of 17b reading `status = ACTIVE`. 17k writes neither — CARRIED
    // leaves them ACTIVE, and `statusFor` returns null for it.
    const status = statusFor(resolution);
    if (status !== null) {
      await tx.applicant.update({ where: { id: applicant.id }, data: { status } });
    }

    // Decision 69: `actor = SYSTEM` for a pass's own unanimous result. Decision
    // 70: NEEDS_ADMIN writes none, and neither does CARRIED — `decisionOutcomeFor`
    // returns null for both.
    const outcome = decisionOutcomeFor(resolution);
    if (outcome !== null) {
      await tx.decision.upsert({
        where: { applicantId_stage: { applicantId: applicant.id, stage: Round.SECOND_ROUND } },
        create: {
          applicantId: applicant.id,
          stage: Round.SECOND_ROUND,
          outcome,
          actor: DecisionActor.SYSTEM,
        },
        update: { outcome, actor: DecisionActor.SYSTEM },
      });
    }
  });

  revalidatePath(`/r/${instanceId}/second-round`);
  revalidatePath(`/r/${instanceId}/second-round/${applicant.id}`);
  // The admin's pass list counts resolutions, and this may have moved one.
  revalidatePath(`/instances/${instanceId}/passes`);

  // Neutral by design. See the note on decision 74 above: no count, no tally,
  // no outcome.
  return { message: "Vote recorded." };
}
