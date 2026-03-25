// Unit tests for cart intelligence subscriber
// Handlers: cart.abandoned, order.placed, order.refunded, order.disputed, order.canceled,
//           product.viewed, review.submitted, cart.item_added

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const MOCK_PROFILE_TTL_SECONDS = vi.hoisted(() => 604800); // 7 days
const mockRecordOrderItems = vi.hoisted(() => vi.fn());
const mockGetWhatsAppSender = vi.hoisted(() => vi.fn());
const mockMedusaAdminFetch = vi.hoisted(() => vi.fn());

// Store registered handlers so we can invoke them in tests
const natsHandlers: Record<string, (payload: unknown) => Promise<void>> = {};

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent.mockImplementation(
    async (event: string, handler: (payload: unknown) => Promise<void>) => {
      natsHandlers[event] = handler;
    },
  ),
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  PROFILE_TTL_SECONDS: MOCK_PROFILE_TTL_SECONDS,
  getWhatsAppSender: mockGetWhatsAppSender,
  medusaAdmin: mockMedusaAdminFetch,
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    recordOrderItems: mockRecordOrderItems,
    getById: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock("../jobs/review-prompt.js", () => ({
  scheduleReviewPrompt: vi.fn().mockResolvedValue(undefined),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { startCartIntelligenceSubscribers } from "../subscribers/cart-intelligence.js";

// ── Mock Redis client ─────────────────────────────────────────────────────────

function createMockRedis(overrides: Record<string, unknown> = {}) {
  const pipeline = {
    zIncrBy: vi.fn().mockReturnThis(),
    zRemRangeByRank: vi.fn().mockReturnThis(),
    lPush: vi.fn().mockReturnThis(),
    lTrim: vi.fn().mockReturnThis(),
    hSet: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };

  return {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(true),
    del: vi.fn().mockResolvedValue(1),
    hIncrBy: vi.fn().mockResolvedValue(1),
    hSet: vi.fn().mockResolvedValue(true),
    hDel: vi.fn().mockResolvedValue(1),
    hKeys: vi.fn().mockResolvedValue([]),
    multi: vi.fn().mockReturnValue(pipeline),
    _pipeline: pipeline,
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function registerSubscribers() {
  // Clear previously registered handlers
  for (const key of Object.keys(natsHandlers)) {
    delete natsHandlers[key];
  }
  await startCartIntelligenceSubscribers();
}

// ── Tests: isNewEvent ─────────────────────────────────────────────────────────

describe("isNewEvent (tested via order.placed handler)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    await registerSubscribers();
  });

  it("processes new event when SET NX returns OK", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRecordOrderItems.mockResolvedValue({ count: 1 });

    await natsHandlers["order.placed"]({
      customerId: "cus_01",
      orderId: "order_new",
      items: [{ productId: "prod_01", variantId: "var_01", quantity: 1, priceInCentavos: 5000 }],
    });

    // recordOrderItems should be called for a new event
    expect(mockRecordOrderItems).toHaveBeenCalled();
  });

  it("skips duplicate event when SET NX returns null", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["order.placed"]({
      customerId: "cus_01",
      orderId: "order_dup",
      items: [{ productId: "prod_01", variantId: "var_01", quantity: 1 }],
    });

    // recordOrderItems should NOT be called for a duplicate
    expect(mockRecordOrderItems).not.toHaveBeenCalled();
  });
});

// ── Tests: updateCopurchaseScores ────────────────────────────────────────────

