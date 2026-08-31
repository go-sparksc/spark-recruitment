# Phase 8 — Hardening and handoff

**Gate (BUILD_PLAN Phase 8):** "A board member who has never used the tool runs a complete mock cycle on the demo instance, start to finish, using only `ADMIN_GUIDE.md`. Every place they get stuck is a documentation bug."

---

## Context

Phases 0–7 built the product. Every functional requirement is implemented and every gate has passed. What is left is the half that decides whether the thing survives its author: the security stopgaps become real, the audit log gets a person behind it, retention becomes something an admin can actually execute, and a successor gets documentation plus a safe place to practise.

Four things carry into this phase from earlier work, each already written down:

- **Decision 19** shipped a deliberate stopgap in Phase 1 and enumerated exactly what it does not cover. Phase 8 owns the real answer.
- **Decision 16** resolved admin identity in principle — a name prompt at sign-in, recorded on the session, copied onto the audit row — and deferred the implementation here.
- **`Instance.archivedAt` has existed since Phase 0 and nothing has ever written it.** It was carved out for §8's archive-and-purge and has sat null through eight phases.
- **Decision 17** (two fixture directories) is open with no phase assigned. It is called out below as an optional slice, not folded in silently.

### Two corrections to the phase brief

**`AuditLog.actor` is not an enum.** It is `String` (`prisma/schema.prisma:872`), holding the literal `"admin"` at all twenty `auditLog.create` call sites in `app/`. The `SYSTEM | ADMIN` enum is `DecisionActor` (`schema.prisma:173`) and it sits on `Decision.actor` (`schema.prisma:844`), where decision 69 gives `SYSTEM` a specific meaning: *a tally decided this, not a person*. So the conflict decision 16 does not account for is real but differently shaped — two columns share the name `actor`, do not share a type, and only one of them should ever learn a person's name. Putting a name on `Decision.actor` would break decision 69 outright.

**Any new model breaks `npm run verify` on creation.** `lib/export.test.ts:92` asserts set equality between the models in the generated Prisma client and `EXPORT_TABLE_NAMES` — deliberately, so a table added to the schema cannot be silently dropped from the FR-20 export. This phase adds one table that is *not* instance-owned and must *not* be exported. The manifest therefore needs an explicit exclusion list rather than a widened comparison, so the "no table quietly left out" guarantee survives the exception. See decision 96.

---

## Decisions to record in PRD §10 before any code

House practice since Phase 5: the decision text lands in §10 first, then the code is written against it. Six new entries, 92–97. Numbers 92–95 were confirmed with the owner during planning; 96 and 97 follow from them.

**92 — Shared rate-limit state lives in Postgres, in one table, under a row lock.**
A `RateLimitBucket` table keyed by the existing `scope:ip` string. The state machine in `lib/rate-limit.ts` stays exactly as it is and stays pure — it is refactored from a closure over a `Map` into functions over a bucket *record*, so the same cases keep testing the same transitions. `lib/rate-limit-store.ts` is the Prisma half. Reads and writes happen inside a transaction that locks the row (`INSERT … ON CONFLICT DO UPDATE … RETURNING` acquires it in one statement), because two simultaneous failures that both read `failures = 3` and both write `4` give an attacker a free guess per concurrent request — the exact hole a shared store exists to close. Row locking rather than expressing the machine in SQL: a second copy of the transitions in a `CASE` expression is a place the two copies can disagree, and at login volume the lock costs nothing.

Lockouts are recorded, per decision 19's last bullet. A lockout on the **instance password** or a **round access code** writes an `AuditLog` row carrying that instance's id, so it is visible in the audit view and in the FR-20 export. A lockout on the **app-level gate** has no instance and writes `instanceId = null` — durable in the database, but invisible in-app and excluded from every export, since decision 86's export is instance-scoped. That gap is stated rather than papered over; closing it would need an app-level security view, which is out of scope here.

**93 — `AuditLog` gains `actorName String?`; `actor` and `Decision.actor` are untouched.**
`actor` keeps carrying the role literal (`"admin"`, `"system"`), so a query can still separate "a person did this" from "the system did this" without string matching. `actorName` carries the first and last name decision 16 asks for. Rows written before this phase keep `actor = "admin"` and `actorName = null`, which is honest — those actions genuinely have no known person, and backfilling a name onto them would be a lie in the one table whose purpose is attribution. `DecisionActor` is not extended and `Decision.actor` never learns a name: decision 69's `SYSTEM` means a unanimous tally resolved the applicant, and there is no person to name.

