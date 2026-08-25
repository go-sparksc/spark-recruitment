"use server";

import { revalidatePath } from "next/cache";

import {
  ApplicantStatus,
  DecisionActor,
  DecisionOutcome,
  InstanceStage,
  PassResolution,
  PassStatus,
  Round,
} from "@/generated/prisma/enums";
import { requireInstance } from "@/lib/auth";
import {
  SECOND_ROUND_POOL,
  UNRESOLVED_AT_CLOSE,
  closeRoundBlock,
  isTerminal,
  passCreationBlock,
  resolvePass,
} from "@/lib/passes";
import { prisma } from "@/lib/prisma";

export interface PassActionState {
  error?: string;
  message?: string;
}

function path(instanceId: string) {
  return `/instances/${instanceId}/passes`;
}

/// Everything a pass create or close changes the look of.
///
/// The reviewer's own list is in here deliberately: its empty state says voting
/// opens when an admin starts a pass, so the moment a pass exists that sentence
/// is wrong. Decision 64's lesson — a dead end nobody revalidated — applied
/// before it can bite.
function revalidateAll(instanceId: string) {
  revalidatePath(path(instanceId));
  revalidatePath(`/instances/${instanceId}`);
  revalidatePath(`/r/${instanceId}/second-round`);
}

/// FR-17: "A pass is created by an admin. Its membership is fixed at creation:
/// every applicant with `status = ACTIVE`."
///
/// Clauses 17a, 17b, 17c's action half, 17w, and decision 79.
export async function createPass(
  _prev: PassActionState,
  formData: FormData,
): Promise<PassActionState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  await requireInstance(instanceId, path(instanceId));

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { id: true, currentStage: true },
  });
  if (!instance) return { error: "No such instance." };

  // **Every input to the guard is read here, not taken from the request.** The
  // page renders the same guard to explain itself, but a second tab opened
  // before someone else created a pass still holds a form bound to this action.
  const [openPass, pool, reviewers, lastPass] = await Promise.all([
    prisma.pass.findFirst({
      where: { instanceId, status: PassStatus.OPEN },
      select: { id: true, ordinal: true },
    }),
    // Clause 17b, through the same constant the hub and the close-round action
    // read. `status = ACTIVE`, no round qualifier — decision 41's whole point.
    prisma.applicant.findMany({
      where: { instanceId, ...SECOND_ROUND_POOL },
      orderBy: { sourceRowIndex: "asc" },
      select: { id: true },
    }),
    prisma.reviewer.findMany({
      where: { instanceId, rounds: { has: Round.SECOND_ROUND } },
      select: { id: true },
    }),
    prisma.pass.findFirst({
      where: { instanceId },
      orderBy: { ordinal: "desc" },
      select: { ordinal: true },
    }),
  ]);

  const block = passCreationBlock({
    inSecondRound: instance.currentStage === InstanceStage.SECOND_ROUND,
    openPassOrdinal: openPass?.ordinal ?? null,
    poolSize: pool.length,
    reviewerCount: reviewers.length,
  });
  if (block) return { error: block };

  // Decision 67: conflicts are scoped by round and never by pass, so a pass
  // created today inherits every conflict flagged before it existed.
  const conflicts = await prisma.conflictOfInterest.findMany({
    where: { round: Round.SECOND_ROUND, applicant: { instanceId } },
    select: { applicantId: true, reviewerId: true },
  });

  const applicantIds = pool.map((applicant) => applicant.id);
  const reviewerIds = reviewers.map((reviewer) => reviewer.id);

  // **Resolved at creation, not left until the first vote.** Clause 17v: an
  // applicant every second-round reviewer has recused from resolves NEEDS_ADMIN
  // immediately, and §7.4 requires that be visible as the pass's answer rather
  // than as a row that never moves. With no votes yet this is the only branch
  // that can fire — everyone else has an outstanding reviewer.
  const resolutions = resolvePass({ reviewerIds, applicantIds, votes: [], conflicts });
  const needsAdmin = new Set(
    resolutions
      .filter((row) => row.resolution === PassResolution.NEEDS_ADMIN)
      .map((row) => row.applicantId),
  );

  const ordinal = (lastPass?.ordinal ?? 0) + 1;
  const now = new Date();

  try {
    await prisma.$transaction(
      async (tx) => {
        const created = await tx.pass.create({
          data: { instanceId, ordinal, status: PassStatus.OPEN },
          select: { id: true },
        });

        await tx.passApplicant.createMany({
          data: applicantIds.map((applicantId) => ({
            passId: created.id,
            applicantId,
            // Decision 70 writes no `Decision` row for NEEDS_ADMIN, and
            // `statusFor` leaves the applicant ACTIVE, so this is the only
            // write the all-COI case makes.
            resolution: needsAdmin.has(applicantId) ? PassResolution.NEEDS_ADMIN : null,
            resolvedAt: needsAdmin.has(applicantId) ? now : null,
          })),
        });

        await tx.auditLog.create({
          data: {
            instanceId,
            // One shared admin password, so the actor cannot yet name an
            // individual — open decision 16. Counts only, no applicant names.
            actor: "admin",
            action: "CREATE_PASS",
            entityType: "Pass",
            entityId: created.id,
            previousValue: {
              ordinal,
              memberCount: applicantIds.length,
              reviewerCount: reviewerIds.length,
              conflicts: conflicts.length,
              needsAdminAtCreation: needsAdmin.size,
            },
          },
        });
      },
      { timeout: 20000 },
    );
  } catch (error) {
    // The guard above is a check-then-act, and two admins creating at the same
    // moment both pass it. `Pass_instanceId_statusOpen_key` and
    // `Pass_instanceId_ordinal_key` are what actually decide, and the loser
    // arrives here. Re-reading and reporting is better than a raw P2002.
    if (isUniqueViolation(error)) {
      return {
        error:
          "Another pass was created a moment ago. Reload this page to see it before creating " +
          "another.",
      };
    }
    throw error;
  }

  revalidateAll(instanceId);

  const flagged =
    needsAdmin.size > 0
      ? ` ${needsAdmin.size} applicant${needsAdmin.size === 1 ? "" : "s"} already need${
          needsAdmin.size === 1 ? "s" : ""
        } an admin — every reviewer has a conflict.`
      : "";

  return {
    message:
      `Pass ${ordinal} created with ${applicantIds.length} applicant` +
      `${applicantIds.length === 1 ? "" : "s"} and ${reviewerIds.length} reviewer` +
      `${reviewerIds.length === 1 ? "" : "s"}.${flagged}`,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "P2002";
}

