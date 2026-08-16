# Phase 3 handoff — PHASE COMPLETE

**As of `3ddc6ec`, 2026-08-16.** **Phase 3 is done.** All nine slices are committed and pushed, the
whole BUILD_PLAN gate has been walked by hand, and `PRD.md` reads `v1.6, Phase 0-3 complete, Phase 4
next`. **The next step is Phase 4 — FR-10 and FR-11, written results and selection.**

**Read `plans/phase-3-board-run.md` before Phase 4.** Slice 7's board-member run produced ten
findings; nine are resolved, and the file is also explicit about what the gate did *not* establish —
the board member works in app design, and the second-person re-run was deliberately skipped, so
nobody without a design background has used the reviewer screen.

**Two things carried out of Phase 3, both deliberate:**

- **F-12**, open at `cosmetic`. The rubric card's scroll chaining is fixed; a residual
  momentum-capture behaviour on iOS remains and is most likely WebKit's rather than ours. An Android
  phone is the test that discriminates.
- **PRD decision 40**, due in Phase 4. `RubricCategory` gains `minPoints Int @default(0)` so the
  written scale can run 1–4 instead of 0–`maxPoints`. Deferred out of Phase 3 on purpose: the
  migration would have landed mid-gate. §5 lists the column as planned and not yet built.

This is a resume-point document, not a plan. `plans/phase-3.md` is the plan; this says what actually
exists, what does not, and what is waiting to be verified.

---

## Read this first

**Slice 6 passed all twelve walkthrough steps**, including the three that no test can produce:

- **Step 6, the claim race** — two devices signed in as two different reviewers, both tapping Claim
  on the same one-slot applicant. One landed on the applicant, the other was told the slot had gone
  and got a pool list that no longer offered it. Neither saw a 500.
- **Step 8, the re-claim** — an applicant returned for conflict of interest and then claimed back
  produced **one** row, `ACTIVE` / `CLAIMED_FROM_POOL` with the return fields cleared, not two.
  Decision 28 holds in practice.
- **Steps 11 and 12, the draft mirror** — a return with unsaved work leaves without a "Still saving"
  hold and discards only the unconfirmed draft; a return with everything saved gains no step.
  Decision 38 holds in practice.

Nothing outstanding from the walkthrough. Phase 2 shipped four defects that only a person using the
screen could find, and this is the pass that would have found their equivalents.

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

**A dev server is running** on `http://localhost:3000`, `http://192.168.1.110:3000` on the LAN,
started 2026-08-16 for the Slice 7 setup.

### Credentials

| What | Value |
|---|---|
| App-level password | Yours — only its argon2 hash is in `.env`. `npm run hash-secret -- "new password"` to replace. |
| Instance password | `phase0-dev-password` (`prisma/seed.ts`) |
| Round codes | **`written-s26`**, `firstround-s26`, `secondround-s26` — the seed's own values. `written-f26` was live between 2026-08-13 and the Slice 7 reseed and is now dead. |
| Seed instance id | `seed_s26_demo` |

### Fixture state — rebuilt 2026-08-16, then used by the board-member run

**The numbers below are the state immediately after the rebuild. The run then moved them:** it added
scores and a note on one applicant, two `RETURNED_TO_POOL` rows and one `CLAIMED_FROM_POOL`, so the
rubric is **locked again** and the assignment mix is no longer all-`AUTO`. Exact post-run counts were
not recorded; `npm run seed` is the reset and the recipe below is the way back.

**The Slice 6 walkthrough state is gone**, deliberately. `npm run seed` was run to give the board
member a clean fixture, which wiped the 427 assignments, the 12 `Score` and 4 `ReviewNote` rows, and
Fatima Fitzgerald's four `RETURNED_TO_POOL` rows. Everything that state demonstrated is recorded in
"What Slice 6 shipped" below and in the commits; none of it needed to survive in the database.

150 applicants · **31** written reviewers (8 Sparklets) · 4 rubric categories at 5 points each.

The 31st is the board member added for Slice 7, non-Sparklet, carrying 14 assignments. See
`plans/phase-3-board-run.md`, which is the setup record and the observation sheet both.

| | |
|---|---|
| `ACTIVE`, `AUTO` | 428 |
| `ACTIVE`, `CLAIMED_FROM_POOL` | 0 |
| `RETURNED_TO_POOL` | 0 |
| Applicants at 3 reviewers | 128 |
| Applicants short one | 22 |
| Load per reviewer | 13–15 |

**Two consequences, the reverse of what the Slice 6 handoff warned about:**

