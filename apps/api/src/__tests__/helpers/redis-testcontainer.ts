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
  /** Lua scripts (EVAL/EVALSHA) executed through `client` so far. */
  readonly luaCallCount: () => number
  /** Stop + remove the container. Idempotent. */
  readonly teardown: () => Promise<void>
}

export interface RedisTestContainerOptions {
  /**
   * Declare that this suite's point is a Lua invariant.
   *
   * F-37 (M3) is what this exists for. `sweeper-resolver-race.test.ts` was
   * enrolled in the M0 roll call, started a real container, and passed — while
   * the Lua path it was cited for never executed, because the suite's own
   * `@ibatexas/tools` shim omitted `eval` and `releaseDeferResumingLock`
   * swallows a failed release by design. Roll-call enrolment proves a FILE
   * ran; it says nothing about whether that file's Lua ran, and the gate
   * counted the file as executing because the file DID execute.
   *
   * With this set, `teardown()` throws when ZERO scripts reached the
   * container. It is deliberately a ZERO alarm and not a count: a per-suite
   * expected-call number would be 21 hand-maintained figures across the roll
   * call, each a fresh way to red spuriously, to catch a failure mode that is
   * always "the Lua stopped happening entirely". The asymmetry mirrors the
   * gate's completeness alarm — this can only ever ADD a failure, never
   * satisfy a requirement.
   *
   * Suites that assert their Lua's EFFECTS directly (the six M1 shape suites)
   * do not need it; they red on their own the moment a script stops running.
   * It is for suites where the Lua is a side effect of the path under test,
   * which is exactly where it can die unnoticed.
   */
  readonly expectLuaCalls?: boolean
}

/**
 * Start a fresh Redis 7 container and return a connected client +
 * teardown handle. The caller is responsible for invoking `teardown()`
 * from `afterAll` (and for `flushAll` between tests if needed).
 *
 * The container image is `redis:7-alpine` — small, well-understood,
 * matches production (`docker-compose.yml`).
 */
export async function setupRedisTestContainer(
  options: RedisTestContainerOptions = {},
): Promise<RedisTestHarness> {
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

  // Count scripts as they go by. Instrumented by replacing the two methods on
  // the instance rather than wrapping the client in a Proxy: node-redis v4
  // methods read private (`#`) fields, which throw when `this` is a Proxy, and
  // a Proxy client also has no spyable own properties (the spy-delegate
  // precedent). `.apply(client, …)` keeps `this` the real client.
  let luaCalls = 0
  for (const method of ["eval", "evalSha"] as const) {
    const original = client[method] as (...a: unknown[]) => unknown
    if (typeof original !== "function") continue
    ;(client as unknown as Record<string, unknown>)[method] = (
      ...args: unknown[]
    ) => {
      luaCalls += 1
      return original.apply(client, args)
    }
  }

  return {
    client,
    url,
    host,
    port,
    luaCallCount: () => luaCalls,
    async teardown() {
      try {
        if (client.isOpen) {
          await client.quit().catch(() => undefined)
        }
      } finally {
        await container.stop({ remove: true, timeout: 10_000 }).catch(() => undefined)
      }
      // AFTER the container is down, so a failure here never leaks one.
      if (options.expectLuaCalls === true && luaCalls === 0) {
        throw new Error(
          "[redis-testcontainer] this suite declared `expectLuaCalls: true` and ran a real " +
            "Redis container, but ZERO Lua scripts (EVAL/EVALSHA) reached it. The suite is " +
            "green over a Lua path that never executed — F-37's shape. Usual cause: a shim " +
            "or mock between the SUT and the container omits `eval`, and the production code " +
            "swallows the resulting TypeError. See docs/architecture/redis-lua-testing-decision.md.",
        )
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
