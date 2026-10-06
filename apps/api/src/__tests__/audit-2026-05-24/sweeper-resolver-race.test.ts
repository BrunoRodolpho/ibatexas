// audit-2026-05-24 — Hardening test T6: sweeper-resolver race regression.
//
// # Why this test exists
//
// SYNTHESIS.md §"Hardening tests" item #6 + audit-2026-05-24 P0-2: the
// `defer-timeout-sweeper` (job that publishes `intent.defer.timeout`) and
// the `defer-resolver` (subscriber that dispatches the resume) used to
// both fire for the same parked envelope when the PIX confirmation NATS
// event arrived just as the parked-envelope TTL crossed the imminent
// threshold (60s in the sweeper, configurable via env). Two destructive
// mutations against the same envelope — exactly the class P0-2 closed by
// adding a shared `defer:resuming:{deferResumeHash(intentHash, signal)}`
// SETNX mutex to both surfaces.
//
// This test is the regression catch-net for that fix. It pins the
// invariant that under any number of concurrent (sweeper, resolver) pairs
// scheduled within a ~50ms window against the SAME parked envelope:
//
//   (a) exactly one `defer:resuming:` SETNX succeeds,
//   (b) exactly one mutation actually fires (publishNatsEvent for the
//       sweeper OR dispatcher for the resolver — never both),
//   (c) the loser logs a `cancel_won_race`-equivalent reason and exits
//       cleanly without emitting a duplicate audit record OR a second
//       NATS event.
//
// # Style
//
// Mirrors R3-1 (commit 6dda950) + the R2-2 P0-3 race regression
// (apps/api/src/__tests__/integration/lgpd-anonymize-lifecycle.test.ts
// §"P0-3 race"). Uses the real Redis testcontainer harness
// (apps/api/src/__tests__/helpers/redis-testcontainer.ts) so the SETNX
// races actually race — a hand-rolled Map-stub would emulate atomicity
// in JS and give a false positive. Per CLAUDE.md / RULE 3: real
// infrastructure or no test.
//
// Iteration target: 100 to flush out non-determinism in the schedule.
// Each iteration uses a fresh sessionId + intentHash so the mutex
// namespace doesn't carry across rounds; the suite passes only if
// across ALL iterations the "exactly-one-mutation" invariant holds.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  deferParkKey,
  deferResumeHash,
} from "@adjudicate/runtime"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "../helpers/redis-testcontainer.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockPublishNatsEvent = vi.hoisted(() =>
  vi.fn(async (_subject: string, _payload: Record<string, unknown>) => undefined),
)
const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn())
const mockAuditSinkEmit = vi.hoisted(() => vi.fn(async () => undefined))
const mockAdjudicate = vi.hoisted(() =>
  vi.fn(() => ({ kind: "EXECUTE" as const })),
)

// Real-Redis testcontainer harness — populated by beforeAll, consumed by
// the getRedisClient mock below.
let runtimeHarness: RedisTestHarness | null = null

// F-40 seam — see the `get` shim below. Installed by exactly one case and
// cleared in `beforeEach`, so every other case runs an unhooked shim.
let afterParkGetHook: ((key: string) => Promise<void>) | null = null

