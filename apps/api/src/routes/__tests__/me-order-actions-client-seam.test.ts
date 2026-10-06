// R5 rollout, family 4 — the me / order-actions route family's Redis-client
// seam, BORN GUARDED.
//
// The family, and why these two and not the four the brief named:
//
//   routes/me.ts            `MeRouteRedisClient`            3 sites
//   routes/order-actions.ts `OrderActionRouteRedisClient`   5 sites
//
// The membership rule: a `requireAuth`-gated customer-plane route with an
// existing R5-S5 composition root whose ENTIRE Redis surface — after the
// hand-it-to analysis below — is servable by the canonical in-memory adapter.
//
// `routes/auth.ts` and `routes/analytics.ts` were in the brief's target list and
// are NOT here. Both hand their client to `atomicIncr` from `@ibatexas/tools`,
// which is an **`eval`** of the INCR+EXPIRE Lua script
// (`packages/tools/src/redis/atomic-rate-limit.ts`). Nothing in either module's
// own text says so — `auth.ts` reads as ten plain `get`/`set`/`del` sites — and
// a naive Pick of what they ISSUE compiles, typechecks and passes. This is the
// #539 item-20 class exactly (`incident-notification-subscriber`), and it makes
// both files owner-gated on the real-Redis decision, not migratable. The census
// records the measurement.
//
// ── Why the decoy/injected pair ──────────────────────────────────────────────
//
// A seam test that only injects a client proves NOTHING: the module could ignore
// the argument and resolve the singleton, and every assertion would still pass
// because the test's own double IS the singleton. So this file runs two DISTINCT
// clients, the pattern `jobs/__tests__/outreach-client-seam.test.ts` and
// `subscribers/__tests__/dedup-family-client-seam.test.ts` established:
//
//   - `decoy`    — what `getRedisClient()` returns. Nothing in an injected case
//                  may touch it.
//   - `injected` — what `deps.redis` hands over.
//
// Every injected case asserts the work landed on `injected` AND that `decoy` was
// never touched. Delete a site's `await deps.redis()` threading and it silently
// falls back to `decoy`: `injected` goes untouched and the case reds on the
// property in its own title.
//
// Each module ALSO carries a DEFAULT arm — register with no `deps.redis` and the
// decoy MUST be what gets used. Those arms are the reason the injected ones are
// not vacuous; they are NOT themselves seam evidence (a neutered route keeps
// them green by construction) and are EXCLUDED from the revert-to-red counts.
//
// ── Directional pins, not happy paths ────────────────────────────────────────
//
// Every counter threaded here is the ONLY thing bounding an attempt: cancels,
// amends, PIX regenerations, the payment-retry daily cap, and the profile-update
// cooldown. So the direction that matters is FAIL-OPEN — a client whose `incr`
// does not really count, or whose `get` does not really read, turns every cap
// into no cap while every happy path stays green. Each cap therefore carries a
// case that seeds the INJECTED keyspace at the limit and requires the refusal,
// paired with a control IN THE SAME TEST (a clean second customer) that must get
// through. Without that control, "429" is satisfied by a route that refuses
// everything.
//
// ── Clock discipline ─────────────────────────────────────────────────────────
//
// Every TTL assertion is an EXACT remaining lifetime on a FROZEN clock.
// `toBeGreaterThan(0)` is the fiction this migration exists to kill — it cannot
// tell a 10-minute rate-limit window from a 10-second one, which is precisely
// the defect R5-S9 found in the audit spill. Against a wall clock the equality
// is a full-suite flake (milliseconds elapse between the route's SET and the
// read), so the clock is injected rather than the assertion weakened.
//
// ── Instrumentation ──────────────────────────────────────────────────────────
//
// Call assertions read the adapter's own `calls` log rather than wrapping each
// command in a `vi.fn()`. The spy-delegate idiom exists to keep an EXISTING
// file's `toHaveBeenCalledWith` assertions working while its double becomes
// real; this file is new, so the adapter's log is the more direct instrument and
// leaves no spy that could answer without the store having moved.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";

// Assigned in beforeEach. The `vi.mock` factory closes over it LAZILY — it is
// only read when `getRedisClient()` is actually CALLED, which in a correctly
// threaded + injected request is never.
let decoy: InMemoryRedis;

/** A frozen instant, so every TTL below is an exact equality. */
const FROZEN = 1_700_000_000_000;

