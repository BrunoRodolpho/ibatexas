// Coverage for the cart.ts handlers/branches NOT exercised by the existing
// suites (src/__tests__/cart-routes.test.ts covers create/get/line-items/
// promotions/payment-sessions happy paths, the IDOR token matrix, SEC-001,
// and large-ticket confirm; cart-pix-details-envelope.test.ts covers the
// cachePixDetailsForCustomer envelope build).
//
// This file ADDS the uncovered surface:
//   - GET  /api/cart/pix-details (cache-hit + service-fallback + empty)
//   - GET  /api/cart/delivery-estimate (success + 400)
//   - POST /api/coupons/validate (valid/disabled/not-found/error)
//   - POST /api/cart/checkout WITH local items → the sync helper chain
//     (clean-cart clear, completed-cart replace, live-session cancel, 404 replace)
//   - validateCheckoutComposition 422 branches (kitchen-closed/shipping/dine_in)
//   - cart-ownership 403 (incl. the lost-race branch) across mutating routes
//   - payment-sessions payment-collection 500
//   - medusaAdjudicated error mapping on PATCH/DELETE/payment-sessions + re-throw 500
//   - GET /api/cart/orders/:orderId pi_-pending(202), IBX- resolution, full shaping
//   - GET /api/cart/orders/:orderId/status IBX-resolve, medusa-fallback, pending, 502
//   - checkout finalize: fixable-failure 400 (gate release) + note persistence
//
// All external deps are mocked — no DB / network / Redis / LLM. pt-BR copy is
// asserted verbatim where the route owns it.
//
// ── R5 rollout — Redis is the CANONICAL in-memory adapter now ─────────────
//
// This file used to intercept `getRedisClient` and answer a hand-rolled
// nine-command object of constants: `hSet`→1, `expire`→true, `set`→"OK",
// `get`→null, `del`→1, `hGetAll`→{}, plus a `multi` whose pipeline discarded
// everything and an `eval`→null. `routes/cart.ts` now takes its client from
// `CartRouteDeps.redis`, so the client arrives as an ARGUMENT and the double is
// `createInMemoryRedis()` from `@ibatexas/tools/testing` — a real keyspace with
// real NX/TTL/hash semantics — wrapped in a SPY-DELEGATE so every existing
// `toHaveBeenCalledWith` survives while the call actually goes THROUGH.
//
// What that changes, concretely:
//
//   • The ownership guard runs against real SET-NX. The old `set`→"OK" constant
//     meant a claim always "succeeded"; a claim on an already-owned key now
//     really returns null.
//   • The checkout idempotency gate is a real NX+EX key, so its release
//     (`del`) is observable as the key DISAPPEARING, not just as a call.
//   • `rk` is the REAL one. The old fake answered `ibatexas:<key>`; production
//     under this vitest writes `development:<key>` (no `APP_ENV` is pinned in
//     apps/api's config) — the keys under assertion were a prefix nothing
//     writes.
//   • `getRedisClient` is now a TRIPWIRE that rejects. It cannot be deleted
//     from the module factory — `routes/cart.ts` imports it as the default
//     behind `defaultCartRouteDeps` — so it is repurposed into the guard that
//     the threading is real.
//
// The two commands the adapter REFUSES by design (W4 RULE 3) are `multi` and
// `eval`, and this file reaches neither: every checkout here is `cash`, so the
// PIX cache's MULTI pipeline is unreachable, and no case drives
// `POST /api/cart/checkout/confirm`, so the confirmation store's Lua is too.
// That is asserted, not assumed — see the `[seam]` case at the end of the file.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";
// Wire the no-op audit sink BEFORE importing the routes (see cart-routes.test.ts).
import "../../__tests__/setup.js";
// The REAL `rk` (the module mock below forwards it) — every key this file seeds
// or asserts is computed the way production computes it.
import { rk } from "@ibatexas/tools";
import { cartRoutes, type CartRouteRedisClient } from "../cart.js";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

/**
 * TRIPWIRE, not a supplier — see the R5 block in the file header. Every Redis
 * touch in these routes must come from the injected `deps.redis`; reaching the
 * singleton is a failure, and rejecting makes it a LOUD one on the paths that
 * would otherwise swallow it (`loadCachedPixDetails` catches and returns null).
 */
const mockGetRedisClient = vi.hoisted(() =>
  vi.fn(() =>
    Promise.reject(new Error("cart-uncovered-handlers: reached the getRedisClient singleton")),
  ),
);
const mockMedusaStore = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockMedusaAdjudicated = vi.hoisted(() => vi.fn());
const mockAdjudicate = vi.hoisted(() => vi.fn());
const mockAdjudicateAndAudit = vi.hoisted(() => vi.fn());
// BKL-180 — the checkout sync leg hydrates DECLARED allergens from the catalog
// (Typesense) before the order.cart.sync adjudication. Default: a declared empty
// allergens array so the sync-chain checkouts proceed.
const mockTypesenseSearch = vi.hoisted(() =>
  vi.fn(async () => ({ hits: [{ document: { allergens: [] as string[] } }] })),
);
const mockCreateCheckout = vi.hoisted(() => vi.fn());
const mockEstimateDelivery = vi.hoisted(() => vi.fn());
const mockGetMealPeriod = vi.hoisted(() => vi.fn());
const mockLoadSchedule = vi.hoisted(() => vi.fn());
const mockCancelStalePI = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockUpdatePixFromEnvelope = vi.hoisted(() => vi.fn());
const mockAddNote = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());
const mockOrderQueryGetById = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());

