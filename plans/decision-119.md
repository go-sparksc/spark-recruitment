# Decision 119 — Class standing, derived from graduation date and the cycle's semester

## Context

Reviewers read "Graduation Date: Spring 2028" and have to work out in their heads whether that
applicant is a sophomore or a junior. The tool should do that arithmetic once, the same way for
everyone. This adds a derived **Class standing** line to the applicant views. It is computed from
two inputs: the applicant's graduation-date answer, and a new instance-level **current semester**
that is set once when the cycle is created.

Per project convention the PRD decision landed before any code. **Step 1 is done: decision 119 was
read in full and approved as written by the owner on 2026-09-12.** Its final text is reproduced
below. **`PRD.md` §10 is authoritative** if the two ever disagree.

**This ships before the first real cycle, by the owner's explicit call.** The PRD status line
(now v1.27) and the `phase-8-status` memory both record it as the one exception to the freeze.

## Rules settled in review (the spec)

| Input | Class standing |
|---|---|
| Graduation-date column not designated, **or** current semester unset | No line at all |
| Blank answer | **Unknown** |
| Matches `Fall YYYY` / `Spring YYYY` exactly, 0–1 semesters out | **Senior** |
| … 2–3 semesters out | **Junior** |
| … 4–5 semesters out | **Sophomore** |
| … 6–9 semesters out | **Freshman** |
| Matches the format, 10 or more semesters out (amended 2026-09-12) | **Non-standard** |
| Matches the format but is in the past (negative) | **Non-standard** |
| Any other non-blank value: Summer, months ("May 2027"), the dropdown's `… or later` suffix, typos, degree notes | **Non-standard** |

- **What "matches" means.** Trim the value, collapse internal whitespace, compare case-insensitively,
  and match the whole string against `^(spring|fall) (\d{4})$`. No partial or substring matching.
  That is why `Spring 2030 or later` is Non-standard. (The draft said `20\d\d`. The approved
  decision says "a four-digit year", so the implementation follows the decision.)
- **How semesters are counted.** Each term gets an index, `year*2 + (FALL ? 1 : 0)`, and
  semesters out = graduation index − current index. Example: Fall 2026 → Spring 2027 is 1, so Senior.
- **Where the graduation date comes from.** An admin designates one column on the FR-2 mapping
  table. The system never guesses it from header text, which keeps FR-2's no-guessing rule intact.
  The designation stays editable after commit, like visibility, because it keys nothing in
  `Applicant.data`. At most one column per instance can hold it.
- **Who sees it.** It follows the designated column's `resolveField` result exactly: group,
  inclusion, the DEMOGRAPHIC lock and `isReviewerVisible`. There is no separate toggle. It is
  computed server-side only when the source field id is in the viewer's visible set, so a hidden
  source means class standing never enters the RSC payload.
- **Current semester.** It is required on the new-instance form, with no preselected value. Once
  set, it is immutable: the action refuses a second write. Instances created before this ships get
  a set-once control on the settings page. That control shows only while the value is null.

## Decision 119 — final text, as approved (PRD §10)

Reproduced verbatim from `PRD.md`, with the list indentation removed, including the 2026-09-12 Freshman-ceiling amendment. PRD.md is authoritative.

119. **Class standing is derived from the graduation-date answer and the cycle's current semester. RESOLVED, amending §5, §6, FR-2, FR-3, FR-5, FR-9, FR-10, FR-14 and FR-16.** Applicant views gain a **Class standing** line directly under the graduation date, so thirty reviewers stop doing the same semester arithmetic in their heads and doing it differently. Planned in `plans/decision-119.md`. **Shipped ahead of the first real cycle by the owner's explicit call**, as the one exception to the freeze the status line records.

**The rule, as behaviour.** Two inputs: the applicant's answer in the designated graduation-date column, and the instance's current semester. A term's index is `year × 2`, plus one for Fall; *semesters out* is the graduation index minus the current one.

