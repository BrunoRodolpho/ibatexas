// Regression tests for P1-ERR-PAYSWITCH — compensating cancel→create on the
// payment method-switch / retry / regenerate-pix paths.
//
// The bug: inside the lock the OLD payment is canceled, then create() makes the
// replacement; a create() failure left the order with NO active payment and an
// opaque 500. The fix re-creates an active payment with the ORIGINAL method on
// create() failure (compensation), and returns an actionable error (not a 500)
// only if that compensating create ALSO fails.
//
// All heavy deps mocked so the route collects without the @ibatexas/domain chain.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { FastifyRequest, FastifyReply } from "fastify";
import { PaymentStatus } from "@ibatexas/types";
import { orderActionRoutes } from "../routes/order-actions.js";

const mockPaymentTransition = vi.hoisted(() => vi.fn());
const mockPaymentCreate = vi.hoisted(() => vi.fn());
const mockFindActiveByOrderId = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());
const mockListByOrderId = vi.hoisted(() => vi.fn());
const mockOrderGetById = vi.hoisted(() => vi.fn());
const mockPaymentUpdate = vi.hoisted(() => vi.fn());
const mockPublishNats = vi.hoisted(() => vi.fn());
const createCalls = vi.hoisted(() => [] as Array<{ orderId: string; method: string; amountInCentavos: number }>);

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({ create: vi.fn(), transitionStatus: vi.fn() }),
  createOrderQueryService: () => ({ getById: mockOrderGetById }),
  createPaymentCommandService: () => ({
    transitionStatus: mockPaymentTransition,
    create: mockPaymentCreate,
    findActiveByOrderId: mockFindActiveByOrderId,
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: mockGetActiveByOrderId,
    listByOrderId: mockListByOrderId,
  }),
  prisma: { payment: { update: mockPaymentUpdate }, orderNote: {} },
  InvalidTransitionError: class InvalidTransitionError extends Error {},
  getEffectivePonr: () => ({ cancelMinutes: 30 }),
}));

