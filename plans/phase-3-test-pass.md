# Phase 3 testing and UI pass — findings

**Run against `a6ecc39`, 2026-08-12.** Slices 0–4 committed; 5–8 not built.

The owner drives the browser; Claude reads the dev log, queries the database read-only, scripts the
checks devtools does badly, and records here. **Nothing is fixed during the pass.** Findings are
triaged afterwards and fixed in a separate diff, so the discovery and the change do not interleave.

---

## Baseline, confirmed before anything was clicked

| Check | Result |
|---|---|
| `git status` | clean, `main` at `a6ecc39` |
| `prisma migrate status` | 6 migrations, schema up to date (Neon `neondb`) |
| `npm run verify` | green — 13 files, 332 tests, typecheck and lint clean |
| `next dev` banner | Local `http://localhost:3000`, Network `http://192.168.1.110:3000`, ready in 14.0s |
| `DEV_ALLOWED_ORIGINS` | `192.168.1.110` — matches the banner, so phone testing needs no change |

**Fixture state** (`seed_s26_demo`), matching `plans/phase-3-handoff.md` exactly:

- 150 applicants · 30 WRITTEN reviewers (8 Sparklets) · 20 FIRST_ROUND · 12 SECOND_ROUND
- 428 WRITTEN assignments, all `ACTIVE` / `AUTO` — 128 applicants at 3 reviewers, 22 at 2
- reviewer loads 14–15, nobody at zero
- **0 `Score` rows, 0 `ReviewNote` rows** — so every completion state reads `0/4` and that is correct
- 4 rubric categories, all four carrying a description (138–172 chars)
- access codes present for all three rounds

**A reviewer to sign in as:** `Dev Abiodun`, non-Sparklet, 15 assignments.

**Pre-existing state worth knowing about:** a second instance is already in the database —
`cmsmpjg2n000010libuyl08f5`, "S26 Gate Run", **DRAFT**, 0 applicants, 0 reviewers. Left over from an
earlier session. It is not a defect, and it is useful: it is what section A's "drafts marked as such"
row is checked against. Do not build section F's throwaway instance on top of it — start a new one.

---

## Checklist

Tick a row, or replace the tick with a finding id. A row is not done until it is one or the other.

### A. Admin surface, seeded instance — regression, Phases 1–2

- [x] `/login` — gate; a wrong password fails clearly, no stack trace
- [x] `/` — FR-1 list: seed instance with date and stage, and "S26 Gate Run" marked as a draft
- [x] `/instances/seed_s26_demo/unlock` — password prompt **and the unconditional settings link** (decision 29)
- [x] `/instances/seed_s26_demo` — instance home
- [x] `…/mapping` — the "already has its applicants" refusal names the correction path. **Pass, expected** (FR-3)
- [x] `…/preview` — committed state handled sanely
- [x] `…/rubric` — renders as specified. **F-01** (preference: per-point descriptions)
- [x] `…/reviewers` — roster, paste box, removal guard and link all correct. **F-02** (defect: placeholder reads as the live code)
- [x] `…/assignments` — FR-7 precheck numbers; FR-8 assign **and** unassign **and** swap all three present

### B. Reviewer surface, seeded instance

- [x] `/r/seed_s26_demo?round=WRITTEN` — one screen: round prefilled, name dropdown, code field, one submit. Signed in cleanly with `written-f26`
- [ ] `/r/seed_s26_demo/list` — ~15 rows, `0/4 categories` each, header `0 of 15 complete`
- [ ] `/r/seed_s26_demo/a/<id>` — `Applicant N`, RESPONSE fields, sticky rubric with descriptions, prev/next
- [ ] `/r/seed_s26_demo/pool` — **404 expected**; a 500 or blank 200 is a finding
- [x] **An assignment id belonging to another reviewer — refused.** Scripted; see "B.5 result" below
- [ ] Phone: sign in, open an applicant, rotate; no horizontal overflow, sticky card clears the last response

### C. The §6 server-side gate — scripted

- [x] **Detail-route response bytes carry nothing hidden — PASS.** See "C.1 result" below.
- [x] **OTHER field visible → appears; back to null → gone.** Direct write, UI path blocked by F-03
- [x] **`isIncluded: false` with the written toggle on → absent (inclusion wins).** Same run.
      The **group-level** version is not reachable on seed data either — see below; carried to F
- [x] **DEMOGRAPHIC field with `visibleToWrittenReviewer: true` → still absent.** See "C.3 result"

**Why the group-level inclusion case moved to section F.** The only `FieldGroup` on the seed
instance is `ethnicity`, and it is DEMOGRAPHIC — so there is no OTHER group whose `isIncluded` can be
dropped while a written toggle is on. §5's "the group's value wins when `groupId` is set" is
therefore untested here. Section F builds an instance from scratch and is already in the mapping
table making groups, so the case is cheap there and impossible here.

### D. Sign-in lockout — **after all of B**, and on `SECOND_ROUND`

- [x] Attempts 1–10 read "That code is not right for this round"
- [x] Attempt 11 names a wait in minutes
- [x] **F-04** — the name dropdown clears after every failed submission

### E. Access-code rotation — **already performed, out of order, during A.8**

> ### ⚠ The written-round code is now `written-f26`. `written-s26` is dead.
>
> Rotated while checking the access-code card. Everything downstream in this pass uses the new
> value, and `plans/phase-3-handoff.md`'s credential table is wrong until it is updated.

- [x] New code `written-f26` works for sign-in
- [x] Old code `written-s26` is refused after rotation
- [x] The card states that reviewers already signed in keep their session

**Section E is closed.** The only open item it left was documentation — the handoff's credential
table — and that was corrected in `16045d7`, which now reads `written-f26`. Note that
`prisma/seed.ts:18` still writes `written-s26`, so `npm run seed` resets the code to the dead value.

### F. Non-seeded instance, end to end — decision 31's whole point

The expectations below are not invented for this pass — they are `prisma/fixtures/README.md`'s own
hazard checklist, which documents exactly what the file was built to catch. **29 columns, 28 data
rows**, CRLF, with two fields carrying embedded newlines so a line-per-record reader mis-parses it.

**Throwaway instance: `cmsr3mynk00c9fclik46frgl9`, "Phase 3 test pass - delete me".**