**94 — The retention threshold is the `RETENTION_CYCLES` environment variable, default 2.**
Read once, displayed on the archive screen so the admin acts on a number they can see. No schema change and no new surface. It is deliberately not editable from the app: everything else behind the app gate is reversible or additive, and a threshold an attacker with the shared password could set to 0 turns a retention control into a delete-everything button. The cost is a redeploy to change it, and a line in `.env.example` the next maintainer has to find — which is why `ARCHITECTURE.md` names it.

**95 — What archive-and-purge keeps, what it destroys, and how "older than N cycles" is computed.**

*Ordering.* Instances sorted by `createdAt` descending. The newest `RETENTION_CYCLES` are retained; everything past that rank is a purge candidate. The **cutoff date** is the `createdAt` of the oldest retained instance. With fewer than `RETENTION_CYCLES` instances there are no candidates and no cutoff.

*An already-archived instance is never a candidate, and a second purge is refused outright.* Both, because either alone is a trap. Rank is computed over `createdAt`, so a purged instance re-enters the candidate list as soon as enough newer cycles exist; a second purge would then recompute `buildArchiveSummary` against the `Applicant.data` the first purge emptied and overwrite a correct frozen summary with zeros — silently, since every row it reads is legitimately present and legitimately empty. So `retentionCandidates` refuses candidacy for any instance with `archivedAt` set, **and** the purge action re-reads `archivedAt` inside its own transaction and refuses rather than trusting the list that sent it there. The candidate list is a UI affordance; it is not a safety mechanism, and the one irreversible action in this slice does not get to depend on one.

*Purged.* `Applicant.email` → null; `Applicant.data` → `{}`; `Applicant.displayName` → `Applicant <sourceRowIndex>` (the anonymous label written reviewers already see, so the column stays non-null and stays meaningful). `ImportRow` and `InterviewImportRow` rows are deleted outright — their `cells` hold the verbatim CSV, which is every essay, every address and every demographic answer in its rawest form. `ReviewNote` and `InterviewNotes` deleted. This instance's `AuditLog.previousValue` → null, since §8 already says those payloads can carry applicant data.

**`RoundAccessCode` rows are deleted.** Rows rather than the column, because `codeHash` is non-null (`schema.prisma:401`) and making it nullable would be a schema change to describe a state only the purge produces. There is no reason to keep them: the only code path that reads `codeHash` is `signInReviewer`, and an archived cycle has nothing for a reviewer to do. Keeping them would leave a live credential to a purged cycle with no route that reads it — the opposite of what a retention pass is for. This does not disturb the FR-20 round trip, which compares row sets rather than requiring a fixed row count.

*Kept.* Every score, vote, decision, assignment, pass and resolution — they are numbers and outcomes, and they are the substrate the aggregates rest on. `Field` and `FieldGroup` keep their header text: that is the club's own form, not an applicant's answer. `Reviewer` names are kept — §8 names essays, emails and demographics, and reviewers are club members, not applicants. **`Instance.passwordHash` is kept, and unlike the access codes it has a live reader**: the archive summary page sits behind `requireInstance`, so opening an archived cycle still means typing its password.

*The aggregates are materialized before the purge, not computed after it.* FR-19's demographic funnel is computed from `Applicant.data`, which the purge empties — so a purge that did not first freeze the funnel would destroy the "aggregate statistics" §8 says to retain. `buildArchiveSummary` renders the funnel and the stage counts into `Instance.archiveSummary` (new nullable JSON column) inside the same transaction as the purge, before anything is deleted.

*An archived instance is read-only, on **both** gates.* Its live screens would render empty essays and blank names against real-looking scores, which reads as data loss rather than as retention. `requireInstance` learns the check and redirects to a new archive summary page; only that page, the settings page and the FR-20 export remain reachable. **`requireReviewer` learns it too** — the reviewer gate in `lib/reviewer-auth.ts` never passes through `requireInstance`, so the admin-side redirect does not cover it, and a reviewer holding a cookie issued before the purge would otherwise reach a dashboard of blanked applicants. Deleting the access codes closes new sign-ins; this closes the sessions already outstanding.

