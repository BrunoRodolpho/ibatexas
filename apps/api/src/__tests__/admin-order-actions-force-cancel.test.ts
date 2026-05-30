// Route-level parity tests for admin POST /api/admin/orders/:id/force-cancel
// (D-C: tests land BEFORE the cutover so we can prove byte-equivalent legacy
// behavior survives routing through adjudicateStaffMutation while inert).
//
// Legacy behavior under test (the manager force-cancel path):
//   - order not found            → 404
//   - order already terminal     → 422 (CANCELED or DELIVERED)
//   - happy path                 → 200, order→CANCELED, active non-terminal
//                                  payment→CANCELED, order.canceled published
//   - no active payment          → 200, published, no payment transition
//   - active payment terminal    → 200, published, no payment transition
//
// Heavy deps mocked so the route collects without the @ibatexas/domain chain.
// @ibatexas/types is NOT mocked — the real isTerminalPaymentStatus +
// OrderFulfillmentStatus run. claustrum-bootstrap is NOT mocked: the conductor
// singleton is null (bootstrap uncalled) → tryGetConductor() === null → the
// inert legacy path runs, which is exactly what we assert is byte-equivalent.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { FastifyRequest, FastifyReply } from "fastify";
import { OrderFulfillmentStatus, PaymentStatus } from "@ibatexas/types";
import { adminOrderActionRoutes } from "../routes/admin/order-actions.js";

const mockOrderTransition = vi.hoisted(() => vi.fn());
const mockOrderGetById = vi.hoisted(() => vi.fn());
const mockPaymentTransition = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());
const mockPublishNats = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({ create: vi.fn(), transitionStatus: mockOrderTransition }),
  createOrderQueryService: () => ({ getById: mockOrderGetById }),
  createPaymentCommandService: () => ({ transitionStatus: mockPaymentTransition, create: vi.fn() }),
  createPaymentQueryService: () => ({ getActiveByOrderId: mockGetActiveByOrderId }),
  prisma: { orderNote: { create: vi.fn() } },
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNats,
}));

vi.mock("../middleware/staff-auth.js", () => ({
  // force-cancel uses requireManager; advance/waive use requireStaff. Stamp a
  // staff id on all so the handlers attribute the action.
  requireManager: (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    (req as FastifyRequest & { staffId?: string; staffRole?: string }).staffId = "staff_mgr";
    (req as FastifyRequest & { staffRole?: string }).staffRole = "MANAGER";
    done();
  },
  requireStaff: (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    (req as FastifyRequest & { staffId?: string; staffRole?: string }).staffId = "staff_mgr";
    (req as FastifyRequest & { staffRole?: string }).staffRole = "MANAGER";
    done();
  },
}));

async function buildServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(adminOrderActionRoutes);
  await app.ready();
  return app;
}

function forceCancel(app: Awaited<ReturnType<typeof buildServer>>, body: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/api/admin/orders/order_1/force-cancel", payload: body });
}

describe("admin force-cancel — legacy parity (inert)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrderTransition.mockResolvedValue({ version: 2, newStatus: "canceled" });
    mockPaymentTransition.mockResolvedValue({ version: 5 });
    mockPublishNats.mockResolvedValue(undefined);
  });

  it("order not found → 404", async () => {
    mockOrderGetById.mockResolvedValue(null);
    const app = await buildServer();
    const res = await forceCancel(app);
    expect(res.statusCode).toBe(404);
    expect(mockOrderTransition).not.toHaveBeenCalled();
  });

  it("already CANCELED → 422, no mutation", async () => {
    mockOrderGetById.mockResolvedValue({
      id: "order_1", fulfillmentStatus: OrderFulfillmentStatus.CANCELED, displayId: 1, customerId: "c1",
    });
    const app = await buildServer();
    const res = await forceCancel(app);
    expect(res.statusCode).toBe(422);
    expect(mockOrderTransition).not.toHaveBeenCalled();
    expect(mockPublishNats).not.toHaveBeenCalled();
  });

  it("already DELIVERED → 422, no mutation", async () => {
    mockOrderGetById.mockResolvedValue({
      id: "order_1", fulfillmentStatus: OrderFulfillmentStatus.DELIVERED, displayId: 1, customerId: "c1",
    });
    const app = await buildServer();
    const res = await forceCancel(app);
    expect(res.statusCode).toBe(422);
    expect(mockOrderTransition).not.toHaveBeenCalled();
  });

  it("happy path: cancels order + active non-terminal payment, publishes order.canceled", async () => {
    mockOrderGetById.mockResolvedValue({
      id: "order_1", fulfillmentStatus: OrderFulfillmentStatus.PENDING, displayId: 7, customerId: "c1",
    });
    mockGetActiveByOrderId.mockResolvedValue({
      id: "pay_1", status: PaymentStatus.AWAITING_PAYMENT,
    });

    const app = await buildServer();
    const res = await forceCancel(app, { reason: "fraude" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, fulfillmentStatus: OrderFulfillmentStatus.CANCELED });
    expect(mockOrderTransition).toHaveBeenCalledWith(
      "order_1",
      expect.objectContaining({ newStatus: OrderFulfillmentStatus.CANCELED, actor: "admin", actorId: "staff_mgr" }),
    );
    expect(mockPaymentTransition).toHaveBeenCalledWith(
      "pay_1",
      expect.objectContaining({ newStatus: PaymentStatus.CANCELED }),
    );
    expect(mockPublishNats).toHaveBeenCalledWith("order.canceled", expect.objectContaining({ orderId: "order_1", canceledBy: "admin" }));
  });

  it("no active payment → 200, publishes, no payment transition", async () => {
    mockOrderGetById.mockResolvedValue({
      id: "order_1", fulfillmentStatus: OrderFulfillmentStatus.PENDING, displayId: 7, customerId: "c1",
    });
    mockGetActiveByOrderId.mockResolvedValue(null);

    const app = await buildServer();
    const res = await forceCancel(app);

    expect(res.statusCode).toBe(200);
    expect(mockPaymentTransition).not.toHaveBeenCalled();
    expect(mockPublishNats).toHaveBeenCalledWith("order.canceled", expect.anything());
  });

  it("active payment already terminal → 200, publishes, no payment transition", async () => {
    mockOrderGetById.mockResolvedValue({
      id: "order_1", fulfillmentStatus: OrderFulfillmentStatus.PENDING, displayId: 7, customerId: "c1",
    });
    mockGetActiveByOrderId.mockResolvedValue({ id: "pay_1", status: PaymentStatus.REFUNDED });

    const app = await buildServer();
    const res = await forceCancel(app);

    expect(res.statusCode).toBe(200);
    expect(mockPaymentTransition).not.toHaveBeenCalled();
    expect(mockPublishNats).toHaveBeenCalledWith("order.canceled", expect.anything());
  });
});
