# Phase 3 — Reviewer dashboard, written round (FR-9)

**Gate (BUILD_PLAN Phase 3):** open on an actual phone. Score an applicant. Kill the network mid-review and confirm nothing is lost. Confirm that a request for a hidden demographic field returns nothing *from the server*, not just nothing on screen. Have one board member who has never seen it complete a review without instructions.

---

## Context

Phase 2 ends with 428 `Assignment` rows pointing 30 reviewers at 150 applicants, and no way for a reviewer to see one. Every score in this system still lives in a separate spreadsheet, which is the failure mode PRD §1 names last and fixes least often. This phase is the surface that makes the platform load-bearing rather than a better-organized admin tool.

Two things make it different from Phases 1 and 2:

**The audience has never seen it, is on a phone, and will use it once.** CLAUDE.md rule 5: every additional tap is a review that does not get completed. That constraint decides the layout, the sign-in shape, and why the pool is one link rather than a section you scroll past.

**This phase is entirely UI, so the browser walkthrough is the gate, not a step after it.** Every defect Phase 2 shipped — the FR-6 manual-add gap, all five Slice 4 gaps — was found by the owner clicking through, and not one by tests, typecheck, or diff review. So each slice below carries its own walkthrough, and the phone walkthrough happens at Slice 3, not at the end.

**FR-9 is a six-bullet list**, which is the exact shape that broke twice in Phase 2 — first clause implemented, rest silently dropped, with tests and commit message agreeing with the implementation and wrong together. The clause ledger below is the mechanical guard, ticked against the plan now and against the diff before each commit.

### What is missing that FR-9 assumes exists

- **No reviewer authentication of any kind.** `proxy.ts` redirects every path except `/login` to the app-level password gate. `RoundAccessCode` rows are created only by `prisma/seed.ts`; nothing reads them. BUILD_PLAN's Phase 3 build list includes "name selection with access code," so this is in scope.
- **No admin surface for the access code.** An instance built through FR-2 has no `RoundAccessCode` row at all, so its reviewer dashboard is unreachable and the gate's last clause ("a board member who has never seen it") can only be met on the seeded instance. Ships as a minimal set/rotate control — see decision 31.
- **`resetWrittenScores` deletes every `Score`**, so after an FR-4 reset-and-relock the completion state reads `0/5`, not `4/5`. The stated test case is satisfied either way — the denominator reads 5 and a previously-complete applicant reads incomplete — but the parenthetical "until the new category is filled" implies the old four survive, and they do not. Flagged rather than silently reconciled; the pure completion function is tested at both `0/5` and `4/5`, since `4/5` is reachable without a reset (adding a category before any score exists is not blocked).

---

## Clause ledger

The mechanical guard from CLAUDE.md. Ticked against this plan now; re-ticked against the diff before each commit.

| # | FR-9 clause, verbatim | Slice | Ticked by |
|---|---|---|---|
| 0 | "Reviewer selects Round → Written, then their name from a dropdown" | 3 | Round picker on `/r/[id]`, prefilled from `?round=`; name `<select>` beside it |
| 1a | "Their assigned applicants as a list" | 4 | `/r/[id]/list`, `status: ACTIVE` assignments for this reviewer + round |
| 1b | "with completion state (0/4 scored, 4/4 scored)" | 4 | `completionOf()` per row **and** an aggregate "2/4 complete" header |
| 2a | detail view: "anonymous label (e.g. 'Applicant 47')" | 4 | `resolvePromoted().anonymousLabel`, built from `sourceRowIndex` |
| 2b | "all RESPONSE fields" | 4 | `visibleFieldIds(..., "WRITTEN_REVIEWER")` — RESPONSE plus any OTHER opted in |
| 2c | "rubric always visible alongside" | 4 | Sticky bottom card on narrow, sticky right rail ≥`lg`. Renders in Slice 4 read-only; gains inputs in Slice 5 |
| 2d | "No name, per §6" | 4 | `displayName`/`email` never leave the server; asserted on the pure view builder and in the RSC payload |
| 3a | "Score inputs per rubric category" | 5 | One numeric input per live `RubricCategory`, `0…maxPoints` |
| 3b | "plus a free-text note" | 5 | `ReviewNote` textarea in the same card, same autosave path |
| 4a | "Autosave on every change" | 5 | Debounced per-key autosave on **both** scores and note |
| 4b | "A dropped connection mid-review must not lose work" | 5 | Unsaved state visible, retry on reconnect, `localStorage` mirror, idempotent upsert |
| 5a | "'Return to pool' on any applicant" | 6 | Control on every row of the list **and** on the detail screen |
| 5b | "with a required reason" | 6 | Submit disabled until a reason is picked; server re-checks |
| 5c | "(conflict of interest / other)" | 6 | Both `ReturnReason` values offered; free text optional for both (decision 27) |
| 6a | "'Claim from pool'" | 6 | `/r/[id]/pool`, linked from the list header with a live count |
| 6b | "showing open assignment slots" | 6 | `target − activeCount` per applicant, from `planShape()` |
| 6c | "on applicants who are short a reviewer" | 6 | Only applicants with ≥1 open slot; excludes ones this reviewer already holds |

