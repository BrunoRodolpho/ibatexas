// Tests that background jobs report errors to Sentry via captureException
// Each job should call Sentry.withScope + captureException when an error occurs.
// Tests call the exported processor functions directly (BullMQ is mocked).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkAbandonedCarts } from "../jobs/abandoned-cart-checker.js";
import { processOutbox } from "../jobs/outbox-retry.js";
import { checkNoShows } from "../jobs/no-show-checker.js";
import { pollReviewPrompts } from "../jobs/review-prompt-poller.js";
import { sendReminders } from "../jobs/reservation-reminder.js";

// ── Hoisted mock functions ──────────────────────────────────────────────────

const mockCaptureException = vi.hoisted(() => vi.fn());
const mockSetTag = vi.hoisted(() => vi.fn());
const mockSetContext = vi.hoisted(() => vi.fn());
const mockWithScope = vi.hoisted(() =>
  vi.fn((cb: (scope: { setTag: typeof mockSetTag; setContext: typeof mockSetContext }) => void) => {
    cb({ setTag: mockSetTag, setContext: mockSetContext });
  }),
);

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockLoadSession = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockFindConfirmedForDate = vi.hoisted(() => vi.fn());
const mockTransition = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockSendReservationReminder = vi.hoisted(() => vi.fn());

// ── Mocks (before imports) ──────────────────────────────────────────────────

vi.mock("@sentry/node", () => ({
  withScope: mockWithScope,
  captureException: mockCaptureException,
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  sendReservationReminder: mockSendReservationReminder,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
  outboxKey: (prefix: string, event: string) => `${prefix}:outbox:${event}`,
}));

vi.mock("../session/store.js", () => ({
  loadSession: mockLoadSession,
}));

vi.mock("@ibatexas/domain", () => ({
  createReservationService: () => ({
    findConfirmedForDate: mockFindConfirmedForDate,
    transition: mockTransition,
  }),
  createCustomerService: () => ({
    getById: mockGetById,
  }),
}));