**F.1 — upload**
- [x] FR-2 upload with `prisma/fixtures/s26-shape.csv`; name and password collected at upload
- [x] **29 columns and 28 rows read** — confirmed on screen and in the database
      (`fields=29`, `importRows=28`). Not 31, so the embedded newlines did not fool the parser

**F.2 — mapping**
- [x] The ten one-hot ethnicity columns proposed as **one group**
- [x] **`Black` and `Black or African American` stayed distinct** — two `Field` rows at ordinals 4
      and 5. The strict-prefix trap; only exact comparison survives it
- [x] **`Other Major:` and `Tags` were never proposed** — an entirely empty column has no value
      signature, and "every non-empty value is the same literal" was not satisfied over zero values
- [x] Headers survived verbatim: longest **261 chars**, **1** with an embedded newline, **2** with
      curly quotes, **1** with a trailing space (`" and how would you uniquely contribute? "`)
- [ ] Write-in `Specify your ethnicity, if not listed above:` set to role **write-in (not counted)**
      — currently attached at ordinal 13 but still `OPTION`. See the note below
- [ ] Ethnicity group category set to **DEMOGRAPHIC** — currently `OTHER`, the FR-2 default

**F.3 — the two visibility tests C could not reach** (pre-commit; F-03 closes this window at commit)
> **The two tests must use different columns.** A grouped column's own visibility toggle is not
> rendered at all — `mapping-controls.tsx:520` gates it on `!grouped`, and the row reads "set on the
> group" instead. So a column cannot serve as both the ungrouped C.1 subject and a C.2 group member.

- [ ] **From C.1, the click path.** Tick **Written** on **`Graduation Date:`** — ungrouped, OTHER,
      populated on every row, and not needed by the group below. After commit, confirm it reaches a
      reviewer's payload. The direct-write run proved the server honours the column; this proves the
      checkbox reaches it
- [ ] **From C.2, group-level precedence.** Build a second group by hand from **`Major:`**,
      `Other Major:` and `Minor:`, set it **OTHER**, tick Written, then untick Include. Members must
      vanish from the payload — §5's "the group's value wins when `groupId` is set", untestable on
      the seed instance whose only group is DEMOGRAPHIC.
      **Verify through `Major:`**, the only member with values: `Other Major:` is empty across all 28
      rows and `Minor:` has two, and an empty value is omitted from the view by design, so neither
      can confirm or deny anything

**F.4 — preview and commit**
- [x] Both duplicate pairs found and resolved — the log shows `setRowDiscarded(…, 17, true)` and
      `setRowDiscarded(…, 3, true)`, i.e. the **Avery** exact pair and the **Bex** normalize-only pair
- [x] **Quinn Spacey**'s padded email surfaced and was corrected —
      `setRowEmail(…, 14, "quinn.sample@example.com  ")` shows the verbatim padding reached the UI
- [x] **Non-blocking warning: no included field resolving to RESPONSE.** Necessarily fired —
      every column resolved to OTHER, so `hasIncludedResponseField` was false
      (`lib/import/preview.ts:160`) and the warning rendered. Committed past, which is correct: it
      is a warning, not a blocker
- [x] **Counts reconcile exactly. 26 is right, and 28 was right.**
      **Applicants: 28 − 2 discarded = 26.** **Fields: 29 − 3 promoted = 26**, since §5 removes the
      EMAIL and NAME columns at commit once their values become `Applicant.email` and
      `.displayName` (`promotedRemaining=0` confirms). The two 26s are a coincidence
- [x] `ImportRow` staging emptied at commit (`importRows=0`), per decision 8
- [ ] Non-blocking warning: a detected group neither named nor dismissed — **moved to F.5c.**
      Untestable on instance A once its only proposal was named, since proposals are produced only
      by detection at upload
- [ ] Commit

**F.5 — the rest of instance A** (`cmsr3mynk00c9fclik46frgl9`)

Everything here is independent of field content, so instance A's missing RESPONSE columns do not
weaken any of it. Both pages below need their URL typed — **F-07**.

- [x] FR-4 rubric with descriptions (`saveRubric`, 2 categories)
- [ ] FR-6 roster: manual add **and** paste containing a blank line, a single-word name, and a
      duplicated name — blank dropped, other two to the confirmation queue
- [x] FR-6 paste behaved: blank and whitespace-only lines dropped, `Mary Anne Chen` split on the
      **last** space, `Cher` routed to confirmation and discarded rather than imported with a blank
      last name, both `Alex Kim` lines flagged. Manual add has its own Sparklet checkbox
      (`roster-controls.tsx:288`) and `Kai Lincoln` is the roster's only `isSparklet=true`
- [x] **FR-7 generate on a small roster — correct, and it exercised the path the seed never reaches.**
      4 reviewers, 26 applicants → `target = min(3, 4) = 3`, 78 total slots;
      pool = `min(max(floor(0.05 × 78), 3), 26)` = **3**, the minimum-of-3 rule that never fires at
      150/30; **75 active slots** = 78 − 3; 23 applicants at 3 and **3 distinct** applicants at 2,
      none at zero; loads 19/19/19/18 inside `[floor(75/4), ceil(78/4)] = [18, 20]`
- [x] **Decision 22's instance-level duplicate — PASS, and this is the important one.** Pasting
      `Alex Kim` against the existing reviewer raised `MATCHES_EXISTING_REVIEWER` and offered
      **"Add this round to them"**, **"Create a second reviewer"** and **"Drop"**, with **none
      pre-selected** and Import blocked pending a choice.

      Worth stating plainly, because it is the reason the project exists: goal 1 is *"one canonical
      applicant record… never a name string"*, and decision 22 extends that to reviewers — comparing
      per round rather than per instance *"would create a second row for one human, which is the
      name-keying defect this system exists to remove."* This is the control that prevents it, and
      it behaves. F-09 is a usability note on the neighbouring within-paste case, not on this
- [x] Access code set; shareable link reached sign-in **from the phone** — decision 31 satisfied on a
      non-seeded instance, which is the clause the seed hides
- [ ] *Optional bonus:* once assignments exist, confirm a written reviewer's profile really is empty.
      It is the FR-3 warning's own prediction, and instance A is an accidental live test of it

**F.5b — instance B, configured correctly, for the payload tests**

A is committed with every column as OTHER, so it has no RESPONSE content to serve as a positive
control — and without one, "absent" proves nothing. B exists to give C.1 and C.2 real controls.

