// R5 rollout, webhook/chat family — `routes/stripe-webhook.ts`'s Redis-client
// seam, BORN GUARDED.
//
// This module is the family's MONEY path and its two Redis sites sit on
// OPPOSITE sides of a queue:
//
//   plugin POST   `set` + `expire`   the 7-day idempotency claim, and its
//                                    downgrade when the enqueue fails
//   dispatch      `hDel`             the pending-orders cleanup, on the BullMQ
//                                    worker inside handlePaymentSucceeded
//
// One dep member reaches both, because `StripeWebhookRouteDeps` already spans
// them: the plugin resolves the set once per registration and closes over it
// for the processor, and `dispatchStripeWebhookEvent` takes it as a parameter.
// Both halves are driven below, because a seam proven on one side says nothing
// about the other.
//
// ── Directional pins, not happy paths ────────────────────────────────────────
//
// A money path earns pins on what FAILS CLOSED, so every directional case here
// asserts a property that a broken gate would violate in a specific, costly
// direction:
//
//   1. REPLAY SUPPRESSION — the same Stripe event id twice must enqueue the
//      work exactly ONCE. A 200 alone proves nothing (a route that refuses
//      everything also returns 200 with `duplicate: true`), so a DIFFERENT
//      event id in the SAME test must get through.
//   2. THE DOWNGRADE — when the enqueue itself fails, the claim must be cut
//      from 7 days to 300s and the response must be 500. This is `expire`'s
//      only reason to exist: without it a queue outage strands a PAID event
//      behind a claim that suppresses Stripe's redelivery for a WEEK. The
//      remaining lifetime is asserted as an exact equality, so a downgrade to
//      the wrong window cannot pass.
//   3. THE CLEANUP IS REACHED — the dispatch-side `hDel` actually removes the
//      settled PaymentIntent's field from the customer's pending-orders hash,
//      read back off the keyspace rather than off a call log.
//
// ── Why the decoy/injected pair ──────────────────────────────────────────────
//
// A seam test that only injects a client proves NOTHING: the module could
// ignore the argument and resolve the singleton, and every assertion would
// still pass because the test's own double IS the singleton. So this file runs
// two DISTINCT clients:
//
//   - `decoy`    — what `getRedisClient()` returns. Nothing in an injected
//                  case may touch it.
//   - `injected` — what `deps.redis` hands over.
//
// Delete a site's `await deps.redis()` threading and it silently falls back to
// `decoy`: `injected` goes untouched and the case reds on the property in its
// own title.
//
// The DEFAULT arms (register/dispatch with no `deps.redis`, decoy MUST be what
// gets used) are what make the injected cases non-vacuous. They are NOT
// themselves seam evidence — a neutered route keeps them green by construction
// — and are EXCLUDED from the revert-to-red counts.
//
// ── Clock discipline ─────────────────────────────────────────────────────────
//
// Every TTL assertion is an EXACT remaining lifetime on a FROZEN clock:
// 604_800_000 ms for the claim (`EX: 604800`) and 300_000 ms for the downgrade
// (`EXPIRE 300`). `toBeGreaterThan(0)` is the fiction this migration exists to
// kill — it cannot tell a 7-day claim from a 7-second one, and it cannot tell
// a downgrade that happened from one that did not.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";

// Assigned in beforeEach. The `vi.mock` factory closes over it LAZILY — it is
// only read when `getRedisClient()` is actually CALLED, which in a correctly
// threaded + injected request is never.
let decoy: InMemoryRedis;

/** A frozen instant, so every TTL below is an exact equality. */
const FROZEN = 1_700_000_000_000;

/** The idempotency claim this route writes: `EX: 604800`. */
const CLAIM_TTL_MS = 604_800_000;

/** The downgrade the enqueue-failure path writes: `EXPIRE 300`. */
const DOWNGRADE_TTL_MS = 300_000;

const mockConstructEvent = vi.hoisted(() => vi.fn());
const mockEnqueue = vi.hoisted(() => vi.fn());
const mockStartProcessor = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockMarkPixPaid = vi.hoisted(() => vi.fn());
const mockCapturePayment = vi.hoisted(() => vi.fn());

vi.mock("stripe", () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent };
  },
}));

