// Unit tests for payment-lifecycle subscriber governance — Task 16.
//
// What's under test:
//   1. EXECUTE path: paid → auto-confirm builds the right envelope and
//      calls transitionStatusFromEnvelope, then publishes order.status_changed.
//   2. REFUSE path: kernel decision REFUSE → no mutation, DLQ written.
//   3. REFUNDED → auto-cancel envelope shape + publish order.canceled.
//   4. Envelope shape: actor.principal="system", taint="SYSTEM",
//      sessionId/nonce derived from paymentId+newStatus (replay-safe).
//   5. Cash payments do NOT trigger auto-confirm (existing behavior preserved).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockIsNewEvent = vi.hoisted(() => vi.fn());
const mockPushToDlq = vi.hoisted(() => vi.fn());
const mockTransitionStatusFromEnvelope = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockEventLogAppend = vi.hoisted(() => vi.fn());
const mockGetAuditSinkEmit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent,
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelope,
  }),
  createOrderQueryService: () => ({
    getById: mockGetById,
  }),
  createOrderEventLogService: () => ({
    append: mockEventLogAppend,
  }),
}));

vi.mock("../../subscribers/dedup.js", () => ({
  isNewEvent: mockIsNewEvent,
}));

vi.mock("../../subscribers/dlq.js", () => ({
  pushToDlq: mockPushToDlq,
}));

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: "info" as const,
    silent: vi.fn(),
  };
}