| Answer | Class standing |
|---|---|
| No column designated, or the instance has no current semester | no line at all |
| Blank | Unknown |
| `Spring`/`Fall` + year, 0–1 semesters out | Senior |
| … 2–3 out | Junior |
| … 4–5 out | Sophomore |
| … 6–9 out | Freshman |
| `Spring`/`Fall` + year, 10 or more out | Non-standard |
| `Spring`/`Fall` + year, but in the past | Non-standard |
| Anything else non-blank — Summer, a month name, the dropdown's "… or later" option, a typo, a degree note | Non-standard |

A value matches only if, trimmed, with internal whitespace collapsed and case ignored, the *whole* string is a season word followed by a four-digit year. No substring matching.

**Amended 2026-09-12, before any code shipped: Freshman is capped at 9 semesters out.** As first approved, the Freshman row read "6 or more out", with no upper bound. That made an obvious typo like `Spring 2207` read as a confident Freshman, which is exactly the wrong label Non-standard exists to prevent.

**Why 9.** Spark's applicant pool includes legitimate five-year programs, and 9 is the furthest a five-year student can be from graduating: someone starting in a Fall graduates in the Spring five years later, 9 semesters on. A ceiling of 7, the four-year maximum, was considered first and rejected because it would turn every first-year in a five-year program into Non-standard. Past 9 the answer fits no program in the pool, whether it is a typo or something genuinely unusual, so it reads Non-standard under the same reasoning as a date in the past.

**The cost, stated plainly, because it goes against this decision's own "never print a wrong label".** The ranges below the ceiling are still counted on a four-year scale. A five-year student therefore gets a label, but in the middle of their program it is one class younger than their actual year:

| Year in a five-year program | Semesters out | Reads |
|---|---|---|
| First | 8–9 | Freshman |
| Second | 6–7 | Freshman |
| Third | 4–5 | Sophomore |
| Fourth | 2–3 | Junior |
| Fifth | 0–1 | Senior |

Only the first and final years read correctly. **The ceiling did not cause the offset, and moving it cannot fix it.** At 7, the same second- to fourth-year students already carried the same one-class-young labels, because they sit 2–7 out, inside both ceilings. Their answer looks exactly like a four-year student's, so no ceiling can tell them apart. The only difference 9 makes for five-year students is their first year, which now reads Freshman, correctly, instead of Non-standard.

**What 9 actually gives up is typo detection in a narrow band.** A mistyped year that lands 8–9 semesters out now reads Freshman rather than Non-standard. Typos further out, like `Spring 2207`, are still caught, which was the gap this amendment was written to close. A reviewer who needs the precise year reads the graduation date directly above the label.

**Non-standard exists so the tool never prints a wrong label.** A graduate student, a progressive-degree student, or a transfer on an odd timeline does not fit a four-year count, and forcing one onto them is worse than declining to. Non-standard tells a reviewer to read the raw answer, which is rendered directly above it. **Unknown means only that the applicant left the question blank** — the two are not interchangeable, and a successor collapsing them loses the difference between "nothing to read" and "read this yourself".

**Strict matching is deliberate.** The real Typeform field is a Fall/Spring dropdown, so anything in that column that is not one of its options is an anomaly worth flagging, not a value to interpret. Two consequences, recorded rather than discovered. A freshman who picks the dropdown's last option, "… or later", reads Non-standard. And the synthetic fixtures, which wrote graduation dates as `May 2027` / `December 2027`, were never the real vocabulary — they are corrected to the dropdown's, rather than the parser being widened to meet them. **Summer is not excluded by a rule, because the real vocabulary never contains it.** The form's dropdown offers eight choices, all Fall or Spring. A `Summer 2027` could only come from someone typing free text outside those eight, so it falls into the same Non-standard bucket as every other off-format entry. It is not a separate carve-out, and a successor should not add one.

**The column is designated, never guessed, and the designation is not frozen.** An admin marks at most one column as the graduation date on FR-2's mapping table. That keeps FR-2's refusal to infer meaning from a header intact. It is not a `promotedRole` — the `Field` row survives commit — and it sits on the not-frozen side of decision 34's line, because it keys nothing in `Applicant.data`: changing it after commit changes a label, not what any stored value means. It lives on `Field` rather than as a foreign key on `Instance` because FR-20's restore writes tables in foreign-key order, Instance before Field, and an `Instance → Field` reference would make that order circular.

