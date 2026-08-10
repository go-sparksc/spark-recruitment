# Phase 1 — CSV import and field mapping (FR-1 … FR-5)

**Status:** complete. All five slices shipped; BUILD_PLAN's Phase 1 gate passed by hand in a browser.
**Gate (BUILD_PLAN):** upload the synthetic CSV, map fields, set a rubric, save the instance with a password, reopen it with that password. Password stored as a hash. A CSV with two identical emails is caught at preview.

---

## Context

Phase 0 shipped the schema, but PRD v1.2 moved the ground under it. §5 now carries a `FieldGroup` table; `Field.groupKey` and `Field.isMultiSelect` are gone, replaced by `Field.groupId` + `Field.groupRole`. `prisma/schema.prisma` still implements v1.1, so it is currently the drifted document CLAUDE.md warns about. A migration is the first thing this phase owes.

The reason the model moved is §10.7. Category, inclusion, and the §6 visibility toggles have to be properties of the *group*, so a group cannot end up half hidden and half visible, and so the `1/n` demographic counting can never run over a partially excluded set. Ten one-hot ethnicity columns are one question. The system has to know that before it can count anything, and the only place it can learn it is the import.

Everything else in this phase serves that: a CSV lands, an admin confirms what the columns mean, and one commit turns the file into applicants that nothing will ever key by name again.

`prisma/fixtures/s26-shape.csv` is the target — 29 columns and every hazard in `prisma/fixtures/README.md` present on purpose. This phase adds one more row to it.

---

## Decisions taken before planning

Resolved with the owner; each becomes a PRD edit (see *PRD changes*):

1. **Draft state lives in a staging table.** Upload parses server-side into `ImportRow`; mapping and preview read the database; commit builds `Applicant` rows and drops the staging rows.
2. **Group membership is set with an assign-to-group control, not drag-and-drop.** FR-2's "drag" becomes "assign an ungrouped column to a group." No new dependency, keyboard-accessible.
3. **Per-round visibility toggles ship in this phase**, as a fourth control on the mapping table for `OTHER` groups and columns, alongside the shared resolver.
4. **`FieldGroup.key` is immutable.** Assigned at creation, never re-slugged. `displayName` is what a rename changes — the same split as `Field.id` versus `Field.displayName`. FR-19 and FR-20 will reference `key`, and a key that moves when someone fixes a typo is the name-keying defect this project exists to remove.
5. **Detected groups are proposals until confirmed, and materialize at naming.** Consequence of 4: if `key` is frozen at creation and detection created rows at upload, every detected group would carry `group-1` forever. So detection writes a proposal, not a `FieldGroup`, and the row is created when the admin names it — with `key` slugged from that name. No `FieldGroup` row exists that an admin has not confirmed.

---

## Slice order

Each slice ends at something clickable and gets its own commit.

### Slice 0 — Fixture, alone in its own commit

`prisma/fixtures/s26-shape.csv` gains one row and `prisma/fixtures/README.md` is re-verified against it. **This ships as a single commit containing nothing else**, before any code, so the raw diff can be read on its own. Its README warns that several hazards are easy to destroy accidentally — the trailing space on the column 23 header and the leading spaces on Quinn Spacey's email are both the kind of thing an editor strips on save — and a fixture edit buried in a code commit is one nobody reads.

- New record 28: a **case-only** email duplicate of `bex.placeholder@example.com`, under a different last name so it is not a pure duplicate row, mirroring how the Avery pair is built. Appended rather than placed beside its partner; adjacent duplicates are the easy case.
- README: `27 data rows` → 28; new row-hazard checklist entry; both "entirely empty across all 27 rows" and the near-empty counts for columns 25 and 26 re-verified, with the new row leaving columns 24–27 exactly as they were.
- Nothing is built against it until the diff is reviewed.

**Clickable:** `git show` on one commit that touches two files, and a manual pass over the README's checklists against the raw file.

### Slice 1 — Migration, pure helpers, seed reconciliation

Schema catches up to §5, and the two pure modules the rest of the phase reads through are written and tested first.

