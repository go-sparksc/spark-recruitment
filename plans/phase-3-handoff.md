# Phase 3 handoff — end of Slice 5

**As of `707420f`, 2026-08-14.** Slices 0–5 are committed and pushed. **Next session starts at
Slice 6 — return to pool and claim from pool.**

This is a resume-point document, not a plan. `plans/phase-3.md` is the plan; this says what actually
exists, what does not, and what is waiting to be verified.

---

## Starting up

```bash
npm run dev        # http://localhost:3000, and http://<lan-ip>:3000 for a phone
```

The LAN address is printed as "Network" in the `next dev` banner — it was `192.168.1.110` on
2026-08-14, but it is DHCP and will move. Phone testing needs `DEV_ALLOWED_ORIGINS` in `.env` set to
that host, or every JS chunk 403s and the page loads but nothing works. See `.env.example`.

**If you have pulled a schema change, restart the dev server.** A running server keeps the old Prisma
client in memory and fails with `Unknown field 'x' ...` while `npm run verify` passes completely. See
CLAUDE.md.

**No dev server is running.** The one from the Slice 5 session was stopped deliberately at the end of
it, so port 3000 is free.

### Credentials

| What | Value |
|---|---|
| App-level password | Yours — only its argon2 hash is in `.env`. `npm run hash-secret -- "new password"` to replace. |
| Instance password | `phase0-dev-password` (`prisma/seed.ts`) |
| Round codes | **`written-f26`**, `firstround-s26`, `secondround-s26` — the written code was rotated on 2026-08-13 while testing the access-code card. `written-s26` is dead. `prisma/seed.ts` still writes `written-s26`, so `npm run seed` resets it. |
| Seed instance id | `seed_s26_demo` |

### Fixture state

150 applicants · 30 reviewers (8 Sparklets) · 428 assignments · loads 14–15 · 128 applicants at 3
reviewers, 22 at 2 · **0 scores** · 4 rubric categories at 5 points each, all with descriptions.

Scores and a note were written and then cleared again during Slice 5's smoke test, so the fixture is
back where it started. **That matters more than it used to:** FR-4 locks the rubric the moment any
`Score` row exists, so the first real score taken on the seed instance will lock
`/instances/seed_s26_demo/rubric` until someone runs the reset. That is correct behaviour, not a
regression — it has simply never been reachable before this slice.

`npm run seed` rebuilds everything **and wipes assignments** — regenerate them from
`/instances/seed_s26_demo/assignments` afterwards, or the reviewer list is empty.

---

## Reviewer surface — `/r/…`

Outside the §8 admin gate. Reviewers never see the instance list.

| Route | Does | Status |
|---|---|---|
| `/r/<instanceId>?round=WRITTEN` | Sign-in: round picker, name dropdown, access code, one submit (decision 30) | Works |
| `/r/<instanceId>/list` | Assigned applicants; per-row `n/4 categories` and header `n of m complete`; sign-out clears drafts | Works |
| `/r/<instanceId>/a/<assignmentId>` | Anonymous label, all visible RESPONSE fields, sticky rubric card, **scoring, note and autosave**, guarded prev/next | Works |
| `/r/<instanceId>/pool` | Claim from pool | **Does not exist — 404s.** Slice 6 |

Session is a separate signed cookie (`spark_reviewer`), 7 days, scoped to one instance and one round.

## Admin surface — `/instances/<id>/…`

Behind the app-level password, then the instance password.

| Route | Does |
|---|---|
| `/` | Instance list |
| `/instances/new` | FR-2 CSV import |
| `/instances/<id>` | **Instance hub** — every surface in cycle order with its current state (decision 36) |
| `…/mapping` | Field categories, inclusion, OTHER per-round visibility. **Still reachable after commit** — identity is frozen, the three booleans are not (decision 34) |
| `…/preview` | FR-3 duplicates, blanks, **two-step commit** (decision 35) |
| `…/rubric` | FR-4 builder — name, max points, **description** (400 chars). **Locks once any Score exists** |
| `…/reviewers` | FR-6 roster, paste, removal guard, **access-code card** |
| `…/assignments` | FR-7 precheck/generate, FR-8 assign/unassign/swap |
| `…/settings` | FR-5 password reset, instance deletion |
| `…/unlock` | Instance password, with the FR-5 recovery link (decision 29) |

---

## What Slice 5 shipped

FR-9 clauses 3a, 3b, 4a and 4b. The rubric card stopped being read-only.

- **Every mutating control is a form submit bound to a server action**, per decision 33. A score is a
  `<button type="submit" name="points" value="3">` inside `<form action={saveScoreForm}>`, so a tap
  before React attaches is a completed native POST. After hydration `onSubmit` calls
  `preventDefault` first, which suppresses React's own dispatch, and the autosave queue sends it —
  one request rather than a route re-render.
