// audit-2026-05-24 H3 Wave A2 — Real-Postgres test harness for the
// LGPD scrub conformance suite (T4).
//
// Why a real container, not a mock:
//
// The T4 suite asserts that `anonymizeCustomer` (post Wave A1) actually
// scrubs every PII-bearing column reachable from a customerId across 7
// in-process surfaces. Per CLAUDE.md / RULE 3 (mirrored on the Redis
// pattern at `helpers/redis-testcontainer.ts`): a Prisma mock would prove
// the call shape, not the column state — exactly the property A1 has to
// uphold. A Map-stub of `update`/`updateMany` returns whatever it's told;
// it cannot catch a missing UPDATE statement (the failure mode T4 is
// designed to detect). Only a real Postgres can.
//
// Wiring strategy:
//
// `@ibatexas/domain` exports a singleton `prisma` client via a Proxy that
// defers PrismaClient construction until the first property access AND
// reads `DATABASE_URL` from `process.env` at that point. We exploit this
// to point the singleton at the testcontainer:
//
//   1. Boot the container, capture host/port.
//   2. Set `process.env.DATABASE_URL` to the container URL.
//   3. Apply Prisma migrations via `prisma migrate deploy` against that URL.
//   4. From this point on, the domain `prisma` singleton (and anything
//      `anonymizeCustomer` calls internally) talks to the container.
//
// This avoids a parallel PrismaClient instance under tsc `rootDir`
// constraints (apps/api's rootDir is `src/`, so a direct import of the
// generated client at `packages/domain/src/generated/...` would trip
// TS6059). It also matches how the production wiring works: one
// process-wide DATABASE_URL → one PrismaClient.
//
// Lifecycle:
//   - `beforeAll`: `setupPostgresTestContainer()` boots a postgres:15-alpine
//     image (matching production), applies migrations once, and returns a
//     harness with the connection URL + a teardown handle. Migration is
//     the slow part (~10-20s); it's amortised across every test in a file.
//   - per-test: callers either scope writes to a unique customerId or
//     call `truncateDomainTables()` in `beforeEach` to wipe state.
//   - `afterAll`: teardown stops + removes the container.
//
// Skip behaviour: matches the Redis pattern — `IBX_SKIP_REAL_POSTGRES=1`
// for local-only dev (CI must run real containers). Docker unavailable →
// `setupPostgresTestContainer` throws; the caller's `describe.skipIf`
// gates whether the suite runs or fails-closed.

import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { GenericContainer, type StartedTestContainer } from "testcontainers"

const SKIP_FLAG = process.env["IBX_SKIP_REAL_POSTGRES"] === "1"

export const RUN_REAL_POSTGRES = !SKIP_FLAG

export interface PostgresTestHarness {
  readonly url: string
  readonly host: string
  readonly port: number
  readonly teardown: () => Promise<void>
}

/**
 * Spin up a fresh postgres:15-alpine container, apply the @ibatexas/domain
 * Prisma migrations, and point `process.env.DATABASE_URL` at it.
 *
 * Callers should `await` this in `beforeAll` BEFORE the first `import` of
 * any code path that touches the domain `prisma` singleton — the singleton
 * is lazy, so reads of `DATABASE_URL` happen at first use, not at module
 * load. Importing `anonymizeCustomer` (which imports `prisma` from
 * `@ibatexas/domain`) is safe BEFORE setup as long as no call has fired.
 */
export async function setupPostgresTestContainer(): Promise<PostgresTestHarness> {
  const container: StartedTestContainer = await new GenericContainer(
    "postgres:15-alpine",
  )
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "ibx_test",
      POSTGRES_PASSWORD: "ibx_test",
      POSTGRES_DB: "ibx_domain_test",
    })
    .withStartupTimeout(120_000)
    .start()

  const host = container.getHost()
  const port = container.getMappedPort(5432)
  const url = `postgresql://ibx_test:ibx_test@${host}:${port}/ibx_domain_test?schema=ibx_domain`

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const domainRoot = path.resolve(__dirname, "../../../../../packages/domain")

  // Apply the Prisma migrations. `prisma migrate deploy` is idempotent and
  // runs everything in `prisma/migrations/` against the empty container
  // DB. DATABASE_URL is passed explicitly so the CLI doesn't try to read
  // a local .env file (the worktree may not have one).
  // Pin PATH to fixed, non-writable system dirs plus Node's own bin dir
  // (which ships `npx`), so the spawned lookup never consults a
  // potentially-writable directory inherited from the ambient PATH.
  const safePath = [
    path.dirname(process.execPath),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(path.delimiter)

  const migrateResult = spawnSync(
    "npx",
    ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    {
      cwd: domainRoot,
      env: { ...process.env, DATABASE_URL: url, PATH: safePath },
      encoding: "utf-8",
      timeout: 180_000,
    },
  )

  if (migrateResult.status !== 0) {
    await container.stop({ remove: true, timeout: 10_000 }).catch(() => undefined)
    throw new Error(
      `[h3-postgres-container] prisma migrate deploy failed (status=${migrateResult.status}):\n` +
        `stdout:\n${migrateResult.stdout}\n` +
        `stderr:\n${migrateResult.stderr}`,
    )
  }

  // Point the domain `prisma` singleton at the container. The singleton's
  // Proxy defers PrismaClient construction until first property access, so
  // setting DATABASE_URL here (before any prisma call fires) is safe.
  process.env["DATABASE_URL"] = url

  return {
    url,
    host,
    port,
    async teardown() {
      await container
        .stop({ remove: true, timeout: 10_000 })
        .catch(() => undefined)
    },
  }
}

/**
 * Helper to wipe domain-schema rows between tests. Issues a single
 * TRUNCATE ... CASCADE so FK chains unwind cleanly without re-applying
 * migrations (which costs ~10-20s each).
 *
 * Tables are listed explicitly (rather than `pg_tables` introspection) so
 * the operation is deterministic; if a new table is added to the schema
 * without being listed here, the relevant test will surface a leftover
 * row and fail-loudly rather than silently leak state.
 */
export async function truncateDomainTables(
  prisma: { $executeRawUnsafe: (sql: string) => Promise<unknown> },
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE
      ibx_domain.reservation_tables,
      ibx_domain.reservations,
      ibx_domain.waitlist,
      ibx_domain.conversation_messages,
      ibx_domain.conversations,
      ibx_domain.order_event_log,
      ibx_domain.order_status_history,
      ibx_domain.order_notes,
      ibx_domain.payment_status_history,
      ibx_domain.payments,
      ibx_domain.order_projections,
      ibx_domain.customer_order_items,
      ibx_domain.customer_preferences,
      ibx_domain.addresses,
      ibx_domain.loyalty_accounts,
      ibx_domain.reviews,
      ibx_domain.customers,
      ibx_domain.staff,
      ibx_domain.time_slots,
      ibx_domain.tables
    CASCADE`,
  )
}