describe("updateCopurchaseScores (tested via order.placed handler)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    await registerSubscribers();
  });

  it("skips copurchase update for single-product orders", async () => {
    const pipeline = {
      zIncrBy: vi.fn().mockReturnThis(),
      zRemRangeByRank: vi.fn().mockReturnThis(),
      lPush: vi.fn().mockReturnThis(),
      lTrim: vi.fn().mockReturnThis(),
      hSet: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      set: vi.fn().mockResolvedValue("OK"),
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRecordOrderItems.mockResolvedValue({ count: 1 });

    await natsHandlers["order.placed"]({
      customerId: "cus_01",
      orderId: "order_single",
      items: [{ productId: "prod_01", variantId: "var_01", quantity: 1, priceInCentavos: 5000 }],
    });

    // For single product, zIncrBy on copurchase should not be called
    // The pipeline.exec is called once for global scores only
    // copurchase pipeline should not have zIncrBy calls for copurchase keys
    const copurchaseCalls = pipeline.zIncrBy.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("copurchase"),
    );
    expect(copurchaseCalls).toHaveLength(0);
  });

  it("updates copurchase pairs for multi-product orders", async () => {
    const pipeline = {
      zIncrBy: vi.fn().mockReturnThis(),
      zRemRangeByRank: vi.fn().mockReturnThis(),
      lPush: vi.fn().mockReturnThis(),
      lTrim: vi.fn().mockReturnThis(),
      hSet: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      set: vi.fn().mockResolvedValue("OK"),
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRecordOrderItems.mockResolvedValue({ count: 2 });

    await natsHandlers["order.placed"]({
      customerId: "cus_01",
      orderId: "order_multi",
      items: [
        { productId: "prod_01", variantId: "var_01", quantity: 1, priceInCentavos: 5000 },
        { productId: "prod_02", variantId: "var_02", quantity: 2, priceInCentavos: 7500 },
      ],
    });

    // For 2 products, there should be copurchase pairs: prod_01->prod_02 and prod_02->prod_01
    const copurchaseCalls = pipeline.zIncrBy.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("copurchase"),
    );
    expect(copurchaseCalls).toHaveLength(2);
  });

  it("prunes copurchase sorted sets to top COPURCHASE_MAX_ENTRIES after update", async () => {
    const pipeline = {
      zIncrBy: vi.fn().mockReturnThis(),
      zRemRangeByRank: vi.fn().mockReturnThis(),
      lPush: vi.fn().mockReturnThis(),
      lTrim: vi.fn().mockReturnThis(),
      hSet: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      set: vi.fn().mockResolvedValue("OK"),
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRecordOrderItems.mockResolvedValue({ count: 2 });

    await natsHandlers["order.placed"]({
      customerId: "cus_01",
      orderId: "order_prune",
      items: [
        { productId: "prod_01", variantId: "var_01", quantity: 1, priceInCentavos: 5000 },
        { productId: "prod_02", variantId: "var_02", quantity: 2, priceInCentavos: 7500 },
      ],
    });

    // zRemRangeByRank should be called once per product for copurchase pruning
    const copurchasePrunes = pipeline.zRemRangeByRank.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("copurchase"),
    );
    expect(copurchasePrunes).toHaveLength(2);
    // Each call removes ranks 0 to -(51) = keeps top 50
    expect(copurchasePrunes[0][1]).toBe(0);
    expect(copurchasePrunes[0][2]).toBe(-51);
  });
});

// ── Tests: updateGlobalScores ───────────────────────────────────────────────

describe("updateGlobalScores (tested via order.placed handler)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    await registerSubscribers();
  });

  it("increments global score per product by quantity", async () => {
    const pipeline = {
      zIncrBy: vi.fn().mockReturnThis(),
      zRemRangeByRank: vi.fn().mockReturnThis(),
      lPush: vi.fn().mockReturnThis(),
      lTrim: vi.fn().mockReturnThis(),
      hSet: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      set: vi.fn().mockResolvedValue("OK"),
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRecordOrderItems.mockResolvedValue({ count: 1 });

    await natsHandlers["order.placed"]({
      customerId: "cus_01",
      orderId: "order_global",
      items: [
        { productId: "prod_01", variantId: "var_01", quantity: 3, priceInCentavos: 5000 },
      ],
    });

    // Global score pipeline should increment by quantity
    const globalCalls = pipeline.zIncrBy.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("global:score"),
    );
    expect(globalCalls).toHaveLength(1);
    expect(globalCalls[0][1]).toBe(3); // quantity
    expect(globalCalls[0][2]).toBe("prod_01"); // productId
  });

  it("prunes global score sorted set to top GLOBAL_SCORE_MAX_ENTRIES after update", async () => {
    const pipeline = {
      zIncrBy: vi.fn().mockReturnThis(),
      zRemRangeByRank: vi.fn().mockReturnThis(),
      lPush: vi.fn().mockReturnThis(),
      lTrim: vi.fn().mockReturnThis(),
      hSet: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      set: vi.fn().mockResolvedValue("OK"),
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRecordOrderItems.mockResolvedValue({ count: 1 });

    await natsHandlers["order.placed"]({
      customerId: "cus_01",
      orderId: "order_global_prune",
      items: [
        { productId: "prod_01", variantId: "var_01", quantity: 1, priceInCentavos: 5000 },
      ],
    });

    // zRemRangeByRank should be called for global score pruning
    const globalPrunes = pipeline.zRemRangeByRank.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("global:score"),
    );
    expect(globalPrunes).toHaveLength(1);
    // Keeps top 200: removes ranks 0 to -(201)
    expect(globalPrunes[0][1]).toBe(0);
    expect(globalPrunes[0][2]).toBe(-201);
  });
});