**One clause added beyond the enumerated cases, deliberately:** a Sparklet reviewer may not claim a slot on an applicant who already has a Sparklet. Nothing in FR-9 or the test cases says so, but CLAUDE.md's domain vocabulary makes "at most one Sparklet reviews any given applicant" an invariant of the system rather than a property of generation, and a claim that breaks it produces exactly the situation FR-7's precheck exists to prevent. Enforced in the claim list (filtered out) and re-checked inside the claim transaction.

---

## Slice order

**Nine slices, eight of which produce a commit.** Slices 0–6 are one commit each; Slice 7 is the board-member run and produces no commit of its own, only however many fixes it finds; Slice 8 is the status line. Two PRD-only commits lead, per CLAUDE.md's PRD-leads-code rule. Each pure module ships and is read before the UI that consumes it.

---

### Slice 0 — PRD §10 decision 29, alone in its own commit

**The code half already shipped** in `fdc735d`, "Link the FR-5 recovery path from the unlock page" — `app/instances/[id]/unlock/page.tsx` now carries an unconditional `<Link>` to `/instances/[id]/settings`, with a comment explaining why it belongs on that page specifically. Verified by reading the file; nothing to build.

What is still missing is the §10 entry. This commit adds it and nothing else, on the Phase 2 Slice 0 precedent — a correction buried in a feature commit is one nobody reads.

> **29. A recovery path named in prose is not a recovery path. RESOLVED: linked from `/unlock`.** FR-5 puts instance password reset behind the app-level password alone, precisely so an admin who has lost the instance password has a way back. `/unlock` had described that route since Phase 1 without linking it, and the settings page's only inbound link sat inside `/mapping` behind `requireInstance` — so the sole route to the recovery was gated on the password being recovered. The link is unconditional and lives on `/unlock` specifically, because that page renders exactly when the session does *not* hold the instance, which is the state a locked-out admin is in. Found by the owner's Phase 2 walkthrough, not by review; recorded here because a capability that is correct and unreachable is indistinguishable from one that is missing.

**Verify:** read the diff. `PRD.md` only.

---

### Slice 1 — PRD §10 decisions 26 through 28, plus 30 and 31

Own commit, before any FR-9 code. 26, 27 and 28 are the owner's resolutions of the three open cases in the test block. 30 and 31 are new ambiguities this plan hit; CLAUDE.md says to add them to §10 rather than pick silently.

#### 26. A save in flight when the reviewer navigates away

**The threshold proposed: 1500 ms**, with the reasoning stated in full because the number is the thing the owner most needs to be able to correct.

- One upsert through a server action against Postgres is 80–250 ms in practice. Add a slow-4G round trip (~300 ms) and a healthy save still settles well under 600 ms. **1500 ms is roughly 5× the realistic worst case on a working connection**, so on any connection that is actually working the reviewer never sees a dialog — which is the "if the in-flight save resolves fast enough, navigation isn't blocked" half.
- It sits **below the ~2 s at which a person concludes the app is stuck and force-closes it** — which is the behaviour that would cause the loss this case is about. A guard that fires after the user has already given up is not a guard.
- It sits **above the ~1 s** that reads as an uninterrupted flow of thought, so a dialog at 1.5 s reads as "something is wrong" rather than as a normal step in the review.

**What the app can actually do, stated honestly, because the three navigation kinds differ:**

- **In-app navigation** (Back to list, Next applicant, the SPA back button) is genuinely holdable. Unsettled work past 1500 ms shows a blocking "Still saving" state with *Wait* and *Leave anyway*; if the save has already failed it says so and offers *Retry* and *Leave anyway*.
- **Tab close and hard unload are not holdable.** `beforeunload` is the only lever, it is synchronous, and the reviewer can dismiss it. It is registered whenever anything is dirty or in flight.
- **Backgrounding the app** — which on a phone is the common case, not the exception — flushes the pending debounce immediately on `pagehide` / `visibilitychange: hidden` rather than waiting it out, so most of these never become a warning at all.

**So the actual "never a silent loss" guarantee is not the dialog.** It is that every keystroke is mirrored to `localStorage` under the assignment id and cleared only on a confirmed save, and restored when the reviewer next opens that applicant. The dialog reduces how often that restore is needed; the mirror is what makes the promise true even when the OS kills the tab.

#### 27. Free text on "Other"

> **RESOLVED: optional, the same as conflict of interest.** A required text box is a wall in front of the one action a reviewer takes when they recognize an applicant, and the reason category is what the admin acts on. `Assignment.returnNote` stays nullable for both values.

