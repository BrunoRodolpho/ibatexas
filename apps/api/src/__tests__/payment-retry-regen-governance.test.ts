// W3 P0-2 — payment/retry + payment/regenerate-pix governance tests.
//
// Coverage:
//   - POST /api/orders/:id/payment/retry routes through
//     paymentCmdSvc.transitionStatusFromEnvelope + createFromEnvelope.
//     The legacy bare-arg `transitionStatus` and `create` are NOT called.
//   - POST /api/orders/:id/payment/regenerate-pix routes through the
//     same envelope-typed surface AND adjudicates the regeneration
//     counter bump via `bumpRegenerationCountFromEnvelope`. The direct
//     `prisma.payment.update` for `regenerationCount` is gone.
//   - REFUSE on the cancel step is tolerated (already terminal).
//   - REFUSE on create / bump surfaces a pt-BR refusal.
//   - Regeneration cap exceeded → 429 + pt-BR refusal (REGEN_CAP).
//
// Bypass-detection: every mutation is reachable only via
// `*FromEnvelope`. The route's legacy three-bypass chain (bare-arg
// transitionStatus + create + prisma.payment.update) is gone.

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
const mockListByOrderId = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());

const mockTransitionStatusLegacy = vi.hoisted(() => vi.fn());
const mockCreateLegacy = vi.hoisted(() => vi.fn());
const mockTransitionStatusFromEnvelope = vi.hoisted(() => vi.fn());
const mockCreateFromEnvelope = vi.hoisted(() => vi.fn());
const mockBumpRegenerationCountFromEnvelope = vi.hoisted(() => vi.fn());
const mockPaymentUpdate = vi.hoisted(() => vi.fn());

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
  }),
  createOrderQueryService: () => ({
    getById: mockGetById,
  }),
  createPaymentCommandService: () => ({
    transitionStatus: mockTransitionStatusLegacy,
    create: mockCreateLegacy,
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelope,
    createFromEnvelope: mockCreateFromEnvelope,
    bumpRegenerationCountFromEnvelope: mockBumpRegenerationCountFromEnvelope,
    findActiveByOrderId: vi.fn(async () => null),
  }),
  createPaymentQueryService: () => ({
    listByOrderId: mockListByOrderId,
    getActiveByOrderId: mockGetActiveByOrderId,
  }),
  prisma: {
    orderNote: { create: vi.fn(), findMany: vi.fn(async () => []) },
    payment: { update: mockPaymentUpdate },
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

function makeOrder(
  overrides?: Partial<{ id: string; fulfillmentStatus: string; customerId: string }>,
) {
  return {
    id: overrides?.id ?? "order_01",
    displayId: 42,
    customerId: overrides?.customerId ?? "cust_01",
    fulfillmentStatus: overrides?.fulfillmentStatus ?? "pending",
    createdAt: new Date(),
    totalInCentavos: 50_000,
  };
}

function makePayment(
  overrides?: Partial<{
    id: string;
    status: string;
    method: string;
    regenerationCount: number;
  }>,
) {
  return {
    id: overrides?.id ?? "pay_01",
    method: overrides?.method ?? "pix",
    status: overrides?.status ?? "payment_expired",
    amountInCentavos: 50_000,
    version: 1,
    regenerationCount: overrides?.regenerationCount ?? 0,
    pixExpiresAt: new Date(Date.now() - 60_000),
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

// ── Tests: payment/retry ──────────────────────────────────────────────────

describe("POST /api/orders/:id/payment/retry — W3 P0-2 envelope path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(makeOrder());
    mockListByOrderId.mockResolvedValue({ count: 1 });
    mockGetActiveByOrderId.mockResolvedValue(
      makePayment({ status: "payment_failed" }),
    );
    mockMedusaAdmin.mockResolvedValue({
      order: { id: "order_01", customer_id: "cust_01" },
    });
    mockTransitionStatusFromEnvelope.mockResolvedValue(
      executeDecision({ version: 2, previousStatus: "payment_failed", newStatus: "canceled" }),
    );
    mockCreateFromEnvelope.mockResolvedValue(
      executeDecision({ id: "pay_02", version: 1 }),
    );
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  it("routes both cancel-old + create-new through *FromEnvelope (no legacy bypass)", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/retry",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { success: boolean; paymentId: string };
      expect(body.success).toBe(true);
      expect(body.paymentId).toBe("pay_02");

      // P0-2: envelope-typed paths called once each.
      expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledTimes(1);
      expect(mockCreateFromEnvelope).toHaveBeenCalledTimes(1);
      const cancelEnv = mockTransitionStatusFromEnvelope.mock.calls[0][0] as {
        kind: string;
        payload: { newStatus: string };
      };
      expect(cancelEnv.kind).toBe("payment.status.transition");
      expect(cancelEnv.payload.newStatus).toBe("canceled");
      const createEnv = mockCreateFromEnvelope.mock.calls[0][0] as {
        kind: string;
        taint: string;
        payload: { method: string; amountInCentavos: number };
      };
      expect(createEnv.kind).toBe("payment.create");
      expect(createEnv.taint).toBe("SYSTEM");
      expect(createEnv.payload.amountInCentavos).toBe(50_000);

      // P0-2: legacy bare-arg paths MUST NOT be called.
      expect(mockTransitionStatusLegacy).not.toHaveBeenCalled();
      expect(mockCreateLegacy).not.toHaveBeenCalled();
      // No direct prisma.payment.update either.
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("tolerates REFUSE on the cancel step (already terminal)", async () => {
    mockTransitionStatusFromEnvelope.mockResolvedValueOnce(
      refuseDecision("Pagamento já está em estado final.", "payment.terminal_state"),
    );
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/retry",
        headers: { "x-customer-id": "cust_01" },
      });
      // The cancel REFUSE is tolerated; create still runs.
      expect(res.statusCode).toBe(200);
      expect(mockCreateFromEnvelope).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  // P1-ERR-PAYSWITCH: retry uses the SAME method, so a genuine create failure
  // means BOTH the create and the compensating re-create (same method) fail →
  // orphaned → an actionable 503 (PAYMENT_RETRY_FAILED), never an opaque 500.
  it("create failure → orphaned 503 (PAYMENT_RETRY_FAILED), not a 500", async () => {
    mockCreateFromEnvelope.mockResolvedValue(
      refuseDecision("Pagamento indisponível no momento.", "payment.unavailable"),
    );
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/retry",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: string; code: string };
      expect(body.code).toBe("PAYMENT_RETRY_FAILED");
      expect(body.error).toMatch(/Tente novamente/);
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ── Tests: payment/regenerate-pix ─────────────────────────────────────────

describe("POST /api/orders/:id/payment/regenerate-pix — W3 P0-2 envelope path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(makeOrder());
    mockGetActiveByOrderId.mockResolvedValue(
      makePayment({ status: "payment_expired", regenerationCount: 1 }),
    );
    mockMedusaAdmin.mockResolvedValue({
      order: { id: "order_01", customer_id: "cust_01" },
    });
    mockTransitionStatusFromEnvelope.mockResolvedValue(
      executeDecision({ version: 2, previousStatus: "payment_expired", newStatus: "canceled" }),
    );
    mockCreateFromEnvelope.mockResolvedValue(
      executeDecision({ id: "pay_02", version: 1 }),
    );
    mockBumpRegenerationCountFromEnvelope.mockResolvedValue(
      executeDecision({ regenerationCount: 2 }),
    );
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  it("routes cancel + create + bump-counter through *FromEnvelope (no legacy bypass)", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/regenerate-pix",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { success: boolean; paymentId: string };
      expect(body.success).toBe(true);
      expect(body.paymentId).toBe("pay_02");

      // P0-2: all three mutations via envelope-typed paths.
      expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledTimes(1);
      expect(mockCreateFromEnvelope).toHaveBeenCalledTimes(1);
      expect(mockBumpRegenerationCountFromEnvelope).toHaveBeenCalledTimes(1);

      const bumpEnv = mockBumpRegenerationCountFromEnvelope.mock.calls[0][0] as {
        kind: string;
        taint: string;
        payload: { paymentId: string };
      };
      expect(bumpEnv.kind).toBe("payment.regeneration.count.increment");
      expect(bumpEnv.taint).toBe("SYSTEM");
      expect(bumpEnv.payload.paymentId).toBe("pay_02");

      // No legacy bare-arg paths.
      expect(mockTransitionStatusLegacy).not.toHaveBeenCalled();
      expect(mockCreateLegacy).not.toHaveBeenCalled();
      // Direct prisma.payment.update for regenerationCount is gone.
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("REGEN_CAP refusal: bump REFUSE → 429 + pt-BR refusal", async () => {
    mockBumpRegenerationCountFromEnvelope.mockResolvedValueOnce(
      refuseDecision(
        "Limite de regenerações para este pagamento atingido.",
        "regeneration.cap_exceeded",
      ),
    );
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/regenerate-pix",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(429);
      const body = res.json() as { error: string; code: string };
      expect(body.error).toMatch(/Limite de regenerações/);
      expect(body.code).toBe("REGEN_CAP");
    } finally {
      await app.close();
    }
  });

  it("returns 422 when payment is not in payment_expired state", async () => {
    mockGetActiveByOrderId.mockResolvedValue(
      makePayment({ status: "paid" }),
    );
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/payment/regenerate-pix",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(422);
      // The envelope paths must NOT have been called when the upstream
      // state check rejects.
      expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled();
      expect(mockCreateFromEnvelope).not.toHaveBeenCalled();
      expect(mockBumpRegenerationCountFromEnvelope).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