// Spread the REAL module and replace ONLY what must not run. `rk` stays REAL —
// Hard Rule #7 — so every key under assertion is the key production writes.
// Under apps/api's vitest that prefix is `development:`.
//
// Two members ARE replaced, and neither is a Redis fake:
//   • `withLock` — the real one reaches `redis.eval(RELEASE_LOCK_SCRIPT)` on
//     its OWN singleton (it takes no client, which is exactly why it is not in
//     this seam's Pick) and would need a live Redis. Replaced with a
//     pass-through that runs `fn()`, preserving the "returns null on
//     contention" contract's success arm.
//   • `medusaAdjudicated` — the real one issues a live HTTP egress.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return {
    ...real,
    getRedisClient: vi.fn(async () => decoy.client),
    withLock: vi.fn(async (_resource: string, fn: () => Promise<unknown>) => fn()),
    medusaAdjudicated: vi.fn(),
  };
});

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("../../jobs/stripe-webhook-processor.js", () => ({
  enqueueStripeWebhookEvent: mockEnqueue,
  startStripeWebhookProcessor: mockStartProcessor,
}));

vi.mock("../../jobs/pix-expiry-monitor.js", () => ({
  markPixPaid: mockMarkPixPaid,
}));

vi.mock("@ibatexas/domain", () => ({
  // Backs `buildWebhookOrderService`, which is what the PRODUCTION dep set's
  // `orderService` member builds. The default arm below needs a TRUTHY capture
  // result for the same reason the injected one does: `handlePaymentSucceeded`
  // reconciles and RETURNS on a falsy capture, and the cleanup site this file
  // pins is downstream of that branch.
  createOrderService: vi.fn(() => ({ capturePayment: mockCapturePayment })),
  createPaymentCommandService: vi.fn(() => ({})),
  createPaymentQueryService: vi.fn(() => ({
    // No local Payment row → the reconcile logs and returns without touching
    // the command service. Enough to carry the handler past the reconcile and
    // on to the cleanup site, which is what this file is about.
    getByStripePaymentIntentId: vi.fn(async () => null),
    getActiveByOrderId: vi.fn(async () => null),
  })),
  createOrderEventLogService: vi.fn(() => ({})),
  PaymentStatus: { PAID: "paid", PAYMENT_FAILED: "payment_failed" },
}));

const EVENT_ID = "evt_seam_money_01";
const PI_ID = "pi_seam_money_01";
const ORDER_ID = "order_seam_01";
const CUSTOMER_ID = "cus_domain_01";

function succeededEvent(eventId: string): Stripe.Event {
  return {
    id: eventId,
    type: "payment_intent.succeeded",
    livemode: false,
    created: 1_700_000_000,
    data: {
      object: {
        id: PI_ID,
        amount: 8900,
        metadata: { medusaOrderId: ORDER_ID, customerId: CUSTOMER_ID },
      },
    },
  } as unknown as Stripe.Event;
}

function silentLogger(): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function freshInjected(): InMemoryRedis {
  return createInMemoryRedis({ now: () => FROZEN });
}

/**
 * `injected` omitted ⇒ the DEFAULT arm: no `deps.redis`, so the route must
 * fall back to `getRedisClient()` — i.e. the decoy.
 */
async function buildServer(injected?: InMemoryRedis): Promise<FastifyInstance> {
  const { stripeWebhookRoutes } = await import("../stripe-webhook.js");
  const app = Fastify({ logger: false });
  await app.register(stripeWebhookRoutes, {
    deps: injected
      ? { redis: async () => injected.client as unknown as never }
      : undefined,
  });
  await app.ready();
  return app;
}

async function postWebhook(
  app: FastifyInstance,
  eventId: string,
): Promise<{ statusCode: number; body: string }> {
  mockConstructEvent.mockReturnValue(succeededEvent(eventId));
  const res = await app.inject({
    method: "POST",
    url: "/api/webhooks/stripe",
    payload: Buffer.from("{}"),
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=123,v1=valid",
    },
  });
  return { statusCode: res.statusCode, body: res.body };
}