*Orphaned audit rows.* §8 requires the instance-deletion records — `instanceId = null` by design — be aged out on the same threshold. They belong to no cycle, so cycle rank cannot apply: rows with `createdAt` older than the cutoff date defined above are deleted. Lockout rows from decision 92 age out by the same rule.

**96 — Not every table belongs to an instance, and the export manifest says which.**
`lib/export.ts` gains `NON_INSTANCE_TABLES`, an explicit list with a stated reason per entry, and `lib/export.test.ts:92` compares the client's models against `EXPORT_TABLE_NAMES ∪ NON_INSTANCE_TABLES`. `RateLimitBucket` is the first entry: it is keyed by client address, belongs to the deployment rather than to any cycle, and a restore that recreated one deployment's lockouts inside another's database would be nonsense. The guarantee the test was written for is unchanged — a new table still fails `npm run verify` until someone decides, in writing, which side of the line it is on.

**97 — The demo material is a small generated CSV plus one completed reference instance.**
`npm run seed:demo` writes `prisma/fixtures/demo-cycle.csv` (25 rows, generated from the existing `prisma/seed/corpus.ts` and `prisma/seed/applicants.ts` under a fixed RNG seed, against the real 37-column header row) and seeds one instance carried all the way to `COMPLETE`. The trainee creates their own cycle by importing the CSV, which is what makes the gate a test of the whole cycle including FR-1 through FR-5; the completed instance is the reference they compare against when a screen does not look like the guide says it should. Twenty-five applicants rather than 150 because a mock cycle at production scale is not clickable in one sitting, and a trainee who shortcuts the scoring is not testing the documentation. **No second synthetic dataset**: same corpus, same generators, different count and different instance id.

---

## Slices

Each is a commit. `npm run verify` before each; `npm run check:round-trip` and the affected `prisma/checks/*` scripts after each migration; **restart `next dev` after every `prisma generate` or `prisma migrate`** (CLAUDE.md — this cost a phase-3 misdiagnosis and three of these slices touch the schema).

### Slice 0 — Decision 17, fixture consolidation *(approved separately, 2026-08-30)*

Called out separately per the brief rather than folded in, and approved on its own. The argument for doing it **now, first**: this phase adds `prisma/fixtures/demo-cycle.csv`, a fourth committed fixture. Adding a file to a two-directory arrangement that decision 17 already calls a hazard makes the hazard bigger and makes the consolidation more work later. It touches `prisma/seed/headers.ts`, which every seed path runs through, so per CLAUDE.md it is its own commit carrying no feature work.

Move `fixtures/sample-headers.csv` → `prisma/fixtures/sample-headers.csv`; update `prisma/seed/headers.ts:56`, `.gitattributes`, `.gitignore` (both the exemption line and the comment block), and `plans/phase-0.md`'s record. Delete the now-empty root `fixtures/`.

While there, one unrelated correction found during planning: `prisma/fixtures/README.md` claims `.gitignore` carries `!prisma/fixtures/*.csv`. It does not, and deliberately does not — the real file names each fixture exactly, with a comment explaining that the glob would re-include a real export saved in that directory. The README describes the hole the `.gitignore` was written to close.

**If this slice is declined**, the demo CSV goes into `prisma/fixtures/` with its own exact `.gitignore` line and decision 17 stays open.

### Slice 1 — Decisions 92–97 into PRD §10

Text only. No code. This is the artifact the next reader trusts, and every slice below is written against it.

### Slice 2 — Rate limiting on Postgres (decision 92)

