// Tests for the admin refund route — atomicity + over-refund guard (P0-PAY-5).
// All heavy deps mocked so the route collects without the @ibatexas/domain chain.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { FastifyRequest, FastifyReply } from "fastify";
import { PaymentStatus } from "@ibatexas/types";
import { adminPaymentRoutes } from "../routes/admin/payments.js";

const mockTransitionStatus = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockOrderGetById = vi.hoisted(() => vi.fn());
const mockPaymentUpdate = vi.hoisted(() => vi.fn());
const callOrder = vi.hoisted(() => [] as string[]);
const lockKeys = vi.hoisted(() => [] as string[]);

vi.mock("@ibatexas/domain", () => ({
  createPaymentCommandService: () => ({ transitionStatus: mockTransitionStatus }),
  createPaymentQueryService: () => ({ getActiveByOrderId: mockGetActiveByOrderId, getById: mockGetById }),
  createOrderQueryService: () => ({ getById: mockOrderGetById }),
  prisma: { payment: { update: mockPaymentUpdate } },
}));

vi.mock("@ibatexas/tools", () => ({
  withLock: vi.fn((key: string, fn: () => Promise<unknown>) => {
    lockKeys.push(key);
    return fn();
  }),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../middleware/staff-auth.js", () => ({
  requireStaff: (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    (req as FastifyRequest & { staffId?: string }).staffId = "staff_1";
    done();
  },
  requireManagerRole: (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    (req as FastifyRequest & { staffId?: string }).staffId = "staff_1";
    done();
  },
}));

async function buildServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(adminPaymentRoutes);
  await app.ready();
  return app;
}

function refund(app: Awaited<ReturnType<typeof buildServer>>, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/admin/orders/order_1/payment/refund", payload: body });
}

describe("admin refund — atomicity + over-refund (P0-PAY-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    lockKeys.length = 0;
    mockOrderGetById.mockResolvedValue({ id: "order_1" });
    mockTransitionStatus.mockImplementation(async () => {
      callOrder.push("transition");
      return { version: 2 };
    });
    mockPaymentUpdate.mockImplementation(async () => {
      callOrder.push("update");
      return {};
    });
  });

  it("re-reads inside the lock — rejects over-refund using the FRESH refundedAmount", async () => {
    // Initial read (outside the lock) looks fully refundable...
    mockGetActiveByOrderId.mockResolvedValue({
      id: "pay_1", status: PaymentStatus.PAID, amountInCentavos: 8900, refundedAmountCentavos: 0, method: "pix",
    });
    // ...but a concurrent refund already consumed it; the fresh re-read shows it spent.
    mockGetById.mockResolvedValue({
      id: "pay_1", status: PaymentStatus.PARTIALLY_REFUNDED, amountInCentavos: 8900, refundedAmountCentavos: 8900, method: "pix",
    });

    const app = await buildServer();
    const res = await refund(app, { amountInCentavos: 8900 });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("OVER_REFUND");
    expect(mockPaymentUpdate).not.toHaveBeenCalled();
    expect(mockTransitionStatus).not.toHaveBeenCalled();
  });

  it("acquires the per-payment lock and bumps amount BEFORE transitioning (fail-safe order)", async () => {
    const payment = {
      id: "pay_1", status: PaymentStatus.PAID, amountInCentavos: 8900, refundedAmountCentavos: 0, method: "pix",
    };
    mockGetActiveByOrderId.mockResolvedValue(payment);
    mockGetById.mockResolvedValue(payment);

    const app = await buildServer();
    const res = await refund(app, {}); // omit amount → full refund

    expect(res.statusCode).toBe(200);
    expect(lockKeys).toContain("payment:pay_1");
    expect(mockPaymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: { refundedAmountCentavos: 8900 },
    });
    expect(mockTransitionStatus).toHaveBeenCalledWith(
      "pay_1",
      expect.objectContaining({ newStatus: PaymentStatus.REFUNDED }),
    );
    expect(callOrder).toEqual(["update", "transition"]); // amount bumped before status flip
  });
});
