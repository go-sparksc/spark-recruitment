import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7 keeps connection URLs here rather than in schema.prisma, and does not
// load .env on its own — hence the dotenv import above, which must stay first.
//
// DATABASE_URL points at Neon's pooled endpoint, which is fine for the app and
// is the thing to watch for migrations: a pgBouncer-style pooler in transaction
// mode does not carry the session-level advisory lock `prisma migrate` takes, so
// a migration against the pooled hostname can fail where the same migration
// against the direct one succeeds.
//
// Hence the conditional below rather than the hand-edit this comment used to
// ask for. `vercel.json` runs `prisma migrate deploy` on every deploy, and a
// build is not a place where someone is available to uncomment a line: set
// DIRECT_URL in the environment (the same URL with `-pooler` removed from the
// hostname) and migrations use it; leave it unset and nothing changes. The app
// itself never reads it — only the migration engine does.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
    ...(process.env.DIRECT_URL ? { directUrl: env("DIRECT_URL") } : {}),
  },
});