const MockMedusaRequestError = vi.hoisted(() =>
  class extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
);
const MockRefusedError = vi.hoisted(() =>
  class extends Error {
    code: string;
    userFacing: string;
    constructor(opts: { code: string; userFacing: string }) {
      super(`Refused: ${opts.code}`);
      this.name = "MedusaAdjudicateRefusedError";
      this.code = opts.code;
      this.userFacing = opts.userFacing;
    }
  },
);
const MockDeferredError = vi.hoisted(() =>
  class extends Error {
    signal: string;
    constructor(opts: { signal: string }) {
      super(`Deferred: ${opts.signal}`);
      this.name = "MedusaAdjudicateDeferredError";
      this.signal = opts.signal;
    }
  },
);
const MockNeedsReviewError = vi.hoisted(() =>
  class extends Error {
    constructor() {
      super("NeedsReview");
      this.name = "MedusaAdjudicateNeedsReviewError";
    }
  },
);

vi.mock("@ibatexas/tools", async () => {
  // Real CPF + per-order-token helpers so any boundary check / mint is faithful.
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>("@ibatexas/tools");
  return {
    getRedisClient: mockGetRedisClient,
    // The REAL rk (Hard Rule #7): the keys these tests assert on are the keys
    // production writes, prefix included.
    rk: actual.rk,
    estimateDelivery: mockEstimateDelivery,
    createCheckout: mockCreateCheckout,
    reaisToCentavos: (amount: number) => Math.round(amount * 100),
    MedusaRequestError: MockMedusaRequestError,
    cancelStalePaymentIntent: mockCancelStalePI,
    loadSchedule: mockLoadSchedule,
    getMealPeriodFromSchedule: mockGetMealPeriod,
    medusaAdjudicated: mockMedusaAdjudicated,
    MedusaAdjudicateRefusedError: MockRefusedError,
    MedusaAdjudicateDeferredError: MockDeferredError,
    MedusaAdjudicateNeedsReviewError: MockNeedsReviewError,
    isValidCpf: actual.isValidCpf,
    normalizeCpf: actual.normalizeCpf,
    createOrderAccessToken: actual.createOrderAccessToken,
    verifyOrderAccessToken: actual.verifyOrderAccessToken,
    // BKL-180 — catalog allergen hydration for the checkout sync leg.
    COLLECTION: "products",
    getTypesenseClient: () => ({
      collections: () => ({ documents: () => ({ search: mockTypesenseSearch }) }),
    }),
  };
});

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    getById: mockGetById,
    updatePixDetailsFromEnvelope: mockUpdatePixFromEnvelope,
  }),
  createOrderCommandService: () => ({
    addNoteFromEnvelope: mockAddNote,
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: mockGetActiveByOrderId,
  }),
  // Dynamically imported inside computeOrderStatus.
  createOrderQueryService: () => ({
    getById: mockOrderQueryGetById,
  }),
  prisma: {
    orderProjection: {
      findFirst: mockFindFirst,
    },
  },
  // FE-T04 — routes/cart.js (imported below) pulls in
  // customer-intent-gateway.js + claustrum/resolve-and-assemble.js, both of
  // which now statically import from @ibatexas/domain. isStructurallyMalformed
  // mirrors real behavior for this file's well-formed envelopes (always
  // `false`) — the gate's own rejection logic is covered by
  // test-envelope-ingress.test.ts and with-adjudicate.test.ts, not here.
  // createReservationService is unexercised by any assertion in this file.
  isStructurallyMalformed: () => false,
  STRUCTURAL_REJECTION_CODE: "envelope_malformed",
  createReservationService: () => ({
    getById: vi.fn().mockResolvedValue(null),
    listByCustomer: vi.fn().mockResolvedValue({ reservations: [] }),
  }),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}));

vi.mock("../admin/_shared.js", () => ({
  medusaStore: mockMedusaStore,
  medusaAdmin: mockMedusaAdmin,
}));

vi.mock("@adjudicate/core/kernel", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, adjudicate: mockAdjudicate };
});

vi.mock("@adjudicate/core", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, adjudicateAndAudit: mockAdjudicateAndAudit };
});

vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    const customerId = request.headers["x-customer-id"] as string | undefined;
    if (!customerId) {
      void reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." });
      return;
    }
    request.customerId = customerId;
    done();
  },
  optionalAuth: (request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => {
    const customerId = request.headers["x-customer-id"] as string | undefined;
    if (customerId) request.customerId = customerId;
    done();
  },
}));

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * The spy-delegate over the canonical adapter (R5-S7).
 *
 * Each command is a `vi.fn()` that FORWARDS to `createInMemoryRedis()`'s
 * client, so `toHaveBeenCalledWith` / `not.toHaveBeenCalled` keep working
 * unedited while the command really executes against a keyspace. A bare Proxy
 * client would have no spyable own properties; a plain double would have no
 * semantics. This has both.
 *
 * Only the commands `routes/cart.ts` issues are wrapped. Anything else falls
 * through to the adapter's throw-on-unrouted Proxy, so a newly-issued command
 * surfaces by NAME instead of returning `undefined`.
 */
type SpyRedis = {
  readonly memory: InMemoryRedis;
  readonly client: CartRouteRedisClient;
  readonly get: Mock;
  readonly set: Mock;
  readonly del: Mock;
  readonly hSet: Mock;
  readonly hDel: Mock;
  readonly hGetAll: Mock;
  readonly expire: Mock;
};

/**
 * A FROZEN clock for the adapter's TTL model.
 *
 * The adapter records expiry as `now() + ttl` and reports `ttlMs` as
 * `expiresAt - now()`. Against the wall clock those two `now()`s differ by a
 * millisecond or two, so an exact TTL assertion is a coin flip. Freezing makes
 * "the 48h TTL" an exact, non-flaky claim — the same technique the R5-S9
 * spill-storage migration used to pin its 7-day window.
 */
const FROZEN_NOW = 1_800_000_000_000;