**Visibility is inherited, not configured, and inheriting it adds no exposure.** Class standing is a function of a value the viewer can already see and a cycle-wide setting that is not sensitive, so showing it reveals nothing new. Where the source column is hidden — Backend only, unset, DEMOGRAPHIC, excluded, or under a hidden group — class standing is hidden too, and is not computed into the response at all. That holds even though class standing is coarser than the date it comes from: goal 3's controls attach to the column, and a second toggle would be a second place for an admin to forget.

**Class standing is shown in the written round despite that round's blinding, and that is a deliberate tradeoff, not an oversight.** §6 and decision 4 hide name and email from written reviewers for two reasons:
- a name is a bias vector a reviewer grading essays does not need;
- a name identifies one specific person, and so does an email.

Class standing does not identify anyone on its own. **That is a weaker claim than it may sound, and it is not a claim about anonymity.** It is tempting to argue from bucket size: four labels over a pool of 160-odd, or three or four applicants per label among the roughly 12–16 one written reviewer is assigned (160-odd applicants × 3 reviewers ÷ 30–40 reviewers). That argument is the wrong measure at either scale. A written reviewer does not pick an applicant out of the pool statistically. They recognise someone they already know from what is on the screen. The set that matters is the people *that reviewer* knows who applied, and it can be very small — small enough that class standing, combined with other reviewer-visible fields, narrows it to one person.

What holds is narrower: **class standing adds nothing to that recognition that the graduation date did not already provide.** It appears only where the date is reviewer-visible, and the date says more than the label. So the blinding question is not "should reviewers see class standing". It is "should reviewers see graduation date", and that was answered on the column before this decision existed. The recognition route that does exist, through any combination of visible fields, is the one §6 already names: a reviewer who recognises an applicant returns them to the pool.

**The cost is real and stated plainly.** Class year can bias a reviewer. Printing "Freshman" beside an essay makes that easier to act on than a date a reviewer would have had to work out. This is a cost of *salience*, not of exposure, and it does not contradict "visibility is inherited … adds no exposure" above: the reviewer learns nothing the date did not already say, but the label puts it in front of them.

It is accepted for two reasons. The information was already on the screen. And the club decides whether class year belongs in blind review by setting one column, not by the system hiding a derived label while showing its source. **An admin who wants the written round blind to class year sets the graduation-date column to Backend only, and class standing disappears with it in every round.** No setting blinds the label while leaving the date visible, on purpose: that would give the appearance of a bias control without its substance.

**The semester is set once, and the cost of that is stated.** Mis-set at creation, it mislabels every applicant for the whole cycle, and the only correction is deleting the instance. Accepted because the value cannot legitimately change within a cycle, and an editable one invites relabelling applicants mid-round. The same reasoning is why the creation form preselects nothing: a default derived from the clock would be a silent guess that then becomes permanent, which is FR-2's category argument with higher stakes. Instances created before this decision have no semester; each gets a single set-once control on its settings page, audited, and until it is used class standing is **absent**, not Unknown.

**Not a demographic, and not stored.** Class standing is computed at render time. It does not enter §10.7's counting, FR-11's or FR-15's panels, FR-19's funnel, or the per-stage CSVs. The two semester columns and the designation flag reach FR-20's JSON export as ordinary columns through `EXPORT_TABLES`.

Forward pointers:

- **34** — amended. The editable-after-commit list gains the graduation-date designation, on 34's own test: it keys nothing.
- **108** — unchanged. Class standing reads `resolveField` and adds no visibility state.
- **FR-2's no-guessing rule** — unchanged and load-bearing; it is why the designation exists.

**PRD section edits (done in step 1):**
- **§5:** add `Instance.currentTermSeason` and `currentTermYear` with their CHECK, and
  `Field.isGraduationDate` with its partial unique index and CHECK.
- **§6:** add a row: "Class standing — follows its designated source column."
- **FR-2:** add the designation control and the editable-after-commit list.
- **FR-3:** in "what final covers", list the graduation-date designation as not frozen.
- **FR-5:** creation also collects the current semester, which is immutable.
- **FR-9, FR-14, FR-16, FR-10's profile:** each view shows class standing.
- **Status header:** v1.27, decisions through 119, and the "waits until after" sentence amended.

