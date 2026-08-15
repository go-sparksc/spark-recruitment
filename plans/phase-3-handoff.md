# Phase 3 handoff — end of Slice 6

**As of `6b16e65`, 2026-08-15.** Slices 0–6 are committed. **The next step is not code: it is the
Slice 6 walkthrough, which has not been run, and then Slice 7's board-member run.**

This is a resume-point document, not a plan. `plans/phase-3.md` is the plan; this says what actually
exists, what does not, and what is waiting to be verified.

---

## Read this first

**Nothing in Slice 6 has been seen in a browser.** `npm run verify` passes (369 tests), `npm run
build` passes, the routes compile and respond in dev, and `prisma/checks/claim-race.ts` passes
against a real database — but every reviewer route redirects to sign-in without a session, so no
rendering of the return control, the pool page, or the admin returned-rows line has been observed by
anyone. Phase 2 shipped four defects that only a person using the screen could find. Assume Slice 6
has some.

The full walkthrough is `plans/phase-3.md`'s Slice 6 section, steps 1–10, plus two added by decision
38 and repeated at the end of this document.

---

## Starting up

```bash
npm run dev        # http://localhost:3000, and http://<lan-ip>:3000 for a phone
```

The LAN address is printed as "Network" in the `next dev` banner — it was `192.168.1.110` on
2026-08-15, unchanged from the Slice 5 session, but it is DHCP and will move. Phone testing needs
`DEV_ALLOWED_ORIGINS` in `.env` set to that host, or every JS chunk 403s and the page loads but
nothing works. See `.env.example`.

**If you have pulled a schema change, restart the dev server.** A running server keeps the old Prisma
client in memory and fails with `Unknown field 'x' ...` while `npm run verify` passes completely. See
CLAUDE.md. Slice 6 involved **no schema change and no migration**, so this did not bite here.

**A dev server may still be running** from the Slice 6 session on port 3000. It has been up for
hours; the handoff below on stale dev servers applies — restart it before trusting anything.

### Credentials

| What | Value |
|---|---|
| App-level password | Yours — only its argon2 hash is in `.env`. `npm run hash-secret -- "new password"` to replace. |
| Instance password | `phase0-dev-password` (`prisma/seed.ts`) |
| Round codes | **`written-f26`**, `firstround-s26`, `secondround-s26` — the written code was rotated on 2026-08-13 while testing the access-code card. `written-s26` is dead. `prisma/seed.ts` still writes `written-s26`, so `npm run seed` resets it. |
| Seed instance id | `seed_s26_demo` |

### Fixture state

150 applicants · 30 reviewers (8 Sparklets) · **428 assignments** · loads 14–15 · 128 applicants at 3
reviewers, 22 at 2 · **0 scores** · 4 rubric categories at 5 points each, all with descriptions.

Unchanged from the end of Slice 5. `claim-race.ts` was run four times against this database and each
run verified the count back at 428 afterwards.

Those 22 applicants at 2 of 3 are the 5% pool, so **the pool page has ~22 rows before anyone returns
anything** — that is correct, not a bug, and it is what makes walkthrough steps 5 and 6 possible
without setting anything up.

`npm run seed` rebuilds everything **and wipes assignments** — regenerate them from
`/instances/seed_s26_demo/assignments` afterwards, or the reviewer list is empty.

---

## Reviewer surface — `/r/…`

Outside the §8 admin gate. Reviewers never see the instance list.

| Route | Does | Status |
|---|---|---|
| `/r/<instanceId>?round=WRITTEN` | Sign-in: round picker, name dropdown, access code, one submit (decision 30) | Works |
| `/r/<instanceId>/list` | Assigned applicants, completion state, **pool link with a live count**, **return control per row** | Compiles; **not clicked** |
| `/r/<instanceId>/a/<assignmentId>` | Responses, sticky rubric, scoring, note, autosave, guarded prev/next, **return control** | Scoring works; return **not clicked** |
| `/r/<instanceId>/pool` | **Claim from pool** — label, `n of 3 reviewers`, one-tap Claim | New; **not clicked** |

Session is a separate signed cookie (`spark_reviewer`), 7 days, scoped to one instance and one round.

## Admin surface — `/instances/<id>/…`

Unchanged except `…/assignments`, which now renders **returned rows** under each applicant —
`Returned · Jane Doe — knows the applicant`, dimmed and with no controls. Decision 39.

---

## What Slice 6 shipped