// ── Tests: resetProfileTtl ──────────────────────────────────────────────────

describe("resetProfileTtl (tested via order.placed handler)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    await registerSubscribers();
  });

  it("calls expire with PROFILE_TTL_SECONDS", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRecordOrderItems.mockResolvedValue({ count: 1 });

    await natsHandlers["order.placed"]({
      customerId: "cus_01",
      orderId: "order_ttl",
      items: [{ productId: "prod_01", variantId: "var_01", quantity: 1, priceInCentavos: 5000 }],
    });

    // expire should be called with the profile key and TTL
    expect(mockRedis.expire).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_01"),
      MOCK_PROFILE_TTL_SECONDS,
    );
  });
});

// ── Tests: cart.abandoned handler ───────────────────────────────────────────

describe("cart.abandoned handler", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockPublishNatsEvent.mockResolvedValue(undefined);
    await registerSubscribers();
  });

  it("publishes notification.send event for abandoned cart", async () => {
    await natsHandlers["cart.abandoned"]({
      cartId: "cart_abandoned_01",
      sessionId: "sess_01",
    });

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "notification.send",
      expect.objectContaining({
        type: "cart_abandoned",
        sessionId: "sess_01",
        cartId: "cart_abandoned_01",
        channel: "whatsapp",
      }),
    );
  });
});

// ── Tests: order.placed handler ─────────────────────────────────────────────

describe("order.placed handler", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    await registerSubscribers();
  });

  it("returns early when customerId is missing", async () => {
    await natsHandlers["order.placed"]({
      orderId: "order_no_customer",
      items: [{ productId: "prod_01", variantId: "var_01", quantity: 1 }],
    });

    expect(mockGetRedisClient).not.toHaveBeenCalled();
    expect(mockRecordOrderItems).not.toHaveBeenCalled();
  });

  it("creates CustomerOrderItem rows via createMany", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRecordOrderItems.mockResolvedValue({ count: 2 });

    await natsHandlers["order.placed"]({
      customerId: "cus_01",
      orderId: "order_items",
      items: [
        { productId: "prod_01", variantId: "var_01", quantity: 1, priceInCentavos: 5000 },
        { productId: "prod_02", variantId: "var_02", quantity: 2, priceInCentavos: 8900 },
      ],
    });

    expect(mockRecordOrderItems).toHaveBeenCalledWith(
      "cus_01",
      "order_items",
      expect.arrayContaining([
        expect.objectContaining({
          productId: "prod_01",
          variantId: "var_01",
          quantity: 1,
          priceInCentavos: 5000,
        }),
        expect.objectContaining({
          productId: "prod_02",
          variantId: "var_02",
          quantity: 2,
          priceInCentavos: 8900,
        }),
      ]),
    );
  });

  it("updates Redis profile counters on order placed", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRecordOrderItems.mockResolvedValue({ count: 1 });

    await natsHandlers["order.placed"]({
      customerId: "cus_profile",
      orderId: "order_profile",
      items: [{ productId: "prod_01", variantId: "var_01", quantity: 1, priceInCentavos: 5000 }],
    });

    // hIncrBy orderCount
    expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_profile"),
      "orderCount",
      1,
    );

    // hSet lastOrderAt
    expect(mockRedis.hSet).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_profile"),
      "lastOrderAt",
      expect.any(String),
    );

    // hDel cartItems
    expect(mockRedis.hDel).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_profile"),
      "cartItems",
    );
  });

  it("skips duplicate order events (idempotency)", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["order.placed"]({
      customerId: "cus_01",
      orderId: "order_dup",
      items: [{ productId: "prod_01", variantId: "var_01", quantity: 1 }],
    });

    expect(mockRecordOrderItems).not.toHaveBeenCalled();
  });

  it("defaults priceInCentavos to 0 when not provided", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRecordOrderItems.mockResolvedValue({ count: 1 });

    await natsHandlers["order.placed"]({
      customerId: "cus_01",
      orderId: "order_no_price",
      items: [{ productId: "prod_01", variantId: "var_01", quantity: 1 }],
    });

    expect(mockRecordOrderItems).toHaveBeenCalledWith(
      "cus_01",
      "order_no_price",
      expect.arrayContaining([
        expect.objectContaining({ priceInCentavos: 0 }),
      ]),
    );
  });
});

