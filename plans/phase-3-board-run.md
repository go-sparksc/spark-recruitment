# Phase 3 Slice 7 — the board-member run

**Prepared 2026-08-16 against `5c34425`. Run 2026-08-16 against `4e74261`. Ten findings, F-10 to
F-19.**

**The run completed.** The board member got through a full review and both pool actions. Nothing here
is a report that the surface does not work — it is a report of where it costs a stranger more than it
should, which is the only thing this instrument was ever going to measure.

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
| Their device | iPhone, their own, on the LAN |
| Date, and how long the run took | 2026-08-16. **Duration deliberately not recorded** — see below |

### The instrument was not quite the one this step specifies, and it matters both ways

The board member has a background in app design, and used the time to hunt for problems rather than
to complete a review the way a reviewer would. Two consequences, both worth being straight about:

- **Every timing signal is void.** The sheet's "hesitation longer than about five seconds" threshold
  measures someone trying to get a job done. It does not measure someone deliberately probing, and no
  duration from this run should be read as what a review costs.
- **The findings are stronger than a naive run's, not weaker.** He could name what was wrong instead
  of only stalling on it, which is why F-10 to F-16 are specific enough to act on. Expert review is a
  better instrument for *finding* design defects.

**But it is a worse instrument for the one thing BUILD_PLAN's gate actually asks**, which is whether
someone with no design instinct and no context can complete a review unaided. A designer finding a
control and remarking that it is unclear is evidence about the control; it is not evidence that a
typical reviewer finds it at all.

**So step 8 is now load-bearing rather than a formality.** The re-run should be someone without a
design background — that is the case this run left untested.

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
| A hydration warning naming `__gcrremoteframetoken` or `__gcruniqueid` | Injected into the DOM before React hydrates by something in the browser, not rendered by us. Neither string exists in the repo. **F-13** — check the `+`/`-` diff before assuming a repeat is the same thing |
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

**Two groups, and the split is the owner's.** F-10 to F-16 are things the board member hit while
being watched. F-17 to F-19 are the owner's own design opinions, noticed during the run but not
things anyone was blocked by.

**Severity follows the vocabulary, not the group.** One observed item (F-16) is a `preference`
because the screen does exactly what `plans/phase-3.md` specifies — that it was noticed while
watching does not make it a defect. Recorded that way deliberately.

---

### F-10 · `/r/<id>/list` · nothing shows that a row opens the applicant

**Severity:** defect
**FR / decision:** FR-9 bullet 1, CLAUDE.md rule 5
**Did:** Signed in, landed on the list of 14 assigned applicants, opened an applicant.
**Expected:** The first action of the whole flow is obvious.
**Observed:** **He found it unaided** and remarked that it was not clear the row was tappable.

**Mechanism.** The row *is* a full-width `<Link>` with a 56px target (`list/page.tsx:130-146`), so the
tap area is right. What is missing is any signal that it is one: no chevron, no underline, no colour,
and `hover:bg-muted` is the only affordance — which on a phone does not exist at all. The row reads
as a status line that happens to say `Applicant 12 · 0/4 categories`, and the only interactive-looking
thing on the page is the bordered `Claim from pool` link above it.

The tap-target work was done and the affordance work was not — the row was built as if the problem
were hitting it, when the problem is seeing it.

**Not `blocks-gate`: he got in on his own.** But read the evidence for what it is. It is a designer's
judgment that the affordance is missing, not an observation of someone failing to find it — and per
the note in the baseline, this run could not produce the second kind. The row is the first action of
the whole flow, so **whether a non-designer finds it is exactly what step 8 needs to answer**, and it
is currently unknown rather than fine.

**Fixed — a disclosure chevron on every row**, owner's choice from three options. It is the native
list idiom on the phone this is actually used on, it adds no words and no height, and it leaves the
`0/4 categories` completion state alone, which clause 1b requires. A text glyph rather than an icon
component, matching the `←` `→` `▲` `▼` already used on the detail screen.

**One thing was added beyond the chosen option, and it is flagged rather than folded in:**
`active:bg-muted` alongside the existing `hover:bg-muted`. `hover:` never fires on a touch screen, so
until now a tap produced no visual feedback whatsoever — the row is only ever tapped, and it was the
one control giving nothing back. Trivially revertible if unwanted.

