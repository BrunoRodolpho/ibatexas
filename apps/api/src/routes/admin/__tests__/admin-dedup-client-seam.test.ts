// R5 rollout, family 5 — the ADMIN DEDUP route family's Redis-client seam,
// BORN GUARDED.
//
// The family, and the rule that makes it one:
//
//   routes/admin/delivery-zones.ts  `DeliveryZoneRouteRedisClient`  1 site
//   routes/admin/orders.ts          `AdminOrderRouteRedisClient`    1 site
//   routes/admin/products.ts        `AdminProductRouteRedisClient`  1 site
//
// All three issue the IDENTICAL command — `SET <rk'd key> "1" EX 300 NX` — and
// nothing else, keyed off the caller's `x-request-id`. That single command IS
// the double-submit gate for every mutating admin write in this file set: a
// null return means the key already existed, which means the request is a
// replay, which means 409 and NO mutation. Verified before threading: each of
// the three files contains exactly ONE `getRedisClient()` call and exactly ONE
// `redis.` command, and no `eval` / `multi` / `evalSha` / `atomicIncr`.
//
// ── Why the decoy/injected pair ──────────────────────────────────────────────
//
// A seam test that only injects a client proves NOTHING: the module could
// ignore the argument and resolve the singleton, and every assertion would
// still pass because the test's own double IS the singleton. So this file runs
// two DISTINCT clients, the pattern `routes/__tests__/
// me-order-actions-client-seam.test.ts` established:
//
//   - `decoy`    — what `getRedisClient()` returns. Nothing in an injected case
//                  may touch it.
//   - `injected` — what `deps.redis` hands over.
//
// Every injected case asserts the work landed on `injected` AND that `decoy`
// was never touched. Delete a site's `await deps.redis()` threading and it
// silently falls back to `decoy`: `injected` goes untouched and the case reds
// on the property in its own title.
//
// Each module ALSO carries a DEFAULT arm — register with no `deps.redis` and
// the decoy MUST be what gets used. Those arms are the reason the injected ones
// are not vacuous; they are NOT themselves seam evidence (a neutered route
// keeps them green by construction) and are EXCLUDED from the revert-to-red
// counts.
//
// ── Directional pins, not happy paths ────────────────────────────────────────
//
// The fiction this file exists to kill is specific and it is in all three of
// the pre-existing suites: their double is `{ set: vi.fn().mockResolvedValue(
// "OK") }`, and the duplicate case PLANTS the answer
// (`mockResolvedValue(null)`). A gate whose SET records nothing and whose
// verdict the test supplies passes both arms identically — including against a
// write-only gate that would let EVERY double-submit through in production.
//
// So each module's directional case submits the SAME `x-request-id` TWICE
// against a real NX keyspace and requires:
//   1. the second response to be 409, and
//   2. the underlying MUTATION to have run exactly ONCE — the property the
//      gate exists for; a 409 alone is satisfied by a route that refuses
//      everything, and
//   3. a CONTROL in the SAME test — a different `x-request-id` — that must get
//      through, which is what rules out "refuses everything".
//
// ── Clock discipline ─────────────────────────────────────────────────────────
//
// Every TTL assertion is an EXACT remaining lifetime on a FROZEN clock:
// 300_000 ms, the `EX: 300` all three sites share. `toBeGreaterThan(0)` is the
// fiction this migration exists to kill — it cannot tell a 5-minute replay
// window from a 5-second one, and a 5-second one is a dedup gate that stops
// nothing. Against a wall clock the equality is a full-suite flake, so the
// clock is injected rather than the assertion weakened.
//
// ── Instrumentation ──────────────────────────────────────────────────────────
//
// Assertions read the adapter's KEYSPACE (`peek` / `ttlMs` / `keys`) rather
// than a `vi.fn()` call log. A spy proves a call happened; only the keyspace
// proves the gate RESERVED anything, which is the whole difference between a
// working dedup gate and the constant-answering fiction above.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";