- [ ] Fresh FR-2 upload of the same fixture
- [ ] Essay columns (19–23) set to **RESPONSE** — these are the positive control
- [ ] Ethnicity group named, category **DEMOGRAPHIC**, write-in set to **write-in (not counted)**
- [ ] **C.1:** tick **Written** on `Graduation Date:` (ungrouped OTHER)
- [ ] **C.2:** build an OTHER group from `Major:` + `Other Major:` + `Minor:`, tick Written,
      untick Include
- [x] Commit, rubric, two reviewers, access code, generate
- [x] **Payload check — PASS on both.** See "F.5b result" below

**F.5c — instance C, two minutes, never committed**

- [ ] Upload the fixture, name and dismiss **nothing**, go straight to preview
- [ ] Confirm the "detected group(s) have not been named or dismissed" warning renders
      (`lib/import/preview.ts:153`)
- [ ] Delete without committing

**F.6 — destructive, and last**
- [ ] FR-5 password reset (on a throwaway instance only, never the seed)
- [ ] Instance deletion with the typed name — all three throwaways, as the final step of the pass

---

## C.1 result — the §6 server-side gate

`GET /r/seed_s26_demo/a/<id>` as `Dev Abiodun` with a minted `spark_reviewer` cookie, 200, 28,592
bytes searched raw. This is the whole response — server-rendered HTML plus the inlined RSC flight
data — so it is what actually crossed the wire, not what the screen chose to show.

**Absent, as §6 requires:** the applicant's `displayName` in full and each half separately
(`"Lucia Rahman"`, `"Lucia"`, `"Rahman"`); their `email` and its local part (`"lrahman@usc.edu"`,
`"lrahman"`); their demographic values (`"Prefer not to say"`, `"Southeast Asian"`); and every
demographic **heading** (`"Pronouns"`, `"Ethnicity"`).

**Present, as a positive control:** the anonymous label `"Applicant 96"`, two RESPONSE headings, and
the opening of two RESPONSE answers. Without this half the check is worthless — a page that errored
or rendered nothing would report every needle absent and read as a pass.

Two notes on method, so the check is repeatable rather than a one-off:

- **Values under 5 characters are not usable needles.** The first run flagged the demographic value
  `"No"` as a leak; it was matching inside a webpack chunk name. Short generic values cannot be
  distinguished from framework strings, so the script filters them and relies on the field's
  heading instead — a rendered field brings its heading with it, and the headings here are
  distinctive.
- The script lives in the scratchpad, not the repo, and only reads.

---

## F.5b result — C.1 and C.2 through the real UI, on an instance built entirely by hand

Instance B (`cmsr6rsb800h1fclinoewyrj3`), every setting made by clicking the mapping table rather
than by writing to the database. `GET /r/<id>/a/<id>` as `Aidan Dijk`, 200, 24,134 bytes, applicant
row 1.

**The single most useful pair in the run, because it is a controlled comparison inside one response:**

| Column | Resolved state | Reached the wire |
|---|---|---|
| `Graduation Date` | OTHER · `inc=true` · **`wr=true`** | **PRESENT** (heading and value) |
| `Major` | OTHER · **`inc=false`** · `wr=true` | **absent** (heading and value) |

Same category, same written-visibility override, differing only in inclusion — in the same request,
for the same applicant. **C.1** is the ticked checkbox reaching the column and the server honouring
it; **C.2** is inclusion beating visibility, and beating it *through the group*, since `Major`
inherits both flags from the `study` group. That is §5's "the group's value wins when `groupId` is
set", verified end to end rather than asserted.

**Positive controls, all present:** the five RESPONSE essays with their headings, and the anonymous
label `Applicant 1`. Absence in this response therefore means something.

**§6 invariants, all held:**

- `displayName` `"Ada Testcase"` — absent
- `email` `"ada.testcase@example.com"` — absent
- every DEMOGRAPHIC heading — absent, all eleven ethnicity members
- the applicant's populated `"East Asian"` value — absent
- `What are your pronouns?` (OTHER, `wr=null`) — absent, the §6 default for OTHER

**What this closes that the direct-write run could not.** The seed-instance run proved
`lib/fields.ts` resolves correctly when the columns hold certain values. This proves the mapping
table's checkboxes actually write those columns, on an instance created through FR-2 from a CSV, with
no seed data involved anywhere.

---

## C.1 / C.2 result — visibility and inclusion at the server boundary

Driven by direct write rather than through the mapping table, because **F-03** makes the UI path
unreachable on a committed instance. Five states walked in sequence against one applicant, so
consecutive rows differ only by the column under test.

`seed_s26_demo_field_06` — "How did you hear about Spark SC?", ungrouped OTHER, originally
`isIncluded: true`, `visibleToWrittenReviewer: null`. Applicant row 19, value `"Marshall newsletter"`,
viewed as `Dev Abiodun`.

| # | State | Heading | Value | Control |
|---|---|---|---|---|
| 1 | `wr=null, inc=true` — §6 default | absent | absent | present |
| 2 | **C.1** `wr=true, inc=true` | **PRESENT** | **PRESENT** | present |
| 3 | **C.2** `wr=true, inc=false` | absent | absent | present |
| 4 | **C.2** `wr=true, inc=true` restored | **PRESENT** | **PRESENT** | present |
| 5 | **C.1** `wr=null, inc=true` | absent | absent | present |

**PASS on both.** Three things this ordering establishes that a single before/after could not:

- **The toggle genuinely moves bytes.** Row 1 → 2 is the only change, and the field appears; row 4 →
  5 reverses it and the field leaves. So absence is caused by the setting, not by the field being
  unrenderable for some unrelated reason.
- **Inclusion beats visibility, and it is inclusion doing it.** Row 3 hides the field while
  visibility still says show. Row 4 turns inclusion back on and the field returns, which is what
  rules out row 3's absence having been caused by anything else.
- **The positive control holds in all five**, so no row's "absent" is an errored page.

**The database is clean.** Revert in a `finally`, verified by re-read against the values captured
before the first write: `isIncluded: true`, `visibleToWrittenReviewer: null`.

**What this does not cover, and where it goes:** the click path. These five states were written
directly, so they prove `lib/fields.ts` resolves correctly and the server honours it — not that the
checkbox in the mapping table reaches that column. Section F sets the toggle through the real UI
before committing, which is the one place that path is still reachable.

---

## C.3 result — decision 18's inert override, end to end

