// Unit tests for WhatsApp LGPD opt-in — hasOptedIn / markOptedIn

import { describe, it, expect, vi, beforeEach } from "vitest";
import { hasOptedIn, markOptedIn } from "../whatsapp/session.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockRedis = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => mockRedis),
  rk: vi.fn((key: string) => `ibatexas:${key}`),
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({}),
}));

vi.mock("@ibatexas/types", () => ({
  Channel: { Web: "web", WhatsApp: "whatsapp" },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ── hasOptedIn ───────────────────────────────────────────────────────────────

describe("hasOptedIn", () => {
  it("returns false for new phone hash", async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await hasOptedIn("test-hash");

    expect(result).toBe(false);
    expect(mockRedis.get).toHaveBeenCalledWith("ibatexas:wa:optin:test-hash");
  });
});

// ── markOptedIn ──────────────────────────────────────────────────────────────

describe("markOptedIn", () => {
  it("sets Redis key, hasOptedIn returns true after", async () => {
    mockRedis.set.mockResolvedValue("OK");

    await markOptedIn("test-hash");

    expect(mockRedis.set).toHaveBeenCalledWith(
      "ibatexas:wa:optin:test-hash",
      "1",
    );

    // After marking, hasOptedIn should return true
    mockRedis.get.mockResolvedValue("1");

    const result = await hasOptedIn("test-hash");
    expect(result).toBe(true);
  });
});