/// FR-17: "Closing a pass without full votes leaves unvoted applicants ACTIVE
/// and carried forward."
///
/// Clause 17n and decision 72. **The close writes status and `closedAt` and
/// nothing else** — no resolution onto the unvoted rows, no touch to any
/// applicant. `CARRIED` would claim a mixed vote that never happened, and
/// `NULL` is what §5 says an unresolved row holds. The only thing that ever
/// writes `NEEDS_ADMIN` over a null row is the close-second-round action
/// (decision 73), which is Slice 10 and is a different sentence.
export async function closePass(
  _prev: PassActionState,
  formData: FormData,
): Promise<PassActionState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const passId = String(formData.get("passId") ?? "");
  await requireInstance(instanceId, path(instanceId));

  const pass = await prisma.pass.findFirst({
    // instanceId in the filter, not just the id: the id arrives from the
    // request and must not be able to name a pass in someone else's instance.
    where: { id: passId, instanceId },
    select: { id: true, ordinal: true, status: true },
  });

  if (!pass) return { error: "No such pass in this instance." };

  if (pass.status !== PassStatus.OPEN) {
    // 17y: there is no reopen action, so this is not a race to recover from —
    // it is a stale tab, and saying so is the whole response.
    return { error: `Pass ${pass.ordinal} is already closed. Reload this page.` };
  }

  const unresolved = await prisma.passApplicant.count({
    where: { passId: pass.id, resolution: null },
  });

  await prisma.$transaction(async (tx) => {
    await tx.pass.update({
      where: { id: pass.id },
      data: { status: PassStatus.CLOSED, closedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
        action: "CLOSE_PASS",
        entityType: "Pass",
        entityId: pass.id,
        previousValue: {
          ordinal: pass.ordinal,
          previousStatus: PassStatus.OPEN,
          // What the close deliberately left alone, recorded because it is the
          // number an admin will want when they wonder why pass 2 is so large.
          leftUnresolved: unresolved,
        },
      },
    });
  });

  revalidateAll(instanceId);

  return {
    message:
      `Pass ${pass.ordinal} closed.` +
      (unresolved > 0
        ? ` ${unresolved} applicant${unresolved === 1 ? "" : "s"} carried forward unresolved.`
        : ""),
  };
}