**Step 8 still has to answer this one.** The fix is a designer-approved affordance, not evidence that
a non-designer now finds the row.

---

### F-11 · `/r/<id>/a/<id>` · a "Save note" button sits under an autosaving field

**Severity:** defect
**FR / decision:** FR-9 bullet 4, decision 33, CLAUDE.md rule 5
**Did:** Wrote a note.
**Expected:** Autosave is the design; there is no manual save.
**Observed:** The button confused him.

**It was not left in by accident, and it is not safe to simply delete.** `score-card.tsx:517-527`
carries the reason: before React attaches, that button is the *only* way to save a note — the form
posts natively to `saveNoteForm` and the server writes it. It is decision 33's third mitigation, and
removing it reintroduces the dead-control window the decision exists to close.

**The defect is the pair, not the button.** After hydration the field says `Saved` and a live
`Save note` button sits underneath it, and those are two different claims about whether the work is
safe. A reviewer who believes the button is load-bearing taps it after every note — which is exactly
the per-review tax rule 5 is about.

So the fix has to keep a working pre-hydration path while removing the post-hydration contradiction,
and "delete the button" is not it. Worth noting the same shape exists on the number-input fallback
(`score-card.tsx:412-417`), which is unreachable here only because `maxPoints` is 5.

**Fixed — the button is rendered by the server, hidden once hydrated, and returns as `Retry now`
only when a save has actually failed.** Owner's choice from three options.

- **The pre-hydration guarantee is untouched.** The server still renders it, so a tap before React
  attaches is still a completed native POST. Decision 33 holds exactly as written.
- **A new `useHydrated()` hook** does the switching, built on `useSyncExternalStore` with a
  `getServerSnapshot` of `false` — the same discipline `useCardOpen` already uses in that file, and
  deliberately not a `typeof window` branch read during render, which is the mismatch F-13 spent an
  afternoon ruling out.
- **The retry is real, and this was checked rather than assumed.** Pressing it runs
  `intercept` → `onBody` → `edit`, and the `"edit"` case in `lib/autosave.ts:244-265` sets
  `failures: 0` and re-arms the send *without* deduplicating on value. So it retries and clears the
  backoff. Had that case deduplicated, the button would have looked like a retry and done nothing,
  which is worse than the dead control it replaces.
- **The number-input fallback was fixed at the same time**, on the same rule. It renders only above
  `SEGMENTED_LIMIT` points so the board member could not have reached it — and a defect that is
  merely unreachable today is the kind this project keeps rediscovering.

**Verified by hand on the detail route, signed in.** Scored a category; watched `Save note` disappear
once hydrated; killed the network and confirmed `Retry now` appears alongside `Unsaved — will retry`.
All four steps passed. Recorded because `npm run verify` cannot reach this route — it is behind a
reviewer session — so typecheck passing over it proved only that it compiles.

---

### F-12 · `/r/<id>/a/<id>` · the expanded rubric card scrolls the page behind it

**Severity:** defect
**FR / decision:** FR-9 bullet 2 ("rubric always visible alongside"), CLAUDE.md rule 5
**Did:** On the phone, opened the score card and scrolled it while the responses behind were still
carrying scroll momentum.
**Expected:** Scrolling the rubric scrolls the rubric.
**Observed:** The written-responses area underneath scrolled instead.

**Mechanism, and it is exact.** `score-card.tsx:272` is
`max-h-[70vh] overflow-y-auto` with no `overscroll-behavior`. The default is `auto`, which *chains*:
when the inner scroller is at a boundary — or while the outer one is still animating — the gesture is
handed to the parent. `overscroll-contain` stops the chain at the card.

This is a phone-only finding by construction: at `lg` the card is `lg:max-h-none lg:overflow-visible`
and has no scroll region to chain out of.

**Partly fixed, and downgraded to `cosmetic` on the phone result.** `overscroll-contain` is on the
element and stays there — but the symptom still reproduces on the iPhone, and it is minor.