// ── Tests: product.viewed handler ───────────────────────────────────────────

describe("product.viewed handler", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    await registerSubscribers();
  });

  it("skips when customerId is missing", async () => {
    await natsHandlers["product.viewed"]({
      productId: "prod_01",
    });

    expect(mockGetRedisClient).not.toHaveBeenCalled();
  });

  it("debounces duplicate views within 60s", async () => {
    // SET NX returns null → duplicate view
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["product.viewed"]({
      productId: "prod_01",
      customerId: "cus_01",
    });

    // After debounce returns false, no further Redis calls for LPUSH
    const pipeline = mockRedis.multi();
    expect(pipeline.lPush).not.toHaveBeenCalled();
  });

  it("pushes to recentlyViewed and trims list for new views", async () => {
    const pipeline = {
      lPush: vi.fn().mockReturnThis(),
      lTrim: vi.fn().mockReturnThis(),
      hSet: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      set: vi.fn().mockResolvedValue("OK"),
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["product.viewed"]({
      productId: "prod_viewed",
      customerId: "cus_viewer",
    });

    // LPUSH with productId
    expect(pipeline.lPush).toHaveBeenCalledWith(
      expect.stringContaining("customer:recentlyViewed:cus_viewer"),
      "prod_viewed",
    );

    // LTRIM to keep last 20
    expect(pipeline.lTrim).toHaveBeenCalledWith(
      expect.stringContaining("customer:recentlyViewed:cus_viewer"),
      0,
      19, // RECENTLY_VIEWED_MAX - 1
    );

    // hSet lastSeenAt
    expect(pipeline.hSet).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_viewer"),
      "lastSeenAt",
      expect.any(String),
    );
  });

  it("resets profile TTL after recording view", async () => {
    const pipeline = {
      lPush: vi.fn().mockReturnThis(),
      lTrim: vi.fn().mockReturnThis(),
      hSet: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      set: vi.fn().mockResolvedValue("OK"),
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["product.viewed"]({
      productId: "prod_ttl",
      customerId: "cus_ttl",
    });

    expect(mockRedis.expire).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_ttl"),
      MOCK_PROFILE_TTL_SECONDS,
    );
  });
});

// ── Tests: subscriber registration ──────────────────────────────────────────

