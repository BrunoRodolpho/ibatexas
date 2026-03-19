// @ibatexas/domain — Prisma client singleton
// Exported as a singleton to avoid exhausting connection pool in dev (hot reload).
//
// AUDIT-FIX: INFRA-13 — Connection pool configuration
// Prisma's connection pool is configured via DATABASE_URL query parameters:
//   ?connection_limit=10  — max connections in the pool (default: num_cpus * 2 + 1)
//   &pool_timeout=30      — seconds to wait for a connection before erroring (default: 10)
// For production, set these in DATABASE_URL to match your Postgres instance limits.
// Example: postgresql://user:pass@host:5432/db?connection_limit=10&pool_timeout=30

import { PrismaClient } from "./generated/prisma-client/index.js"

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
  })

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
