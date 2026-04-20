// Unit tests for product.intelligence.purge NATS subscriber
// Verifies Redis cleanup logic when a product is deleted

import { describe, it, expect, vi, beforeEach } from "vitest";
import { startCartIntelligenceSubscribers } from "../../subscribers/cart-intelligence.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((key: string) => `ibatexas:${key}`));
const MOCK_PROFILE_TTL_SECONDS = vi.hoisted(() => 604800);
const mockGetWhatsAppSender = vi.hoisted(() => vi.fn());
const mockMedusaAdminFetch = vi.hoisted(() => vi.fn());
const mockRecordOrderItems = vi.hoisted(() => vi.fn());
const mockSentryCaptureException = vi.hoisted(() => vi.fn());

const natsHandlers: Record<string, (payload: unknown) => Promise<void>> = {};

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent.mockImplementation(
    async (event: string, handler: (payload: unknown) => Promise<void>) => {
      natsHandlers[event] = handler;
    },
  ),
  publishNatsEvent: vi.fn(),
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
  createOrderEventLogService: () => ({
    append: vi.fn(),
  }),
  createOrderCommandService: () => ({
    create: vi.fn(),
    reconcileStatus: vi.fn().mockResolvedValue({ success: true }),
  }),
  createPaymentCommandService: () => ({
    create: vi.fn(),
  }),
  createLoyaltyService: () => ({
    addStamp: vi.fn().mockResolvedValue({ stamps: 1, rewarded: false }),
  }),
  ConcurrencyError: class ConcurrencyError extends Error {},
}));

vi.mock("@sentry/node", () => ({
  captureException: mockSentryCaptureException,
}));

