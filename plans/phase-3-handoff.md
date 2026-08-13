# Phase 3 handoff — end of Slice 4

**As of `6eab63b`, 2026-08-11.** Slices 0–4 are committed and pushed. Slices 5–8 are not built.

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
| `…/mapping` | Field categories, inclusion, OTHER per-round visibility |
| `…/preview` | FR-3 duplicates, blanks, commit |
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
   though the submitted value survives.
2. ~~**A non-seeded instance.**~~ Passed end to end, twice, including phone sign-in — decision 31
   satisfied on an instance built through FR-2.

**Read `plans/phase-3-test-pass.md` before starting Slice 5.** It carries nine findings, one of them
**blocks-gate** (F-07: `…/reviewers` and `…/assignments` have no inbound link from anywhere in the
app, so FR-6 and FR-7/FR-8 are reachable only by typing a URL). Agreed fix order: F-07, then F-08 and
F-03 together, then F-02 and F-04. Four preferences are held for a separate PRD conversation.

## Known hazards

- **Pre-hydration taps do nothing.** `<button type="button">` with `onClick` has no native behaviour, and hydration took ~640 ms on a warm route on desktop. `Generate assignments` is the one that bites in practice — tap it again. PRD decision 33; Slice 5 converts mutating controls to form submits.
- **`position: fixed` with `bottom: 0` is unusable on mobile Chrome.** It anchors to the layout viewport and renders below the visible area while the URL bar is showing. The score card uses `sticky` for this reason; do not "simplify" it back.
- **Automation cannot reliably drive a native `<select>` or a submit button.** Verify reviewer flows over HTTP with a minted session cookie, or by hand.

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
```

Next: Slice 5, carrying decision 33's three mitigations — adopt DOM values on mount, mutating controls as form submits, disabled rather than silently inert.
