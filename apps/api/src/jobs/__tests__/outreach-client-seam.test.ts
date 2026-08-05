// R5 rollout, family 2 — the outreach jobs' Redis-client seam, BORN GUARDED.
//
// The family: every background job whose output is a customer-facing WhatsApp
// message (or the event that produces one), where a Redis key is the only thing
// suppressing a duplicate or unwanted send —
//
//   jobs/weather-helper.ts        `WeatherCacheRedis`
//   jobs/reservation-reminder.ts  `ReservationReminderRedis`
//   jobs/hesitation-nudge.ts      `NudgeProcessorRedis` / `MarkRepliedRedis`
//   jobs/pix-expiry-monitor.ts    `PixPaidReadRedis` / `PixPaidWriteRedis` /
//                                 `PixExpiryProcessorRedis`
//   jobs/proactive-engagement.ts  `OutreachRedis`
//   jobs/abandoned-cart-checker.ts `AbandonedCartRedis`
//
// ── Why the control/treatment pair ───────────────────────────────────────────
//
// A seam test that only injects a client proves NOTHING: the module could ignore
// the argument and resolve the singleton, and every assertion would still pass
// because the test's own double IS the singleton. So this file runs two DISTINCT
// clients, exactly as `subscribers/__tests__/defer-resolver-client-seam.test.ts`
// does:
//
//   - `decoy`    — what `getRedisClient()` returns. Nothing in an injected case
//                  may touch it.
//   - `injected` — what the seam is handed.
//
// Every injected case asserts the work landed on `injected` AND that `decoy` was
// never touched. Delete a module's `?? (await getRedisClient())` threading and it
// silently falls back to `decoy`: `injected` goes untouched and the case reds on
// the property in its own title. That is the revert-to-red.
//
// Each module ALSO carries a DEFAULT case — call it with no deps, and the decoy
// MUST be what gets used. Without that arm the injected cases are compatible with
// a module that resolves nothing at all.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing"
import type { Job } from "bullmq"

// Assigned in beforeEach. The `vi.mock` factory closes over it LAZILY — it is
// only read when `getRedisClient()` is actually CALLED, which in a correctly
// threaded + injected call is never.
let decoy: InMemoryRedis

const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockSendText = vi.hoisted(() => vi.fn())
const mockFindDormantCustomers = vi.hoisted(() => vi.fn())
const mockFindConfirmedForDate = vi.hoisted(() => vi.fn())
const mockGetCustomerById = vi.hoisted(() => vi.fn())
const mockGetByStripePaymentIntentId = vi.hoisted(() => vi.fn())
const mockSendReservationReminder = vi.hoisted(() => vi.fn())
const mockMedusaAdmin = vi.hoisted(() => vi.fn())
const mockShouldSuppress = vi.hoisted(() => vi.fn())
const mockFetch = vi.hoisted(() => vi.fn())

// Spread the REAL module and replace ONLY the client resolver (plus the two
// HTTP edges). `rk` stays REAL — Hard Rule #7 — so every key under assertion is
// the key production writes. Under apps/api's vitest that prefix is
// `development:`, which is precisely what the retired doubles in this family
// faked as `test:`.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>()
  return {
    ...real,
    getRedisClient: vi.fn(async () => decoy.client),
    medusaAdmin: mockMedusaAdmin,
    sendReservationReminder: mockSendReservationReminder,
  }
})

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
  subscribeNatsEvent: vi.fn(async () => {}),
}))

vi.mock("@ibatexas/domain", async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return {
    ...real,
    createCustomerService: vi.fn(() => ({
      findDormantCustomers: mockFindDormantCustomers,
      getById: mockGetCustomerById,
    })),
    createReservationService: vi.fn(() => ({
      findConfirmedForDate: mockFindConfirmedForDate,
    })),
    createPaymentQueryService: vi.fn(() => ({
      getByStripePaymentIntentId: mockGetByStripePaymentIntentId,
    })),
  }
})

vi.mock("../../whatsapp/client.js", () => ({
  sendText: mockSendText,
  getWhatsAppSender: vi.fn(() => "whatsapp:+15550001111"),
}))

vi.mock("../../broadcast/broadcast-optout.js", () => ({
  shouldSuppressPromotionalSend: mockShouldSuppress,
}))

/** Captures what each `startX()` actually registers as its BullMQ processor. */
const registeredProcessors = vi.hoisted(
  () => new Map<string, (job: unknown, token?: unknown) => unknown>(),
)