vi.mock("../../jobs/review-prompt.js", () => ({
  scheduleReviewPrompt: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockPipeline() {
  const pipeline = {
    zIncrBy: vi.fn().mockReturnThis(),
    zRemRangeByRank: vi.fn().mockReturnThis(),
    zRem: vi.fn().mockReturnThis(),
    lPush: vi.fn().mockReturnThis(),
    lTrim: vi.fn().mockReturnThis(),
    hSet: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  return pipeline;
}

/**
 * Build a mock Redis client that simulates 5 copurchase sets:
 * - ibatexas:copurchase:prod_deleted  (the deleted product's own set)
 * - ibatexas:copurchase:prod_A through prod_D  (other products referencing the deleted one)
 *
 * SCAN returns all 5 keys in a single page (cursor 0 → 0).
 */
function createMockRedisWithCopurchaseSets(deletedProductId: string) {
  const copurchaseKeys = [
    `ibatexas:copurchase:${deletedProductId}`,
    "ibatexas:copurchase:prod_A",
    "ibatexas:copurchase:prod_B",
    "ibatexas:copurchase:prod_C",
    "ibatexas:copurchase:prod_D",
  ];

  const pipeline = createMockPipeline();

  return {
    del: vi.fn().mockResolvedValue(1),
    scan: vi.fn().mockResolvedValue({ cursor: 0, keys: copurchaseKeys }),
    zRem: vi.fn().mockResolvedValue(1),
    multi: vi.fn().mockReturnValue(pipeline),
    set: vi.fn().mockResolvedValue("OK"),
    expire: vi.fn().mockResolvedValue(true),
    hIncrBy: vi.fn().mockResolvedValue(1),
    hSet: vi.fn().mockResolvedValue(true),
    hDel: vi.fn().mockResolvedValue(1),
    hKeys: vi.fn().mockResolvedValue([]),
    _pipeline: pipeline,
  };
}

async function registerSubscribers() {
  for (const key of Object.keys(natsHandlers)) {
    delete natsHandlers[key];
  }
  await startCartIntelligenceSubscribers();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("product.intelligence.purge subscriber", () => {
  const DELETED_PRODUCT_ID = "prod_deleted";

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    await registerSubscribers();
  });

  it("DEL the deleted product's own copurchase set", async () => {
    const mockRedis = createMockRedisWithCopurchaseSets(DELETED_PRODUCT_ID);
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["product.intelligence.purge"]({ productId: DELETED_PRODUCT_ID });

    expect(mockRedis.del).toHaveBeenCalledWith(`ibatexas:copurchase:${DELETED_PRODUCT_ID}`);
  });

  it("uses SCAN (not KEYS) to find other copurchase sets", async () => {
    const mockRedis = createMockRedisWithCopurchaseSets(DELETED_PRODUCT_ID);
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["product.intelligence.purge"]({ productId: DELETED_PRODUCT_ID });

    expect(mockRedis.scan).toHaveBeenCalled();
    // Verify SCAN is called with cursor and MATCH pattern — never KEYS
    const scanCall = mockRedis.scan.mock.calls[0];
    expect(scanCall[1]).toMatchObject({ MATCH: "ibatexas:copurchase:*" });
  });

  it("ZREMs deleted productId from all other copurchase sets via pipeline", async () => {
    const mockRedis = createMockRedisWithCopurchaseSets(DELETED_PRODUCT_ID);
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["product.intelligence.purge"]({ productId: DELETED_PRODUCT_ID });

    const pipeline = mockRedis._pipeline;
    expect(pipeline.zRem).toHaveBeenCalledTimes(5);
    // Each of the 5 copurchase keys should have the deleted productId removed
    for (const key of [
      `ibatexas:copurchase:${DELETED_PRODUCT_ID}`,
      "ibatexas:copurchase:prod_A",
      "ibatexas:copurchase:prod_B",
      "ibatexas:copurchase:prod_C",
      "ibatexas:copurchase:prod_D",
    ]) {
      expect(pipeline.zRem).toHaveBeenCalledWith(key, DELETED_PRODUCT_ID);
    }
    expect(pipeline.exec).toHaveBeenCalled();
  });

  it("ZREMs deleted productId from product:global:score", async () => {
    const mockRedis = createMockRedisWithCopurchaseSets(DELETED_PRODUCT_ID);
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["product.intelligence.purge"]({ productId: DELETED_PRODUCT_ID });

    expect(mockRedis.zRem).toHaveBeenCalledWith("ibatexas:product:global:score", DELETED_PRODUCT_ID);
  });

  it("ZREMs deleted productId from product:cart:popularity", async () => {
    const mockRedis = createMockRedisWithCopurchaseSets(DELETED_PRODUCT_ID);
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["product.intelligence.purge"]({ productId: DELETED_PRODUCT_ID });

    expect(mockRedis.zRem).toHaveBeenCalledWith("ibatexas:product:cart:popularity", DELETED_PRODUCT_ID);
  });

  it("is idempotent — running purge twice for the same product is safe", async () => {
    const mockRedis = createMockRedisWithCopurchaseSets(DELETED_PRODUCT_ID);
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["product.intelligence.purge"]({ productId: DELETED_PRODUCT_ID });
    await natsHandlers["product.intelligence.purge"]({ productId: DELETED_PRODUCT_ID });

    // del is idempotent — no errors expected on second call
    expect(mockRedis.del).toHaveBeenCalledTimes(2);
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
  });

  it("reports errors to Sentry and does not throw", async () => {
    const mockRedis = createMockRedisWithCopurchaseSets(DELETED_PRODUCT_ID);
    mockRedis.del = vi.fn().mockRejectedValue(new Error("Redis connection lost"));
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await expect(
      natsHandlers["product.intelligence.purge"]({ productId: DELETED_PRODUCT_ID }),
    ).resolves.toBeUndefined();

    expect(mockSentryCaptureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it("handles empty SCAN result (no other copurchase sets) without error", async () => {
    const pipeline = createMockPipeline();
    const mockRedis = {
      del: vi.fn().mockResolvedValue(1),
      scan: vi.fn().mockResolvedValue({ cursor: 0, keys: [] }),
      zRem: vi.fn().mockResolvedValue(0),
      multi: vi.fn().mockReturnValue(pipeline),
      set: vi.fn().mockResolvedValue("OK"),
      expire: vi.fn().mockResolvedValue(true),
      hIncrBy: vi.fn().mockResolvedValue(1),
      hSet: vi.fn().mockResolvedValue(true),
      hDel: vi.fn().mockResolvedValue(1),
      hKeys: vi.fn().mockResolvedValue([]),
      _pipeline: pipeline,
    };
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await expect(
      natsHandlers["product.intelligence.purge"]({ productId: DELETED_PRODUCT_ID }),
    ).resolves.toBeUndefined();

    expect(mockRedis.del).toHaveBeenCalledWith(`ibatexas:copurchase:${DELETED_PRODUCT_ID}`);
    expect(pipeline.exec).not.toHaveBeenCalled();
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
  });

  it("iterates multiple SCAN pages until cursor returns 0", async () => {
    const pipeline = createMockPipeline();
    const mockRedis = {
      del: vi.fn().mockResolvedValue(1),
      // First call returns cursor=42 (more pages), second returns cursor=0 (done)
      scan: vi.fn()
        .mockResolvedValueOnce({ cursor: 42, keys: ["ibatexas:copurchase:prod_A", "ibatexas:copurchase:prod_B"] })
        .mockResolvedValueOnce({ cursor: 0, keys: ["ibatexas:copurchase:prod_C"] }),
      zRem: vi.fn().mockResolvedValue(1),
      multi: vi.fn().mockReturnValue(pipeline),
      set: vi.fn().mockResolvedValue("OK"),
      expire: vi.fn().mockResolvedValue(true),
      hIncrBy: vi.fn().mockResolvedValue(1),
      hSet: vi.fn().mockResolvedValue(true),
      hDel: vi.fn().mockResolvedValue(1),
      hKeys: vi.fn().mockResolvedValue([]),
      _pipeline: pipeline,
    };
    mockGetRedisClient.mockResolvedValue(mockRedis);

    await natsHandlers["product.intelligence.purge"]({ productId: DELETED_PRODUCT_ID });

    expect(mockRedis.scan).toHaveBeenCalledTimes(2);
    // pipeline.exec should be called once per page with keys
    expect(pipeline.exec).toHaveBeenCalledTimes(2);
  });
});