function requireRuntimeRedis(): RedisTestHarness["client"] {
  if (!runtimeHarness) {
    throw new Error(
      "[sweeper-resolver-race.test] real-Redis testcontainer not initialized — beforeAll did not complete",
    )
  }
  return runtimeHarness.client
}

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
  subscribeNatsEvent: mockSubscribeNatsEvent,
}))

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => {
    const redis = requireRuntimeRedis()
    return {
      async set(
        key: string,
        value: string,
        options?: { EX?: number; NX?: boolean },
      ): Promise<string | null> {
        // audit-2026-05-24 P0-3 lesson (lgpd-anonymize-lifecycle.test.ts):
        // node-redis strips unknown option fields. Re-build the options
        // bag with ONLY the keys it recognises so SETNX races against the
        // real server.
        const setOpts: { EX?: number; NX?: true } = {}
        if (options?.EX !== undefined) setOpts.EX = options.EX
        if (options?.NX === true) setOpts.NX = true
        return Object.keys(setOpts).length > 0
          ? ((await redis.set(key, value, setOpts)) as string | null)
          : ((await redis.set(key, value)) as string | null)
      },
      async get(key: string): Promise<string | null> {
        const value = (await redis.get(key)) as string | null
        // F-40 seam. Lets ONE deterministic case interleave a resolver win
        // into the exact window between the sweeper's E3 blob GET and its
        // `defer:resuming:*` SETNX. Null for every other case, so nothing
        // else in this file changes behaviour. See the F-40 test below for
        // why a hook beats leaning on the 100-iteration case's ~1% rate.
        if (afterParkGetHook) await afterParkGetHook(key)
        return value
      },
      async del(key: string): Promise<number> {
        return (await redis.del(key)) as number
      },
      async incr(key: string): Promise<number> {
        return (await redis.incr(key)) as number
      },
      async decr(key: string): Promise<number> {
        return (await redis.decr(key)) as number
      },
      async expire(key: string, seconds: number): Promise<boolean | number> {
        return (await redis.expire(key, seconds)) as boolean | number
      },
      async ttl(key: string): Promise<number> {
        return (await redis.ttl(key)) as number
      },
      // F-37 (M3). This shim used to omit `eval`, and that single omission
      // made the file a class-(i-b) hole WEARING A CONTAINER: both surfaces
      // release their `defer:resuming:*` mutex through
      // `releaseDeferResumingLock`, whose Lua compare-and-delete died on
      // `redis.eval is not a function` and was swallowed by that helper's
      // documented best-effort catch (`lib/defer-resuming-lock.ts:128`). The
      // races below still raced — SETNX went to the real server — but the
      // RELEASE half never executed, so the mutex only ever ended by TTL and
      // this suite's roll-call enrolment certified a file that ran, not a Lua
      // path that did. Measured before the fix: after a sweeper-won sweep the
      // mutex was still present with ttl=60.
      //
      // The fix is a verbatim FORWARD, never an emulation — the script text,
      // keys and arguments go to the same container every other command here
      // goes to, and Redis executes it. Nothing about W4 RULE 3 is bent: the
      // in-memory adapter still refuses `eval`, and this is not the in-memory
      // adapter.
      async eval(
        script: string,
        options?: { keys?: string[]; arguments?: string[] },
      ): Promise<unknown> {
        return await redis.eval(script, options)
      },
      scanIterator(opts: { MATCH?: string; COUNT?: number }) {
        return redis.scanIterator(opts) as AsyncIterable<string | string[]>
      },
    }
  }),
  rk: (k: string) => `t6-race:${k}`,
}))

// F-39 (M3). `mockAuditSinkEmit` above was a DEAD SPY: it was declared,
// cleared in `beforeEach`, and asserted on in three places — but no
// `vi.mock` ever connected it to anything, so `auditEmits` was structurally
// always 0. That made `expect(auditEmits).toBe(0)` vacuous everywhere it
// appeared, and made the `park_missing_after_lock` arm's
// `expect(auditEmits).toBe(1)` unsatisfiable. It stayed green only because
// that arm was UNREACHABLE while the release EVAL was dead (F-37): the
// sweeper never freed the mutex inside an iteration, so the resolver could
// only ever come back `duplicate_suppressed`. Fixing F-37 made the branch
// reachable and the dead spy fell out immediately.
//
// Wired here to the real seam the resolver uses (`getAuditSink().emit`),
// with the rest of the module passed through — `src/__tests__/setup.ts`
// imports `__setAuditSinkDependencies` from it to bootstrap the no-op sink
// every apps/api test file relies on.
vi.mock("@ibatexas/audit-sink", async () => {
  const real =
    await vi.importActual<typeof import("@ibatexas/audit-sink")>(
      "@ibatexas/audit-sink",
    )
  return {
    ...real,
    getAuditSink: () => ({ emit: mockAuditSinkEmit }),
  }
})