// Only the BullMQ FACTORIES are replaced. `assertDepsBag` is spread through
// REAL — it is the guard under test two describes down, and a stubbed copy
// would be testing the stub.
vi.mock("../queue.js", async (orig) => {
  const real = await orig<typeof import("../queue.js")>()
  return {
    ...real,
    createQueue: vi.fn(() => ({ upsertJobScheduler: vi.fn(), close: vi.fn(), add: vi.fn() })),
    createWorker: vi.fn((name: string, processor: (job: unknown, token?: unknown) => unknown) => {
      registeredProcessors.set(name, processor)
      return { on: vi.fn(), close: vi.fn() }
    }),
  }
})

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (scope: unknown) => void) => {
    cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() })
  }),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}))

/** `Job<T>` narrowed to the one field every processor in this family reads. */
function jobOf<T>(data: T): Job<T> {
  return { data } as unknown as Job<T>
}

beforeEach(() => {
  vi.clearAllMocks()
  registeredProcessors.clear()
  decoy = createInMemoryRedis()
  mockSendText.mockResolvedValue(undefined)
  mockPublishNatsEvent.mockResolvedValue(undefined)
  mockShouldSuppress.mockResolvedValue(false)
  mockFindDormantCustomers.mockResolvedValue([])
  mockFindConfirmedForDate.mockResolvedValue([])
  mockGetByStripePaymentIntentId.mockResolvedValue(null)
  mockMedusaAdmin.mockResolvedValue({ order: { metadata: {} } })
  vi.stubGlobal("fetch", mockFetch)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ── weather-helper — WeatherCacheRedis {get, set} ────────────────────────────

describe("seam — fetchWeatherCondition drives the INJECTED client", () => {
  beforeEach(() => {
    vi.stubEnv("RESTAURANT_LAT", "-23.55")
    vi.stubEnv("RESTAURANT_LNG", "-46.63")
  })

  it("reads the cache from the injected keyspace and never touches the singleton", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis()
    await injected.client.set(rk("weather:current"), JSON.stringify({ condition: "rain" }))
    const { fetchWeatherCondition } = await import("../weather-helper.js")

    const result = await fetchWeatherCondition({ redis: injected.client })

    expect(result).toBe("rain")
    // A cache HIT means fetch was never reached — so the value really came out
    // of the injected keyspace, not out of a stubbed HTTP response.
    expect(mockFetch).not.toHaveBeenCalled()
    expect(decoy.calls).toHaveLength(0)
  })

  it("WRITES the fetched condition to the injected keyspace, under the REAL rk()", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis()
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ current: { rain: 3, temperature_2m: 20 } }),
    })
    const { fetchWeatherCondition } = await import("../weather-helper.js")

    expect(await fetchWeatherCondition({ redis: injected.client })).toBe("rain")

    // The cache SET is inside the module's swallowing catch, so asserting the
    // verdict alone cannot tell an injected write from no write at all.
    const stored = injected.peek(rk("weather:current"))
    expect(stored).toBeDefined()
    expect(JSON.parse(stored!)).toMatchObject({ condition: "rain" })
    expect(decoy.calls).toHaveLength(0)
  })

  it("resolves the singleton when NO client is threaded (the default is preserved)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ current: { rain: 0, temperature_2m: 20 } }),
    })
    const { fetchWeatherCondition } = await import("../weather-helper.js")

    expect(await fetchWeatherCondition()).toBe("normal")

    // The control for the two cases above: with no client the module MUST fall
    // back, so the decoy is what gets used.
    expect(decoy.calls.map((c) => c.command)).toContain("get")
    expect(decoy.calls.map((c) => c.command)).toContain("set")
  })
})

// ── reservation-reminder — ReservationReminderRedis {set} ────────────────────