// Assigned in beforeEach. The `vi.mock` factory closes over it LAZILY — it is
// only read when `getRedisClient()` is actually CALLED, which in a correctly
// threaded + injected request is never.
let decoy: InMemoryRedis;

/** A frozen instant, so every TTL below is an exact equality. */
const FROZEN = 1_700_000_000_000;

/** The window all three dedup sites share: `EX: 300`. */
const DEDUP_TTL_MS = 300_000;

const mockMedusaAdjudicated = vi.hoisted(() => vi.fn());
const mockInvalidateDeliveryCache = vi.hoisted(() => vi.fn());

// Spread the REAL module and replace ONLY what must not run. `rk` stays REAL —
// Hard Rule #7 — so every key under assertion is the key production writes.
// Under apps/api's vitest that prefix is `development:`, which is exactly what
// all three pre-existing suites fake as `ibatexas:` — a prefix production has
// never written.
//
// Two members ARE replaced, and neither is a Redis fake:
//   • `medusaAdjudicated` — the real one issues a live HTTP egress.
//   • `invalidateDeliveryCache` — the real one resolves its OWN singleton
//     (it is called with zero arguments, which is precisely why it is not
//     downstream of this seam's Pick) and would reach for a live Redis. It is
//     `void`-ed fire-and-forget in the route, so nothing here awaits it.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return {
    ...real,
    getRedisClient: vi.fn(async () => decoy.client),
    medusaAdjudicated: mockMedusaAdjudicated,
    invalidateDeliveryCache: mockInvalidateDeliveryCache,
  };
});

// NOT mocked: `@ibatexas/nats-client`. A wholesale replacement of it breaks the
// audit sink these handlers publish through, and every governed write then
// 500s — which would make the cases fail for a reason that has nothing to do
// with the seam. The package is already inert under apps/api's vitest.

const mockZoneListAll = vi.hoisted(() => vi.fn());
const mockZoneCreate = vi.hoisted(() => vi.fn());
const mockZoneUpdate = vi.hoisted(() => vi.fn());
const mockZoneRemove = vi.hoisted(() => vi.fn());
const mockTransitionFromEnvelope = vi.hoisted(() => vi.fn());
const mockOrderGetById = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  // ── admin/delivery-zones.ts ──────────────────────────────────────────────
  createDeliveryZoneService: () => ({
    listAll: mockZoneListAll,
    create: mockZoneCreate,
    update: mockZoneUpdate,
    remove: mockZoneRemove,
  }),
  // ── admin/orders.ts ──────────────────────────────────────────────────────
  createOrderCommandService: () => ({
    transitionStatusFromEnvelope: mockTransitionFromEnvelope,
  }),
  createOrderQueryService: () => ({
    getById: mockOrderGetById,
    listAll: vi.fn(async () => ({ orders: [], count: 0 })),
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: vi.fn(async () => null),
    getActiveByOrderIds: vi.fn(async () => new Map()),
  }),
  createFiscalDocumentService: () => ({ getByOrderId: vi.fn(async () => null) }),
  prisma: {},
  ConcurrencyError: class ConcurrencyError extends Error {},
  ProjectionNotFoundError: class ProjectionNotFoundError extends Error {},
  InvalidTransitionError: class InvalidTransitionError extends Error {
    constructor(readonly from?: string, readonly to?: string) {
      super("invalid transition");
    }
  },
}));

const mockMedusaAdmin = vi.hoisted(() => vi.fn());
vi.mock("../_shared.js", () => ({ medusaAdmin: mockMedusaAdmin }));

vi.mock("../../../middleware/staff-auth.js", () => ({
  requireManagerRole: (
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ) => {
    (request as unknown as { staffId: string }).staffId = "staff_01";
    (request as unknown as { staffRole: string }).staffRole = "MANAGER";
    done();
  },
}));

// ── Server factories ─────────────────────────────────────────────────────────
//
// `injected` omitted ⇒ the DEFAULT arm: no `deps.redis`, so the route must fall
// back to `getRedisClient()` — i.e. the decoy. That is what makes every
// injected case below non-vacuous, and it is not itself seam evidence.