function createSpyRedis(
  memory: InMemoryRedis = createInMemoryRedis({ now: () => FROZEN_NOW }),
): SpyRedis {
  const real = memory.client;
  const spies = {
    get: vi.fn((...a: unknown[]) => (real.get as (...x: unknown[]) => unknown)(...a)),
    set: vi.fn((...a: unknown[]) => (real.set as (...x: unknown[]) => unknown)(...a)),
    del: vi.fn((...a: unknown[]) => (real.del as (...x: unknown[]) => unknown)(...a)),
    hSet: vi.fn((...a: unknown[]) => (real.hSet as (...x: unknown[]) => unknown)(...a)),
    hDel: vi.fn((...a: unknown[]) => (real.hDel as (...x: unknown[]) => unknown)(...a)),
    hGetAll: vi.fn((...a: unknown[]) => (real.hGetAll as (...x: unknown[]) => unknown)(...a)),
    expire: vi.fn((...a: unknown[]) => (real.expire as (...x: unknown[]) => unknown)(...a)),
  };
  // Spread the adapter's Proxy LAST so unwrapped commands (multi, eval, …) keep
  // throwing by name rather than silently resolving to undefined.
  const client = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string | symbol) =>
      typeof prop === "string" && prop in spies
        ? (spies as Record<string, unknown>)[prop]
        : (real as unknown as Record<string | symbol, unknown>)[prop],
  }) as unknown as CartRouteRedisClient;
  return { memory, client, ...spies };
}

/** The client the route family runs on for the current test. */
let redis: SpyRedis;

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  // R5 rollout — the ONLY override. Every other CartRouteDeps member keeps its
  // production default, which is what makes `@ibatexas/domain`'s module mock
  // still the thing under these tests.
  await app.register(cartRoutes, { deps: { redis: async () => redis.client } });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  redis = createSpyRedis();
  mockGetMealPeriod.mockReturnValue("lunch");
  mockLoadSchedule.mockResolvedValue({ days: {} });
  mockCreateCheckout.mockResolvedValue({ success: true });
  mockEstimateDelivery.mockResolvedValue({ success: true });
  mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
  mockGetById.mockResolvedValue(null);
  mockGetActiveByOrderId.mockResolvedValue(null);
  mockFindFirst.mockResolvedValue(null);
  mockCancelStalePI.mockResolvedValue(undefined);
  mockAddNote.mockResolvedValue({ decision: { kind: "EXECUTE" }, result: undefined });
});

// ── Cart-ownership 403 across mutating routes ────────────────────────────────