vi.mock("@ibatexas/tools", () => ({
  // Pass-through lock so the compensating sequence runs inline; returns the
  // callback value (truthy result object) on success, mirroring real withLock.
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

describe("P1-ERR-PAYSWITCH — payment replacement compensation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createCalls.length = 0;
    mockOrderGetById.mockResolvedValue({
      id: "order_1",
      customerId: "cust_1",
      fulfillmentStatus: "pending",
      displayId: 1,
    });
    mockPaymentTransition.mockResolvedValue({ version: 2, previousStatus: "x", newStatus: "canceled" });
    mockListByOrderId.mockResolvedValue({ count: 1 });
    mockPaymentUpdate.mockResolvedValue({});
    mockPublishNats.mockResolvedValue(undefined);
    // Record every create() call so we can assert the compensating method.
    mockPaymentCreate.mockImplementation(async (data) => {
      createCalls.push(data);
      return { id: `pay_new_${createCalls.length}`, version: 1 };
    });
  });

  // ── PATCH /payment/method (switch) ────────────────────────────────────────
  describe("switch method", () => {
    function activePixAwaiting() {
      mockGetActiveByOrderId.mockResolvedValue({
        id: "pay_old", method: "pix", status: PaymentStatus.AWAITING_PAYMENT, amountInCentavos: 8900,
      });
    }
    const url = "/api/orders/order_1/payment/method";

    it("happy path: creates new method, publishes method_changed, returns 200", async () => {
      activePixAwaiting();
      const app = await buildServer();
      const res = await app.inject({ method: "PATCH", url, payload: { method: "card" } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true, method: "card" });
      // create() called once, with the NEW method.
      expect(createCalls).toEqual([{ orderId: "order_1", method: "card", amountInCentavos: 8900 }]);
      expect(mockPublishNats).toHaveBeenCalledWith("payment.method_changed", expect.objectContaining({ newMethod: "card" }));
    });

    it("create(newMethod) fails → compensates with ORIGINAL method, returns actionable 503, no method_changed", async () => {
      activePixAwaiting();
      // First create (new method=card) throws; compensating create (pix) succeeds.
      mockPaymentCreate.mockReset();
      mockPaymentCreate
        .mockImplementationOnce(async (data) => { createCalls.push(data); throw new Error("stripe down"); })
        .mockImplementationOnce(async (data) => { createCalls.push(data); return { id: "pay_restored", version: 1 }; });

      const app = await buildServer();
      const res = await app.inject({ method: "PATCH", url, payload: { method: "card" } });

      // Actionable error, not an opaque 500.
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("PAYMENT_SWITCH_FAILED");
      // Original method restored as the active payment (order NOT left payment-less).
      expect(res.json().method).toBe("pix");
      expect(res.json().activePaymentId).toBe("pay_restored");
      // Two creates: failed new-method, then compensating original-method.
      expect(createCalls.map((c) => c.method)).toEqual(["card", "pix"]);
      // Method did NOT change → no event.
      expect(mockPublishNats).not.toHaveBeenCalled();
    });

    it("create + compensation both fail → 503 PAYMENT_SWITCH_FAILED (orphaned), never a 500", async () => {
      activePixAwaiting();
      mockPaymentCreate.mockReset();
      mockPaymentCreate.mockRejectedValue(new Error("db down"));

      const app = await buildServer();
      const res = await app.inject({ method: "PATCH", url, payload: { method: "card" } });

      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("PAYMENT_SWITCH_FAILED");
      expect(mockPublishNats).not.toHaveBeenCalled();
    });
  });

  // ── POST /payment/retry ───────────────────────────────────────────────────
  describe("retry", () => {
    const url = "/api/orders/order_1/payment/retry";
    function failedPix() {
      mockGetActiveByOrderId.mockResolvedValue({
        id: "pay_old", method: "pix", status: PaymentStatus.PAYMENT_FAILED, amountInCentavos: 8900,
      });
    }

    it("create fails once → compensates (same method), returns success not orphaned", async () => {
      failedPix();
      mockPaymentCreate.mockReset();
      mockPaymentCreate
        .mockImplementationOnce(async (data) => { createCalls.push(data); throw new Error("transient"); })
        .mockImplementationOnce(async (data) => { createCalls.push(data); return { id: "pay_retry", version: 1 }; });

      const app = await buildServer();
      const res = await app.inject({ method: "POST", url, payload: {} });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true, paymentId: "pay_retry", method: "pix" });
      expect(createCalls.map((c) => c.method)).toEqual(["pix", "pix"]);
    });

    it("create + compensation both fail → 503 PAYMENT_RETRY_FAILED, not a 500", async () => {
      failedPix();
      mockPaymentCreate.mockReset();
      mockPaymentCreate.mockRejectedValue(new Error("db down"));

      const app = await buildServer();
      const res = await app.inject({ method: "POST", url, payload: {} });

      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("PAYMENT_RETRY_FAILED");
    });
  });

  // ── POST /payment/regenerate-pix ──────────────────────────────────────────
  describe("regenerate-pix", () => {
    const url = "/api/orders/order_1/payment/regenerate-pix";
    function expiredPix() {
      mockGetActiveByOrderId.mockResolvedValue({
        id: "pay_old", method: "pix", status: "payment_expired", amountInCentavos: 8900, regenerationCount: 1,
      });
    }

    it("create fails once → compensates, bumps regenerationCount on the RESTORED payment", async () => {
      expiredPix();
      mockPaymentCreate.mockReset();
      mockPaymentCreate
        .mockImplementationOnce(async (data) => { createCalls.push(data); throw new Error("transient"); })
        .mockImplementationOnce(async (data) => { createCalls.push(data); return { id: "pay_regen", version: 1 }; });

      const app = await buildServer();
      const res = await app.inject({ method: "POST", url, payload: {} });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true, paymentId: "pay_regen" });
      // regenerationCount incremented on whichever payment is now active.
      expect(mockPaymentUpdate).toHaveBeenCalledWith({
        where: { id: "pay_regen" },
        data: { regenerationCount: 2 },
      });
    });

    it("create + compensation both fail → 503 PIX_REGEN_FAILED, no regenerationCount write", async () => {
      expiredPix();
      mockPaymentCreate.mockReset();
      mockPaymentCreate.mockRejectedValue(new Error("db down"));

      const app = await buildServer();
      const res = await app.inject({ method: "POST", url, payload: {} });

      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("PIX_REGEN_FAILED");
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    });
  });
});