describe("seam — sendReminders drives the INJECTED client", () => {
  const RESERVATION = {
    id: "res_1",
    customerId: "cust_1",
    partySize: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    timeSlot: { id: "ts_1", startTime: "19:00", durationMinutes: 90 },
  }

  it("claims the idempotency key on the injected keyspace, not the singleton", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis()
    mockFindConfirmedForDate.mockResolvedValue([RESERVATION])
    mockGetCustomerById.mockResolvedValue({ phone: "+5511999990001" })
    const { sendReminders } = await import("../reservation-reminder.js")

    await sendReminders(null, { redis: injected.client })

    expect(injected.peek(rk("reminder:sent:res_1"))).toBe("1")
    expect(mockSendReservationReminder).toHaveBeenCalledTimes(1)
    expect(decoy.calls).toHaveLength(0)
  })

  it("the NX claim is REAL: a second run over the same injected keyspace sends nothing", async () => {
    const injected = createInMemoryRedis()
    mockFindConfirmedForDate.mockResolvedValue([RESERVATION])
    mockGetCustomerById.mockResolvedValue({ phone: "+5511999990001" })
    const { sendReminders } = await import("../reservation-reminder.js")

    await sendReminders(null, { redis: injected.client })
    await sendReminders(null, { redis: injected.client })

    // The retired double answered a constant "OK", so the guard this job exists
    // to provide could not be exercised at all.
    expect(mockSendReservationReminder).toHaveBeenCalledTimes(1)
    expect(decoy.calls).toHaveLength(0)
  })

  it("resolves the singleton when NO client is threaded (the default is preserved)", async () => {
    mockFindConfirmedForDate.mockResolvedValue([RESERVATION])
    mockGetCustomerById.mockResolvedValue({ phone: "+5511999990001" })
    const { sendReminders } = await import("../reservation-reminder.js")

    await sendReminders(null)

    expect(decoy.calls.map((c) => c.command)).toContain("set")
  })
})

// ── hesitation-nudge — NudgeProcessorRedis {get,del} / MarkRepliedRedis {set} ─

describe("seam — the hesitation nudge drives the INJECTED client", () => {
  const NUDGE = { phone: "+5511999990001", phoneHash: "hash_1", customerId: "cust_1" }

  it("markCustomerReplied writes the replied marker to the injected keyspace", async () => {
    const { rk } = await import("@ibatexas/tools")
    // A FROZEN clock, not `Date.now`. The TTL assertion below is an EXACT
    // remaining lifetime, which is the point — `toBeGreaterThan(0)` cannot tell
    // a 120s marker from a 120ms one. Against a wall clock that equality is a
    // flake, and it FAILED that way in the full-suite run (132ms elapsed between
    // the module's SET and this read, so 120_000 read back as 119_868). The
    // isolated run passed, which is what makes this class worth a comment.
    const injected = createInMemoryRedis({ now: () => 1_700_000_000_000 })
    const { markCustomerReplied } = await import("../hesitation-nudge.js")

    await markCustomerReplied("hash_1", { redis: injected.client })

    expect(injected.peek(rk("wa:nudge:replied:hash_1"))).toBe("1")
    expect(injected.ttlMs(rk("wa:nudge:replied:hash_1"))).toBe(120_000)
    expect(decoy.calls).toHaveLength(0)
  })

  it("processNudge READS the marker markCustomerReplied wrote, and CONSUMES it", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis()
    const { markCustomerReplied, processNudge } = await import("../hesitation-nudge.js")

    // The two entry points take DISJOINT client types, but one keyspace: the key
    // the writer writes is the key the processor reads. A pair of constant stubs
    // never connects them, so "a customer who replied is not nudged" was never
    // actually tested.
    await markCustomerReplied("hash_1", { redis: injected.client })
    await processNudge(jobOf(NUDGE), { redis: injected.client })

    expect(mockSendText).not.toHaveBeenCalled()
    // The processor DELETES the marker it consumed.
    expect(injected.peek(rk("wa:nudge:replied:hash_1"))).toBeUndefined()
    expect(decoy.calls).toHaveLength(0)
  })

  it("processNudge SENDS when the injected keyspace carries no marker", async () => {
    const injected = createInMemoryRedis()
    const { processNudge } = await import("../hesitation-nudge.js")

    await processNudge(jobOf(NUDGE), { redis: injected.client })

    // The control for the case above: without it, "not nudged" could be green
    // because the processor never sends at all.
    expect(mockSendText).toHaveBeenCalledTimes(1)
    expect(decoy.calls).toHaveLength(0)
  })

  it("resolves the singleton when NO client is threaded (the default is preserved)", async () => {
    const { markCustomerReplied, processNudge } = await import("../hesitation-nudge.js")

    await markCustomerReplied("hash_default")
    await processNudge(jobOf(NUDGE))

    const commands = decoy.calls.map((c) => c.command)
    expect(commands).toContain("set")
    expect(commands).toContain("get")
  })
})

// ── pix-expiry-monitor — and the DOWNSTREAM half of the fail-closed Pick ─────

