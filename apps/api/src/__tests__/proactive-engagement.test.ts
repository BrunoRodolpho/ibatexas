// Tests for proactive-engagement job.
// Mocks all external dependencies: Redis, NATS, domain, WhatsApp client, Medusa.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";
import { rk } from "@ibatexas/tools";
import {
  checkDormantCustomers,
  startProactiveEngagement,
  stopProactiveEngagement,
} from "../jobs/proactive-engagement.js";

// ── Hoisted mock functions ──────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockFindDormantCustomers = vi.hoisted(() => vi.fn());
const mockSendText = vi.hoisted(() => vi.fn());
const mockSentryCapture = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockFetchWeatherCondition = vi.hoisted(() => vi.fn());

// ── Mocks ────────────────────────────────────────────────────────────────────

// R5-S6 — only the CLIENT is substituted. `rk()` is the real one (it is pure),
// so every key below is the key production writes.
vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return {
    ...actual,
    getRedisClient: mockGetRedisClient,
    medusaAdmin: mockMedusaAdmin,
  };
});

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
//
// R5-S6 — this suite used to hand-roll a `createMockRedis()` of six `vi.fn()`s
// that each answered a CONSTANT. The two guarantees the job exists to provide
// are stateful, and a constant cannot express either: the per-customer COOLDOWN
// (the key the job WRITES is the key it later READS — the stub never connected
// them, so "we do not message the same customer twice" was never tested) and
// the WEEKLY CAP (an INCR counter, stubbed to return whatever a case wanted, so
// the cap could not be exercised at all). Both now run against the canonical
// in-memory keyspace from `@ibatexas/tools/testing`, with real TTLs.

/** Keys the job reads and writes, through the REAL rk(). */
const cooldownKey = (customerId: string): string => rk(`outreach:last:${customerId}`);
const profileKey = (customerId: string): string => rk(`customer:profile:${customerId}`);
const WEEKLY_KEY = (): string => rk("outreach:weekly:count");

const CUSTOMER_A = { id: "cust_a", phone: "+5511999990001", name: "Ana" };
const CUSTOMER_B = { id: "cust_b", phone: "+5511999990002", name: "Bruno" };

