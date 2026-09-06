# Architecture

For the next person to maintain this. Read `PRD.md` for *what* it does and why;
this is *how it is built* and what will bite you.

`CLAUDE.md` is the working-conventions file and overlaps this one deliberately —
it is loaded automatically by Claude Code, this is for a human.

---

## The one-paragraph version

A Next.js App Router application over a Postgres database, deployed on Vercel,
running one recruitment cycle at a time for 160+ applicants and about 30
reviewers. There is no external auth provider, no queue, no cache, and no
background jobs. Server components read; server actions write. The interesting
code is not the plumbing — it is the eight or so pure modules in `lib/` that hold
the actual rules.

---

## Stack, and why each piece

| Layer | Choice | Why this one |
|---|---|---|
| Framework | Next.js (App Router) + TypeScript | Server components let field visibility be enforced on the server, which PRD §6 requires. One deployable unit. |
| Database | Postgres | JSONB for `Applicant.data`, and real constraints for the uniqueness rules that keep votes clean. |
| ORM | Prisma | The schema file doubles as documentation, and migrations are legible to whoever inherits this. |
| Styling | Tailwind + shadcn/ui | The reviewer dashboard has to work on a phone with no training. Do not hand-roll a design system. |
| Auth | Custom, six small modules | Two shared passwords and a signed HMAC cookie, with no provider, no session table and no user table. PRD §8 asks for exactly this. |
| Testing | Vitest | Four algorithms carry real logic and get real tests. |

**Hosting and the database should be under a club-owned account, not a personal
one.** This is the highest-leverage succession decision and it takes ten minutes
on day one. Retrofitting it after you graduate is painful.

---

## Four rules that are not style preferences

Breaking any of these produces a system that looks fine and is wrong.

**1. Never key applicant records by name.** Every score, vote, note and decision
references `applicantId`. Name matching happens only at import boundaries, and
only through the FR-13 reconciliation cascade in `lib/reconciliation.ts`. This is
the core defect of the 36-sheet workbook this replaced: a typo silently orphaned
a record and nobody could tell.

**2. Field visibility is enforced server-side.** PRD §6. A reviewer request for a
hidden field returns no data — it is not fetched and hidden in the client.
`lib/fields.ts` has the single resolver; every surface routes through it.

**3. Real applicant data never enters the repository.** `.gitignore` covers
`*.csv`, `*.xlsx`, `/data`, `/uploads`, with each legitimate fixture exempted **by
exact name** rather than by a directory glob — a glob would re-include a real
export dropped in that directory. Development runs on `prisma/seed.ts`. The real
export contains essays about family trauma and immigration status, self-reported
ethnicity, and first-generation status.

**4. Passwords are hashed with argon2id.** Never logged, never displayed, never
returned by an API — except FR-20's instance export (decision 86), which is
admin-only and treated as a sensitive file for exactly that reason.

---

## Where the logic lives

The split that matters: **anything decidable without a database is in a pure
module, so it can be tested without one.** The Prisma half is deliberately thin.

```
lib/
  assignment.ts     3 reviewers per applicant, ≤1 Sparklet, even load, 5% pool
  passes.ts         second-round resolution state machine
  reconciliation.ts FR-13's four-tier name-matching cascade
  roster.ts         FR-6 paste parsing
  fields.ts         §6 visibility resolution — the single source
  demographics.ts   §10.7's checked predicate and 1/n weighting
  funnel.ts         FR-19's breakdown, built on demographics.ts
  export.ts         what "the entire instance" and "intact" mean
  archive.ts        retention split, frozen summary, purge plan
  rate-limit.ts     attempt-counter state machine
  session.ts        cookie payload shape and expiry

  ...and their database halves, which hold queries and nothing else:
  instance-io.ts    ← export.ts
  archive-io.ts     ← archive.ts
  rate-limit-store.ts ← rate-limit.ts
  auth.ts / reviewer-auth.ts ← session.ts / reviewer-session.ts
```

The `-io` modules carry `import "server-only"`, which makes them unimportable
from a plain `tsx` script. Run anything that needs them with
`tsx --conditions=react-server` — the npm scripts already do.

**When a page transforms query results before rendering them, that
transformation belongs in `lib/`.** Twice in Phase 5 a page assembled correct
pure functions incorrectly and no suite could see it. `lib/first-round.ts` is the
worked example.

---

## Routes

```
/                             instance list          app password
/login                        sign in                — (name + app password)
/archive                      retention              app password

/instances/new                create a cycle         app password
/instances/[id]               the hub                instance password
  /mapping /preview           FR-2, FR-3 import
  /rubric /interview-rubric   FR-4, FR-12a
  /reviewers /assignments     FR-6 – FR-8
  /results /first-round-results  FR-10, FR-15
  /interviews                 FR-12 import
  /passes                     FR-17, FR-18
  /final                      FR-19
  /export                     FR-20                  ← reachable when archived
  /audit                      §8 activity log        ← reachable when archived
  /archive                    frozen summary         ← the archived redirect target
  /settings                   password reset, delete  app password ONLY
  /unlock                     instance password prompt

/r/[instanceId]               reviewer sign-in       round access code
  /list /a/[assignmentId]     written round
  /first-round/[applicantId]  first round
  /second-round/[applicantId] second round
  /pool                       claim an open slot
  /closed                     shown when the cycle is archived
```

