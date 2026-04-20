// @ibatexas/domain — Prisma client singleton (lazy)
// Exported as a lazy singleton to avoid exhausting connection pool in dev (hot reload)
// and to allow env vars (DATABASE_URL) to be loaded before the first connection.
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

const globalForPrisma = globalThis as unknown as { _prisma?: PrismaClient }

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "warn"] : ["warn"],
  })
}

function getPrismaClient(): PrismaClient {
  if (!globalForPrisma._prisma) {
    globalForPrisma._prisma = createPrismaClient()
  }
  return globalForPrisma._prisma
}

// Lazy proxy: defers PrismaClient creation until first property access.
// This avoids reading DATABASE_URL at ESM module evaluation time, which
// breaks CLI tools that load env vars via dotenv after static imports resolve.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getPrismaClient(), prop, receiver)
  },
})