// Spread the REAL module and replace ONLY the client resolver. `rk` stays REAL —
// Hard Rule #7 — so every key under assertion is the key production writes.
// Under apps/api's vitest that prefix is `development:`, which is exactly what
// the doubles in `me-routes.test.ts` and `order-actions-notes-amend-payment.test.ts`
// fake as `ibatexas:` — a prefix production has never written.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return { ...real, getRedisClient: vi.fn(async () => decoy.client) };
});

// NOT mocked: `@ibatexas/nats-client`. A wholesale replacement of it breaks the
// audit sink these handlers publish through, and every governed write then 500s
// — which would have made the me.ts cases fail for a reason that has nothing to
// do with the seam. The package is already inert under apps/api's vitest.

const mockOrderGetById = vi.hoisted(() => vi.fn());
const mockUpdateProfile = vi.hoisted(() => vi.fn());
const mockUpdatePreferences = vi.hoisted(() => vi.fn());
const mockListByOrderId = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  // ── me.ts ────────────────────────────────────────────────────────────────
  exportCustomerData: vi.fn(),
  anonymizeCustomer: vi.fn(),
  anonymizeCustomerFromEnvelope: vi.fn(),
  createCustomerService: () => ({
    getById: vi.fn(async () => null),
    updatePreferences: mockUpdatePreferences,
    updateProfile: mockUpdateProfile,
    listAddresses: vi.fn(async () => []),
    addAddress: vi.fn(),
    removeAddress: vi.fn(),
  }),
  createLoyaltyService: () => ({ getBalance: vi.fn(async () => null) }),
  // ── order-actions.ts ─────────────────────────────────────────────────────
  createOrderCommandService: () => ({
    transitionStatusFromEnvelope: vi.fn(),
    createFromEnvelope: vi.fn(),
    addNoteFromEnvelope: vi.fn(),
  }),
  createOrderQueryService: () => ({ getById: mockOrderGetById }),
  createPaymentCommandService: () => ({
    findActiveByOrderId: vi.fn(async () => null),
    transitionStatusFromEnvelope: vi.fn(),
    createFromEnvelope: vi.fn(),
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: mockGetActiveByOrderId,
    listByOrderId: mockListByOrderId,
  }),
  prisma: {
    orderNote: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    payment: { update: vi.fn() },
    customer: { findUniqueOrThrow: vi.fn() },
  },
  InvalidTransitionError: class InvalidTransitionError extends Error {},
  getEffectivePonr: () => ({ cancelMinutes: 30 }),
  // Both route modules pull in customer-intent-gateway + resolve-and-assemble,
  // which import these statically. Well-formed envelopes only in this file.
  isStructurallyMalformed: () => false,
  STRUCTURAL_REJECTION_CODE: "envelope_malformed",
  createReservationService: () => ({
    getById: vi.fn(async () => null),
    listByCustomer: vi.fn(async () => ({ reservations: [] })),
  }),
}));

vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    const customerId = request.headers["x-customer-id"] as string | undefined;
    if (!customerId) {
      void reply.code(401).send({ message: "auth required" });
      return;
    }
    request.customerId = customerId;
    done();
  },
  optionalAuth: (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    request.customerId = request.headers["x-customer-id"] as string | undefined;
    done();
  },
}));

// ── Server factories ─────────────────────────────────────────────────────────

/**
 * `injected` omitted ⇒ the DEFAULT arm: no `deps.redis`, so the route must fall
 * back to `getRedisClient()` — i.e. the decoy. That is what makes every injected
 * case below non-vacuous, and it is not itself seam evidence.
 */
async function buildOrderActionsServer(injected?: InMemoryRedis): Promise<FastifyInstance> {
  const { orderActionRoutes } = await import("../order-actions.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(orderActionRoutes, {
    deps: injected
      ? { redis: async () => injected.client as unknown as never }
      : undefined,
  });
  await app.ready();
  return app;
}

async function buildMeServer(injected?: InMemoryRedis): Promise<FastifyInstance> {
  const { meRoutes } = await import("../me.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(meRoutes, {
    deps: injected
      ? { redis: async () => injected.client as unknown as never }
      : undefined,
  });
  await app.ready();
  return app;
}

function freshInjected(): InMemoryRedis {
  return createInMemoryRedis({ now: () => FROZEN });
}

