// NEW-P0-X4 — PATCH /api/orders/:id/payment/method envelope migration.
//
// Per deep-audit/MASTER §"NEW-P0-X4": the previous route chained THREE
// bare-arg bypasses (`paymentCmdSvc.transitionStatus` × 2 +
// `paymentCmdSvc.create`). `payment.method.switch` is a registered kind
// in @ibatexas/pack-payments (W5) but the route never wired it.
//
// Coverage:
//   - Successful PATCH routes ALL writes through `*FromEnvelope`.
//   - The cancel + create envelopes carry the right kinds and taint.
//   - Legacy bare-arg `transitionStatus` and `create` are NOT called.
//   - REFUSE from createFromEnvelope surfaces 403 with pt-BR.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockGetById = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());

const mockTransitionStatusLegacy = vi.hoisted(() => vi.fn());
const mockCreateLegacy = vi.hoisted(() => vi.fn());
const mockTransitionStatusFromEnvelope = vi.hoisted(() => vi.fn());
const mockCreateFromEnvelope = vi.hoisted(() => vi.fn());

const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());

const mockRedisIncr = vi.hoisted(() => vi.fn(async () => 1));
const mockRedisExpire = vi.hoisted(() => vi.fn(async () => 1));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    del: vi.fn(),
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
  })),
  rk: (k: string) => `ibatexas:${k}`,
  withLock: vi.fn(async (_r: string, fn: () => Promise<unknown>) => fn()),
  amendOrder: vi.fn(),
  changeDeliveryAddress: vi.fn(),
  switchOrderType: vi.fn(),
  medusaAdmin: mockMedusaAdmin,
}));

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({
    transitionStatus: vi.fn(),
    create: vi.fn(),
  }),
  createOrderQueryService: () => ({
    getById: mockGetById,
  }),
  createPaymentCommandService: () => ({
    transitionStatus: mockTransitionStatusLegacy,
    create: mockCreateLegacy,
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelope,
    createFromEnvelope: mockCreateFromEnvelope,
    findActiveByOrderId: vi.fn(async () => null),
  }),
  createPaymentQueryService: () => ({
    listByOrderId: vi.fn(),
    getActiveByOrderId: mockGetActiveByOrderId,
  }),
  prisma: {
    orderNote: { create: vi.fn(), findMany: vi.fn(async () => []) },
    payment: { update: vi.fn() },
  },
  InvalidTransitionError: class InvalidTransitionError extends Error {
    public readonly from: string;
    public readonly to: string;
    constructor(_orderId: string, from: string, to: string) {
      super(`invalid: ${from} -> ${to}`);
      this.name = "InvalidTransitionError";
      this.from = from;
      this.to = to;
    }
  },
  getEffectivePonr: () => ({ cancelMinutes: 30 }),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (
    request: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void,
  ) => {
    const customerId = request.headers["x-customer-id"] as string | undefined;
    if (!customerId) {
      void reply.code(401).send({ message: "auth required" });
      return;
    }
    request.customerId = customerId;
    done();
  },
}));

// ── Server factory ─────────────────────────────────────────────────────────