describe("seam — the PIX expiry monitor drives the INJECTED client", () => {
  const PI = "pi_seam"
  const job = (stage: "reminder" | "expired") =>
    jobOf({ phone: "+5511999990001", phoneHash: "h", paymentIntentId: PI, stage })

  it("markPixPaid writes, and isPixPaid READS, the same injected key", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis()
    const { markPixPaid, isPixPaid } = await import("../pix-expiry-monitor.js")

    await markPixPaid(PI, { redis: injected.client })

    expect(injected.peek(rk(`pix:paid:${PI}`))).toBe("1")
    expect(await isPixPaid(PI, { redis: injected.client })).toBe(true)
    expect(decoy.calls).toHaveLength(0)
  })

  it("processPixExpiry's paid-check runs on the client IT was handed (the union Pick)", async () => {
    const injected = createInMemoryRedis()
    const { markPixPaid, processPixExpiry } = await import("../pix-expiry-monitor.js")

    await markPixPaid(PI, { redis: injected.client })
    await processPixExpiry(job("expired"), { redis: injected.client })

    // `processPixExpiry` never issues `get` itself — `isPixPaid` does, on the
    // threaded client. If the client did NOT thread through, the paid flag on
    // `injected` would be invisible and the customer who already paid would get
    // "O PIX expirou".
    expect(mockSendText).not.toHaveBeenCalled()
    expect(decoy.calls).toHaveLength(0)
  })

  it("the per-stage NX send claim is REAL on the injected keyspace", async () => {
    const injected = createInMemoryRedis()
    const { processPixExpiry } = await import("../pix-expiry-monitor.js")

    await processPixExpiry(job("reminder"), { redis: injected.client })
    await processPixExpiry(job("reminder"), { redis: injected.client })
    await processPixExpiry(job("expired"), { redis: injected.client })

    // Two runs of the SAME stage send once (the claim held); the other stage is
    // a distinct key and sends. The retired double answered `set` from a
    // per-case `mockResolvedValue`, so the claim's keyspace was never involved.
    expect(mockSendText).toHaveBeenCalledTimes(2)
    expect(decoy.calls).toHaveLength(0)
  })

  it("resolves the singleton when NO client is threaded (the default is preserved)", async () => {
    const { processPixExpiry } = await import("../pix-expiry-monitor.js")

    await processPixExpiry(job("reminder"))

    const commands = decoy.calls.map((c) => c.command)
    expect(commands).toContain("get")
    expect(commands).toContain("set")
  })
})

// ── proactive-engagement — OutreachRedis {exists,hGetAll,set,incr,expire} ────

describe("seam — checkDormantCustomers drives the INJECTED client", () => {
  const CUSTOMER = { id: "cust_a", phone: "+5511999990001", name: "Ana" }

  beforeEach(() => {
    vi.useFakeTimers()
    // 11:00 in São Paulo (UTC-3) — inside the lunch outreach window.
    vi.setSystemTime(new Date("2026-01-15T14:00:00Z"))
    mockMedusaAdmin.mockResolvedValue({ product: { title: "Costela" } })
  })

  it("writes the cooldown and the weekly counter to the injected keyspace", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => Date.now() })
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER])
    const { checkDormantCustomers } = await import("../proactive-engagement.js")

    await checkDormantCustomers(null, { redis: injected.client })

    expect(mockSendText).toHaveBeenCalledTimes(1)
    expect(injected.peek(rk("outreach:last:cust_a"))).toBe("1")
    expect(injected.peek(rk("outreach:weekly:count"))).toBe("1")
    // The counter's TTL is set only on the FIRST incr — a property no constant
    // stub can express.
    expect(injected.ttlMs(rk("outreach:weekly:count"))).toBe(7 * 86_400_000)
    expect(decoy.calls).toHaveLength(0)
  })

  it("the cooldown is REAL: a second run over the same injected keyspace sends nothing", async () => {
    const injected = createInMemoryRedis({ now: () => Date.now() })
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER])
    const { checkDormantCustomers } = await import("../proactive-engagement.js")

    await checkDormantCustomers(null, { redis: injected.client })
    await checkDormantCustomers(null, { redis: injected.client })

    expect(mockSendText).toHaveBeenCalledTimes(1)
    expect(decoy.calls).toHaveLength(0)
  })

  it("weather-helper keeps its OWN resolution — the seams are not collapsed", async () => {
    const injected = createInMemoryRedis({ now: () => Date.now() })
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER])
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ current: { rain: 0, temperature_2m: 20 } }),
    })
    vi.stubEnv("RESTAURANT_LAT", "-23.55")
    vi.stubEnv("RESTAURANT_LNG", "-46.63")
    const { checkDormantCustomers } = await import("../proactive-engagement.js")

    await checkDormantCustomers(null, { redis: injected.client })

    // Folding `fetchWeatherCondition` onto the caller's client would drop the
    // default path's singleton resolutions from two to one — a behaviour change
    // under a refactor. The decoy touch here IS that second resolution, and it
    // is deliberate: the weather cache is a SEPARATE seam.
    expect(decoy.calls.map((c) => c.command)).toContain("get")
    // ...and the outreach guards still landed on the injected client only.
    expect(injected.calls.map((c) => c.command)).toContain("incr")
    expect(decoy.calls.map((c) => c.command)).not.toContain("incr")
  })

  it("resolves the singleton when NO client is threaded (the default is preserved)", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER])
    const { checkDormantCustomers } = await import("../proactive-engagement.js")

    await checkDormantCustomers(null)

    expect(decoy.calls.map((c) => c.command)).toContain("exists")
    expect(decoy.calls.map((c) => c.command)).toContain("incr")
  })
})

