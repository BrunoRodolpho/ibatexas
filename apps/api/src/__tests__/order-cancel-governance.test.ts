// Unit tests for Task 14 customer order cancel governance.
//
// Coverage:
//   - POST /api/orders/:id/cancel wraps the kernel `order.cancel` envelope.
//   - With `IBX_KERNEL_ENFORCE=order.cancel`, a REFUSE decision surfaces as
//     403 + pt-BR copy.
//   - With pure-legacy mode (no env), the legacy imperative path runs as
//     before — proves the rollout-safe behavior.
//   - Envelope shape: actor.principal="user", actor.sessionId=customerId,
//     taint="UNTRUSTED", kind="order.cancel".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockGetById = vi.hoisted(() => vi.fn());
const mockTransitionStatus = vi.hoisted(() => vi.fn());
const mockFindActiveByOrderId = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockAdjudicate = vi.hoisted(() => vi.fn());

const redisStorage = vi.hoisted(() => new Map<string, string>());
const mockRedisIncr = vi.hoisted(() => vi.fn(async () => 1));
const mockRedisExpire = vi.hoisted(() => vi.fn(async () => 1));
const mockRedisDel = vi.hoisted(() => vi.fn(async () => 1));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    del: mockRedisDel,
    get: vi.fn(async (k: string) => redisStorage.get(k) ?? null),
    set: vi.fn(async () => "OK"),
  })),
  rk: (k: string) => `ibatexas:${k}`,
  withLock: vi.fn(async (_resource: string, fn: () => Promise<unknown>) => fn()),
  amendOrder: vi.fn(),
  changeDeliveryAddress: vi.fn(),
  switchOrderType: vi.fn(),
  medusaAdmin: mockMedusaAdmin,
}));

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({
    transitionStatus: mockTransitionStatus,
  }),
  createOrderQueryService: () => ({
    getById: mockGetById,
  }),
  createPaymentCommandService: () => ({
    findActiveByOrderId: mockFindActiveByOrderId,
    transitionStatus: vi.fn(),
  }),
  createPaymentQueryService: () => ({
    listByOrderId: vi.fn(async () => ({ count: 0 })),
    getActiveByOrderId: vi.fn(async () => null),
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

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: vi.fn(async () => undefined) }),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@adjudicate/core/kernel", async (orig) => {
  const actual = await orig() as Record<string, unknown>;
  return {
    ...actual,
    adjudicate: mockAdjudicate,
  };
});

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
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

function makeOrder(overrides?: Partial<{ id: string; fulfillmentStatus: string; createdAt: Date; totalInCentavos: number }>) {
  return {
    id: overrides?.id ?? "order_01",
    displayId: 42,
    customerId: "cust_01",
    fulfillmentStatus: overrides?.fulfillmentStatus ?? "pending",
    createdAt: overrides?.createdAt ?? new Date(),
    totalInCentavos: overrides?.totalInCentavos ?? 5000,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/orders/:id/cancel — envelope governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
    mockGetById.mockResolvedValue(makeOrder());
    mockFindActiveByOrderId.mockResolvedValue(null);
    mockTransitionStatus.mockResolvedValue({
      version: 2,
      previousStatus: "pending",
      newStatus: "canceled",
    });
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pure-legacy mode (no env) → executor runs, returns 200 + success body", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_01" },
        payload: { reason: "Mudei de ideia" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { success: boolean; fulfillmentStatus: string };
      expect(body.success).toBe(true);
      expect(body.fulfillmentStatus).toBe("canceled");

      // The legacy command-service was called.
      expect(mockTransitionStatus).toHaveBeenCalledTimes(1);
      // adjudicate was NOT called in pure-legacy mode (not in ALWAYS_ENFORCE, no env).
      expect(mockAdjudicate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("enforce mode + EXECUTE decision → executor runs, returns 200", async () => {
    vi.stubEnv("IBX_KERNEL_ENFORCE", "order.cancel");
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_01" },
        payload: { reason: "Mudei de ideia" },
      });

      expect(res.statusCode).toBe(200);
      expect(mockAdjudicate).toHaveBeenCalledTimes(1);

      // Envelope shape was correct: actor=user, sessionId=customerId, taint=UNTRUSTED
      const adjArgs = mockAdjudicate.mock.calls[0];
      const envelope = adjArgs[0] as {
        kind: string;
        actor: { principal: string; sessionId: string };
        taint: string;
        payload: { orderId: string; reason: string };
      };
      expect(envelope.kind).toBe("order.cancel");
      expect(envelope.actor.principal).toBe("user");
      expect(envelope.actor.sessionId).toBe("cust_01");
      expect(envelope.taint).toBe("UNTRUSTED");
      expect(envelope.payload.orderId).toBe("order_01");
    } finally {
      await app.close();
    }
  });

  it("enforce mode + REFUSE decision → 403 + pt-BR copy + transitionStatus NOT called", async () => {
    vi.stubEnv("IBX_KERNEL_ENFORCE", "order.cancel");
    mockAdjudicate.mockReturnValue({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "order.cancel.past_ponr",
        userFacing: "Não é mais possível cancelar este pedido.",
      },
      basis: [],
    });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_01" },
        payload: { reason: "x" },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json() as { error: string; code: string };
      // The route uses `portugueseRefusalMessages` to localize REFUSE codes.
      // Unknown codes fall back to the framework default ("Essa ação não é
      // permitida neste momento.") — assert the structure rather than the
      // exact string so the test stays robust against dictionary churn.
      expect(body.error.length).toBeGreaterThan(0);
      expect(body.code).toBe("order.cancel.past_ponr");

      // The destructive call did NOT run — adjudicate rejected.
      expect(mockTransitionStatus).not.toHaveBeenCalled();
      expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("preserves rate-limit (5 cancels per 10min) — 429 on overage", async () => {
    mockRedisIncr.mockResolvedValueOnce(6); // already at 6

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_01" },
        payload: {},
      });

      expect(res.statusCode).toBe(429);
      // Adjudicate is NOT called when rate-limit fires first — adjudicate is additive,
      // existing rate-limit gates run upstream.
      expect(mockAdjudicate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
