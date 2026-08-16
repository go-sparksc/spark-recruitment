# Phase 3 Slice 7 — the board-member run

**Prepared 2026-08-16 against `5c34425`. Not yet run.**

BUILD_PLAN's Phase 3 gate ends with *"have one board member who has never seen it complete a review
without instructions."* This is that step, and it is a gate step rather than a demo. It cannot be run
by the owner, and it cannot be run twice on the same person — once they have seen the tool work they
are contaminated for every question the run exists to ask.

`plans/phase-3.md` Slice 7 holds the eight steps. This file is the instrument: the setup, the
message, what to watch for at each screen, and where the findings go. **Slice 7 produces no commit of
its own** — only whatever fixes it finds, each in its own diff after triage.

**The board member is referred to throughout as "the guest".** `plans/` is committed; their real name
goes in the database roster and nowhere in this repository.

---

## Part 1 — Fixture setup

> **Done 2026-08-16.** All four steps below were carried out and confirmed on screen. The numbers
> they produced are in the baseline table. Kept as written rather than collapsed to a tick, because
> step 8 may need the fixture rebuilt for a second board member.

**The order matters and getting it wrong fails silently.** A guest added to the roster *after*
generation lands on "Nothing is assigned to you yet" — correct behaviour, and a dead test.

### 1. `npm run seed`

Rebuilds the instance and **wipes all assignments**. It also clears the 12 `Score` and 4 `ReviewNote`
rows the Slice 6 walkthrough left behind, which **unlocks the rubric** — FR-4 locks
`/instances/seed_s26_demo/rubric` the moment any score exists, and it has been locked since that
walkthrough.

> ### ⚠ The written access code flips back to `written-s26`
>
> `prisma/seed.ts:18` writes `written-s26`. The code live before this step was `written-f26`,
> rotated during the 2026-08-13 test pass. **The reseed reverses that**: `written-s26` is live and
> `written-f26` is dead. `plans/phase-3-handoff.md`'s credential table was corrected to match.

### 2. Do not rotate the code

Leave it at `written-s26`. It is the seed's own value, so it survives every future reseed and the
credential table stops drifting. F-02's fix means a code that has been set is never redisplayed — a
rotated value exists only if it is written down at the instant it is typed, and one more thing to get
right on the day buys nothing here.

### 3. Add the guest to the roster

`/instances/seed_s26_demo/reviewers`, round **Written** → **Add a reviewer**. Their real first and
last name. **Sparklet unchecked.**

Non-Sparklet is not cosmetic: a Sparklet is filtered out of any pool applicant that already has one
(`claimEligibility` → `SECOND_SPARKLET`), which would thin step 6's pool for a reason that has nothing
to do with what is being tested.

Their real name is the point of this step. Step 2 of the run sends the link and the code and nothing
else, and that only works if the guest finds *themselves* in the dropdown. Otherwise the first thing
said out loud is "pick Dev Abiodun", which is the instruction the step forbids, and the first
hesitation recorded is a fixture artefact rather than a defect.

### 4. Generate assignments

`/instances/seed_s26_demo/assignments` → **Generate**. Expected numbers, so a mismatch is visible now
rather than discovered mid-run:

| | |
|---|---|
| WRITTEN reviewers | 31 (8 Sparklets) |
| Total slots | 450 |
| Pool | `floor(0.05 × 450)` = **22** |
| Assigned | **428** |
| Load ceiling | `ceil(450/31)` = 15 |
| Applicants at 3 reviewers / at 2 | 128 / 22 |
| The guest's load | **13–15** — read it off the **Assigned** column of the roster grid |

The FR-7 precheck passes: non-Sparklet capacity is 23 × 15 = 345 against a non-Sparklet minimum of
428 − 120 = 308.

**A first tap on `Generate` may do nothing** — decision 33's pre-hydration window. It is a finding
only if the *second* tap also does nothing.

---

## Part 2 — Pre-flight, on the day

In this order. Items 2 and 3 are the ones that fail without an error message anywhere.

- [ ] **1.** `git status` clean. `npm run verify` green.
- [ ] **2.** `npm run dev`, and read the **Network** address from the banner.
      As of 2026-08-16 the machine is on `192.168.1.110` (Wi-Fi), unchanged since 2026-08-15 — but it
      is DHCP and it will move.