#### 28. Claiming a slot on an applicant you previously returned

> **RESOLVED: allowed, not blocked.** The reviewer judged their own conflict and the system does not second-guess it. **Implementation consequence, stated because it is not obvious:** `UNIQUE (round, applicantId, reviewerId)` means the re-claim cannot insert a second row — it reactivates the existing `RETURNED_TO_POOL` row to `ACTIVE`, sets `origin: CLAIMED_FROM_POOL`, and clears `returnReason`, `returnNote` and `returnedAt`. That also resolves the tension with decision 23: a returned row is an exclusion generation must never re-pair, but a reviewer deliberately re-claiming is not generation, and once the row is `ACTIVE` + `CLAIMED_FROM_POOL` it becomes preserved capacity under decision 21 rather than an exclusion.

#### 30. The reviewer roster is served before the access code is verified

> **RESOLVED: one screen, name and code submitted together.** §8 says the code "keeps friction at one extra field" — a field, not a screen — and FR-9's whole premise is that every extra tap costs a completed review. The cost is that anyone with the round link can see ~30 club members' names before entering anything. Accepted: the threat §8 names is impersonation ("a name dropdown alone would let anyone with the link vote as anyone"), which the code closes regardless of when the roster loads, and the roster is club members' names, not applicant data. If a future cycle wants the roster gated, the change is to load the dropdown after the code validates, on the same screen.

#### 31. Round access codes have no admin surface

> **RESOLVED: a minimal set/rotate control ships in Phase 3, on the reviewers page.** `RoundAccessCode` has existed since Phase 0 and only `prisma/seed.ts` writes one, so every instance created through FR-2 has no code and an unreachable reviewer dashboard. This is outside FR-9's six bullets and is shipped anyway, because the Phase 3 gate requires a board member to complete a review and that cannot happen on an instance with no code. It lives on `/instances/[id]/reviewers`, which is already round-scoped and is where an admin thinks about a round's staff. Setting a code hashes it with `hashSecret` and never displays it again; rotating replaces it. The shareable `/r/<id>?round=…` link is shown next to it.

**Also in this commit, an FR-9 text edit rather than a §10 entry:** FR-9's bullet list says nothing about how a reviewer reaches the dashboard, while §8 requires the code and BUILD_PLAN Phase 3 lists "round selection, name selection with access code." Add one sentence to FR-9 naming the entry route and the session, so the next maintainer does not read the six bullets as the whole surface.

**Verify:** read the diff. `PRD.md` only. Confirm nothing in §10 renumbers.

---

### Slice 2 — `lib/review.ts`, pure

No database, no Prisma client, matching `lib/assignment.ts`, `lib/passes.ts` and `lib/roster.ts`. This is where the three things worth verifying away from the UI live.

```ts
/// FR-9 bullet 1. Denominator is the LIVE rubric, numerator counts only scores
/// whose category still exists — which is what makes the FR-4 reset case correct
/// without a special path.
export function completionOf(
  categoryIds: readonly string[],
  scoredCategoryIds: readonly string[],
): { scored: number; total: number; complete: boolean };

/// FR-9 bullet 6. `target` comes from planShape() so the pool view and the
/// generator cannot disagree about how many slots an applicant has.
export function openSlotsOf(target: number, activeAssignmentCount: number): number;

/// Whether this reviewer may claim this applicant's open slot.
export function claimEligibility(
  reviewer: { id: string; isSparklet: boolean },
  applicant: { openSlots: number; assignedReviewerIds: readonly string[]; hasSparklet: boolean },
): { eligible: true } | { eligible: false; reason: "NO_OPEN_SLOTS" | "ALREADY_ASSIGNED" | "SECOND_SPARKLET" };

/// FR-9 bullet 2 and §6. The server-side projection, built where it can be
/// tested against plain objects rather than against a rendered page.
export function buildApplicantView(
  applicant: { sourceRowIndex: number; displayName: string; email: string | null; data: Record<string, unknown> },
  fields: readonly FieldLike[],
  groups: readonly FieldGroupLike[],
  viewer: Viewer,
): ApplicantView;
```

`ApplicantView` carries `label` (`"Applicant 47"`), and an ordered list of `{ fieldId, displayName, groupDisplayName, value }`. **It has no `displayName` and no `email` field at all** for a blind viewer — the type is narrowed by `resolvePromoted`, so a component cannot render a name that was never in the object. That is the difference between hiding a value and not having it.

Reuses `resolveField`, `visibleFieldIds`, `projectApplicantData`, `resolvePromoted` from `lib/fields.ts` and `planShape` from `lib/assignment.ts`. No new logic in either.

**Tests assert** — the test block's cases, restated as pure inputs:

