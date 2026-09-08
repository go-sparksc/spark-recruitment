# Decision 108 — field visibility becomes a binary, explicitly-chosen flag

## Context

§6's three-category visibility matrix (DEMOGRAPHIC / RESPONSE / OTHER × four viewers) is being
replaced by a single binary flag per mapped column or group: **Reviewer-visible** or **Backend
only**. Reviewer-visible means all three reviewer rounds alike; Backend only means no reviewer in
any round. Admin always sees everything not excluded.

This is a spec change with two deliberately approved behaviour reversals, not a UI simplification:

1. **Essays become visible to first-round reviewers.** Today RESPONSE resolves to hidden for
   `FIRST_ROUND_REVIEWER` (`lib/fields.ts:61-66`), which FR-14 states as "Demographics and written
   responses are hidden per §6."
2. **Demographics become invisible to second-round reviewers.** Today DEMOGRAPHIC resolves to
   visible for `SECOND_ROUND_REVIEWER`, which FR-16 states as "the complete applicant profile:
   demographics, written responses, …".

Name and email are unaffected: they are promoted columns resolved by `resolvePromoted`
(`lib/fields.ts:201-204`), which is category-independent and keeps its fixed rule (blind in the
written round only). Interview scores and notes are likewise outside this system.

Five rules settled in review, beyond the brief:

- **Demographics are locked to Backend only**, server-side, always. Carries decision 18's substance
  forward: goal 3's premise is that the bias control is enforced by the system, not by an admin
  remembering.
- **There is no default.** Every eligible column must have a state explicitly chosen, and the import
  cannot commit until they all do — a hard blocker, not a warning.
- **RESPONSE is enforced by a hard blocker, not by a lock.** Commit is refused if any included
  RESPONSE-category column resolves Backend only. Same enforcement strength as the demographics lock,
  but not a lock, because the two fail in opposite directions: hiding is fail-safe, and **category
  freezes at commit while visibility does not** (decision 34). A locked-open flag on a frozen enum is
  the one state in this model that cannot be walked back — a column mistakenly marked Responses would
  be reviewer-visible for the life of the instance, with un-including it the only escape, which per
  decision 34 also strips it from FR-10's admin profile.
- **A split per-round setting becomes NULL, not a guess.** The old model can express "visible to
  written reviewers only"; the binary cannot. Rows whose two booleans disagree are set unchosen so
  the admin re-picks, rather than being silently widened or narrowed.
- **Draft instances get NULL where nobody has touched the row; committed instances get derived
  values.** A committed instance must never be retroactively blocked. A draft one has a commit gate
  ahead of it, so the must-choose rule applies — but only to rows where both old booleans were NULL.
  A row an admin had actually set carries over, so refining the model does not cost them work they
  already did. Refined after Gate 0; see below.

## What the audit found that changes the shape of the work

**`category` cannot be deleted.** It has a second job independent of visibility:

- `lib/demographics.ts:61-63` selects columns for FR-11/FR-19 and the funnel by
  `resolved.category === DEMOGRAPHIC`. That drives §10.7's 1/n counting and feeds
  `results/page.tsx:141`, `first-round-results/page.tsx:107`, `final/load.ts:76`,
  `lib/archive-io.ts:~228`, and `prisma/checks/archive-purge.ts:241`.
- `lib/import/preview.ts:123-127` drives FR-3's precheck off `category === RESPONSE`.

So the enum survives as a **classification** ("what this column is"), the new flag owns **visibility**
("who may read it"), and the mapping screen keeps its category selector alongside the new checkbox
pair. The two axes are not fully independent — category decides the demographic lock and triggers the
RESPONSE blocker — and §6 must say so rather than claim a clean binary.

**The blast radius in reviewer code is small.** All three reviewer pages and the admin detail page go
through one chokepoint, `buildApplicantView` (`lib/review.ts:350`), which calls `visibleFieldIds`.
None of them branch on category themselves. The behaviour change lands almost entirely inside
`lib/fields.ts`.

