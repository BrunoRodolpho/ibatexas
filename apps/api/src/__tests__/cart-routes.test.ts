// Unit tests for cart routes
// POST /api/cart, GET /api/cart/:id, POST /api/cart/:id/line-items,
// PATCH /api/cart/:id/line-items/:itemId, DELETE /api/cart/:id/line-items/:itemId,
// POST /api/cart/:id/promotions, POST /api/cart/:id/payment-sessions

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";
// Wire the no-op audit sink BEFORE importing the routes. `getAuditSink()`
// (@ibatexas/audit-sink) is fail-closed: it throws AuditSinkNotInitializedError
// until `__setAuditSinkDependencies(...)` runs, and the cart routes build
// wrapper meta with `auditSink: getAuditSink()` on every governed egress +
// checkout. The apps/api vitest config wires this via `setupFiles`, but a direct
// `vitest run` from the repo ROOT resolves the root vitest.config.ts (no
// setupFiles), leaving the sink un-wired → every write/checkout route 500s.
// Importing the canonical setup here makes this test file config-independent
// (idempotent: __setAuditSinkDependencies just re-assigns the deps).
import "./setup.js";
import { cartRoutes } from "../routes/cart.js";
import {
  createCheckoutConfirmationStore,
  type PendingCheckout,
} from "../routes/checkout-confirmation-store.js";
// R0a — the mocked `@ibatexas/tools` re-exports the REAL token helpers
// (importActual above) and the mocked `createCheckout`. We mint/verify tokens
// with the real helpers and override createCheckout's resolved value to assert
// the checkout response carries a valid per-order token.
import {
  createOrderAccessToken,
  verifyOrderAccessToken,
  createCheckout,
} from "@ibatexas/tools";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockMedusaStore = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
// P0-X9 follow-up: cart route mutations go through medusaAdjudicated.
// We mock it as a standalone function (NOT a passthrough to medusaStore)
// per the anti-theater rule — tests must assert the wrapper was called.
const mockMedusaAdjudicated = vi.hoisted(() => vi.fn());
// Polish-B follow-up: customer-intent-gateway calls `adjudicate()` from
// `@adjudicate/core/kernel`. SEC-001 tests isolate the route's auth gate
// from the kernel decision; default to EXECUTE so the EXECUTE/REWRITE
// branch of `runCustomerIntent` falls through to the route's own logic.
const mockAdjudicate = vi.hoisted(() => vi.fn());
// The checkout-confirm RESUME path routes through the AUDITED kernel verb
// `adjudicateAndAudit` (from `@adjudicate/core`), not the pure `adjudicate`.
// Mock it so confirm tests control the resolved decision without the real
// kernel/audit-sink I/O. No existing test touches this verb.
const mockAdjudicateAndAudit = vi.hoisted(() => vi.fn());
// R0a — the /status route resolves order projections via
// createOrderQueryService().getById. Hoisted so each test controls the owner
// attribution (null owner = guest order) under test.
const mockOrderQueryGetById = vi.hoisted(() => vi.fn());

const MockMedusaRequestError = vi.hoisted(() =>
  class extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  }
);

// P0-X9: typed errors the wrapper can throw. Mocks need to be `instanceof`-able.
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
  // Use the REAL Receita Federal CPF validators so the P1-DATA-CPF checkout
  // boundary check is exercised faithfully (not a stubbed always-true).
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>("@ibatexas/tools");
  return {
    getRedisClient: mockGetRedisClient,
    rk: mockRk,
    estimateDelivery: vi.fn(async () => ({ success: true })),
    createCheckout: vi.fn(async () => ({ success: true })),
    reaisToCentavos: (amount: number) => Math.round(amount * 100),
    MedusaRequestError: MockMedusaRequestError,
    cancelStalePaymentIntent: vi.fn().mockResolvedValue(undefined),
    loadSchedule: vi.fn().mockResolvedValue({ days: {} }),
    getMealPeriodFromSchedule: vi.fn().mockReturnValue("lunch"),
    medusaAdjudicated: mockMedusaAdjudicated,
    MedusaAdjudicateRefusedError: MockRefusedError,
    MedusaAdjudicateDeferredError: MockDeferredError,
    MedusaAdjudicateNeedsReviewError: MockNeedsReviewError,
    isValidCpf: actual.isValidCpf,
    normalizeCpf: actual.normalizeCpf,
    // R0a — use the REAL per-order token helpers so the IDOR/binding/expiry
    // guards are exercised faithfully (HMAC sign+verify, not a stubbed true).
    createOrderAccessToken: actual.createOrderAccessToken,
    verifyOrderAccessToken: actual.verifyOrderAccessToken,
  };
});

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    getById: vi.fn().mockResolvedValue(null),
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: vi.fn().mockResolvedValue(null),
  }),
  // R0a — the /status route imports this dynamically for the projection path.
  createOrderQueryService: () => ({
    getById: mockOrderQueryGetById,
  }),
  prisma: {
    orderProjection: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}));