**Why the fix did not close it, which is the part worth keeping.** `overscroll-behavior` governs
*chaining*: what happens when an inner scroller reaches its boundary. That was a real latent defect
and it is now fixed. But the reported symptom is not chaining — it is a **new touch landing while the
page behind is mid-momentum**, and which element receives that gesture is decided by WebKit's
touch handling, not by CSS. On iOS the first touch during a momentum scroll conventionally stops the
momentum rather than scrolling whatever is under the finger. No app-level CSS controls that.

**So this is most likely platform behaviour, and one test discriminates.** Every browser on iOS is
WebKit, so trying Chrome on the same iPhone proves nothing. **An Android phone does**: if it does not
reproduce there, it is WebKit and there is nothing to fix. Left open at `cosmetic` rather than closed,
because the residual behaviour is real even if it turns out not to be ours — and `overscroll-contain`
is kept either way, since the chaining it prevents was a genuine defect that a boundary scroll would
have hit.

---

### F-13 · `/r/<id>/…` · hydration warning — **third-party DOM injection, not our render**

**Severity:** not a defect. The vocabulary has no slot for "real warning, someone else's cause", and
`cosmetic` would misfile it as ours. Recorded as a finding because the investigation is the valuable
part, and carried into the known-expected table so the next run does not repeat it.
**FR / decision:** n/a
**Did:** Used the reviewer surface on an iPhone.
**Expected:** No hydration error.
**Observed:** A React hydration error appeared.

**What the dev log actually says.** The server was running throughout, and it captured **four**
`A tree hydrated but some attributes of the server rendered HTML didn't match` warnings. Every diff
line in all four — 69 of them — is one of exactly two attributes:

```
__gcrremoteframetoken="…"     on <html>, once per warning
__gcruniqueid="1" … "12"      on individual elements
```

**Not one diff line involves any attribute, text node or element from this codebase**, and neither
name appears anywhere in the repository. Both are stamped onto the DOM by something in the browser
before React hydrates, which is the last cause the warning itself lists.

**The warnings are not confined to one session.** Reading the log as a timeline: the first lands on
the very first `/list` render of the day. The others land **after** a `signOut`, after someone browses
the `?round=FIRST_ROUND` and `?round=SECOND_ROUND` links, and around two `signIn` calls — which is a
fresh person arriving on the link and exploring, not the owner's dry run. Warnings occur in both, and
**all four have the same `__gcr*`-only shape.**

So whichever session the iPhone was, a warning of this shape was already accounted for, and no
warning anywhere in the log implicates our markup.

**What was checked and did not explain it.** Every browser-state read on this surface runs in an
effect, an event handler or a server action — `readDraft`, `purgeExpiredDrafts`, the `Date.now()`
calls in `use-autosave.ts` and `guarded-link.tsx`. The one piece of external state read during render,
the card's expanded flag, uses `useSyncExternalStore` with a `getServerSnapshot` of `false`
(`score-card.tsx:49-62`), which is the correct pattern for exactly this hazard and is why it does not
appear in any diff.

**The text supplied from the phone was the generic preamble**, which is byte-identical for every
hydration warning React emits. The diagnostic half is the `+`/`-` tree printed underneath it. If this
is ever revisited, that is the part to capture.

**Residual uncertainty, stated rather than rounded away:** the log cannot attribute a session to a
device, so "his warning is one of these four" is an inference from shape and timing, not a
measurement. It is a weak uncertainty — four for four, across two sessions — but it is not zero.

**Dev-only either way.** The overlay does not exist in a production build, so no real reviewer would
ever see this. **No `suppressHydrationWarning` was added**, and none should be: suppressing here would
hide a genuine mismatch later for the sake of a warning that is not ours.

---

### F-14 · app-wide · buttons do not show a pointer cursor

**Severity:** cosmetic
**FR / decision:** CLAUDE.md rule 5
**Did:** Hovered the rubric scoring buttons.
**Expected:** A hand cursor, the usual signal that something is clickable.
**Observed:** The default arrow.