- 4 categories, one assignment with 4 scores → `4/4`, complete. One with 3 → `3/4`. One with 0 → `0/4`.
- Denominator follows the live category list: the same three score sets against a 5-category rubric read `4/5`, `3/5`, `0/5`, and the `4/5` case is **not** complete. Both the reachable states of the FR-4 case are pinned, and a comment records that `resetWrittenScores` makes the observed state `0/5`.
- A score whose category id is absent from `categoryIds` is not counted. Structurally impossible today — `Score` cascades from `RubricCategory` — and asserted so it stays that way.
- `openSlotsOf(3, 2) === 1`; `openSlotsOf(3, 1) === 2`, which is the "2 of 3, one returns → 1 active, 2 open" case; `openSlotsOf(3, 3) === 0`.
- `claimEligibility`: refuses `SECOND_SPARKLET` for a Sparklet on an applicant that has one, allows a non-Sparklet on the same applicant, refuses `ALREADY_ASSIGNED`, refuses `NO_OPEN_SLOTS`.
- `buildApplicantView` for `WRITTEN_REVIEWER` — the field-visibility block, all four cases:
  - An OTHER field with `visibleToWrittenReviewer: true` and `visibleToFirstRoundReviewer: false` is present in the view; the same field is absent for `FIRST_ROUND_REVIEWER`. Per field, not per category.
  - A field with `isIncluded: false` is absent whatever its visibility override says.
  - A RESPONSE field with both overrides null is present.
  - A DEMOGRAPHIC field is absent, **and** a DEMOGRAPHIC field carrying `visibleToWrittenReviewer: true` is still absent — decision 18's inert-override rule, asserted here because this is the surface it protects.
  - `view.label === "Applicant 47"` for `sourceRowIndex: 47`, and `JSON.stringify(view)` contains neither the applicant's `displayName` nor their `email`. Serializing the whole object is deliberate: it is the same reduction the RSC payload performs, so it catches a name smuggled in on a nested field the shape test would miss.

**Verify:** `npm run test lib/review`, then read the test file against the field-visibility block of the brief. No UI exists yet; nothing is built on this until the tests have been read.

---

### Slice 3 — Reviewer sign-in, and the admin control that makes a code exist

Two things that have to ship together: a sign-in that reads `RoundAccessCode`, and the admin control that writes one. Either alone is unusable.

**`lib/reviewer-session.ts`, pure**, mirroring `lib/session.ts` — same HMAC, same `base64url` payload, same "returns null for anything not currently valid" contract.

```ts
export interface ReviewerSessionPayload {
  ins: string;   // instance id
  rd: Round;     // the round signed in for
  rev: string;   // reviewer id
  exp: number;   // absolute, 12h, not sliding
}
export const REVIEWER_COOKIE = "spark_reviewer";
```

**A separate cookie from `spark_session`, not a field on it.** An admin session must never confer reviewer identity and a reviewer session must never confer admin access; one cookie holding both makes that a code question instead of a structural one. Signed with the same `SESSION_SECRET`, so rotating it invalidates both at once — which is what you want if anything leaks.

**`lib/reviewer-auth.ts`**, the request-bound half, mirroring `lib/auth.ts`:

- `signInReviewer(instanceId, round, reviewerId, code)` — rate-limited on `reviewer:{instanceId}:{round}:{ip}` through the existing `createAttemptLimiter`, **consulted before the argon2 verify** so a locked-out caller costs nothing and learns nothing. Verifies the reviewer belongs to the instance and serves the round.
- `requireReviewer(instanceId)` — returns the payload or redirects to `/r/{instanceId}`. Called in every reviewer page **and inside every reviewer action**, per the `lib/auth.ts` comment and the server-actions doc: render-time gating is not a boundary.
- `signOutReviewer()`.

**Routes.** The round lives in the session, not the URL — a round in the path invites a mismatch between what the URL says and what the session permits.

- `/r/[instanceId]` — sign-in. Round picker prefilled from `?round=`, name `<select>`, code field, one submit. Redirects to `/r/[instanceId]/list` if already signed in.
- `/r/[instanceId]/list`, `/r/[instanceId]/a/[assignmentId]`, `/r/[instanceId]/pool` — Slices 4 and 6.

**`proxy.ts` matcher must exclude `/r`.** Currently `"/((?!login|_next/static|_next/image|favicon.ico).*)"` sends every reviewer to the app password gate. The replacement is `"/((?!login|r(?:/|$)|_next/static|_next/image|favicon.ico).*)"` — `r(?:/|$)` and not a bare `r`, which would also exempt any future top-level path beginning with the letter r. The proxy is a convenience redirect and not a boundary either way; `requireReviewer` is the actual check.

**Admin control**, on `/instances/[id]/reviewers` beside the existing round selector: a card showing whether this round has a code, a field to set or rotate it, and the shareable link. `setRoundCode` hashes with `hashSecret`, upserts on `(instanceId, round)`, writes an `AuditLog` row (§8 — it changes who can reach applicant data), and **never returns or re-displays the code**. Rotating tells the admin plainly that reviewers already signed in keep their session until it expires, since the session is signed rather than looked up.