**`prisma/seed.ts` and `prisma/demo.ts` are the same catalog.** `demo.ts:184-207` re-runs `seed.ts`
with a different instance id and email domain, so `seed_s26_demo` and `demo_reference` have identical
field rows: 34 fields (7 RESPONSE, 13 DEMOGRAPHIC, 14 OTHER), one ethnicity `FieldGroup`, 3 excluded,
and **both visibility booleans NULL on every row**. Under the backfill they land exactly where the new
model wants them: 7 essays visible, everything else Backend only.

**`seed_walk0907` is not in the repo.** It exists only in the local dev database, from a walkthrough
session, and carries hand-set visibility values the two canonical instances do not. It cannot be
verified by reading files — see the pre-migration gate below.

## Gate 0 — RUN, 2026-09-07. What the database actually held

Five instances, not the three the repo can show:

| instance | state | fields | visibility values |
|---|---|---|---|
| `seed_s26_demo` | committed | 34 | all NULL |
| `demo_reference` | committed | 34 | all NULL |
| `seed_walk0907` | committed | 34 | **all NULL** — a synthetic clone, not a hand-configured instance |
| `cmtggwyw…k28j` "Demo Cycle — my practice run" | committed | 35 | all NULL; no DEMOGRAPHIC fields at all (28 OTHER + 7 RESPONSE) |
| `cmtrtyafn…nlhn` "Kai Walkthrough" | **DRAFT** | 38 | **the only hand-set values**: 6 rows true/true, 1 row false/null |

Three findings that changed the migration:

1. **`seed_walk0907` carries no admin choices.** The instance with hand-set values is the draft
   "Kai Walkthrough". No special handling is needed for the committed seeds.
2. **Zero split rows exist.** The 6 hand-set rows agree; the false/null row also agrees once §6's
   default is applied. The disagree→NULL rule is correct policy but writes nothing today.
3. **The draft rule was refined as a result.** NULL only where *both* old booleans were NULL. A row
   where either was set carries over, which saves the 7 real choices in "Kai Walkthrough" — the
   original rule would have wiped them. Draft unchosen count drops from 37 to 30.

The projection, run as the shipping `CASE` against real rows: the four committed instances land at
7 visible / 27–28 backend / 0 unchosen. Only the draft carries unchosen rows.

Re-run this survey after the migration and diff it against the above.

### The query

Read-only, and worth re-running by hand rather than leaving a script in the tree:

```sql
SELECT i.id, i."importCommittedAt" IS NOT NULL AS committed, f.category,
       f."visibleToWrittenReviewer" AS w, f."visibleToFirstRoundReviewer" AS r,
       f."isIncluded", count(*)
FROM "Field" f JOIN "Instance" i ON i.id = f."instanceId"
GROUP BY 1,2,3,4,5,6 ORDER BY 1,3;
```

and the same over `FieldGroup`. What this has to answer before the migration is written: which
instances exist beyond the two canonical ones, whether `seed_walk0907` is committed or still in
draft, and **how many rows hit the disagree→NULL path**. If that count is large in a committed
instance, the post-commit notice below stops being a nicety.

## Schema

Real schema change. On both `Field` and `FieldGroup`:

- **Drop** `visibleToWrittenReviewer`, `visibleToFirstRoundReviewer`.
- **Add** `isReviewerVisible Boolean?` — nullable, and null means *not yet chosen*, which is what
  makes "no default" representable. It is not a third visibility state: the resolver treats null as
  not visible (fail-closed), so an unchosen column can never leak.

Keep `category`, its enum, and `Field_instanceId_category_idx`.

**Backfill.** For OTHER, null meant "use the §6 default", which is false for both rounds — so
effective values are `COALESCE(col, false)` and "disagree" means the two effective values differ.

```sql
UPDATE "Field" f SET "isReviewerVisible" = CASE
  -- Locked, in draft or committed. §6's DEMOGRAPHIC lock.
  WHEN f."category" = 'DEMOGRAPHIC' THEN false
  -- Draft, and never touched by an admin: the commit gate is still ahead of
  -- this instance, so the no-default rule applies. A row where either boolean
  -- was set was touched by a person and falls through to the rules below.
  WHEN i."importCommittedAt" IS NULL
   AND f."visibleToWrittenReviewer" IS NULL
   AND f."visibleToFirstRoundReviewer" IS NULL THEN NULL
  WHEN f."category" = 'RESPONSE' THEN true
  -- Agreeing rows carry over; split rows are unchosen rather than guessed.
  WHEN COALESCE(f."visibleToWrittenReviewer", false)
     <> COALESCE(f."visibleToFirstRoundReviewer", false) THEN NULL
  ELSE COALESCE(f."visibleToWrittenReviewer", false)
END
FROM "Instance" i WHERE i.id = f."instanceId";
```

