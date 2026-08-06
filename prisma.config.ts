import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7 keeps connection URLs here rather than in schema.prisma, and does not
// load .env on its own — hence the dotenv import above, which must stay first.
//
// DATABASE_URL points at Neon's pooled endpoint. If `prisma migrate` ever fails
// on advisory locks or prepared statements, set DIRECT_URL in .env to the same
// URL with `-pooler` removed from the hostname and add:
//   directUrl: env("DIRECT_URL"),
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