- `prisma/migrations/<ts>_field_groups/migration.sql`
  - `CREATE TYPE "FieldGroupRole" AS ENUM ('OPTION','FREE_TEXT')`
  - `CREATE TABLE "FieldGroup"` per §5 — `key`, `displayName`, `category`, `isMultiSelect`, `isIncluded`, `ordinal`, both nullable visibility columns, `UNIQUE (instanceId, key)`, `instanceId` FK `ON DELETE CASCADE`
  - `CREATE TABLE "ImportRow"` — `instanceId` FK cascade, `rowIndex`, `cells jsonb`, `UNIQUE (instanceId, rowIndex)`
  - `ALTER TABLE "Instance"` — add `importCommittedAt`, `importProposals jsonb`, and `CHECK ("importCommittedAt" IS NULL OR "importProposals" IS NULL)`. Clearing the proposals at commit is a line of code that can be dropped in a refactor; this makes it a database guarantee instead, the same reasoning §5 gives for `UNIQUE (instanceId, email)`. Stale proposals sitting on a committed instance would read as meaningful to a successor, and there is no rule for which one wins when they disagree with the `FieldGroup` rows beside them.
  - `ALTER TABLE "Field"` — drop `groupKey` and `isMultiSelect`, add `groupId` (FK, `ON DELETE SET NULL`) and `groupRole`
  - `ALTER TABLE "AuditLog"` — `instanceId` becomes nullable and its FK becomes `ON DELETE SET NULL`. Phase 0 made it `ON DELETE CASCADE`, which means the audit row recording a deletion is destroyed by the cascade that row exists to describe. See *Deleting an instance*.
  - **Backfill, not a silent drop.** For each distinct `(instanceId, groupKey)`, insert a `FieldGroup` and repoint its members with `groupRole = 'OPTION'`. An existing dev database keeps its ethnicity grouping instead of losing it to a column drop.
  - `ALTER TABLE "Field" ADD CONSTRAINT "Field_groupRole_iff_groupId" CHECK (("groupId" IS NULL) = ("groupRole" IS NULL))` — §5 says `groupRole` is "set only when `groupId` is set"; Prisma cannot express that, so it goes in raw SQL with a `prisma/checks/` assertion behind it.
- `lib/fields.ts` — **the one shared resolver** (see *Where resolution lives*)
- `lib/field-groups.ts` — **the §10.7 checked predicate** and `checkedOptions()`
- `prisma/seed/fields.ts` — the write-in moves *into* the ethnicity group as `groupRole: FREE_TEXT`. Phase 0 deliberately kept it out and `plans/phase-0.md` records that as a judgment call; v1.2 reverses it, so phase-0.md gets a superseding note rather than an edit, matching how it already handles the v1.1 supersessions.
- `prisma/checks/field-groups.ts` — same contract as `unique-constraints.ts`: raw SQL, asserts SQLSTATE 23505 on `FieldGroup_instanceId_key_key` and 23514 on the `groupRole` check, cleans up after itself and verifies it did.

**Clickable:** `npx prisma migrate dev` → `npm run seed` → `npm run seed:inspect` prints the ethnicity group with 11 members. `/` gains a Groups count so the migration is visible in a browser.

### Slice 2 — Admin gate, FR-1 dashboard, upload