vi.mock("../routes/admin/_shared.js", () => ({
  medusaStore: mockMedusaStore,
  medusaAdmin: mockMedusaAdmin,
}));

vi.mock("@adjudicate/core/kernel", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    adjudicate: mockAdjudicate,
  };
});

// Preserve every real @adjudicate/core export (buildEnvelope, buildAuditRecord,
// localizeDecision, …) — only the audited verb is swapped so the confirm path
// is deterministic in the sandbox.
vi.mock("@adjudicate/core", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    adjudicateAndAudit: mockAdjudicateAndAudit,
  };
});

vi.mock("../middleware/auth.js", () => ({
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
    if (customerId) {
      request.customerId = customerId;
    }
    done();
  },
}));

// ── Server factory ─────────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(cartRoutes);
  await app.ready();
  return app;
}

// ── Mock Redis client ─────────────────────────────────────────────────────────

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    hSet: vi.fn().mockResolvedValue(1),
    hDel: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(true),
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// Map-backed Redis with NX-aware `set` + a GET+DEL `eval` so the checkout
// park→confirm round-trip (idempotency gate, cart-owner claim, single-use
// confirmation receipt) can be exercised against one consistent store.
function createStatefulRedis() {
  const kv = new Map<string, string>();
  return {
    kv,
    hSet: vi.fn().mockResolvedValue(1),
    hDel: vi.fn().mockResolvedValue(1),
    hGetAll: vi.fn().mockResolvedValue({}),
    expire: vi.fn().mockResolvedValue(true),
    set: vi.fn(async (key: string, val: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && kv.has(key)) return null;
      kv.set(key, val);
      return "OK";
    }),
    get: vi.fn(async (key: string) => kv.get(key) ?? null),
    del: vi.fn(async (key: string) => (kv.delete(key) ? 1 : 0)),
    eval: vi.fn(async (_script: string, opts: { keys: string[] }) => {
      const key = opts.keys[0];
      const val = kv.get(key);
      if (val !== undefined) {
        kv.delete(key);
        return val;
      }
      return null;
    }),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/cart — create cart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("creates a cart and tracks it in Redis (via medusaAdjudicated)", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    // P0-X9: mutations go through medusaAdjudicated, NOT bare medusaStore.
    mockMedusaAdjudicated.mockResolvedValue({ cart: { id: "cart_01", items: [] } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart",
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.cart.id).toBe("cart_01");

    // Cart ID tracked in Redis active:carts hash
    expect(mockRedis.hSet).toHaveBeenCalledWith(
      expect.stringContaining("active:carts"),
      "cart_01",
      expect.stringContaining("cart_01"),
    );

    // P0-X9 anti-theater: medusaAdjudicated WAS called with the
    // kernel-gated envelope shape. Bare medusaStore is NOT invoked
    // for this mutation.
    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(1);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "POST",
        path: "/store/carts",
        intentKind: "medusa.cart.create",
      }),
    );
    expect(mockMedusaStore).not.toHaveBeenCalled();
  });

  it("passes customer_id when authenticated", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockResolvedValue({ cart: { id: "cart_02", items: [] } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(201);
    // Cart creation sends empty body — customer association happens via Medusa session
    // P0-X9: the payload (not the body string) is what the wrapper sees.
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "POST",
        path: "/store/carts",
        payload: {},
      }),
    );
  });

  it("creates anonymous cart without customer_id", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockResolvedValue({ cart: { id: "cart_03", items: [] } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart",
    });

    expect(res.statusCode).toBe(201);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {},
        path: "/store/carts",
      }),
    );
  });
});