describe("cart-ownership guard — 403 on a foreign cart", () => {
  /**
   * Plant the competing owner in the keyspace, for real.
   *
   * The retired double answered every `get` with the constant `"cust_OTHER"` —
   * including the re-GET after a lost NX claim, and including any OTHER key the
   * route might read. This writes ONE key, the one `verifyCartOwnership`
   * actually consults, through the adapter's own SET.
   */
  async function seedForeignOwner(cartId = "cart_01") {
    await redis.memory.client.set(rk(`cart:owner:${cartId}`), "cust_OTHER");
  }

  it("POST /api/cart/:id/line-items → 403", async () => {
    await seedForeignOwner();
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { variant_id: "var_01", quantity: 1 },
      headers: { "x-customer-id": "cust_ME" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Carrinho pertence a outro usuário.");
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled();
  });

  it("PATCH /api/cart/:id/line-items/:itemId → 403", async () => {
    await seedForeignOwner();
    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/cart/cart_01/line-items/item_01",
      payload: { quantity: 3 },
      headers: { "x-customer-id": "cust_ME" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Carrinho pertence a outro usuário.");
  });

  it("DELETE /api/cart/:id/line-items/:itemId → 403", async () => {
    await seedForeignOwner();
    const app = await buildTestServer();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/cart/cart_01/line-items/item_01",
      headers: { "x-customer-id": "cust_ME" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /api/cart/checkout → 403", async () => {
    await seedForeignOwner();
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash" },
      headers: { "x-customer-id": "cust_ME" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Carrinho pertence a outro usuário.");
    // Rejected before schedule/composition/idempotency side-effects.
    expect(mockCreateCheckout).not.toHaveBeenCalled();
  });

  it("lost claim race (NX fails, actual owner differs) → 403", async () => {
    // owner GET null → claim NX returns null (another request won) → re-GET
    // returns a DIFFERENT customer → not us → 403.
    //
    // The retired double asserted this with `get`→"cust_OTHER" + `set`→null,
    // which never reached the race AT ALL: the FIRST get already returned an
    // owner, so `verifyCartOwnership` returned on the `owner === customerId`
    // line and the `set` override was dead code. The race is now driven for
    // real — the interleaving competitor is modelled by planting its claim
    // between our GET and our SET, and every command after that (the failing
    // NX, the re-GET that reads "cust_OTHER") is the adapter's own semantics.
    const ownerKey = rk("cart:owner:cart_01");
    redis.set.mockImplementationOnce(async (...args: unknown[]) => {
      await redis.memory.client.set(ownerKey, "cust_OTHER"); // the competitor wins
      return (redis.memory.client.set as (...x: unknown[]) => Promise<unknown>)(...args);
    });
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { variant_id: "var_01", quantity: 1 },
      headers: { "x-customer-id": "cust_ME" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── validateCheckoutComposition 422 branches ─────────────────────────────────

describe("POST /api/cart/checkout — composition guards (422)", () => {
  it("kitchen closed + IMMEDIATE-DELIVERY food (deliveryType=delivery) → 422 KITCHEN_CLOSED", async () => {
    mockGetMealPeriod.mockReturnValue("closed");
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "card",
        deliveryType: "delivery",
        items: [{ variantId: "v1", quantity: 1, productType: "food" }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("KITCHEN_CLOSED");
    expect(res.json().message).toContain("cozinha está fechada");
    // Decided policy: the refusal surfaces the scheduled-pickup affordance.
    expect(res.json().message).toContain("agendar uma retirada");
  });

  it("kitchen closed + IMMEDIATE-DELIVERY food (deliveryCep present, no type) → 422 KITCHEN_CLOSED", async () => {
    mockGetMealPeriod.mockReturnValue("closed");
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "card",
        deliveryCep: "01310-100",
        items: [{ variantId: "v1", quantity: 1, productType: "food" }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("KITCHEN_CLOSED");
  });

  it("kitchen closed + food + deliveryType=pickup BUT deliveryCep present → 422 KITCHEN_CLOSED (immediate delivery; subset of create-checkout's !deliveryCep pickup set)", async () => {
    mockGetMealPeriod.mockReturnValue("closed");
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "card",
        deliveryType: "pickup",
        deliveryCep: "01310-100",
        items: [{ variantId: "v1", quantity: 1, productType: "food" }],
      },
    });
    // create-checkout keys pickup on the ABSENCE of deliveryCep, so a present cep
    // means immediate DELIVERY downstream — must NOT slip through as scheduled pickup.
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("KITCHEN_CLOSED");
  });

  // Accepted closed-hours paths run the full kernel/executor chain, so the
  // local-item sync helpers need their Medusa mocks (mirrors the sync-chain
  // suite below). EXECUTE → createCheckout is invoked → 200.
  function setupAcceptedCheckoutMocks() {
    mockMedusaStore.mockResolvedValue({ cart: { items: [], payment_collection: null } });
    mockMedusaAdjudicated.mockResolvedValue({ ok: true });
  }

  it("kitchen closed + PICKUP food → ACCEPTED as scheduled (no 422; mirrors create-checkout)", async () => {
    mockGetMealPeriod.mockReturnValue("closed");
    setupAcceptedCheckoutMocks();
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "cash",
        deliveryType: "pickup",
        items: [{ variantId: "v1", quantity: 1, productType: "food" }],
      },
      headers: { "x-customer-id": "cus_01" },
    });
    // No KITCHEN_CLOSED refusal — the order proceeds to the kernel/executor.
    expect(res.statusCode).toBe(200);
    expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
  });

  it("kitchen closed + UNSPECIFIED type/no cep food → treated as pickup → ACCEPTED", async () => {
    mockGetMealPeriod.mockReturnValue("closed");
    setupAcceptedCheckoutMocks();
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "cash",
        items: [{ variantId: "v1", quantity: 1, productType: "food" }],
      },
      headers: { "x-customer-id": "cus_01" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
  });

  it("kitchen closed + PICKUP with frozen/merch only → ACCEPTED (frozen always allowed)", async () => {
    mockGetMealPeriod.mockReturnValue("closed");
    setupAcceptedCheckoutMocks();
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "cash",
        deliveryType: "pickup",
        items: [{ variantId: "v1", quantity: 1, productType: "frozen" }],
      },
      headers: { "x-customer-id": "cus_01" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("shipping with a non-merchandise item → 422 SHIPPING_NON_MERCHANDISE", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "card",
        deliveryType: "shipping",
        items: [{ variantId: "v1", quantity: 1, productType: "food" }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("SHIPPING_NON_MERCHANDISE");
  });

  it("shipping + cash → 422 CASH_NOT_ALLOWED_FOR_SHIPPING", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "cash",
        deliveryType: "shipping",
        items: [{ variantId: "v1", quantity: 1, productType: "merchandise" }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("CASH_NOT_ALLOWED_FOR_SHIPPING");
  });

  it("dine_in without a food item → 422 DINEIN_REQUIRES_FOOD", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "card",
        deliveryType: "dine_in",
        items: [{ variantId: "v1", quantity: 1, productType: "merchandise" }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("DINEIN_REQUIRES_FOOD");
  });
});

// ── POST /api/cart/checkout WITH local items → sync helper chain ──────────────

describe("POST /api/cart/checkout — local-item sync chain", () => {
  const merchItems = [{ variantId: "var_A", quantity: 2, productType: "merchandise" as const }];

  it("clean cart: clears existing items then re-adds local items, EXECUTE 200", async () => {
    // Existing cart is clean (no completed_at / no payment sessions) with one stale item.
    mockMedusaStore.mockResolvedValue({ cart: { items: [{ id: "old_1" }], payment_collection: null } });
    mockMedusaAdjudicated.mockResolvedValue({ ok: true });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash", deliveryType: "pickup", items: merchItems },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    // Stale item removed in place.
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/store/carts/cart_01/line-items/old_1",
        intentKind: "medusa.cart.line_items.remove",
      }),
    );
    // Local item re-added with its productType metadata.
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/store/carts/cart_01/line-items",
        intentKind: "medusa.cart.line_items.add",
        payload: { variant_id: "var_A", quantity: 2, metadata: { productType: "merchandise" } },
      }),
    );
    expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
  });

  it("completed cart: binds the new cart to the customer's Medusa id and checks out the new cart", async () => {
    mockGetById.mockResolvedValue({ medusaId: "med_1" });
    mockMedusaStore.mockResolvedValue({ cart: { completed_at: "2026-06-01T00:00:00Z", items: [] } });
    mockMedusaAdjudicated.mockImplementation(async (opts: { intentKind: string }) => {
      if (opts.intentKind === "medusa.cart.create") return { cart: { id: "cart_NEW" } };
      return { ok: true };
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash", deliveryType: "pickup", items: merchItems },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    // New cart created, customer-bound.
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/store/carts",
        intentKind: "medusa.cart.create",
        payload: { customer_id: "med_1" },
      }),
    );
    // Local item added to the NEW cart, not the stale one.
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/store/carts/cart_NEW/line-items",
        intentKind: "medusa.cart.line_items.add",
      }),
    );
  });

  it("cart with live payment sessions: cancels the Stripe PI then replaces the cart", async () => {
    mockMedusaStore.mockResolvedValue({
      cart: {
        items: [],
        payment_collection: {
          id: "pc_1",
          payment_sessions: [{ id: "ps_1", provider_id: "pp_stripe_stripe", data: { id: "pi_LIVE" } }],
        },
      },
    });
    mockMedusaAdjudicated.mockImplementation(async (opts: { intentKind: string }) => {
      if (opts.intentKind === "medusa.cart.create") return { cart: { id: "cart_NEW" } };
      return { ok: true };
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash", deliveryType: "pickup", items: merchItems },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    // The orphan-QR Stripe PaymentIntent is cancelled before replacing the cart.
    expect(mockCancelStalePI).toHaveBeenCalledWith("pi_LIVE");
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({ intentKind: "medusa.cart.create" }),
    );
  });

  it("purged cart (Medusa 404): creates a fresh cart and proceeds", async () => {
    mockMedusaStore.mockRejectedValue(new MockMedusaRequestError(404, "cart not found"));
    mockMedusaAdjudicated.mockImplementation(async (opts: { intentKind: string }) => {
      if (opts.intentKind === "medusa.cart.create") return { cart: { id: "cart_FRESH" } };
      return { ok: true };
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_GONE", paymentMethod: "cash", deliveryType: "pickup", items: merchItems },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({ intentKind: "medusa.cart.create" }),
    );
  });

  it("new-cart creation returns no id → 500", async () => {
    mockMedusaStore.mockResolvedValue({ cart: { completed_at: "2026-06-01T00:00:00Z", items: [] } });
    mockMedusaAdjudicated.mockImplementation(async (opts: { intentKind: string }) => {
      if (opts.intentKind === "medusa.cart.create") return { cart: undefined };
      return { ok: true };
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash", deliveryType: "pickup", items: merchItems },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toBe("Não foi possível criar um novo carrinho.");
  });
});

// ── checkout finalize side-effects ───────────────────────────────────────────

describe("POST /api/cart/checkout — finalize side-effects", () => {
  it("createCheckout failure → 400 and the idempotency gate is released", async () => {
    mockCreateCheckout.mockResolvedValue({ success: false, message: "Estoque insuficiente." });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash" },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    // The fixable-failure gate release (redis.del) ran so the customer can retry.
    expect(redis.del).toHaveBeenCalledWith(
      expect.stringContaining("checkout:idem:"),
    );
  });

  it("COUPON_REJECTED (D1 fail-closed coupon) → 422 with the typed code + pt-BR error, gate released", async () => {
    mockCreateCheckout.mockResolvedValue({
      success: false,
      code: "COUPON_REJECTED",
      message: "O cupom não pôde ser aplicado (expirado ou esgotado). Remova o cupom e tente novamente.",
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash", couponCode: "SAVE10" },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.code).toBe("COUPON_REJECTED");
    // The web checkout renders data.error ?? data.message — both carry the pt-BR copy.
    expect(body.error).toContain("cupom");
    expect(body.message).toContain("cupom");
    // The fixable-failure gate release ran so the customer can remove the coupon and retry.
    expect(redis.del).toHaveBeenCalledWith(
      expect.stringContaining("checkout:idem:"),
    );
  });

  it("success with notes + IBX order → persists the note via order.note.add envelope", async () => {
    mockCreateCheckout.mockResolvedValue({ success: true, orderId: "IBX-0004", paymentMethod: "cash" });
    mockFindFirst.mockResolvedValue({
      id: "proj_1",
      customerId: "cus_01",
      paymentMethod: "cash",
      paymentStatus: "pending",
      totalInCentavos: 5000,
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash", notes: "Sem cebola, por favor." },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().orderId).toBe("IBX-0004");
    // Display-id resolved to the projection's internal id.
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { displayId: 4 } }),
    );
    // Note routed through the kernel-adjudicated order.note.add envelope.
    expect(mockAddNote).toHaveBeenCalledTimes(1);
    const [envelope] = mockAddNote.mock.calls[0]!;
    expect(envelope.kind).toBe("order.note.add");
    expect(envelope.payload).toEqual({ orderId: "proj_1", body: "Sem cebola, por favor." });
    // Successful order untracks the cart owner key.
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining("cart:owner:cart_01"));
  });
});

// ── medusaAdjudicated error mapping (uncovered routes) ───────────────────────

describe("cart routes — medusaAdjudicated error mapping (uncovered)", () => {
  it("PATCH line-items REFUSE → 403 pt-BR", async () => {
    mockMedusaAdjudicated.mockRejectedValue(
      new MockRefusedError({ code: "qty.blocked", userFacing: "Quantidade bloqueada." }),
    );
    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/cart/cart_01/line-items/item_01",
      payload: { quantity: 5 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Quantidade bloqueada.");
    expect(res.json().code).toBe("qty.blocked");
  });

  it("DELETE line-items DEFER → 202", async () => {
    mockMedusaAdjudicated.mockRejectedValue(new MockDeferredError({ signal: "stock.hold" }));
    const app = await buildTestServer();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/cart/cart_01/line-items/item_01",
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("deferred");
    expect(res.json().signal).toBe("stock.hold");
  });

  it("payment-sessions DEFER → 202", async () => {
    mockMedusaStore.mockResolvedValue({ cart: { payment_collection: { id: "pc_1" } } });
    mockMedusaAdjudicated.mockRejectedValue(new MockDeferredError({ signal: "psp.retry" }));
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/payment-sessions",
      payload: { provider_id: "pp_stripe_stripe" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().signal).toBe("psp.retry");
  });

  it("payment-sessions: payment-collection create returns no id → 500", async () => {
    mockMedusaStore.mockResolvedValue({ cart: { payment_collection: null } });
    mockMedusaAdjudicated.mockResolvedValue({ payment_collection: undefined });
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/payment-sessions",
      payload: { provider_id: "pp_stripe_stripe" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("Failed to create payment collection");
  });

  it("POST /api/cart re-throws a non-typed error → 500", async () => {
    mockMedusaAdjudicated.mockRejectedValue(new Error("medusa down"));
    const app = await buildTestServer();
    const res = await app.inject({ method: "POST", url: "/api/cart" });
    // Not a typed REFUSE/DEFER/REVIEW → mapMedusaErrorToReply returns false →
    // the route re-throws → Fastify default 500.
    expect(res.statusCode).toBe(500);
  });
});

// ── GET /api/cart/pix-details ────────────────────────────────────────────────

describe("GET /api/cart/pix-details", () => {
  it("returns the Redis-cached PIX details (cache hit) and refreshes the TTL", async () => {
    // A REAL hash at the key the route reads, written with the same HSET the
    // PIX cache write uses — the retired double answered a constant object for
    // every hGetAll, whatever the key.
    await redis.memory.client.hSet(rk("customer:pix:cus_01"), {
      name: "Ana",
      email: "ana@x.com",
      cpf: "39053344705",
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/pix-details",
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "Ana", email: "ana@x.com", cpf: "39053344705" });
    expect(redis.expire).toHaveBeenCalled();
  });

  it("falls back to the customer service when Redis has no cache", async () => {
    // The keyspace is empty — hGetAll answers {} because nothing was cached.
    mockGetById.mockResolvedValue({ name: "Bob", email: "bob@x.com", cpf: "11144477735" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/pix-details",
      headers: { "x-customer-id": "cus_02" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "Bob", email: "bob@x.com", cpf: "11144477735" });
  });

  it("returns {} when nothing is cached and the customer lookup yields nothing", async () => {
    mockGetById.mockResolvedValue(null);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/pix-details",
      headers: { "x-customer-id": "cus_03" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it("requires authentication (401 without x-customer-id)", async () => {
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/pix-details" });
    expect(res.statusCode).toBe(401);
  });
});

// ── GET /api/cart/delivery-estimate ──────────────────────────────────────────

describe("GET /api/cart/delivery-estimate", () => {
  it("returns the estimate on success", async () => {
    mockEstimateDelivery.mockResolvedValue({ success: true, feeInCentavos: 500, etaMinutes: 40 });
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/delivery-estimate?cep=01310100" });
    expect(res.statusCode).toBe(200);
    expect(res.json().feeInCentavos).toBe(500);
    expect(mockEstimateDelivery).toHaveBeenCalledWith({ cep: "01310100" });
  });

  it("returns 400 when the estimate fails (out-of-range CEP)", async () => {
    mockEstimateDelivery.mockResolvedValue({ success: false, error: "Fora da área de entrega." });
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/delivery-estimate?cep=99999999" });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it("returns 400 on a malformed CEP (schema validation)", async () => {
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/delivery-estimate?cep=123" });
    expect(res.statusCode).toBe(400);
  });
});

// ── POST /api/coupons/validate ───────────────────────────────────────────────

describe("POST /api/coupons/validate (BKL-070 display-parity)", () => {
  const validate = async (code: string) => {
    const app = await buildTestServer();
    return app.inject({ method: "POST", url: "/api/coupons/validate", payload: { code } });
  };

  it("active promotion, no campaign constraints → { valid: true, discount }", async () => {
    mockMedusaAdmin.mockResolvedValue({
      promotions: [{ id: "p1", code: "VIP10", status: "active", application_method: { value: 1000, type: "percentage" } }],
    });
    const res = await validate("VIP10");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, discount: 1000 });
  });

  it("status draft / inactive → { valid: false } (the v2 lifecycle flag — is_disabled was dead)", async () => {
    for (const status of ["draft", "inactive"] as const) {
      mockMedusaAdmin.mockResolvedValue({
        promotions: [{ id: "p2", code: "OLD", status, application_method: { value: 500 } }],
      });
      const res = await validate("OLD");
      expect(res.json()).toEqual({ valid: false });
    }
  });

  it("status ABSENT → { valid: false } (display-side fail-closed, never a vacuous pass)", async () => {
    mockMedusaAdmin.mockResolvedValue({
      promotions: [{ id: "p3", code: "GHOST", application_method: { value: 500 } }],
    });
    const res = await validate("GHOST");
    expect(res.json()).toEqual({ valid: false });
  });

  it("campaign window: ends_at in the past → { valid: false }; starts_at in the future → { valid: false }", async () => {
    mockMedusaAdmin.mockResolvedValue({
      promotions: [{ id: "p4", code: "EXPIRED", status: "active", campaign: { ends_at: "2020-01-01T00:00:00.000Z" }, application_method: { value: 500 } }],
    });
    expect((await validate("EXPIRED")).json()).toEqual({ valid: false });
    mockMedusaAdmin.mockResolvedValue({
      promotions: [{ id: "p5", code: "SOON", status: "active", campaign: { starts_at: "2999-01-01T00:00:00.000Z" }, application_method: { value: 500 } }],
    });
    expect((await validate("SOON")).json()).toEqual({ valid: false });
  });

  it("campaign in-window (both bounds) → { valid: true }", async () => {
    mockMedusaAdmin.mockResolvedValue({
      promotions: [{
        id: "p6", code: "NOW", status: "active",
        campaign: { starts_at: "2020-01-01T00:00:00.000Z", ends_at: "2999-01-01T00:00:00.000Z" },
        application_method: { value: 700 },
      }],
    });
    expect((await validate("NOW")).json()).toEqual({ valid: true, discount: 700 });
  });

  it("promotion-level usage budget exhausted (used >= limit) → { valid: false }", async () => {
    mockMedusaAdmin.mockResolvedValue({
      promotions: [{ id: "p7", code: "USEDUP", status: "active", limit: 100, used: 100, application_method: { value: 500 } }],
    });
    expect((await validate("USEDUP")).json()).toEqual({ valid: false });
  });

  it("campaign usage/spend budget exhausted → { valid: false }", async () => {
    for (const type of ["usage", "spend"] as const) {
      mockMedusaAdmin.mockResolvedValue({
        promotions: [{
          id: "p8", code: "CAMPCAP", status: "active",
          campaign: { budget: { type, limit: 50, used: 50 } },
          application_method: { value: 500 },
        }],
      });
      expect((await validate("CAMPCAP")).json()).toEqual({ valid: false });
    }
  });

  it("per-attribute budget types are NOT evaluated (would over-reject without the attribute) → { valid: true }", async () => {
    for (const type of ["use_by_attribute", "spend_by_attribute"] as const) {
      mockMedusaAdmin.mockResolvedValue({
        promotions: [{
          id: "p9", code: "PERCUST", status: "active",
          campaign: { budget: { type, limit: 1, used: 999 } },
          application_method: { value: 300 },
        }],
      });
      expect((await validate("PERCUST")).json()).toEqual({ valid: true, discount: 300 });
    }
  });

  it("unlimited budgets (null limit) and under-budget usage stay valid", async () => {
    mockMedusaAdmin.mockResolvedValue({
      promotions: [{
        id: "p10", code: "OK", status: "active", limit: null, used: 3,
        campaign: { budget: { type: "usage", limit: 100, used: 3 } },
        application_method: { value: 250 },
      }],
    });
    expect((await validate("OK")).json()).toEqual({ valid: true, discount: 250 });
  });

  it("no matching promotion → { valid: false }", async () => {
    mockMedusaAdmin.mockResolvedValue({ promotions: [] });
    expect((await validate("NOPE")).json()).toEqual({ valid: false });
  });

  it("Medusa error → { valid: false } (never 500; display-side fail-closed)", async () => {
    mockMedusaAdmin.mockRejectedValue(new Error("medusa down"));
    const res = await validate("X");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });
  });
});

// ── GET /api/cart/orders/:orderId — resolution + shaping (uncovered) ─────────

describe("GET /api/cart/orders/:orderId — order resolution + shaping", () => {
  it("pi_ id with no matching order yet → 202 pending", async () => {
    mockMedusaAdmin.mockResolvedValue({ orders: [] });
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/orders/pi_PENDING" });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
    expect(res.json().paymentIntentId).toBe("pi_PENDING");
  });

  it("IBX- display id resolves via the projection then converts reais→centavos + shapes currentPayment", async () => {
    mockFindFirst.mockResolvedValue({ id: "order_X" });
    mockMedusaAdmin.mockResolvedValue({
      order: {
        id: "order_X",
        status: "completed",
        display_id: 4,
        total: 178,
        subtotal: 158,
        shipping_total: 20,
        customer_id: "cus_ME",
        metadata: { deliveryType: "delivery", tipInCentavos: "300" },
        items: [{ id: "i1", title: "Costela", quantity: 1, unit_price: 158, metadata: { productType: "food" } }],
        created_at: "2026-06-25T00:00:00.000Z",
      },
    });
    mockGetActiveByOrderId.mockResolvedValue({
      id: "cp_1",
      method: "pix",
      status: "pending",
      amountInCentavos: 17800,
      pixExpiresAt: new Date("2026-06-30T00:00:00.000Z"),
      version: 2,
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/IBX-0004",
      headers: { "x-customer-id": "cus_ME" },
    });

    expect(res.statusCode).toBe(200);
    const order = res.json().order;
    // reais → centavos conversion.
    expect(order.total).toBe(17800);
    expect(order.subtotal).toBe(15800);
    expect(order.items[0].unit_price).toBe(15800);
    expect(order.items[0].productType).toBe("food");
    // payment projection shaping.
    expect(order.payment_method).toBe("pix");
    expect(order.payment_status).toBe("pending");
    expect(order.currentPayment).toEqual({
      id: "cp_1",
      method: "pix",
      status: "pending",
      amountInCentavos: 17800,
      pixExpiresAt: "2026-06-30T00:00:00.000Z",
      version: 2,
    });
    expect(order.tip_in_centavos).toBe(300);
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { displayId: 4 } }),
    );
  });

  it("IBX- id with no projection AND no Medusa display_id hit → 202 pending", async () => {
    mockFindFirst.mockResolvedValue(null);
    mockMedusaAdmin.mockResolvedValue({ orders: [] });
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/orders/IBX-0099" });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
  });
});

// ── GET /api/cart/orders/:orderId/status — resolution + fallback (uncovered) ─

describe("GET /api/cart/orders/:orderId/status — resolution + Medusa fallback", () => {
  it("IBX- id resolves via projection id then reads status from the projection (200)", async () => {
    mockFindFirst.mockResolvedValue({ id: "order_X" });
    mockOrderQueryGetById.mockResolvedValue({
      customerId: "cus_ME",
      fulfillmentStatus: "preparing",
      updatedAt: new Date("2026-06-25T00:00:00.000Z"),
    });
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/IBX-0004/status",
      headers: { "x-customer-id": "cus_ME" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("preparing");
    expect(res.json().source).toBe("projection");
    // The IBX- id was resolved to the projection's internal id before the query.
    expect(mockOrderQueryGetById).toHaveBeenCalledWith("order_X");
  });

  it("projection miss → Medusa fallback maps not_fulfilled → pending (200, source=medusa_fallback)", async () => {
    mockOrderQueryGetById.mockResolvedValue(null);
    mockMedusaAdmin.mockResolvedValue({
      order: {
        fulfillment_status: "not_fulfilled",
        customer_id: "cus_ME",
        updated_at: "2026-06-25T01:00:00.000Z",
      },
    });
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_raw/status",
      headers: { "x-customer-id": "cus_ME" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("pending"); // not_fulfilled → pending
    expect(res.json().source).toBe("medusa_fallback");
  });

  it("projection miss + Medusa has no order → 202 pending", async () => {
    mockOrderQueryGetById.mockResolvedValue(null);
    mockMedusaAdmin.mockResolvedValue({ order: undefined });
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/orders/order_missing/status" });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
  });

  it("query service throws → 502", async () => {
    mockOrderQueryGetById.mockRejectedValue(new Error("projection store down"));
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/orders/order_err/status" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("Failed to fetch order status");
  });
});

// ── The Redis client seam, born guarded (F-5) ────────────────────────────────
//
// Every case above injects a client and then asserts on it. That is NOT proof
// the route used the injection: if `CartRouteDeps.redis` were dropped and
// `routes/cart.ts` went back to `await getRedisClient()`, most of those cases
// would still be green — the ownership 403s would come from a `get` that
// answers nothing, the estimate/coupon/order-read cases never touch Redis at
// all, and `loadCachedPixDetails` SWALLOWS its failure into a cache-miss.
//
// So the seam is pinned on its CONSUMING SURFACE, three ways:
//   1. the write really landed in the injected keyspace (state, not calls);
//   2. the process singleton was never resolved (the tripwire's call count);
//   3. the family's declared command set is the set actually issued — which is
//      also what proves the two W4-refused commands (`multi`, `eval`) are out
//      of this file's reach rather than merely unasserted.

describe("[seam] cart routes drive the INJECTED Redis client", () => {
  it("the cart-tracking write lands in the injected keyspace, at the real rk key", async () => {
    mockMedusaAdjudicated.mockResolvedValue({ cart: { id: "cart_seam" } });
    const app = await buildTestServer();

    const res = await app.inject({ method: "POST", url: "/api/cart" });
    expect(res.statusCode).toBe(201);

    // STATE, not a call: the field exists in the adapter's own hash.
    expect(redis.memory.keys()).toContain(rk("active:carts"));
    const tracked = await redis.memory.client.hGetAll(rk("active:carts"));
    expect(JSON.parse(tracked["cart_seam"]!)).toMatchObject({
      cartId: "cart_seam",
      sessionType: "guest",
    });
    // …and the 48h TTL is a real remaining lifetime, not a `true` constant.
    expect(redis.memory.ttlMs(rk("active:carts"))).toBe(48 * 60 * 60 * 1000);
  });

  it("the checkout idempotency gate is a real NX key, released by the fixable-failure DEL", async () => {
    mockCreateCheckout.mockResolvedValue({ success: false, message: "Estoque insuficiente." });
    const app = await buildTestServer();

    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_gate", paymentMethod: "cash" },
      headers: { "x-customer-id": "cus_gate" },
    });
    expect(res.statusCode).toBe(400);

    // The release is observable as ABSENCE, which a `del`→1 constant could not
    // show: the gate key is gone from the keyspace, so a retry can re-claim it.
    expect(redis.memory.keys()).not.toContain(rk("checkout:idem:cart_gate"));
    const reclaim = await redis.memory.client.set(
      rk("checkout:idem:cart_gate"),
      "1",
      { NX: true, EX: 120 },
    );
    expect(reclaim).toBe("OK");
  });

  it("never resolves the getRedisClient singleton, and issues only the declared commands", async () => {
    mockMedusaAdjudicated.mockResolvedValue({ cart: { id: "cart_probe" } });
    mockCreateCheckout.mockResolvedValue({ success: true, orderId: "IBX-0009" });
    const app = await buildTestServer();

    await app.inject({ method: "POST", url: "/api/cart" });
    await app.inject({
      method: "POST",
      url: "/api/cart/cart_probe/line-items",
      payload: { variant_id: "var_1", quantity: 1 },
      headers: { "x-customer-id": "cus_probe" },
    });
    await app.inject({
      method: "GET",
      url: "/api/cart/pix-details",
      headers: { "x-customer-id": "cus_probe" },
    });
    await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_probe", paymentMethod: "cash" },
      headers: { "x-customer-id": "cus_probe" },
    });

    // (2) The singleton was never reached. Its tripwire rejects, and
    // `loadCachedPixDetails` would have swallowed that into a null — so the
    // call COUNT is the only honest observation available.
    expect(mockGetRedisClient).not.toHaveBeenCalled();

    // (3) The observed command set. `CartRouteRedisClient` declares NINE
    // commands; the four requests above issue SEVEN of them — every member
    // except the two the adapter refuses. So the Pick is not over-declared on
    // this surface: each of these seven is genuinely reachable from a route,
    // not a guess someone widened the type with.
    //
    // The two absentees are the whole reason this file could migrate at all:
    // `multi` (the PIX cache write — unreachable because every checkout here is
    // `cash`) and `eval` (the confirmation store — unreachable because no case
    // drives /checkout/confirm). A route change that put either on one of these
    // paths would throw BY NAME out of the adapter's Proxy, and this assertion
    // pins that their absence is a property of the driven paths rather than of
    // what the file happens to assert.
    const issued = new Set(redis.memory.calls.map((c) => c.command));
    expect(issued).not.toContain("multi");
    expect(issued).not.toContain("eval");
    expect([...issued].sort()).toEqual(
      ["del", "expire", "get", "hDel", "hGetAll", "hSet", "set"].sort(),
    );
  });
});

// Type assertion helper so the mocks satisfy TS in `.mock.calls` access.
const _typed: Mock = mockAddNote;
void _typed;
