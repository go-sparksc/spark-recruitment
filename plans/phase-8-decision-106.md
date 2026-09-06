# Phase 8 — Decision 106's narrow reversal

**Scope, as recorded in decision 106 and restated in the brief:** an admin reverses a manual reject on FR-18's grid, only while the pass it happened in is still open. It sets `Applicant.status` back to `ACTIVE`, clears the pass row to `NULL`, deletes the `Decision` row, and writes an audit row carrying the previous values. Out of scope, by 106's own text: reversing a vote-driven resolution, anything in a closed pass, and written- or first-round rejects.

---

## Context

Decision 106 (PRD.md:1234–1238) recorded that v1 has no decision reversal and named this slice as the one to build before the next live cycle: the manual reject is the one action an admin takes alone, in the room, that no vote can undo, and second-round deliberation is exactly where a board reconsiders a call. The reconciliation pass (`plans/prd-reconciliation.md` B9) left it as its own slice.

The brief asked three things be confirmed against the code before planning. All three are settled below, and each changes the shape of the work.

---

## What the code actually guards on

**1. `isMutableResolution` (lib/passes.ts:291) answers a different question from the one reversal asks.** It decides whether a *recount* may write over a stored row: `null` and `NEEDS_ADMIN` move, `SPARKLET`, `REJECTED` and `CARRIED` do not. Three writers read it — the reviewer vote action (`app/r/[instanceId]/second-round/actions.ts:305`), `removeConflict` (`passes/actions.ts:609`) and `voteAvailability` (lib/passes.ts:613). Its comment at :279–282 says a manual reject "is protected by this same rule — a vote landing afterwards recomputes to something, and this is what stops that something from being written."

A reversal is not a recount. It is an admin undoing an admin write, and after it the row *should* be recomputable again. So **`isMutableResolution` does not change and `REJECTED` stays immovable to every recount.** Loosening it would reopen exactly the hole decision 71 closed: a vote in flight would overwrite the reject. The "REJECTED never moves" comment gains one sentence saying that the reversal is the one write that is not a recount, and points at the new predicate.

**2. `manuallyReject` (passes/actions.ts:291) guards on `isTerminal`, not `isMutableResolution`** — reconciliation finding A12. Its four guards, in order: pass exists in this instance; pass is `OPEN`; membership exists; row is not terminal; applicant is `ACTIVE`. It writes, in one transaction: row → `REJECTED` + `resolvedAt`; status → `REJECTED`; `Decision` upsert at `SECOND_ROUND` with `actor = ADMIN`, `outcome = REJECT`; audit row `MANUAL_REJECT_IN_PASS` with `{ passId, ordinal, previousResolution, previousStatus }`.

That fourth write is what makes a manual reject distinguishable from a vote-driven one after the fact: the vote path writes `actor = SYSTEM` (:331, :656). So the reversal's identity test is **row `REJECTED` in the open pass AND `Decision(applicantId, SECOND_ROUND).actor = ADMIN`**, exactly as 106 states it. No new column, no new flag. An ACTIVE member of an open pass never has a `SECOND_ROUND` decision before the reject (the only writers are the two upserts and FR-19's action, all of which change status first), so the reject's upsert always *creates*, and the reversal's delete destroys nothing that predates the reject.

**3. The reject's confirm (reject-control.tsx:45–65) is the precedent, and its comment is now wrong.** It names the applicant and their `Applicant N` handle, spells out the consequence, and its doc comment says "the only route back is an override on a later surface" — the sentence 106 was written to correct. The reversal control follows the same shape: a plain button, a confirm naming the person and handle with the consequence spelled out, submit and cancel. The reject's confirm text itself is **not** softened with "you can undo this": 106 calls that confirm the only guard on the mis-tap, and a reversal that exists is a reason to keep the friction, not remove it. The section heading and the guide say the reversal exists.