- **Segmented 0…maxPoints** at `maxPoints ≤ 10`, falling back to a number input above that. `—`
  clears, sending `points=""`, which is what takes 3/4 back to 2/4.
- **`lib/autosave.ts`** holds the queue as a pure state machine over an injected clock: debounce,
  coalescing, one flight per key, backoff, and the in-flight timeout. 22 tests. It never performs a
  save — `use-autosave.ts` interprets its effects, and that split is what makes the timing testable.
- **The localStorage mirror** (decisions 26 and 37) is written on every change and cleared only on a
  confirmed save, on sign-out, or by a 7-day TTL.
- **`GuardedLink`** holds an in-app navigation up to 1500 ms, then offers Wait / Leave anyway.

### Verified on a real phone

Walkthrough steps 4 and 5 both pass: airplane mode shows `Unsaved — will retry` and never `Saved`;
turning it off resolves cleanly; force-quitting with unsaved work restores it still marked unsaved.

The no-JavaScript path was driven end to end over HTTP as well — score saved, note saved,
`points=99` refused server-side, both cleared again.

---

## Not built yet

- **Return to pool.** Clauses 5a–5c — Slice 6.
- **Claim from pool.** `/r/<id>/pool` does not exist and 404s. Clauses 6a–6c — Slice 6, including the
  `SELECT … FOR UPDATE` concurrency case that needs two devices to test.
- **The board-member run.** Slice 7. It is a gate step, not a demo, and it cannot be run by the owner.
- **The PRD status line.** Slice 8, and only after the whole gate passes by hand.
- **First-round and second-round dashboards.** Sign-in offers those rounds and the seed has codes, but
  no rosters and no dashboards exist behind them. Phases 5 and 6.

## Still open from the testing pass, and deliberately not code

F-01 (per-point rubric descriptions, a §5 change), F-05 and F-06 (group creation and dissolution
affordances), F-09 (within-paste duplicate resolution). All four are `preference` — the screen does
what the requirement says and the owner wants it done differently — so each is a PRD conversation
first. See `plans/phase-3-test-pass.md`.

---

## Known hazards

Everything from the end of Slice 4 still applies. Added by Slice 5:

- **An in-flight request needs a deadline, not just a retry.** A `fetch` issued while the radio is
  down does not reliably reject — it can hang forever. Slice 5 originally had retry-on-failure but no
  timeout, and the retry path skipped any key already `sending`, so a save caught across an
  offline→online transition was unreachable by the very code meant to rescue it: stuck on `Saving…`
  indefinitely. Found on a phone in walkthrough step 4. `KeyState.timeoutAt` and the `attempt`
  generation are the fix; do not collapse `dueAt` and `timeoutAt` back into one field.
- **A `"use server"` file may only export async functions.** A `const` export there passes typecheck,
  lint and all 360 tests, and fails only at `npm run build`. **Run `npm run build`, not just
  `npm run verify`, on anything touching a server-action module.**
- **A long-running `next dev` goes stale.** After several hours it served a 3 KB Pages-router error
  shell for `/r/[instanceId]` with `Failed to generate static paths` and Jest worker crashes in
  `.next/dev/logs/`, while `npm run build` compiled the same route cleanly. Restart it; the build
  passing while dev does not is the tell.
- **`__gcruniqueid` / `__gcrremoteframetoken` hydration warnings are a browser extension**, not this
  app. React's diff names them on `<html>`, the sign-in `<form>`, the `<select>` and the `<input>`;
  no application attribute is involved, and the warning is development-only. Confirmed 2026-08-14 by
  reading the component stack out of the dev log. Do not go looking for an app-side cause.
- **The controlled/uncontrolled asymmetry is load-bearing in both directions.** The score card's
  fields are **uncontrolled**, because React overwrites a controlled field with its own empty state at
  hydration and discards anything typed in that window (decision 33). `sign-in-form.tsx`'s `<select>`
  is **controlled with a ref write-back**, because a form React *dispatches* is reset when its action
  settles (F-04). Neither score-card field sits in a dispatched form, which is what makes uncontrolled
  safe there. Changing either half breaks the other.

---

## Commits in this phase

Slices 0–4 and the fix pass are listed in the git log from `14aa534` to `ab79803`. Slice 5:

```
1cb1803  PRD decision 37 — what clears the offline draft mirror
ee0687f  Slice 5 — the autosave queue as a pure state machine
95dd832  Slice 5 — score inputs, the note, and autosave
707420f  Slice 5 — recover from a save that never answers
```

All pushed to `origin/main`.

Next: **Slice 6**, clauses 5a–6c. Read `plans/phase-3.md`'s Slice 6 section first — the claim
concurrency case is the one piece of it that is not obvious, and its walkthrough step 6 needs two
devices signed in as two different reviewers.