Note the clause order: DEMOGRAPHIC is tested first so the lock applies to drafts too, and the
never-touched test sits above RESPONSE so a draft's untouched Response columns are still explicitly
chosen rather than defaulted to visible.

and the structurally identical statement for `FieldGroup`.

Per CLAUDE.md the flow is `prisma migrate diff --from-config-datasource --to-schema
prisma/schema.prisma --script`, then hand-finish. **Gate 1: the finished SQL is shown for review
before `migrate deploy` runs** — specifically to confirm both `UPDATE`s sit above the `DROP COLUMN`s,
since the diff generates only the drops and the ordering is entirely hand-added. Nothing is applied
until you have read it. **Restart `next dev` afterwards** — the running server holds the old client
and `npm run verify` passes against the new one while the app is broken.

## Code

**`lib/fields.ts`** — the whole behaviour change:

- `FieldLike` / `FieldGroupLike`: replace the two booleans with `isReviewerVisible: boolean | null`.
- Delete `CATEGORY_DEFAULTS`, `overridable`, `overrideFor`.
- In `resolveField`, keep steps 1 and 2 unchanged (group wins; `!isIncluded` → invisible to everyone
  including ADMIN). Replace steps 3–4 with: ADMIN → visible; `category === DEMOGRAPHIC` → not
  visible, whatever is stored; otherwise `source.isReviewerVisible === true`.
- Add an exported `mustChooseVisibility(field, group)` so the mapping page, the preview blockers and
  the tests share one definition rather than three.
- `ResolvedField` keeps its four fields — no caller changes.