**`/settings` gates on the app password alone, deliberately.** FR-5 makes an
instance password unrecoverable, so if deletion and reset also sat behind it, a
typo'd password at creation would leave a permanently unreachable row holding
real applicant data.

---

## Things that will bite you

**`prisma migrate dev` does not run here.** It refuses in a non-interactive
shell. The flow is:

```bash
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
# hand-finish the SQL: CHECK constraints, partial indexes, and a comment
# explaining WHY, then save as prisma/migrations/<timestamp>_<name>/migration.sql
npx prisma migrate deploy
npx prisma generate
```

Prisma 7 renamed the diff flags; `--from-schema-datasource` is gone.

**Restart `next dev` after any `prisma generate` or `prisma migrate`.** The
generated client is rewritten on disk, but a running dev server keeps the old one
in memory — so it serves a client that does not know the column you just added
and fails at runtime with `Unknown field 'x'`. **`npm run verify` passes
completely while this is happening**, because it reads the new client from disk.
This cost a full round of misdiagnosis in Phase 3.

Two corollaries. *Check the route that is actually failing*, not a neighbour: a
200 from a page that avoids the new column proves nothing. And *read the dev
server log before theorising* — the untruncated Prisma error names the exact
field.

**Connection URLs live in `prisma.config.ts`, not in the schema** (Prisma 7). The
client is generated to `generated/prisma` (gitignored) and imported from
`@/generated/prisma/client`.

**There is no formatter.** Prettier is not a dependency and `npx prettier --write`
on a tracked file installs it on the fly and reflows the whole file — in Phase 6
that turned a 60-line change into a 368-line diff. Fix indentation by hand.

---

## Scripts

```bash
npm run dev                  # next dev
npm run verify               # typecheck + lint + test — run before every commit
npm run hash-secret -- "pw"  # generate ADMIN_PASSWORD_HASH and SESSION_SECRET

npm run seed                 # 158 applicants at WRITTEN, written round finalized
npm run seed:advance         # → through the first round into SECOND_ROUND
npm run seed:passes          # → a complete second round, instance COMPLETE
npm run seed:inspect         # verify the field catalog and JSONB resolution
npm run seed:demo            # the training CSV + a finished reference cycle
```

The three seed steps are separate on purpose: several checks are written against
the intermediate states, and a seed that always advanced would leave them passing
over a fixture they no longer describe.

### Constraint checks

`prisma/checks/` holds scripts that assert against **the database**, not the
Prisma client — a duplicate insert goes through raw SQL and must come back as
SQLSTATE 23505 naming the expected index, because Prisma can reject a duplicate
client-side without the statement ever reaching Postgres.

They are **not** part of `npm run verify` (they need a seeded database and they
write to it). **Re-run them by hand after any schema change.**

```bash
npm run check:round-trip     # FR-20: export, delete, restore, compare — destructive
npm run check:rate-limit     # the row lock, under real concurrency
npm run check:archive-purge  # §8 retention — destructive, DO NOT run on production
npx tsx prisma/checks/unique-constraints.ts
npx tsx prisma/checks/field-groups.ts
npx tsx prisma/checks/passes.ts
npx tsx prisma/checks/claim-race.ts
npx tsx prisma/checks/interview-import.ts
npx tsx prisma/checks/reconciliation-fixture.ts
```

Each cleans up what it creates and verifies that it did. `archive-purge` is the
exception worth knowing about: it runs a real purge, which ages out orphaned
audit rows **by date**, so its fixture dates are deliberately pinned to 2001. See
the incident note in `CLAUDE.md`.

---

## Environment

Copy `.env.example` to `.env`. The app refuses to start without the first three
rather than defaulting to open.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres. A pooled endpoint is fine for the app. |
| `ADMIN_PASSWORD_HASH` | argon2id. **Escape every `$` as `\$` in `.env`** — Next expands `$VAR`. Not escaped in a hosting dashboard. |
| `SESSION_SECRET` | Signs both cookies. There is no session table, so rotating this is how every session is revoked at once. |
| `RETENTION_CYCLES` | Optional, default 2. How many cycles `/archive` keeps in full. Deliberately not editable in-app — see decision 94. |
| `DIRECT_URL` | Only if `prisma migrate` fails against a pooled endpoint. |
| `DEV_ALLOWED_ORIGINS` | Local only, for testing the reviewer dashboard on a real phone. |

---

## Two things with no in-app reader

Both are deliberate, and both are the first place to look when something seems
missing.

**App-level rate-limit lockouts** write an `AuditLog` row with `instanceId =
null`. Instance and reviewer lockouts carry their instance and appear in that
cycle's activity log; the app-level gate has no instance, so those rows are
visible only by querying the database. Decision 92 states this rather than
hiding it — closing it would need an app-level security view no requirement asks
for.

**Orphaned instance-deletion records**, also `instanceId = null`, are what
survives a deleted cycle. Both classes age out when the next archive-and-purge
runs, on the same threshold as everything else.

---

## Where the reasoning is written down

- **`PRD.md` §10** — 97 numbered decisions, each recording what was chosen, what
  was rejected, and why. When something looks arbitrary, it is usually in here.
- **`plans/phase-N.md`** — the design history, one file per build phase,
  including what each gate found.
- **`BUILD_PLAN.md`** — the phased execution plan and its gates.
- **`CLAUDE.md`** — working conventions, plus a Security notes section recording
  two incidents that destroyed data during development.