## Schema

The migration adds columns only; there is no backfill.

- `enum TermSeason { SPRING FALL }`.
- `Instance.currentTermSeason TermSeason?` and `currentTermYear Int?`. Hand-added CHECKs:
  both-or-neither is set, and the year is within 2000–2100.
- `Field.isGraduationDate Boolean @default(false)`. Hand-added:
  - a partial unique index, `UNIQUE (instanceId) WHERE "isGraduationDate"`, mirroring EMAIL's;
  - `CHECK (NOT ("isGraduationDate" AND "promotedRole" IS NOT NULL))`, because a promoted row is
    deleted at commit.
- **Why a column on `Field` and not an FK on `Instance`:** `writeSnapshot` (`lib/instance-io.ts:176`)
  restores tables in foreign-key order, Instance before Field. An `Instance → Field` FK would create
  a cycle in that order.

Flow, per CLAUDE.md:
1. `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`.
2. Hand-finish the SQL.
3. **Gate: show the SQL for review before `migrate deploy`.**
4. `prisma generate`, then **restart `next dev`**, and confirm the old process is actually gone.

## Code

**`lib/class-standing.ts` (new, pure, no DB).** Exports:
- `parseTerm(raw)`, returning `{season, year} | null`;
- `termIndex`;
- `classStanding(raw: unknown, current: Term): ClassStanding`, where the result is
  `"Senior" | "Junior" | "Sophomore" | "Freshman" | "Non-standard" | "Unknown"`.

Add it to CLAUDE.md's list of pure `lib/` modules.

**`lib/review.ts` — `buildApplicantView`**, the single chokepoint all four applicant pages already
go through:
- `ReviewFieldLike` gains `isGraduationDate: boolean`. Every caller's `select` then fails typecheck
  until it loads the column, which is how the four pages are found.
- The function gains a `currentTerm: Term | null` parameter.
- When a designated field is in `visible` and `currentTerm` is non-null, it inserts a derived entry
  immediately after that field's position: `displayName: "Class standing"`, `groupDisplayName: null`,
  and a synthetic `fieldId` of `class-standing:<fieldId>`, documented as a render key rather than a
  `Field.id`.
- The entry is inserted even when the raw value is blank, and then reads Unknown. That is the one
  place this differs from the "drop empty values" rule, and the comment says so.
- The pages need no rendering changes. They only add the column and the instance's term to their
  queries:
  - `app/r/[instanceId]/a/[assignmentId]/page.tsx`
  - `.../first-round/[applicantId]/page.tsx`
  - `.../second-round/[applicantId]/page.tsx`
  - `app/instances/[id]/results/[applicantId]/page.tsx`

**`app/instances/new/`**
- `new-instance-form.tsx`: add a required Season select (Spring/Fall, no default) and a Year input.
- `actions.ts`: validate both and write them in the existing `instance.create`.

**`app/instances/[id]/settings/`**
- A set-once form, shown only while the semester is null.
- `setCurrentSemester` action, with `requireInstance` inside it. It does a conditional `updateMany`
  on `currentTermSeason: null`; a count of 0 means refuse. The write is audited.

**`app/instances/[id]/mapping/`**
- `actions.ts`: new `setGraduationDateField(instanceId, fieldId | null)`, going through
  `openInstance`, not `openDraft`, since it is editable after commit.
  - In one transaction it clears the previous designation, then sets the new one.
  - It refuses a promoted column.
  - It audits only when the instance is committed, the same as `setFieldRoundSettings`.
- `mapping-controls.tsx`: a per-column control, separate from the frozen designation select at
  line 474.
  - It is controlled and uses `onChange → run(...)`, like the existing controls, so React 19's form
    reset does not apply.
  - It is disabled on promoted columns.