**Verify — first phone pass, and the setup that costs an hour if it is skipped:**

1. `npm run seed`, then `npm run dev`. Confirm the dev server is reachable from the phone: same Wi-Fi, `http://<machine-lan-ip>:3000`, and Windows Firewall allowing inbound on 3000. Cookies are `secure: false` outside production, so plain http on the LAN works.
2. On the phone, open `/r/<seed-instance-id>?round=WRITTEN`. Confirm it does **not** bounce to `/login` — that is the proxy matcher change, and it is the one thing that fails silently as a redirect rather than an error.
3. Sign in with a roster name and `written-s26`. Land on the list.
4. Wrong code → a clear failure, the name selection preserved, no stack trace. Eleven wrong codes → the lockout message, and confirm it names how long.
5. Sign in as an admin in another browser, rotate the written code, confirm the old one now fails and the new one works.
6. Set a code on a *second*, non-seeded instance and reach its sign-in screen. This is the clause the seed hides.

---

### Slice 4 — Assigned list and applicant detail (clauses 1a–2d)

Server components read; a client component holds only what needs interaction. The score card renders here **read-only** — rubric category names and max points, no inputs — so the layout and the field-visibility boundary can be walked before autosave exists. Shipping the inputs and the autosave together in Slice 5 keeps the risky part in its own diff.

**`/r/[instanceId]/list`.** `Assignment` rows for this reviewer and round with `status: ACTIVE`, each with its applicant's `sourceRowIndex` and its scores. Per row: `Applicant 47` and `3/4 categories`. Header: `2 of 4 complete`, and the pool link with its count. Both halves of clause 1b — the aggregate and the per-applicant state — because the brief asks for both and the aggregate alone is the easy half.

A returned assignment is gone from this list the moment it is returned, not shown as "returned". That is the third case in the brief's first block, and it falls out of the `status: ACTIVE` filter rather than needing a rule.

**`/r/[instanceId]/a/[assignmentId]`.** `requireReviewer`, then confirm the assignment belongs to this reviewer, this round, and is `ACTIVE` — an assignment id in the URL is an untrusted reference. Loads the applicant, the instance's fields and groups, and calls `buildApplicantView(..., "WRITTEN_REVIEWER")`. **Nothing hidden ever reaches the component tree**, so nothing hidden reaches the RSC payload.

Layout, per the owner's choice:

- **Narrow:** responses in one scrolling column; the score card sticky at the bottom, collapsed to one line (`▲ 3/4 scored · Next →`), tappable to expand. Always on screen while reading, which is the strong reading of "alongside". One tap to open, none after — the expanded/collapsed state persists across applicants in `localStorage`, so a reviewer who opens it once never opens it again.
- **≥`lg`:** two columns, rubric sticky in the right rail. No collapse.

Fields render in `ordinal` order; grouped members render under their group's `displayName`. Fields whose value is empty are omitted rather than rendered blank — thirty empty headings on a phone is scrolling that buys nothing.

Prev/next navigation between assigned applicants, so a reviewer working through fifteen never returns to the list. That is a friction call, not a clause; it stays if the walkthrough likes it.

**Verify — phone, and the server-side half of the §6 gate:**

1. Open the list. Confirm 15 rows, `0/4 categories` on each, `0 of 15 complete`.
2. Open an applicant. Confirm the label reads `Applicant N`, the responses are present, and the rubric is on screen without scrolling.
3. **In desktop devtools, open the network tab and read the RSC payload for the detail route.** Search it for the applicant's real name, their email, and a demographic value taken from `npm run seed:inspect`. All three must be absent from the response bytes, not merely absent from the screen. This is BUILD_PLAN's "returns nothing from the server, not just nothing on screen" and it is the one gate step that cannot be satisfied by looking at the page.
4. In the admin mapping table, toggle one OTHER field visible to written reviewers. Reload the detail view: it appears. Toggle it back: it is gone from the payload, not just the screen.
5. Set an OTHER field's group to `isIncluded: false` with the written toggle still on. Confirm it is absent — inclusion wins.
6. Rotate the phone, and open on the narrowest device available. Confirm nothing overflows horizontally and the sticky card does not cover the last response.

---

### Slice 5 — Score inputs, note, autosave (clauses 3a–4b)

**Server actions**, in `app/r/[instanceId]/actions.ts`:

- `saveScore(assignmentId, rubricCategoryId, points | null)` — `null` deletes the row, so `3/4` can go back to `2/4`.
- `saveNote(assignmentId, body)`.