- [ ] **3.** If that address differs from `DEV_ALLOWED_ORIGINS` in `.env` — currently
      `192.168.1.110`, matching — update it and **restart the dev server**.
      Wrong value means every JS chunk 403s: the page loads, nothing hydrates, and every tap silently
      does nothing. There is no error on screen. This is the most expensive thing to discover while a
      guest is holding the phone.
- [ ] **4.** **Owner's dry run, on a phone, signed in as a different reviewer** — never as the guest,
      whose `0/4` state has to be intact. Sign in, open one applicant, tap one score, confirm it
      reads `Saved`, sign out. This is the only check that proves item 3 from the outside.
- [ ] **5.** Confirm the guest's roster row shows 13–15 assigned.
- [ ] **6.** Get the guest's phone onto the Wi-Fi **before** sending the message. "Join this network"
      says nothing about the tool and does not contaminate anything; fumbling with Wi-Fi after the
      link has arrived does.

No `prisma generate` or `prisma migrate` is involved, so CLAUDE.md's stale-client hazard does not
apply — except through item 3, where the restart is for the environment variable.

---

## Baseline

Setup values confirmed 2026-08-16, when the fixture was built. The last two rows are filled on the
day.

| Check | Result |
|---|---|
| `git status` | clean, `main` at `c6ef3b6` |
| `npm run verify` | green — 14 files, 369 tests, typecheck and lint clean |
| `next dev` banner — Network | `http://192.168.1.110:3000`, ready in 8.0s |
| `DEV_ALLOWED_ORIGINS` | `192.168.1.110` — **matches**, so no change needed. Re-check on the day; it is DHCP |
| Applicants · WRITTEN reviewers · rubric categories | 150 · 31 (8 Sparklets) · 4 |
| Assignments generated | **428**, 22 applicants one short, load 13–15. Pre-generate panel matched the expected figures exactly |
| The guest's assigned count | **14** |
| Written access code | `written-s26` — reset by the reseed, and `written-f26` is now dead |
| Their device (OS, browser, anything unusual about text size) | |
| Date, and how long the run took | |

---

## The message

Sent in one message, in whatever the guest actually uses. Nothing else in it, and nothing said
alongside it:

```
http://192.168.1.110:3000/r/seed_s26_demo?round=WRITTEN
written-s26
```

Step 2's own test: **if the message needs a sentence of instruction to be usable, that sentence is
the defect.**

---

## The one thing said out loud

Before the message. About the situation, not about the tool:

> "I'm going to send you a link. Use it the way you'd use anything else someone sent you. I'm not
> going to say anything while you do — that's on purpose, not because you're doing it wrong."

Without this, the social dynamic produces questions, and answering a question ends the test for that
question.

---

## What to watch

Steps 1–4 of `plans/phase-3.md` Slice 7 are conduct. Steps 5 and 6 are the observable content.

### Step 5 — one complete review, unaided

Sign in → open an applicant → score every category → write a note → back to the list → that applicant
reads `4/4`.

| Screen | The specific thing to watch |
|---|---|
| Sign-in `/r/seed_s26_demo?round=WRITTEN` | Do they find their own name in a 31-name dropdown sorted by **first** name? Do the three round links read as already-answered, or as a question they have to solve first? A first tap that no-ops is the pre-hydration window — only a finding if the second does too |
| `/list` | Header reads `N of 14 complete`; rows read `Applicant 47` · `0/4 categories`. Do they know a row is tappable? The whole 56px row is the target, not the text |
| Detail, narrow — **the highest-risk item** | Scoring lives behind the sticky bottom bar: `Score this applicant  0/4 scored ▲`. Do they tap it, or scroll to the bottom of the essays hunting for score inputs? An earlier version of this bar showed only `0/4 scored` and a glyph and read as a label rather than a button; the current wording is the fix, and this is its first naive test |
| Scoring | A segmented row of buttons, `0`–`5` plus `—` to clear. Is `—` legible as "clear", or read as a sixth score? |
| The note | Placeholder `Anything the score does not capture.` Do they hunt for a **Save** button? There is none by design — the per-key status reads `Saving…` / `Saved` / `Unsaved — will retry` |
| Getting back | The link reads `← All applicants`. Do they use it, or the browser's back gesture? Both should work |
| `/list` again | Does the row read `4/4 categories` in green, and did the header count increment? |

### Step 6 — hand one back, pick an extra one up, still unaided

Asked as a situation, not as a UI instruction: *"say you knew one of these people — what would you
do?"* and *"say you had time for one more."*