- **The rubric is unlocked again.** No `Score` row exists, so FR-4's lock on
  `/instances/seed_s26_demo/rubric` has disengaged. It re-engages the moment the board member scores
  anything, which will happen during the run.
- **22 applicants are short, not 27.** The 5% pool exactly, with no returns on top of it.

`npm run seed` rebuilds everything **and wipes assignments** — regenerate them from
`/instances/seed_s26_demo/assignments` afterwards, or the reviewer list is empty. It also drops the
board member from the roster, so re-add them *before* regenerating; the ordering matters and failing
it produces an empty list rather than an error.

---

## Reviewer surface — `/r/…`

Outside the §8 admin gate. Reviewers never see the instance list.

| Route | Does | Status |
|---|---|---|
| `/r/<instanceId>?round=WRITTEN` | Sign-in: round picker, name dropdown, access code, one submit (decision 30) | Works |
| `/r/<instanceId>/list` | Assigned applicants, completion state, pool link with a live count, return control per row | Works |
| `/r/<instanceId>/a/<assignmentId>` | Responses, sticky rubric, scoring, note, autosave, guarded prev/next, return control | Works |
| `/r/<instanceId>/pool` | Claim from pool — label, `n of 3 reviewers`, one-tap Claim | Works |

Session is a separate signed cookie (`spark_reviewer`), 7 days, scoped to one instance and one round.

## Admin surface — `/instances/<id>/…`

Unchanged except `…/assignments`, which now renders **returned rows** under each applicant —
`Returned · Jane Doe — knows the applicant`, dimmed and with no controls. Decision 39.

---

## What Slice 6 shipped

Three code commits, then `6e0171c` and this document recording them.

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

### How it was verified

- **The twelve-step walkthrough, on real hardware**, including two devices for the claim race. See
  "Read this first". This is the one that counts.
- `npm run verify` — 369 tests, typecheck, lint.
- `npm run build` — the "a `use server` file may only export async functions" trap fired once, on
  `claimMessage`, and moving it to `lib/claim-slot.ts` is why that module owns the message map.
- `npx tsx prisma/checks/claim-race.ts` — 8 checks, all passing, fixtures cleaned up and verified.
  Re-run it after any schema change; it is not part of `npm run verify`.

---

## Not built yet

- **The board-member run.** Slice 7, and **the next thing to do.** A gate step, not a demo. It cannot
  be run by the owner and it cannot be run twice on the same person. All eight steps are in
  `plans/phase-3.md`. **Done** — 2026-08-16, findings in `plans/phase-3-board-run.md`. Clauses 5a and
  6a are met: he used return-to-pool and claim-from-pool without being told where either lives.
- **The PRD status line.** Slice 8. **Done** — `3ddc6ec`, after every gate clause had a record behind
  it.
- **Written results and selection.** FR-10 and FR-11, Phase 4, and **the next thing to do.**
- **First-round and second-round dashboards.** Phases 5 and 6.

### One thing Phase 4 should know about the fixture

FR-10 ranks by average score and variance across three reviewers. **The seed does not generate any
scores** — every `Score` row in the database was typed by hand during a walkthrough, so there is
currently about one applicant's worth of real data and nothing for a ranking to rank. Phase 4 will
want the seed to produce scores, or a script that does, before FR-10 can be looked at rather than
merely compiled. Worth planning for rather than discovering on the first render.

## Still open from the testing pass, and deliberately not code

F-01, F-05, F-06, F-09 — all `preference`, each a PRD conversation first. See
`plans/phase-3-test-pass.md`.

---

## The two walkthrough steps decision 38 added

Recorded because they are not in `plans/phase-3.md`'s numbered list and a re-run should include them.
Both passed.

11. Type a note and, **before it saves**, return the applicant. It leaves the list with no "Still
    saving" hold. Claim it back from the pool and reopen it: the saved scores are there and the
    discarded draft is not.
12. Return an applicant with everything already saved. Nothing is lost and no dialog appears — the
    common case must not have gained a step.

**Step 6 needs two devices** signed in as two different reviewers, both eligible for the same
one-slot applicant, tapping Claim within the same second. `claim-race.ts` is a pre-flight for the
lock, not a substitute: it skips HTTP, the session, and Next's per-client sequential dispatch, and
that dispatch is exactly what would hide the race in one browser. Passed on the first attempt.

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

Next: **Slice 7, the board-member run.** Pick someone who has not seen the tool and has not been in
any conversation about it, send them the `/r/seed_s26_demo?round=WRITTEN` link and the access code in
one message with no explanation, and say nothing while they use it. Every place they get stuck is a
Phase 3 defect fixed in Phase 3 — not deferred to a reviewer guide, which is the artefact FR-9's
premise exists to make unnecessary.
