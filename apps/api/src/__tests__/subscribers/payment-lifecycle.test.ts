// Regression tests for payment-lifecycle subscriber (P1-ERR-LIFECYCLE + P1-CONC-DEDUP).
//
// Focus:
//   • PAID auto-confirm + REFUNDED auto-cancel: an EXPECTED concurrency/invalid-
//     transition error is benign (info-level, NO DLQ, NO escalation), while an
//     UNEXPECTED error is escalated — pushToDlq(...) + order.escalation_needed —
//     mirroring the disputed branch (money taken, order not confirmed → alert).
//   • The handler body runs inside withDedup so the processed-key is only marked
//     after success; a duplicate (withDedup → false) is skipped.
//
// Service / Redis / NATS layers are mocked — no network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymentStatus } from "@ibatexas/types";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockTransitionStatus = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockEventLogAppend = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPushToDlq = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
// withDedup: by default run the handler and report it as newly processed.
const mockWithDedup = vi.hoisted(() =>
  vi.fn(async (_key: string, handler: () => Promise<void>) => {
    await handler();
    return true;
  }),
);

const natsHandlers: Record<string, (payload: unknown) => Promise<void>> = {};

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent.mockImplementation(
    async (event: string, handler: (payload: unknown) => Promise<void>) => {
      natsHandlers[event] = handler;
    },
  ),
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({ transitionStatus: mockTransitionStatus }),
  createOrderQueryService: () => ({ getById: mockGetById }),
  createOrderEventLogService: () => ({ append: mockEventLogAppend }),
}));

vi.mock("../../subscribers/dlq.js", () => ({
  pushToDlq: mockPushToDlq,
}));

vi.mock("../../subscribers/dedup.js", () => ({
  withDedup: mockWithDedup,
}));

import { startPaymentLifecycleSubscriber } from "../../subscribers/payment-lifecycle.js";

// ── Error fixtures (match the .name strings the subscriber classifies on) ──────
class ConcurrencyError extends Error {
  constructor() {
    super("concurrency");
    this.name = "ConcurrencyError";
  }
}
class InvalidTransitionError extends Error {
  constructor() {
    super("invalid transition");
    this.name = "InvalidTransitionError";
  }
}

async function register() {
  for (const k of Object.keys(natsHandlers)) delete natsHandlers[k];
  await startPaymentLifecycleSubscriber();
}

const PAID_PAYLOAD = {
  eventType: "payment.status_changed",
  orderId: "order_1",
  paymentId: "pay_1",
  newStatus: PaymentStatus.PAID,
  method: "pix",
  version: 1,
};

const REFUND_PAYLOAD = {
  eventType: "payment.status_changed",
  orderId: "order_2",
  paymentId: "pay_2",
  newStatus: PaymentStatus.REFUNDED,
  method: "pix",
  version: 1,
};