**Export and seed**
- `lib/export.ts:68,70`: add the three columns to `EXPORT_TABLES`.
- Seed data:
  - `prisma/seed/fields.ts`: set `isGraduationDate` on the `graduationDate` catalog entry.
  - `prisma/seed.ts`: set the instance semester (Spring 2026 for S26).
  - `prisma/seed/corpus.ts` `GRADUATION_DATES`: replace with the real vocabulary (`Spring 2027`,
    `Fall 2027`, …, `Spring 2030 or later`).
  - Seed at least one blank and one Summer value, so every branch can be clicked.
- Fixtures: correct `prisma/fixtures/s26-shape.csv` and `demo-cycle.csv` to the same vocabulary.
  Check `prisma/fixtures/README.md` for how they were produced before editing, and update its note
  on graduation-date values.

## Tests

**`lib/class-standing.test.ts`.** These cases are the spec:
- every range boundary (0 through 9, and 10 and 12 past the ceiling), counted from both a Spring and a Fall current
  term;
- negative → Non-standard; blank and whitespace-only → Unknown;
- `Summer 2027`, `May 2027`, `Spring 2030 or later`, `Spring '27`, `2027 Spring` → Non-standard;
- case and whitespace variants of a valid value still parse.

**`lib/review.test.ts`**
- Class standing is present when the source is visible, and absent when the source is:
  - Backend only, NULL, DEMOGRAPHIC with a stored `true`, or excluded (checked with the ADMIN viewer
    too);
  - grouped under a hidden group.
- Absent when there is no current term, and absent when no column is designated.
- Positioned directly after its source field.
- Blank source gives Unknown with the source line dropped.
- It is not in the returned object at all when hidden, which is the server-side §6 assertion.

**Other tests**
- `lib/export.test.ts`: the manifest assertion picks up the new columns.
- `prisma/checks/`: extend `field-groups.ts`, or add `class-standing.ts`. Raw SQL must show:
  - a second `isGraduationDate` row fails with 23505 naming the index;
  - a promoted and designated row fails with 23514;
  - a half-set semester fails with 23514.
  - The script cleans up after itself.

## Docs

- **ADMIN_GUIDE:** the creation step (semester is permanent, check it), the mapping step (designate
  graduation date), and the settings step (the set-once control for older instances).
- **REVIEWER_GUIDE:** one line on what Non-standard and Unknown mean.
- **README and ARCHITECTURE:** the decision counts. **CLAUDE.md:** the pure-lib list.
- **Screenshots** to recapture if these screens appear: the new-instance form, the mapping table,
  and the reviewer applicant pages.

## Order of work

Each step is one commit, with every clause ticked against the diff.

1. **PRD:** decision 119, the section edits, the status header; `plans/decision-119.md`; the memory
   update.
2. **Pure logic:** `lib/class-standing.ts` and its tests.
3. **Schema and migration.** Gate on the SQL, then `migrate deploy`, generate, restart the dev
   server.
4. **Instance semester:** the creation form and action, the settings set-once control, the export
   manifest.
5. **Designation:** the mapping action and control.
6. **Rendering:** `buildApplicantView`, its tests, and the four page selects. Seed and fixture
   vocabulary.
7. **Docs.**

**Clause ledger for step 6:** written ✓, first-round ✓, second-round ✓, inherits visibility ✓,
Unknown ✓, Non-standard ✓, four ranges ✓, Summer rejected ✓.

## Verification

- `npm run verify` at every step.
- **`npm run build`** after steps 4–6, because they add client form fields and change what crosses
  into client components and what server actions export.
- `npm run check:round-trip` after the export change.
- Run the prisma check script by hand against the dev DB. Never against production.
- **Click through** on the reseeded app:
  1. Create an instance and confirm the semester is required and has no preselection.
  2. Open an older instance's settings and set the semester once. Confirm the control disappears
     and that a replayed POST is refused.
  3. Designate graduation date on a committed instance.
  4. Open a written applicant: "Class standing: Junior" appears under the graduation date and the
     name is still blind. Check a blank answer (Unknown) and a Summer / `or later` answer
     (Non-standard).
  5. Flip the column to Backend only. Class standing disappears for written, first-round and
     second-round reviewers, and the admin profile still shows it.
  6. Check the RSC payload in network tools for the hidden case.
- **Before pushing, remember that Vercel migrates on build.** Confirm the Preview `DATABASE_URL`
  scoping is still correct.
