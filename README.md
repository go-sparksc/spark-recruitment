# Spark SC Recruitment Platform

Applicant review and selection for [Spark SC](https://sparksc.org), USC's oldest student
entrepreneurship organization. Replaces the 36-sheet Excel workbook that ran our previous
recruitment cycles, where applicant identity was keyed by name across eight separate
sheets and a single typo could silently orphan a record.

Handles three rounds: written review, first-round interviews, and second-round
deliberation via sequential voting passes. Roughly 150 applicants and 30 reviewers per
cycle.

**Status:** in development. The written round is complete and gate-verified end to end:
CSV import and field mapping, reviewer assignment, a phone-first scoring dashboard for
thirty reviewers, and a ranked results and selection view for admins. First-round
interviews and second-round deliberation are not yet built.

**[PRD.md](PRD.md)** has the full specification, including the permissions model and the
open decisions left to the club rather than resolved unilaterally. **[BUILD_PLAN.md](BUILD_PLAN.md)**
has the phased execution plan.

No real applicant data lives in this repository. Development runs against a deterministic
synthetic seed of 150 generated applicants that reproduces the structural quirks of the
real export, including realistic score distributions across reviewers.

Next.js, TypeScript, Postgres via Prisma, deployed on Vercel.
