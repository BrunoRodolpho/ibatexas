// Regression tests for the DLQ cap (P2-SCALE-DLQCAP).
//
// Verifies:
//   • pushToDlq lPushes the entry and sets the 7-day TTL.
//   • When the list grows past MAX_DLQ, it lTrims to (0, MAX_DLQ-1) keeping the
//     newest entries, and logs the number of dropped (oldest) entries.
//   • When the list is at/under the cap, it does NOT lTrim.
//   • Redis keys are built via rk() (Hard Rule).
//
// Pure unit test — Redis and Sentry are mocked, no network.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((k: string) => `test:${k}`));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (scope: unknown) => void) =>
    cb({ setTag: vi.fn(), setLevel: vi.fn() }),
  ),
  captureMessage: vi.fn(),
}));

import { pushToDlq } from "../../subscribers/dlq.js";

function createMockRedis(lPushLen: number) {
  return {
    lPush: vi.fn().mockResolvedValue(lPushLen),
    lTrim: vi.fn().mockResolvedValue("OK"),
    expire: vi.fn().mockResolvedValue(1),
  };
}

describe("pushToDlq — DLQ cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MAX_DLQ;
  });

  it("pushes the entry under the namespaced key and sets the 7-day TTL", async () => {
    const redis = createMockRedis(1);
    mockGetRedisClient.mockResolvedValue(redis);

    await pushToDlq("order.placed", { id: "ord_1" }, new Error("boom"));

    expect(mockRk).toHaveBeenCalledWith("dlq:order.placed");
    expect(redis.lPush).toHaveBeenCalledOnce();
    expect(redis.lPush.mock.calls[0][0]).toBe("test:dlq:order.placed");
    expect(redis.expire).toHaveBeenCalledWith("test:dlq:order.placed", 604_800);
  });

  it("does NOT lTrim when the list is at/under the default cap (1000)", async () => {
    const redis = createMockRedis(1000); // exactly at cap
    mockGetRedisClient.mockResolvedValue(redis);

    await pushToDlq("order.placed", {}, "err");

    expect(redis.lTrim).not.toHaveBeenCalled();
  });

  it("lTrims to (0, defaultCap-1) and logs dropped count when over the default cap", async () => {
    const redis = createMockRedis(1003); // 3 over default cap of 1000
    mockGetRedisClient.mockResolvedValue(redis);
    const log = { error: vi.fn() };

    await pushToDlq("order.placed", {}, "err", log);

    expect(redis.lTrim).toHaveBeenCalledWith("test:dlq:order.placed", 0, 999);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ dropped: 3, cap: 1000 }),
      expect.stringContaining("dropped oldest"),
    );
  });

  it("honors the MAX_DLQ env override (read at module load)", async () => {
    // MAX_DLQ is captured at import time, so reset modules and re-import with the
    // env set to prove the override is actually wired (not just the default).
    vi.resetModules();
    process.env.MAX_DLQ = "5";
    const fresh = await import("../../subscribers/dlq.js");

    const redis = createMockRedis(6); // 1 over the custom cap of 5
    mockGetRedisClient.mockResolvedValue(redis);

    await fresh.pushToDlq("order.placed", {}, "err");

    expect(redis.lTrim).toHaveBeenCalledWith("test:dlq:order.placed", 0, 4);
  });

  it("swallows Redis errors so the producer is not broken", async () => {
    mockGetRedisClient.mockRejectedValue(new Error("redis down"));
    const log = { error: vi.fn() };

    await expect(
      pushToDlq("order.placed", {}, "err", log),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "order.placed" }),
      expect.stringContaining("Failed to push to DLQ"),
    );
  });
});