**Mechanism.** **Tailwind v4 removed `button { cursor: pointer }` from Preflight**; v3 set it. This
project is on Tailwind v4 (`package.json`), and neither `app/globals.css` nor
`components/ui/button.tsx` restores it — verified, there is no `cursor` declaration in either.

So this is **not** specific to the rubric buttons: every `<button>` in the application has it,
admin surfaces included. One rule in `globals.css` fixes all of them, and per-component
`cursor-pointer` classes would be the wrong shape of fix. `cosmetic` because nothing fails — but it
is the cheapest finding here to resolve and the broadest in reach.

**Fixed.** One rule in the `@layer base` block of `app/globals.css`, restoring
`cursor: pointer` on `button:not(:disabled)` and `[role="button"]:not(:disabled)`. The absence was
confirmed by reading `node_modules/tailwindcss/preflight.css` at the installed 4.3.3 rather than from
the changelog. Deliberately not a per-component class: the next button anyone adds would be missing
it again.

---

### F-15 · `/r/<id>/a/<id>` · "Return to pool" is not separated from the rubric card

**Severity:** cosmetic
**FR / decision:** FR-9 clause 5a
**Did:** Scrolled to the bottom of an applicant on the phone.
**Expected:** Visible separation between the return control and the sticky rubric.
**Observed:** They read as one crowded block.

**Mechanism.** `ReturnControl` is the last child of `<article>`, and `<ScoreCard>` is its next
sibling. The gap between them is `lg:gap-8` (`page.tsx:161`) — **which does not apply below `lg`**.
`article`'s own `space-y-6` spaces its children from each other, not from what follows it. So on a
phone the spacing between the two is zero, and the card's `border-t` lands directly under the return
control.

**Fixed** — `space-y-6 lg:space-y-0` on the wrapper, so the stacked layout gets the gap and the grid
takes the job back at `lg`. Spacing the two siblings rather than padding the article, because the
thing that was missing is the gap *between the columns*, which is exactly what `lg:gap-8` provides
above the breakpoint.

---

### F-16 · `/r/<id>/a/<id>`, wide viewports · responses and rubric scroll independently

