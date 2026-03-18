// Unit tests for cart intelligence subscriber
// Handlers: cart.abandoned, order.placed, product.viewed

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const MOCK_PROFILE_TTL_SECONDS = vi.hoisted(() => 604800); // 7 days
const mockRecordOrderItems = vi.hoisted(() => vi.fn());
const mockGetWhatsAppSender = vi.hoisted(() => vi.fn());

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
    lPush: vi.fn().mockReturnThis(),
    lTrim: vi.fn().mockReturnThis(),
    hSet: vi.fn().mockReturnThis(),
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
      lPush: vi.fn().mockReturnThis(),
      lTrim: vi.fn().mockReturnThis(),
      hSet: vi.fn().mockReturnThis(),
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
      lPush: vi.fn().mockReturnThis(),
      lTrim: vi.fn().mockReturnThis(),
      hSet: vi.fn().mockReturnThis(),
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
      lPush: vi.fn().mockReturnThis(),
      lTrim: vi.fn().mockReturnThis(),
      hSet: vi.fn().mockReturnThis(),
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
    expect(mockSubscribeNatsEvent).toHaveBeenCalledTimes(11);
  });
});