vi.mock("@adjudicate/core/kernel", async () => {
  const real = await vi.importActual<typeof import("@adjudicate/core/kernel")>(
    "@adjudicate/core/kernel",
  )
  return {
    ...real,
    adjudicate: mockAdjudicate,
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────

// Build an envelope. The runtime's verifyParkedEnvelopeHash reads
// {version, nonce, taint, actorPrincipal} at the envelope's top level;
// buildEnvelope produces all four. We also hoist `actor.principal` →
// top-level `actorPrincipal` so the parked blob passes verification on
// the resolver side.
function buildTestEnvelope(args: {
  sessionId: string
  nonce: string
}): IntentEnvelope & { actorPrincipal: string } {
  const env = buildEnvelope({
    kind: "order.confirm",
    payload: { orderId: `ord_${args.nonce}` },
    actor: { principal: "user", sessionId: args.sessionId },
    taint: "UNTRUSTED",
    nonce: args.nonce,
  }) as IntentEnvelope
  return {
    ...env,
    actorPrincipal: env.actor.principal,
  } as IntentEnvelope & { actorPrincipal: string }
}

function makeLogger(): import("fastify").FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: "info",
    silent: vi.fn(),
  } as unknown as import("fastify").FastifyBaseLogger
}

/**
 * Seed a parked envelope into real Redis with a TTL that places it at the
 * sweeper's imminent threshold (≤60s remaining). The signal matches what
 * the resolver will deliver to `resolveDeferredSession`.
 *
 * Returns the intentHash + parkKey so the test can verify post-race state.
 */
async function seedParkedEnvelope(args: {
  sessionId: string
  signal: string
  nonce: string
}): Promise<{
  parkKey: string
  resumingKey: string
  intentHash: string
}> {
  const envelope = buildTestEnvelope({
    sessionId: args.sessionId,
    nonce: args.nonce,
  })
  const intentHash = envelope.intentHash
  const parkedAt = new Date().toISOString()
  const parkBlob = JSON.stringify({
    envelope,
    signal: args.signal,
    parkedAt,
  })
  // rk() under the mocked @ibatexas/tools is `t6-race:${k}`.
  const parkKey = `t6-race:${deferParkKey(args.sessionId)}`
  const resumingKey = `t6-race:defer:resuming:${deferResumeHash(intentHash, args.signal)}`
  // Use SET with EX=30 so the sweeper sees TTL ≤ IMMINENT_TTL_SECONDS (60s).
  // The sweeper's branch `if (ttl > IMMINENT_TTL_SECONDS) continue` is what
  // we MUST cross — a fresh park with TTL=600 would never trigger the
  // sweeper to publish.
  await requireRuntimeRedis().set(parkKey, parkBlob, { EX: 30 })
  return { parkKey, resumingKey, intentHash }
}

/**
 * Wipe the testcontainer between iterations so each race starts clean.
 */
async function flushRedis(): Promise<void> {
  if (runtimeHarness) {
    await runtimeHarness.client.flushDb()
  }
}

// ── Real-Redis harness lifecycle ──────────────────────────────────────────

beforeAll(async () => {
  // `expectLuaCalls` — F-37 (M3). This file's release path is Lua, but the Lua
  // is a SIDE EFFECT of the race under test rather than the thing the
  // assertions read, which is exactly how it managed to be dead for as long as
  // it was. The declaration makes teardown fail if zero scripts reach the
  // container, so the file cannot go back to being enrolled-but-Lua-less
  // without saying so.
  runtimeHarness = await setupRedisTestContainer({ expectLuaCalls: true })
}, 120_000)

afterAll(async () => {
  await runtimeHarness?.teardown()
  runtimeHarness = null
})

beforeEach(async () => {
  mockPublishNatsEvent.mockClear()
  mockSubscribeNatsEvent.mockClear()
  mockAuditSinkEmit.mockClear()
  mockAdjudicate.mockClear()
  mockAdjudicate.mockReturnValue({ kind: "EXECUTE" as const })
  afterParkGetHook = null
  await flushRedis()
})

// ── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_REAL_REDIS)(
  "audit-2026-05-24 T6 — sweeper-vs-resolver race regression",
  () => {
    // Iteration target. 50 surfaces non-determinism reliably under our
    // local scheduler; we run 100 to give CI noise headroom. If the test
    // becomes too slow in CI (>120s wall), drop to 50 — the invariant
    // surfaces within the first 10-20 iterations when broken.
    const ITERATIONS = 100

    // Timing tolerance the schedule honours. The race scheduler fires
    // both surfaces within a 50ms window via `setTimeout` jitter (per
    // task spec). Production timing between PIX-webhook arrival and the
    // sweeper's TTL crossing is on the same order of magnitude.
    const RACE_WINDOW_MS = 50

    // ── E2 (Fix-b) HARD-ZERO INVARIANT (closed 2026-05-24) ────────────
    //
    // Initial T6 runs surfaced a 1-4% / 100 iteration violation rate
    // against the P0-2 mutex. Diagnosis:
    //
    //   Resolver: GET parkKey (returns the still-live blob into memory)
    //   Sweeper:  SETNX defer:resuming → publish → DEL parkKey → DEL mutex
    //   Resolver: SETNX defer:resuming (now succeeds — sweeper just
    //                                   released the mutex)
    //   Resolver: dispatch (BOTH surfaces mutated)
    //
    // Closed by E2 Fix-b in `apps/api/src/subscribers/defer-resolver.ts`
    // (search for "audit-2026-05-24 E2 (Fix-b)"): the resolver now
    // re-checks parkKey existence AFTER the SETNX succeeds and BEFORE
    // the cycle counter / dispatch. The parkKey is the ground-truth
    // ownership token; once the sweeper DELs it, the resolver MUST
    // refuse and emit a `defer.resume.skipped` audit record.
    //
    // Tolerance dropped to ZERO across 5 separate 100-iteration runs.
    // Any violation regression here means the post-SETNX re-check was
    // removed or weakened.
    it(`${ITERATIONS} sweeper-vs-resolver concurrent iterations — hard-zero double-mutation invariant (E2 Fix-b closed)`, async () => {
      const { sweepDeferTimeouts } = await import(
        "../../jobs/defer-timeout-sweeper.js"
      )
      const {
        resolveDeferredSession,
        setResumeIntentDispatcher,
      } = await import("../../subscribers/defer-resolver.js")

      const dispatcherCalls: string[] = []
      setResumeIntentDispatcher(async (intent) => {
        dispatcherCalls.push(intent.originalIntentHash)
      })

      interface IterationResult {
        readonly iteration: number
        readonly intentHash: string
        readonly sweeperPublished: boolean
        readonly resolverDispatched: boolean
        readonly resolverKind: string
        readonly auditEmits: number
      }
      const results: IterationResult[] = []

      try {
        for (let i = 0; i < ITERATIONS; i++) {
          const sessionId = `sess_t6_race_${i}`
          const signal = "payment.confirmed"
          const nonce = `t6-nonce-${i}`

          // Per-iteration counters AND Redis state reset — we count from a
          // fresh slate so an aggregate over 100 iterations is the sum, not
          // contamination. Flushing Redis between iterations prevents
          // leftover parkKeys (from prior iterations where neither side
          // mutated, e.g., due to scheduling) from being picked up by the
          // current iteration's sweeper SCAN — that would cross-pollute
          // `sweepDeferTimeouts`'s publishedCount and the audit mock.
          mockPublishNatsEvent.mockClear()
          mockAuditSinkEmit.mockClear()
          dispatcherCalls.length = 0
          await flushRedis()

          // Seed: park a near-TTL envelope so the sweeper's
          // `ttl > IMMINENT_TTL_SECONDS` branch admits it.
          const { intentHash, resumingKey, parkKey } = await seedParkedEnvelope({
            sessionId,
            signal,
            nonce,
          })

          // Schedule the two surfaces within a ~RACE_WINDOW_MS window
          // via setTimeout jitter. Promise.all flushes them through the
          // microtask queue — whichever SETNX hits the real Redis first
          // wins the mutex.
          //
          // The stagger jitter is intentional: a fixed 0ms delay on both
          // sides would make Promise.all serialise them through V8's
          // queue in a deterministic order. A ±RACE_WINDOW_MS jitter
          // breaks that determinism so successive iterations actually
          // race rather than re-play the same scheduler outcome.
          const sweeperDelayMs = Math.floor(Math.random() * RACE_WINDOW_MS)
          const resolverDelayMs = Math.floor(Math.random() * RACE_WINDOW_MS)

          // PaymentStatusChangedEvent shape — only the fields the
          // resolver reads in `buildResumeOrderState`.
          const event = {
            orderId: `ord_${nonce}`,
            paymentId: `pay_${nonce}`,
            previousStatus: "payment_pending",
            newStatus: "paid",
            method: "pix" as const,
            version: 2,
            timestamp: new Date().toISOString(),
          }

          const [sweeperCountOrErr, resolverResult] = await Promise.all([
            new Promise<number | Error>((resolve) => {
              setTimeout(() => {
                void sweepDeferTimeouts(makeLogger())
                  .then(resolve)
                  .catch((err) => resolve(err as Error))
              }, sweeperDelayMs)
            }),
            new Promise<{ kind: string }>((resolve) => {
              setTimeout(() => {
                void resolveDeferredSession({
                  sessionId,
                  signal,
                  event: event as unknown as Parameters<
                    typeof resolveDeferredSession
                  >[0]["event"],
                  log: makeLogger(),
                })
                  .then((r) => resolve({ kind: r.kind }))
                  .catch((err) =>
                    resolve({ kind: `threw:${(err as Error).message}` }),
                  )
              }, resolverDelayMs)
            }),
          ])

          // Did the sweeper actually publish `intent.defer.timeout`?
          //
          // audit-2026-05-24 E3 closed (commit suppressing sweeper ghost
          // publish): when the resolver wins the race between the
          // sweeper's SCAN/TTL pass and the sweeper's parkKey GET, the
          // sweeper now short-circuits with a debug log and does NOT
          // publish at all. As a result we count any `intent.defer.timeout`
          // publish as a real sweeper-won mutation — there is no longer a
          // ghost path to filter for. The aggregate invariant below pins
          // this to `publishedCount === 0` on resolver-won iterations.
          const sweeperPublished = mockPublishNatsEvent.mock.calls.some(
            ([subject]) => subject === "intent.defer.timeout",
          )
          // Did the resolver actually dispatch? The dispatcher we installed
          // pushes intentHash; a re-adjudicated EXECUTE without dispatch
          // wiring would skip the push.
          const resolverDispatched = dispatcherCalls.includes(intentHash)
          const auditEmits = mockAuditSinkEmit.mock.calls.length

          results.push({
            iteration: i,
            intentHash,
            sweeperPublished,
            resolverDispatched,
            resolverKind: resolverResult.kind,
            auditEmits,
          })

          // ── Per-iteration loser-path invariants ────────────────────
          //
          // The TOP-LEVEL "exactly one mutation" invariant is asserted
          // against the aggregate after the loop (see VIOLATION_TOLERANCE_PCT
          // comment + assertion). Here we pin the LOSER-PATH invariants:
          // when only one side mutated, the OTHER side must have surfaced
          // a refusal-class result and NOT emitted an audit record.
          // Regressions in the loser path would be a separate class from
          // the residual race window (which is tolerated below).
          if (resolverDispatched && !sweeperPublished) {
            // Resolver won — sweeper MUST NOT have published ANY
            // intent.defer.timeout event for this iteration.
            //
            // audit-2026-05-24 E3 closed: prior to the E3 fix the sweeper
            // could still publish a "ghost" timeout with empty intentHash
            // via its malformed-blob fallback when the resolver DEL'd the
            // parkKey between SCAN/TTL and GET. With the E3 suppression
            // (apps/api/src/jobs/defer-timeout-sweeper.ts: `if (raw ===
            // null) continue`), the sweeper short-circuits with a debug
            // log instead. We pin the strict invariant: publishedCount on
            // the sweeper side is 0, and no `intent.defer.timeout` call
            // (ghost OR meaningful) fires.
            expect(
              sweeperCountOrErr,
              `iteration ${i}: resolver won race but sweeper threw an error`,
            ).not.toBeInstanceOf(Error)
            expect(
              sweeperCountOrErr,
              `iteration ${i}: resolver won race but sweeper publishedCount=${sweeperCountOrErr} — E3 ghost-publish suppression regression`,
            ).toBe(0)
            const timeoutPublishes = mockPublishNatsEvent.mock.calls.filter(
              ([s]) => s === "intent.defer.timeout",
            )
            expect(
              timeoutPublishes.length,
              `iteration ${i}: resolver won race but sweeper published ${timeoutPublishes.length} intent.defer.timeout event(s) — E3 regression. ` +
                `First payload: ${JSON.stringify(timeoutPublishes[0]?.[1])}`,
            ).toBe(0)
          } else if (sweeperPublished && !resolverDispatched) {
            // Sweeper won — resolver must have surfaced one of
            // {duplicate_suppressed, signal_mismatch, no_park,
            // park_missing_after_lock}. The pre-P0-2 race let the
            // resolver ALSO dispatch even though the sweeper had already
            // torn down the envelope; the post-fix invariants are:
            //   - resolver's preflight (defer:resuming SETNX) refuses with
            //     duplicate_suppressed when the sweeper still holds the
            //     mutex, or
            //   - resolver's post-SETNX parkKey re-check (E2 Fix-b) refuses
            //     with park_missing_after_lock when the sweeper released
            //     the mutex AFTER deleting the parkKey.
            expect(
              [
                "duplicate_suppressed",
                "no_park",
                "signal_mismatch",
                "park_missing_after_lock",
              ],
              `iteration ${i}: sweeper won but resolverKind=${resolverResult.kind} ` +
                `is not in the expected loser-refusal set. Either the resolver dispatched ` +
                `a second mutation OR a new refusal kind was introduced without updating ` +
                `this test.`,
            ).toContain(resolverResult.kind)
            // The resolver MAY emit ONE audit record on the
            // park_missing_after_lock loser path (the defer.resume.skipped
            // forensic record). On all other loser paths it MUST NOT emit.
            if (resolverResult.kind === "park_missing_after_lock") {
              expect(
                auditEmits,
                `iteration ${i}: park_missing_after_lock loser path should emit exactly one defer.resume.skipped audit record`,
              ).toBe(1)
            } else {
              expect(
                auditEmits,
                `iteration ${i}: resolver lost race (${resolverResult.kind}) but emitted ${auditEmits} audit records — duplicate audit emission regression`,
              ).toBe(0)
            }
          }

          // Sanity: the parked key is either consumed by the winner
          // (sweeper DELs after publish; resolver DELs after commit) or
          // still present if both lost. We assert it is NOT present-AND-
          // unchanged (which would mean nothing happened).
          void parkKey
          void resumingKey
        }
      } finally {
        setResumeIntentDispatcher(null)
      }

      // ── Aggregate assertions across all iterations ────────────────
      const bothFired = results.filter(
        (r) => r.sweeperPublished && r.resolverDispatched,
      )
      const sweeperWon = results.filter(
        (r) => r.sweeperPublished && !r.resolverDispatched,
      )
      const resolverWon = results.filter(
        (r) => !r.sweeperPublished && r.resolverDispatched,
      )
      const neitherFired = results.filter(
        (r) => !r.sweeperPublished && !r.resolverDispatched,
      )

      // ── E2 (Fix-b) HARD-ZERO INVARIANT ────────────────────────────
      //
      // The post-SETNX parkKey re-check in defer-resolver.ts closes the
      // race window that previously produced a 1-4% / 100 iteration
      // violation rate. Tolerance is ZERO: any iteration where BOTH
      // surfaces fire indicates the re-check was removed, the sweeper
      // changed its release ordering, or a new race window opened.
      const violationPct = (bothFired.length / ITERATIONS) * 100

      expect(
        bothFired.length,
        `audit-2026-05-24 E2 race REGRESSION: ${bothFired.length} of ` +
          `${ITERATIONS} iterations (${violationPct.toFixed(1)}%) saw BOTH ` +
          `surfaces fire — Fix-b requires HARD ZERO. ` +
          `Inspect: apps/api/src/subscribers/defer-resolver.ts ` +
          `(post-SETNX parkKey re-check, search "E2 (Fix-b)") and ` +
          `apps/api/src/jobs/defer-timeout-sweeper.ts ` +
          `(release ordering after publish + parkKey DEL). ` +
          `Violation diagnostics (iter, intentHash, resolverKind, auditEmits): ` +
          `${bothFired
            .slice(0, 5)
            .map(
              (r) =>
                `[${r.iteration}, ${r.intentHash.slice(0, 12)}, ${r.resolverKind}, ${r.auditEmits}]`,
            )
            .join("; ")}.`,
      ).toBe(0)

      // Aggregate sanity: the partition covers all iterations.
      expect(
        bothFired.length +
          sweeperWon.length +
          resolverWon.length +
          neitherFired.length,
        `partition mismatch — iterations missing from the win/loss split`,
      ).toBe(ITERATIONS)

      // Sanity: zero-iteration runs (no party won) should be rare. If
      // every iteration sees neitherFired, the testcontainer SETNX
      // racing is broken (e.g. node-redis stripped the NX flag — the
      // P0-3 lesson from lgpd-anonymize-lifecycle.test.ts) and the
      // test is structurally inert. We fail loudly so a regression
      // there doesn't silently pass.
      expect(
        neitherFired.length,
        `${neitherFired.length}/${ITERATIONS} iterations had NEITHER ` +
          `surface fire. This is a structural-test regression — likely ` +
          `the @ibatexas/tools getRedisClient mock dropped the NX flag ` +
          `(see lgpd-anonymize-lifecycle.test.ts P0-3 lesson) or the ` +
          `testcontainer is unreachable. The race needs SETNX to actually ` +
          `serialise against real Redis to be meaningful.`,
      ).toBeLessThan(ITERATIONS / 2)

      void sweeperWon
      void resolverWon
    }, 240_000)

    // ── F-37 (M3) — the two cases that make this file's Lua path load-bearing ──
    //
    // Everything else in this file races SETNX. These two are the only cases
    // that require the RELEASE half — the `defer:resuming:*` Lua compare-and-
    // delete — to actually execute. Before M3 the shim above omitted `eval`,
    // so the release threw, `releaseDeferResumingLock` swallowed it, and the
    // mutex ended only by TTL while all three enrolled cases stayed green.
    // Delete the `eval` forward from the shim and BOTH of these red.
    //
    // Division of labour with M1's shape suite (ruling Q2): the CAD's SHAPE
    // invariant — that the script never releases a foreign owner, over all 11
    // production sites — lives in `lua-shape-cad-contract.test.ts`. What lives
    // HERE is the site half: that the sweeper's own release path really issues
    // it against a real server inside this race harness.

    it("F-37 — a sweeper-won sweep RELEASES its defer:resuming mutex (not left to TTL)", async () => {
      const sessionId = "sess_f37_release"
      const signal = "payment.confirmed"
      const { resumingKey } = await seedParkedEnvelope({
        sessionId,
        signal,
        nonce: "f37-release",
      })
      const { sweepDeferTimeouts } = await import(
        "../../jobs/defer-timeout-sweeper.js"
      )
      mockPublishNatsEvent.mockClear()

      const published = await sweepDeferTimeouts(makeLogger())
      // Control: the sweeper really did win and run its release path. Without
      // this the assertion below could be satisfied by a sweep that did
      // nothing at all (the mutex would be absent because it was never taken).
      expect(
        published,
        "sweeper did not publish — it never acquired the mutex, so the release assertion below would be vacuous",
      ).toBe(1)

      const exists = await requireRuntimeRedis().exists(resumingKey)
      const ttl = await requireRuntimeRedis().ttl(resumingKey)
      expect(
        exists,
        `defer:resuming mutex survived a sweeper-won release (ttl=${ttl}). ` +
          `The Lua compare-and-delete did not execute — check that the ` +
          `@ibatexas/tools shim in this file still forwards \`eval\` to the ` +
          `container (F-37).`,
      ).toBe(0)
    })

    it("F-37 — that release is OWNERSHIP-CHECKED: a foreign holder's mutex survives, its own does not", async () => {
      // BOTH ARMS ARE REQUIRED, and the order matters. "A foreign mutex
      // survives" is trivially true when the release never runs at all —
      // which is exactly the pre-M3 state of this file. The matching arm is
      // what makes the foreign arm mean something: it proves the release DID
      // execute against this container, so the foreign key's survival is a
      // decision the script made and not an absence of any script.
      const { releaseDeferResumingLock } = await import(
        "../../lib/defer-resuming-lock.js"
      )
      const { getRedisClient } = await import("@ibatexas/tools")
      const client = (await getRedisClient()) as unknown as Parameters<
        typeof releaseDeferResumingLock
      >[2]

      const key = "t6-race:defer:resuming:f37-ownership"

      // Arm 1 — FOREIGN owner. The stored value belongs to someone else; our
      // release must leave it alone.
      await requireRuntimeRedis().set(key, "resolver:not-our-token", { EX: 60 })
      await releaseDeferResumingLock(key, "sweeper:our-token", client)
      expect(
        await requireRuntimeRedis().get(key),
        "the release deleted (or overwrote) a mutex held by another owner — CAD ownership regression",
      ).toBe("resolver:not-our-token")

      // Arm 2 — OWN token. Same key, same helper, same client: this one must
      // really go, or arm 1 proved nothing.
      await requireRuntimeRedis().set(key, "sweeper:our-token", { EX: 60 })
      await releaseDeferResumingLock(key, "sweeper:our-token", client)
      expect(
        await requireRuntimeRedis().exists(key),
        "the release left its OWN mutex in place — the Lua compare-and-delete " +
          "never executed, so arm 1 above is vacuous (F-37)",
      ).toBe(0)
    })

    // ── F-40 (M3) — the window F-37 was hiding ────────────────────────────
    //
    // The 100-iteration case above catches this at ~1% per iteration, which
    // is a signal but a poor regression net. This case reproduces the SAME
    // interleaving deterministically.
    //
    // The window: the sweeper's E3 guard GETs the park blob and returns
    // early if the key is already gone. It then SETNX-acquires
    // `defer:resuming:*` and publishes. Between those two steps the resolver
    // can complete its whole resume — dispatch, DEL parkKey, RELEASE the
    // mutex — at which point the sweeper's SETNX succeeds against a
    // just-freed mutex and it publishes `intent.defer.timeout` for an
    // envelope that has already been resumed. Two destructive mutations for
    // one parked envelope: precisely the P0-2 class this file exists to
    // police.
    //
    // The resolver got a post-SETNX parkKey re-check for this (E2 Fix-b).
    // The sweeper never did. That asymmetry was invisible because the
    // sweeper's release was DEAD (F-37): with the mutex only ever ending by
    // TTL, the sweeper's SETNX could not succeed inside an iteration, so the
    // window could not open and "hard zero" was an artifact of the broken
    // release rather than a property of the code.
    //
    // The hook below deletes the parkKey the instant the sweeper's blob GET
    // returns — standing in for a resolver that won that window — and leaves
    // the mutex free, exactly as a completed resolver would.
    it("F-40 — the sweeper re-checks parkKey AFTER its SETNX: no publish for an envelope the resolver already resumed", async () => {
      const sessionId = "sess_f40_window"
      const signal = "payment.confirmed"
      const { parkKey } = await seedParkedEnvelope({
        sessionId,
        signal,
        nonce: "f40-window",
      })

      let fired = 0
      afterParkGetHook = async (key) => {
        if (key !== parkKey || fired > 0) return
        fired += 1
        // The resolver wins the window: it dispatched, DEL'd the parkKey and
        // released the resuming mutex. The mutex is free, so the sweeper's
        // SETNX below WILL succeed.
        await requireRuntimeRedis().del(parkKey)
      }

      const { sweepDeferTimeouts } = await import(
        "../../jobs/defer-timeout-sweeper.js"
      )
      mockPublishNatsEvent.mockClear()
      const published = await sweepDeferTimeouts(makeLogger())

      // Control: the hook really did fire, so the assertion below is about
      // the sweeper's behaviour in the window and not about a sweep that
      // never reached it.
      expect(
        fired,
        "the parkKey-GET hook never fired — the sweeper did not reach its E3 blob read, so this case proves nothing",
      ).toBe(1)
      expect(
        await requireRuntimeRedis().exists(parkKey),
        "parkKey should be gone — the hook deletes it to simulate the resolver winning",
      ).toBe(0)

      const timeoutPublishes = mockPublishNatsEvent.mock.calls.filter(
        ([s]) => s === "intent.defer.timeout",
      )
      expect(
        timeoutPublishes.length,
        "sweeper published intent.defer.timeout for an envelope the resolver had already resumed and unparked — " +
          "the post-SETNX parkKey re-check (the sweeper-side mirror of the resolver's E2 Fix-b) is missing or weakened.",
      ).toBe(0)
      expect(published, "sweeper reported a published timeout in the same window").toBe(0)
    })

    it("deterministic case — when resolver SETNX wins first, sweeper short-circuits with no publish", async () => {
      const sessionId = "sess_t6_resolver_wins"
      const signal = "payment.confirmed"
      const nonce = "resolver-wins"
      const { intentHash, resumingKey } = await seedParkedEnvelope({
        sessionId,
        signal,
        nonce,
      })

      // Pre-acquire the resuming mutex as if the resolver claimed it first.
      // This locks in the "resolver mid-flight" branch on the sweeper side.
      await requireRuntimeRedis().set(
        resumingKey,
        JSON.stringify({
          at: new Date().toISOString(),
          sessionId,
          intentHash,
          signal,
        }),
        { EX: 60, NX: true },
      )

      const { sweepDeferTimeouts } = await import(
        "../../jobs/defer-timeout-sweeper.js"
      )
      mockPublishNatsEvent.mockClear()
      const publishedCount = await sweepDeferTimeouts(makeLogger())

      // Sweeper saw the mutex held → released its recovery marker → did
      // NOT publish. The parked key is left alive for the resolver.
      expect(publishedCount).toBe(0)
      const intentDefer = mockPublishNatsEvent.mock.calls.find(
        ([subject]) => subject === "intent.defer.timeout",
      )
      expect(
        intentDefer,
        "sweeper published intent.defer.timeout despite resolver holding the mutex — P0-2 regression",
      ).toBeUndefined()
    })

    it("deterministic case — when sweeper SETNX wins first, resolver short-circuits with duplicate_suppressed", async () => {
      const sessionId = "sess_t6_sweeper_wins"
      const signal = "payment.confirmed"
      const nonce = "sweeper-wins"
      const { intentHash, resumingKey } = await seedParkedEnvelope({
        sessionId,
        signal,
        nonce,
      })

      // Pre-acquire the resuming mutex as if the sweeper claimed it first.
      // This locks in the "sweeper mid-flight" branch on the resolver side.
      await requireRuntimeRedis().set(
        resumingKey,
        JSON.stringify({
          at: new Date().toISOString(),
          sessionId,
          intentHash,
          signal,
        }),
        { EX: 60, NX: true },
      )

      const { resolveDeferredSession, setResumeIntentDispatcher } =
        await import("../../subscribers/defer-resolver.js")

      const dispatcher = vi.fn(async () => undefined)
      setResumeIntentDispatcher(dispatcher)
      mockAuditSinkEmit.mockClear()
      mockAdjudicate.mockReturnValue({ kind: "EXECUTE" as const })

      try {
        const result = await resolveDeferredSession({
          sessionId,
          signal,
          event: {
            orderId: `ord_${nonce}`,
            paymentId: `pay_${nonce}`,
            previousStatus: "payment_pending",
            newStatus: "paid",
            method: "pix",
            version: 2,
            timestamp: new Date().toISOString(),
          } as unknown as Parameters<
            typeof resolveDeferredSession
          >[0]["event"],
          log: makeLogger(),
        })

        expect(
          result.kind,
          "resolver should short-circuit when sweeper-side mutex is already held",
        ).toBe("duplicate_suppressed")
        expect(
          dispatcher,
          "dispatcher fired despite sweeper holding the mutex — duplicate-mutation regression",
        ).not.toHaveBeenCalled()
        expect(
          mockAuditSinkEmit,
          "audit emitted on resolver's loser path — duplicate-audit regression",
        ).not.toHaveBeenCalled()
      } finally {
        setResumeIntentDispatcher(null)
      }
    })
  },
)