async function getRegisteredCallback() {
  mockSubscribeNatsEvent.mockClear();
  const { startPaymentLifecycleSubscriber } = await import(
    "../../subscribers/payment-lifecycle.js"
  );
  await startPaymentLifecycleSubscriber(makeLogger() as never);
  expect(mockSubscribeNatsEvent).toHaveBeenCalledOnce();
  const [subject, callback] = mockSubscribeNatsEvent.mock.calls[0] as [
    string,
    (payload: unknown) => Promise<void>,
  ];
  expect(subject).toBe("payment.status_changed");
  return callback;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("payment-lifecycle governance (task 16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNewEvent.mockResolvedValue(true);
    mockEventLogAppend.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  describe("paid → auto-confirm", () => {
    it("builds a SYSTEM-actor envelope and calls transitionStatusFromEnvelope on EXECUTE", async () => {
      mockGetById.mockResolvedValue({
        id: "order_01",
        displayId: 42,
        customerId: "cust_01",
        fulfillmentStatus: "pending",
        version: 1,
      });
      mockTransitionStatusFromEnvelope.mockResolvedValue({
        decision: { kind: "EXECUTE", basis: [] },
        result: { version: 2, previousStatus: "pending", newStatus: "confirmed" },
      });

      const callback = await getRegisteredCallback();
      await callback({
        orderId: "order_01",
        paymentId: "pay_01",
        previousStatus: "payment_pending",
        newStatus: "paid",
        method: "pix",
        version: 2,
      });

      expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledOnce();
      const [envelope] = mockTransitionStatusFromEnvelope.mock.calls[0] as [
        IntentEnvelope,
      ];
      expect(envelope.kind).toBe("order.status.transition");
      expect(envelope.actor.principal).toBe("system");
      expect(envelope.taint).toBe("SYSTEM");
      // nonce + sessionId derived from paymentId + newStatus → replay-safe
      expect(envelope.nonce).toBe("auto_confirm:pay_01:paid");
      expect(envelope.actor.sessionId).toBe(
        "payment.status_changed:auto_confirm:pay_01:paid",
      );
      expect(envelope.payload).toMatchObject({
        orderId: "order_01",
        newStatus: "confirmed",
        actor: "system",
      });

      // order.status_changed event published
      expect(mockPublishNatsEvent).toHaveBeenCalledWith(
        "order.status_changed",
        expect.objectContaining({
          orderId: "order_01",
          newStatus: "confirmed",
          previousStatus: "pending",
        }),
      );
    });

    it("does NOT auto-confirm cash payments (existing behavior preserved)", async () => {
      const callback = await getRegisteredCallback();
      await callback({
        orderId: "order_02",
        paymentId: "pay_02",
        previousStatus: "cash_pending",
        newStatus: "paid",
        method: "cash",
        version: 2,
      });

      expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled();
      expect(mockGetById).not.toHaveBeenCalled();
    });

    it("skips auto-confirm when order is not pending", async () => {
      mockGetById.mockResolvedValue({
        id: "order_03",
        displayId: 43,
        customerId: "cust_03",
        fulfillmentStatus: "confirmed",
        version: 2,
      });

      const callback = await getRegisteredCallback();
      await callback({
        orderId: "order_03",
        paymentId: "pay_03",
        previousStatus: "payment_pending",
        newStatus: "paid",
        method: "pix",
        version: 2,
      });

      expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled();
    });

    it("on REFUSE: skips mutation and pushes to DLQ", async () => {
      mockGetById.mockResolvedValue({
        id: "order_04",
        displayId: 44,
        customerId: "cust_04",
        fulfillmentStatus: "pending",
        version: 1,
      });
      mockTransitionStatusFromEnvelope.mockResolvedValue({
        decision: {
          kind: "REFUSE",
          refusal: {
            code: "order.projection.not_found",
            userFacing: "Pedido não encontrado.",
            class: "BUSINESS_RULE",
          },
          basis: [],
        },
      });

      const callback = await getRegisteredCallback();
      await callback({
        orderId: "order_04",
        paymentId: "pay_04",
        previousStatus: "payment_pending",
        newStatus: "paid",
        method: "pix",
        version: 2,
      });

      expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledOnce();
      // No order.status_changed published
      expect(mockPublishNatsEvent).not.toHaveBeenCalled();
      // DLQ written
      expect(mockPushToDlq).toHaveBeenCalledOnce();
      const [dlqEvent] = mockPushToDlq.mock.calls[0] as [string];
      expect(dlqEvent).toBe("payment.status_changed");
    });
  });

  describe("refunded → auto-cancel", () => {
    it("builds an auto-cancel envelope and publishes order.canceled on EXECUTE", async () => {
      mockGetById.mockResolvedValue({
        id: "order_10",
        displayId: 50,
        customerId: "cust_10",
        fulfillmentStatus: "confirmed",
        version: 2,
      });
      mockTransitionStatusFromEnvelope.mockResolvedValue({
        decision: { kind: "EXECUTE", basis: [] },
        result: { version: 3, previousStatus: "confirmed", newStatus: "canceled" },
      });

      const callback = await getRegisteredCallback();
      await callback({
        orderId: "order_10",
        paymentId: "pay_10",
        previousStatus: "paid",
        newStatus: "refunded",
        method: "card",
        version: 3,
      });

      expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledOnce();
      const [envelope] = mockTransitionStatusFromEnvelope.mock.calls[0] as [
        IntentEnvelope,
      ];
      expect(envelope.kind).toBe("order.status.transition");
      expect(envelope.nonce).toBe("auto_cancel:pay_10:refunded");
      expect(envelope.taint).toBe("SYSTEM");
      expect(envelope.payload).toMatchObject({
        newStatus: "canceled",
        reason: "Pagamento reembolsado",
      });

      expect(mockPublishNatsEvent).toHaveBeenCalledWith(
        "order.canceled",
        expect.objectContaining({ orderId: "order_10" }),
      );
    });

    it("skips auto-cancel when order is past cancelable state", async () => {
      mockGetById.mockResolvedValue({
        id: "order_11",
        displayId: 51,
        customerId: "cust_11",
        fulfillmentStatus: "delivered",
        version: 5,
      });

      const callback = await getRegisteredCallback();
      await callback({
        orderId: "order_11",
        paymentId: "pay_11",
        previousStatus: "paid",
        newStatus: "refunded",
        method: "card",
        version: 3,
      });

      expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled();
    });
  });

  describe("P1-C: DLQ on transitionStatusFromEnvelope throw", () => {
    it("auto-confirm throw → original payload pushed to DLQ", async () => {
      mockGetById.mockResolvedValue({
        id: "order_thr_01",
        displayId: 70,
        customerId: "cust_thr_01",
        fulfillmentStatus: "pending",
        version: 1,
      });
      const err = new Error("ConcurrencyError: version stale");
      mockTransitionStatusFromEnvelope.mockRejectedValue(err);

      const originalPayload = {
        orderId: "order_thr_01",
        paymentId: "pay_thr_01",
        previousStatus: "payment_pending",
        newStatus: "paid",
        method: "pix",
        version: 2,
      };

      const callback = await getRegisteredCallback();
      await callback(originalPayload);

      // No order.status_changed publish.
      expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
        "order.status_changed",
        expect.anything(),
      );
      // DLQ push with the original payload + the thrown error.
      expect(mockPushToDlq).toHaveBeenCalledOnce();
      const [subject, payload, errOut] =
        mockPushToDlq.mock.calls[0] as [string, Record<string, unknown>, unknown];
      expect(subject).toBe("payment.status_changed");
      expect(payload).toEqual(originalPayload);
      expect(errOut).toBe(err);
    });

    it("auto-cancel throw → original payload pushed to DLQ", async () => {
      mockGetById.mockResolvedValue({
        id: "order_thr_02",
        displayId: 71,
        customerId: "cust_thr_02",
        fulfillmentStatus: "confirmed",
        version: 2,
      });
      const err = new Error("InvalidTransitionError");
      mockTransitionStatusFromEnvelope.mockRejectedValue(err);

      const originalPayload = {
        orderId: "order_thr_02",
        paymentId: "pay_thr_02",
        previousStatus: "paid",
        newStatus: "refunded",
        method: "card",
        version: 3,
      };

      const callback = await getRegisteredCallback();
      await callback(originalPayload);

      expect(mockPushToDlq).toHaveBeenCalledOnce();
      const [subject, payload, errOut] =
        mockPushToDlq.mock.calls[0] as [string, Record<string, unknown>, unknown];
      expect(subject).toBe("payment.status_changed");
      expect(payload).toEqual(originalPayload);
      expect(errOut).toBe(err);
    });
  });

  describe("idempotency", () => {
    it("skips when dedup says the event is a duplicate", async () => {
      mockIsNewEvent.mockResolvedValue(false);

      const callback = await getRegisteredCallback();
      await callback({
        orderId: "order_20",
        paymentId: "pay_20",
        previousStatus: "payment_pending",
        newStatus: "paid",
        method: "pix",
        version: 2,
      });

      expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled();
      expect(mockGetById).not.toHaveBeenCalled();
    });

    it("nonce is deterministic per paymentId+newStatus (replay-safe)", async () => {
      mockGetById.mockResolvedValue({
        id: "order_30",
        displayId: 60,
        customerId: "cust_30",
        fulfillmentStatus: "pending",
        version: 1,
      });
      mockTransitionStatusFromEnvelope.mockResolvedValue({
        decision: { kind: "EXECUTE", basis: [] },
        result: { version: 2, previousStatus: "pending", newStatus: "confirmed" },
      });

      const callback = await getRegisteredCallback();
      await callback({
        orderId: "order_30",
        paymentId: "pay_30",
        previousStatus: "payment_pending",
        newStatus: "paid",
        method: "pix",
        version: 2,
      });

      const [env1] = mockTransitionStatusFromEnvelope.mock.calls[0] as [
        IntentEnvelope,
      ];
      const firstHash = env1.intentHash;
      const firstNonce = env1.nonce;

      // Simulate re-delivery (dedup off — proves the envelope itself is deterministic)
      mockTransitionStatusFromEnvelope.mockClear();
      mockIsNewEvent.mockResolvedValue(true);
      await callback({
        orderId: "order_30",
        paymentId: "pay_30",
        previousStatus: "payment_pending",
        newStatus: "paid",
        method: "pix",
        version: 2,
      });
      const [env2] = mockTransitionStatusFromEnvelope.mock.calls[0] as [
        IntentEnvelope,
      ];

      expect(env2.nonce).toBe(firstNonce);
      expect(env2.intentHash).toBe(firstHash);
    });
  });
});