describe("payment-lifecycle — PAID auto-confirm error handling", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockWithDedup.mockImplementation(async (_k: string, h: () => Promise<void>) => {
      await h();
      return true;
    });
    mockPublishNatsEvent.mockResolvedValue(undefined);
    await register();
  });

  it("auto-confirms a pending order on PAID (happy path, no escalation)", async () => {
    mockGetById.mockResolvedValue({ fulfillmentStatus: "pending", displayId: 7, customerId: "cus_1", version: 1 });
    mockTransitionStatus.mockResolvedValue(undefined);

    await natsHandlers["payment.status_changed"](PAID_PAYLOAD);

    expect(mockTransitionStatus).toHaveBeenCalledWith("order_1", expect.objectContaining({ newStatus: "confirmed" }));
    expect(mockPushToDlq).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith("order.escalation_needed", expect.anything());
  });

  it("treats a ConcurrencyError as benign — NO DLQ, NO escalation", async () => {
    mockGetById.mockResolvedValue({ fulfillmentStatus: "pending", displayId: 7, customerId: "cus_1", version: 1 });
    mockTransitionStatus.mockRejectedValue(new ConcurrencyError());

    await natsHandlers["payment.status_changed"](PAID_PAYLOAD);

    expect(mockPushToDlq).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith("order.escalation_needed", expect.anything());
  });

  it("treats an InvalidTransitionError as benign — NO DLQ, NO escalation", async () => {
    mockGetById.mockResolvedValue({ fulfillmentStatus: "pending", displayId: 7, customerId: "cus_1", version: 1 });
    mockTransitionStatus.mockRejectedValue(new InvalidTransitionError());

    await natsHandlers["payment.status_changed"](PAID_PAYLOAD);

    expect(mockPushToDlq).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith("order.escalation_needed", expect.anything());
  });

  it("ESCALATES an unexpected error — pushToDlq + order.escalation_needed", async () => {
    mockGetById.mockResolvedValue({ fulfillmentStatus: "pending", displayId: 7, customerId: "cus_1", version: 1 });
    mockTransitionStatus.mockRejectedValue(new Error("DB connection lost"));

    await natsHandlers["payment.status_changed"](PAID_PAYLOAD);

    expect(mockPushToDlq).toHaveBeenCalledWith(
      "payment.status_changed",
      expect.objectContaining({ orderId: "order_1", paymentId: "pay_1" }),
      expect.any(Error),
      undefined,
    );
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "order.escalation_needed",
      expect.objectContaining({
        eventType: "order.escalation_needed",
        orderId: "order_1",
        reason: "auto_confirm_failed",
        paymentId: "pay_1",
      }),
    );
  });
});

describe("payment-lifecycle — REFUNDED auto-cancel error handling", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockWithDedup.mockImplementation(async (_k: string, h: () => Promise<void>) => {
      await h();
      return true;
    });
    mockPublishNatsEvent.mockResolvedValue(undefined);
    await register();
  });

  it("ESCALATES an unexpected cancel failure — pushToDlq + order.escalation_needed", async () => {
    mockGetById.mockResolvedValue({ fulfillmentStatus: "confirmed", displayId: 9, customerId: "cus_2", version: 1 });
    mockTransitionStatus.mockRejectedValue(new Error("write conflict at storage layer"));

    await natsHandlers["payment.status_changed"](REFUND_PAYLOAD);

    expect(mockPushToDlq).toHaveBeenCalledWith(
      "payment.status_changed",
      expect.objectContaining({ orderId: "order_2" }),
      expect.any(Error),
      undefined,
    );
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "order.escalation_needed",
      expect.objectContaining({ reason: "refund_cancel_failed", orderId: "order_2", paymentId: "pay_2" }),
    );
  });

  it("treats a ConcurrencyError on cancel as benign — NO escalation", async () => {
    mockGetById.mockResolvedValue({ fulfillmentStatus: "confirmed", displayId: 9, customerId: "cus_2", version: 1 });
    mockTransitionStatus.mockRejectedValue(new ConcurrencyError());

    await natsHandlers["payment.status_changed"](REFUND_PAYLOAD);

    expect(mockPushToDlq).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith("order.escalation_needed", expect.anything());
  });
});

describe("payment-lifecycle — dedup integration", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockPublishNatsEvent.mockResolvedValue(undefined);
    await register();
  });

  it("wraps processing in withDedup keyed by paymentId:newStatus", async () => {
    mockWithDedup.mockResolvedValue(false); // simulate duplicate
    mockGetById.mockResolvedValue({ fulfillmentStatus: "pending", displayId: 7, version: 1 });

    await natsHandlers["payment.status_changed"](PAID_PAYLOAD);

    expect(mockWithDedup).toHaveBeenCalledWith(
      "payment-lifecycle:pay_1:paid",
      expect.any(Function),
    );
    // Duplicate → body never ran → no transition attempted.
    expect(mockTransitionStatus).not.toHaveBeenCalled();
  });
});