**One thing 106 says that the code makes worth stating as a cost.** A manual reject is legal over `null`, `CARRIED` and `NEEDS_ADMIN` rows (17l's "any applicant"). 106 says the reversal "clears the pass row to `NULL`", which is a true reversal only for the first of those. For a reject over `CARRIED`, the reversed row reads "No resolution" with zero outstanding, and reviewers regain the vote control on it because `null` is mutable; for a reject over `NEEDS_ADMIN`, the grid still renders "Needs an admin" (18d renders `stored ?? computed`) but the pass summary counts it under "without a resolution". Both land in the same place at every later step — a null row carries at pass close and becomes `NEEDS_ADMIN` at round close, the same as `CARRIED` does under decision 73. **The plan follows 106 literally and writes `NULL`**, and decision 107 below records the consequence so it is a stated choice. The alternative — recomputing through `resolveApplicant` the way `removeConflict` does, which returns the pre-reject value in every reachable case — is a two-line swap in the action if the owner prefers it at review; it is not chosen because 106's text and the brief both say `NULL`, and because a recompute that can in principle return a terminal value drags `statusFor`/`decisionOutcomeFor` writes into a reversal.

**Confirmed at review, 2026-09-06: the reversal writes `NULL`.** The owner accepted the cost on the ground stated above — `CARRIED` and `NEEDS_ADMIN` both converge to `NEEDS_ADMIN` under decision 73, so a recompute buys nothing durable.

---

## Decision to record in PRD §10 before any code

**107 — Decision 106's narrow reversal, built. RESOLVED, amending 106, §5's `Decision` comment, §8's audit bullet, FR-3, FR-17 and §7.4's edge-case table.**

- *Guard.* Reversible iff the pass is `OPEN`, the applicant's row in it is `REJECTED`, their `Decision` at `stage = SECOND_ROUND` has `actor = ADMIN` and `outcome = REJECT`, and `Applicant.status = REJECTED`. One pure predicate in `lib/passes.ts`, read by the page to decide which rows get the control and by the action to refuse — the `passCreationBlock` / `voteAvailability` posture. A vote-driven `REJECTED` row carries `actor = SYSTEM` and is refused; a closed pass is refused; earlier rounds have no pass row and cannot reach it.
- *Writes, one transaction.* Row → `NULL`, `resolvedAt` → `NULL`; status → `ACTIVE`; the `Decision` row **deleted**, not updated — §5's comment said "a reversal would update the row", but there is no prior decision to restore to, and a row with no outcome is not a state `DecisionOutcome` has; audit row `REVERSE_MANUAL_REJECT`, `entityType = Applicant`, `entityId = applicantId`, `previousValue = { passId, ordinal, previousResolution: REJECTED, previousStatus: REJECTED, deletedDecision: { id, outcome, actor, decidedAt } }`. The reject's own audit row is untouched, so the log reads reject-then-reversal.
- *The row is cleared to `NULL`, not recomputed.* Cost stated: a reject over `CARRIED` reverses to a null row with no outstanding reviewer, which reviewers may vote on again; a reject over `NEEDS_ADMIN` reverses to a null row the grid still renders as needing an admin. Both carry and both close to `NEEDS_ADMIN` under decision 73, so nothing downstream distinguishes them from the value the reject overwrote.
- *`isMutableResolution` is unchanged.* `REJECTED` is still immovable to every recount. The reversal is the one write over a `REJECTED` row that is not a recount, and it goes through its own predicate rather than through a fourth mutable case.
- *Votes are untouched.* The reject deleted none, so the reversal restores none; the reviewer's stored vote, if any, is what `voteAvailability` hands back as `current`.
- *Membership.* The applicant is still a member of the open pass, so there is no membership write. A later pass will include them because they are `ACTIVE` at its creation.
- *Concurrency.* The first write is a conditional `updateMany` on `(passId, applicantId, resolution = REJECTED)`; zero rows aborts the transaction and the admin is told the rejection was already reversed. Same posture as `createPass` letting the index decide.
- *The reject's confirm is unchanged.* It remains the guard on the mis-tap; the reversal is announced by its own section heading and by the guide, not by weakening the reject.

**Text amended alongside:** FR-3 (PRD.md:417) "no decision reversal" → "the only decision reversal is decision 107's"; §5 `Decision` comment (:301–304); §8 audit bullet (:655); FR-17 gains a bullet after 17l/17m — "An admin can reverse their own manual reject while that pass is still open (decision 107)" — with a clause-index row **17aa**; §7.4's "Admin reopens a closed pass" row (:583) loses "Corrections happen via manual override on the applicant", which names a surface that does not exist, and says a manual reject in the still-open pass is reversible and nothing in a closed pass is; FR-18 (:622) names its two admin controls. Decision 106's last paragraph gets one line: "Built as decision 107."

---

## Slices

Each is a commit; `npm run verify` before each. No migration — the schema is untouched, so no `prisma generate` and no dev-server restart.

### Slice 1 — Decision 107 and the text amendments

`PRD.md` only, per the list above. Also `prisma/schema.prisma` comments at `Decision` (:866–867, "A reversal updates this row" → deletes it, see 107) and `AuditLog` (:872–874, which already lists "decision reversal"). Comments only; the generated client does not change.

### Slice 2 — The predicate, tested

**`lib/passes.ts`**, beside `isMutableResolution` / `isTerminal`:

```ts
export interface ReversalContext {
  passStatus: PassStatus;
  storedResolution: PassResolution | null;
  applicantStatus: ApplicantStatus;
  /// The applicant's SECOND_ROUND Decision row, or null when none exists.
  decision: { actor: DecisionActor; outcome: DecisionOutcome } | null;
}

/// Why this row's rejection cannot be reversed right now, or null when it can.
export function reversalBlock(context: ReversalContext): string | null
```

Order is the specification, matching `manuallyReject`'s guard order so a stale tab gets the same first reason from both controls: closed pass → row not `REJECTED` → decision missing or `actor = SYSTEM` (message names that a unanimous vote, not an admin, rejected them) → `outcome ≠ REJECT` (defensive) → status not `REJECTED` (already reversed; reload). Messages name only surfaces that exist.

Amend the `isMutableResolution` doc comment (:279–282) with one sentence pointing here.

**`lib/passes.test.ts`**, new `describe("decision 107 — reversing a manual reject")`, built the way `passCreationBlock`'s suite is:

- open pass, `REJECTED` row, `ADMIN`/`REJECT` decision, status `REJECTED` → `null`
- closed pass, same row → blocked, message says closed
- row `SPARKLET`, `CARRIED`, `NEEDS_ADMIN`, `null` → each blocked
- `REJECTED` row with `actor = SYSTEM` → blocked, message says a vote decided it
- `REJECTED` row with no decision → blocked
- status `ACTIVE` with everything else reversible → blocked (already reversed)
- ordering: closed pass **and** `SYSTEM` actor reports the closed pass
- **regression guard:** `isMutableResolution(REJECTED)` is still `false` next to a reversible context — the reversal does not loosen the recount rule.

### Slice 3 — The action

**`app/instances/[id]/passes/actions.ts`**, `reverseManualReject(_prev, formData)` beside `manuallyReject`:

1. `requireInstance`; `pass.findFirst({ id, instanceId })` as the reject does.
2. `passApplicant.findUnique` selecting `resolution` and `applicant { id, status, decisions: { where: { stage: SECOND_ROUND }, select: { id, actor, outcome, decidedAt } } }` (the `Applicant.decisions` relation exists, schema.prisma:460).
3. `reversalBlock(...)` → `{ error }`.
4. Transaction: `passApplicant.updateMany({ where: { passId, applicantId, resolution: REJECTED }, data: { resolution: null, resolvedAt: null } })`, throw a sentinel on `count === 0` and catch it outside as the stale-tab error; `applicant.update({ status: ACTIVE })`; `decision.delete({ where: { id } })`; `auditLog.create` per decision 107 with `...auditActor(session)`.
5. `revalidateAll(instanceId)`, the pass page, and `/r/${instanceId}/second-round/${applicantId}` — the reviewer profile 404'd while the applicant was `REJECTED` and `removeConflict` already revalidates that path for the same reason.
6. Return `{ message: "Rejection reversed. Applicant N is active again in pass K." }`.

Amend `manuallyReject`'s doc comment (:284–290): "§7.4 sends corrections after the fact through the applicant override" names a surface that does not exist; say instead that a manual reject can be reversed by `reverseManualReject` while the pass is open, and a vote-driven terminal row cannot.

### Slice 4 — The control on FR-18's page

**`app/instances/[id]/passes/[passId]/reverse-control.tsx`** (new, client), a mirror of `reject-control.tsx`: hidden `instanceId` / `passId` / `applicantId`, a "Reverse rejection" outline button, then the confirm:

> Reverse the rejection of {name} ({handle})? They return to this pass as active with no resolution and will be included in every later pass. Any votes already cast on them still stand, and reviewers can vote on them again. The rejection itself stays in the activity log.

Submit "Reverse rejection" (pending "Reversing…"), "Cancel", then `state.error` / `state.message` as the reject does. Doc comment says why this is confirmed: it is the second control on this page that moves a person's status without a vote, and the rows either side belong to different people.

**`app/instances/[id]/passes/[passId]/page.tsx`:**

- Extend the members select with `applicant.decisions` filtered to `SECOND_ROUND` (same select as the action, so the page's `reversalBlock` input is the action's).
- `const reversible = pass.members.filter(m => reversalBlock({...}) === null)`, the same shape as `rejectable` (:134–139).
- A second section under "Reject an applicant": heading **"Reverse a rejection"**, one line of copy — "A rejection made by an admin in this pass, while it is still open. Rejections decided by a unanimous vote cannot be reversed." — and a card listing each reversible member with name, handle, and `ReverseControl`. Empty when nothing is reversible, like the reject section; on a closed pass both are absent.
- Fix `reject-control.tsx`'s comment (:13–16): the route back is the reversal section on this page, while the pass is open, and nothing once it closes.

### Slice 5 — The guide

`ADMIN_GUIDE.md` §12 does not mention the manual reject at all today. Add one subsection between "Conflicts of interest" and "Closing", in the guide's register (no FR numbers, no table names):

> **Rejecting someone by hand, and undoing it.** Below the grid, "Reject an applicant" removes someone from this and every later pass without a vote — use it when the room has decided and waiting for eleven submissions is theatre. It asks you to confirm, and names the person with their applicant number, because names repeat. If you rejected the wrong person, "Reverse a rejection" on the same page puts them back, **as long as the pass is still open** — once it closes, nothing in it can be changed. Both actions are recorded in Activity with your name.

A screenshot only if the demo instance can be brought to an open pass cheaply (see verification); otherwise none — the guide's other second-round screenshots are already flagged as unverified in `plans/phase-8.md`.

---

## Files

| File | Change |
|---|---|
| `PRD.md` | Decision 107; amendments listed in slice 1 |
| `prisma/schema.prisma` | Two doc comments, no schema change |
| `lib/passes.ts` | `ReversalContext`, `reversalBlock`; one sentence on `isMutableResolution` |
| `lib/passes.test.ts` | New describe block |
| `app/instances/[id]/passes/actions.ts` | `reverseManualReject`; `manuallyReject` comment |
| `app/instances/[id]/passes/[passId]/reverse-control.tsx` | New |
| `app/instances/[id]/passes/[passId]/page.tsx` | Decisions in the select; `reversible`; new section |
| `app/instances/[id]/passes/[passId]/reject-control.tsx` | Comment only |
| `ADMIN_GUIDE.md` | §12 subsection |

Not touched: `isMutableResolution`, `isTerminal`, the vote action, `removeConflict`, `buildPassGrid`, the audit page (its copy, "every override, reset and deletion", already covers this), `lib/export.ts` (no new column), any migration.

---

## Clause ledger, to tick before each commit

From decision 106's text and the brief, each checked against the diff (CLAUDE.md's list-requirement rule):