function makeOrder(overrides?: Record<string, unknown>) {
  return {
    id: "order_01",
    displayId: 42,
    customerId: "cust_01",
    fulfillmentStatus: "confirmed",
    createdAt: new Date(FROZEN),
    totalInCentavos: 50_000,
    paymentMethod: "pix",
    paymentStatus: "awaiting_payment",
    itemsJson: [{ title: "X-Burger", productType: "food" }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  decoy = createInMemoryRedis({ now: () => FROZEN });
  mockOrderGetById.mockResolvedValue(makeOrder());
  mockListByOrderId.mockResolvedValue({ count: 0, payments: [] });
  mockGetActiveByOrderId.mockResolvedValue(null);
  // The cache refresh is gated on `persistedPrefs !== null`, i.e. on what the
  // executor's `updatePreferences` RETURNS — a mock resolving `undefined` skips
  // the site entirely and the seam case would pass with the write never issued.
  mockUpdatePreferences.mockResolvedValue({
    allergenExclusions: ["gluten"],
    favoriteCategories: ["burgers"],
  });
  vi.stubEnv("JWT_SECRET", "test-jwt-secret-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  // Deliberately NO `vi.resetModules()`. The sibling seam suites carry one
  // because they re-register BullMQ processors per case; this file does not,
  // and here it is actively harmful: resetting modules drops the audit-sink
  // singleton that `apps/api`'s `setupFiles` initialises ONCE, so every
  // adjudicated write after the first case 500s with
  // `AuditSinkNotInitializedError`. That failure is a perfect counterfeit of a
  // broken seam — it reds exactly the injected cases and leaves the
  // singleton-fallback arms green, because those assert on the decoy's call log
  // rather than on a 200. Recorded so the next slice does not re-derive it.
});

// ═══════════════════════════════════════════════════════════════════════════
// order-actions.ts — OrderActionRateLimitRedis (4 sites: cancel, amend ×2,
// PIX regeneration)
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — order-actions cancel cap drives the INJECTED client", () => {
  it("counts the cancel attempt on the INJECTED keyspace at the exact 10-minute window, and never touches the singleton", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildOrderActionsServer(injected);
    try {
      await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: {},
      });

      const key = rk("rate:cancel:cust_01");
      // The counter as a KEYSPACE property, not a call assertion: a double that
      // answers a constant `1` and records nothing satisfies
      // `expect(incr).toHaveBeenCalled()` while counting nothing at all.
      expect(injected.peek(key)).toBe("1");
      // EXACT, on a frozen clock. `toBeGreaterThan(0)` cannot tell a 10-minute
      // window from a 10-second one.
      expect(injected.ttlMs(key)).toBe(600_000);
      // The seam: nothing reached the singleton.
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional — the cap is enforced FROM the injected keyspace] refuses the 6th attempt 429 while a clean customer in the SAME test gets through", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildOrderActionsServer(injected);
    try {
      // Seed the capped customer AT the limit on the injected keyspace.
      const cappedKey = rk("rate:cancel:cust_capped");
      for (let i = 0; i < 5; i += 1) {
        await injected.client.incr(cappedKey);
      }

      const refused = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_capped", "content-type": "application/json" },
        payload: {},
      });
      expect(refused.statusCode).toBe(429);
      expect((refused.json() as { code?: string }).code).toBe("RATE_LIMIT");

      // The CONTROL, in the same test: without it "429" is satisfied by a route
      // that refuses everything, and by a route reading an empty decoy that
      // happens to 429 for another reason. A clean customer must NOT be capped.
      const allowed = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_clean", "content-type": "application/json" },
        payload: {},
      });
      expect(allowed.statusCode).not.toBe(429);

      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — NOT seam evidence] with no deps.redis the cancel cap counts on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    const app = await buildOrderActionsServer();
    try {
      await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: {},
      });
      expect(decoy.peek(rk("rate:cancel:cust_01"))).toBe("1");
    } finally {
      await app.close();
    }
  });
});