describe("GET /api/cart/:id — get cart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns cart data from Medusa", async () => {
    // Medusa v2 returns prices in reais — this is a passthrough proxy
    mockMedusaStore.mockResolvedValue({
      cart: {
        id: "cart_01",
        items: [
          { id: "item_01", variant_id: "var_01", quantity: 2, unit_price: 89 },
        ],
        total: 178,
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/cart_01",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cart.id).toBe("cart_01");
    expect(body.cart.items).toHaveLength(1);
    expect(body.cart.total).toBe(178);
  });

  it("calls medusaStore with correct path", async () => {
    mockMedusaStore.mockResolvedValue({ cart: { id: "cart_xyz" } });

    const app = await buildTestServer();
    await app.inject({ method: "GET", url: "/api/cart/cart_xyz" });

    expect(mockMedusaStore).toHaveBeenCalledWith("/store/carts/cart_xyz");
  });
});

describe("POST /api/cart/:id/line-items — add item", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("adds item to cart (via medusaAdjudicated) and tracks cart in Redis", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockResolvedValue({
      cart: {
        id: "cart_01",
        items: [{ id: "item_01", variant_id: "var_01", quantity: 1 }],
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { variant_id: "var_01", quantity: 1 },
    });

    expect(res.statusCode).toBe(201);

    // Cart tracked in active:carts hash
    expect(mockRedis.hSet).toHaveBeenCalledWith(
      expect.stringContaining("active:carts"),
      "cart_01",
      expect.stringContaining("cart_01"),
    );

    // P0-X9: medusaAdjudicated called with the kernel-gated envelope
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "POST",
        path: "/store/carts/cart_01/line-items",
        intentKind: "medusa.cart.line_items.add",
        payload: { variant_id: "var_01", quantity: 1 },
      }),
    );
    expect(mockMedusaStore).not.toHaveBeenCalled();
  });

  it("returns 400 when variant_id is missing", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { quantity: 1 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when quantity is 0", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { variant_id: "var_01", quantity: 0 },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/cart/:id/line-items/:itemId — update quantity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("updates item quantity (via medusaAdjudicated)", async () => {
    mockMedusaAdjudicated.mockResolvedValue({
      cart: {
        id: "cart_01",
        items: [{ id: "item_01", variant_id: "var_01", quantity: 3 }],
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/cart/cart_01/line-items/item_01",
      payload: { quantity: 3 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "POST",
        path: "/store/carts/cart_01/line-items/item_01",
        intentKind: "medusa.cart.line_items.update",
        payload: { quantity: 3 },
      }),
    );
  });

  it("returns 400 when quantity is invalid", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/cart/cart_01/line-items/item_01",
      payload: { quantity: -1 },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/cart/:id/line-items/:itemId — remove item", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("removes item from cart (via medusaAdjudicated)", async () => {
    mockMedusaAdjudicated.mockResolvedValue({
      cart: { id: "cart_01", items: [] },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/cart/cart_01/line-items/item_01",
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "DELETE",
        path: "/store/carts/cart_01/line-items/item_01",
        intentKind: "medusa.cart.line_items.remove",
      }),
    );
  });
});

describe("POST /api/cart/:id/promotions — apply coupon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("applies promotion code to cart (via medusaAdjudicated)", async () => {
    mockMedusaAdjudicated.mockResolvedValue({
      cart: { id: "cart_01", discount_total: 10 },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/promotions",
      payload: { promo_codes: ["PROMO10"] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "POST",
        path: "/store/carts/cart_01/promotions",
        intentKind: "medusa.cart.promotion.apply",
        payload: { promo_codes: ["PROMO10"] },
      }),
    );
  });

  it("returns 400 when promo_codes is missing", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/promotions",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("accepts multiple promo codes", async () => {
    mockMedusaAdjudicated.mockResolvedValue({
      cart: { id: "cart_01", discount_total: 20 },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/promotions",
      payload: { promo_codes: ["PROMO10", "VIP20"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cart.discount_total).toBe(20);
  });
});

describe("POST /api/cart/:id/payment-sessions — initialize payment (v2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("creates payment collection then initializes session (both via medusaAdjudicated)", async () => {
    // The cart GET stays on bare medusaStore (read-only, not governed).
    mockMedusaStore.mockResolvedValueOnce({ cart: { id: "cart_01", payment_collection: null } });
    // Two adjudicated mutations: collection.create + session.create.
    mockMedusaAdjudicated
      .mockResolvedValueOnce({ payment_collection: { id: "pc_01" } })
      .mockResolvedValueOnce({ payment_session: { id: "ps_01", provider_id: "pp_stripe_stripe" } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/payment-sessions",
      payload: { provider_id: "pp_stripe_stripe" },
    });

    expect(res.statusCode).toBe(200);
    // First adjudicated call: payment-collection create
    expect(mockMedusaAdjudicated).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        path: "/store/payment-collections",
        intentKind: "medusa.payment_collection.create",
      }),
    );
    // Second adjudicated call: payment-session create
    expect(mockMedusaAdjudicated).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        path: "/store/payment-collections/pc_01/payment-sessions",
        intentKind: "medusa.payment_session.create",
      }),
    );
  });

  it("reuses existing payment collection (via medusaAdjudicated)", async () => {
    // Cart already has a payment collection — only ONE adjudicated call (session.create).
    mockMedusaStore.mockResolvedValueOnce({
      cart: { id: "cart_02", payment_collection: { id: "pc_existing" } },
    });
    mockMedusaAdjudicated.mockResolvedValueOnce({ payment_session: { id: "ps_02" } });

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/cart/cart_02/payment-sessions",
      payload: { provider_id: "pp_stripe_stripe" },
    });

    // Should NOT create a new payment collection
    expect(mockMedusaAdjudicated).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "/store/payment-collections" }),
    );
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/store/payment-collections/pc_existing/payment-sessions",
        intentKind: "medusa.payment_session.create",
      }),
    );
  });
});