Decision 18 has two halves: an override on a non-OTHER category is **unreachable through the UI**,
and **inert if it arrives some other way**. The first half is enforced at
`app/instances/[id]/mapping/mapping-controls.tsx:520`, where the written and first-round toggles
render only under `!grouped && effectiveCategory === OTHER` — so there is no click path to this
state, which is why the second half needed the state written directly.

`seed_s26_demo_field_14` — "Pronouns", **ungrouped** DEMOGRAPHIC, `isIncluded: true`, 75 applicants
populated. Ungrouped deliberately: on a group member the group's value wins regardless, so the
field's own override would be doubly inert and would prove less.

| State | Heading `"Pronouns"` | Value `"he/him"` | Control `Applicant 19` |
|---|---|---|---|
| `visibleToWrittenReviewer = null` (original) | absent | absent | present |
| `visibleToWrittenReviewer = true` (written directly) | **absent** | **absent** | present |

**PASS** — the override is inert at the server boundary, not merely hidden by the client.

**The database is clean.** Set, check and revert ran in one program with the revert in a `finally`,
so a failure mid-run could not orphan the override. The field was re-read afterwards and is back to
`null`, matching the value recorded before the write.

---

## B.5 result — the assignment id as an untrusted reference

Five `GET`s against `/r/seed_s26_demo/a/<id>` as `Dev Abiodun`, covering the distinct ways the
reference can be wrong. FR-9's entry-route paragraph requires that an id in a URL be confirmed to
belong to the session's reviewer.

| Case | Result |
|---|---|
| Own assignment — **control** | 200, renders `Applicant 118` |
| Another reviewer's assignment id | **404** |
| Well-formed id that does not exist | **404** |
| No cookie at all | **307** → `/r/seed_s26_demo` |
| Cookie signed with the wrong secret | **307** → `/r/seed_s26_demo` |

All correct, and one property is better than the requirement asked for: **another reviewer's
assignment and a nonexistent id return the identical 404**, so the response does not distinguish
"exists but is not yours" from "does not exist". A 403 on the first would have confirmed the id was
real and made the route an enumeration oracle over the assignment table. A forged signature is
rejected the same way an absent cookie is, so the HMAC is genuinely being checked rather than the
cookie merely being read.

---

## Known-expected — walked and correct, not defects

| Observation | Why it is correct |
|---|---|
| Every completion state reads `0/4` | 0 `Score` rows exist and Slice 5 has not shipped the inputs |
| `/r/<id>/pool` 404s | Slice 6 not built |
| No score inputs on the detail screen | Slice 5; the card is read-only by design in Slice 4 |
| FR-4's rubric lock cannot be exercised | It engages on the first `Score`, and none can be created yet |
| A first tap on `Generate assignments` does nothing | Decision 33's pre-hydration window. Only a finding if the **second** tap also does nothing |

---

## Findings

Severity is one of `blocks-gate` · `defect` · `cosmetic` · `preference` · `expected-gap`.

**`preference` is not a defect.** It means the screen does what the requirement says and the owner
wants it done differently. Those entries record the want rather than a repro, and they are resolved
by changing `PRD.md` or `plans/phase-3.md` first and the code second — never as a bug fix, which
would quietly move the spec out from under the next maintainer.

```
### F-NN · <route> · <one-line title>
Severity:
FR / decision:
Did:
Expected:
Observed:
```

### F-01 · `…/rubric` · one description per category, not one per point value

**Severity:** preference — the screen does exactly what FR-4 and decision 32 specify
**FR / decision:** FR-4, decision 32, §5 `RubricCategory.description`

**Now:** each `RubricCategory` carries a single nullable `description`, collected in the FR-4 builder
and rendered beside the score input on the reviewer's card. Four categories, four descriptions.

**Wanted:** a description per *point value*. For a category scored 1–5, five distinct descriptions —
what a 1 means, what a 3 means, what a 5 means — displayed to the reviewer as a reference table they
consult while scoring, rather than one paragraph covering the whole scale.

**Why it matters, in the terms decision 32 already uses:** that decision's own argument is that a
shared definition of a 4 is the main thing standing between thirty untrained reviewers and the score
variance FR-10 exists to flag. A single description gestures at the scale; a per-point table *is* the
shared definition of a 4. The current design satisfies the sentence and only partly serves the reason
the sentence was written.

**This is a data-model change, not a UI change**, and therefore not a bug fix:

- §5 gains a per-point structure — a `RubricLevel` table keyed `(rubricCategoryId, points)`, or a
  JSONB map on the category. §5 is the source of truth for the data model, so it changes first.
- FR-4's builder grows from one field per category to `maxPoints` fields, which changes what the
  grid looks like and what "number of categories and max points" generates. Editing `maxPoints`
  after levels exist needs a defined behaviour (truncate? backfill?) that nothing currently states.
- FR-4's lock covers descriptions, so the same "a typo costs every score" consequence applies to
  every level, multiplied by five.
- FR-9's card has to fit a 5-row table on a phone alongside the responses, which is the constraint
  that decided the current layout. Decision 32's own resolution was reached *because* the owner
  opened the screen on a phone; this is the same question asked again with five times the content.

**Next step: a PRD discussion, then §5 and FR-4, then code.** Not to be picked up as part of Slice 5.

---

### F-02 · `…/reviewers` · the access-code field's placeholder reads as the live code

**Severity:** defect
**FR / decision:** decision 31, §8, CLAIM in the card's own prose

**Did:** rotated the written-round code from `written-s26` to `written-f26` on
`/instances/seed_s26_demo/reviewers`. Got the success message; the new code works for sign-in.
Observed the field then showing `written-s26` again, reading as "the current code reverted".

**Expected:** after a rotation, nothing on screen suggests the old code is still live.

**Observed, and the mechanism is not a stale display:** there is no current-code display in this
component at all, and there cannot be — `RoundAccessCode` stores only `codeHash`, and
`AccessCodeCard` receives `{ instanceId, round, hasCode }` with no code value in the props. Nothing
was read back. What is on screen is the input's hardcoded attribute at
`app/instances/[id]/reviewers/access-code-card.tsx:84`:

```tsx
placeholder="written-s26"
```

React resets the uncontrolled form when the action succeeds, the typed value clears, and the
placeholder becomes visible for the first time since the page loaded — immediately below a green
success message. Grey placeholder text in a just-cleared field, at that moment, is indistinguishable
from a value.

**Two things make it worse than a generic bad placeholder:**

