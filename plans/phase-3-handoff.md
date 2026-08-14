# Phase 3 handoff — end of Slice 4, plus the fix pass

**As of `ab79803`, 2026-08-14.** Slices 0–4 are committed, and the testing pass's five defects are
fixed. Slices 5–8 are not built. **Next session starts at Slice 5.**

This is a resume-point document, not a plan. `plans/phase-3.md` is the plan; this says what actually exists, what does not, and what is waiting to be verified.

---

## Starting up

```bash
npm run dev        # http://localhost:3000, and http://<lan-ip>:3000 for a phone
```

The LAN address is printed as "Network" in the `next dev` banner — it was `192.168.1.110` on 2026-08-11, but it is DHCP and will move. Phone testing needs `DEV_ALLOWED_ORIGINS` in `.env` set to that host, or every JS chunk 403s and the page loads but nothing works. See `.env.example`.

**If you have pulled a schema change, restart the dev server.** A running server keeps the old Prisma client in memory and fails with `Unknown field 'x' ...` while `npm run verify` passes completely. See CLAUDE.md.

### Credentials

| What | Value |
|---|---|
| App-level password | Yours — only its argon2 hash is in `.env`. `npm run hash-secret -- "new password"` to replace. |
| Instance password | `phase0-dev-password` (`prisma/seed.ts`) |
| Round codes | **`written-f26`**, `firstround-s26`, `secondround-s26` — the written code was rotated on 2026-08-13 while testing the access-code card. `written-s26` is dead. `prisma/seed.ts` still writes `written-s26`, so `npm run seed` resets it. |
| Seed instance id | `seed_s26_demo` |

### Fixture state

150 applicants · 30 reviewers (8 Sparklets) · 428 assignments · loads 14–15 · 128 applicants at 3 reviewers, 22 at 2 · **0 scores** · 4 rubric categories, all with descriptions.

`npm run seed` rebuilds everything **and wipes assignments** — regenerate them from `/instances/seed_s26_demo/assignments` afterwards, or the reviewer list is empty.

---

## Reviewer surface — `/r/…`

Outside the §8 admin gate. Reviewers never see the instance list.

| Route | Does | Status |
|---|---|---|
| `/r/<instanceId>?round=WRITTEN` | Sign-in: round picker, name dropdown, access code, one submit (decision 30) | Works |
| `/r/<instanceId>/list` | Assigned applicants; per-row `n/4 categories` and header `n of m complete` | Works |
| `/r/<instanceId>/a/<assignmentId>` | Anonymous label, all visible RESPONSE fields, sticky rubric card with descriptions, prev/next | Works, **read-only** |

Session is a separate signed cookie (`spark_reviewer`), 7 days, scoped to one instance and one round.

## Admin surface — `/instances/<id>/…`

Behind the app-level password, then the instance password.

| Route | Does |
|---|---|
| `/` | Instance list |
| `/instances/new` | FR-2 CSV import |
| `/instances/<id>` | **Instance hub** — every surface in cycle order with its current state (decision 36). Was an unconditional redirect to `…/mapping` until `d8c42ca` |
| `…/mapping` | Field categories, inclusion, OTHER per-round visibility. **Still reachable after commit** — identity is frozen, the three booleans are not (decision 34) |
| `…/preview` | FR-3 duplicates, blanks, **two-step commit** (decision 35) |
| `…/rubric` | FR-4 builder — name, max points, **description** (400 chars) |
| `…/reviewers` | FR-6 roster, paste, removal guard, **access-code card** |
| `…/assignments` | FR-7 precheck/generate, FR-8 assign/unassign/swap |
| `…/settings` | FR-5 password reset, instance deletion |
| `…/unlock` | Instance password, with the FR-5 recovery link (decision 29) |

---

## Not built yet

- **Score inputs and the note.** The rubric card shows `— / 5`. FR-9 clauses 3a/3b — Slice 5.
- **Autosave**, and everything decision 26 and 33 describe. Slice 5.
- **Return to pool.** Clauses 5a–5c — Slice 6.
- **Claim from pool.** `/r/<id>/pool` does not exist and 404s. Clauses 6a–6c — Slice 6.
- **First-round and second-round dashboards.** Sign-in offers those rounds and the seed has codes, but no rosters and no dashboards exist behind them. Phases 5 and 6.

## Waiting to be verified — **both closed 2026-08-13**

Both were Slice 3 leftovers that could not be driven from the automation harness. Both passed in the
structured testing pass; see **`plans/phase-3-test-pass.md`** for that pass in full.

1. ~~**Sign-in lockout.**~~ Passed — attempts 1–10 gave the code error, the 11th named a wait. It
   also surfaced **F-04**: the name dropdown's visible label reverts after every failed submission,
   though the submitted value survives. Diagnosed and fixed on 2026-08-14 in `42feb19`.
2. ~~**A non-seeded instance.**~~ Passed end to end, twice, including phone sign-in — decision 31
   satisfied on an instance built through FR-2.