/// FR-17: "An admin can manually reject any applicant within a pass, excluding
/// them from future passes." Clauses 17l, 17m, 17t and decision 71.
///
/// **One transaction, four writes, and the order of the guards matters.** The
/// pass row records what happened to the applicant *in this pass*; the applicant
/// status is what excludes them from the next one (17m, falling out of 17b
/// reading `status = ACTIVE`); the `Decision` row is decision 69's `actor =
/// ADMIN` half; the audit row is §8.
///
/// **A terminal row is never overwritten.** An applicant already resolved
/// SPARKLET by a unanimous vote is not rejectable — that is not an override, it
/// is a contradiction, and §7.4 sends corrections after the fact through the
/// applicant override rather than back through the pass. A `CARRIED` or
/// `NEEDS_ADMIN` row *is* rejectable: neither decided anything about the
/// applicant, and 17l says "any applicant", which is precisely the population
/// those two describe.
export async function manuallyReject(
  _prev: PassActionState,
  formData: FormData,
): Promise<PassActionState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  const passId = String(formData.get("passId") ?? "");
  const applicantId = String(formData.get("applicantId") ?? "");
  await requireInstance(instanceId, path(instanceId));

  const pass = await prisma.pass.findFirst({
    where: { id: passId, instanceId },
    select: { id: true, ordinal: true, status: true },
  });
  if (!pass) return { error: "No such pass in this instance." };

  // Decision 71 scopes this to an open pass: "the admin's manual reject during
  // an open pass". A closed pass is a record of what happened, and §7.4 refuses
  // to reopen one — corrections there go through an override on the applicant,
  // which is FR-19's surface and not this one.
  if (pass.status !== PassStatus.OPEN) {
    // **Names only what exists today.** This used to say "correct this on the
    // applicant instead", which is FR-19's override — a Phase 7 surface. A
    // message that points at an unbuilt screen is worse than no message: it
    // sends an admin looking for something that is not there, and reads as a
    // feature they have failed to find rather than one nobody has written.
    return {
      error:
        `Pass ${pass.ordinal} is closed and cannot be reopened. If this applicant is still ` +
        `active, reject them from the open pass, or from the next pass once you create one. ` +
        `Reload this page to see where they stand.`,
    };
  }

  const membership = await prisma.passApplicant.findUnique({
    where: { passId_applicantId: { passId: pass.id, applicantId } },
    select: {
      resolution: true,
      applicant: { select: { id: true, status: true } },
    },
  });

  if (!membership) return { error: "That applicant is not in this pass." };

  if (isTerminal(membership.resolution)) {
    return {
      error: `This pass has already resolved that applicant. Reload to see where they stand.`,
    };
  }

  // The applicant's own status, checked separately from the pass row: a manual
  // reject in an earlier pass leaves this pass's row untouched, so the row can
  // read null while the applicant is already REJECTED.
  if (membership.applicant.status !== ApplicantStatus.ACTIVE) {
    return { error: "That applicant has already been decided." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.passApplicant.update({
      where: { passId_applicantId: { passId: pass.id, applicantId } },
      data: { resolution: PassResolution.REJECTED, resolvedAt: new Date() },
    });

    // 17m. This is the write that excludes them from every future pass, because
    // membership is recomputed from `status` at each creation.
    await tx.applicant.update({
      where: { id: applicantId },
      data: { status: ApplicantStatus.REJECTED },
    });

    // Decision 69: same table and pattern as the other two rounds, `actor =
    // ADMIN` because a person did this rather than a tally.
    await tx.decision.upsert({
      where: { applicantId_stage: { applicantId, stage: Round.SECOND_ROUND } },
      create: {
        applicantId,
        stage: Round.SECOND_ROUND,
        outcome: DecisionOutcome.REJECT,
        actor: DecisionActor.ADMIN,
      },
      update: { outcome: DecisionOutcome.REJECT, actor: DecisionActor.ADMIN },
    });

    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
        action: "MANUAL_REJECT_IN_PASS",
        // The applicant id, which is what §8's entityId is for, and never the
        // name — 17t. `previousValue` carries what this overwrote, so the row
        // says what changed rather than only that something did.
        entityType: "Applicant",
        entityId: applicantId,
        previousValue: {
          passId: pass.id,
          ordinal: pass.ordinal,
          previousResolution: membership.resolution,
          previousStatus: membership.applicant.status,
        },
      },
    });
  });

  revalidateAll(instanceId);
  revalidatePath(`/instances/${instanceId}/passes/${pass.id}`);

  return { message: `Applicant rejected in pass ${pass.ordinal}.` };
}