beforeEach(() => {
  vi.clearAllMocks();
  decoy = createInMemoryRedis({ now: () => FROZEN });
  process.env.STRIPE_SECRET_KEY = "sk_test_seam";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_seam";
  mockEnqueue.mockResolvedValue(undefined);
  mockPublishNatsEvent.mockResolvedValue(undefined);
  mockMarkPixPaid.mockResolvedValue(undefined);
  // A truthy capture result: `handlePaymentSucceeded` RETURNS EARLY on a falsy
  // one, and the cleanup site this file pins is downstream of that branch.
  mockCapturePayment.mockResolvedValue({
    customerId: CUSTOMER_ID,
    displayId: 1001,
    customerEmail: "c@example.com",
    customerName: "Cliente",
    customerPhone: "+5511999999999",
    totalInCentavos: 8900,
    subtotalInCentavos: 8900,
    shippingInCentavos: 0,
    items: [],
    paymentMethod: "pix",
    deliveryType: "delivery",
    tipInCentavos: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
  // Deliberately NO `vi.resetModules()`. Recorded by #548 at ~10 red cases of
  // diagnosis cost: resetting modules drops the audit-sink singleton that
  // `apps/api`'s `setupFiles` initialises ONCE, so every adjudicated write
  // after the first case 500s with `AuditSinkNotInitializedError` — a PERFECT
  // counterfeit of a broken seam, reddening exactly the injected cases and
  // leaving the singleton-fallback arms green. If this file ever fails in that
  // shape, check for a `resetModules` before believing the seam is broken.
});

// ═══════════════════════════════════════════════════════════════════════════
// The plugin POST — `set` + `expire`, the 7-day idempotency claim
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — stripe-webhook idempotency gate drives the INJECTED client", () => {
  it("claims the event on the INJECTED keyspace at the exact 7-day window, and never touches the singleton", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildServer(injected);
    try {
      const res = await postWebhook(app, EVENT_ID);
      expect(res.statusCode).toBe(200);

      const key = rk(`webhook:processed:${EVENT_ID}`);
      // The claim as a KEYSPACE property, not a call assertion: a double that
      // answers a constant "OK" and records nothing satisfies
      // `expect(set).toHaveBeenCalled()` while claiming nothing at all.
      expect(injected.peek(key)).toBe("1");
      // EXACT, on a frozen clock. `toBeGreaterThan(0)` cannot tell a 7-day
      // claim from a 7-second one.
      expect(injected.ttlMs(key)).toBe(CLAIM_TTL_MS);
      // The seam: nothing reached the singleton.
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional — REPLAY SUPPRESSION on the injected keyspace] the SAME Stripe event id twice enqueues the work exactly ONCE, while a fresh event id in the SAME test gets through", async () => {
    const injected = freshInjected();
    const app = await buildServer(injected);
    try {
      const first = await postWebhook(app, EVENT_ID);
      const second = await postWebhook(app, EVENT_ID);

      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.body)).toEqual({ ok: true });
      // The replay is acknowledged, NOT re-processed.
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body)).toEqual({ ok: true, duplicate: true });

      // The property the gate exists for. A 200 on the second call is
      // satisfied by a route that refuses everything; only the enqueue count
      // says the money work ran once.
      expect(mockEnqueue).toHaveBeenCalledTimes(1);

      // The CONTROL, in the SAME test: a different event must get through, so
      // "enqueued once" cannot be explained by a gate that refuses everything.
      const other = await postWebhook(app, "evt_seam_money_02");
      expect(other.statusCode).toBe(200);
      expect(JSON.parse(other.body)).toEqual({ ok: true });
      expect(mockEnqueue).toHaveBeenCalledTimes(2);

      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional — THE DOWNGRADE, on the injected keyspace] a FAILED enqueue cuts the 7-day claim to exactly 300s and answers 500, so Stripe re-delivers instead of the event being lost", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildServer(injected);
    try {
      mockEnqueue.mockRejectedValueOnce(new Error("BullMQ unreachable"));

      const res = await postWebhook(app, EVENT_ID);

      // 500 is what makes Stripe retry at all.
      expect(res.statusCode).toBe(500);

      const key = rk(`webhook:processed:${EVENT_ID}`);
      // The claim still EXISTS — it is downgraded, not deleted, so a retry
      // inside the 300s window is still suppressed.
      expect(injected.peek(key)).toBe("1");
      // The whole point of `expire` being in this Pick. An absent command here
      // would leave the claim at seven days and strand a PAID event behind it;
      // an exact equality is the only assertion that can tell the downgrade
      // from the original claim.
      expect(injected.ttlMs(key)).toBe(DOWNGRADE_TTL_MS);
      expect(injected.ttlMs(key)).not.toBe(CLAIM_TTL_MS);

      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — EXCLUDED from the RTR counts] with no deps.redis the claim lands on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    const app = await buildServer();
    try {
      const res = await postWebhook(app, EVENT_ID);
      expect(res.statusCode).toBe(200);
      expect(decoy.peek(rk(`webhook:processed:${EVENT_ID}`))).toBe("1");
    } finally {
      await app.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The dispatch side — `hDel`, on the far side of the queue
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — stripe-webhook pending-orders cleanup drives the INJECTED client", () => {
  /**
   * The dep set the dispatch entry point takes, with a truthy capture.
   *
   * `redis` is ALWAYS present here. A PARTIAL set is not a valid default arm
   * for this site and the type forbids one: `deps.redis` would be `undefined`,
   * `await deps.redis()` would throw a TypeError, and the cleanup's bare
   * `catch` — it is best-effort bookkeeping — would SWALLOW it into a silent
   * no-op. That is the #539 shape, and it is why the default arm below omits
   * the parameter ENTIRELY (the only way to reach
   * `defaultStripeWebhookRouteDeps()`) rather than handing over a set with a
   * hole in it.
   */
  async function dispatchDeps(injected: InMemoryRedis): Promise<unknown> {
    return {
      redis: async () => injected.client,
      paymentQueryService: () => ({
        getByStripePaymentIntentId: vi.fn(async () => null),
        getActiveByOrderId: vi.fn(async () => null),
      }),
      paymentCommandService: () => ({}),
      orderEventLogService: () => ({}),
      orderService: () => ({ capturePayment: mockCapturePayment }),
    };
  }

  it("HDELs the settled PaymentIntent off the INJECTED pending-orders hash, and never touches the singleton", async () => {
    const { rk } = await import("@ibatexas/tools");
    const { dispatchStripeWebhookEvent } = await import("../stripe-webhook.js");
    const injected = freshInjected();

    const pendingKey = rk(`customer:pending-orders:${CUSTOMER_ID}`);
    // Two fields, so the assertion can tell a targeted HDEL from a wipe.
    await injected.client.hSet(pendingKey, PI_ID, "pending");
    await injected.client.hSet(pendingKey, "pi_other", "pending");
    // The same shape on the decoy, so "the singleton was untouched" is a real
    // claim about a populated hash rather than about an empty keyspace.
    await decoy.client.hSet(pendingKey, PI_ID, "pending");

    const deps = (await dispatchDeps(injected)) as never;
    await dispatchStripeWebhookEvent(succeededEvent(EVENT_ID), FROZEN, silentLogger(), deps);

    // The settled PI is gone from the INJECTED hash…
    expect(await injected.client.hGetAll(pendingKey)).toEqual({ pi_other: "pending" });
    // …and the singleton's copy is untouched, which is the seam.
    expect(await decoy.client.hGetAll(pendingKey)).toEqual({ [PI_ID]: "pending" });
  });

  it("[default arm — EXCLUDED from the RTR counts] the 3-ARGUMENT call resolves the production set, and the cleanup lands on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    const { dispatchStripeWebhookEvent } = await import("../stripe-webhook.js");

    const pendingKey = rk(`customer:pending-orders:${CUSTOMER_ID}`);
    await decoy.client.hSet(pendingKey, PI_ID, "pending");
    await decoy.client.hSet(pendingKey, "pi_other", "pending");

    // Omitting `deps` ENTIRELY is what reaches `defaultStripeWebhookRouteDeps()`
    // — the documented optional-parameter exception this entry point carries.
    await dispatchStripeWebhookEvent(succeededEvent(EVENT_ID), FROZEN, silentLogger());

    expect(await decoy.client.hGetAll(pendingKey)).toEqual({ pi_other: "pending" });
  });
});
