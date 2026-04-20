// Unit tests for welcome credit helpers in whatsapp/session.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { setWelcomeCredit, getAndConsumeWelcomeCredit } from "../../whatsapp/session.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockRedis = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  getDel: vi.fn(),
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => mockRedis),
  rk: vi.fn((key: string) => `test:${key}`),
  atomicIncr: vi.fn().mockResolvedValue(1),
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    upsertFromWhatsApp: vi.fn(),
  }),
}));

vi.mock("@ibatexas/types", () => ({
  Channel: { Web: "web", WhatsApp: "whatsapp" },
}));

vi.mock("uuid", () => ({ v4: vi.fn().mockReturnValue("test-uuid") }));

beforeEach(() => {
  vi.clearAllMocks();
});

// ── setWelcomeCredit ──────────────────────────────────────────────────────────

describe("setWelcomeCredit", () => {
  it("stores BEMVINDO15 coupon with 30-day TTL", async () => {
    mockRedis.set.mockResolvedValue("OK");

    await setWelcomeCredit("cust-123");

    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("welcome:credit:cust-123"),
      "BEMVINDO15",
      { EX: 30 * 86400 },
    );
  });
});

// ── getAndConsumeWelcomeCredit ────────────────────────────────────────────────

describe("getAndConsumeWelcomeCredit", () => {
  it("returns coupon code and deletes key on first call", async () => {
    mockRedis.getDel.mockResolvedValue("BEMVINDO15");

    const code = await getAndConsumeWelcomeCredit("cust-123");

    expect(code).toBe("BEMVINDO15");
    expect(mockRedis.getDel).toHaveBeenCalledWith(
      expect.stringContaining("welcome:credit:cust-123"),
    );
  });

  it("returns null when no credit exists", async () => {
    mockRedis.getDel.mockResolvedValue(null);

    const code = await getAndConsumeWelcomeCredit("cust-123");

    expect(code).toBeNull();
  });

  it("is consumed — second call returns null", async () => {
    // First call: getDel atomically returns and deletes
    mockRedis.getDel.mockResolvedValueOnce("BEMVINDO15");

    const first = await getAndConsumeWelcomeCredit("cust-456");
    expect(first).toBe("BEMVINDO15");

    // Second call: key already deleted, getDel returns null
    mockRedis.getDel.mockResolvedValueOnce(null);

    const second = await getAndConsumeWelcomeCredit("cust-456");
    expect(second).toBeNull();
  });
});