1. The string is the seed instance's **real written-round code**, identical to `prisma/seed.ts:18`.
   So it does not merely look like a value, it looks like the *correct* value, and an admin who
   trusts it pastes a dead code to thirty reviewers.
2. The card's own prose two lines above says *"It cannot be read back — if it has been lost, set a
   new one."* The screen appears to contradict its own sentence, which teaches an admin that the
   sentence is false.

**Relationship to `cb55512`, since the question was raised:** a different bug, and causally
downstream of that fix. `cb55512` fixed the *value* persisting after a rotation, by moving to an
uncontrolled `useActionState` form that React resets on success — the reasoning is in the component's
own doc comment at lines 22–25, describing this exact failure mode. Clearing the value is precisely
what exposes the placeholder. The first fix was correct and created the conditions for this one.

**Confirmed from the screen by the owner**, which settles it as a static attribute rather than a
state read-back: the text renders in placeholder styling with the field itself empty, and it stays
`written-s26` no matter what the code is rotated to — it survived a rotation to `written-f26`
unchanged. A stale read-back would have shown *something* that moved.

**Not fixed here.** The obvious repair is a generic placeholder that cannot be mistaken for a
credential, but "what should this field say after a successful rotation" is a small design question
and it belongs with the triage, not with the discovery.

---

### F-03 · `…/mapping` · field visibility becomes unreachable the moment the import commits

**Severity:** defect — and the resolution needs a §10 decision before any code
**FR / decision:** §6, FR-2's per-round visibility row, FR-3's finality, goal 3, decision 18
**Resolved 2026-08-14 by PRD decision 34** (`1c32fe9`), **fixed in `46b0ba8`.** The proposed
resolution below was adopted as written — the three booleans become editable after commit,
identity-bearing properties stay frozen — with audit under §8 and no mid-round restriction.
`isMultiSelect` joined the frozen side during implementation: it decides §10.7's checked predicate
and 1/n denominator, so it changes what a committed cohort's demographics mean.

**Did:** tried to reach the Written/Include toggles on `/instances/seed_s26_demo/mapping` to run C.1
and C.2.

**Observed:** the page renders the FR-3 "already has its applicants" card and nothing else.

**This is not a missing link — the capability is genuinely gone after commit, and both layers agree:**

- `app/instances/[id]/mapping/page.tsx:53` — `if (instance.importCommittedAt !== null)` returns the
  `ImportCommitted` card and **returns early**, so the entire columns table, the groups panel, and
  every visibility and inclusion control are never rendered.
- `app/instances/[id]/mapping/actions.ts:34` — `openDraft()` throws on a committed instance, so
  `updateField` and `updateGroup` refuse server-side too.
- `updateField` / `updateGroup` have no other caller anywhere in `app/` — only `mapping-controls.tsx`.

So this is **not** decision 29's shape. There, the capability worked and only the navigation was
missing. Here the server refuses as well, deliberately and with a comment saying why.

**Why it is still a defect, despite being deliberate.** The lock is scoped to the whole mapping
surface, but only part of that surface is unsafe to change after commit. `actions.ts:24` gives the
real reason — *"`Applicant.data` still points at the old ones"* — which is about **field identity**:
renaming, regrouping, or recategorising a column changes what the `fieldId` keys in committed
`Applicant.data` mean. `isIncluded` and `visibleToWrittenReviewer` change no identity at all. They
are presentation policy, and they got frozen alongside the structural mapping because they live on
the same screen.

The consequence is sharp, and §6 is where it bites:

- §6 marks OTHER **"Configurable, default hidden"**, and FR-2 says the mapping table "is where it is
  configured". After commit there is nowhere it can be configured.
- Field visibility is a **per-round** control — CLAUDE.md's own vocabulary: *"Round … distinct
  reviewer rosters and distinct field visibility per round."* Rounds happen weeks after commit.
- So the one window in which an admin may decide what written reviewers see closes **before the
  applicants exist and long before any reviewer signs in**. An admin realistically asks "should
  written reviewers see the major?" while briefing reviewers, not while mapping CSV columns.
- The only correction path FR-3 offers is deleting the instance and re-importing, which destroys
  every applicant, assignment and score to change one boolean.

Goal 3 wants the bias controls "enforced by the system rather than by an admin remembering to hide
columns". They are enforced — C.1's baseline and C.3 both confirm the server honours them exactly —
but they are settable only during import, which is the one moment nobody is thinking about rounds.

**Not fixed here, and not fixable without a decision first.** The question is which parts of the
mapping surface FR-3's finality is actually meant to cover. That is a new §10 entry plus a change to
FR-2/FR-3, per CLAUDE.md's rule to record a new ambiguity rather than pick silently.

> **Proposed resolution, for the §10 decision — not yet agreed, and no code before it is.**
> The **identity-bearing** properties stay frozen at commit exactly as they are today — category,
> group membership, display name, promoted role — because each of them changes what the `fieldId`
> keys in committed `Applicant.data` mean, which is the hazard `actions.ts:24` was written about.
> The **three booleans** — `isIncluded`, `visibleToWrittenReviewer`, `visibleToFirstRoundReviewer` —
> become editable after commit, because they are per-round presentation policy, they orphan no data,
> and §6 calls one of them "configurable" while FR-2 points at the only screen that can configure it.
>
> Open sub-questions the decision has to answer, since they are the reason this is not a one-line
> fix: what the mapping page renders after commit (the full table with identity controls disabled,
> or a narrower round-settings screen); whether the change is audited under §8, given it changes what
> reviewers can see; and whether a change mid-round is allowed at all, or only between rounds.

**Consequence for this pass:** C.1 and C.2 cannot be driven through the UI on any committed
instance. See the C.1/C.2 note below for how they were covered instead.

---

### F-04 · `/r/<id>` · the name dropdown clears after every failed sign-in

**Severity:** defect
**FR / decision:** FR-9's premise, decision 30, `plans/phase-3.md` Slice 3 verify step 4 —
*"Wrong code → a clear failure, **the name selection preserved**, no stack trace"*

**Did:** section D's lockout run — eleven wrong codes on `SECOND_ROUND`. The lockout itself behaved:
attempts 1–10 gave the code error, the 11th named a wait.

**Observed:** the name had to be re-picked from the dropdown before every retry.