## The fix pass — **complete for all five defects, 2026-08-14**

`plans/phase-3-test-pass.md` carried nine findings. The five defects are fixed and the PRD decisions
that had to precede three of them landed first, per CLAUDE.md's PRD-leads-code rule.

| Finding | Severity | Decision | Fix |
|---|---|---|---|
| F-07 — `…/reviewers` and `…/assignments` had no inbound link | blocks-gate | 36 | `d8c42ca` |
| F-03 — field visibility unreachable after commit | defect | 34 | `46b0ba8` |
| F-08 — commit was one unguarded click | defect | 35 | `d109f20` |
| F-02 — access-code placeholder was a real credential | defect | — | `fab954b` |
| F-04 — sign-in name reverted after a failed code | defect | — | `42feb19` |

**Still open, and deliberately not code:** F-01 (per-point rubric descriptions, a §5 change), F-05 and
F-06 (group creation and dissolution affordances), F-09 (within-paste duplicate resolution). All four
are `preference` — the screen does what the requirement says and the owner wants it done differently
— so each is a PRD conversation first. Read the test pass's own note on why that distinction matters
before picking one up.

**Nothing in the fix pass closes the Phase 3 gate.** Only step 1 (the RSC payload check) was ever
reachable; steps 2, 3 and 4 need Slices 5, 6 and 7. `PRD.md`'s status line is correctly still
`v1.5, Phase 0-2 complete, Phase 3 next`.

## Known hazards

- **Pre-hydration taps do nothing.** `<button type="button">` with `onClick` has no native behaviour, and hydration took ~640 ms on a warm route on desktop. `Generate assignments` is the one that bites in practice — tap it again. PRD decision 33; Slice 5 converts mutating controls to form submits.
- **`position: fixed` with `bottom: 0` is unusable on mobile Chrome.** It anchors to the layout viewport and renders below the visible area while the URL bar is showing. The score card uses `sticky` for this reason; do not "simplify" it back.
- **Clicking a native `<select>` from automation is unreliable — driving it from JavaScript is not.** Set the value through the native property setter and dispatch a bubbling `change`, and React's state receives it like a real selection; submit with `form.requestSubmit(button)`. Verified in Chrome on 2026-08-14 while diagnosing F-04, including reading the component's own hook state off the React fiber to confirm the selection had landed. That is what made a DOM-level diagnosis possible where reading server responses could not have reached it.
- **A server response cannot see a client-side rendering bug.** F-04 was invisible to every HTTP-level check in the testing pass, because the divergence was between React's state and the DOM after hydration. If a finding is about what a control *shows*, it has to be reproduced in a browser.
- **Server actions can be driven over HTTP, but the two kinds differ.** Plain-argument actions take a `Next-Action: <id>` header with a JSON array body, and the ids are in the page's client chunk (grep it for the exported name). Actions bound through `useActionState` reject that shape with `Connection closed` — replay the form's own hidden `$ACTION_REF_*` / `$ACTION_KEY` fields as multipart instead, with no `Next-Action` header, which is also exactly how the no-JavaScript path is tested.

## Commits in this phase

```
14aa534  Phase 3 plan
fdb468e  PRD decision 29 — FR-5 recovery path linked
913d4de  PRD decisions 26-28, 30, 31 + FR-9 entry route
c4565eb  Slice 2 — lib/review.ts
bd2c8a4  Slice 3 — reviewer sign-in + access code
cb55512  Slice 3 follow-up — access-code card staleness
73427e6  PRD decision 32 — rubric needs descriptions
82d5e10  FR-4 — RubricCategory.description
c39d8d9  PRD decision 33 — pre-hydration data loss
fbdb17a  Slice 4 — assigned list and applicant detail
6eab63b  CLAUDE.md — restart next dev after prisma generate
a6ecc39  Phase 3 handoff — what exists at the end of Slice 4
16045d7  Phase 3 testing pass — nine findings, one blocking
```

Then the fix pass, 2026-08-14 — PRD decisions leading their code in every case:

```
1c32fe9  PRD decisions 34-35 — what commit may freeze, and its guard
ccb61a8  Test pass — point F-03 and F-08 at their decisions
47f4a25  PRD decision 36 — an instance hub
d8c42ca  F-07 — the instance hub                        (blocks-gate)
46b0ba8  F-03 — visibility survives the commit
d109f20  F-08 — two-step guard on the commit
fab954b  F-02 — access-code placeholder + doc catch-up
42feb19  F-04 — sign-in name no longer reverts
ab79803  Test pass — record F-02/F-04 fixed, close the record
```

Next: Slice 5, carrying decision 33's three mitigations — adopt DOM values on mount, mutating controls as form submits, disabled rather than silently inert. Note that F-04's fix is a fourth instance of the same family, and worth reading first: `app/r/[instanceId]/sign-in-form.tsx` documents why controlled state alone does not survive React's post-action form reset on a `<select>`, which is the same reset Slice 5's score inputs will meet.