**Migration.** `RateLimitBucket`: `key String @id`, `failures Int`, `windowStartedAt DateTime`, `lockedUntil DateTime?`, `lockoutCount Int @default(0)`, `updatedAt DateTime @updatedAt`. Generated via `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, hand-finished, applied with `migrate deploy` (CLAUDE.md — `migrate dev` does not run here).

**`lib/rate-limit.ts`** stays pure and keeps `PASSWORD_ATTEMPT_POLICY` unchanged. `createAttemptLimiter`'s closure-over-a-`Map` is replaced by two functions over a bucket record — `verdictFor(bucket, policy, at)` and `bucketAfterFailure(bucket, policy, at)` — preserving `spent`, the window rollover, and the deliberate no-lock-extension rule with its comment intact. `lib/rate-limit.test.ts` is rewritten against the new signatures **case for case**: the nine existing cases are the spec and none of them may disappear in the refactor.

**`lib/rate-limit-store.ts`** (new, `server-only`) holds `checkKey`, `recordFailure`, `resetKey`, `pruneSpent`. Each wraps a `$transaction` that locks the bucket row first. `pruneSpent` runs on each successful sign-in and inside the archive purge, so the table stays small without a scheduled job.

**Wiring.** `lib/auth.ts` drops the module-level `limiter` and awaits the store in `signInAsAdmin` and `unlockInstance`; `lib/reviewer-auth.ts` follows, keeping its existing `reviewer:<instance>:<round>` key shape. `attemptKey` is unchanged — its `unknown` fallback is deliberate and stays. The limiter is still consulted **before** the argon2 verify in all three gates.

**Lockout audit rows.** A transition into lockout writes one `AuditLog` row: `action = "RATE_LIMIT_LOCKOUT"`, `actor = "system"`, `actorName = null`, `entityType = "RateLimitKey"`, `entityId = <key>`, `previousValue = { failures, lockoutCount }`, `instanceId` set for the instance and reviewer scopes and null for the app gate.

**`lib/export.ts`** gains `NON_INSTANCE_TABLES` with `RateLimitBucket` as its first entry; `lib/export.test.ts:92` compares against the union (decision 96).

**New check: `prisma/checks/rate-limit.ts`.** Asserts against the database, in the house style: N concurrent `recordFailure` calls on one key produce exactly N failures (this is the whole point of the row lock and cannot be unit-tested); a locked key is refused without a password check; the lock does not extend under continued attempts; `pruneSpent` removes a spent bucket and leaves a live one. Cleans up every row it creates and verifies it did.

### Slice 3 — Admin identity (decisions 16, 93)

**Migration.** `AuditLog.actorName String?`. One column.

**Session.** `SessionPayload` gains `nm: string`; `decodeSession` validates it as a non-empty string and `newSession` takes it. Existing cookies lack the field and will decode as null — every admin signs in again once, which is correct, since the point is to collect the name. `lib/signed-token.ts` is untouched.

**Sign-in.** `app/login/login-form.tsx` gains first-name and last-name fields above the password; `app/login/actions.ts` validates both non-empty and passes them to `signInAsAdmin`. The name is **not** a credential and is not checked against anything — decision 16 says so, and the guide will say so too: it is a signature, not a login.

**Threading.** A single `lib/audit.ts` helper — `auditActor(session)` returning `{ actor: "admin", actorName }` — spread into all twenty `auditLog.create` calls, rather than twenty hand-written literals. Every one of those actions already calls `requireAdmin`/`requireInstance` and so already holds the session; none needs a new query.

**Read surface.** New `app/instances/[id]/audit/page.tsx` behind **`requireInstance`**, not `requireAdmin` — a deliberate departure from the settings page beside it. `previousValue` payloads can carry applicant data (§8 says so in as many words), and the settings page is reachable by someone holding only the shared app password who has never unlocked this cycle. Columns: when, who (`actorName`, falling back to `actor` for pre-phase-8 rows), action, entity type and id, with `previousValue` in a collapsed `<details>`. Newest first, paginated. Linked from the instance hub and from settings.

**`lib/export.ts`** manifest gains `actorName` on the `AuditLog` entry.

### Slice 4 — Archive and purge (decisions 94, 95)

**Migration.** `Instance.archiveSummary Json?`. `archivedAt` already exists. Manifest and `NULLABLE_JSON_COLUMNS` in `lib/export.ts` updated.

**`lib/archive.ts`** — pure, no Prisma, on the same terms as `lib/funnel.ts` and `lib/passes.ts`:
- `retentionCandidates(instances, retentionCycles)` → `{ retained, candidates, alreadyArchived, cutoff }`. This is where the off-by-one lives, so it is where the tests are: exactly `RETENTION_CYCLES` instances yields zero candidates; `N+1` yields one; ties on `createdAt` broken by id so the split is deterministic; `retentionCycles = 0` refused rather than obeyed. **An instance with `archivedAt` set is never a candidate** — it comes back in `alreadyArchived` instead, so the screen can show it as done rather than omitting it. It still occupies its rank and still counts toward the cutoff, because it is a real cycle and dropping it from the ordering would pull an older live cycle into candidacy a purge earlier than its age warrants. Tested directly: an archived instance surrounded by enough newer ones does not reappear as a candidate.
- `buildArchiveSummary(input)` → the frozen JSON. Reuses `buildFunnel` from `lib/funnel.ts` and `demographicColumns` / `applicantDemographics` from `lib/demographics.ts` — §10.7 requires the checked predicate and the 1/n weighting live in exactly one place, and a summary that recomputed them would be the second copy that rule exists to prevent. Carries a `summaryVersion`, stage counts, the rendered funnel, reviewer and rubric structure, and `generatedAt`.
- `purgePlan()` → the table-by-table statement of what is nulled and what is deleted, as data rather than as prose buried in an action, so slice 4's check can assert against the same list the purge executes.

**`lib/archive-io.ts`** (new, `server-only`) — the Prisma half, mirroring the `lib/export.ts` / `lib/instance-io.ts` split. One transaction: **re-read `archivedAt` and abort if it is set** → read what the summary needs → build it → write `archiveSummary` and `archivedAt` → null and delete per the plan, `RoundAccessCode` rows included → prune spent rate-limit buckets → delete orphaned `AuditLog` rows older than the cutoff → write the `ARCHIVE_AND_PURGE` audit row **last**, so it survives the `previousValue` nulling that precedes it. Its `previousValue` carries row counts only, never content.

The `archivedAt` re-read is inside the transaction, not before it: two admins on the archive screen at once, or one double-submitting, are the ordinary way a second purge happens, and a check outside the transaction loses that race. The refusal is a returned error the screen renders, not a thrown exception — a second purge is a normal thing to attempt, not a fault.

**Surface.** New `app/archive/page.tsx` behind `requireAdmin` — cross-instance by nature, so it does not live under `/instances/[id]`. Lists every instance by age with its rank, states the threshold and where it is set, marks candidates, and shows what a purge will destroy. Each purge is confirmed by typing the instance name, mirroring `deleteInstance`. `requireAdmin` alone matches FR-5's precedent for deletion, and purge is the strictly less destructive of the two.

**Read-only enforcement.** `requireInstance` gains the archived check and redirects to a new `app/instances/[id]/archive/page.tsx` rendering the frozen summary; settings and the FR-20 export stay reachable. `requireReviewer` and `signInReviewer` in `lib/reviewer-auth.ts` gain the same check independently, per decision 95 — they are a separate gate on a separate cookie and the admin-side redirect does not reach them. A reviewer on an archived cycle gets a plain "this cycle is closed" page rather than the sign-in form, since there is no code left that would let them in.

**New check: `prisma/checks/archive-purge.ts`.** The real test of §8's retention rule, and it must run against a database. Seed a throwaway instance, snapshot its funnel, purge it, then assert: zero applicants with a non-null email; zero with a non-empty `data`; zero `ImportRow`, `InterviewImportRow`, `ReviewNote`, `InterviewNotes`, `RoundAccessCode` rows; zero `AuditLog` rows with a non-null `previousValue`; every score, vote and decision count unchanged; and **the frozen summary reproduces the pre-purge funnel cell for cell**.

Then the second-purge case, which is the one that would otherwise destroy data quietly: **call the purge again on the same instance and assert it is refused** — no new `ARCHIVE_AND_PURGE` audit row, `archivedAt` unchanged, and `archiveSummary` still byte-identical to what the first run wrote. That last assertion is the one that matters; a refusal that still overwrote the summary would look like a pass under the first two.

Finally, confirm the FR-20 export of the purged instance still parses and still round-trips.

### Slice 5 — Demo instance and demo CSV (decision 97)

`prisma/demo.ts` + `npm run seed:demo`, reusing the existing generators throughout.

**The CSV.** 25 profiles from `buildApplicantProfiles` under a fixed seed, written against `readSourceHeaders()` (the real 37-column header row) using `toCsv` and `csvCell` from `lib/export-csv.ts` — the RFC 4180 writer already exists and already has tests, so the demo file does not get a hand-rolled second one. Same safety properties as the existing fixtures: `example.com` addresses, every free-text cell prefixed `SYNTHETIC`. Committed, with its own exact `.gitignore` line (or in the consolidated location, if slice 0 is approved).

**The reference instance.** `SEED_INSTANCE_ID` in `prisma/seed/client.ts:20` becomes `process.env.SEED_INSTANCE_ID ?? "seed_s26_demo"`, with the instance name and password overridable the same way. That is a one-line change to one file, and it is what lets `seed:demo` drive `seed.ts` → `advance.ts` → `passes.ts` under a second identity without threading a parameter through the roughly hundred references across the seed scripts and all seven check scripts. **Documented consequence:** `prisma/checks/*` follow the same variable, so they can be pointed at the demo instance too — useful, but it means an unset variable is what keeps them pointed at the development seed.

### Slice 6 — The three documents

Root-level, alongside `PRD.md` and `BUILD_PLAN.md`. Screenshots in `docs/img/`, captured from `next dev` against the demo instance with Chrome tooling — **only the demo instance, so every pixel is synthetic**, which is the same rule the fixtures follow and the reason the demo instance is built before the docs.

- **`ARCHITECTURE.md`** — for the next developer. The stack and why. The four non-negotiables from CLAUDE.md, with the reasoning, not just the rule. The `lib/` pure-versus-Prisma split and which files are on which side. The migration flow, including why `migrate dev` does not run here. The seed, advance, passes and check scripts and when to run each. Environment variables, `RETENTION_CYCLES` among them. One route-map diagram; no screenshots.
- **`ADMIN_GUIDE.md`** — the gate document, and the one that gets written last and hardest. A numbered walkthrough of one full cycle against `demo-cycle.csv`: create the cycle, upload, map fields, resolve the duplicates the file contains on purpose, set the rubric, paste the roster, assign, share the access code, watch the results, close the written round, import interviews, run the passes, publish, export. A screenshot per screen. **No jargon**: no `FR-` numbers, no table names, no "server action". The words on the screen are the words in the guide.
- **`REVIEWER_GUIDE.md`** — one page, phone screenshots, for pasting into Slack next to the access code. How to get in, how to score, what the note is for, and how to flag a conflict of interest. Nothing about instances, rounds-as-a-concept, or anything a reviewer never sees.

`README.md`'s status paragraph is updated in the same commit — it still says first and second rounds are unbuilt, which has been wrong since Phase 6.

### Slice 7 — The gate

Hand `ADMIN_GUIDE.md` and a running deployment to a board member who has not used the tool. They run a complete mock cycle on the demo CSV, unaided. Every place they stop is a documentation bug and gets fixed in `ADMIN_GUIDE.md` — not explained to them verbally, which would fix the run and not the document. Record what they hit in `plans/phase-8.md` under a "what the gate found" heading, as Phases 3 and 7 did.

---

## Verification

**Per slice:** `npm run verify` (typecheck, lint, test).

**After each of the three migrations:** restart `next dev`; `npm run check:round-trip`; re-run `prisma/checks/unique-constraints.ts`, `field-groups.ts`, `passes.ts`, `claim-race.ts`, `interview-import.ts` and `reconciliation-fixture.ts` by hand — they need a seeded database and write to it, so they are not in `npm run verify` and CLAUDE.md requires them after any schema change.

**New checks, run in the slice that adds them and again at the end:** `prisma/checks/rate-limit.ts`, `prisma/checks/archive-purge.ts`.

**Slice 2, by hand:** ten wrong admin passwords in one browser locks the gate; the same key stays locked from a *second* process — the assertion the in-memory limiter could never make and the whole reason for the table; a correct password after the lockout expires clears the bucket; a `RATE_LIMIT_LOCKOUT` audit row exists with the right `instanceId` for each of the three scopes.

**Slice 3, by hand:** sign in with a name, perform a manual assignment override, confirm the name appears on the audit page; confirm a pre-phase-8 row still renders with no name and does not crash; confirm the audit page redirects to `/unlock` for an admin who has not opened that instance.

**Slice 4, by hand:** with `RETENTION_CYCLES=2` and three instances, exactly the oldest is a candidate; purge it and confirm the funnel on its archive page matches what FR-19 showed beforehand; confirm every live admin route on it redirects to the archive page and that a reviewer cookie issued before the purge lands on the closed-cycle page rather than a dashboard of blanked applicants; confirm an orphaned instance-deletion audit row older than the cutoff is gone and a newer one is not. Then create two more instances so the purged one falls back into purge range, and confirm the archive screen still shows it as archived rather than as a candidate.

**Slice 5:** `npm run seed:demo` from an empty database, then `npm run seed` after it, and confirm the two instances coexist and neither deletes the other's rows.

**The gate is slice 7 and nothing above substitutes for it.**

---

## Risks

**This is the largest phase since 2.** Three migrations, one refactor of a security-critical module, a new destructive admin action, and three documents. BUILD_PLAN estimates a day; the documents alone are most of one. Slices 2, 3 and 4 are independent of each other and can each be gated separately — if time runs short, slice 4 is the one to defer, because retention is the only item here with no cycle running against it yet.

**The purge is irreversible and has no undo.** It is the second such action in the product, after `deleteInstance`. The mitigations are the typed-name confirmation, the FR-20 export as the escape hatch (`ARCHIVE_AND_PURGE`'s guide entry will say to export first), and `prisma/checks/archive-purge.ts` asserting on a throwaway instance rather than a real one.

**The rate-limit refactor touches all three authentication gates.** The nine existing test cases are the specification and carry forward unchanged; the new check covers the one property they cannot reach, which is the concurrency the shared store exists to provide.

---

## What writing the guide found

Slice 6's walkthrough is the Phase 8 gate rehearsed by the author. Everything
below was found by clicking a screen, not by a test, which is the whole argument
for the gate existing.

**The demo fixture fragmented the Ethnicity group.** At 25 rows the seed's
weighted ethnicity picker left `Central Asian` and `Native Hawaiian/Pacific
Islander` checked by nobody, and an entirely empty column has no value signature
for FR-2's group detection to recognise. The ten one-hot columns were therefore
offered as **three** separate groups split around the empty ones. The detector is
correct — `prisma/fixtures/README.md` documents that trap deliberately for
`s26-shape.csv` — but a trainee following the guide would have created three
"Ethnicity" groups, and §10.7's 1/n weighting has to run over one group of ten or
every demographic number in FR-11 and FR-19 is wrong. Fixed in `prisma/demo.ts`
with a deterministic coverage pass; all ten columns now carry at least one check.

**The preview caught a real mistake mid-walkthrough.** The whole mapping was set
up without a single column categorised as a Response, and the preview said so:
*"No column is categorised as a Response. Written reviewers see only Response
fields, so every profile in the written round will be empty."* Every column
defaults to Other and the tool never guesses from header text (deliberately —
guessing is how a demographic column becomes visible to reviewers), so a trainee
will hit this too. It is now step 3's worked example, quoted verbatim.

**The ethnicity write-in joins its group as `option (counted)`.** It has to be
set to `write-in (not counted)` by hand, and the tool cannot detect the column at
all because its values differ per person. Left as an option, one applicant's
typed answer becomes its own category in every breakdown for the rest of the
cycle. A trainee would miss this without being told; it is now called out in step
2 with the consequence spelled out.

### Open, not fixed

- **Typo on the mapping screen.** The "Before you can commit" banner reads
  *"1 detected group still need naming or dismissing"* — should be **needs**.
  Grammatical only, wrong only in the singular case. Deliberately left alone
  rather than changing app copy in the middle of a documentation pass; worth one
  commit of its own.

- **`REVIEWER_GUIDE.md`'s first- and second-round sections are unverified against
  a running screen.** The written-round half was driven live and screenshotted;
  the two later rounds were written from the code. Confirming them needs an
  instance at `SECOND_ROUND` with an **open** pass, and none is in that state:
  both seeded cycles are `COMPLETE` with their passes closed, and a closed second
  round cannot be reopened. The practice cycle is at `FIRST_ROUND` with all eight
  reviewers staffed to the written round only, and the FR-12 interview fixtures
  cannot bridge the gap because they reference the seed's pinned applicants, who
  do not exist in a cycle imported from `demo-cycle.csv`.

  Two ways to close it, for slice 7 or later: advance the practice cycle through
  the first round properly, or run `npm run seed` then `npm run seed:advance`
  WITHOUT `seed:passes` against a throwaway instance id, which lands exactly
  where an admin creates pass 1. Either way the reviewer sign-in needs a round
  access code typed by a person.