async function baseApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  return app;
}

async function buildDeliveryZonesServer(
  injected?: InMemoryRedis,
): Promise<FastifyInstance> {
  const { deliveryZoneRoutes } = await import("../delivery-zones.js");
  const app = await baseApp();
  await app.register(deliveryZoneRoutes, {
    deps: injected
      ? { redis: async () => injected.client as unknown as never }
      : undefined,
  });
  await app.ready();
  return app;
}

async function buildAdminOrdersServer(
  injected?: InMemoryRedis,
): Promise<FastifyInstance> {
  const { orderRoutes } = await import("../orders.js");
  const app = await baseApp();
  await app.register(orderRoutes, {
    deps: injected
      ? { redis: async () => injected.client as unknown as never }
      : undefined,
  });
  await app.ready();
  return app;
}

async function buildAdminProductsServer(
  injected?: InMemoryRedis,
): Promise<FastifyInstance> {
  const { productRoutes } = await import("../products.js");
  const app = await baseApp();
  await app.register(productRoutes, {
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

const ZONE_BODY = {
  name: "Zona Centro",
  cepPrefixes: ["12345"],
  feeInCentavos: 900,
  estimatedMinutes: 40,
};

beforeEach(() => {
  vi.clearAllMocks();
  decoy = createInMemoryRedis({ now: () => FROZEN });
  // delivery-zones: no existing zones → no CEP conflict, so the only gate the
  // request can fail is the dedup one.
  mockZoneListAll.mockResolvedValue([]);
  mockZoneCreate.mockResolvedValue({ id: "z_new", ...ZONE_BODY, active: true });
  mockZoneUpdate.mockResolvedValue({ id: "z1", ...ZONE_BODY, active: true });
  mockZoneRemove.mockResolvedValue(undefined);
  // admin/orders: an EXECUTE decision and a projection to render back.
  mockTransitionFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE" },
    result: { version: 4, previousStatus: "confirmed", newStatus: "preparing" },
  });
  mockOrderGetById.mockResolvedValue({
    id: "order_01",
    displayId: 1001,
    customerId: "cust_01",
    fulfillmentStatus: "preparing",
    paymentStatus: "captured",
    version: 4,
  });
  // admin/products: the kernel-gated egress succeeds.
  mockMedusaAdjudicated.mockResolvedValue({ product: { id: "prod_01" } });
});

afterEach(() => {
  vi.useRealTimers();
  // Deliberately NO `vi.resetModules()`. Recorded by #548 at ~10 red cases of
  // diagnosis cost: resetting modules drops the audit-sink singleton that
  // `apps/api`'s `setupFiles` initialises ONCE, so every adjudicated write
  // after the first case 500s with `AuditSinkNotInitializedError`. That failure
  // is a PERFECT counterfeit of a broken seam — it reds exactly the injected
  // cases and leaves the singleton-fallback arms green. If this file ever
  // starts failing in that shape, check for a `resetModules` before believing
  // the seam is broken.
});

// ═══════════════════════════════════════════════════════════════════════════
// admin/delivery-zones.ts — DeliveryZoneRouteRedisClient
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — admin/delivery-zones dedup gate drives the INJECTED client", () => {
  it("reserves the x-request-id on the INJECTED keyspace at the exact 5-minute window, and never touches the singleton", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildDeliveryZonesServer(injected);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/delivery-zones",
        payload: ZONE_BODY,
        headers: { "x-request-id": "req-zone-1" },
      });
      expect(res.statusCode).toBe(201);

      const key = rk("dz:create:dedup:req-zone-1");
      // The reservation as a KEYSPACE property, not a call assertion: a double
      // that answers a constant "OK" and records nothing satisfies
      // `expect(set).toHaveBeenCalled()` while reserving nothing at all.
      expect(injected.peek(key)).toBe("1");
      // EXACT, on a frozen clock. `toBeGreaterThan(0)` cannot tell a 5-minute
      // replay window from a 5-second one.
      expect(injected.ttlMs(key)).toBe(DEDUP_TTL_MS);
      // The seam: nothing reached the singleton.
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional — the gate REFUSES from the injected keyspace] the SAME x-request-id twice creates the zone exactly ONCE, while a fresh id in the SAME test gets through", async () => {
    const injected = freshInjected();
    const app = await buildDeliveryZonesServer(injected);
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/admin/delivery-zones",
        payload: ZONE_BODY,
        headers: { "x-request-id": "req-double-submit" },
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/admin/delivery-zones",
        payload: ZONE_BODY,
        headers: { "x-request-id": "req-double-submit" },
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: "Requisicao duplicada." });
      // THE property the gate exists for. A 409 alone does not say the write
      // was stopped; this does.
      expect(mockZoneCreate).toHaveBeenCalledTimes(1);

      // The CONTROL, in the same test: without it "409" is satisfied by a
      // route that refuses everything, and by a route reading an empty decoy
      // that happens to 409 for another reason.
      const distinct = await app.inject({
        method: "POST",
        url: "/api/admin/delivery-zones",
        payload: ZONE_BODY,
        headers: { "x-request-id": "req-distinct" },
      });
      expect(distinct.statusCode).toBe(201);
      expect(mockZoneCreate).toHaveBeenCalledTimes(2);

      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("the ACTION is part of the reservation key: one x-request-id replayed across create/update/delete is NOT a duplicate", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildDeliveryZonesServer(injected);
    try {
      // A real property of the key derivation, not a restatement of the code:
      // an admin client that reuses one correlation id across a create and a
      // subsequent edit must not have the edit swallowed as a replay. A
      // constant-answering double cannot express this — it has no keyspace for
      // the three writes to be distinct IN.
      const created = await app.inject({
        method: "POST",
        url: "/api/admin/delivery-zones",
        payload: ZONE_BODY,
        headers: { "x-request-id": "req-shared-id" },
      });
      const updated = await app.inject({
        method: "PUT",
        url: "/api/admin/delivery-zones/z1",
        payload: ZONE_BODY,
        headers: { "x-request-id": "req-shared-id" },
      });
      const removed = await app.inject({
        method: "DELETE",
        url: "/api/admin/delivery-zones/z9",
        headers: { "x-request-id": "req-shared-id" },
      });

      expect(created.statusCode).toBe(201);
      expect(updated.statusCode).toBe(200);
      expect(removed.statusCode).toBe(200);

      expect(injected.keys().filter((k) => k.includes("dedup")).sort()).toEqual(
        [
          rk("dz:create:dedup:req-shared-id"),
          rk("dz:delete:dedup:req-shared-id"),
          rk("dz:update:dedup:req-shared-id"),
        ].sort(),
      );
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("with NO x-request-id the gate is skipped entirely — the injected keyspace stays empty and the write still happens", async () => {
    const injected = freshInjected();
    const app = await buildDeliveryZonesServer(injected);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/delivery-zones",
        payload: ZONE_BODY,
      });
      expect(res.statusCode).toBe(201);
      expect(mockZoneCreate).toHaveBeenCalledTimes(1);
      // Pins the guard's early return as an OBSERVABLE: no header, no
      // reservation. Without this, "the gate wrote a key" is compatible with a
      // gate that writes one for every request under some derived id.
      expect(injected.keys()).toEqual([]);
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — NOT seam evidence] with no deps.redis the dedup gate reserves on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    const app = await buildDeliveryZonesServer();
    try {
      await app.inject({
        method: "POST",
        url: "/api/admin/delivery-zones",
        payload: ZONE_BODY,
        headers: { "x-request-id": "req-default-zone" },
      });
      expect(decoy.peek(rk("dz:create:dedup:req-default-zone"))).toBe("1");
    } finally {
      await app.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// admin/orders.ts — AdminOrderRouteRedisClient
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — admin/orders status dedup gate drives the INJECTED client", () => {
  it("reserves the x-request-id on the INJECTED keyspace at the exact 5-minute window, and never touches the singleton", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildAdminOrdersServer(injected);
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: { fulfillment_status: "preparing", version: 3 },
        headers: { "x-request-id": "req-order-1" },
      });
      expect(res.statusCode).toBe(200);

      const key = rk("order:status:dedup:req-order-1");
      expect(injected.peek(key)).toBe("1");
      expect(injected.ttlMs(key)).toBe(DEDUP_TTL_MS);
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional] the SAME x-request-id twice transitions the order exactly ONCE, while a fresh id in the SAME test gets through", async () => {
    const injected = freshInjected();
    const app = await buildAdminOrdersServer(injected);
    try {
      const body = { fulfillment_status: "preparing", version: 3 };
      const first = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: body,
        headers: { "x-request-id": "req-order-double" },
      });
      const second = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: body,
        headers: { "x-request-id": "req-order-double" },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: "Requisicao duplicada." });
      // A duplicated admin status transition is a real-money-adjacent event
      // (it re-publishes order.status_changed and re-versions the projection).
      // The gate's whole job is that this stays 1.
      expect(mockTransitionFromEnvelope).toHaveBeenCalledTimes(1);

      const distinct = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: body,
        headers: { "x-request-id": "req-order-distinct" },
      });
      expect(distinct.statusCode).toBe(200);
      expect(mockTransitionFromEnvelope).toHaveBeenCalledTimes(2);

      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — NOT seam evidence] with no deps.redis the dedup gate reserves on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    const app = await buildAdminOrdersServer();
    try {
      await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: { fulfillment_status: "preparing", version: 3 },
        headers: { "x-request-id": "req-default-order" },
      });
      expect(decoy.peek(rk("order:status:dedup:req-default-order"))).toBe("1");
    } finally {
      await app.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// admin/products.ts — AdminProductRouteRedisClient
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — admin/products dedup gate drives the INJECTED client", () => {
  it("reserves the x-request-id on the INJECTED keyspace at the exact 5-minute window, and never touches the singleton", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildAdminProductsServer(injected);
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/products/prod_01",
        payload: { status: "draft" },
        headers: { "x-request-id": "req-prod-1" },
      });
      expect(res.statusCode).toBe(200);

      const key = rk("product:update:dedup:req-prod-1");
      expect(injected.peek(key)).toBe("1");
      expect(injected.ttlMs(key)).toBe(DEDUP_TTL_MS);
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional] the SAME x-request-id twice reaches the kernel-gated egress exactly ONCE, while a fresh id in the SAME test gets through", async () => {
    const injected = freshInjected();
    const app = await buildAdminProductsServer(injected);
    try {
      const first = await app.inject({
        method: "PATCH",
        url: "/api/admin/products/prod_01",
        payload: { status: "draft" },
        headers: { "x-request-id": "req-prod-double" },
      });
      const second = await app.inject({
        method: "PATCH",
        url: "/api/admin/products/prod_01",
        payload: { status: "draft" },
        headers: { "x-request-id": "req-prod-double" },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: "Requisicao duplicada." });
      // The gate sits IN FRONT of `medusaAdjudicated` — the kernel-gated
      // Medusa write. One reservation, one egress.
      expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(1);

      const distinct = await app.inject({
        method: "PATCH",
        url: "/api/admin/products/prod_01",
        payload: { status: "draft" },
        headers: { "x-request-id": "req-prod-distinct" },
      });
      expect(distinct.statusCode).toBe(200);
      expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(2);

      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — NOT seam evidence] with no deps.redis the dedup gate reserves on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    const app = await buildAdminProductsServer();
    try {
      await app.inject({
        method: "PATCH",
        url: "/api/admin/products/prod_01",
        payload: { status: "draft" },
        headers: { "x-request-id": "req-default-prod" },
      });
      expect(decoy.peek(rk("product:update:dedup:req-default-prod"))).toBe("1");
    } finally {
      await app.close();
    }
  });
});