describe("seam — order-actions amend caps drive the INJECTED client", () => {
  it("BOTH amend handlers share ONE bucket: the single and the batch route increment the same key", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildOrderActionsServer(injected);
    try {
      await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { action: "update_qty", itemTitle: "X-Burger", quantity: 2 },
      });
      await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend/batch",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { changes: [{ type: "update_qty", itemTitle: "X-Burger", quantity: 3 }] },
      });

      // A real property, not a restatement of the code: the two routes share
      // `rate:amend:<customerId>`, so the documented "5 per 10 minutes" is 5
      // across BOTH, not 5 each. A constant-answering double cannot express
      // this — it has no single place for the two writes to meet.
      const key = rk("rate:amend:cust_01");
      expect(injected.peek(key)).toBe("2");
      expect(injected.ttlMs(key)).toBe(600_000);
      // And the batch route did NOT open a second bucket.
      expect(injected.keys().filter((k) => k.includes("rate:amend"))).toEqual([key]);
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional] the shared amend cap refuses at 6 while a clean customer in the SAME test gets through", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildOrderActionsServer(injected);
    try {
      const cappedKey = rk("rate:amend:cust_capped");
      for (let i = 0; i < 5; i += 1) {
        await injected.client.incr(cappedKey);
      }

      const refused = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend",
        headers: { "x-customer-id": "cust_capped", "content-type": "application/json" },
        payload: { action: "update_qty", itemTitle: "X-Burger", quantity: 2 },
      });
      expect(refused.statusCode).toBe(429);
      expect((refused.json() as { code?: string }).code).toBe("RATE_LIMIT");

      const allowed = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend",
        headers: { "x-customer-id": "cust_clean", "content-type": "application/json" },
        payload: { action: "update_qty", itemTitle: "X-Burger", quantity: 2 },
      });
      expect(allowed.statusCode).not.toBe(429);

      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — NOT seam evidence] with no deps.redis the amend cap counts on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    const app = await buildOrderActionsServer();
    try {
      await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { action: "update_qty", itemTitle: "X-Burger", quantity: 2 },
      });
      expect(decoy.peek(rk("rate:amend:cust_01"))).toBe("1");
    } finally {
      await app.close();
    }
  });
});