/// FR-17's "Close second round". Clauses 17p–17u and decision 73.
///
/// Passes do not end on their own; this is the explicit act that ends the round,
/// and it is the *only* thing that produces FR-19's Unresolved group.
///
/// **`Applicant.status` is deliberately untouched** (17u). There is no
/// `UNRESOLVED` status, because an applicant's fate at the end of the round is
/// already recorded on their final pass row and a second copy could disagree
/// with the first. They stay ACTIVE, and FR-19 finds them by the row.
export async function closeSecondRound(
  _prev: PassActionState,
  formData: FormData,
): Promise<PassActionState> {
  const instanceId = String(formData.get("instanceId") ?? "");
  await requireInstance(instanceId, path(instanceId));

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { id: true, currentStage: true },
  });
  if (!instance) return { error: "No such instance." };

  // **17r, and it has to come before the guard.** `closeRoundBlock` reports a
  // COMPLETE instance as "the second round is closed", which is the right thing
  // for the page to render and the wrong thing for this action to return: §7.4
  // requires that running the close twice changes nothing, and an error is a
  // change in what the admin is told. So a second run is a quiet no-op — no
  // writes, and no second audit row.
  if (instance.currentStage === InstanceStage.COMPLETE) {
    return { message: "The second round is already closed." };
  }

  // The final pass is the highest ordinal, which is also the only one decision
  // 73 touches: a CARRIED row on an earlier pass carried into a later one and is
  // not unresolved, it is history.
  const finalPass = await prisma.pass.findFirst({
    where: { instanceId },
    orderBy: { ordinal: "desc" },
    select: { id: true, ordinal: true, status: true },
  });

  const block = closeRoundBlock({
    stage: instance.currentStage,
    passCount: finalPass === null ? 0 : 1,
  });
  if (block) return { error: block };

  // Non-null once the block has passed: the only branch that permits a null
  // final pass is the `passCount === 0` one, which blocks.
  if (!finalPass) return { error: "No pass exists on this instance." };

  const unresolved = await prisma.passApplicant.count({
    where: { passId: finalPass.id, ...UNRESOLVED_AT_CLOSE },
  });

  await prisma.$transaction(async (tx) => {
    // §7.4: "It also closes the final pass if it is still open, so a COMPLETE
    // instance cannot hold an OPEN one." Skipped when already closed, so a
    // closedAt recorded days ago is not rewritten to now.
    if (finalPass.status === PassStatus.OPEN) {
      await tx.pass.update({
        where: { id: finalPass.id },
        data: { status: PassStatus.CLOSED, closedAt: new Date() },
      });
    }

    // 17q and decision 73: NULL **or** CARRIED, on the final pass only. A
    // CARRIED row here is an applicant whose votes were mixed and who had no
    // next pass to carry into — invisible to FR-19 if it kept its value, since
    // FR-19 finds Unresolved by NEEDS_ADMIN and by nothing else.
    //
    // `updateMany` is what makes 17r true at the database rather than by
    // argument: after the first run no row matches this filter.
    await tx.passApplicant.updateMany({
      where: { passId: finalPass.id, ...UNRESOLVED_AT_CLOSE },
      data: { resolution: PassResolution.NEEDS_ADMIN, resolvedAt: new Date() },
    });

    // Decision 70: NEEDS_ADMIN writes no `Decision` row. Nothing has been
    // decided yet — that is the entire meaning of the value — and the row is
    // written later, whenever an admin actually resolves them.
    //
    // 17u: no `Applicant.status` write either. Deliberately.

    await tx.instance.update({
      where: { id: instanceId },
      data: { currentStage: InstanceStage.COMPLETE },
    });

    // 17t. Counts only, no applicant names.
    await tx.auditLog.create({
      data: {
        instanceId,
        actor: "admin",
        action: "CLOSE_SECOND_ROUND",
        entityType: "Instance",
        entityId: instanceId,
        previousValue: {
          previousInstanceStage: instance.currentStage,
          finalPassOrdinal: finalPass.ordinal,
          finalPassWasOpen: finalPass.status === PassStatus.OPEN,
          markedNeedsAdmin: unresolved,
        },
      },
    });
  });

  revalidateAll(instanceId);
  revalidatePath(`/instances/${instanceId}/passes/${finalPass.id}`);
  // The instance list renders currentStage, and the reviewer's list changes
  // meaning at this moment — its "round is closed" empty state turns on it.
  revalidatePath("/");

  return {
    message:
      `Second round closed.` +
      (unresolved > 0
        ? ` ${unresolved} applicant${unresolved === 1 ? "" : "s"} left unresolved and ${
            unresolved === 1 ? "needs" : "need"
          } an admin decision.`
        : " Every applicant was decided."),
  };
}
