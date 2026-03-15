// @ibatexas/domain — Prisma client singleton
// Exported as a singleton to avoid exhausting connection pool in dev (hot reload).

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