vi.mock("@ibatexas/types", () => ({
  ReservationStatus: { CONFIRMED: "confirmed" },
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    hScan: vi.fn().mockResolvedValue({ cursor: 0, tuples: [] }),
    hDel: vi.fn(),
    exists: vi.fn(),
    ttl: vi.fn(),
    lRange: vi.fn().mockResolvedValue([]),
    zRangeByScore: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    zRem: vi.fn(),
    set: vi.fn(),
    multi: vi.fn(() => ({
      zRem: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
    ...overrides,
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: "info",
  } as unknown as import("fastify").FastifyBaseLogger;
}

function cartEntry(cartId: string, idleMs: number): string {
  return JSON.stringify({
    cartId,
    sessionType: "guest",
    lastActivity: Date.now() - idleMs,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Sentry reporting in background jobs", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRk.mockImplementation((key: string) => `test:${key}`);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── abandoned-cart-checker ────────────────────────────────────────────────

  describe("abandoned-cart-checker", () => {
    it("reports per-cart processing errors to Sentry", async () => {
      const idleMs = 3 * 60 * 60 * 1000;

      mockRedis.hScan.mockResolvedValue({
        cursor: 0,
        tuples: [{ field: "cart_err", value: cartEntry("cart_err", idleMs) }],
      });
      mockLoadSession.mockRejectedValue(new Error("Redis timeout"));

      await checkAbandonedCarts(createMockLogger());

      expect(mockWithScope).toHaveBeenCalled();
      expect(mockSetTag).toHaveBeenCalledWith("job", "abandoned-cart-checker");
      expect(mockSetTag).toHaveBeenCalledWith("source", "background-job");
      expect(mockSetContext).toHaveBeenCalledWith("cart", { cartId: "cart_err" });
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
    });

    it("propagates top-level errors for BullMQ to handle", async () => {
      mockGetRedisClient.mockRejectedValue(new Error("Redis connection refused"));

      await expect(checkAbandonedCarts(createMockLogger())).rejects.toThrow("Redis connection refused");
    });
  });

  // ── outbox-retry ──────────────────────────────────────────────────────────

  describe("outbox-retry", () => {
    it("reports per-event re-publish errors to Sentry", async () => {
      mockRedis.lRange.mockResolvedValue(['{"eventType":"order.placed"}']);
      mockRedis.set.mockResolvedValue("OK"); // lock acquired
      (mockRedis as Record<string, unknown>)["eval"] = vi.fn().mockResolvedValue(1); // lock released
      mockPublishNatsEvent.mockRejectedValue(new Error("NATS down"));

      await processOutbox(createMockLogger());

      expect(mockWithScope).toHaveBeenCalled();
      expect(mockSetTag).toHaveBeenCalledWith("job", "outbox-retry");
      expect(mockSetTag).toHaveBeenCalledWith("source", "background-job");
      expect(mockSetContext).toHaveBeenCalledWith("event", { eventType: "order.placed" });
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
    });

    it("propagates top-level poll errors for BullMQ to handle", async () => {
      mockGetRedisClient.mockRejectedValue(new Error("Redis unreachable"));

      await expect(processOutbox(createMockLogger())).rejects.toThrow("Redis unreachable");
    });
  });

  // ── no-show-checker ───────────────────────────────────────────────────────

  describe("no-show-checker", () => {
    it("reports per-reservation processing errors to Sentry", async () => {
      process.env.RESTAURANT_TIMEZONE = "UTC";

      const reservation = {
        id: "res_sentry",
        customerId: "cust_01",
        partySize: 4,
        status: "confirmed",
        timeSlot: {
          id: "slot_01",
          date: new Date("2026-03-15T00:00:00.000Z"),
          startTime: "11:30",
          durationMinutes: 90,
        },
      };

      mockFindConfirmedForDate.mockResolvedValue([reservation]);
      mockTransition.mockRejectedValue(new Error("DB write failed"));

      vi.setSystemTime(new Date("2026-03-15T23:59:00Z"));
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await checkNoShows();

      expect(mockWithScope).toHaveBeenCalled();
      expect(mockSetTag).toHaveBeenCalledWith("job", "no-show-checker");
      expect(mockSetTag).toHaveBeenCalledWith("source", "background-job");
      expect(mockSetContext).toHaveBeenCalledWith("reservation", { reservationId: "res_sentry" });
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));

      consoleErrorSpy.mockRestore();
      delete process.env.RESTAURANT_TIMEZONE;
    });

    it("propagates top-level errors for BullMQ to handle", async () => {
      mockFindConfirmedForDate.mockRejectedValue(new Error("DB connection lost"));

      await expect(checkNoShows()).rejects.toThrow("DB connection lost");
    });
  });

  // ── review-prompt-poller ──────────────────────────────────────────────────

  describe("review-prompt-poller", () => {
    it("reports NATS publish errors to Sentry", async () => {
      mockRedis.zRangeByScore.mockResolvedValue(["cust_01:order_01"]);
      mockRedis.get.mockResolvedValue("order_01");
      mockPublishNatsEvent.mockRejectedValue(new Error("NATS publish failed"));

      await pollReviewPrompts(createMockLogger());

      expect(mockWithScope).toHaveBeenCalled();
      expect(mockSetTag).toHaveBeenCalledWith("job", "review-prompt-poller");
      expect(mockSetTag).toHaveBeenCalledWith("source", "background-job");
      expect(mockSetContext).toHaveBeenCalledWith("review", {
        customerId: "cust_01",
        orderId: "order_01",
      });
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
    });

    it("propagates top-level errors for BullMQ to handle", async () => {
      mockGetRedisClient.mockRejectedValue(new Error("Redis unreachable"));

      await expect(pollReviewPrompts(createMockLogger())).rejects.toThrow("Redis unreachable");
    });
  });

  // ── reservation-reminder ──────────────────────────────────────────────────

  describe("reservation-reminder", () => {
    it("reports per-reservation send errors to Sentry", async () => {
      const reservation = {
        id: "res_reminder_err",
        customerId: "cust_02",
        partySize: 2,
        status: "confirmed",
        createdAt: new Date("2026-03-19T08:00:00Z"),
        timeSlot: {
          id: "slot_02",
          date: new Date("2026-03-19T00:00:00Z"),
          startTime: "12:00",
          durationMinutes: 90,
        },
      };

      mockFindConfirmedForDate.mockResolvedValue([reservation]);
      // Redis SET returns "OK" (NX succeeded — not sent yet)
      mockRedis.set.mockResolvedValue("OK");
      // Customer lookup succeeds but sendReservationReminder throws
      mockGetById.mockResolvedValue({ phone: "+5517999999999" });
      mockSendReservationReminder.mockRejectedValue(new Error("Twilio API error"));

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      await sendReminders();

      expect(mockWithScope).toHaveBeenCalled();
      expect(mockSetTag).toHaveBeenCalledWith("job", "reservation-reminder");
      expect(mockSetTag).toHaveBeenCalledWith("source", "background-job");
      expect(mockSetContext).toHaveBeenCalledWith("reservation", { reservationId: "res_reminder_err" });
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));

      consoleErrorSpy.mockRestore();
      consoleInfoSpy.mockRestore();
    });

    it("propagates top-level errors for BullMQ to handle", async () => {
      mockFindConfirmedForDate.mockRejectedValue(new Error("DB connection lost"));

      await expect(sendReminders()).rejects.toThrow("DB connection lost");
    });
  });
});
