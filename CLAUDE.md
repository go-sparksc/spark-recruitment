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
- Postgres via Prisma. **PRD §5 is the source of truth for the data model**; `prisma/schema.prisma` is its implementation. If the schema needs to diverge, change §5 first and say why — a schema that has drifted ahead of the PRD is how the next maintainer ends up trusting the wrong document
- Prisma 7: connection URLs live in `prisma.config.ts`, not in the schema. The client is generated to `generated/prisma` (gitignored) and imported from `@/generated/prisma/client`
- Server actions for mutations, server components for data fetching
- `lib/assignment.ts`, `lib/passes.ts`, and `lib/roster.ts` contain pure functions with no database access. Keep them that way. The first two are the pieces with real logic; `lib/roster.ts` is the FR-6 paste parser, smaller but equally worth testing away from the database.

## Domain vocabulary

- **Instance** — one recruitment cycle. Has a name and a password.
- **Sparklet** — an existing Spark SC member. Reviewers can be Sparklets. Constraint: at most one Sparklet reviews any given applicant.
- **Field group** — several CSV columns forming one logical question, such as the ten one-hot ethnicity columns plus the free-text write-in. Category, inclusion, and field visibility are set on the group and apply to every member. The write-in is a member for display only and is excluded from demographic counting. See PRD §5 and §10.7.
- **Unassigned pool** — ~5% of assignment slots held open, spread across distinct applicants who each start with 2 reviewers instead of 3. Never whole applicants with zero reviewers. A reviewer hitting a conflict of interest returns their slot to the pool and any reviewer can claim an open slot. See PRD §10.1 and BUILD_PLAN Phase 2.
- **Pass** — a second-round voting session. Sequential. Membership fixed at creation to applicants still ACTIVE. Unanimous yes makes a Sparklet, unanimous no rejects, mixed carries forward.
- **Round** — WRITTEN, FIRST_ROUND, SECOND_ROUND. Distinct reviewer rosters and distinct field visibility per round.

## Working conventions

- Plan before implementing. Write the plan to `plans/phase-N.md` and wait for review.
- Build vertical slices that can be clicked through, not horizontal layers.
- Small commits with real messages.
- Run `npm run verify` (typecheck, lint, test) before declaring a phase done.
- Ask rather than assume when the PRD is ambiguous. PRD §10 lists known open decisions; if you hit a new one, add it there rather than picking silently.
- **One command per shell call.** Do not chain a file write, a test run, and a restore into one invocation. When a chain half-succeeds you cannot tell which half, and a `cp` restore tacked onto the end of a failing command does not run — so the tree is left modified in a way the next command's output will not mention.
- **Never edit tracked source to test it.** If a case needs coverage, write the test. Mutating the implementation to watch a test fail leaves the repository in a state no one asked for, and it proves the test catches *that* mutation rather than that the case is covered. The gap it seems to find is a missing test; write that instead.

## Testing

Three things get real tests:

- **`lib/assignment.ts`** — 3 reviewers per applicant, at most 1 Sparklet each, even load, 5% pool, and a feasibility precheck that fails loudly when the Sparklet ratio makes the constraints unsatisfiable.
- **`lib/passes.ts`** — the resolution state machine, including the COI-as-skip rule and the all-COI case, which must flag for admin rather than auto-resolve.
- **`lib/roster.ts`** — FR-6 paste parsing: last-space split, blank lines dropped, unsplittable and duplicate lines routed to confirmation rather than imported.

Test cases for all three are enumerated in `BUILD_PLAN.md` phases 2 and 6. Those cases are the spec. If a test contradicts them, the test is wrong.

Everything else gets light smoke coverage. Do not chase coverage percentage.

`prisma/checks/` holds constraint verification scripts. They are not part of `npm run verify` — they need a seeded database and they write to it — so re-run them by hand after any schema change. They assert against the database rather than the Prisma client: a duplicate insert goes through raw SQL and must come back as SQLSTATE 23505 naming the expected index, because Prisma can reject a duplicate client-side without the statement ever reaching Postgres. Each script cleans up whatever it creates and verifies that it did.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
