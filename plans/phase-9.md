# Phase 9 — what using it found

Companion to PRD §10 decisions 110–118. The reasoning for each decision lives in
the PRD; this file is the execution record — what each slice touches, what its
gate is, and what the gate found.

Everything in this phase came from the owner clicking through a built product
rather than from review. That is the fourth phase in a row where that is true
(3, 5, 6, 7 each recorded it), and it is why the gates below are all "open it in
a browser" rather than "the suite is green".

---

## Slice 9.0 — the decisions — **DONE**

PRD §10 gains 110–118. FR text amended in §5, §6, §10.7, FR-2, FR-3, FR-4, FR-6,
FR-8, FR-9, FR-10, FR-14, FR-16 and §7.4's clause index. Forward pointers on
decisions 22, 27, 32, 34, 39, 40, 62, 74, 80, 82, 83, 83a, 84 and 108.

**Gate:** owner read and approved. Confirmed one premise by hand — decision 111
rests on the second round being one deliberation in one room, and the owner
confirmed that has been true of every cycle.

**Census taken before writing 114's migration rule**, not after:
`RubricCategory.description` is non-null on 17 of 18 rows across six instances,
none whitespace-only. But 12 are the same four strings `prisma/seed/` writes and
regenerates, and 4 are keyboard mash on a walkthrough instance. **One row holds
prose a person wrote for its purpose** — "Initiative" on *Demo Cycle — my
practice run*, whose text names what a 4 means, which is the one case where
migrating into the top value is right rather than least-wrong. Every category on
every instance runs 1–4, so 114's scale-width cap binds on nothing that exists.

---

## Slice 9.1 — the second round becomes visible

Decisions 111 and 112, the resolving-vote 404, and FR-18's grid colour. One
slice because they are one fact reaching four surfaces.

**The two predicates, which is the part to get right.** `SECOND_ROUND_POOL`
(`status = ACTIVE`) is FR-17 clause 17b's pass membership and does not move.
`SECOND_ROUND_COHORT` (`stageReached = SECOND_ROUND`) is new and is what a
reviewer reads. They were one constant only because the sets coincided; widening
the shared one would have created passes over resolved applicants, and leaving it
alone would have kept resolved applicants off the list. One of the two surfaces
had to be wrong and neither would have looked it.

**Read widened, write unchanged.** `flagConflict` and `submitPassVote` keep the
ACTIVE predicate. A resolved applicant is reachable and not votable.

**The 404, and what the reversal did and did not fix.** Root cause:
`second-round/[applicantId]/page.tsx` queried with `SECOND_ROUND_POOL` and called
`notFound()`; `submitPassVote` revalidates that same route, so the reviewer whose
own vote completed unanimity was re-rendered through a query that no longer
matched. No redirect was involved — the redirect logic was never broken. Decision
112 fixes it, but **only because the profile's predicate moved too**; widening
the list alone would have left it exactly in place. Not fixed by the reversal and
done anyway: there was no `not-found.tsx` anywhere under `app/`, so every
reviewer-side 404 was Next's stock page with no way back. Added at
`app/r/[instanceId]/not-found.tsx`, deriving the instance id from the pathname
because the file convention is not given params.

