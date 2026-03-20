// @ibatexas/domain — Prisma client singleton
// Exported as a singleton to avoid exhausting connection pool in dev (hot reload).
//
// Prisma 7: uses the Rust-free @prisma/adapter-pg driver adapter.
// Connection pool is managed by Supabase PgBouncer (port 6543, transaction mode).
// Prisma connects via DATABASE_URL (pooler) for queries. Pool tuning is via
// DATABASE_URL query params:
//   ?connection_limit=10  — max connections Prisma opens (default: num_cpus * 2 + 1)
//   &pool_timeout=30      — seconds to wait for a connection (default: 10)
//   &pgbouncer=true       — disables prepared statements (required for PgBouncer)
// See docs/setup/supabase.md for full setup.

import { PrismaClient } from "./generated/prisma-client/client.js"
import { PrismaPg } from "@prisma/adapter-pg"

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
  })
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