**The component is already controlled, so the obvious explanation is wrong.**
`app/r/[instanceId]/sign-in-form.tsx:35` holds `reviewerId` in `useState`, the `<select>` is
`value={reviewerId}` with an `onChange`, and the comment at lines 30–34 says this exact shape exists
*because* "React resets a form once its action completes".

**What the dev server log proves**, which is what rules out the remount theories:

```
GET  /r/seed_s26_demo?round=SECOND_ROUND 200      <- one page load, and only one
POST /r/seed_s26_demo?round=SECOND_ROUND 200      <- x11, each `ƒ signIn(...)`
```

Eleven action POSTs with **no intervening GET**. So there was no full-page reload, no native
pre-hydration form post (decision 33), and no remount. `useActionState` threaded its state correctly
throughout — the log shows the first call receiving `{}` as `_prev` and every later one receiving the
previous error object, which only happens on a continuously mounted component.

**So the mechanism is React's post-action form reset acting on the DOM, not on React's state.** When
the action settles, React resets the form's DOM elements to their HTML defaults; the `<select>` has
no `selected` attribute on any option, so it reverts to the disabled `"Pick your name…"` placeholder.
React then re-renders with `value={reviewerId}` *unchanged from the previous render*, sees no change
to that prop, and does not write it back to the DOM. The state survives; the displayed value does
not. Controlled inputs are not immune to the reset — they only look like they should be.

**Answering the question directly: the fix cannot "cover only the first submission".** It is
controlled state, and there is no code path in this component that behaves differently on submission
2 than on submission 1. `git log` shows `sign-in-form.tsx` has exactly one commit — `bd2c8a4`, which
created it already controlled — so nothing has regressed since. The implication is that the reset
happens on the **first** failed submission too, and that the Slice 3 walkthrough which recorded this
as fixed verified something subtly different.

**Both discriminating checks were run, and they scope this down to a display bug:**

1. **The first failed attempt clears it too**, not only repeated ones — as the mechanism predicted.
   Nothing about this is specific to the lockout run; section D just made it happen eleven times in a
   row, which is why it was noticed there.
2. **Submitting again without touching the dropdown returned `"That code is not right for this
   round."`, not `"Pick your name from the list."`** `FormData` is built from the DOM, so the
   `reviewerId` that reached the server was still correct. **No data is lost. The visible label
   reverts and the underlying value does not.**

**Scope: the smaller fix.** Nothing needs to re-capture or re-store the reviewer's choice; the choice
was never lost. What needs fixing is that the control stops showing what it holds.

**One thing the fixer should not skip, because it is the part that does not add up.** On a native
`<select>`, the displayed label *is* the selected option, which *is* the value — so "the value
survived but the label reverted" is not a state a select should be able to occupy. Something is
re-asserting `value` on the DOM node without the browser updating the rendered option, or the reset
and React's restore are interleaving in an order that leaves the two disagreeing. The obvious
one-line remedy — re-assert `reviewerId` in an effect after the action settles — may be aimed at the
wrong layer, since the value is already correct by the time the form is submitted. **Confirm what is
actually diverging in the browser before writing the fix**, rather than treating the model above as
established: it predicted check 1 correctly and check 2 only half correctly, so it is a partial
account, not a diagnosis.

**Why this matters more than its size suggests.** FR-9's premise is that every extra tap is a review
that does not get completed, and this tax falls precisely on the reviewer who mistypes a code shared
in Slack — on a phone, one-handed, choosing from a thirty-name dropdown, having already been told
only that "the code is not right". It is the same class of defect as F-02: the screen is most
misleading at the exact moment the user is already recovering from an error.

---

### F-05 · `…/mapping` · creating a group is only reachable from a column's own dropdown

