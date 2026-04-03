// Tests for cart recovery tier logic in cart.abandoned subscriber and abandoned-cart-checker.
// Verifies tier progression, cooldown enforcement, and active:carts retention.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startCartIntelligenceSubscribers } from "../../subscribers/cart-intelligence.js";
import { checkAbandonedCarts, stopAbandonedCartChecker } from "../../jobs/abandoned-cart-checker.js";

// ── Hoisted mock functions ──────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockLoadSession = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockGetWhatsAppSender = vi.hoisted(() => vi.fn());
const MOCK_PROFILE_TTL_SECONDS = vi.hoisted(() => 604800);

// Capture registered NATS handlers
const natsHandlers: Record<string, (payload: unknown) => Promise<void>> = {};

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  PROFILE_TTL_SECONDS: MOCK_PROFILE_TTL_SECONDS,
  getWhatsAppSender: mockGetWhatsAppSender,
}));

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent.mockImplementation(
    async (event: string, handler: (payload: unknown) => Promise<void>) => {
      natsHandlers[event] = handler;
    },
  ),
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("../../session/store.js", () => ({
  loadSession: mockLoadSession,
}));

vi.mock("../../jobs/review-prompt.js", () => ({
  scheduleReviewPrompt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    recordOrderItems: vi.fn(),
    getById: vi.fn().mockResolvedValue({ phone: "+5511999999999" }),
  }),
}));