describe("proactive-engagement", () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Default to lunch window (11:00 Sao Paulo = 14:00 UTC, UTC-3)
    vi.setSystemTime(new Date("2024-01-15T14:00:00Z"));

    // The adapter reads the FAKE clock, so a TTL written under fake timers
    // expires when the test advances time — not on wall-clock.
    redis = createInMemoryRedis({ now: () => Date.now() });
    mockGetRedisClient.mockResolvedValue(redis.client);
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
    // The REAL cooldown key, seeded exactly as a previous run would have left it.
    await redis.client.set(cooldownKey(CUSTOMER_A.id), "1", { EX: 3 * 86400 });

    await checkDormantCustomers();

    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── No-show / dispute skip logic ─────────────────────────────────────────

  it("skips customer with noShowCount > 2", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    await redis.client.hSet(profileKey(CUSTOMER_A.id), { noShowCount: "3", disputeCount: "0" });

    await checkDormantCustomers();

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("skips customer with disputeCount > 0", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    await redis.client.hSet(profileKey(CUSTOMER_A.id), { noShowCount: "0", disputeCount: "1" });

    await checkDormantCustomers();

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("allows customer with noShowCount <= 2 and disputeCount === 0", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    await redis.client.hSet(profileKey(CUSTOMER_A.id), { noShowCount: "2", disputeCount: "0" });

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${CUSTOMER_A.phone}`,
      expect.objectContaining({ text: expect.any(String) }),
    );
  });

  // ── Successful outreach ──────────────────────────────────────────────────

  it("sends message and sets cooldown key on success", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${CUSTOMER_A.phone}`,
      expect.objectContaining({ text: expect.any(String) }),
    );
    // The cooldown key really exists now, with a real TTL.
    expect(redis.peek(cooldownKey(CUSTOMER_A.id))).toBe("1");
    expect(redis.ttlMs(cooldownKey(CUSTOMER_A.id))).toBeGreaterThan(0);
  });

  it("does not message the same customer twice inside the cooldown window", async () => {
    // The guarantee the hand-rolled stub could not express: the key the job
    // WRITES on run 1 is the key it READS on run 2. With six constant-returning
    // `vi.fn()`s those were two unrelated facts, so this suite shipped without
    // ever testing the anti-spam property the job exists to provide.
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);

    await checkDormantCustomers();
    expect(mockSendText).toHaveBeenCalledTimes(1);

    await checkDormantCustomers();
    expect(mockSendText).toHaveBeenCalledTimes(1);
    // The weekly counter did not move either — the second run sent nothing.
    expect(redis.peek(WEEKLY_KEY())).toBe("1");
  });

  it("messages again once the cooldown has EXPIRED", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);

    await checkDormantCustomers();
    expect(mockSendText).toHaveBeenCalledTimes(1);

    // Past the cooldown TTL: the key is gone and outreach resumes. A stubbed
    // `exists` could never model this, because it had no notion of time.
    vi.setSystemTime(new Date("2024-02-15T14:00:00Z"));
    expect(redis.peek(cooldownKey(CUSTOMER_A.id))).toBeUndefined();

    await checkDormantCustomers();
    expect(mockSendText).toHaveBeenCalledTimes(2);
    // A month on, the weekly counter's own 7-day TTL has lapsed too, so the
    // window rolled over and the count restarts at 1 rather than accumulating
    // forever. Both TTLs are real here; neither is asserted from a stub.
    expect(redis.peek(WEEKLY_KEY())).toBe("1");
  });

  it("increments weekly counter on each send", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);

    await checkDormantCustomers();

    expect(redis.peek(WEEKLY_KEY())).toBe("1");
  });

  it("sets 7-day TTL on weekly counter when it is newly created (incr returns 1)", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    // The counter does not exist, so the REAL INCR returns 1 and the job stamps
    // the TTL. Nothing about the return value is stubbed.
    await checkDormantCustomers();

    expect(redis.peek(WEEKLY_KEY())).toBe("1");
    expect(redis.ttlMs(WEEKLY_KEY())).toBe(7 * 86400 * 1000);
  });

  it("does NOT set TTL on weekly counter when counter already exists (incr > 1)", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    // A counter mid-week: no TTL of its own (the stamp happened on the first
    // INCR of the window, which this seed stands in for).
    await redis.client.set(WEEKLY_KEY(), "4");
    expect(redis.ttlMs(WEEKLY_KEY())).toBeNull();

    await checkDormantCustomers();

    expect(redis.peek(WEEKLY_KEY())).toBe("5");
    // Still no TTL — the job must not re-stamp and slide the window forward.
    expect(redis.ttlMs(WEEKLY_KEY())).toBeNull();
  });

  // ── NATS event ───────────────────────────────────────────────────────────

  it("publishes outreach.sent NATS event with correct payload", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);

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

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalledTimes(50);
  });

  // ── Error handling ───────────────────────────────────────────────────────

  it("continues with next customer when one throws", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A, CUSTOMER_B]);

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
    mockSendText.mockRejectedValueOnce(new Error("Twilio error"));

    await checkDormantCustomers();

    expect(mockSentryCapture).toHaveBeenCalled();
  });

  // ── Top product from score:* fields ──────────────────────────────────────

  it("picks the product with the highest score value", async () => {
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);
    await redis.client.hSet(profileKey(CUSTOMER_A.id), {
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

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalled();
  });

  it("allows outreach during lunch window (10:00 Sao Paulo — boundary)", async () => {
    // 13:00 UTC = 10:00 America/Sao_Paulo
    vi.setSystemTime(new Date("2024-01-15T13:00:00Z"));
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalled();
  });

  it("allows outreach during dinner window (18:00 Sao Paulo)", async () => {
    // 21:00 UTC = 18:00 America/Sao_Paulo
    vi.setSystemTime(new Date("2024-01-15T21:00:00Z"));
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalled();
  });

  it("allows outreach during dinner window (17:00 Sao Paulo — boundary)", async () => {
    // 20:00 UTC = 17:00 America/Sao_Paulo
    vi.setSystemTime(new Date("2024-01-15T20:00:00Z"));
    mockFindDormantCustomers.mockResolvedValue([CUSTOMER_A]);

    await checkDormantCustomers();

    expect(mockSendText).toHaveBeenCalled();
  });
});
