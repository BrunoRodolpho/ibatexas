// Unit tests for the PIX expiry monitor's payment-confirmation check.
//
// PIXPAIDFLAG: isPixPaid() must not rely solely on the best-effort Redis flag
// (`pix:paid:<orderId>`, set AFTER the DB write and catch-and-ignored on failure,
// 2h TTL). When the flag is absent it falls back to the Payment projection — the
// billing source of truth — so a customer who already paid never receives a
// spurious "your PIX expired" reminder. Pure added read; no money movement.
//
// Mocks: @ibatexas/tools (getRedisClient, rk, medusaAdmin),
//        @ibatexas/domain (createPaymentQueryService),
//        ../../whatsapp/client.js (sendText), ../../lib/logger.js,
//        ../queue.js (BullMQ factories), @sentry/node.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymentStatus } from "@ibatexas/types";

const mockRedisGet = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());
const mockSendText = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: (key: string) => `ibatexas:${key}`,
  medusaAdmin: vi.fn(),
}));

vi.mock("@ibatexas/domain", () => ({
  createPaymentQueryService: vi.fn(() => ({
    getActiveByOrderId: mockGetActiveByOrderId,
  })),
}));

vi.mock("../../whatsapp/client.js", () => ({
  sendText: mockSendText,
}));

vi.mock("../../lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../queue.js", () => ({
  createQueue: vi.fn(() => ({ add: vi.fn(), close: vi.fn() })),
  createWorker: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
}));

vi.mock("@sentry/node", () => ({
  withScope: vi.fn(),
  captureException: vi.fn(),
}));

import { isPixPaid, processPixExpiry, type PixExpiryJobData } from "../pix-expiry-monitor.js";
import type { Job } from "../queue.js";

function buildJob(stage: "reminder" | "expired", orderId: string): Job<PixExpiryJobData> {
  return {
    data: { phone: "+5511999999999", phoneHash: "hash", orderId, stage },
  } as Job<PixExpiryJobData>;
}

describe("isPixPaid — PIXPAIDFLAG DB fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedisClient.mockResolvedValue({ get: mockRedisGet });
  });

  it("returns true from the Redis flag without consulting the DB", async () => {
    mockRedisGet.mockResolvedValue("1");

    expect(await isPixPaid("order_1")).toBe(true);
    expect(mockGetActiveByOrderId).not.toHaveBeenCalled();
  });

  it("falls back to the DB and returns true when the active Payment is PAID", async () => {
    mockRedisGet.mockResolvedValue(null); // flag absent (SET failed / TTL-evicted / restart)
    mockGetActiveByOrderId.mockResolvedValue({ status: PaymentStatus.PAID });

    expect(await isPixPaid("order_2")).toBe(true);
    expect(mockGetActiveByOrderId).toHaveBeenCalledWith("order_2");
  });

  it("returns false when the flag is absent and the active Payment is not yet paid", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockGetActiveByOrderId.mockResolvedValue({ status: PaymentStatus.PAYMENT_PENDING });

    expect(await isPixPaid("order_3")).toBe(false);
    expect(mockGetActiveByOrderId).toHaveBeenCalledWith("order_3");
  });

  it("returns false when the flag is absent and there is no active Payment", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockGetActiveByOrderId.mockResolvedValue(null);

    expect(await isPixPaid("order_4")).toBe(false);
    expect(mockGetActiveByOrderId).toHaveBeenCalledWith("order_4");
  });

  it("returns false (never throws) when the DB fallback query fails", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockGetActiveByOrderId.mockRejectedValue(new Error("db unavailable"));

    await expect(isPixPaid("order_5")).resolves.toBe(false);
  });
});

describe("processPixExpiry — suppresses messaging on DB-confirmed payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedisClient.mockResolvedValue({ get: mockRedisGet, set: mockRedisSet });
    // Default: NX claim succeeds (first run for this {orderId,stage}).
    mockRedisSet.mockResolvedValue("OK");
  });

  it("does NOT send a reminder when the flag is absent but the Payment is PAID", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockGetActiveByOrderId.mockResolvedValue({ status: PaymentStatus.PAID });

    await processPixExpiry(buildJob("reminder", "order_paid"));

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("sends a reminder when neither the flag nor the Payment indicate payment", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockGetActiveByOrderId.mockResolvedValue(null);

    await processPixExpiry(buildJob("reminder", "order_unpaid"));

    expect(mockSendText).toHaveBeenCalledTimes(1);
  });
});

describe("processPixExpiry — P3-NET-PIXREMINDER per-stage send idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedisClient.mockResolvedValue({ get: mockRedisGet, set: mockRedisSet });
    // Unpaid in every case here — we are isolating the NX send guard.
    mockRedisGet.mockResolvedValue(null);
    mockGetActiveByOrderId.mockResolvedValue(null);
  });

  it("claims the send with SET NX before messaging (keyed by orderId+stage)", async () => {
    mockRedisSet.mockResolvedValue("OK");

    await processPixExpiry(buildJob("reminder", "order_idem"));

    expect(mockRedisSet).toHaveBeenCalledWith(
      "ibatexas:pix:reminder-sent:order_idem:reminder",
      "1",
      { NX: true, EX: 3600 },
    );
    expect(mockSendText).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-send when the NX claim fails (key already set by a prior run)", async () => {
    mockRedisSet.mockResolvedValue(null); // NX → null: another run already sent it

    await processPixExpiry(buildJob("reminder", "order_dupe"));

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("a retry of the same {orderId,stage} sends exactly once across two invocations", async () => {
    // First invocation claims the key; the second sees it already set.
    mockRedisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await processPixExpiry(buildJob("expired", "order_retry"));
    await processPixExpiry(buildJob("expired", "order_retry"));

    expect(mockSendText).toHaveBeenCalledTimes(1);
  });

  it("uses a stage-scoped key so reminder and expired are independent claims", async () => {
    mockRedisSet.mockResolvedValue("OK");

    await processPixExpiry(buildJob("reminder", "order_two_stage"));
    await processPixExpiry(buildJob("expired", "order_two_stage"));

    const keys = mockRedisSet.mock.calls.map((c) => c[0]);
    expect(keys).toContain("ibatexas:pix:reminder-sent:order_two_stage:reminder");
    expect(keys).toContain("ibatexas:pix:reminder-sent:order_two_stage:expired");
    // Both distinct stages send (the guard is per-stage, not per-order).
    expect(mockSendText).toHaveBeenCalledTimes(2);
  });
});