describe("startCartIntelligenceSubscribers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("subscribes to all intelligence event handlers", async () => {
    await registerSubscribers();

    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("cart.abandoned", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("order.placed", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("product.viewed", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("order.payment_failed", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("review.prompt.schedule", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("notification.send", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("reservation.created", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("reservation.modified", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("reservation.cancelled", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("reservation.no_show", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("review.prompt", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("search.results_viewed", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("order.refunded", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("order.disputed", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("order.canceled", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("review.submitted", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith("cart.item_added", expect.any(Function));
    expect(mockSubscribeNatsEvent).toHaveBeenCalledTimes(20);
  });
});

// ── Tests: order.refunded handler (EVT-002) ─────────────────────────────────

describe("order.refunded handler (EVT-002)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    await registerSubscribers();
  });

  it("updates refundCount and totalRefundAmount in customer profile", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdminFetch.mockResolvedValue({
      order: { customer_id: "cus_refund" },
    });

    await natsHandlers["order.refunded"]({
      orderId: "order_r01",
      chargeId: "ch_r01",
      amountRefunded: 5000,
    });

    expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_refund"),
      "refundCount",
      1,
    );
    expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_refund"),
      "totalRefundAmount",
      5000,
    );
  });

  it("skips profile update when order has no customerId", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdminFetch.mockResolvedValue({
      order: { customer_id: null },
    });

    await natsHandlers["order.refunded"]({
      orderId: "order_guest",
      chargeId: "ch_g01",
      amountRefunded: 3000,
    });

    expect(mockRedis.hIncrBy).not.toHaveBeenCalled();
  });

  it("skips duplicate refund events (idempotency)", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["order.refunded"]({
      orderId: "order_r01",
      chargeId: "ch_r01",
      amountRefunded: 5000,
    });

    expect(mockMedusaAdminFetch).not.toHaveBeenCalled();
  });

  it("reads customerId from metadata fallback", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdminFetch.mockResolvedValue({
      order: { metadata: { customerId: "cus_meta" } },
    });

    await natsHandlers["order.refunded"]({
      orderId: "order_meta",
      chargeId: "ch_meta",
      amountRefunded: 2000,
    });

    expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_meta"),
      "refundCount",
      1,
    );
  });
});

// ── Tests: order.disputed handler (EVT-003) ─────────────────────────────────

describe("order.disputed handler (EVT-003)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockPublishNatsEvent.mockResolvedValue(undefined);
    await registerSubscribers();
  });

  it("publishes notification.send alert for staff", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdminFetch.mockResolvedValue({
      order: { customer_id: "cus_disp" },
    });

    await natsHandlers["order.disputed"]({
      orderId: "order_d01",
      disputeId: "dp_001",
      amount: 10000,
      reason: "fraudulent",
    });

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "notification.send",
      expect.objectContaining({
        type: "order_disputed",
        channel: "whatsapp",
      }),
    );
  });

  it("increments disputeCount in customer profile", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdminFetch.mockResolvedValue({
      order: { customer_id: "cus_disp" },
    });

    await natsHandlers["order.disputed"]({
      orderId: "order_d01",
      disputeId: "dp_002",
      amount: 5000,
      reason: "product_not_received",
    });

    expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_disp"),
      "disputeCount",
      1,
    );
  });

  it("handles dispute without orderId (no profile update)", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["order.disputed"]({
      orderId: null,
      disputeId: "dp_003",
      amount: 2000,
      reason: "duplicate",
    });

    // Should still send notification
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "notification.send",
      expect.objectContaining({ type: "order_disputed" }),
    );
    // But no Medusa fetch or profile update
    expect(mockMedusaAdminFetch).not.toHaveBeenCalled();
    expect(mockRedis.hIncrBy).not.toHaveBeenCalled();
  });

  it("skips duplicate dispute events (idempotency)", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["order.disputed"]({
      orderId: "order_d01",
      disputeId: "dp_dup",
      amount: 5000,
      reason: "fraudulent",
    });

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});

// ── Tests: order.canceled handler (EVT-004) ─────────────────────────────────

describe("order.canceled handler (EVT-004)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    await registerSubscribers();
  });

  it("increments orderCancellationCount in customer profile", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdminFetch.mockResolvedValue({
      order: { customer_id: "cus_cancel" },
    });

    await natsHandlers["order.canceled"]({
      orderId: "order_c01",
      stripePaymentIntentId: "pi_c01",
      cancellationReason: "requested_by_customer",
    });

    expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_cancel"),
      "orderCancellationCount",
      1,
    );
  });

  it("skips profile update when order has no customerId", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdminFetch.mockResolvedValue({
      order: {},
    });

    await natsHandlers["order.canceled"]({
      orderId: "order_guest_c",
      stripePaymentIntentId: "pi_c02",
    });

    expect(mockRedis.hIncrBy).not.toHaveBeenCalled();
  });

  it("skips duplicate canceled events (idempotency)", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["order.canceled"]({
      orderId: "order_c_dup",
      stripePaymentIntentId: "pi_dup",
    });

    expect(mockMedusaAdminFetch).not.toHaveBeenCalled();
  });
});

// ── Tests: review.submitted handler (EVT-005) ──────────────────────────────

