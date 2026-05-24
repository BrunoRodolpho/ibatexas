// Real-Redis test harness — RULE 3 (no Lua emulation theater).
//
// The mock-Redis stubs scattered across the api test suite implement
// Redis commands as Map.get/.set in JS. They CANNOT emulate Lua `EVAL`
// faithfully — Lua scripts in our code (refund-cap atomic check-and-
// increment, admin-confirmation-store GET+DEL, lock release) rely on
// Redis's server-side atomicity. A JS Map-stub of `eval()` is theater
// in the most literal sense: it gives green tests against code paths
// that have no real coverage. Cluster D flagged this against the
// W1C P1-I refund-cap fix — without a real Redis, the test gives a
// false signal of correctness on the very property the Lua exists
// to provide.
//
// This module spins up a real Redis 7 container per test file via
// `testcontainers`, hands callers a connected `node-redis` client,
// and tears down cleanly on `afterAll`. Tests opt in by calling
// `setupRedisTestContainer()` inside a `beforeAll`.
//
// The container uses a host-ephemeral port (testcontainers picks one)
// so multiple test files can run in parallel without contention.
//
// Skip behaviour: if Docker is not reachable, the helper throws — the
// caller decides whether to fail the suite or skip the describe block
// via the `RUN_REAL_REDIS` guard exported here. The default policy
// (per the W4 test-infra rebuild and the audit's RULE 3) is FAIL: real
// infrastructure or no test. Local-only dev may set
// `IBX_SKIP_REAL_REDIS=1` to skip — CI must run real Redis.

import { GenericContainer, type StartedTestContainer } from "testcontainers"
import { createClient, type RedisClientType } from "redis"

const SKIP_FLAG = process.env["IBX_SKIP_REAL_REDIS"] === "1"

/**
 * True when real-Redis tests should run. False only when the operator
 * explicitly set IBX_SKIP_REAL_REDIS=1 (local dev convenience).
 */
export const RUN_REAL_REDIS = !SKIP_FLAG

export interface RedisTestHarness {
  readonly client: RedisClientType
  readonly url: string
  readonly host: string
  readonly port: number
  /** Stop + remove the container. Idempotent. */
  readonly teardown: () => Promise<void>
}

/**
 * Start a fresh Redis 7 container and return a connected client +
 * teardown handle. The caller is responsible for invoking `teardown()`
 * from `afterAll` (and for `flushAll` between tests if needed).
 *
 * The container image is `redis:7-alpine` — small, well-understood,
 * matches production (`docker-compose.yml`).
 */
export async function setupRedisTestContainer(): Promise<RedisTestHarness> {
  // testcontainers picks an ephemeral host port — exposes 6379 inside.
  const container: StartedTestContainer = await new GenericContainer(
    "redis:7-alpine",
  )
    .withExposedPorts(6379)
    .withStartupTimeout(60_000)
    .start()

  const host = container.getHost()
  const port = container.getMappedPort(6379)
  const url = `redis://${host}:${port}`

  const client = createClient({ url }) as RedisClientType
  client.on("error", () => {
    /* swallow — surface errors via the awaited operation instead */
  })
  await client.connect()

  return {
    client,
    url,
    host,
    port,
    async teardown() {
      try {
        if (client.isOpen) {
          await client.quit().catch(() => undefined)
        }
      } finally {
        await container.stop({ remove: true, timeout: 10_000 }).catch(() => undefined)
      }
    },
  }
}

/**
 * Convenience: build the same shim shape that `getRedisClient()` from
 * `@ibatexas/tools` is expected to return. The api code calls into
 * `redis as unknown as { eval: ... }` so the node-redis client works
 * directly. This helper is here to document the contract and to allow
 * future shims to layer over it (e.g. capturing metrics).
 */
export function asGetRedisClientShim(client: RedisClientType): unknown {
  return client
}
