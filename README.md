# Spark SC Recruitment Platform

Applicant review and selection for [Spark SC](https://sparksc.org), USC's oldest student
entrepreneurship organization. Replaces the 36-sheet Excel workbook that ran our previous
recruitment cycles, where applicant identity was keyed by name across eight separate
sheets and a single typo could silently orphan a record.

Handles three rounds: written review, first-round interviews, and second-round
deliberation via sequential voting passes. 160+ applicants and roughly 30 reviewers per
cycle.

**Status:** feature-complete and gate-verified end to end. All three rounds are built —
CSV import and field mapping, reviewer assignment, a phone-first scoring dashboard,
first-round interview import and voting, second-round deliberation by sequential passes,
the final class with its demographic funnel, and a full JSON export whose round trip is
verified by deleting the database and restoring from the file alone. The hardening pass
is in as well: sign-in rate limiting shared across processes, a name behind every audit
row, and archive-and-purge, which freezes a finished cycle's aggregate statistics and
then destroys its essays, emails and demographics. What remains is the succession gate —
a board member who has never used the tool running a complete mock cycle from
`ADMIN_GUIDE.md` alone — which has not been run yet.

**Documentation:** **[ADMIN_GUIDE.md](ADMIN_GUIDE.md)** walks one complete cycle, screen
by screen, for whoever is running applications this semester. **[REVIEWER_GUIDE.md](REVIEWER_GUIDE.md)**
is the one-page version to paste into Slack alongside the access code.
**[ARCHITECTURE.md](ARCHITECTURE.md)** is for the next person to maintain the code.

**[PRD.md](PRD.md)** has the full specification, including the permissions model and the
97 numbered decisions recording what was chosen and why. **[BUILD_PLAN.md](BUILD_PLAN.md)**
has the phased execution plan, and **[plans/](plans/)** is the design history, one file
per phase, including what each gate found.

No real applicant data lives in this repository. Development runs against a deterministic
synthetic seed of 150 generated applicants that reproduces the structural quirks of the
real export, including realistic score distributions across reviewers. `npm run seed:demo`
adds a 25-applicant training file and a finished cycle to practise against, so a new admin
can click through a complete cycle without touching anything real.

Next.js, TypeScript, Postgres via Prisma, deployed on Vercel.
