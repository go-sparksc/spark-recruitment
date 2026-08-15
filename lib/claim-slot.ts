// FR-9 clause 6, the half that touches the database.
//
// **This file is not pure, and that is deliberate — it is the exception, not a
// drift.** lib/assignment.ts, lib/passes.ts and lib/roster.ts are pure and stay
// that way; the rules this one applies live in lib/review.ts and are tested
// there against plain objects. What is left here is a transaction, and a
// transaction is the one thing in Slice 6 that cannot be verified away from a
// database: the race it exists to prevent is two different reviewers taking the
// last slot, and no amount of unit testing over plain objects can produce it.
//
// So it takes its Prisma client as an argument rather than importing the app
// singleton. `claimSlot` in app/r/[instanceId]/actions.ts passes the interactive
// transaction; prisma/checks/claim-race.ts passes its own, from a standalone
// client, and fires two of them at one applicant concurrently. A harness that
// tested a *copy* of this logic would test the copy.

import { Prisma } from "@/generated/prisma/client";
import { AssignmentOrigin, AssignmentStatus, Round } from "@/generated/prisma/enums";
import {
  claimEligibility,
  openSlotsOf,
  targetFor,
  type ClaimRefusal,
  type ClaimReviewer,
} from "@/lib/review";

/// The three refusals `claimEligibility` can produce, plus the one only the
/// database can: the applicant stopped existing between the pool list being
/// rendered and the claim arriving.
export type ClaimFailure = ClaimRefusal | "NO_SUCH_APPLICANT";

export type ClaimOutcome =
  | { ok: true; assignmentId: string }
  | { ok: false; reason: ClaimFailure };

/// What a refused claim is told, and the losing side of the race is the reader
/// that matters: it must say what happened rather than "something went wrong".
///
/// **A total `Record`, so a fifth failure cannot be added without writing its
/// sentence.** It lives here rather than beside the action for two reasons: a
/// `"use server"` module may only export async functions, and this is the module
/// that owns the union it is keyed by.
const CLAIM_MESSAGES: Record<ClaimFailure, string> = {
  NO_OPEN_SLOTS: "Someone else claimed that slot a moment ago.",
  ALREADY_ASSIGNED: "That applicant is already on your list.",
  SECOND_SPARKLET: "That applicant already has a Sparklet reviewer.",
  NO_SUCH_APPLICANT: "That applicant is no longer in this cycle.",
};

/// Read from a query string, so the input is whatever was typed into the URL
/// bar. Returns null for anything that is not one of the four, and the page
/// renders no banner at all rather than an empty one.
export function claimMessage(key: string | undefined): string | null {
  if (key === undefined) return null;
  return CLAIM_MESSAGES[key as ClaimFailure] ?? null;
}

export interface ClaimInput {
  instanceId: string;
  round: Round;
  applicantId: string;
  /// Read from the database by the caller, never from a request body. Whether
  /// this reviewer is a Sparklet decides whether the claim is legal.
  reviewer: ClaimReviewer;
}

/// Take one open slot on one applicant, inside a transaction the caller owns.
///
/// **The unique index does not help with the race, which is the whole reason
/// this is shaped like it is.** `UNIQUE (round, applicantId, reviewerId)` stops
/// one reviewer holding two slots on one applicant; the race here is two
/// *different* reviewers taking the last slot, and both of their inserts satisfy
/// that index perfectly. Nothing in the schema can refuse the fourth reviewer.
///
/// So the transaction opens by locking the applicant's row. Nothing reads that
/// row — the lock is a mutex named by the applicant id, held until commit, so
/// two claims on one applicant serialize and claims on different applicants do
/// not block each other at all.
///
/// Chosen over `isolationLevel: "Serializable"`, which would also be correct and
/// would push the loser into a 40001 serialization failure that has to be caught
/// and retried. A retry loop is more code and more ways to be subtly wrong than
/// a lock that simply makes the second claim wait and then find the slot gone.
/// Read Committed is sufficient with the lock held.
///
/// **What the lock does not cover, stated rather than discovered later:** FR-8's
/// admin assign does not take it. An admin assigning a third reviewer at the
/// exact instant a claim lands can still produce four, which is §10.5's
/// last-write-wins territory and is a deliberate human action rather than a
/// race between two people who cannot see each other.
export async function claimSlotWithin(
  tx: Prisma.TransactionClient,
  { instanceId, round, applicantId, reviewer }: ClaimInput,
): Promise<ClaimOutcome> {
  // Parameterized by the tagged template, so the id is a bind parameter rather
  // than string-interpolated SQL.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Applicant" WHERE id = ${applicantId} AND "instanceId" = ${instanceId} FOR UPDATE
  `;
  if (locked.length === 0) return { ok: false, reason: "NO_SUCH_APPLICANT" };

  // Awaited one at a time rather than through Promise.all: an interactive
  // transaction is one connection, and concurrent queries on it are a way to
  // find that out the hard way.
  const applicantCount = await tx.applicant.count({ where: { instanceId } });
  const roundReviewerCount = await tx.reviewer.count({
    where: { instanceId, rounds: { has: round } },
  });

  const active = await tx.assignment.findMany({
    where: { instanceId, round, applicantId, status: AssignmentStatus.ACTIVE },
    select: { reviewerId: true, reviewer: { select: { isSparklet: true } } },
  });

  // The same two functions the pool list filtered with, re-run with the lock
  // held. That is what makes a stale list unable to get past this point — and
  // it is why they live in lib/review.ts rather than in either surface.
  const target = targetFor(applicantCount, roundReviewerCount);
  const verdict = claimEligibility(reviewer, {
    openSlots: openSlotsOf(target, active.length),
    assignedReviewerIds: active.map((assignment) => assignment.reviewerId),
    hasSparklet: active.some((assignment) => assignment.reviewer.isSparklet),
  });

  if (!verdict.eligible) return { ok: false, reason: verdict.reason };

  // Decision 28: a reviewer may claim back an applicant they returned. The
  // unique index leaves exactly one way to do that — reactivate the row rather
  // than insert a second one. Any row found here is RETURNED_TO_POOL, because
  // an ACTIVE one would have refused above as ALREADY_ASSIGNED.
  const existing = await tx.assignment.findUnique({
    where: {
      round_applicantId_reviewerId: { round, applicantId, reviewerId: reviewer.id },
    },
    select: { id: true },
  });

  if (existing) {
    await tx.assignment.update({
      where: { id: existing.id },
      data: {
        status: AssignmentStatus.ACTIVE,
        origin: AssignmentOrigin.CLAIMED_FROM_POOL,
        // Cleared, so the row records a live assignment and no longer records a
        // recusal. That is what moves it from decision 23's exclusion set into
        // decision 21's preserved set at the next regeneration.
        returnReason: null,
        returnNote: null,
        returnedAt: null,
      },
    });
    return { ok: true, assignmentId: existing.id };
  }

  const created = await tx.assignment.create({
    data: {
      instanceId,
      round,
      applicantId,
      reviewerId: reviewer.id,
      origin: AssignmentOrigin.CLAIMED_FROM_POOL,
    },
    select: { id: true },
  });

  return { ok: true, assignmentId: created.id };
}