**Severity:** preference — the layout does exactly what `plans/phase-3.md` Slice 4 specifies
**FR / decision:** FR-9 bullet 2, `plans/phase-3.md` Slice 4
**Did:** Watched on a desktop screen.
**Expected:** (owner's) One thing to track, not two.
**Observed:** Two regions moving separately felt awkward.

**One thing to check before treating this as purely a preference.** At `lg` the card is
`sticky top-6` with `lg:max-h-none lg:overflow-visible` — so there is no second *scroll region*
there; the rubric is pinned while the page scrolls. Two genuinely independent scrollers only exist
**below** `lg`, where the card is `max-h-[70vh] overflow-y-auto`. If this was seen in a browser window
narrower than 1024px, it was the phone layout on a desktop screen, which
`plans/phase-3.md` warns is not the same surface.

**And a real risk hiding underneath it — measured, and ruled out.** A `sticky` element taller than
the viewport pins at the top and its lower portion cannot be scrolled into view. The note field is
the **last** thing in the card, under four categories carrying 138–172 character descriptions, so on
a short laptop viewport it could have been unreachable at `lg`. **Checked on hardware: the note is
reachable.** This stays a `preference` rather than becoming a `defect`.

Worth knowing that the margin is not guaranteed: the card's height scales with the number of
categories and the length of their descriptions, both admin-controlled. A six-category rubric with
long descriptions could still reach it, and nothing in the code prevents that.

---

### F-17 · `…/rubric` · the scoring scale should be 1–4, not 0–5

**Severity:** preference — owner's rubric-design opinion, not an observed problem
**FR / decision:** FR-4, §5 `RubricCategory`
**Did:** n/a — noticed while watching.
**Expected:** (owner's) A 1–4 scale.
**Observed:** The seed's categories are 5-point, and the segmented row offers `—` plus `0`–`5`.

**This is a PRD conversation and it is a larger one than it looks.** §5's `RubricCategory` carries
`maxPoints` and **no minimum**, so the control renders `0…maxPoints` inclusive — a 6-value scale for
`maxPoints: 5` is the schema working as written, not a UI choice. A 1–4 scale is therefore not a seed
change: it needs either a `minPoints` column or a stated convention that 0 is not offered, and §5 has
to move before either.

Per CLAUDE.md, that means PRD §5 and FR-4 change first, with the reason recorded, and the code
follows. **Not a bug fix** — resolving it as one would move the spec out from under the next
maintainer.

**Recorded as PRD decision 40, and the build is deferred to Phase 4.** The resolution is a
`minPoints Int @default(0)` column rather than a stated convention: a convention lives in validation
code and so applies retroactively to every instance ever, which would leave a past cycle's legitimate
0 scores as values the current scale says cannot exist — bad for FR-10's averages and for FR-20's
export-and-reimport round trip. A column makes the scale data that travels with the instance that
used it.

**Deferred deliberately, and the reason is about this gate rather than about the change.** Nothing is
blocked and no data is wrong, but the migration would land between the board-member run and its step
8 re-run — risking the thing Phase 3 is trying to close, for a change with no deadline. Phase 4 is
the natural home: FR-10 is the first requirement that computes on the scale rather than only storing
it. §5 carries the planned column marked as not yet built, so the document does not claim a field
the schema lacks.

---

### F-18 · `/r/<id>/a/<id>` · bold the question prompts

**Severity:** preference
**FR / decision:** FR-9 bullet 2
**Did:** n/a — noticed while watching.
**Expected:** (owner's) Prompts visually distinct from the applicant's answers.
**Observed:** `page.tsx:171` renders the prompt as `text-sm font-medium` above a `text-[0.95rem]`
answer — a real but slight distinction, and the prompt is the *smaller* of the two.

**Fixed** — `text-[0.95rem] font-semibold`, so the question matches the answer's size and separates by
weight alone. Not made larger: an essay prompt here runs to 200 characters, and a prompt that
outweighs the response works against the person who is there to read the response.

**Done directly rather than through a PRD amendment**, by the owner's call. The `preference` rule
exists to stop the spec being moved quietly out from under the next maintainer — but neither `PRD.md`
nor `plans/phase-3.md` ever made a claim about prompt weight, so there was no document to move.

---

### F-19 · `/r/<id>/list` · move sign-out to the top

**Severity:** preference
**FR / decision:** n/a
**Did:** n/a — noticed while watching.
**Expected:** (owner's) Sign-out at the top of the screen.
**Observed:** `<SignOutButton>` is the last element on the list page (`list/page.tsx:166`), below all
14 rows.

**Fixed** — moved into the header, on the same line as the reviewer's own name, which is what it acts
on and where it is looked for. At the foot of the list it was fourteen rows of scrolling away.

**The `mt-8` moved with it.** That margin lived on the form inside `sign-out-button.tsx` and was the
list page's spacing kept in the wrong file — harmless while there was exactly one caller and one
position, wrong the moment either changed. Placement is the caller's now.

---

## Result

| # | Severity | Route | What |
|---|---|---|---|
| F-10 | defect | `/r/<id>/list` | A row gives no sign it opens the applicant — the first action of the flow. **Fixed** |
| F-11 | defect | `…/a/<id>` | `Save note` and `Saved` make two different claims about the same work. **Fixed** |
| F-12 | cosmetic | `…/a/<id>` | Chaining fixed; a residual momentum-capture behaviour remains, most likely WebKit |
| F-13 | not a defect | `/r/<id>/…` | Hydration warning — all four recorded are `__gcr*` injection, none implicating our render |
| F-14 | cosmetic | app-wide | No pointer cursor on any button — Tailwind v4 dropped it from Preflight. **Fixed** |
| F-15 | cosmetic | `…/a/<id>` | `lg:gap-8` leaves zero space above the sticky card on a phone. **Fixed** |
| F-16 | preference | `…/a/<id>` | Rubric and responses scroll separately. Tall-card risk **measured and ruled out** |
| F-17 | preference | `…/rubric` | 1–4 rather than 0–5. **Decision 40 recorded; `minPoints` column deferred to Phase 4** |
| F-18 | preference | `…/a/<id>` | Bold the question prompts. **Fixed** |
| F-19 | preference | `/r/<id>/list` | Sign-out to the top. **Fixed** |

**Three defects, two cosmetics, four preferences, one closed as not ours. No `blocks-gate`.** He
completed a full review and both pool actions unaided, and found the list row himself.

**Status: nine of ten resolved.** F-10, F-11, F-14, F-15, F-18 and F-19 are fixed and confirmed;
F-13 is closed as third-party; F-16's hidden risk was measured and ruled out, leaving it a stated
preference. **F-12 is the only one still live**, downgraded to `cosmetic` — its chaining half is
fixed and the residual is most likely WebKit. **F-17 is recorded as PRD decision 40 and deferred to
Phase 4.**

**Every fix was verified by the owner, not by a second board member — see "Run 2" below.** The fixes
work; whether they solve the discoverability problem they were chosen for is untested.

**Clauses 5a and 6a are met.** He used `Return to pool` and `Claim from pool` **without being told
where either lives** — confirmed by the owner, and corroborated by the log, which shows a
`returnToPool` and a `claimSlot` in the session. Those were the two clauses this step was scheduled
to decide, and "a control nobody finds is a control that did not ship" is answered: both shipped.

The finding that hurts is F-10, one screen earlier, on the control nobody thought was at risk — and
per the baseline note it is the one this run was *least* able to measure properly.

---

## After the run

1. Triage the hesitation log into findings from F-10 up, in this file.
2. **Fix defects in Phase 3, not Phase 8.** Step 7 is explicit about this: reaching for
   `REVIEWER_GUIDE.md` means the screen is wrong, because that guide is the artefact FR-9's "no
   account creation, no download, no spreadsheet training" premise exists to make unnecessary.
3. Tick each fix against the FR-9 clause ledger at the top of `plans/phase-3.md` — the ledger itself,
   not a paraphrase of it — before committing.
4. **Step 8 — the second-person re-run — was deliberately SKIPPED for this phase.** See below.
5. Only then Slice 8, the PRD status line. A status line claiming an unverified phase is the one PRD
   edit that must not lead the code.

---

## Run 2 — deliberately skipped, 2026-08-16

**Decided by the owner.** The fixes were verified by the owner's own testing, and no second board
member ran the screen. Recorded here rather than left as an absence, because the difference between
"we checked" and "a stranger checked" is the entire point of this instrument, and a reader a year
from now cannot tell them apart from a doc that simply stops.

### What this does and does not leave confirmed

**BUILD_PLAN's Phase 3 gate clause is met, on its own terms.** It asks for *"one board member who has
never seen it complete a review without instructions"* — one, and that happened: he signed in, scored
every category, wrote a note, returned an applicant and claimed another, all unaided. The clause does
not ask for two, and it does not say anything about who they are.

**What is not confirmed is narrower, and it is worth naming precisely.** Every fix F-10 through F-19
was verified by the person who chose it. So:

- **The fixes are confirmed to work.** They were exercised on the real device.
- **They are not confirmed to solve the problem they were chosen for.** F-10 especially: a chevron was
  added because a designer said the row's affordance was unclear, and the only person to have judged
  the result is the owner, who now knows exactly where to look. Whether a stranger finds the row
  faster than Zechariah did is untested and will stay untested.

**The gap this leaves is the naive-user question**, which the first run could not answer either — the
board member works in app design and probed for problems rather than trying to finish a review. So
across both runs, **nobody without a design background has ever used this screen.** That is the honest
summary of Phase 3's user evidence.

### Why this is a reasonable call, and what would change it

Phase 3's reviewer surface is not the last chance to learn this. **Phase 8's gate is the same
instrument aimed at the whole product** — a board member running a complete mock cycle on the demo
instance using only `ADMIN_GUIDE.md` — and the reviewer dashboard is part of what that exercises.
The written round also ships to a real cohort of ~30 reviewers before first and second round are
built (BUILD_PLAN's Phase 4 milestone note), which is a far larger and more honest sample than one
person in a room.

**If F-10 was the wrong fix, the signal arrives there**, as reviewers who do not start. It is worth
watching for on the first live cycle: a cohort where a noticeable share never opens a single
applicant is this finding coming back.