vi.mock("../../jobs/queue.js", () => ({
  createQueue: vi.fn(() => ({
    upsertJobScheduler: vi.fn(),
    close: vi.fn(),
  })),
  createWorker: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const TIER_1_TO_2_MS = 4 * 60 * 60 * 1000;
const TIER_2_TO_3_MS = 18 * 60 * 60 * 1000;
const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

function cartEntry(cartId: string, idleMs: number): string {
  return JSON.stringify({ cartId, sessionType: "guest", lastActivity: Date.now() - idleMs });
}

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    hScan: vi.fn(),
    hDel: vi.fn().mockResolvedValue(1),
    hSet: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    expire: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(0),
    hGet: vi.fn().mockResolvedValue(null),
    hIncrBy: vi.fn().mockResolvedValue(1),
    hKeys: vi.fn().mockResolvedValue([]),
    lRange: vi.fn().mockResolvedValue([]),
    multi: vi.fn().mockReturnValue({
      zIncrBy: vi.fn().mockReturnThis(),
      zRemRangeByRank: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
    ...overrides,
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe("cart recovery tier logic — cart.abandoned subscriber", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `test:${key}`);
    mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockLoadSession.mockResolvedValue([]);
    mockPublishNatsEvent.mockResolvedValue(undefined);
    mockGetWhatsAppSender.mockReturnValue(null);

    // Register subscribers (idempotent in tests — cleared each run)
    await startCartIntelligenceSubscribers();
  });

  it("no nudge key → sends tier 1 and saves nudge state", async () => {
    mockRedis.get.mockResolvedValue(null); // no nudge key

    await natsHandlers["cart.abandoned"]({
      cartId: "cart_01",
      sessionId: "cart_01",
      customerId: "cust_01",
    });

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "notification.send",
      expect.objectContaining({ type: "cart_abandoned" }),
    );

    // Should save tier 1 nudge state
    expect(mockRedis.set).toHaveBeenCalledWith(
      "test:cart:nudge:cart_01",
      expect.stringContaining('"tier":1'),
      expect.objectContaining({ EX: expect.any(Number) }),
    );
  });

  it("tier 1 + 4h elapsed → escalates to tier 2", async () => {
    const sentAt = Date.now() - TIER_1_TO_2_MS - 1000; // just past the cooldown
    mockRedis.get.mockResolvedValue(JSON.stringify({ tier: 1, sentAt }));

    await natsHandlers["cart.abandoned"]({
      cartId: "cart_02",
      sessionId: "cart_02",
      customerId: "cust_02",
    });

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "notification.send",
      expect.objectContaining({ type: "cart_abandoned" }),
    );
    expect(mockRedis.set).toHaveBeenCalledWith(
      "test:cart:nudge:cart_02",
      expect.stringContaining('"tier":2'),
      expect.anything(),
    );
  });

  it("tier 2 + 18h elapsed → escalates to tier 3", async () => {
    const sentAt = Date.now() - TIER_2_TO_3_MS - 1000;
    mockRedis.get.mockResolvedValue(JSON.stringify({ tier: 2, sentAt }));

    await natsHandlers["cart.abandoned"]({
      cartId: "cart_03",
      sessionId: "cart_03",
      customerId: "cust_03",
    });

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "notification.send",
      expect.objectContaining({ type: "cart_abandoned" }),
    );
    expect(mockRedis.set).toHaveBeenCalledWith(
      "test:cart:nudge:cart_03",
      expect.stringContaining('"tier":3'),
      expect.anything(),
    );
  });

  it("tier 1 cooldown not elapsed (2h after tier 1) → skips", async () => {
    const sentAt = Date.now() - 2 * 60 * 60 * 1000; // only 2h — need 4h
    mockRedis.get.mockResolvedValue(JSON.stringify({ tier: 1, sentAt }));

    await natsHandlers["cart.abandoned"]({
      cartId: "cart_04",
      sessionId: "cart_04",
      customerId: "cust_04",
    });

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("tier 2 cooldown not elapsed → skips", async () => {
    const sentAt = Date.now() - 10 * 60 * 60 * 1000; // only 10h — need 18h
    mockRedis.get.mockResolvedValue(JSON.stringify({ tier: 2, sentAt }));

    await natsHandlers["cart.abandoned"]({
      cartId: "cart_05",
      sessionId: "cart_05",
      customerId: "cust_05",
    });

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("tier 3 already sent → skips (final nudge done)", async () => {
    const sentAt = Date.now() - 30 * 60 * 60 * 1000;
    mockRedis.get.mockResolvedValue(JSON.stringify({ tier: 3, sentAt }));

    await natsHandlers["cart.abandoned"]({
      cartId: "cart_06",
      sessionId: "cart_06",
      customerId: "cust_06",
    });

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("tier 1 message is personalized with item name and customer name", async () => {
    mockRedis.get.mockResolvedValue(null);

    await natsHandlers["cart.abandoned"]({
      cartId: "cart_07",
      sessionId: "cart_07",
      customerId: "cust_07",
      itemNames: ["Picanha"],
      customerName: "Ana",
    });

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "notification.send",
      expect.objectContaining({
        body: expect.stringContaining("Picanha"),
      }),
    );
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "notification.send",
      expect.objectContaining({
        body: expect.stringContaining("Ana"),
      }),
    );
  });
});

// ── Tier tracking in abandoned-cart-checker ───────────────────────────────

describe("cart recovery tier logic — abandoned-cart-checker", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `test:${key}`);
    mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockLoadSession.mockResolvedValue([{ role: "user", content: "Quero costela" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await stopAbandonedCartChecker();
  });

  it("tier 1 — cart NOT removed from active:carts, lastActivity updated", async () => {
    const idleMs = IDLE_THRESHOLD_MS + 1000;
    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [{ field: "cart_t1", value: cartEntry("cart_t1", idleMs) }],
    });
    // No nudge key yet
    mockRedis.get.mockResolvedValue(null);

    await checkAbandonedCarts();

    expect(mockPublishNatsEvent).toHaveBeenCalledWith("cart.abandoned", expect.objectContaining({ cartId: "cart_t1" }));
    // Should update lastActivity (hSet), NOT delete (hDel should not be called for active:carts)
    expect(mockRedis.hSet).toHaveBeenCalledWith(
      "test:active:carts",
      "cart_t1",
      expect.any(String),
    );
    expect(mockRedis.hDel).not.toHaveBeenCalledWith("test:active:carts", "cart_t1");
  });

  it("tier 2 — cart NOT removed from active:carts", async () => {
    const idleMs = IDLE_THRESHOLD_MS + 1000;
    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [{ field: "cart_t2", value: cartEntry("cart_t2", idleMs) }],
    });
    // Tier 1 nudge was already sent (cooldown elapsed)
    const sentAt = Date.now() - TIER_1_TO_2_MS - 1000;
    mockRedis.get.mockImplementation((key: string) => {
      if (key === "test:cart:nudge:cart_t2") return Promise.resolve(JSON.stringify({ tier: 1, sentAt }));
      return Promise.resolve(null);
    });

    await checkAbandonedCarts();

    expect(mockPublishNatsEvent).toHaveBeenCalledWith("cart.abandoned", expect.objectContaining({ cartId: "cart_t2" }));
    expect(mockRedis.hSet).toHaveBeenCalledWith("test:active:carts", "cart_t2", expect.any(String));
    expect(mockRedis.hDel).not.toHaveBeenCalledWith("test:active:carts", "cart_t2");
  });

  it("tier 3 — cart IS removed from active:carts", async () => {
    const idleMs = IDLE_THRESHOLD_MS + 1000;
    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [{ field: "cart_t3", value: cartEntry("cart_t3", idleMs) }],
    });
    // Tier 3 nudge was already sent
    const sentAt = Date.now() - 30 * 60 * 60 * 1000;
    mockRedis.get.mockImplementation((key: string) => {
      if (key === "test:cart:nudge:cart_t3") return Promise.resolve(JSON.stringify({ tier: 3, sentAt }));
      return Promise.resolve(null);
    });

    await checkAbandonedCarts();

    expect(mockPublishNatsEvent).toHaveBeenCalledWith("cart.abandoned", expect.objectContaining({ cartId: "cart_t3" }));
    expect(mockRedis.hDel).toHaveBeenCalledWith("test:active:carts", "cart_t3");
    expect(mockRedis.hSet).not.toHaveBeenCalledWith("test:active:carts", "cart_t3", expect.any(String));
  });
});