describe("review.submitted handler (EVT-005)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    await registerSubscribers();
  });

  it("updates product review analytics in Redis", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["review.submitted"]({
      productId: "prod_rev",
      customerId: "cus_rev",
      rating: 5,
      reviewCount: 10,
      newAvgRating: 4.5,
      orderId: "order_rev",
    });

    expect(mockRedis.hSet).toHaveBeenCalledWith(
      expect.stringContaining("product:reviews:prod_rev"),
      expect.objectContaining({
        avgRating: "4.5",
        reviewCount: "10",
        lastReviewAt: expect.any(String),
      }),
    );
    expect(mockRedis.expire).toHaveBeenCalledWith(
      expect.stringContaining("product:reviews:prod_rev"),
      30 * 86400,
    );
  });

  it("increments reviewCount in customer profile", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["review.submitted"]({
      productId: "prod_rev2",
      customerId: "cus_rev2",
      rating: 4,
      reviewCount: 5,
      newAvgRating: 3.8,
    });

    expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_rev2"),
      "reviewCount",
      1,
    );
  });

  it("resets profile TTL after recording review", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["review.submitted"]({
      productId: "prod_ttl",
      customerId: "cus_ttl_rev",
      rating: 3,
      reviewCount: 1,
      newAvgRating: 3.0,
    });

    expect(mockRedis.expire).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_ttl_rev"),
      MOCK_PROFILE_TTL_SECONDS,
    );
  });
});

// ── Tests: cart.item_added handler (EVT-006) ────────────────────────────────

describe("cart.item_added handler (EVT-006)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    await registerSubscribers();
  });

  it("increments product cart popularity sorted set", async () => {
    const pipeline = {
      zIncrBy: vi.fn().mockReturnThis(),
      zRemRangeByRank: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["cart.item_added"]({
      cartId: "cart_01",
      customerId: "cus_cart",
      productId: "prod_pop",
      variantId: "var_pop",
      quantity: 3,
      sessionId: "sess_01",
    });

    expect(pipeline.zIncrBy).toHaveBeenCalledWith(
      expect.stringContaining("product:cart:popularity"),
      3,
      "prod_pop",
    );
  });

  it("updates customer profile cartAddCount for authenticated users", async () => {
    const pipeline = {
      zIncrBy: vi.fn().mockReturnThis(),
      zRemRangeByRank: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["cart.item_added"]({
      cartId: "cart_02",
      customerId: "cus_cart2",
      productId: "prod_p2",
      variantId: "var_p2",
      quantity: 1,
    });

    expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_cart2"),
      "cartAddCount",
      1,
    );
    expect(mockRedis.hSet).toHaveBeenCalledWith(
      expect.stringContaining("customer:profile:cus_cart2"),
      "lastCartActivityAt",
      expect.any(String),
    );
  });

  it("skips profile update for anonymous cart additions", async () => {
    const pipeline = {
      zIncrBy: vi.fn().mockReturnThis(),
      zRemRangeByRank: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["cart.item_added"]({
      cartId: "cart_anon",
      variantId: "var_anon",
      productId: "prod_anon",
    });

    // Popularity should still be tracked
    expect(pipeline.zIncrBy).toHaveBeenCalled();
    // But no profile update
    expect(mockRedis.hIncrBy).not.toHaveBeenCalled();
  });

  it("defaults quantity to 1 when not provided", async () => {
    const pipeline = {
      zIncrBy: vi.fn().mockReturnThis(),
      zRemRangeByRank: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["cart.item_added"]({
      cartId: "cart_noqty",
      productId: "prod_noqty",
      variantId: "var_noqty",
    });

    expect(pipeline.zIncrBy).toHaveBeenCalledWith(
      expect.stringContaining("product:cart:popularity"),
      1, // default
      "prod_noqty",
    );
  });

  it("prunes cart popularity sorted set to top CART_POPULARITY_MAX_ENTRIES after update", async () => {
    const pipeline = {
      zIncrBy: vi.fn().mockReturnThis(),
      zRemRangeByRank: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const mockRedis = createMockRedis({
      multi: vi.fn().mockReturnValue(pipeline),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["cart.item_added"]({
      cartId: "cart_prune",
      productId: "prod_prune",
      variantId: "var_prune",
      quantity: 1,
    });

    // zRemRangeByRank should be called for cart popularity pruning
    const popularityPrunes = pipeline.zRemRangeByRank.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("cart:popularity"),
    );
    expect(popularityPrunes).toHaveLength(1);
    // Keeps top 200: removes ranks 0 to -(201)
    expect(popularityPrunes[0][1]).toBe(0);
    expect(popularityPrunes[0][2]).toBe(-201);
  });
});