describe("GET /api/cart/orders/:orderId — IDOR check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 403/404 when order belongs to a different customer", async () => {
    // Medusa v2 returns prices in reais — route converts to centavos
    mockMedusaAdmin.mockResolvedValue({
      order: {
        id: "order_01",
        status: "completed",
        display_id: 42,
        total: 178,
        subtotal: 158,
        shipping_total: 20,
        customer_id: "cust_OTHER",
        items: [],
        created_at: "2026-03-18T00:00:00.000Z",
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_01",
      headers: { "x-customer-id": "cust_ME" },
    });

    // Should return 404 (masking the existence of the order)
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.message).toBe("Pedido não encontrado.");
  });

  it("returns order when customer_id matches", async () => {
    // Medusa v2 returns prices in reais — route converts to centavos
    mockMedusaAdmin.mockResolvedValue({
      order: {
        id: "order_02",
        status: "completed",
        display_id: 43,
        total: 89,
        subtotal: 89,
        shipping_total: 0,
        customer_id: "cust_ME",
        items: [{ id: "item_01", title: "Costela", quantity: 1, unit_price: 89 }],
        created_at: "2026-03-18T00:00:00.000Z",
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_02",
      headers: { "x-customer-id": "cust_ME" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.order.id).toBe("order_02");
  });

  it("returns 404 when order not found (unauthenticated)", async () => {
    // Route uses optionalAuth to support stripe-return polling for PIX orders
    mockMedusaAdmin.mockResolvedValue({ order: undefined });
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_not_found",
      // No x-customer-id header
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for an anonymous caller reading an owned order (P1-SEC-IDOR)", async () => {
    // The order exists and belongs to a customer, but the caller is anonymous
    // (no x-customer-id). Display IDs are enumerable, so a missing caller
    // identity must be treated as an ownership mismatch — not a free pass.
    mockMedusaAdmin.mockResolvedValue({
      order: {
        id: "order_03",
        status: "completed",
        display_id: 44,
        total: 178,
        subtotal: 158,
        shipping_total: 20,
        customer_id: "cust_OWNER",
        items: [],
        created_at: "2026-03-18T00:00:00.000Z",
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_03",
      // No x-customer-id header — anonymous
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.message).toBe("Pedido não encontrado.");
  });
});

// ── R0a — null-owner IDOR close + signed per-order access token ─────────────
//
// CLOSED DEFECT: the old guard `if (owner && owner !== caller) → 404`
// short-circuited to ALLOW when an order's customer_id was NULL (guest
// checkout, optionalAuth), leaking the order/status/payment to any anonymous
// IBX-<n> enumerator. SDD Invariant 2 (§J.2): a `customer_scoped` resource with
// NO owner attribution resolves REFUSED — "no owner" ≠ "any owner". The read is
// now authorized iff (authed owner-match) OR (valid signed per-order token bound
// to THIS orderId). Per PLAN decision (a): no match + no token ⇒ 404.

describe("GET /api/cart/orders/:orderId — R0a null-owner IDOR + per-order token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  function nullOwnerOrder(id: string) {
    return {
      order: {
        id,
        status: "preparing",
        display_id: 77,
        total: 178,
        subtotal: 158,
        shipping_total: 20,
        customer_id: null, // guest checkout — NO owner attribution
        items: [],
        created_at: "2026-06-25T00:00:00.000Z",
      },
    };
  }

  // (a) NON-VACUOUS: revert the deny to the lenient `owner && owner !== caller`
  // form and `customer_id: null` short-circuits to ALLOW → the route returns
  // 200 (the leak) and this 404 assertion goes RED.
  it("(a) anonymous + null-owner order + no token → 404 (was a 200 leak)", async () => {
    mockMedusaAdmin.mockResolvedValue(nullOwnerOrder("order_guest"));
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_guest",
      // no x-customer-id, no X-Order-Access-Token header
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("Pedido não encontrado.");
  });

  // (d) binding: a valid token authorizes ONLY the order it was minted for.
  it("(d) per-order token authorizes its bound order (200) but not another (404)", async () => {
    const token = createOrderAccessToken("order_guest");
    const app = await buildTestServer();

    mockMedusaAdmin.mockResolvedValue(nullOwnerOrder("order_guest"));
    const okRes = await app.inject({
      method: "GET",
      url: `/api/cart/orders/order_guest`,
      headers: { "x-order-access-token": token },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().order.id).toBe("order_guest");

    // SAME token, DIFFERENT order id → not bound → 404.
    mockMedusaAdmin.mockResolvedValue(nullOwnerOrder("order_OTHER"));
    const otherRes = await app.inject({
      method: "GET",
      url: `/api/cart/orders/order_OTHER`,
      headers: { "x-order-access-token": token },
    });
    expect(otherRes.statusCode).toBe(404);
    expect(otherRes.json().message).toBe("Pedido não encontrado.");
  });

  // (e) expired token → 404. Mint with Date.now pinned in 1970 so the bounded
  // TTL is long elapsed by real time; only Date.now is mocked (timers untouched,
  // so app.inject's promises resolve normally).
  it("(e) expired per-order token → 404", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    const expiredToken = createOrderAccessToken("order_guest");
    nowSpy.mockRestore();

    mockMedusaAdmin.mockResolvedValue(nullOwnerOrder("order_guest"));
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/cart/orders/order_guest`,
      headers: { "x-order-access-token": expiredToken },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/cart/orders/:orderId/status — R0a null-owner IDOR + per-order token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  function projection(customerId: string | null) {
    return {
      customerId,
      fulfillmentStatus: "preparing",
      updatedAt: new Date("2026-06-25T00:00:00.000Z"),
    };
  }

  // (a) NON-VACUOUS: with the lenient guard, `customerId: null` short-circuits
  // to ALLOW → the status/payment leak returns 200; this 404 assert goes RED.
  it("(a) anonymous + null-owner projection + no token → 404 (was a 200 leak)", async () => {
    mockOrderQueryGetById.mockResolvedValue(projection(null));
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_guest/status",
    });
    expect(res.statusCode).toBe(404);
    // (f) accent fix on the touched 404 copy.
    expect(res.json().error).toBe("Pedido não encontrado.");
  });

  // (b) cross-customer read (authed as B, order owned by A) → 404.
  it("(b) cross-customer read → 404", async () => {
    mockOrderQueryGetById.mockResolvedValue(projection("cus_A"));
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_A/status",
      headers: { "x-customer-id": "cus_B" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Pedido não encontrado.");
  });

  // (c) authed owner read → 200.
  it("(c) authed owner read → 200", async () => {
    mockOrderQueryGetById.mockResolvedValue(projection("cus_OWNER"));
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_OWNER/status",
      headers: { "x-customer-id": "cus_OWNER" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("preparing");
  });

  // (d) binding on the /status path.
  it("(d) per-order token authorizes its bound order (200) but not another (404)", async () => {
    mockOrderQueryGetById.mockResolvedValue(projection(null));
    const token = createOrderAccessToken("order_guest");
    const app = await buildTestServer();

    const okRes = await app.inject({
      method: "GET",
      url: `/api/cart/orders/order_guest/status`,
      headers: { "x-order-access-token": token },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().status).toBe("preparing");

    const otherRes = await app.inject({
      method: "GET",
      url: `/api/cart/orders/order_OTHER/status`,
      headers: { "x-order-access-token": token },
    });
    expect(otherRes.statusCode).toBe(404);
    expect(otherRes.json().error).toBe("Pedido não encontrado.");
  });

  // (e) expired token → 404 on /status.
  it("(e) expired per-order token → 404", async () => {
    mockOrderQueryGetById.mockResolvedValue(projection(null));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    const expiredToken = createOrderAccessToken("order_guest");
    nowSpy.mockRestore();

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/cart/orders/order_guest/status`,
      headers: { "x-order-access-token": expiredToken },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/cart/checkout — R0a mints a per-order access token (gate 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
  });

  // The checkout response carries a token the guest can use to track the order.
  // NON-VACUOUS: drop the mint in finalizeCheckout and `accessToken` is absent
  // → the `verifyOrderAccessToken(...)` assertion throws / the typeof check
  // fails (RED).
  it("checkout response carries a valid token bound to the order", async () => {
    mockGetRedisClient.mockResolvedValue(
      createMockRedis({ del: vi.fn().mockResolvedValue(1) }),
    );
    // Guest card checkout (SEC-001 permits) with a concrete orderId so
    // finalizeCheckout mints a bound token.
    vi.mocked(createCheckout).mockResolvedValueOnce({
      success: true,
      paymentMethod: "card",
      orderId: "order_MINT",
      message: "ok",
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "card" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { orderId?: string; accessToken?: string };
    expect(body.orderId).toBe("order_MINT");
    expect(typeof body.accessToken).toBe("string");
    // The minted token authorizes its own order, and ONLY its own order.
    expect(verifyOrderAccessToken(body.accessToken!, "order_MINT")).toBe(true);
    expect(verifyOrderAccessToken(body.accessToken!, "order_OTHER")).toBe(false);
  });

  // R0a regression #1 (guest CARD): a card checkout has NO orderId — the order
  // is created LATER by the Stripe webhook — but it DOES carry the Stripe
  // PaymentIntent id. The guest tracks via /pedido/<paymentIntentId>, so the
  // token must be minted bound to that `pi_…` id (not orderId, which is absent).
  //
  // NON-VACUOUS: this is exactly the cohort the R0a fix broke — without the
  // `result.paymentMethod === "card" && result.paymentIntentId` mint branch in
  // finalizeCheckout, `accessToken` is absent here (orderId is undefined), the
  // guest lands on /pedido/pi_… with no access token, and the deny-null-owner guard
  // 404s the webhook-created order. Drop that branch → accessToken is undefined
  // → the `verifyOrderAccessToken(...)` / typeof assertions go RED.
  it("guest card checkout (no orderId) mints a token bound to the paymentIntentId", async () => {
    mockGetRedisClient.mockResolvedValue(
      createMockRedis({ del: vi.fn().mockResolvedValue(1) }),
    );
    // Card branch shape: success, no orderId, a `pi_…` PaymentIntent id.
    vi.mocked(createCheckout).mockResolvedValueOnce({
      success: true,
      paymentMethod: "card",
      stripeClientSecret: "pi_REG_secret_abc",
      paymentIntentId: "pi_REG",
      message: "ok",
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "card" },
      // guest — no x-customer-id (SEC-001 permits card for guests)
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      orderId?: string;
      paymentIntentId?: string;
      accessToken?: string;
    };
    // No orderId on the card path — the webhook creates the order later.
    expect(body.orderId).toBeUndefined();
    // The pi_ id is surfaced so the client can key the token by it.
    expect(body.paymentIntentId).toBe("pi_REG");
    // The token is minted + BOUND to the pi_ id the guest will navigate to.
    expect(typeof body.accessToken).toBe("string");
    expect(verifyOrderAccessToken(body.accessToken!, "pi_REG")).toBe(true);
    // Binding: the SAME token does NOT authorize a different pi/order.
    expect(verifyOrderAccessToken(body.accessToken!, "pi_OTHER")).toBe(false);
  });
});

// ── R0a regression #1 — guest CARD tracking via the per-order token ─────────
//
// The guest pays by card, lands on /pedido/<pi_…>, and polls /orders/:id +
// /status with the `X-Order-Access-Token` header token minted at checkout. The webhook-created order
// has a NULL owner and is resolved from the RAW `pi_…` id via
// metadata[stripePaymentIntentId]; R0a captures that raw id BEFORE resolution
// and binds the token to it. This suite proves the round-trip: WITH the bound
// token → 200 (tracking restored), WITHOUT → 404 (the regression), and the
// IDOR stays closed (cross-customer + wrong-token → 404).

describe("guest card tracking — pi_ read authorized by the bound per-order token (R0a #1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  // The webhook-created order: NULL owner, resolved from the pi_ id via metadata.
  // (The resolved Medusa id differs from the pi_ id the guest holds.)
  function nullOwnerCardOrder(overrides: Record<string, unknown> = {}) {
    return {
      id: "order_from_webhook",
      status: "preparing",
      display_id: 99,
      total: 178,
      subtotal: 158,
      shipping_total: 20,
      customer_id: null, // guest checkout — NO owner attribution
      metadata: { stripePaymentIntentId: "pi_REG" },
      items: [],
      created_at: "2026-06-26T00:00:00.000Z",
      ...overrides,
    };
  }

  it("(a) GET /orders/pi_… WITHOUT token → 404 (the regression); WITH the bound token → 200", async () => {
    // pi_ path resolves the order via the metadata search (returns { orders: [...] }).
    mockMedusaAdmin.mockResolvedValue({ orders: [nullOwnerCardOrder()] });
    const app = await buildTestServer();

    // WITHOUT token — the regression cohort: null-owner webhook order 404s.
    const noTok = await app.inject({ method: "GET", url: "/api/cart/orders/pi_REG" });
    expect(noTok.statusCode).toBe(404);
    expect(noTok.json().message).toBe("Pedido não encontrado.");

    // WITH the token minted (bound to the pi_ id) at checkout → 200.
    const token = createOrderAccessToken("pi_REG");
    const withTok = await app.inject({
      method: "GET",
      url: `/api/cart/orders/pi_REG`,
      headers: { "x-order-access-token": token },
    });
    expect(withTok.statusCode).toBe(200);
    expect(withTok.json().order.id).toBe("order_from_webhook");
  });

  it("(a) GET /orders/pi_…/status WITHOUT token → 404; WITH the bound token → 200", async () => {
    // Projection is keyed by Medusa id, so a pi_ lookup misses → null → the
    // route falls to the Medusa metadata fallback (which carries customer_id).
    mockOrderQueryGetById.mockResolvedValue(null);
    mockMedusaAdmin.mockResolvedValue({
      orders: [{
        fulfillment_status: "not_fulfilled",
        customer_id: null,
        metadata: { stripePaymentIntentId: "pi_REG" },
        updated_at: "2026-06-26T00:00:00.000Z",
      }],
    });
    const app = await buildTestServer();

    const noTok = await app.inject({ method: "GET", url: "/api/cart/orders/pi_REG/status" });
    expect(noTok.statusCode).toBe(404);
    expect(noTok.json().error).toBe("Pedido não encontrado.");

    const token = createOrderAccessToken("pi_REG");
    const withTok = await app.inject({
      method: "GET",
      url: `/api/cart/orders/pi_REG/status`,
      headers: { "x-order-access-token": token },
    });
    expect(withTok.statusCode).toBe(200);
    expect(withTok.json().status).toBe("pending"); // not_fulfilled → pending
  });

  it("(c) IDOR still closed — a token minted for a DIFFERENT pi/order → 404 (binding)", async () => {
    mockMedusaAdmin.mockResolvedValue({ orders: [nullOwnerCardOrder()] });
    const app = await buildTestServer();
    const wrongToken = createOrderAccessToken("pi_DIFFERENT");
    const res = await app.inject({
      method: "GET",
      url: `/api/cart/orders/pi_REG`,
      headers: { "x-order-access-token": wrongToken },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("Pedido não encontrado.");
  });

  it("(c) IDOR still closed — cross-customer authed read of a card pi_ order → 404", async () => {
    // The order is now owned by cust_A; caller authed as cust_B, no token.
    mockMedusaAdmin.mockResolvedValue({
      orders: [nullOwnerCardOrder({ customer_id: "cust_A" })],
    });
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/pi_REG",
      headers: { "x-customer-id": "cust_B" },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── SEC-001: Cash/PIX checkout auth gate ────────────────────────────────────

describe("POST /api/cart/checkout — SEC-001 cash/PIX auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    // SEC-001 is about the route's auth gate, not the kernel's policy
    // decision. The kernel cutover (CLAUDE.md rule #9) made adjudicate()
    // always-authoritative — the legacy `IBX_KERNEL_SHADOW` env-stub no
    // longer exists. Mock the kernel to EXECUTE so each test isolates
    // the auth-gate behavior from `order.checkout.create` policy guards.
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
  });

  it("guest checkout with card → 200 OK", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "card" },
      // No x-customer-id — guest
    });

    expect(res.statusCode).toBe(200);
  });

  it("duplicate checkout (idempotency gate already held) → 409 (P0-PAY-3)", async () => {
    // SET NX returns null → a checkout for this cart is already in flight; the
    // second submit must be rejected before any payment/cart side-effect.
    mockGetRedisClient.mockResolvedValue(createMockRedis({ set: vi.fn().mockResolvedValue(null) }));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "card" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("CHECKOUT_IN_PROGRESS");
  });

  it("guest checkout with cash → 401", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash" },
      // No x-customer-id — guest
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.message).toContain("Autenticação necessária");
    expect(body.message).toContain("dinheiro/PIX");
  });

  it("guest checkout with PIX → 401", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "pix" },
      // No x-customer-id — guest
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.message).toContain("Autenticação necessária");
  });

  it("authenticated checkout with cash → 200 OK", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash" },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("authenticated checkout with PIX → 200 OK", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "pix" },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
  });

  // ── P1-DATA-CPF — checksum validation at the PIX checkout boundary ─────────
  it("PIX checkout with a valid CPF → 200 OK", async () => {
    mockGetRedisClient.mockResolvedValue(createMockRedis());

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "pix", pixCpf: "529.982.247-25" },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("PIX checkout with an invalid CPF checksum → 422 INVALID_CPF (never reaches checkout)", async () => {
    mockGetRedisClient.mockResolvedValue(createMockRedis());

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "pix", pixCpf: "123.456.789-00" },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("INVALID_CPF");
  });
});