1. Offered from FR-18's grid page — slice 4.
2. Only while the pass is still open — predicate case + action guard + page filter.
3. Only a manual reject: row `REJECTED` and `Decision.actor = ADMIN` — predicate; a `SYSTEM` row refused and tested.
4. Sets `status` back to `ACTIVE` — action write 2.
5. Clears the pass row to `NULL` — action write 1, `resolvedAt` too.
6. Deletes the `Decision` row — action write 3.
7. Audit row with previous values, actor, timestamp — action write 4, through `auditActor`.
8. No membership consequence — nothing written to `PassApplicant` beyond the resolution.
9. Excludes vote-driven resolutions, closed passes, earlier rounds — predicate + the absence of any control elsewhere.
10. Confirmed, naming the person and handle, with the consequence — slice 4 copy.

---

## Verification

**Automated:** `npm run verify` after every slice. The predicate suite in `lib/passes.test.ts` is the real test; the action and page get the light coverage CLAUDE.md prescribes, and the page's only transformation is one `reversalBlock` call per member.

**No new `prisma/checks/*` script.** A check would have to reproduce the action rather than import it (server actions are not importable from `tsx`, which is why `prisma/passes.ts` reproduces `manuallyReject`), and CLAUDE.md names that as verifying a second copy of the code under test. The transaction's database-level behaviour is one conditional update, one status update, one delete by id and one insert — nothing a constraint could refuse that the typecheck does not already see.

