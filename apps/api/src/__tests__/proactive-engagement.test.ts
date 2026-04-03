// Tests for proactive-engagement job.
// Mocks all external dependencies: Redis, NATS, domain, WhatsApp client, Medusa.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkDormantCustomers,
  startProactiveEngagement,
  stopProactiveEngagement,
} from "../jobs/proactive-engagement.js";

// ── Hoisted mock functions ──────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((k: string) => `test:${k}`));
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockFindDormantCustomers = vi.hoisted(() => vi.fn());
const mockSendText = vi.hoisted(() => vi.fn());
const mockSentryCapture = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockFetchWeatherCondition = vi.hoisted(() => vi.fn());

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  medusaAdmin: mockMedusaAdmin,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: vi.fn(() => ({
    findDormantCustomers: mockFindDormantCustomers,
  })),
}));

vi.mock("../whatsapp/client.js", () => ({
  sendText: mockSendText,
}));

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (scope: unknown) => void) => {
    cb({ setTag: vi.fn(), setContext: vi.fn() });
  }),
  captureException: mockSentryCapture,
}));

vi.mock("../jobs/queue.js", () => ({
  createQueue: vi.fn(() => ({
    upsertJobScheduler: vi.fn(),
    close: vi.fn(),
  })),
  createWorker: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("../jobs/weather-helper.js", () => ({
  fetchWeatherCondition: mockFetchWeatherCondition,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    exists: vi.fn().mockResolvedValue(0),
    hGetAll: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue("OK"),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    hSet: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

const CUSTOMER_A = { id: "cust_a", phone: "+5511999990001", name: "Ana" };
const CUSTOMER_B = { id: "cust_b", phone: "+5511999990002", name: "Bruno" };

describe("proactive-engagement", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Default to lunch window (11:00 Sao Paulo = 14:00 UTC, UTC-3)
    vi.setSystemTime(new Date("2024-01-15T14:00:00Z"));

    mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockSendText.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);
    mockMedusaAdmin.mockResolvedValue({ product: { title: "Costela Defumada" } });
    // Default to normal weather so existing tests pass
    mockFetchWeatherCondition.mockResolvedValue("normal");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await stopProactiveEngagement();
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it("starts and stops without errors", async () => {
    expect(() => startProactiveEngagement()).not.toThrow();
    await expect(stopProactiveEngagement()).resolves.toBeUndefined();
  });

  it("does not start a second worker if already running", () => {
    startProactiveEngagement();
    expect(() => startProactiveEngagement()).not.toThrow();
  });

  it("stopProactiveEngagement is safe to call when not started", async () => {
    await expect(stopProactiveEngagement()).resolves.toBeUndefined();
  });

  // ── No dormant customers ─────────────────────────────────────────────────

  it("does nothing when there are no dormant customers", async () => {
    mockFindDormantCustomers.mockResolvedValue([]);

    await checkDormantCustomers();

    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Cooldown skip logic ──────────────────────────────────────────────────

  it("skips customer when cooldown key exists in Redis", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(1); // cooldown active

    await checkDormantCustomers();

    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── No-show / dispute skip logic ─────────────────────────────────────────

  it("skips customer with noShowCount > 2", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({ noShowCount: "3", disputeCount: "0" });

    await checkDormantCustomers();

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("skips customer with disputeCount > 0", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({ noShowCount: "0", disputeCount: "1" });

    await checkDormantCustomers();

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("allows customer with noShowCount <= 2 and disputeCount === 0", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({ noShowCount: "2", disputeCount: "0" });

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${CUSTOMER_A.phone}`,
      expect.any(String),
    );
  });

  // ── Successful outreach ──────────────────────────────────────────────────

  it("sends message and sets cooldown key on success", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${CUSTOMER_A.phone}`,
      expect.any(String),
    );
    expect(mockRedis.set).toHaveBeenCalledWith(
      `test:outreach:last:${CUSTOMER_A.id}`,
      "1",
      expect.objectContaining({ EX: expect.any(Number) }),
    );
  });

  it("increments weekly counter on each send", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});

    await checkDormantCustomers();

    expect(mockRedis.incr).toHaveBeenCalledWith("test:outreach:weekly:count");
  });

  it("sets 7-day TTL on weekly counter when it is newly created (incr returns 1)", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});
    mockRedis.incr.mockResolvedValue(1); // first increment

    await checkDormantCustomers();

    expect(mockRedis.expire).toHaveBeenCalledWith(
      "test:outreach:weekly:count",
      7 * 86400,
    );
  });

  it("does NOT set TTL on weekly counter when counter already exists (incr > 1)", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});
    mockRedis.incr.mockResolvedValue(5); // already has entries

    await checkDormantCustomers();

    // expire should not have been called for weekly counter
    const expireCalls = mockRedis.expire.mock.calls as [string, number][];
    const weeklyExpireCall = expireCalls.find(([key]) => key === "test:outreach:weekly:count");
    expect(weeklyExpireCall).toBeUndefined();
  });

  // ── NATS event ───────────────────────────────────────────────────────────

  it("publishes outreach.sent NATS event with correct payload", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});

    await checkDormantCustomers();

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "outreach.sent",
      expect.objectContaining({
        customerId: CUSTOMER_A.id,
        messageType: expect.any(String),
        sentAt: expect.any(String),
      }),
    );
  });

  // ── MAX_MESSAGES_PER_RUN cap ─────────────────────────────────────────────

  it("stops after MAX_MESSAGES_PER_RUN (50) messages", async () => {
    // Generate 60 customers
    const manyCustomers = Array.from({ length: 60 }, (_, i) => ({
      id: `cust_${i}`,
      phone: `+551199999${String(i).padStart(4, "0")}`,
      name: `Customer ${i}`,
    }));
    mockFindDormantCustomers.mockResolvedValue(manyCustomers);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalledTimes(50);
  });

  // ── Error handling ───────────────────────────────────────────────────────

  it("continues with next customer when one throws", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A, CUSTOMER_B]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});

    // First sendText throws, second succeeds
    mockSendText
      .mockRejectedValueOnce(new Error("Twilio timeout"))
      .mockResolvedValueOnce(undefined);

    await checkDormantCustomers();

    // Second customer still sent
    expect(mockSendText).toHaveBeenCalledTimes(2);
  });

  it("reports error to Sentry when sendText throws", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});
    mockSendText.mockRejectedValueOnce(new Error("Twilio error"));

    await checkDormantCustomers();

    expect(mockSentryCapture).toHaveBeenCalled();
  });

  // ── Top product from score:* fields ──────────────────────────────────────

  it("picks the product with the highest score value", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({
      "score:prod_low": "1.5",
      "score:prod_high": "9.8",
      "score:prod_mid": "4.2",
    });
    mockMedusaAdmin.mockResolvedValue({ product: { title: "Costela Alta" } });

    await checkDormantCustomers();

    // medusaAdmin should be called with the highest-score product
    expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/products/prod_high");
  });

  // ── Time-of-day guard ─────────────────────────────────────────────────────

  it("skips outreach outside meal windows (2:00 Sao Paulo)", async () => {
    // 05:00 UTC = 02:00 America/Sao_Paulo (UTC-3)
    vi.setSystemTime(new Date("2024-01-15T05:00:00Z"));
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);

    await checkDormantCustomers();

    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockFindDormantCustomers).not.toHaveBeenCalled();
  });

  it("skips outreach outside meal windows (15:00 Sao Paulo — between windows)", async () => {
    // 18:00 UTC = 15:00 America/Sao_Paulo
    vi.setSystemTime(new Date("2024-01-15T18:00:00Z"));
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);

    await checkDormantCustomers();

    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockFindDormantCustomers).not.toHaveBeenCalled();
  });

  it("allows outreach during lunch window (11:00 Sao Paulo)", async () => {
    // 14:00 UTC = 11:00 America/Sao_Paulo
    vi.setSystemTime(new Date("2024-01-15T14:00:00Z"));
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalled();
  });

  it("allows outreach during lunch window (10:00 Sao Paulo — boundary)", async () => {
    // 13:00 UTC = 10:00 America/Sao_Paulo
    vi.setSystemTime(new Date("2024-01-15T13:00:00Z"));
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalled();
  });

  it("allows outreach during dinner window (18:00 Sao Paulo)", async () => {
    // 21:00 UTC = 18:00 America/Sao_Paulo
    vi.setSystemTime(new Date("2024-01-15T21:00:00Z"));
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalled();
  });

  it("allows outreach during dinner window (17:00 Sao Paulo — boundary)", async () => {
    // 20:00 UTC = 17:00 America/Sao_Paulo
    vi.setSystemTime(new Date("2024-01-15T20:00:00Z"));
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    mockRedis.exists.mockResolvedValue(0);
    mockRedis.hGetAll.mockResolvedValue({});

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalled();
  });
});
