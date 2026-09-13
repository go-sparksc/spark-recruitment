# Spark SC Recruitment Platform

Applicant review and selection for [Spark SC](https://sparksc.org), USC's oldest student
entrepreneurship organization. Replaces the 36-sheet Excel workbook that ran our previous
recruitment cycles, where applicant identity was keyed by name across eight separate
sheets and a single typo could silently orphan a record.

Handles three rounds: written review, first-round interviews, and second-round
deliberation via sequential voting passes. 160+ applicants and roughly 30 reviewers per
cycle.

**Status:** complete — all nine build phases shipped and gated, the succession gate
closed, and Spark's first real cycle pending. CSV import
and field mapping, reviewer assignment, a phone-first scoring dashboard, first-round
interview import and voting, second-round deliberation by sequential passes, the final
class with its demographic funnel, and a full JSON export whose round trip is verified by
dropping the database and restoring from the file alone. Hardening is in as well:
sign-in rate limiting shared across processes and a name behind every audit row.

The most recent round of changes came from running the tool rather than from review — a
written rubric that states its criteria per point value, a suspected-AI flag on the
reviewer's score card, first-round voting moved onto the applicant's page, second-round
outcomes made visible to the room that voted, and demographic counts printed as
proportions of a stated pool. Those are PRD decisions 110–118, and both guides were
re-read against the running screens afterwards.

Finished cycles are kept in full and indefinitely — an earlier retention rule that purged
old ones was reversed, for the reasons in PRD decision 109, leaving FR-5's confirmed
per-instance deletion as the only way to remove a cycle.

The succession gate is closed. A board member who had never used the tool took a complete
mock cycle from `ADMIN_GUIDE.md` alone, and nothing pressing surfaced — no step left them
stuck and no documentation bug came out of the run. It was deliberately held until the
changes above had shipped. The one genuinely scarce resource here is a board member who
has never seen the tool, and spending it on screens that were about to change would have
tested documentation that was about to be rewritten. The record is in
[plans/phase-8.md](plans/phase-8.md).

Spark's first real cycle runs on the platform with one addition. Smaller improvements may
come up later and wait until after it, because the only run that exercises the tool under
real conditions is worth more than any refinement guessed at beforehand. The exception,
approved by the owner, is **class standing**, per PRD decision 119. It is derived from a
designated graduation-date column and a set-once semester chosen when the cycle is created,
and shown under the graduation date on every applicant view, with exactly that column's
visibility.

**Documentation:** **[ADMIN_GUIDE.md](ADMIN_GUIDE.md)** walks one complete cycle, screen
by screen, for whoever is running applications this semester. **[REVIEWER_GUIDE.md](REVIEWER_GUIDE.md)**
is the one-page version to paste into Slack alongside the access code.
**[ARCHITECTURE.md](ARCHITECTURE.md)** is for the next person to maintain the code.

**[PRD.md](PRD.md)** has the full specification, including the permissions model and the
119 numbered decisions recording what was chosen and why. **[BUILD_PLAN.md](BUILD_PLAN.md)**
has the phased execution plan, and **[plans/](plans/)** is the design history, one file
per phase, including what each gate found.

No real applicant data lives in this repository. Development runs against a deterministic
synthetic seed of 150 generated applicants that reproduces the structural quirks of the
real export, including realistic score distributions across reviewers. `npm run seed:demo`
adds a 25-applicant training file and a finished cycle to practise against, so a new admin
can click through a complete cycle without touching anything real.

Next.js, TypeScript, Postgres via Prisma. Deployed on Vercel, where the build command is
`prisma migrate deploy && next build` — so the deploy that needs a migration is the deploy
that applies it, and a migration that fails fails the build instead of shipping code to a
schema that cannot serve it.