- `lib/auth.ts` — `requireAdmin()` and `requireInstance(id)`, called in each admin page and **inside every server action**, not only in `proxy.ts`. Next's own guidance is that proxy-layer checks are not the authorization boundary; the check belongs next to the data.
- App-level gate per §8: `ADMIN_PASSWORD_HASH` in env (argon2id digest), verified with the existing `verifySecret()` in `lib/password.ts`. Session is an httpOnly / secure / sameSite=lax cookie holding an HMAC-signed payload (`SESSION_SECRET`, Node `crypto`, no new dependency). Per-instance unlock appends `instance:<id>`. `cookies()` is async in this Next version.
- **FR-1** — `app/page.tsx` becomes the real instance list behind the gate: name, created date, stage, Draft / Imported marker. The Phase 0 placeholder comment says this page is not FR-1; this slice makes it FR-1.
- **New instance from CSV** — name + password + file in one form. The `Instance` row is created here, before the CSV commits, because `passwordHash` is non-null in §5 and §8 forbids an ungated instance existing even as a draft.
- `lib/import/parse-csv.ts` — wraps `csv-parse/sync` (**new dependency**; the fixture's quoted newlines, CRLF, doubled quotes and BOM rule out the one-record reader in `prisma/seed/headers.ts`). `bom: true`, `relax_column_count: false`, **`trim: false`** — cells are stored verbatim so the preview can report Quinn Spacey's padded email rather than silently fixing it.
- `next.config.ts` — `experimental.serverActions.bodySizeLimit: '8mb'`. The default is 1MB and a real 150-applicant export with five essays each will exceed it. This is the only large payload in the app.
- Upload writes, in one transaction: `ImportRow` staging rows, one `Field` per column, and the detection result into `Instance.importProposals`. **No `FieldGroup` rows yet.**

**Clickable:** sign in, create "S26 Recruitment", upload `s26-shape.csv`, land on a 29-row mapping table with one proposed group awaiting a name.

### Slice 3 — FR-2 mapping table

Per column: read-only source header, editable display name (defaults to `cleanHeader()`, moving from `prisma/seed/fields.ts` to `lib/fields.ts` for reuse), include checkbox, category selector, and — for `OTHER` — the two per-round visibility checkboxes. Group rows carry the same controls; grouped columns inherit and render theirs read-only.

Email and display-name designation live here and cannot be excluded (FR-2). `sourceRowIndex` comes from parse order, not a column — `s26-shape.csv` has no row counter, unlike `fixtures/sample-headers.csv`.

**No category guessing.** Every column defaults to `OTHER`, included, ungrouped. Inferring `DEMOGRAPHIC` from header keywords is exactly the silent transform this phase exists to avoid, and `OTHER` carries the same effective visibility as `DEMOGRAPHIC` in §6 — the two differ only in whether FR-11/FR-19 count the column, which is the admin's call. The cost of that default is a written round with nothing in it, which Slice 4's preview warning catches.

**Clickable:** name the proposed group "Ethnicity" (creating it, `key: "ethnicity"`), attach column 14 as `FREE_TEXT`, set the group to `DEMOGRAPHIC`, mark the five essay columns `RESPONSE`, exclude `Network ID`, designate `Email Address` and `First Name` + `Last Name`. Reload; every choice persists.

### Slice 4 — FR-3 preview, commit, delete, and the second-upload refusal

Preview reads the staging rows and reports:

| Finding | Treatment |
|---|---|
| Duplicate email, **compared normalized** | Blocks commit until resolved or discarded |
| Blank email | Reported; permitted — `email` is nullable and Postgres allows many nulls |
| Blank name | Reported; blocks, since `displayName` is non-null |
| Email with surrounding whitespace | Reported as trimmed-on-import, never fixed silently |
| **A detected proposal neither named nor dismissed** | Warns |
| **Zero included fields resolve to `RESPONSE`** | Warns |

**Duplicate detection runs on the normalized value, not the verbatim one.** Trim, NFC-normalize, and lowercase before comparing; display the verbatim value in the preview so the admin sees what is actually in the file. Without this, two rows differing only in case sail through preview and hit `UNIQUE (instanceId, email)` at commit, after the admin has approved — a failure that arrives at the worst possible moment and looks like a bug in the tool. An address that is whitespace-only normalizes to empty and is treated as blank, not as a duplicate of another whitespace-only address.

**An unconfirmed proposal is the same class of failure and gets the same treatment.** Since Decision 5, a proposal the admin never names is not a `FieldGroup` — so committing past one leaves eleven independent ungrouped columns, `checkedOptions` has no group to read, and the §10.7 ethnicity breakdown is dead. Nobody discovers that until FR-11 in Phase 4, long after the import that caused it. So the proposal carries two explicit actions, **Name** and **Dismiss**, and the preview warns until one of them has been taken:

> One detected group has not been confirmed: 10 columns from `American Indian/Alaskan Native/First Nations` to `White`. Unconfirmed, they import as 10 separate questions and will not appear in any demographic breakdown. Name the group, or dismiss it if they really are unrelated.

Warning rather than block, for the reason the group's own defaults are conservative: detection is a heuristic, and a false positive must never be able to wedge an import. **Dismiss** is what keeps the warning from becoming background noise — it clears by a recorded decision rather than by the admin learning to scroll past it, and a dismissed proposal stays listed, collapsed, so the choice is visible and reversible before commit.

**The zero-`RESPONSE` warning exists because of the `OTHER` default.** Under §6, `RESPONSE` is the only category a written reviewer sees. An admin who never sets the essay columns commits an instance where every written reviewer opens an empty profile — and that surfaces in Phase 3, in front of thirty reviewers, not here. It is a warning rather than a block for the same reason as the group-name warning: a plausible instance can legitimately have none, and this phase should not invent a rule §6 does not state.

> No column is categorised as a Response. Written reviewers see only Response fields (§6), so every profile will be empty. If these are the essay columns, set them before committing.

Commit runs one transaction: create `Applicant` rows, delete the instance's `ImportRow` rows, clear `importProposals`, set `importCommittedAt`.

**Delete instance.** `deleteInstance(id)` server action, reachable from the instance settings and from the refusal page. **Gated on the app password, not the instance password** (see *What gates what*), plus typing the instance name to confirm — the standard treatment for something with no undo. The FK cascades from Phase 0 do the row-removal work; the action's own job is the confirmation and the audit trail.

**The audit row has to outlive the instance.** `AuditLog.instanceId` cascades, so a deletion record written the normal way is destroyed by the cascade it describes — the most destructive action in the product would be the only one leaving no trace. The fix is the FK change in Slice 1 plus a deliberate order inside one transaction:

1. Delete the instance's existing `AuditLog` rows. They describe entities that are about to stop existing, and their `previousValue` payloads can carry applicant data that §8's retention rules say should not outlive the cycle.
2. Write the deletion record: `entityType: "Instance"`, `entityId: <id>`, `previousValue: { name, applicantCount, currentStage, importCommittedAt }` — identity and scale, never applicant data.
3. Delete the instance. `ON DELETE SET NULL` orphans that one row by design, and it survives with the instance's identity carried in its own columns rather than in the dead FK.

What remains is one row per deleted instance saying who deleted what and when, and nothing that a purge would have wanted gone. Phase 8's archive-and-purge should age these out on the same threshold as everything else; noted in §10 rather than built here.

**Second-upload refusal.** The check is `Instance.importCommittedAt !== null`, enforced inside the upload and commit server actions. A refusal that lives in a disabled button is not a refusal. It renders as a page state:

> **This instance already has its applicants.**
> S26 Recruitment imported 26 applicants from a CSV on 9 August 2026. An instance accepts exactly one file, and that import is final.
>
> To import a corrected file, delete this instance and start again. Deleting removes its 26 applicants and everything attached to them, permanently, with no undo.
>
> Editing individual applicants in place is not available yet.

Three properties: it names the one correction path that this phase actually builds, it states what that path costs, and it says plainly that the other path does not exist rather than implying it does.

### Slice 5 — FR-4 rubric builder, FR-5 instance unlock

Category-count and max-points grid → `RubricCategory` rows. Locked once any `Score` exists, with an explicit "reset written scores" action behind a confirmation — no `Score` rows exist yet in this phase, so the guard is written and unit-tested rather than demonstrated.

FR-5's name and password were collected in Slice 2; what lands here is unlock and password rotation.

### What gates what

FR-5 says an instance password is never recoverable and that **recovery means an admin with app-level access resets it**. That sentence only describes a real path if the reset is not itself behind the password being reset. So:

| Action | Gate |
|---|---|
| Open an instance and work in it | Instance password |
| **Reset / rotate an instance password** | **App password only** |
| **Delete an instance** | **App password only**, plus typing the instance name |

Gating either of the bottom two on the current instance password creates a trap with no exit: an admin who typos a password at creation cannot open the instance, cannot reset it, and cannot delete it either — a permanently dead row holding real applicant data, produced by a typo.

This means the instance password is not a boundary against someone holding the app password, and it was never meant to be. It scopes routine access between cycles; §8's app-level gate is the actual admin boundary. Worth stating plainly in the PRD so a successor does not mistake it for something stronger and build on that assumption. It also sharpens open decision 16: with one shared `ADMIN_PASSWORD_HASH`, both reset and delete are attributable to "an admin" and nothing finer.

**Clickable:** set four categories, sign out, reopen the instance with its password. Then reset that password holding only the app password, and confirm the old one no longer opens it.

---

## Group detection

**Detection is a suggestion the admin confirms. It never writes a grouping the admin has not seen** — and, since Decision 5, it never writes a `FieldGroup` row at all until the admin names one. Until then the proposal lives in `Instance.importProposals` and renders in the mapping table as a pending group with its members listed and expanded.

`lib/import/detect-groups.ts`, pure, takes headers + parsed rows and returns proposals:

1. For each column, collect the distinct **non-empty** values, compared byte-for-byte after NFC normalization and trim.
2. A column is a **one-hot candidate** when it has at least one non-empty value, exactly one distinct non-empty value, and that value **equals the column's own header exactly**. Never `startsWith`, never `includes`, never a loose `LIKE`.
3. A proposal is a **maximal run of two or more adjacent candidates**.
4. Proposal defaults: `isMultiSelect: true` (a run of one-hots is multi-checkable by construction), `category: OTHER`, `isIncluded: true`, no name. **Naming it is what creates it; dismissing it is what discards it.** Leaving it untouched is neither, and the preview warns until the admin has done one or the other.

Three guards, each one killing a rule that otherwise looks reasonable:

- **A column with zero non-empty values is never a candidate.** `Other Major:` and `Tags` are empty across every row, and "every non-empty value is the same literal" is vacuously true over nothing. Without this guard they group with each other or with a neighbour.
- **A run of one is not a group.** `Anything else you would like us to know about you?` has exactly one non-empty value in the fixture, which makes it single-valued by accident.
- **Value-equals-own-header is required, not merely single-valued.** A column of all `Yes` is single-valued and is not a checkbox. And `Black` is a strict prefix of `Black or African American`, so only exact comparison separates them.

**A form tool exporting `Y`/`TRUE`/`1` instead of the option label detects nothing**, and the admin groups by hand. That is the correct failure: no detection costs a minute, a wrong silent detection costs a cycle.

## Correcting a wrong detection

Four operations, all on the mapping table, all `revalidatePath` server actions:

- **Rename** — edits `FieldGroup.displayName` only. **`key` never moves.** It is slugged once, from the name given at creation, and frozen. `Applicant.data` is keyed by `Field.id`, so no rename can orphan a value either.
- **Split** — select a subset of members and move them to a new group, which is named at the moment it is created and takes its own frozen `key`. The remainder keeps the original. A split that would empty the original deletes it.
- **Merge** — pick two groups; members of the second repoint to the first in ordinal order and the second is deleted. The surviving group's `key`, category, inclusion and visibility win, and the confirmation says so, because those are group properties and the merge is where two answers become one.
- **Assign an ungrouped column to a group** — a `group:` selector on every column row: *None* / each existing group / *New group…* / any pending proposal. Choosing a group also asks for the role, `OPTION` or `FREE_TEXT`. Removing a column clears `groupId` and `groupRole` together, which the `CHECK` constraint enforces at the database.

All four are reversible before commit and none touches applicant values.

## The free-text write-in

**Column 14, `Specify your ethnicity, if not listed above:`, will not be detected, and attaching it is a required manual step rather than an optional one.** Its values vary by definition — that is what free text means — so no value-signature rule can ever reach it. The fixture fills it in only two rows.

Two consequences the mapping table carries:

1. The `FREE_TEXT` role is offered on every column's assign control, not only on detected candidates. A group with no `FREE_TEXT` member is the normal state after detection, not an error.
2. Any `isMultiSelect` group without a `FREE_TEXT` member shows a persistent hint: *"If this question has a write-in column, assign it here — it will not be detected automatically."* This is the one thing the admin has to know that the system cannot infer, so the system says it out loud rather than waiting to be asked.

Being a member is what lets FR-19 find the write-in to display beneath the breakdown. Being `FREE_TEXT` is what keeps it out of the checked predicate and out of `1/n`. Both halves matter, and neither is derivable from the data.

## Where category, inclusion, and visibility resolution lives

**`lib/fields.ts`. One helper, no DB access, tested in isolation — per §6's closing sentence.**

```ts
resolveField(field, group, viewer): { category, isIncluded, isVisible }
visibleFieldIds(fields, groups, viewer): Set<string>
resolvePromoted(viewer): { name: boolean; email: boolean; anonymousLabel: boolean }
```

The three inputs §6 names: `FieldGroup` rows for grouped columns, `Field` rows for ungrouped ones, fixed rules for the promoted ones. Precedence, in order:

1. `groupId` set → the group's `category`, `isIncluded` and visibility win over the member's, always. A member's own values are never read when it is grouped.
2. `isIncluded: false` → invisible to every reviewer role, regardless of anything else.
3. A non-null `visibleToWrittenReviewer` / `visibleToFirstRoundReviewer` wins for that round.
4. Null → the §6 category default. `DEMOGRAPHIC` hidden/hidden/visible, `RESPONSE` visible/hidden/visible, `OTHER` hidden/hidden/visible.
5. Promoted columns are not `Field` rows and are not covered by the per-field toggles: `displayName` and `email` are hidden from written reviewers, `sourceRowIndex` is exposed only as "Applicant 47".

**Every reviewer-facing query selects through `visibleFieldIds()` and projects `Applicant.data` down to that set on the server.** A hidden field is absent from the response, not hidden in the client. Phase 1 has no reviewer surfaces, so nothing consumes this yet — it is written now because Phase 3 builds three surfaces at once, and re-deriving the rule per surface is exactly what §6 forbids.

## Where the §10.7 checked predicate lives

**`lib/field-groups.ts`. Pure, no DB access.**

```ts
isChecked(value: unknown): boolean              // non-empty after trim
checkedOptions(data, group, fields): string[]   // OPTION members only
```

`isChecked` is the whole predicate: empty string, `null` and an absent key are all unchecked; a non-empty value is checked. `checkedOptions` filters to `groupRole === OPTION` before applying it, which is what excludes the write-in from the count. The `1/n` weighting and the "Not specified" bucket are FR-11/FR-19 work built on top of this in Phase 4 — the predicate ships now because detection needs it in Slice 1 and two copies of it would drift.

---

## Files

**New**
- `lib/fields.ts`, `lib/field-groups.ts`, `lib/auth.ts`
- `lib/import/parse-csv.ts`, `lib/import/detect-groups.ts`, `lib/import/preview.ts`
- `*.test.ts` alongside each
- `app/(admin)/instances/new/`, `.../[id]/mapping/`, `.../[id]/preview/`, `.../[id]/rubric/`, `.../[id]/settings/` + `actions.ts` per route
- `prisma/migrations/<ts>_field_groups/migration.sql`, `prisma/checks/field-groups.ts`

**Modified**
- `prisma/schema.prisma` — `FieldGroup`, `FieldGroupRole`, `ImportRow`, `Instance.importCommittedAt` + `importProposals`, `Field` group columns, `AuditLog.instanceId` nullable
- `prisma/fixtures/s26-shape.csv`, `prisma/fixtures/README.md` — **Slice 0, their own commit, no code alongside**. Details there.
- `prisma/seed/fields.ts`, `prisma/seed.ts` — write-in into the group as `FREE_TEXT`; groups created before fields
- `app/page.tsx` — placeholder becomes FR-1
- `next.config.ts`, `package.json` (`csv-parse`), `.env.example`
- `PRD.md`, `plans/phase-0.md`, `CLAUDE.md` (testing section gains the two new pure modules)

**Reused rather than rewritten:** `hashSecret`/`verifySecret` (`lib/password.ts`), `prisma` (`lib/prisma.ts`), `cleanHeader` (relocating from `prisma/seed/fields.ts`), the `prisma/checks/` script contract, the shadcn primitives in `components/ui/`.

## PRD changes

Made **before** the code, per CLAUDE.md — the PRD leads and the schema follows.

- **Status line** — v1.1 → v1.2. The header is stale; §5 and §7.1 are already v1.2.
- **FR-2** — "drag an ungrouped column into one" → "assign an ungrouped column to a group". Add the per-round visibility control to the mapping-table column list.
- **FR-3** — note that duplicate detection compares normalized emails.
- **FR-5** — state which gate protects unlock, reset and deletion, and that the instance password is not a boundary against app-level access.
- **§5** — add `ImportRow`; add `Instance.importCommittedAt` and `Instance.importProposals`; note on `FieldGroup.key` that it is immutable; make `AuditLog.instanceId` nullable with the reason.
- **§8** — note that instance deletion leaves one surviving audit row, and that archive-and-purge must age it out.
- **§10, new entries:**
  - 8. *Import draft state.* **RESOLVED: staging table.** Rows land in `ImportRow` at upload and are deleted at commit; detected groups live in `Instance.importProposals` until named or dismissed. Both are cleared at commit, and a `CHECK` constraint makes that a database guarantee rather than a line of code — proposals left on a committed instance would read as meaningful to a successor and could disagree with the `FieldGroup` rows beside them. Alternatives were a client-held payload, which breaks the 1MB server-action limit on a real 150-applicant export, and a temp file, which does not survive a Vercel deploy.
  - 9. *Instance created before the CSV commits.* **RESOLVED.** Name and password are collected at upload because `passwordHash` is non-null in §5 and §8 forbids an ungated instance existing even as a draft. FR-5 is therefore unlock and rotation, not creation.
  - 10. *Email normalization.* **RESOLVED: trim, NFC, lowercase — and duplicate detection compares the normalized value.** USC addresses are case-insensitive and `Applicant.email` is the FR-12/FR-13 join key. Comparing verbatim would let a case-only pair pass preview and fail `UNIQUE (instanceId, email)` at commit, after approval. The staging row keeps the value verbatim and the preview reports the change, so it is never silent; the pre-normalization form is not retained after commit.
  - 11. *`sourceRowIndex` from parse order.* **RESOLVED.** Assigned at parse, 1-based, never renumbered. Discarding a duplicate at preview leaves a gap, so "Applicant 47" keeps pointing at record 47 of the source file.
  - 12. *Group detection scope.* **RESOLVED:** exact equality with the column's own header, runs of two or more, empty columns never grouped. A form tool exporting `Y`/`TRUE`/`1` detects nothing and the admin groups by hand.
  - 13. *`FieldGroup.key` immutability.* **RESOLVED: assigned at creation, never re-slugged.** `displayName` is what a rename changes. FR-19 and FR-20 will reference `key`; a key that moves when someone fixes a typo reintroduces the name-keying defect in a new place. This is why detected groups are proposals until named — a key stamped before anyone named the group would be `group-1` forever. The cost of that deferral is that a proposal can be committed past, which FR-3 covers with a warning and an explicit Dismiss rather than by silently ungrouping the columns.
  - 14. *Auditing instance deletion.* **RESOLVED: the audit row outlives the instance.** `AuditLog.instanceId` becomes nullable with `ON DELETE SET NULL`, the instance's own audit rows are purged first, and the deletion record survives as an orphan carrying name, counts and stage — never applicant data. Cascading it away was the Phase 0 default, and it made the one irreversible action the one action with no record. Rejected alternative: declare deletion unaudited in v1, which is defensible only if nothing else is audited, and §8 already requires overrides be logged. Phase 8's archive-and-purge should age these rows out on the same threshold as everything else.
  - 15. *What gates password reset and instance deletion.* **RESOLVED: the app password, not the instance password.** FR-5 makes an instance password unrecoverable and names app-level access as the recovery path, which cannot exist if the reset sits behind the password being reset. Gating deletion the same way closes the matching trap: a password typo at creation would otherwise leave an instance that cannot be opened, reset, or removed, holding real applicant data forever. The consequence, worth stating rather than discovering: the instance password scopes routine access and is not a boundary against anyone holding the app password.
  - 16. *Admin identity behind the app gate.* **OPEN — Phase 8, no action in Phase 1.** §8 specifies one app-level password shared by 2–6 admins, so `AuditLog.actor` has no real identity behind it: every manual assignment, manual rejection and decision reversal is attributable to "an admin" and nothing finer. Decision 15 adds password reset and instance deletion to that list, which is what makes this worth deciding rather than inheriting. Acceptable for v1 among co-presidents who trust each other; not acceptable as the permanent answer for a log whose purpose is attribution. Options for Phase 8: per-admin accounts, or a name prompt at sign-in recorded on the session and copied to `actor` — weaker, but honest and cheap. Decide before hardening, not during it.

---

## Verification

```bash
npx prisma migrate dev                      # backfill included; run against a seeded DB
npm run seed && npm run seed:inspect        # ethnicity group: 10 OPTION + 1 FREE_TEXT
npx tsx prisma/checks/unique-constraints.ts
npx tsx prisma/checks/field-groups.ts       # 23505 on the key index, 23514 on the groupRole check
npm run verify                              # typecheck, lint, test
npm run dev
```

**Unit, against `prisma/fixtures/s26-shape.csv`.** The README's hazard checklists are the assertions:

- Parse yields **28 records from more physical lines than that**; the header parses to 29 columns despite the embedded newline in column 21.
- Column 19's 261-character header, the curly quotes in 20 and 22, and the trailing space on 23 survive into `Field.sourceHeader` **verbatim**.
- `Black` and `Black or African American` resolve to different fields for Fen Dummy, Gale Synthetic and Harper Lorem.
- Detection proposes exactly one group, columns 4–13. Column 14 is not in it. Columns 24 and 27 are not grouped. `Anything else…` is not grouped.
- `checkedOptions` gives `n = 3` for Rowan Fixture and `n = 0` for both Pax Writein and Tobin Blankethnicity — the write-in never raises `n`.
- Preview flags the Avery pair (exact) **and the Bex pair (case-only)**; reports Emory's blank email and Quinn's whitespace; does **not** flag Indigo, who has a first name and so a valid `displayName`.
- Preview warns when no included field resolves to `RESPONSE`, and stops warning once one does.
- Preview warns while the detected proposal is untouched, and stops on either Name or Dismiss — the two paths clear the same warning and reach different end states.
- Resolver: a grouped member's own `category`/`isIncluded`/visibility are never read; `isIncluded: false` beats every visibility setting; `null` falls through to the §6 default across all three categories × three rounds.
- Rename changes `displayName` and leaves `key` byte-identical.

**End to end, by hand:**

1. Read the Slice 0 commit on its own and walk the README's checklists against the raw file before anything else is built.
2. Sign in with the app password; confirm the instance list is unreachable signed out.
3. Create an instance, upload the fixture, confirm one proposed group with ten members and no `FieldGroup` row in the database yet.
4. Go straight to preview without touching the proposal; confirm the unconfirmed-group warning names the columns. Dismiss it, confirm the warning clears, then undo the dismissal.
5. Name it "Ethnicity" — the row appears with `key: "ethnicity"`. Assign column 14 as `FREE_TEXT`. Set the group to `DEMOGRAPHIC`.
6. Rename it to "Ethnicity (self-reported)" and confirm `key` is still `ethnicity`.
7. Split the group in two, merge them back, confirm 11 members and one group.
8. Go to preview *without* setting any `RESPONSE` column; confirm the empty-written-round warning. Set the five essay columns to `RESPONSE`; the warning clears.
9. Confirm both duplicate pairs are flagged, Emory and Quinn reported, Indigo not flagged. Discard one Avery and one Bex; commit; land on 26 applicants.
10. `select "importProposals" from "Instance"` → null, and confirm the `CHECK` rejects writing one back onto the committed instance.
11. Attempt a second upload → the refusal page, naming deletion as the only correction path.
12. Set a four-category rubric. Sign out; reopen with the instance password.
13. `select "passwordHash" from "Instance"` → an argon2id digest. Grep the dev server output for the plaintext password; it must not appear.
14. Reset the instance password holding only the app password; the old one stops working. Confirm reset and delete are both reachable **without** the instance password — the FR-5 recovery path.
15. Delete the instance from settings, typing its name to confirm. Verify no orphaned `Field`, `FieldGroup`, `ImportRow` or `Applicant` rows remain, that the instance's earlier `AuditLog` rows are gone, and that **exactly one** row survives with `instanceId IS NULL`, `entityType = 'Instance'`, and no applicant data in `previousValue`.