Both derive the reviewer from the session and re-check assignment ownership; neither accepts a `reviewerId`. Both **upsert on the existing unique key** — `(assignmentId, rubricCategoryId)` for `Score`, `assignmentId` for `ReviewNote` — which makes a retry after an ambiguous failure idempotent by construction. That is where "no silent duplicate write" comes from: not from a nonce, but from a constraint that has been in the schema since Phase 0.

Points are validated server-side against the category's `maxPoints`; a client is not trusted to have bounded its own input.

**Neither action calls `revalidatePath`.** A route re-render per debounced keystroke is the opposite of what a phone on a bad connection needs. They return `{ ok, savedAt }` and nothing else. The list's counts refresh on navigation because the list reads cookies and is therefore dynamic; the walkthrough checks that explicitly, and if the count comes back stale the fix is a `router.refresh()` on the back link rather than revalidation on every save.

**Client autosave**, one hook driving both the score inputs and the note, keyed per field:

- 600 ms debounce per key. One request in flight per key; an edit arriving during a flight is coalesced and re-sent when it resolves. **That is what makes "only the final value persists" true** — the second case in the autosave block — independently of Next's own sequential dispatch, which happens to give the same guarantee but is a property of the client dispatcher rather than something to build on.
- Per-key status: `Saving…` / `Saved` / `Unsaved — will retry`. A failed save never renders as saved.
- Retry with backoff (1 s, 2 s, 4 s, capped at 15 s) plus an immediate retry on the `online` event, so a reviewer walking back into signal does not have to touch anything.
- `localStorage` mirror per assignment on every change, cleared per key on a confirmed save, restored on mount. This is the guarantee, per decision 26 — the dialogs reduce how often it is needed.
- Flush the debounce on `pagehide` / `visibilitychange: hidden`.
- `beforeunload` registered while anything is dirty or in flight.
- In-app navigation guard: wait up to **1500 ms** for everything to settle, then a blocking dialog with *Wait* / *Leave anyway*, or *Retry* / *Leave anyway* if a save has already failed.

**Verify — phone, airplane mode, and this is the slice the gate is really about:**

1. Score all four categories on one applicant. Back to the list: it reads `4/4` and the header count went up.
2. Clear one score. Confirm `3/4` and that the row is actually gone, not zeroed.
3. Type a note, wait for `Saved`, reload the page. The note is there.
4. **Airplane mode on.** Change two scores and the note. Confirm all three read `Unsaved — will retry` and none reads `Saved`. Airplane mode off. Confirm all three save without a tap, and reload to confirm the values landed.
5. **Airplane mode on. Change a score, then force-quit the browser.** Reopen, sign in, open that applicant: the unsaved value is restored and still marked unsaved. This is the case `beforeunload` cannot cover and the mirror can.
6. Fix a typo in the note twice in under a second. Reload: the second value is what persisted.
7. Throttle to "Slow 3G" in desktop devtools, change a score, and immediately click back. Confirm the 1500 ms hold and then the dialog, and that *Wait* resolves to a saved state.
8. Try a `points` value above the category maximum by editing the request. It must be refused server-side.

**What actually shipped, where it differs from the section above.** Recorded here rather than left as a
diff to reverse-engineer.

- **The score control is a segmented row of submit buttons, not a numeric input.** One tap instead of
  opening a numeric keyboard, and — the reason it is worth the extra code — it makes decision 33's
  second mitigation literal rather than aspirational: each value is a `<button type="submit"
  name="points" value="3">` inside a `<form action={saveScoreForm}>`, so a tap in the hydration
  window is a completed native POST rather than a discarded one. `—` is the clear, sending
  `points=""`. Falls back to a number input above `maxPoints > 10`, since `MAX_POINTS_CEILING` is
  1000 and 101 buttons is not a control.
- **Post-hydration, `onSubmit` calls `preventDefault` and the queue takes it**, so a score costs one
  request rather than a route re-render. This works because React's form-action listener is queued
  *after* the `onSubmit` listeners and checks `defaultPrevented` before dispatching — verified in
  `react-dom-client.development.js`, not assumed.
- **The fields are uncontrolled**, which is the opposite of what `sign-in-form.tsx` needed and is not
  a contradiction: a controlled field is overwritten by React's own state at hydration (decision 33),
  while an uncontrolled one in a form React *dispatches* is reset when the action settles (F-04).
  Neither field here is in a dispatched form, which is what makes uncontrolled the safe half.
- **PRD decision 37 leads the code**, covering what clears the localStorage mirror. Decision 26
  made the mirror the guarantee and said nothing about its lifetime.
- **Three commits, not one** — the PRD decision, then `lib/autosave.ts` with its tests, then the UI —
  following this plan's own "each pure module ships and is read before the UI that consumes it".
- **`nextDueAt` selector rather than a `schedule` effect**, so the interpreter arms one timer for the
  whole queue and there is nothing to cancel out of step. `UnsavedGuard` folded into `GuardedLink`
  for the same reason: one component that already knows whether it is the one holding a navigation.
