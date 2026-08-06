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
export const SEED_INSTANCE_ID = "seed_s26_demo";