| Screen | The specific thing to watch |
|---|---|
| Return control | A `<details>` summary reading **`Return to pool`**, right-aligned in small grey text under every list row and on the detail screen. **Does it read as tappable at all?** This is clause 5a, and a control nobody finds is a control that did not ship |
| Which one they use | The list-row control or the detail-screen one. The list one exists so a reviewer who recognises a name need not open the applicant they are trying not to read — if they open the applicant first, the placement is not doing its job |
| The reason | Radios read `I know this applicant` / `Something else`. The note is optional for **both** (decision 27) and the placeholder says `(optional)`. Do they treat it as required anyway? |
| Claim | The pool link is in the list header: `Claim from pool` with `N open` on the right. Do they find it from that wording, or look somewhere else first? |
| `/pool` | Rows read `Applicant N` · `2 of 3 reviewers`. Do they understand what they are about to take on? |
| Which one they claim | Re-claiming the one just returned is allowed (decision 28) but is a different test — note it if they do |

---

## Hesitation log

Every hesitation longer than about five seconds, and every tap that did not do what they expected.

| # | Screen | What they did | Sec | Said out loud | Finding? |
|---|---|---|---|---|---|
| | | | | | |

---

## The unblocking rule

Step 4 says say nothing; step 5 says they must complete a review. When someone is genuinely stuck
those conflict, so the rule is fixed in advance rather than decided under social pressure:

> **Wait a full 30 seconds.** Then give the *smallest possible* unblock, record it as a
> `blocks-gate` finding, and mark every step after it **assisted**. A hint contaminates everything
> downstream — the run's later observations are weaker evidence from that point on, and the log
> should say so rather than pretend otherwise.

---

## Known-expected — correct, not defects

So that fixture artefacts and deliberate design do not get logged as findings.

| Observation | Why it is correct |
|---|---|
| A first tap on a form button does nothing | Decision 33's pre-hydration window. A finding only if the **second** tap also does nothing |
| There is no Save button anywhere | Autosave is the design (clause 4a); the per-key status text is the feedback |
| A returned applicant vanishes from the list rather than showing as "returned" | Falls out of the `status: ACTIVE` filter — `plans/phase-3.md` Slice 4 |
| The pool link renders even when it reads `none open` | Deliberate. A link that disappears at zero is a link nobody can go looking for |
| Every other reviewer's applicant reads `0/4` | The reseed cleared every score |
| The applicant has no name, only `Applicant 47` | §6. The name and email are never selected on the server, so they are not in the payload either |

**The four findings still open from the test pass — F-01, F-05, F-06, F-09 — are all admin
surfaces** (`…/rubric`, `…/mapping`, `…/reviewers`) and none is reachable from `/r/…`. The guest
cannot hit a known-open item, so **every finding this run produces is new.**

---

## Findings

Numbering continues from `plans/phase-3-test-pass.md`. F-01 through F-09 are taken, so **this run
starts at F-10.**

Severity is one of `blocks-gate` · `defect` · `cosmetic` · `preference` · `expected-gap`.
`preference` still means the screen does what the requirement says and the owner wants it done
differently — resolved by changing `PRD.md` or `plans/phase-3.md` first and the code second, never as
a bug fix.

**Nothing is fixed during the run.** Findings are triaged afterwards and fixed in a separate diff, so
discovery and change do not interleave.

```
### F-NN · <route> · <one-line title>
Severity:
FR / decision:
Did:
Expected:
Observed:
```

*(none yet — the run has not happened)*

---

## After the run

1. Triage the hesitation log into findings from F-10 up, in this file.
2. **Fix defects in Phase 3, not Phase 8.** Step 7 is explicit about this: reaching for
   `REVIEWER_GUIDE.md` means the screen is wrong, because that guide is the artefact FR-9's "no
   account creation, no download, no spreadsheet training" premise exists to make unnecessary.
3. Tick each fix against the FR-9 clause ledger at the top of `plans/phase-3.md` — the ledger itself,
   not a paraphrase of it — before committing.
4. **Step 8: re-run steps 5 and 6** with the same person after the fixes, or with a second board
   member if the first is now contaminated by having seen it work. Add a second person to the roster
   only when that is decided — an unused roster entry consumes assignment slots at the next
   generation.
5. Only then Slice 8, the PRD status line. A status line claiming an unverified phase is the one PRD
   edit that must not lead the code.
