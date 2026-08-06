# CLAUDE.md

Context for Claude Code working in this repository. Read `PRD.md` before implementing any feature.

## What this is

An applicant management platform for Spark SC, USC's student entrepreneurship organization. It replaces a 36-sheet Excel workbook used to run a three-round recruitment cycle: written application review, first-round interviews, second-round group deliberation.

Scale: ~150 applicants, ~30 reviewers, one cycle per semester. This is not a high-traffic system. Optimize for clarity and for the next maintainer, not for performance.

## Non-negotiable rules

1. **Never key applicant records by name.** Every score, vote, note, and decision references `applicantId`. Name matching happens only at import boundaries, and only through the reconciliation flow in PRD FR-13. This is the core defect of the system being replaced.

2. **Field visibility is enforced server-side.** See PRD §6. A reviewer request for a hidden field returns no data. Never fetch everything and hide it in the client.

3. **Real applicant data never enters the repo.** `.gitignore` covers `*.csv`, `*.xlsx`, `/data`, `/uploads`. Development uses `prisma/seed.ts` synthetic data. The real data includes essays about family trauma, immigration status, self-reported ethnicity, and first-generation status.

4. **Passwords are hashed with argon2id.** Never logged, never returned in an API response, never displayed.

5. **The reviewer dashboard is used once, on a phone, by someone who has never seen it.** Every additional tap is a review that does not get completed. When in doubt, remove a step.

## Architecture

- Next.js App Router, TypeScript, Tailwind + shadcn/ui
- Postgres via Prisma. Schema in `prisma/schema.prisma`, which is the source of truth for the data model
- Server actions for mutations, server components for data fetching
- `lib/assignment.ts` and `lib/passes.ts` contain pure functions with no database access. Keep them that way; they are the two pieces with real logic and they are tested in isolation.

## Domain vocabulary

- **Instance** — one recruitment cycle. Has a name and a password.
- **Sparklet** — an existing Spark SC member. Reviewers can be Sparklets. Constraint: at most one Sparklet reviews any given applicant.
- **Unassigned pool** — ~5% of applicants held with no reviewers, so reviewers hitting a conflict of interest can swap out and others can pick up slack.
- **Pass** — a second-round voting session. Sequential. Membership fixed at creation to applicants still ACTIVE. Unanimous yes makes a Sparklet, unanimous no rejects, mixed carries forward.
- **Round** — WRITTEN, FIRST_ROUND, SECOND_ROUND. Distinct reviewer rosters and distinct field visibility per round.

## Working conventions

- Plan before implementing. Write the plan to `plans/phase-N.md` and wait for review.
- Build vertical slices that can be clicked through, not horizontal layers.
- Small commits with real messages.
- Run `npm run verify` (typecheck, lint, test) before declaring a phase done.
- Ask rather than assume when the PRD is ambiguous. PRD §10 lists known open decisions; if you hit a new one, add it there rather than picking silently.

## Testing

Two things carry real logic and get real tests:

- **`lib/assignment.ts`** — 3 reviewers per applicant, at most 1 Sparklet each, even load, 5% pool, and a feasibility precheck that fails loudly when the Sparklet ratio makes the constraints unsatisfiable.
- **`lib/passes.ts`** — the resolution state machine, including the COI-as-skip rule and the all-COI case, which must flag for admin rather than auto-resolve.

Test cases for both are enumerated in `BUILD_PLAN.md` phases 2 and 6. Those cases are the spec. If a test contradicts them, the test is wrong.

Everything else gets light smoke coverage. Do not chase coverage percentage.