**Severity:** preference — the capability exists and works
**FR / decision:** FR-2 ("The admin can rename a group, split it, merge two, or assign an ungrouped
column to a group")

**Now:** `createGroupFromField` is the only entry point for a group the detector missed, and it hangs
off an individual column's group dropdown. Its doc comment states the intent — *"The path for a
question the detector missed entirely — a form that exports Y/TRUE/1 produces no proposals at all,
and the admin has to start somewhere."*

**Wanted:** a general "create group" affordance on the mapping page itself, not only inside one
column's control cluster.

**Why it is worth acting on rather than filing away.** Decision 12 records that a form tool
exporting `Y`/`TRUE`/`1` rather than the option label **detects nothing**, and calls that "the safe
failure, since no detection costs a minute and a wrong silent detection costs a cycle". That minute
is only cheap if the manual path is findable. On an export with no detections at all, the admin sees
a flat 29-row table and must work out that grouping starts inside a row they have not yet decided is
special. The safe failure is only safe if the recovery is obvious.

---

### F-06 · `…/mapping` · no direct way to dissolve a group

**Severity:** preference — the capability exists, by a route nobody would guess
**FR / decision:** FR-2, §5 `FieldGroup`

**It is not missing.** Three paths delete a group today, and all are deliberate:

- `assignToGroup(..., groupId: null)` ungroups a column, and `actions.ts:439-449` then deletes any
  group left with no members — *"Removing the last member leaves an empty group, which nothing can
  use and which would still appear in FR-19. Clean it up rather than leaving a shell."*
- `mergeGroups` deletes the merged group.
- `splitGroup` deletes the original if the split empties it.

**What is missing is a direct one.** Dissolving the eleven-member ethnicity group means ungrouping
eleven columns one at a time and relying on the empty-group cleanup to fire on the eleventh. That is
a correct outcome reached by an route an admin has to reverse-engineer, and the intermediate states
are a partially grouped demographic question — precisely the "half hidden and half visible" condition
§5 says group properties exist to prevent.

**Wanted:** a "dissolve group" control that ungroups every member in one action. No schema change;
the cleanup logic already exists.

---

### F-07 · `…/reviewers`, `…/assignments` · two whole FR surfaces have no inbound link

**Severity:** blocks-gate
**FR / decision:** FR-6, FR-7, FR-8, decision 31, decision 29's general form, goal 4
**Resolved 2026-08-14 by PRD decision 36** (`47f4a25`), **fixed in `d8c42ca`.** `/instances/[id]` is
now an instance hub listing every surface in cycle order with its current state, and every instance
page carries a crumb back to it. `/unlock` and `/settings` deliberately keep a plain `← Instances`,
since both gate on less than `requireInstance` and a hub crumb would bounce a locked-out admin.

**Did:** tried to reach the roster and assignment pages from the rubric page on a draft instance.

**Observed:** no route there. Not from the rubric page, not from mapping, not from the instance root.

**The full navigation graph, which is what makes this conclusive:**

| From | Links to |
|---|---|
| `/instances/[id]` | **redirects** unconditionally to `/mapping` (`page.tsx:20`) — there is no landing page, and the comment says so: *"An instance has no landing page of its own yet"* |
| `/mapping` (draft) | `/rubric`, `/preview` |
| `/mapping` (committed) | `/rubric`, `/settings` — via `ImportCommitted` |
| `/rubric` | `/` only |
| `/preview` | mapping / commit flow |
| `/assignments` | `/reviewers` ×2 |
| **anything → `/assignments`** | **nothing** |
| **anything → `/reviewers`** | **only `/assignments`** |

So `/reviewers` and `/assignments` form a closed island: `/assignments` links into `/reviewers`, and
nothing in the application links into either. **The only way in is typing the URL.** Section A
reached them solely because the URLs were supplied in this pass's instructions — which is exactly
how a gap like this stays invisible to the person testing.

**This is decision 29's general form, at a larger scale than decision 29 itself:** *"a capability
that is correct and unreachable is indistinguishable, from the outside, from one that is missing."*
There it was one link to one recovery page. Here it is FR-6's entire roster surface and FR-7/FR-8's
entire assignment surface — both fully built, both working, neither findable.

**Why `blocks-gate` and not `defect`.** The access-code card lives on `/instances/[id]/reviewers`,
and decision 31 put it there specifically so the Phase 3 gate — *"a board member who has never seen
it completes a review"* — would be reachable on a non-seeded instance. An admin cannot set that code
without first reaching a page nothing links to. The decision solved "no admin surface exists" and
left "no way to get to it", which is the same failure one layer out. It also defeats goal 4: an
E-Board running a cycle from documentation alone cannot navigate to two of the surfaces a written
round requires.

**Not fixed here.** The shape of the fix is a real instance landing page or a persistent per-instance
nav, which is a small design decision rather than a link to drop in — `/instances/[id]` currently
redirects rather than rendering anything, so there is no surface to add the links to yet.

---

### F-08 · `…/preview` · commit is one unguarded click, and it is irreversible

**Severity:** defect
**FR / decision:** FR-3 ("Commit is final"), FR-5's deletion gate, F-03
**Resolved 2026-08-14 by PRD decision 35** (`1c32fe9`), **fixed in `d109f20`** — a two-step
confirmation naming what becomes final, deliberately lighter than FR-5's typed-name gate. Both steps
are server-rendered and work with no JavaScript, per decision 33.

**Did:** worked through the preview page on `cmsr3mynk00c9fclik46frgl9`, discarding two duplicate rows
and correcting a padded email. The instance committed without the owner registering that it had.

**The commit was a real, explicit action** — the dev log shows
`ƒ commitImport("cmsr3mynk00c9fclik46frgl9") in 1670ms`, invoked from `/preview`. Nothing fired it as
a side effect. But the control that fires it is, in full:

```tsx
<Button disabled={pending || !canCommit} onClick={() => run(() => commitImport(instanceId))}>
  Commit — create {keptCount} applicants
</Button>
```

**One click. No confirmation. No second step.** And what it does cannot be undone:

- FR-3: *"An instance accepts exactly one CSV. Commit is final."* The only correction path is
  deleting the instance and importing again.
- **F-03**: commit also permanently freezes every field category, group, inclusion flag and
  visibility toggle. The admin loses the entire mapping surface at the same instant.
- FR-3's own justification for the preview — *"it is the only point at which a bad file can be
  caught cheaply"* — makes an accidental commit expensive by the requirement's own reasoning.

**The asymmetry is the clearest way to see it.** FR-5 guards instance *deletion* behind the app-level
password **and** typing the instance name. Commit is equally irreversible in its effect on the
mapping, and it is one tap with no guard at all. Deletion at least announces itself; commit is a
button among other buttons on a page whose whole purpose is reviewing and adjusting.

It is also an `onClick` handler rather than a form submit, so under decision 33 it is inert before
hydration and then fires instantly afterwards — the exact profile that produces "I do not think I
clicked that".

**This is not the owner mis-clicking through unfamiliarity.** It happened to the person who wrote the
PRD, on their own tool, while deliberately testing it. A guard proportionate to irreversibility —
a confirmation naming what becomes final, or a typed confirmation matching FR-5's deletion gate — is
the fix, and it belongs with the F-03 decision since both concern what commit is allowed to freeze.

---

### F-09 · `…/reviewers` · the within-paste duplicate offers a per-line choice for a pair-level question

**Severity:** preference — **not** the defect it first looked like; see the classification below
**FR / decision:** FR-6's within-paste rule, decision 22's instance-level rule

**Did:** pasted a roster containing `Alex Kim` twice into an instance whose roster was empty. Both
lines were flagged. One `Alex Kim` exists in the roster afterwards.

**Why this is not a spec violation.** FR-6 and decision 22 govern **two different duplicate cases**,
and `lib/roster.ts:34` keeps them as separate flags:

| Flag | Trigger | What the spec requires |
|---|---|---|
| `DUPLICATE_IN_PASTE` | two lines in one paste produce the same name | FR-6: *"not an error, since two reviewers may share a name, but both are flagged for the admin to confirm before commit"* |
| `MATCHES_EXISTING_REVIEWER` | a pasted name matches a reviewer already on the **instance** | Decision 22: offers *"add this round to them"* or *"create a second reviewer"*, **neither a default** |

The roster was empty, so this paste raised `DUPLICATE_IN_PASTE` only. **Decision 22's two-resolution
requirement is about the instance-level case and does not apply here** — and it *is* implemented for
the case it governs (`roster-controls.tsx:229-247`): the "Add this round to them" button renders only
when `item.entry.match` is set, the second button's label switches between "Create a second reviewer"
and "Keep this one" accordingly, and the prose reads *"Add this round to them, or create a second
reviewer if they are a different person."*

**"No default" is also implemented, for every flagged line.** Queue items initialise to
`choice: "PENDING"`, `unresolved` counts them, and `canCommit` requires `unresolved === 0` — so
nothing imports until the admin answers. The section header states the rule outright: *"Nothing here
imports until you say what it is. Two reviewers really can share a name, so neither answer is
assumed."*

**What is left, and it is real but smaller.** For `DUPLICATE_IN_PASTE` the question is inherently
about the **pair** — are these one person or two? — but the affordance is **per line**: each of the
two Alex Kim rows independently offers "Keep this one" / "Drop". The instruction that expresses the
pair-level answer, *"If they are two different people, keep both"*, sits in prose above the buttons
rather than in them. An admin resolving two rows one at a time is answering a question about the pair
twice, in a control that never names the pair. That is how "both flagged, both import" ends up as one
reviewer without the admin registering a decision.

**Wanted:** for `DUPLICATE_IN_PASTE`, present the duplicate lines as one grouped item with two
pair-level answers — "two different people, keep both" / "same person, keep one" — matching the shape
the instance-level case already uses.

**Untested, and more important than the above:** decision 22's instance-level path has not been
exercised at all. Added as a checklist row — instance A now holds an `Alex Kim`, so pasting that name
into it triggers `MATCHES_EXISTING_REVIEWER` directly.

---

## Result

**Every section closed.** A · B · C · D · E · F. `npm run verify` green at the end as at the start —
13 files, 332 tests, typecheck and lint clean — and the only change in the tree is this file.

### Findings

| id | Severity | Where | What |
|---|---|---|---|
| **F-07** | **blocks-gate** | `…/reviewers`, `…/assignments` | Two whole FR surfaces have no inbound link from anywhere in the app — **decision 36**, fixed in `d8c42ca` |
| F-03 | defect | `…/mapping` | Field visibility and inclusion become unreachable at commit — **decision 34**, fixed in `46b0ba8` |
| F-08 | defect | `…/preview` | Commit is one unguarded click, and it is irreversible twice over — **decision 35**, fixed in `d109f20` |
| F-02 | defect | `…/reviewers` | The access-code placeholder is a real credential and reads as the live code |
| F-04 | defect | `/r/<id>` | The name `<select>`'s label reverts after a failed sign-in; value survives |
| F-01 | preference | `…/rubric` | One description per category, not one per point value |
| F-05 | preference | `…/mapping` | Creating a group is reachable only from a column's own dropdown |
| F-06 | preference | `…/mapping` | No direct way to dissolve a group |
| F-09 | preference | `…/reviewers` | Within-paste duplicates get a per-line control for a pair-level question |

**Three of these need a decision before any code**, and all three are recorded with the decision
stated rather than assumed: F-03 (what FR-3's finality is meant to cover), F-01 (a §5 change to the
rubric model), F-08 (which belongs with F-03, since both concern what commit is allowed to freeze).

**Two of the three are now decided.** F-03 and F-08 were resolved together on 2026-08-14 as PRD
decisions 34 and 35 (`1c32fe9`), before any code, per CLAUDE.md's PRD-leads-code rule. **F-01 remains
open** and is still a PRD conversation rather than a fix.

**F-04's scope was narrowed by testing rather than by argument.** It looked like data loss; two
discriminating checks proved the submitted value is correct and only the rendered label reverts. The
write-up says plainly that the mechanism is a partial account, not a diagnosis, and that the fixer
should confirm what diverges in the browser before writing the fix.

**One finding was reclassified downward.** F-09 was reported as a defect against decision 22.
Reading `lib/roster.ts` showed FR-6 and decision 22 govern two different duplicate cases, that the
code implements both, and that the instance-level case — the one decision 22 is actually about —
behaves correctly. What remains is a real usability point, logged as a preference.

### What was verified that could not be seen on screen

- **§6 at the wire, twice.** Once on the seed instance and once on an instance built entirely through
  FR-2 from a CSV. Name, email, every demographic heading and a populated demographic value absent
  from the response bytes, with RESPONSE content and the anonymous label present as controls.
- **Decision 18's inert override**, by writing the state the UI cannot produce and reverting it.
- **Inclusion beating visibility**, in a single response containing its own controlled comparison:
  `Graduation Date` (`inc=true, wr=true`) present beside `Major` (`inc=false, wr=true`) absent.
- **The assignment id as an untrusted reference** — and better than specified, since a stranger's
  assignment and a nonexistent one return the identical 404 rather than an enumeration oracle.
- **FR-7 on a 4-reviewer roster**, exercising the reduced-target and minimum-3-pool rules the
  150/30 seed never reaches: 75 slots = 78 − 3, three distinct applicants short exactly one, loads
  inside `[18, 20]`.
- **Decision 22's instance-level duplicate**, the control that stops two rows existing for one human.
- **§8's deletion audit**, confirmed to outlive the instances it describes and to carry identity and
  scale only, with no applicant data.

### Housekeeping this pass leaves behind

1. ~~**`plans/phase-3-handoff.md`'s credential table is wrong.**~~ **Done in `16045d7`.** The
   written-round code on the seed instance is **`written-f26`**; `written-s26` was rotated away
   during section E and is dead. What remains true, and is not a defect: `prisma/seed.ts:18` still
   writes `written-s26`, so `npm run seed` puts the dead value back.
2. **`S26 Gate Run` (`cmsmpjg2n000010libuyl08f5`) is still there**, an uncommitted draft from
   2026-08-10 holding 28 import rows and one unnamed 10-column proposal. It was left deliberately —
   it is the instance F.5c's warning check was run against, since it was already in exactly the
   state that check needs. Delete it whenever, but note that recreating that state costs a fresh
   import.
3. **Database is otherwise clean.** Instances A and B deleted with audit rows surviving; the two
   direct writes made during section C reverted and verified by re-read; the seed instance's
   fixtures unchanged at 150 applicants, 30 reviewers, 428 assignments.

### What this pass does **not** close

The Phase 3 gate. Only one of `plans/phase-3.md`'s four hard gate steps was reachable:

| Gate step | Status |
|---|---|
| 1. RSC payload check | **Closed** — twice over |
| 2. Force-quit with an unsaved change | Needs Slice 5 |
| 3. Two devices claiming simultaneously | Needs Slice 6 |
| 4. The board-member run | Slice 7, and needs 5 and 6 first |

`PRD.md`'s status line stays at `v1.5, Phase 0-2 complete, Phase 3 next`.

**Recommended order for the fix pass**, on the argument that reachability outranks polish: F-07
first, since two FR surfaces nobody can navigate to is the largest gap and blocks decision 31's
purpose; then F-08 and F-03 together, since they are the same question about commit; then F-02 and
F-04, both of which mislead a user who is already recovering from an error. The four preferences are
PRD conversations, not code.
