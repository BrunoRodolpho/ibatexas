// Unit tests for payment-lifecycle subscriber — P1-ERR-LIFECYCLE escalation.
//
// Focus: when the kernel-gated auto-confirm / auto-cancel transition THROWS,
// the handler must classify the error:
//   - expected (ConcurrencyError / InvalidTransitionError) → info log, NO DLQ
//     (another process already advanced the order).
//   - unexpected (anything else) → pushToDlq for recovery (BKL-181 removed the
//     dead `order.escalation_needed` publish — it had no subscriber).
//
// withDedup is mocked to run the handler directly so we exercise the body.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { startPaymentLifecycleSubscriber } from "../../subscribers/payment-lifecycle.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockTransitionStatusFromEnvelope = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockEventLogAppend = vi.hoisted(() => vi.fn());
const mockPushToDlq = vi.hoisted(() => vi.fn());
const mockWithDedup = vi.hoisted(() => vi.fn());

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
  createOrderCommandService: () => ({
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelope,
  }),
  createOrderQueryService: () => ({ getById: mockGetById }),
  createOrderEventLogService: () => ({ append: mockEventLogAppend }),
}));

vi.mock("@ibatexas/audit-sink", () => ({
  getAuditSink: () => ({ emit: vi.fn() }),
}));

vi.mock("../../subscribers/dlq.js", () => ({ pushToDlq: mockPushToDlq }));

// Run the handler directly; promote-on-success is irrelevant to these assertions.
vi.mock("../../subscribers/dedup.js", () => ({
  withDedup: mockWithDedup.mockImplementation(
    async (_key: string, handler: () => Promise<void>) => {
      await handler();
      return true;
    },
  ),
}));

vi.mock("../../subscribers/__shared__/system-actor-envelope.js", () => ({
  buildSystemEnvelope: (args: unknown) => ({ ...(args as object), nonce: "n-test" }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function executeDecision() {
  return { decision: { kind: "EXECUTE" as const, basis: [] }, result: { version: 2 } };
}

class ConcurrencyError extends Error {
  constructor() {
    super("version conflict");
    this.name = "ConcurrencyError";
  }
}

const PAID_PAYLOAD = {
  orderId: "order_01",
  paymentId: "pay_01",
  newStatus: "paid",
  method: "pix",
  previousStatus: "awaiting_payment",
  version: 2,
};

async function register() {
  for (const k of Object.keys(natsHandlers)) delete natsHandlers[k];
  await startPaymentLifecycleSubscriber();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("payment-lifecycle — auto-confirm failure escalation (P1-ERR-LIFECYCLE)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockWithDedup.mockImplementation(async (_key: string, handler: () => Promise<void>) => {
      await handler();
      return true;
    });
    mockEventLogAppend.mockResolvedValue(undefined);
    mockGetById.mockResolvedValue({
      id: "order_01",
      displayId: 42,
      fulfillmentStatus: "pending",
      customerId: "cust_01",
      version: 1,
    });
    mockPublishNatsEvent.mockResolvedValue(undefined);
    mockPushToDlq.mockResolvedValue(undefined);
    await register();
  });

  it("DLQs (for recovery) when auto-confirm throws an UNEXPECTED error — no dead escalation event (BKL-181)", async () => {
    mockTransitionStatusFromEnvelope.mockRejectedValueOnce(new Error("db exploded"));

    await natsHandlers["payment.status_changed"](PAID_PAYLOAD);

    expect(mockPushToDlq).toHaveBeenCalledTimes(1);
    // BKL-181 — the subscriber-less order.escalation_needed is no longer published.
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "order.escalation_needed",
      expect.anything(),
    );
  });

  it("does NOT escalate when auto-confirm throws an EXPECTED transition error (already advanced)", async () => {
    mockTransitionStatusFromEnvelope.mockRejectedValueOnce(new ConcurrencyError());

    await natsHandlers["payment.status_changed"](PAID_PAYLOAD);

    expect(mockPushToDlq).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "order.escalation_needed",
      expect.anything(),
    );
  });

  it("does NOT escalate on a clean auto-confirm (EXECUTE)", async () => {
    mockTransitionStatusFromEnvelope.mockResolvedValueOnce(executeDecision());

    await natsHandlers["payment.status_changed"](PAID_PAYLOAD);

    expect(mockPushToDlq).not.toHaveBeenCalled();
    // order.status_changed is published on success, but NOT order.escalation_needed.
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "order.escalation_needed",
      expect.anything(),
    );
  });

  it("skips the handler entirely when withDedup reports a duplicate", async () => {
    mockWithDedup.mockImplementationOnce(async () => false);

    await natsHandlers["payment.status_changed"](PAID_PAYLOAD);

    // Handler body never ran → no transition attempted, no escalation.
    expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled();
    expect(mockPushToDlq).not.toHaveBeenCalled();
  });
});
