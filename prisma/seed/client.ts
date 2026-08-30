import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../generated/prisma/client";

// Standalone client for the seed and inspect scripts. These run under tsx rather
// than Next, so they load .env themselves and use relative imports instead of the
// "@/" alias. The app uses lib/prisma.ts instead.
export function createSeedClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/// Fixed so the seed can delete and recreate exactly its own instance, leaving
/// anything else in the database alone.
///
/// **Overridable by environment**, which is what lets `npm run seed:demo` drive
/// the same three scripts (`seed`, `advance`, `passes`) under a second identity
/// without threading a parameter through the ~100 references to this constant
/// across the seed and every check script. PRD decision 97.
///
/// Two consequences worth knowing, since neither is obvious from a call site:
///
///   - `prisma/checks/*` follow this variable too. That is useful — the checks
///     can be pointed at the demo instance — but it means an UNSET variable is
///     the only thing keeping them aimed at the development seed.
///   - Every script that reads this deletes and recreates "its own" instance.
///     Setting the variable to a real instance's id would therefore destroy it.
///     Only ever set it to a seed or demo id.
export const SEED_INSTANCE_ID = process.env.SEED_INSTANCE_ID ?? "seed_s26_demo";
