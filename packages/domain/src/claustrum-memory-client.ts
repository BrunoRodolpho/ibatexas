// @ibatexas/domain — dedicated claustrum-memory Prisma client singleton (lazy).
//
// This is a SEPARATE, generate-only client (see prisma/claustrum-memory.prisma)
// whose sole purpose is to expose the `claustrum_memory_*` delegates that
// resolveMemoryPort() probes and createPostgresMemoryProvider() drives. The
// physical tables are owned by the @claustrum SQL migrations and live in the
// `public` schema; this client never manages them (no migrate/db push).
//
// Mirrors the domain `prisma` singleton (lazy Proxy + @prisma/adapter-pg) so
// DATABASE_URL is read at first access, not at module-eval time.

import { PrismaClient } from "./generated/claustrum-memory-client/client.js"
import { PrismaPg } from "@prisma/adapter-pg"

const globalForMemory = globalThis as unknown as { _claustrumMemoryPrisma?: PrismaClient }

function createMemoryPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "warn"] : ["warn"],
  })
}

function getMemoryPrismaClient(): PrismaClient {
  globalForMemory._claustrumMemoryPrisma ??= createMemoryPrismaClient()
  return globalForMemory._claustrumMemoryPrisma
}

// Lazy proxy: defers PrismaClient creation until first property access.
export const claustrumMemoryPrisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getMemoryPrismaClient(), prop, receiver)
  },
})