**Who must choose:** an included, ungrouped-or-group-level, non-promoted column whose category is not
`DEMOGRAPHIC`. Exempt, with the reason in the code: demographic rows (locked), excluded rows
(invisible anyway, and re-includable later since the flag stays editable post-commit), grouped members
(the choice is the group's), promoted rows (their `Field` rows are deleted at commit).

**`lib/import/preview.ts`** — two new entries in `blockers`, plus one restated warning:

- Blocker: *"N column(s) still need Reviewer-visible or Backend only chosen."*
- Blocker: *"N Response column(s) are set to Backend only. Written reviewers would not see them."*
- Warning, unchanged in strength: no included column resolves RESPONSE at all. The new blocker cannot
  fire in that case — there is nothing to violate it — so the existing zero-Response warning still
  has to exist. Reword only.

`canCommit` already gates `commitImport` (`preview/actions.ts:107`), so server-side enforcement is
free. Note: the unnamed-group guard cited as the model for a hard block is **not** one today — it is
a mapping-page nag (`page.tsx:118-120`) plus a preview *warning* (`preview.ts:153-158`). Left as-is;
flagged so the asymmetry is a choice rather than an oversight.

**`app/instances/[id]/mapping/`** —
- `actions.ts`: `setFieldRoundSettings` / `setGroupRoundSettings` take `isReviewerVisible` in place of
  the two booleans; both refuse `true` on a DEMOGRAPHIC row server-side, not only in the UI. Their
  `SET_FIELD_VISIBILITY` audit `previousValue` shape changes with them.
- `page.tsx`: **the unchosen-columns list is a first-class deliverable of this change, not a caveat on
  the backfill.** Compute one `unresolvedVisibility` list from `mustChooseVisibility`, and render it
  on **every** instance's mapping screen — committed or not — for as long as any eligible column has
  NULL visibility. Concretely:
  - Pre-commit: it joins the existing `outstanding` array (113–121) under the current
    "Before you can commit" card, alongside the email/name/group items, and feeds the commit blocker.
  - Post-commit: the card currently returns early on `!committed` (162). Add a second render path with
    the same list under its own heading — "N column(s) need a visibility choice", with copy stating
    that they are hidden from reviewers until one is made. This is the only signal an admin gets for a
    disagree→NULL row, since no commit gate exists behind them, so it ships with the migration rather
    than after it.
  - The card disappears on its own once every eligible column has a state, on both paths.
- `mapping-controls.tsx`: replace each two-checkbox pair (223–264 group, 571–604 column) with two
  mutually exclusive checkboxes, **Reviewer-visible** / **Backend only**, neither checked when
  unchosen. Rendered for every category, disabled with an explanatory note when the category is
  Demographics or the column is excluded. Note: a radio group is the native control for a
  mutually-exclusive pair and gets keyboard and screen-reader behaviour for free; checkboxes are built
  to your stated preference, so they need explicit `role`/`aria-checked` wiring to not read as two
  independent toggles.

**`lib/export.ts:63-64`** — swap the two booleans for `isReviewerVisible` in `EXPORT_TABLES`, or
`lib/export.test.ts`'s `ScalarFieldEnum` assertion fails. Re-run `npm run check:round-trip`
(FR-20 / decision 86) after.

**`lib/archive-io.ts:164-189`**, the page-level `select`s that load these columns
(`r/.../a/[assignmentId]`, `r/.../first-round/...`, `r/.../second-round/...`,
`instances/.../results/[applicantId]`, `results/page.tsx`, `first-round-results/page.tsx`,
`final/load.ts`), and `prisma/checks/archive-purge.ts:231-235` — mechanical column swap.

**`prisma/seed/fields.ts`** — `CATALOG` and `ETHNICITY_GROUP` gain explicit `isReviewerVisible`
(true on the 7 RESPONSE entries, false elsewhere); `prisma/seed.ts:131-158` writes it. Seeding must
not rely on a fallthrough that no longer exists.

## Tests

`lib/fields.test.ts` carries most of the work. The matrix suite (48–94) and the whole per-round
override suite (186–248) are deleted, replaced by: the binary resolves identically for all three
reviewer viewers; ADMIN always visible; **a stored `true` on a DEMOGRAPHIC row does not make it
visible** (direct descendant of the inert-override test at 208–220, and the regression guard for the
lock); null resolves hidden; exclusion still beats everything; group still wins.
`mustChooseVisibility` gets a case per exemption.

`lib/review.test.ts:490-601` — the §6-boundary suite rewritten to the binary, keeping its
DEMOGRAPHIC-override case (539–553) and grouped-member case (555–570). Add the two reversals as named
tests: an essay **is** visible to `FIRST_ROUND_REVIEWER`; a demographic column is **not** visible to
`SECOND_ROUND_REVIEWER`.

`lib/import/preview.test.ts` — a case per new blocker, one for the restated zero-Response warning,
and one confirming a Backend-only *Response group* trips the blocker (the existing suite already has
the group-vs-column distinction at 219–241, which is where that bug would hide).

`lib/demographics.test.ts:209-214` — re-examine its viewer argument; counting behaviour is unchanged.

## PRD

New decision **108** (highest today is 107), formatted per §10's convention: `RESOLVED, amending §6,
§5, FR-2, FR-3, FR-14, FR-16, and decisions 18 and 34.` Record the two behaviour reversals, the
demographics lock and its goal-3 reasoning, the RESPONSE blocker **and why it is a blocker rather than
a lock** (the fail-open/frozen-category argument — that reasoning is the part a successor will
otherwise re-litigate), the no-default rule, the split-row NULL rule, and that category survives for
§10.7 counting.

Forward pointers, in the established trailing-bold style:

- **18** — superseded. Its question dissolves; its hazard is re-answered by the lock.
- **34** — amended, not moot. Frozen/editable line survives; the editable list becomes `isIncluded`
  and `isReviewerVisible`. Its third paragraph's second half ("a column mis-marked DEMOGRAPHIC cannot
  be shown to written reviewers at all") is now the lock's doing rather than category-gating's, and
  its companion sentence ("a column mis-marked RESPONSE can still be hidden by un-including it")
  becomes load-bearing — it is the escape hatch the RESPONSE blocker deliberately preserves.
- **7** — unchanged but load-bearing: 1/n still depends on `category === DEMOGRAPHIC` and on
  group-level inclusion, which is why the enum stays.
- **35** — its confirmation-panel copy enumerates what freezes; the visibility half of that list moves.
- **74, 77** — the two that already amended §6's table. 108 sits on top of them; 77's written-notes
  and attribution rows are untouched.

Section edits: **§6**'s table collapses to Reviewer-visible / Backend only / locked-demographic rows
plus the unchanged promoted and interview rows, and the "Where configurable is configured" paragraph
(376) is rewritten. **§5**'s `Field` (102–110) and `FieldGroup` (82–87) blocks. **FR-2**'s per-round
bullet and the must-choose rule. **FR-3**'s frozen/not-frozen paragraph (421) and its blocker list.
**FR-14** drops "written responses are hidden." **FR-16** drops demographics from its list.
**PRD.md:501** (FR-12's detail view) says "all RESPONSE fields" and needs restating.

## Docs

- **ADMIN_GUIDE §2** — "The group's settings" (102–109) quotes the exact §6 string
  `mapping-controls.tsx:261` emits and moves with it; "Categories" (119–129) becomes two steps,
  classify then choose visibility. Step 3's freeze note (157–165) and step 7's "What a reviewer sees"
  (282–290) update for the reversals.
- **Trap (a), Response-defaulting** (119–129, 142–149) survives in changed form: the failure it guards
  is unchanged, but it is now a blocker rather than a dismissible warning, so step 3's worked example
  changes from "the warning disappears" to "commit is refused until".
- **Trap (b), write-in reclassification** (90–100) is **unchanged and stays as written.** It is about
  `groupRole` OPTION vs FREE_TEXT and §10.7's denominator — orthogonal to category and visibility. The
  brief assumed both traps were artefacts of the old model; only one is.
- **REVIEWER_GUIDE** is wrong in two places once this ships: 80–85 ("instead of essays you get
  interview scores and notes") and 111–113 ("including the answers the written round hid").
- **Screenshots to recapture:** `docs/img/02-mapping.jpg` (certain), `03-preview.jpg` and
  `04-commit-confirm.jpg` (copy moves), `r5-first-round-applicant.jpg` and
  `r7-second-round-profile.jpg` (both show the reversed content).
- **CLAUDE.md:37**'s field-group vocabulary line should follow §6's new wording.

## Order of work

0. **Gate 0** — the database survey above. Report what it finds, including `seed_walk0907`'s actual
   rows, before writing the migration.
1. PRD — decision 108, §6, §5, the FR amendments, the forward pointers. Nothing else starts until the
   PRD reads correctly, per the schema-never-leads-the-PRD rule.
2. `lib/fields.ts` + its tests, then `lib/review.test.ts`. Pure, no database.
3. Schema and migration. **Gate 1** — the finished SQL shown for review; `migrate deploy` only after.
   Then `prisma generate` and **restart `next dev`**.
4. Seed and the mechanical `select` swaps; `lib/export.ts`; re-run `prisma/checks/field-groups.ts` and
   `archive-purge.ts` by hand.
5. Mapping UI (including the post-commit notice) and the preview blockers.
6. Docs and screenshots last, against the real screen.

Steps 2–5 are one vertical slice each; tick every clause of FR-2, FR-3, FR-14 and FR-16 against the
diff before committing, per the clause-ledger rule.

## Verification

- `npm run verify` (typecheck, lint, test) at each step.
- `npm run check:round-trip` after the export change — `tsx --conditions=react-server`, since
  `lib/instance-io.ts` carries `server-only`.
- `prisma/checks/field-groups.ts` and `prisma/checks/archive-purge.ts` by hand after the migration.
  Per CLAUDE.md: never against production.
- Re-run Gate 0's query **after** the migration and diff it against the before-picture, so the
  backfill's effect on `seed_walk0907` is observed rather than assumed.
- Clicked through on the running app, which is what the reversals actually need: reseed, open a
  first-round applicant and confirm the essays appear; open a second-round applicant and confirm
  ethnicity does not; on a fresh import confirm commit is refused until every eligible column has a
  state and until no Response column is Backend only, and that Demographics rows are locked and do not
  count against the block; on `seed_walk0907` confirm the post-commit notice lists exactly the columns
  the survey predicted.