- **`experimental.useOffline` rejected.** It exists in Next 16 and looks like exactly this problem,
  but it is experimental, its guide says dev mode is not a reliable reference for it, and it removes
  the state step 4 above requires a reviewer to *see* — the call simply stays pending and looks like
  a slow server.

---

### Slice 6 — Return to pool and claim from pool (clauses 5a–6c)

**`returnToPool(assignmentId, reason, note?)`** — sets `status: RETURNED_TO_POOL`, `returnReason`, `returnNote`, `returnedAt`. The reason is required and re-checked server-side; the note is optional for **both** values, per decision 27. Available on every list row and on the detail screen — "on any applicant" is the clause, and putting it only on the detail screen means a reviewer who recognizes a name in the list has to open the applicant they are trying not to read.

Returning does not delete scores already submitted. The assignment leaves the reviewer's list and the slot reopens; whether FR-10 counts a returned reviewer's scores is a Phase 4 question and is noted, not decided here.

**`/r/[instanceId]/pool`** — applicants in this round with `openSlots > 0`, computed as `planShape(applicantCount, roundRosterSize).target − activeCount`, filtered through `claimEligibility`. Each row shows the anonymous label and `2 of 3 reviewers`. Applicants this reviewer previously returned **are listed** — decision 28.

**`claimSlot(applicantId)` — the concurrency case, which is the one thing here that is not obvious.** `UNIQUE (round, applicantId, reviewerId)` does *not* help: the race is two **different** reviewers taking the last slot, and both inserts satisfy the index. So the claim runs in a transaction that first takes a row lock on the applicant:

```
SELECT id FROM "Applicant" WHERE id = $1 FOR UPDATE   -- $queryRaw
-- then: count ACTIVE assignments, re-check claimEligibility, then insert or reactivate
```

Chosen over `isolationLevel: "Serializable"`, which would also be correct but pushes the loser into a `40001` serialization failure that has to be caught and retried — a retry loop is more code and more ways to be subtly wrong than a lock that simply serializes claims on one applicant. Read Committed suffices with the lock held.

The loser gets `"Someone else claimed that slot a moment ago."` and a refreshed pool list — a clear state, not a 500 and not a silent no-op.

The insert writes `origin: CLAIMED_FROM_POOL` (per §5, FR-8, and decision 21). Where a `RETURNED_TO_POOL` row already exists for this exact pair, it **reactivates that row** rather than inserting — the unique index leaves no other option, and decision 28 records why that is right.

**Verify — phone, and one step needs two devices:**

1. Return an applicant with reason "Conflict of interest", no free text. Confirm it submits, drops off the list immediately, and the header count adjusts.
2. Return another with "Other" and no free text. Confirm it submits — this is decision 27 and it is exactly the kind of clause that ships as "required" by accident.
3. Try to submit a return with no reason picked. Refused.
4. As an admin, open that applicant on the assignments page. Confirm 2 active reviewers and that the returned row is `RETURNED_TO_POOL`, not deleted.
5. Take an applicant that had 2 of 3 and have one of those two return. Confirm the pool shows **2 open slots** on it and `1 of 3 reviewers` — the third case in the return block.
6. **Two devices, or a phone and a desktop, signed in as two different reviewers.** Both open the pool on the same one-slot applicant and both tap Claim within the same second. One lands on the applicant; the other sees "already claimed" and a pool list that no longer offers it. Neither sees a 500.
7. Confirm the winning row is `CLAIMED_FROM_POOL` in the admin view.
8. Claim back an applicant this reviewer returned for conflict of interest. Allowed, per decision 28. Confirm **one** assignment row, now `ACTIVE` / `CLAIMED_FROM_POOL`, with the return fields cleared — not two rows.
9. As a Sparklet reviewer, confirm an applicant who already has a Sparklet is absent from the pool list, and that a direct claim on it is refused by name.
10. Regenerate assignments as an admin. Confirm the warning counts the claimed slots separately from the manual overrides, per decision 21 — Phase 2 built that path and this is the first phase that can actually produce a claimed row to test it with.

---

### Slice 7 — The board-member run

BUILD_PLAN's Phase 3 gate ends with *"have one board member who has never seen it complete a review without instructions."* It is the hardest clause in the gate and the easiest to let evaporate into "I showed someone and they seemed fine," so it is scheduled here as its own step between the last code slice and the status line, not folded into either.

It runs **after Slice 6 and before Slice 7's commit**, because it is the only check that can still find a defect the other six walkthroughs cannot: those are run by someone who knows what the screen is supposed to do.

