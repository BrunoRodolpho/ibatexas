// Regression tests for the 2026-05-27 P2 audit fixes on order-actions.ts cancel:
//
//   P2-LOGIC-CANCELPAY — cancel must NOT emit `order.canceled` when the active
//                        payment is not terminal afterward (cancel attempt
//                        failed and the payment is still live). Otherwise a
//                        canceled order can retain a payment that later
//                        reconciles to `paid`.
//   P2-CONC-CONFIRMVER — the customer-cancel payment-cancel transition must pin
//                        expectedVersion (the version read from the active
//                        payment) so a concurrent flip is not clobbered.
//
// Heavy deps mocked so the route collects without the @ibatexas/domain chain
// (mirrors order-actions-payment-compensation.test.ts). @ibatexas/types is NOT
// mocked: the real isTerminalPaymentStatus / canPerformAction run.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Conductor is unconditional post-cutover; a permissive EXECUTE conductor lets the
// gateway run the route's domain mutation (behaviour-preserving for these tests).
vi.mock("../claustrum-bootstrap.js", () => {
  const conductor = { adjudicator: { adjudicate: async () => ({ kind: "EXECUTE", basis: [] }) } };
  return {
    getConductor: () => conductor,
    tryGetConductor: () => conductor,
    policyForKind: () => ({
      stateGuards: [], authGuards: [], business: [],
      taint: { minimumFor: () => "UNTRUSTED" }, default: "EXECUTE",
    }),
  };
});
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { FastifyRequest, FastifyReply } from "fastify";
import { PaymentStatus } from "@ibatexas/types";
import { orderActionRoutes } from "../routes/order-actions.js";

const mockOrderTransition = vi.hoisted(() => vi.fn());
const mockFindActiveByOrderId = vi.hoisted(() => vi.fn());
const mockPaymentTransition = vi.hoisted(() => vi.fn());
const mockOrderGetById = vi.hoisted(() => vi.fn());
const mockPublishNats = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({ create: vi.fn(), transitionStatus: mockOrderTransition }),
  createOrderQueryService: () => ({ getById: mockOrderGetById }),
  createPaymentCommandService: () => ({
    transitionStatus: mockPaymentTransition,
    create: vi.fn(),
    findActiveByOrderId: mockFindActiveByOrderId,
  }),
  createPaymentQueryService: () => ({ getActiveByOrderId: vi.fn(), listByOrderId: vi.fn() }),
  prisma: { payment: { update: vi.fn() }, orderNote: {} },
  InvalidTransitionError: class InvalidTransitionError extends Error {},
  // Generous PONR window so the (recent) order passes the cancel-allowed check.
  getEffectivePonr: () => ({ cancelMinutes: 600 }),
}));

vi.mock("@ibatexas/tools", () => ({
  withLock: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
  getRedisClient: vi.fn(async () => ({
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  })),
  rk: (s: string) => s,
  amendOrder: vi.fn(),
  changeDeliveryAddress: vi.fn(),
  switchOrderType: vi.fn(),
  medusaAdmin: vi.fn(),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNats,
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    (req as FastifyRequest & { customerId?: string }).customerId = "cust_1";
    done();
  },
}));

async function buildServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(orderActionRoutes);
  await app.ready();
  return app;
}

function cancel(app: Awaited<ReturnType<typeof buildServer>>) {
  return app.inject({ method: "POST", url: "/api/orders/order_1/cancel", payload: { reason: "mudei de ideia" } });
}

describe("P2-LOGIC-CANCELPAY / P2-CONC-CONFIRMVER — customer cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A freshly-created, pending order so canPerformAction("cancel_order") passes.
    mockOrderGetById.mockResolvedValue({
      id: "order_1",
      customerId: "cust_1",
      fulfillmentStatus: "pending",
      displayId: 1,
      createdAt: new Date(),
    });
    mockOrderTransition.mockResolvedValue({ version: 2, newStatus: "canceled" });
    mockPublishNats.mockResolvedValue(undefined);
  });

  it("happy path: cancels live payment, then emits order.canceled", async () => {
    mockFindActiveByOrderId.mockResolvedValue({
      id: "pay_1", status: PaymentStatus.AWAITING_PAYMENT, version: 4,
    });
    mockPaymentTransition.mockResolvedValue({ version: 5, previousStatus: "awaiting_payment", newStatus: "canceled" });

    const app = await buildServer();
    const res = await cancel(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    // P2-CONC-CONFIRMVER: the cancel transition pins the read version.
    expect(mockPaymentTransition).toHaveBeenCalledWith(
      "pay_1",
      expect.objectContaining({ newStatus: PaymentStatus.CANCELED, expectedVersion: 4 }),
    );
    // Payment terminal ⇒ event emitted.
    expect(mockPublishNats).toHaveBeenCalledWith("order.canceled", expect.objectContaining({ orderId: "order_1" }));
  });

  it("no active payment: nothing to cancel, emits order.canceled", async () => {
    mockFindActiveByOrderId.mockResolvedValue(null);

    const app = await buildServer();
    const res = await cancel(app);

    expect(res.statusCode).toBe(200);
    expect(mockPaymentTransition).not.toHaveBeenCalled();
    expect(mockPublishNats).toHaveBeenCalledWith("order.canceled", expect.anything());
  });

  it("already-terminal active lookup: emits order.canceled without transitioning", async () => {
    // findActiveByOrderId only returns NON-terminal payments in production, but
    // guard defensively: a terminal status short-circuits to terminal=true.
    mockFindActiveByOrderId.mockResolvedValue({
      id: "pay_1", status: PaymentStatus.CANCELED, version: 9,
    });

    const app = await buildServer();
    const res = await cancel(app);

    expect(res.statusCode).toBe(200);
    expect(mockPaymentTransition).not.toHaveBeenCalled();
    expect(mockPublishNats).toHaveBeenCalledWith("order.canceled", expect.anything());
  });

  it("payment-cancel FAILS and payment stays live → withholds order.canceled, returns 409", async () => {
    // Active, non-terminal payment...
    mockFindActiveByOrderId
      .mockResolvedValueOnce({ id: "pay_1", status: PaymentStatus.AWAITING_PAYMENT, version: 4 })
      // ...transition throws (e.g. concurrency: webhook flipped it to paid)...
      // ...and the post-failure re-read shows it is STILL active (non-terminal).
      .mockResolvedValueOnce({ id: "pay_1", status: PaymentStatus.PAID, version: 5 });
    mockPaymentTransition.mockRejectedValue(new Error("PaymentConcurrencyError"));

    const app = await buildServer();
    const res = await cancel(app);

    // Event MUST NOT be published — order canceled but payment is still live.
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PAYMENT_CANCEL_FAILED");
    expect(mockPublishNats).not.toHaveBeenCalled();
  });

  it("payment-cancel throws but payment IS terminal afterward → still emits order.canceled", async () => {
    // Cancel raced with another terminalizing transition; the re-read shows no
    // active payment (it settled to a terminal state). Safe to emit.
    mockFindActiveByOrderId
      .mockResolvedValueOnce({ id: "pay_1", status: PaymentStatus.AWAITING_PAYMENT, version: 4 })
      .mockResolvedValueOnce(null);
    mockPaymentTransition.mockRejectedValue(new Error("already terminal"));

    const app = await buildServer();
    const res = await cancel(app);

    expect(res.statusCode).toBe(200);
    expect(mockPublishNats).toHaveBeenCalledWith("order.canceled", expect.anything());
  });
});