async function buildTestServer() {
  const { orderActionRoutes } = await import("../routes/order-actions.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(orderActionRoutes);
  await app.ready();
  return app;
}

function makeOrder() {
  return {
    id: "order_01",
    displayId: 42,
    customerId: "cust_01",
    fulfillmentStatus: "pending",
    createdAt: new Date(),
    totalInCentavos: 50_000,
  };
}

function makePayment(
  overrides?: Partial<{ id: string; status: string; method: string; version: number }>,
) {
  return {
    id: overrides?.id ?? "pay_01",
    method: overrides?.method ?? "pix",
    status: overrides?.status ?? "awaiting_payment",
    amountInCentavos: 50_000,
    version: overrides?.version ?? 1,
    regenerationCount: 0,
    createdAt: new Date(),
  };
}

function executeDecision<T>(result: T) {
  return { decision: { kind: "EXECUTE" as const, basis: [] }, result };
}

function refuseDecision(userFacing: string, code = "test.refuse") {
  return {
    decision: {
      kind: "REFUSE" as const,
      refusal: { kind: "BUSINESS_RULE", code, userFacing },
      basis: [],
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PATCH /api/orders/:id/payment/method — NEW-P0-X4 envelope path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(makeOrder());
    mockGetActiveByOrderId.mockResolvedValue(makePayment({ status: "awaiting_payment", method: "pix" }));
    mockMedusaAdmin.mockResolvedValue({
      order: { id: "order_01", customer_id: "cust_01" },
    });
    mockTransitionStatusFromEnvelope.mockResolvedValue(
      executeDecision({ version: 2, previousStatus: "awaiting_payment", newStatus: "canceled" }),
    );
    mockCreateFromEnvelope.mockResolvedValue(
      executeDecision({ id: "pay_02", version: 1 }),
    );
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  it("routes ALL writes through *FromEnvelope (no legacy bypass)", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/payment/method",
        headers: { "x-customer-id": "cust_01" },
        payload: { method: "cash" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { success: boolean; paymentId: string; method: string };
      expect(body.success).toBe(true);
      expect(body.paymentId).toBe("pay_02");
      expect(body.method).toBe("cash");

      // NEW-P0-X4: envelope-typed paths called.
      // payment.status.transition (cancel-old) called — possibly 2x if
      // switching_method transition is allowed.
      expect(mockTransitionStatusFromEnvelope).toHaveBeenCalled();
      const transitionCalls = mockTransitionStatusFromEnvelope.mock.calls;
      // All cancel envelopes carry kind=payment.status.transition.
      for (const call of transitionCalls) {
        const env = call[0] as { kind: string; taint: string };
        expect(env.kind).toBe("payment.status.transition");
        expect(env.taint).toBe("TRUSTED");
      }

      // payment.create (new payment) called exactly once.
      expect(mockCreateFromEnvelope).toHaveBeenCalledTimes(1);
      const createEnv = mockCreateFromEnvelope.mock.calls[0][0] as {
        kind: string;
        taint: string;
        payload: { method: string; amountInCentavos: number };
      };
      expect(createEnv.kind).toBe("payment.create");
      expect(createEnv.taint).toBe("SYSTEM");
      expect(createEnv.payload.method).toBe("cash");
      expect(createEnv.payload.amountInCentavos).toBe(50_000);

      // NEW-P0-X4: legacy bare-arg paths MUST NOT be called.
      expect(mockTransitionStatusLegacy).not.toHaveBeenCalled();
      expect(mockCreateLegacy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // ── P1-ERR-PAYSWITCH — compensating cancel→create ──────────────────────────
  it("create(newMethod) failure COMPENSATES by restoring the original method (503, original active)", async () => {
    // First create (the new method) fails; the compensating create (original
    // method) succeeds via the beforeEach default → order keeps an active payment.
    mockCreateFromEnvelope.mockResolvedValueOnce(
      refuseDecision("Não foi possível criar pagamento com cartão.", "payment.card_unavailable"),
    );
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/payment/method",
        headers: { "x-customer-id": "cust_01" },
        payload: { method: "card" },
      });
      // Switch failed but the original (pix) method was restored as the active
      // payment — actionable 503, NOT an opaque 500 and NOT an orphaned order.
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: string; code: string; method: string };
      expect(body.code).toBe("PAYMENT_SWITCH_FAILED");
      expect(body.error).toMatch(/continua ativo/);
      expect(body.method).toBe("pix");
      // Two create attempts: the new method (refused) + the compensating original.
      expect(mockCreateFromEnvelope).toHaveBeenCalledTimes(2);
      expect(mockCreateFromEnvelope.mock.calls[0][0].payload.method).toBe("card");
      expect(mockCreateFromEnvelope.mock.calls[1][0].payload.method).toBe("pix");
      // The method did NOT actually change → no method_changed event.
      expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
        "payment.method_changed",
        expect.anything(),
      );
    } finally {
      await app.close();
    }
  });

  it("both new-method and compensation creates failing → orphaned 503 (no 500)", async () => {
    // Every create REFUSEs (new method AND the compensating original).
    mockCreateFromEnvelope.mockResolvedValue(
      refuseDecision("Pagamento indisponível no momento.", "payment.unavailable"),
    );
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/payment/method",
        headers: { "x-customer-id": "cust_01" },
        payload: { method: "card" },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: string; code: string };
      expect(body.code).toBe("PAYMENT_SWITCH_FAILED");
      expect(body.error).toMatch(/Tente novamente/);
      expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
        "payment.method_changed",
        expect.anything(),
      );
    } finally {
      await app.close();
    }
  });

  it("returns 422 when payment status is not switchable", async () => {
    mockGetActiveByOrderId.mockResolvedValue(makePayment({ status: "paid", method: "pix" }));
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/payment/method",
        headers: { "x-customer-id": "cust_01" },
        payload: { method: "cash" },
      });
      expect(res.statusCode).toBe(422);
      // No envelope calls — fast-fail.
      expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled();
      expect(mockCreateFromEnvelope).not.toHaveBeenCalled();
      // No bare-arg calls either.
      expect(mockTransitionStatusLegacy).not.toHaveBeenCalled();
      expect(mockCreateLegacy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 422 when switching to same method", async () => {
    mockGetActiveByOrderId.mockResolvedValue(makePayment({ status: "awaiting_payment", method: "pix" }));
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/payment/method",
        headers: { "x-customer-id": "cust_01" },
        payload: { method: "pix" },
      });
      expect(res.statusCode).toBe(422);
      expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled();
      expect(mockCreateFromEnvelope).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