1. **Pick someone who has not seen the tool** and has not been in any conversation about it. Do not demo it first, do not sit them down and explain the rounds.
2. **Send exactly what a reviewer would get in Slack** — the `/r/<instance-id>?round=WRITTEN` link and the access code, in one message, with no accompanying explanation. If the message needs a sentence of instruction to be usable, that sentence is the defect.
3. **On their own phone**, not yours. Their browser, their default font size, their signal.
4. **Watch and say nothing.** Write down every hesitation longer than about five seconds and every tap that did not do what they expected. Answering a question ends the test for that question.
5. **They must get through one complete review unaided:** sign in, open an applicant, score every rubric category, write a note, get back to the list, and see that applicant read `4/4`.
6. **Then, still unaided,** ask them to hand one applicant back because they know them, and to pick up an extra one. They must find return-to-pool and claim-from-pool without being told where those live — clauses 5a and 6a are only met if the controls are findable, and a control nobody finds is a control that did not ship.
7. **Every place they got stuck is a Phase 3 defect, fixed in Phase 3.** Not deferred to Phase 8's `REVIEWER_GUIDE.md`: a reviewer guide is the artefact FR-9's "no account creation, no download, no spreadsheet training" premise exists to make unnecessary, so reaching for one here means the screen is wrong. Phase 2 shipped four defects that only a person using the screen could find; this step is the same instrument aimed at the half of the surface the owner is now too familiar with to test.
8. **Re-run steps 5 and 6 with the same person after the fixes**, or with a second board member if the first is now contaminated by having seen it work.

### Slice 8 — PRD status line

`v1.5, Phase 0-2 complete, Phase 3 next` moves to Phase 3 complete in its own final commit, and only after the whole BUILD_PLAN gate has passed by hand — including Slice 7. A status line claiming an unverified phase is the one PRD edit that must not lead the code.

---

## Files

**New**
- `lib/review.ts`, `lib/review.test.ts`
- `lib/reviewer-session.ts`, `lib/reviewer-session.test.ts`
- `lib/reviewer-auth.ts`
- `app/r/[instanceId]/` — `page.tsx`, `actions.ts`, `sign-in-form.tsx`
- `app/r/[instanceId]/list/page.tsx`
- `app/r/[instanceId]/a/[assignmentId]/` — `page.tsx`, `score-card.tsx`
- `app/r/[instanceId]/pool/page.tsx`
- `app/r/[instanceId]/actions.ts` — `saveScore`, `saveNote`, `returnToPool`, `claimSlot`

**Modified**
- `proxy.ts` — matcher exempts `/r`
- `app/instances/[id]/reviewers/page.tsx`, `actions.ts`, `roster-controls.tsx` — the access-code card
- `PRD.md` — §10 decisions 26–31, one FR-9 sentence, status line last

**Reused rather than rewritten:** `resolveField` / `visibleFieldIds` / `projectApplicantData` / `resolvePromoted` (`lib/fields.ts`), `planShape` (`lib/assignment.ts`), `hashSecret` / `verifySecret` (`lib/password.ts`), `createAttemptLimiter` + `PASSWORD_ATTEMPT_POLICY` (`lib/rate-limit.ts`), the HMAC encode/decode shape and `SESSION_TTL_SECONDS` (`lib/session.ts`), the `AuditLog` write shape (`app/instances/[id]/rubric/actions.ts`), the server-component-reads / client-controls / server-action split from `mapping/` and `reviewers/`, the shadcn primitives in `components/ui/`. **No new dependency and no migration** — `Assignment.returnReason`, `returnNote`, `returnedAt`, `Score`, `ReviewNote` and `RoundAccessCode` have all existed since Phase 0.

---

## Verification

```bash
npm run verify                      # typecheck, lint, test
npm run seed && npm run seed:inspect
npm run dev                         # reachable from the phone on the LAN
```

Then the walkthroughs at the end of Slices 3, 4, 5 and 6, in that order, **on an actual phone** — not a resized browser window, which is what BUILD_PLAN's Phase 3 gate specifies and what a sticky bottom card behaves differently under, because a real mobile browser's URL bar moves and a resized desktop window's does not. Then **Slice 7's board-member run in full**, which is a gate step and not a demo, and then the status line.

Four gate steps that cannot be satisfied by looking at the page, called out because they are the ones most likely to be skipped:

1. **The RSC payload check** (Slice 4, step 3). Reading the response bytes is the only way to distinguish server-side enforcement from client-side hiding, and §6 requires the former.
2. **Force-quit with an unsaved change** (Slice 5, step 5). `beforeunload` cannot cover this and it is the case the `localStorage` mirror exists for.
3. **Two devices claiming simultaneously** (Slice 6, step 6). A single-client test cannot produce the race, and Next's sequential per-client dispatch will hide it if you try.
4. **The board-member run** (Slice 7, all eight steps). It is the only check performed by someone who does not already know what the screen is supposed to do, which is exactly the reviewer FR-9 is written for. It cannot be run by the owner and it cannot be run twice on the same person.

Before each commit, re-read the FR-9 clauses that slice claims and tick them against the diff — the ledger at the top of this file, not a paraphrase of it.