Three commits.

- **`00efdc4` — PRD decisions 38 and 39.** What a return does to the draft mirror; and the return
  reason that no admin surface rendered.
- **`17364bb` — return to pool.** Clauses 5a, 5b, 5c. A `<details>` disclosure around a plain form,
  on every list row and on the detail screen. `validateReturn` in `lib/review.ts` is the server half
  of "required reason"; `required` on the radios is the browser's. Free text optional for **both**
  reasons.
- **`6b16e65` — claim from pool.** Clauses 6a, 6b, 6c. `lib/claim-slot.ts` holds the transaction,
  which opens with `SELECT … FOR UPDATE` on the applicant. `app/r/[instanceId]/pool-query.ts` is the
  one definition of "open to me", called by both the pool page and the list header so the count and
  the rows cannot disagree. Also decision 39's admin rendering, and its second half: **`assign` and
  `swap` both reactivate a returned row** instead of inserting over it and violating the unique
  index.

### Verified without a browser

- `npm run verify` — 369 tests, typecheck, lint.
- `npm run build` — the "a `use server` file may only export async functions" trap fired once, on
  `claimMessage`, and moving it to `lib/claim-slot.ts` is why that module owns the message map.
- `npx tsx prisma/checks/claim-race.ts` — 8 checks, all passing, fixtures cleaned up and verified.

---

## Not built yet

- **The Slice 6 walkthrough.** Ten steps in `plans/phase-3.md` plus two below. **This is the next
  thing to do.**
- **The board-member run.** Slice 7. A gate step, not a demo, and it cannot be run by the owner.
- **The PRD status line.** Slice 8, and only after the whole gate passes by hand.
- **First-round and second-round dashboards.** Phases 5 and 6.

## Still open from the testing pass, and deliberately not code

F-01, F-05, F-06, F-09 — all `preference`, each a PRD conversation first. See
`plans/phase-3-test-pass.md`.

---

## The two walkthrough steps decision 38 added

Beyond the ten in `plans/phase-3.md`:

11. Type a note and, **before it saves**, return the applicant. It leaves the list with no "Still
    saving" hold. Claim it back from the pool and reopen it: the saved scores are there and the
    discarded draft is not.
12. Return an applicant with everything already saved. Nothing is lost and no dialog appears — the
    common case must not have gained a step.

**Step 6 still needs two devices** signed in as two different reviewers, both eligible for the same
one-slot applicant, tapping Claim within the same second. `claim-race.ts` is a pre-flight for the
lock, not a substitute: it skips HTTP, the session, and Next's per-client sequential dispatch, and
that dispatch is exactly what would hide the race in one browser.

---

## Known hazards

Everything from the end of Slice 5 still applies. Added by Slice 6:

- **A concurrency check that passes may be checking nothing.** Two versions of `claim-race.ts` passed
  over a deliberately unlocked copy of the claim before the third one caught it. Two concurrent
  claims serialize on their own often enough to refuse correctly by accident; and "the claim blocks
  while the row is locked" is true whether or not the claim takes the lock, because inserting an
  `Assignment` takes a `FOR KEY SHARE` lock on its parent `Applicant` for the foreign key. The
  version that discriminates takes the last slot **while the claim is waiting**, which is the only
  thing that separates a fresh eligibility read from a stale one. Before trusting any check here, ask
  what it would do against the bug.
- **`redirect()` must be called outside `$transaction`.** It reports by throwing a control-flow
  error, and thrown inside an interactive transaction that error is a rollback — the claim would be
  undone and the reviewer would land on an applicant that is not theirs. `claimSlot` captures the
  outcome and redirects after the transaction closes.
- **Prisma cannot select the same relation twice** under two different filters, so the admin
  assignments page reads active and returned rows in one relation query and partitions them in JS.
- **`assignReviewer` and `swapReviewer` could not previously see a returned row**, because both read
  only ACTIVE assignments before inserting. Fixed, but the shape is worth remembering: a query that
  filters `status: ACTIVE` for a *display* purpose is often wrong for a *uniqueness* purpose, and
  this codebase has that filter in a lot of places.
- **The `@/` alias does resolve under `tsx`**, verified rather than assumed, which is why
  `prisma/checks/claim-race.ts` can import `lib/claim-slot.ts` and drive the real transaction instead
  of a copy of it.

---

Next: **run the Slice 6 walkthrough on a phone**, fix what it finds, then Slice 7.
