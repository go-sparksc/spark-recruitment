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
- **`prisma migrate dev` cannot run here.** It refuses in a non-interactive shell, so the migration flow is `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, hand-finish the SQL (CHECK constraints, partial indexes), then `prisma migrate deploy`. Prisma 7 renamed the diff flags — `--from-schema-datasource` is gone, and the error message names the replacement
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
- **Tick every clause before committing a slice.** Re-read the FR sentence and the plan section, list their clauses, and check each one against the diff. A requirement written as a list — "adds by name, and bulk paste is also supported", "assign, unassign, or swap" — is the failure mode: the first clause gets built and the rest quietly do not. Neither tests nor the commit message catch it, because both describe what was built rather than what was asked for, so they agree with the implementation and are wrong together. This has already happened twice in Phase 2, on FR-6 and FR-8, and both were found by the owner clicking through rather than by review. FR-9 is a six-bullet list and will break the same way.
- **One command per shell call.** Do not chain a file write, a test run, and a restore into one invocation. When a chain half-succeeds you cannot tell which half, and a `cp` restore tacked onto the end of a failing command does not run — so the tree is left modified in a way the next command's output will not mention.
- **Never edit tracked source to test it.** If a case needs coverage, write the test. Mutating the implementation to watch a test fail leaves the repository in a state no one asked for, and it proves the test catches *that* mutation rather than that the case is covered. The gap it seems to find is a missing test; write that instead.
- **There is no formatter here. Do not reach for one.** Prettier is not a dependency, and `npx prettier --write` on a tracked file installs it on the fly and reflows the whole file: in Phase 6 that turned a 60-line change to `roster-controls.tsx` into a 368-line diff, where the actual edit was unreviewable and every unrelated line looked touched. Fix indentation by hand. If a file's formatting genuinely needs settling, that is its own commit, agreed first — never a side effect of a change about something else.
- **Restart `next dev` after any `prisma generate` or `prisma migrate`.** The generated client is regenerated on disk, but a running dev server keeps the old one in memory — so the server serves a client that does not know the column you just added, and fails with `Unknown field 'x' for select statement on model 'Y'` at runtime. Nothing in the toolchain warns you: `npm run verify` reads the new client from disk and passes completely, so typecheck, lint and every test go green while the app is broken. This cost a full round of misdiagnosis in Phase 3 — the owner found it from a browser error overlay after being sent to look at the network, because the reachability checks had probed routes that did not touch the new column.

  Two corollaries worth having in front of you. **Check the route that is actually failing, not a neighbouring one**: a 200 from a page that avoids the new column proves nothing about the page that uses it. And **read the dev server log before theorising** — the untruncated Prisma error names the exact field, and it is in `next dev`'s output the whole time.

## Testing

Four things get real tests:

- **`lib/assignment.ts`** — 3 reviewers per applicant, at most 1 Sparklet each, even load, 5% pool, and a feasibility precheck that fails loudly when the Sparklet ratio makes the constraints unsatisfiable.
- **`lib/roster.ts`** — FR-6 paste parsing: last-space split, blank lines dropped, unsplittable and duplicate lines routed to confirmation rather than imported.
- **`lib/reconciliation.ts`** — FR-13's four-tier cascade: exact email, exact name, fuzzy name, unresolved. Normalization (single-letter tokens, non-alphanumerics, NFC, case) is tested on its own, before any tier, because every tier depends on it. Jaro-Winkler is pinned to published reference pairs so a refactor cannot quietly change the metric. Two cases are regression guards rather than behaviour: `cici fang`/`cecilia fang` scores **below** 0.85 whole-string and `mia chen`/`nia chen` scores **above** it, which is why decision 52 scores the given name against an exact surname instead. Ambiguity queues at *every* tier, not only the fuzzy one, and a single fuzzy candidate is confirmed by a human before commit — the nickname the PRD wants matched is less similar to its own given name than two different people's names are to each other, and no threshold fixes that.
- **`lib/passes.ts`** — the resolution state machine: unanimous yes admits, unanimous no rejects, mixed carries forward, COI counts as skip without a stored vote, all-COI must flag NEEDS_ADMIN rather than read as unanimous. Pure function, no database access, tested against every case in `BUILD_PLAN.md`'s Phase 6 section and PRD decisions 66-71 before anything is built against it.

Test cases for all four are enumerated in `BUILD_PLAN.md` phases 2 and 6 and in `lib/reconciliation.test.ts` itself. Those cases are the spec. If a test contradicts them, the test is wrong.

Everything else gets light smoke coverage. Do not chase coverage percentage.

**Where "light" still means something.** Twice in Phase 5 a page assembled correct pure functions incorrectly — a wrong `tallySelections` call and an unactionable collision list — and neither the pure suites nor the clause ledger could see it. The rule that came out of it: when a page transforms query results before rendering them, that transformation belongs in `lib/` where it can be tested, and the page keeps only the query. `lib/first-round.ts` is the worked example.

`prisma/checks/` holds constraint verification scripts. They are not part of `npm run verify` — they need a seeded database and they write to it — so re-run them by hand after any schema change. They assert against the database rather than the Prisma client: a duplicate insert goes through raw SQL and must come back as SQLSTATE 23505 naming the expected index, because Prisma can reject a duplicate client-side without the statement ever reaching Postgres. Each script cleans up whatever it creates and verifies that it did.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