// ── abandoned-cart-checker — the fail-closed Pick's DOWNSTREAM half ──────────

describe("seam — checkAbandonedCarts drives the INJECTED client", () => {
  /** Seed one idle cart with a non-empty session history, all on ONE client. */
  async function seedIdleCart(redis: InMemoryRedis, cartId: string): Promise<void> {
    const { rk } = await import("@ibatexas/tools")
    await redis.client.hSet(
      rk("active:carts"),
      cartId,
      JSON.stringify({
        cartId,
        sessionType: "guest",
        // 3h idle — past the 2h threshold.
        lastActivity: Date.now() - 3 * 60 * 60 * 1000,
      }),
    )
    // The history `loadSession` reads, written the way `appendMessages` writes it.
    await redis.client.rPush(
      rk(`session:${cartId}`),
      JSON.stringify({ role: "user", content: "oi" }),
    )
  }

  it("walks active:carts on the injected keyspace and publishes cart.abandoned", async () => {
    const injected = createInMemoryRedis()
    await seedIdleCart(injected, "cart_01")
    const { checkAbandonedCarts } = await import("../abandoned-cart-checker.js")

    await checkAbandonedCarts(null, { redis: injected.client })

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.abandoned",
      expect.objectContaining({ cartId: "cart_01", sessionType: "guest" }),
    )
    expect(decoy.calls).toHaveLength(0)
  })

  it("the session history is read from the INJECTED client, through the real loadSession", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis()
    await seedIdleCart(injected, "cart_02")
    const { checkAbandonedCarts } = await import("../abandoned-cart-checker.js")

    await checkAbandonedCarts(null, { redis: injected.client })

    // `session/store.ts` is NOT mocked here. Its LRANGE is what proves the
    // client threads all the way through `loadSession`'s own options bag.
    const lRangeKeys = injected.calls
      .filter((c) => c.command === "lRange")
      .map((c) => c.args[0])
    expect(lRangeKeys).toContain(rk("session:cart_02"))
    expect(decoy.calls).toHaveLength(0)
  })

  it("[fail-closed Pick] a client WITHOUT lRange kills every publish while the sweep reports success", async () => {
    const injected = createInMemoryRedis()
    await seedIdleCart(injected, "cart_03")
    await seedIdleCart(injected, "cart_04")

    // A spy-DELEGATE over the adapter — every command forwards to the real
    // adapter — except `lRange`, which is REMOVED. That is exactly the client a
    // Pick declaring only the commands this module ISSUES would accept.
    const narrowed = new Proxy(injected.client, {
      get(target, prop) {
        if (prop === "lRange") return undefined
        return Reflect.get(target, prop) as unknown
      },
    })

    const errors: unknown[] = []
    const log = {
      error: (...args: unknown[]) => errors.push(args),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const { checkAbandonedCarts } = await import("../abandoned-cart-checker.js")

    // The measurement: it RESOLVES. Nothing throws to BullMQ.
    await expect(
      checkAbandonedCarts(log as never, {
        redis: narrowed as unknown as Parameters<typeof checkAbandonedCarts>[1] extends
          | { redis?: infer R }
          | undefined
          ? R
          : never,
      }),
    ).resolves.toBeUndefined()

    // ...and NOT ONE cart.abandoned was published, for either seeded cart.
    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
    expect(errors).toHaveLength(2)
    expect(decoy.calls).toHaveLength(0)
  })

  it("resolves the singleton when NO client is threaded (the default is preserved)", async () => {
    await seedIdleCart(decoy, "cart_default")
    const { checkAbandonedCarts } = await import("../abandoned-cart-checker.js")

    await checkAbandonedCarts(null)

    expect(decoy.calls.map((c) => c.command)).toContain("hScan")
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.abandoned",
      expect.objectContaining({ cartId: "cart_default" }),
    )
  })
})