**Files:** `lib/labels.ts` (`Outcome`, `OUTCOME_TONE`, the two mappers),
`lib/passes.ts` (`SECOND_ROUND_COHORT`, `voteAvailability`'s `RESOLVED` state),
`lib/second-round.ts` (`outcome` on the row, `undecidedCount`),
`app/r/[instanceId]/second-round/{load.ts,page.tsx,actions.ts}` and
`[applicantId]/{page.tsx,vote-buttons.tsx}`,
`app/r/[instanceId]/not-found.tsx`,
`app/instances/[id]/passes/[passId]/{page.tsx,pass-grid.tsx}`.

**Two things that would have broken quietly**, both caught by working the clause
list rather than the diff:

1. **The conflict control on a resolved row.** `flagConflict` refuses a resolved
   applicant, so keeping the row without hiding the control would have put a
   working-looking control on every green and red row that the action then
   refuses — the offered-and-refused shape decision 100 exists to prevent.
   Hidden on both the list row and the profile section.
2. **The list's third empty state.** "Every applicant has been decided" used to
   be what an empty `status = ACTIVE` list meant. Under the cohort predicate that
   is unreachable, and the branch would have gone on claiming to handle a case it
   could never see. The sentence moved into the header, derived from
   `undecidedCount`; the empty branch now says the true remaining thing, which is
   that the first round advanced nobody.

**FR-18's colour comes from `PassApplicant.resolution`, never from
`Applicant.status`.** §7.4 is explicit that a pass row records what happened *in
that pass*, so an applicant rejected in pass 3 was genuinely carried by pass 1 and
pass 1's grid has to keep saying so.

**Gate — in a browser, not curl** (Phase 7's process failure was hand-minted
tokens behind "renders correctly" claims). **PASSED.**

- [x] Cast the vote that completes unanimity. Land on a green profile, not a 404.
- [x] The list shows red and green, and the row keeps its place in source order.
- [x] A `CARRIED` applicant is present, settled, and **uncoloured**.
- [x] A resolved row offers no conflict control, on the list and on the profile.
- [x] Pass 1's grid still shows pass 1's resolutions after pass 2 exists.
- [x] No other reviewer's vote is in the RSC payload (decision 74, clause 17z).
- [x] A bad applicant id under `/r/` renders the new not-found with a way back.

**How the first one was reached, since it needed a state the seed does not
contain.** No applicant anywhere was one vote from resolving, so the transition
was staged on `seed_walk0907` — the instance named throwaway — by creating pass 1
and writing YES votes for 11 of its 12 eligible second-round reviewers. The
twelfth vote was cast by hand in the browser, signed in as that reviewer.

Before: "Your vote", Yes / No / Submit, and a conflict control. After submitting:
the same URL, no navigation, no 404 — the section became "Outcome" carrying the
green "This applicant is now a Sparklet", and the conflict section was gone. The
list went from "30 still to decide" to 29, with the green badge on Applicant 1
holding its place in source order.

The database recorded all four writes FR-17 requires: 12 `PassVote` rows,
`PassApplicant.resolution = SPARKLET` with `resolvedAt`, `Applicant.status =
SPARKLET`, and a `Decision` at `stage = SECOND_ROUND` with `actor = SYSTEM`
(decision 69).

**The staging and teardown scripts were scratch, not committed**, and the
teardown asserted its own result rather than assuming it: 1 pass, 12 votes, 1
decision and 1 resolved applicant removed, all four counts back to zero, and
`seed_walk0907` confirmed back at 30 active with no pass. That check matters more
here than it usually would — `CLAUDE.md`'s security note is about a fixture that
destroyed rows the script had never created, so a script that writes votes into a
real instance is exactly the shape that goes wrong. It was guarded three ways:
the instance id hardcoded, the instance *name* required to still contain
"throwaway", and a refusal if any pass already existed.

**Decision 74's payload check is a code reading, not a byte inspection**: the
profile's only `passVote` query is a `findUnique` scoped to the signed-in
reviewer, unchanged by this slice. Said plainly because "verified" should not
cover two different strengths of evidence.

---

## Slice 9.2 — first-round voting moves to the page

Decision 113. The vote control leaves FR-14's list; the list becomes a browsing
and finding surface carrying the reviewer's own vote as a marker.

**Files:** `lib/first-round.ts` (`filterFirstRoundRows`), `lib/first-round.test.ts`,
`app/r/[instanceId]/first-round/{page.tsx,vote-buttons.tsx,actions.ts}`.

**The search is a plain GET form, not a client-side filter**, and that is decision
33 applied rather than a preference. A client filter would be snappier and would
be inert for the ~640 ms decision 33 measured — on the one screen in the product
that is opened cold on a phone by someone who has never seen it. The `?q=` also
survives in the URL, so opening an applicant and coming back lands on the same
narrowed list. The filter itself lives in `lib/` per CLAUDE.md's Phase-5 rule.

**`votedCount` is over every row and the list renders the filtered set.** Two
different sets, deliberately: "voted on 1 of 4" under a search for one name reads
as finished. Stated in the code because the two calls sit three lines apart and
look like they should take the same argument.

**The marker is deliberately not decision 111's green.** That colour means an
*outcome* — the round decided this person — and a reviewer seeing their own "yes"
in green would read it as the applicant having got through. Muted text, and the
word carries it.

**`actions.ts` stopped re-deriving the pool predicate inline.** It was the one
caller of four spelling out `status` and `stageReached` by hand instead of using
`FIRST_ROUND_POOL`, which is exactly the drift the constant exists to prevent.

### What the gate found

**Two applicants named "Diego Hoffmann", indistinguishable on the row.** The
first-round list printed the name and nothing else, so a search for "diego"
returned two identical rows and a reviewer had to open both to tell which was
which. Phase 6 hit this same collision on FR-18's grid and fixed it there by
rendering the written round's `Applicant N` handle beside the name; this list had
never learned it. Decision 113 is what raised the stakes — a list you *browse*
tolerates a duplicate name, a list you *search* does not — and the same change
also made the number searchable in practice, since the filter matches
`sourceRowIndex` and the row had never shown a reviewer what number to type.
Fixed by rendering the handle. **Found by searching the screen, not by reading
the diff**, which is the fourth phase running where that is how a surface defect
surfaced.

**A false alarm worth recording so nobody re-investigates it.** Two attempts to
vote through the browser recorded nothing and produced no POST at all, which
looked exactly like decision 33's dead-control-before-hydration failure — the
first-round buttons are `type="button"` with `onClick`, so they genuinely are
inert in that window, unlike the second round's form-bound control. It was not
that: a five-second wait changed nothing, and the same button clicked by
coordinate fired immediately and recorded the vote. It was an artifact of the
test harness's ref-based clicking, not the product. The hydration exposure is
real and pre-existing, but it is not what happened here.

**Gate — PASSED.**

- [x] No vote control on any list row.
- [x] The vote works on the applicant's page and records.
- [x] "You voted yes" marker appears on that row and nowhere else.
- [x] `Voted on 1 of 48` — the counter is over all rows, not the filtered four.
- [x] Search by name narrows (4 of 48), and `Clear` restores.
- [x] Search by number resolves the name collision to one row.
- [x] Colliding names are distinguishable on the row.

Run on a throwaway instance seeded for it (`SEED_INSTANCE_ID=seed_p92`), since no
existing instance was at `currentStage = FIRST_ROUND`. Deleted afterwards, audit
rows first so the deletion orphaned none — decision 109 records that nothing ages
those out any more, and an instance that was never a real cycle should leave zero
rows behind rather than one. The other six instances were confirmed untouched.

### The handle audit this slice prompted

Fixing one list raised the obvious question, so every surface that renders an
applicant's name was checked rather than assumed. Carrying a handle already:
FR-10's results table (`#{sourceRowIndex}`), FR-19's final dashboard, the admin
applicant profile, FR-8's assignments page, FR-11's selection confirm panel, both
second-round surfaces and FR-18's grid.

**Missing it, and scheduled into 9.5:**

- `app/instances/[id]/first-round-results/results-table.tsx` — FR-15's ranked
  list, name alone beside the checkboxes that advance or reject. **The
  consequential one.** On the list 9.2 fixed, a name collision cost a reviewer
  opening the wrong profile; here it costs advancing the wrong applicant. The
  confirm panel has the same gap — it joins `displayName` for unvoted rejects and
  can print one name twice.
- `app/r/[instanceId]/first-round/[applicantId]/page.tsx` — the profile header.
  Cosmetic by comparison, and inconsistent with the second round's profile and
  with the list that now links to it.

**Left alone, deliberately:** FR-12/13's reconciliation picker labels candidates
`name — email`. Email is the join key and disambiguates better than a row number
where one exists; it degenerates only where FR-3 permitted a blank email. Noted
so a successor sees the choice was made.

**The general lesson, which is the reusable part.** Phase 6 found this on FR-18's
grid and fixed it there. Phase 9.2 found it again on the first-round list. Twice
is a pattern: the data model refuses name-keying correctly, and then the
*presentation* layer reintroduces the ambiguity one screen at a time, because
each screen decides independently whether to print the handle. Anywhere a name
identifies an applicant next to a control that acts on them, the handle belongs
beside it.

---

## Slice 9.3 — two schema changes

Decisions 114 (`RubricLevel`, replacing `RubricCategory.description`) and 116
(`Assignment.suspectedAiUse`). One migration per decision rather than the single
one `migrate diff` emitted, so each is bisectable against the decision it serves.

**The generated SQL would have destroyed the prose.** `prisma migrate diff`
emitted `DROP COLUMN "description"` with no backfill. Hand-finished so the order
is create → carry the text into the top value's criterion → drop, which is
decision 114's rule and the reason that decision exists as prose rather than as
a schema diff. Verified afterwards: 17 rows moved, matching the census exactly,
including the one row of genuinely human prose.

**Scale width is capped on the criteria, not on `maxPoints`.** `MAX_SCALE_VALUES`
bounds how many values a category may offer *while carrying* per-value guidance;
`MAX_POINTS_CEILING` stays at 1000, because lowering it would retroactively
invalidate an instance that has already run — decision 40's whole argument for
making the scale data rather than a rule. `validateRubric` also rejects a
criterion attached to a score outside the range, which is reachable by writing
guidance and then lowering the ceiling and would otherwise be stored, exported
and rendered nowhere.

**`scaleValues` is one helper with three readers** — the builder's inputs, the
validator's check, and the reviewer's buttons. Three derivations of "which values
does this category offer" is how one of them comes to disagree about the floor.

**The export needed three edits, not one.** `EXPORT_TABLES` (both the new table
and `Assignment`'s new column), `DATE_COLUMNS`, and `readSnapshot`'s reader map —
the last scoped through `rubricCategory`, since `RubricLevel` carries no
`instanceId` and an unscoped read would put every instance's rubric prose into
one instance's file. The bidirectional `EXPORT_TABLES` assertion is what forced
the first; the exhaustive `TableReader` type forced the third.

**`prisma/checks/unique-constraints.ts` gained a fourth case.** Decision 114 chose
a table over a jsonb map *specifically* so that one-criterion-per-value is a
database guarantee, and that claim is only worth making if the index bites — so
it is now asserted the way the other three are, through raw SQL, against SQLSTATE
23505 naming the index. Probe rows sit at `points = -1`, deliberately outside any
real scale, so they cannot collide with or be mistaken for real criteria on the
seeded category they attach to; cleanup checks for strays by that value as well
as by id, which is CLAUDE.md's security note applied rather than quoted.

**The dev-server trap fired exactly as documented.** Stopping the background task
killed the `npm` wrapper and left the Next process bound to port 3000, still
serving the pre-`generate` client. `netstat` showed it; `taskkill` needed `//PID`
in Git Bash and was done through PowerShell instead; the port was confirmed free
before restarting. Worth recording that the check is what caught it — nothing
else would have, since `npm run verify` reads the new client from disk and was
green throughout.

### What the gate found

**Nothing wrong with the product, and one thing wrong with my instrumentation.**
Mid-gate I reported the AI flag as a real server-side bug: the action ran, the
form demonstrably serialized `suspectedAiUse: "on"`, and the database still read
false. It was not a bug. The probe script used `findFirst` with **no `orderBy`**,
so Postgres returned an arbitrary assignment — and once updates moved rows
around, it returned a different one than the browser was showing. Reading the
assignment by id showed the flag set correctly, on exactly one row, the one that
was clicked. Recorded because the wrong conclusion was stated out loud before the
right one, and because an unordered `findFirst` in a verification script is a
trap that will look exactly like a product defect the next time too.

Two harness artifacts, neither a product issue: `computer` clicks are in
**screenshot** coordinates, which are ~1.33× the viewport here, so several
"missed" clicks were simply aimed at the wrong place; and Next's dev-overlay
badge (`NEXTJS-PORTAL`) sits on top of the bottom-left corner of the page, which
is where the AI checkbox lands — `elementFromPoint` is what identified it.

**Gate — PASSED, with one item not reachable.**

- [x] Migrations apply, and `migrate diff` afterwards reports an empty diff.
- [x] The backfill carried all 17 descriptions to the top value; census matches.
- [x] `npm run check:round-trip` clean — 25 tables now, `RubricLevel` among them
      with rows, so it was compared rather than waved through as empty.
- [x] `prisma/checks/unique-constraints.ts` — the new index bites, cleanup verified.
- [x] The reviewer's card renders one criterion per value, above the buttons.
- [x] The AI checkbox writes, and writes to the right assignment.
- [ ] **FR-10's flag column and the profile's attributed flag — not visually
      confirmed.** Both are behind the app-level password, which I will not type.
      Built, typechecked and lint-clean; they need an eye on them.

**One follow-up, deferred to 9.5 rather than done here.** The FR-10 column renders
a bare count (`⚑ 2`), and the row carries no denominator — so it does not
distinguish *one of three reviewers suspected* from *the only reviewer who has
read it suspected*, which are very different signals. The fix is the tooltip, not
a fraction in the cell: the honest denominator is **completed reviews**, not
assigned reviewers, because `suspectedAiUse` defaults to false and a reviewer who
never opened the application reads identically to one who read it and did not
suspect. Decision 116 now records that reasoning so a successor does not "fix"
the cell into `1/3`. `row.completedCount` is already in scope at that render
site, so it is a one-line change — folded into 9.5 because three other items open
the same file.

---

## Slice 9.4 — roster and pool

Decisions 115 (a later round is staffed from the earlier round's roster) and 117
(an admin can return an assignment to the pool).

**Decision 115's rule lives in a new `lib/rounds.ts`, and the two rejected homes
are the interesting part.** It started inside the roster's server actions, where
it could not be tested — a `"use server"` module may only export async functions.
Moving it to `lib/roster.ts` looked obvious and was wrong: that module's own
comment states it is "free of the Round enum and of any opinion about which round
is being staffed", and this rule is nothing *but* an opinion about which round is
being staffed, so putting it there would have quietly broken an invariant its
author had written down. Its own module keeps both properties intact and made
nine tests possible.

**115 and 84 are two guards, checked in that order, and the page now says so
too.** 84 is a time lock (the roster freezes once a pass exists); 115 is a
membership rule (holds from the start, applies to the first round as well). The
actions check 84 first, because a frozen roster makes eligibility moot.

**117 extends FR-9's return path rather than adding a verb.** Same
`RETURNED_TO_POOL` row, `returnReason = OTHER`, note required — reusing
`validateReturn` so the two paths cannot disagree about what a return needs.
`unassignReviewer` stays and is deliberately different: it deletes the row and
its scores, so generation may re-pair; a return preserves the scores and writes
decision 23's permanent exclusion. The audit payload names `keptScoreCount` where
unassign's names `deletedScoreCount`, so an admin reading the log can see at a
glance which verb destroyed work.

### What the gate found

**A build error `npm run verify` cannot see.** `ROUND_PREREQUISITES` was exported
from a `"use server"` module, which is legal TypeScript and an illegal Next
build — typecheck, lint and 878 tests were green while `next build` would have
failed. Caught by running the build, now recorded in `CLAUDE.md` beside the
dev-server trap, which is the same shape one layer earlier.

**A prose version of offered-and-refused.** On `demo_reference`'s second-round
tab — locked by decision 84, since it has a pass — both banners rendered: 84's
"this roster is fixed" and then 115's "tick them into this round on the grid
below". The second instructs an admin to do something the first has just
forbidden. Suppressed when `rosterFixed`, mirroring the action ordering. Found by
opening the tab, not by reading the diff.

**A test that was wrong about its own contract.** `prerequisiteBlock([SECOND_ROUND],
SECOND_ROUND)` was asserted to return null; it returns a refusal, because the
prerequisites really are missing. `addRound` never asks — it returns early on
`rounds.includes(round)` — so the caller owns that case. The test was corrected
to the real contract rather than the function bent to fit it.

**Gate — PASSED for what is reachable.**

- [x] The written tab keeps its add form and paste box.
- [x] The first-round tab has neither, and explains where reviewers come from.
- [x] A locked second-round tab shows decision 84's banner only.
- [x] Reviewer chips render `swap · return · ×`, with distinct aria-labels.
- [x] The return confirm names the pairing and all three consequences.
- [x] Submit stays disabled while the note is empty — the note is required.
- [x] `prerequisiteBlock`, nine cases, including the ordering of the named fix.
- [x] **The refusal, clicked.** Staged on a throwaway (`seed_p94`) with a probe
      reviewer holding `rounds: []` — a state no product path creates, which is
      why it needed staging. Ticking their first-round box reverted the checkbox
      and rendered, directly under that row: *"A reviewer joins the first round
      only after the written round… Add them to the written round first."* The
      database kept `rounds: []`, so the refusal held on both sides.
- [x] **The return, executed.** `Lars Ansari` on Applicant 1, carrying four
      scores. Afterwards: `status = RETURNED_TO_POOL`, `returnReason = OTHER`,
      `returnedAt` set, the note stored verbatim, **all four scores intact**, and
      one audit row `RETURN_ASSIGNMENT_TO_POOL` whose payload names
      `keptScoreCount: 4` — the field that distinguishes it from unassign's
      `deletedScoreCount` at a glance. The applicant dropped to two active
      reviewers, so the slot reads as open to `openPoolFor`, which is the whole
      point of a return over an unassign.

Both needed the owner to unlock the instance first: entering a password is off
limits, so a throwaway is only reachable with one manual step from them.

**Two false alarms during this gate, neither a defect.** I reported "no POST
fired" and then "no refusal rendered"; both were me reading the dev-server log
and the DOM before the round trip had finished. The click coordinates were also
suspected and were fine — a recorder attached to `document` showed the click
landing on the right element at the right point. Recorded because I said the
wrong thing out loud twice before saying the right one, and the next person
tempted to blame the harness should check timing first.

**One harness fact worth keeping:** `computer` click coordinates are in
**screenshot** space, which is ~1.33× the viewport here. Compute them as
`rect * (screenshotWidth / window.innerWidth)`; a click aimed at raw viewport
coordinates silently lands somewhere else and looks exactly like a dead control.

---

## Slice 9.5 — admin surfaces

Decisions 110 and 118, plus the five straightforward items, the two missing
handles found by 9.2's audit, and 116's tooltip.

**Decision 110** is `shouldDefaultReviewerVisible` in `lib/fields.ts`, applied by
both mapping actions at the moment a category is chosen — which is the only
moment a column can become RESPONSE, since FR-2's importer never guesses one.
The clause that earns its keep is the third: an **excluded** Responses column is
left alone, because defaulting it would write a choice nobody was asked for and
that choice would then survive being re-included. That is the one path by which
this could hand out visibility unasked, and it is closed. A cross-check asserts
the columns it defaults are exactly the ones `mustChooseVisibility` would have
reported outstanding, so the default and FR-3's blocker cannot describe
different sets.

**Decision 118** is `formatTally`. Nothing about §10.7's counting changed — the
`1/n` weighting, the `Not specified` bucket and the checked predicate are
untouched; what changed is that the panel now prints the denominator it was
always summing to. Two shapes: `1.0/9 (2)` for a multi-select column,
`33/150` for a single-select one, where the second is the general rule with two
of its three numbers coinciding rather than a special case. `isMultiSelect` is
read off the **column**, not off the observed answers, so the format cannot
flicker between two cohorts of the same question.

Each column carries its own denominator — the selection's size on the left, the
pool's on the right. A shared one would belong to one of them and quietly
misdescribe the other.

**The invariant is re-asserted through the formatter**, not only through
`tallySelections`: the printed numerators of a whole breakdown sum to the printed
denominator, over a set containing a single-selector, a multi-selector and a
non-responder together, which is the only combination where it can fail.

**Also in this slice.** Ethnicity cells wrap instead of truncating — `truncate`
is `white-space: nowrap` with the full value only on `title`, and a touch screen
has no hover, so the value was unreadable rather than merely clipped. 116's
tooltip gained "N of M completed reviews". `Applicant N` handles landed on
FR-15's ranked table, its confirm panel (which could print one name twice) and
the first-round profile. "Moved on" filters on both results pages, offered only
once the round is finalized — before that nobody has advanced and the control
would empty the table. `No group` capitalised, and the group dropdown moved
below category and visibility, so the three FR-2 questions read in the order an
admin works through them and the one that overrides the others reads last.

**The back button is an anchor, not a button.** Decision 33 measured ~640 ms
where an `onClick` control is silently inert, and this is the one control an
admin reaches for after opening an applicant from a filtered results view. It
renders as a real `<a href>` to a server-supplied fallback and upgrades to
`router.back()` on click — so it works with no JavaScript, during hydration, and
middle-clicks like a link. `fallback` is required rather than defaulted, which
forces every caller to answer "where does this go when there is no history",
a real case for anyone opening a link from Slack.

**Gate — PASSED.** Run in the browser and confirmed by the owner: *"Phase 9 is
fully gated and clean."*

Three of its items were then re-observed on live screens during the guide
screenshot pass below, which is where the guide's pictures come from:

- [x] The panel prints its denominator — `Black 9.0/158 (12)`, and the weighted
      column of a full breakdown summing to 158.
- [x] First-gen reads `No 113/158` / `Yes 45/158`, no bracketed count.
- [x] A long multi-select ethnicity wraps to two lines, fully readable, no hover.
- [x] "Moved on" on the finalized first-round results: *"30 of 48 advanced to the
      second round."*

---

## Phase 9.6 — the guides

Not in the original plan. Phase 9 changed six screens the two guides describe, so
both were re-read **against the running application** rather than against memory,
which is the only way this kind of pass finds anything.

`REVIEWER_GUIDE.md` — scoring rewritten for per-value criteria and the AI
checkbox; the first-round section rewritten around a list that no longer votes;
the second round gained the outcome badges and the resolved profile. Eleven
screenshots replaced, three added.

`ADMIN_GUIDE.md` — step 2's three rows of controls and decision 110's default,
step 4's per-score criteria, step 5's later-round staffing, step 6's return-to-pool
as a fourth verb beside unassign, step 8's AI column, wrapped ethnicity, printed
denominators and back button, step 11's "Moved on", and step 12's coloured grid
with what the room can and cannot see.

**Three copy defects that only reading the live screen could find**, all fixed
here rather than written around:

1. The rubric builder said its criteria were "shown **beside** the reviewer's
   score buttons". They render above them.
2. "Joins the **written**." — grammatical while the round was a variable, a
   fragment once decision 115 fixed it to one round. Same for the paste box's
   "Everyone pasted joins the written". Both now say "written round", and
   `AddReviewerForm`'s `roundLabel` prop went with them: dead configuration, the
   `size="compact"` case from 9.2 again.
3. The guide's own note claimed steps 1–8 were photographed from the 25-applicant
   training file. Step 8 cannot be: a composition panel over 25 people and an AI
   column nobody has ticked show the layout and none of the point. The note moved
   up to sit before step 8 and now says so.