// ── Large-ticket checkout confirmation (REQUEST_CONFIRMATION park→confirm) ──
//
// Web checkout now adjudicates against the REAL cart total, so the orders
// pack's confirmLargeTicket guard returns REQUEST_CONFIRMATION for orders
// ≥ R$1.000. The route parks the prepared checkout under a single-use
// receipt; POST /api/cart/checkout/confirm consumes it and resumes the
// EXECUTE through the kernel's confirmationReceipt seam. The hard cap
// (≥ R$10.000) still REFUSEs even with a valid receipt.

describe("POST /api/cart/checkout — large-ticket confirmation", () => {
  let redis: ReturnType<typeof createStatefulRedis>;

  const basePending = (
    overrides: Partial<PendingCheckout> = {},
  ): PendingCheckout => ({
    kind: "order.checkout.create",
    payload: { cartId: "cart_01", paymentMethod: "cash" },
    idempotencyKey: "cart_01:checkout",
    cartId: "cart_01",
    customerId: "cus_01",
    userType: "customer",
    checkoutBody: { cartId: "cart_01", paymentMethod: "cash" },
    prompt: "Confirmar pedido de R$ 1.500,00?",
    createdAt: "2026-06-08T12:00:00.000Z",
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    redis = createStatefulRedis();
    mockGetRedisClient.mockResolvedValue(redis);
    // Defaults: the pure kernel and the audited verb both auto-resolve to
    // EXECUTE; individual tests override to drive the branch under test.
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
    mockAdjudicateAndAudit.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      record: {},
      ledgerHit: null,
    });
  });

  it("≥ R$1.000 checkout → 202 with a confirmationId + prompt (parked)", async () => {
    mockAdjudicate.mockReturnValue({
      kind: "REQUEST_CONFIRMATION",
      prompt: "Confirmar pedido de R$ 1.500,00?",
      basis: [],
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash" },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.confirmationRequired).toBe(true);
    expect(body.confirmationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(body.prompt).toBe("Confirmar pedido de R$ 1.500,00?");
    expect(body.ttlSeconds).toBe(600);
  });

  it("park → confirm → EXECUTE 200 (full round-trip)", async () => {
    // 1) Park: a ≥ R$1k checkout returns a single-use receipt.
    mockAdjudicate.mockReturnValue({
      kind: "REQUEST_CONFIRMATION",
      prompt: "Confirmar?",
      basis: [],
    });
    const app = await buildTestServer();
    const parkRes = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash" },
      headers: { "x-customer-id": "cus_01" },
    });
    expect(parkRes.statusCode).toBe(202);
    const confirmationId = parkRes.json().confirmationId as string;

    // 2) Confirm: the audited verb resolves the receipt to EXECUTE → 200.
    const confirmRes = await app.inject({
      method: "POST",
      url: "/api/cart/checkout/confirm",
      payload: { confirmationId },
      headers: { "x-customer-id": "cus_01" },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().success).toBe(true);
    expect(mockAdjudicateAndAudit).toHaveBeenCalledTimes(1);
  });

  it("confirm when the cart now ≥ R$10.000 → 403 (override does NOT rescue REFUSE)", async () => {
    const store = createCheckoutConfirmationStore();
    const { confirmationId } = await store.create(basePending());
    // The kernel re-adjudicates against the grown cart and REFUSEs — the
    // receipt only satisfies the "ask first" threshold, never the hard cap.
    mockAdjudicateAndAudit.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          kind: "BUSINESS",
          code: "amount_above_cap",
          userFacing:
            "Valor acima do limite permitido para checkout automático.",
          detail: "cart total ≥ R$10.000",
        },
        basis: [],
      },
      record: {},
      ledgerHit: null,
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout/confirm",
      payload: { confirmationId },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(403);
    expect(typeof res.json().error).toBe("string");
    expect(mockAdjudicateAndAudit).toHaveBeenCalledTimes(1);
  });

  it("confirm by a different customer → 403 (ownership), never adjudicates", async () => {
    const store = createCheckoutConfirmationStore();
    const { confirmationId } = await store.create(
      basePending({ customerId: "cus_OTHER" }),
    );

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout/confirm",
      payload: { confirmationId },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(403);
    expect(mockAdjudicateAndAudit).not.toHaveBeenCalled();
  });

  it("confirm with an expired / already-used receipt → 410", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout/confirm",
      payload: { confirmationId: "11111111-2222-3333-4444-555555555555" },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe("CONFIRMATION_EXPIRED");
  });
});