describe("seam — order-actions PIX-regeneration cap drives the INJECTED client", () => {
  it("counts on the INJECTED keyspace at the exact 1-hour window (a site AFTER the ownership gate)", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildOrderActionsServer(injected);
    try {
      await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/regenerate-pix",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: {},
      });

      const key = rk("pix:regen:rate:cust_01");
      expect(injected.peek(key)).toBe("1");
      // 3600s, not 600s — the four caps do NOT share a window, and an exact
      // equality is the only assertion that can tell them apart.
      expect(injected.ttlMs(key)).toBe(3_600_000);
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional] refuses the 4th regeneration REGEN_RATE_LIMIT while a clean customer in the SAME test gets through", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildOrderActionsServer(injected);
    try {
      // Ownership is checked BEFORE the counter on this route, so the capped
      // customer must own the order for the cap to be reachable at all.
      mockOrderGetById.mockResolvedValue(makeOrder({ customerId: "cust_capped" }));
      const cappedKey = rk("pix:regen:rate:cust_capped");
      for (let i = 0; i < 3; i += 1) {
        await injected.client.incr(cappedKey);
      }

      const refused = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/regenerate-pix",
        headers: { "x-customer-id": "cust_capped", "content-type": "application/json" },
        payload: {},
      });
      expect(refused.statusCode).toBe(429);
      expect((refused.json() as { code?: string }).code).toBe("REGEN_RATE_LIMIT");

      mockOrderGetById.mockResolvedValue(makeOrder({ customerId: "cust_clean" }));
      const allowed = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/regenerate-pix",
        headers: { "x-customer-id": "cust_clean", "content-type": "application/json" },
        payload: {},
      });
      expect(allowed.statusCode).not.toBe(429);

      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// order-actions.ts — PaymentRetryCapRedis (the one site that READS first)
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — the payment-retry daily cap READS the INJECTED keyspace", () => {
  /** Stages the retry route past ownership / retryable / lifetime-cap gates. */
  function stageRetryable(customerId: string): void {
    mockOrderGetById.mockResolvedValue(makeOrder({ customerId }));
    mockListByOrderId.mockResolvedValue({ count: 1, payments: [] });
    mockGetActiveByOrderId.mockResolvedValue({
      id: "pay_01",
      method: "pix",
      status: "payment_expired",
      amountInCentavos: 50_000,
      version: 1,
      createdAt: new Date(FROZEN),
    });
  }

  it("projects the day counter from the INJECTED client — the exact key, read not written", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    stageRetryable("cust_01");
    const app = await buildOrderActionsServer(injected);
    try {
      await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/retry",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: {},
      });

      const day = new Date().toISOString().slice(0, 10);
      const key = rk(`payment-retry:cust_01:${day}`);
      // The GET is the seam evidence here: this site's first command is a READ,
      // so a keyspace-write assertion would miss it entirely.
      expect(
        injected.calls.some((c) => c.command === "get" && c.args[0] === key),
      ).toBe(true);
      expect(decoy.calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional — money path] a day counter AT the cap on the injected keyspace refuses the retry, while a clean customer in the SAME test is not refused for that reason", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const day = new Date().toISOString().slice(0, 10);

    stageRetryable("cust_capped");
    // `retryDailyCapGuard` reads `ctx.dailyRetryCount` (default cap 3), which
    // the route projects from THIS key. Seed it at the cap.
    await injected.client.set(rk(`payment-retry:cust_capped:${day}`), "3");

    const app = await buildOrderActionsServer(injected);
    try {
      const refused = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/retry",
        headers: { "x-customer-id": "cust_capped", "content-type": "application/json" },
        payload: {},
      });
      // The kernel REFUSEs rather than the route 429-ing: the daily cap is a
      // Pack guard, not a route branch. Either way it must not be a 200.
      expect(refused.statusCode).not.toBe(200);

      // The control, same test: identical staging, an EMPTY counter. If this one
      // also fails to reach the executor the negative above proves nothing about
      // the counter — it would just mean the route refuses every retry.
      stageRetryable("cust_clean");
      const clean = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/retry",
        headers: { "x-customer-id": "cust_clean", "content-type": "application/json" },
        payload: {},
      });
      expect(clean.statusCode).not.toBe(refused.statusCode);

      expect(decoy.calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — NOT seam evidence] with no deps.redis the retry cap reads the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    stageRetryable("cust_01");
    const app = await buildOrderActionsServer();
    try {
      await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/retry",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: {},
      });
      const day = new Date().toISOString().slice(0, 10);
      expect(
        decoy.calls.some(
          (c) => c.command === "get" && c.args[0] === rk(`payment-retry:cust_01:${day}`),
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// me.ts — ProfileUpdateRateRedis (the get/set pair on one handler client)
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — the me.ts profile-update cooldown drives the INJECTED client", () => {
  it("reads the last-update marker from the INJECTED client and writes the refreshed marker back to it", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    mockUpdateProfile.mockResolvedValue(undefined);
    const app = await buildMeServer(injected);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/profile",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { name: "Maria Silva" },
      });
      expect(res.statusCode).toBe(200);

      const key = rk("customer:profile:last-update:cust_01");
      // Both halves of the Pick, on ONE handler-scoped client: the projection
      // READ before the kernel runs, and the marker WRITE from the executor.
      expect(injected.calls.some((c) => c.command === "get" && c.args[0] === key)).toBe(true);
      expect(injected.peek(key)).toBeDefined();
      expect(decoy.calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional — the cooldown is enforced FROM the injected keyspace] a fresh marker REFUSES and the profile is not persisted, while a clean customer in the SAME test IS persisted", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    mockUpdateProfile.mockResolvedValue(undefined);
    // A marker written "now" ⇒ the pack's cooldown guard REFUSEs.
    await injected.client.set(
      rk("customer:profile:last-update:cust_capped"),
      String(Date.now()),
    );

    const app = await buildMeServer(injected);
    try {
      const refused = await app.inject({
        method: "POST",
        url: "/api/me/profile",
        headers: { "x-customer-id": "cust_capped", "content-type": "application/json" },
        payload: { name: "Novo Nome" },
      });
      expect(refused.statusCode).not.toBe(200);
      expect(mockUpdateProfile).not.toHaveBeenCalled();

      // The control, same test. Without it "updateProfile was not called" is
      // satisfied by a route that never persists anything.
      const allowed = await app.inject({
        method: "POST",
        url: "/api/me/profile",
        headers: { "x-customer-id": "cust_clean", "content-type": "application/json" },
        payload: { name: "Outro Nome" },
      });
      expect(allowed.statusCode).toBe(200);
      expect(mockUpdateProfile).toHaveBeenCalledWith(
        "cust_clean",
        expect.objectContaining({ name: "Outro Nome" }),
      );

      expect(decoy.calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — NOT seam evidence] with no deps.redis the cooldown reads the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    mockUpdateProfile.mockResolvedValue(undefined);
    const app = await buildMeServer();
    try {
      await app.inject({
        method: "POST",
        url: "/api/me/profile",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { name: "Maria Silva" },
      });
      expect(
        decoy.calls.some(
          (c) =>
            c.command === "get" && c.args[0] === rk("customer:profile:last-update:cust_01"),
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// me.ts — ProfileCacheRefreshRedis (a SWALLOWING site)
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — the me.ts profile-cache refresh drives the INJECTED client", () => {
  it("writes the preferences field and the exact 30-day TTL onto the INJECTED keyspace", async () => {
    const { rk, PROFILE_TTL_SECONDS } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildMeServer(injected);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/preferences",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { allergenExclusions: ["gluten"], favoriteCategories: ["burgers"] },
      });
      expect(res.statusCode).toBe(200);

      const key = rk("customer:profile:cust_01");
      // This site is wrapped in `catch { log.warn }` and the handler returns 200
      // regardless, so the response code proves NOTHING about it. The keyspace
      // is the only witness — which is exactly why the seam is born guarded
      // here: a dropped `hSet`/`expire` leaves the agent plane serving STALE
      // preferences with the web save reported successful.
      expect(injected.keys()).toContain(key);
      expect(injected.ttlMs(key)).toBe(PROFILE_TTL_SECONDS * 1000);
      expect(decoy.calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — NOT seam evidence] with no deps.redis the cache refresh writes to the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    const app = await buildMeServer();
    try {
      await app.inject({
        method: "POST",
        url: "/api/me/preferences",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { allergenExclusions: ["gluten"], favoriteCategories: ["burgers"] },
      });
      expect(decoy.keys()).toContain(rk("customer:profile:cust_01"));
    } finally {
      await app.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// me.ts — PendingDeletionClearRedis (the third site, and the SHARPEST seam
// boundary in the family)
// ═══════════════════════════════════════════════════════════════════════════
//
// This handler's Redis surface is deliberately SPLIT and the split is the
// property worth pinning. `routes/me/anonymize-otp-gate.ts` and
// `routes/me/anonymize-active-lock.ts` are separate modules with their own
// (un-threaded) `getRedisClient()` calls, so the receipt read, the receipt
// clear, the 60s mutex and the cancel cooldown ALL land on the singleton —
// while the `defer:pending:<customerId>` clear, the only site `me.ts` itself
// owns here, must land on the INJECTED client. A test that asserted "Redis was
// touched" would be satisfied by either.
//
// It also exercises the census's class-(i-b) mechanism live, and the case
// tolerates it explicitly rather than being surprised by it:
// `releaseAnonymizeActiveLock` issues the CAD `eval` against the SINGLETON, the
// in-memory adapter refuses it with `LuaAtomicityNotEmulated`, and the
// module's documented best-effort `catch` swallows the refusal. The mutex is
// therefore never released here and only its TTL ends it — a GREEN handler over
// an uncovered invariant, exactly as R5-S12 measured for `defer:resuming:*`.
// That Lua stays owner-gated; nothing in this slice claims otherwise.

describe("seam — the me.ts pending-deletion clear drives the INJECTED client", () => {
  const RECEIPT = JSON.stringify({
    parkedAt: FROZEN - 60_000,
    intentHash: "a".repeat(64),
    otpTokenHint: "hint",
  });

  it("clears defer:pending on the INJECTED client while the receipt, mutex and cooldown stay on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    // The receipt lives in `anonymize-otp-gate.ts`, which resolves its own
    // client — so it is seeded on the DECOY on purpose.
    await decoy.client.set(rk("anonymize:pending:cust_01"), RECEIPT);
    // The blob this seam's one site is responsible for.
    await injected.client.set(rk("defer:pending:cust_01"), "parked-envelope-blob");

    const app = await buildMeServer(injected);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/cancel-deletion",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(200);

      // The seam: the site me.ts owns landed on the INJECTED keyspace.
      expect(injected.peek(rk("defer:pending:cust_01"))).toBeUndefined();
      expect(
        injected.calls.some(
          (c) => c.command === "del" && c.args[0] === rk("defer:pending:cust_01"),
        ),
      ).toBe(true);

      // The boundary: the NEIGHBOURING modules' sites did NOT move. Threading
      // me.ts must not silently capture `anonymize-otp-gate.ts`'s client.
      expect(decoy.peek(rk("anonymize:pending:cust_01"))).toBeUndefined();
      expect(decoy.keys()).toContain(rk("anonymize:cancel-cooldown:cust_01"));
      // And the injected client was NOT handed the neighbours' work.
      expect(injected.keys().some((k) => k.includes("anonymize:"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("[default arm — NOT seam evidence] with no deps.redis the defer:pending clear hits the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    await decoy.client.set(rk("anonymize:pending:cust_01"), RECEIPT);
    await decoy.client.set(rk("defer:pending:cust_01"), "parked-envelope-blob");

    const app = await buildMeServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/cancel-deletion",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(decoy.peek(rk("defer:pending:cust_01"))).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