**By hand, in the browser, against a throwaway instance with an open pass** (the setup `plans/phase-8.md`'s open item already describes, since no seeded instance holds one):

```
SEED_INSTANCE_ID=seed_rev107 npm run seed
SEED_INSTANCE_ID=seed_rev107 npm run seed:advance
```

without `seed:passes`, which lands at `SECOND_ROUND` with no pass. Then:

1. Create pass 1. Reject one applicant by hand; confirm the "Reverse a rejection" section lists exactly them, with the right handle.
2. Reverse. Confirm: the grid row reads "No resolution" and the summary line's rejected count drops by one; the applicant is back in "Reject an applicant"; Activity shows `Manual reject in pass` followed by `Reverse manual reject` with the same name and the deleted decision in the payload; signed in as a reviewer, their profile loads again and the vote control is open, showing any vote they had cast.
3. Vote them to a unanimous NO. Confirm the resulting `REJECTED` row is **not** listed under "Reverse a rejection" — this is the `SYSTEM`-actor exclusion, seen rather than inferred.
4. Reject someone else by hand, close the pass, and confirm neither section renders and the stale tab's reverse submit returns the closed-pass message.
5. Two tabs on the same reversible row: reverse in both; the second reports it was already reversed and Activity holds one reversal row, not two.
6. Delete the throwaway instance afterwards (FR-5), so the development database is left as it was found.

Restart `next dev` is **not** required — no `prisma generate` runs in this slice — but step 2's reviewer check goes through the route that actually renders the reinstated applicant, not a neighbour of it.