// ── P0-X9 — medusaAdjudicated error mapping ────────────────────────────────
//
// Anti-theater: tests that the typed errors from the wrapper map to the
// expected pt-BR HTTP responses. If a future refactor accidentally swallows
// REFUSE / DEFER / NEEDS_REVIEW, these assertions break.

describe("Cart routes — medusaAdjudicated error mapping (P0-X9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("POST /api/cart → 403 with pt-BR copy on REFUSE", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockRejectedValue(
      new MockRefusedError({
        code: "cart.create.blocked",
        userFacing: "Criação de carrinho bloqueada.",
      }),
    );

    const app = await buildTestServer();
    const res = await app.inject({ method: "POST", url: "/api/cart" });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("Criação de carrinho bloqueada.");
    expect(body.code).toBe("cart.create.blocked");
  });

  it("POST /api/cart/:id/line-items → 202 on DEFER", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockRejectedValue(
      new MockDeferredError({ signal: "inventory.replenish" }),
    );

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { variant_id: "var_01", quantity: 1 },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("deferred");
    expect(body.signal).toBe("inventory.replenish");
  });

  it("POST /api/cart/:id/promotions → 503 on NEEDS_REVIEW", async () => {
    mockMedusaAdjudicated.mockRejectedValue(new MockNeedsReviewError());

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/promotions",
      payload: { promo_codes: ["VIP"] },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toContain("atendimento humano");
  });
});