// ── The BullMQ deps-slot collision ──────────────────────────────────────────
//
// Two of this family's entry points are BullMQ PROCESSORS, and a deps bag in
// their second positional slot collides with how BullMQ actually calls them.
// `queue.ts` types the processor as `(job) => Promise<void>`, but BullMQ invokes
// it as `(job, token)` with a lock-token STRING. Registering the processor
// directly puts that string where `deps` goes.
//
// The collision is SILENT by default — `("tok").redis` is `undefined`, so the
// module falls back to the singleton and nothing observable changes — which is
// exactly why a naive test cannot see it. Two dead ends, recorded because both
// look convincing:
//
//   • `processor.length === 1`. VACUOUS: a parameter with a DEFAULT does not
//     count toward `Function.length`, so `processNudge(job, deps = {})` already
//     has length 1. This assertion was written first and passed GREEN against
//     the bare registration.
//   • "drive it with a token and assert the singleton was used". Also vacuous —
//     that is what BOTH spellings do today.
//
// So the guard had to be made observable rather than merely asserted:
// `assertDepsBag` (in queue.ts) THROWS on a non-object deps. The pair below is
// control/treatment over that — the treatment proves the guard is live, the
// control proves the registered wrapper actually satisfies it.

describe("seam — a BullMQ lock token cannot reach the deps slot", () => {
  const nudgeJob = () => jobOf({ phone: "+5511999990001", phoneHash: "h", customerId: "c" })
  const pixJob = () =>
    jobOf({
      phone: "+5511999990001",
      phoneHash: "h",
      paymentIntentId: "pi_tok",
      stage: "reminder" as const,
    })

  it("[treatment] the BARE processor REFUSES a lock token instead of degrading silently", async () => {
    const { processNudge } = await import("../hesitation-nudge.js")
    const { processPixExpiry } = await import("../pix-expiry-monitor.js")

    // Precisely what BullMQ does to a bare registration.
    await expect(
      (processNudge as unknown as (j: unknown, t: unknown) => Promise<void>)(nudgeJob(), "tok-1"),
    ).rejects.toThrow(/deps must be an options object, got string/)
    await expect(
      (processPixExpiry as unknown as (j: unknown, t: unknown) => Promise<void>)(pixJob(), "tok-2"),
    ).rejects.toThrow(/deps must be an options object, got string/)

    // The refusal happens BEFORE any client is resolved — it is a wiring error,
    // not a Redis one.
    expect(decoy.calls).toHaveLength(0)
  })

  it("[control] what each start() REGISTERS survives the token BullMQ passes it", async () => {
    const { startHesitationNudgeWorker, stopHesitationNudgeWorker } = await import(
      "../hesitation-nudge.js"
    )
    const { startPixExpiryMonitor, stopPixExpiryMonitor } = await import("../pix-expiry-monitor.js")
    startHesitationNudgeWorker()
    startPixExpiryMonitor()

    const nudge = registeredProcessors.get("hesitation-nudge")
    const pix = registeredProcessors.get("pix-expiry-monitor")
    expect(nudge).toBeDefined()
    expect(pix).toBeDefined()

    // Without this arm the treatment above is compatible with a registration
    // that is ALSO broken — it would prove the guard fires, not that production
    // clears it. Register either processor bare and this reds.
    await expect(nudge!(nudgeJob(), "tok-1")).resolves.toBeUndefined()
    await expect(pix!(pixJob(), "tok-2")).resolves.toBeUndefined()
    // ...and both ran, on the singleton, exactly as production does.
    expect(decoy.calls.map((c) => c.command)).toContain("get")

    await stopHesitationNudgeWorker()
    await stopPixExpiryMonitor()
  })
})
