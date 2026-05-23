// Unit tests for Task 13 admin force-* governance flow.
//
// Coverage:
//   - admin-confirmation-store (Lua atomic consume, single-use, expiry semantics)
//   - POST /api/admin/orders/:id/force-cancel (step 1 + step 2)
//   - POST /api/admin/orders/:id/waive (step 1 + step 2)
//   - POST /api/admin/orders/:id/payment/refund
//       * direct execute below R$ 200 threshold
//       * two-step receipt protocol >= R$ 200
//   - PATCH /api/admin/orders/:id/payment/status (two-step receipt protocol)
//
// Assertions for each route:
//   - Step 1 returns 202 + confirmationId + prompt for above-threshold ops.
//   - Step 2 with valid receipt dispatches `*FromEnvelope`.
//   - Step 2 with unknown receipt returns 410 Gone.
//   - Step 2 replay (consumed once) returns 410.
//   - Direct mutation below threshold (refund only) returns 200 immediately.
//   - REFUSE from kernel returns 403 with the pt-BR refusal text.
//
// Bypass-detection: every mutation path goes through
// `transitionStatusFromEnvelope` — the legacy bare-arg `transitionStatus`
// is NOT called for force-cancel / waive / refund / force-status.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockGetById = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());
const mockTransitionStatus = vi.hoisted(() => vi.fn());
const mockTransitionStatusFromEnvelopeOrder = vi.hoisted(() => vi.fn());
const mockTransitionStatusFromEnvelopePayment = vi.hoisted(() => vi.fn());
const mockTransitionStatusLegacyPayment = vi.hoisted(() => vi.fn());
const mockPaymentUpdate = vi.hoisted(() => vi.fn());
const mockOrderEventLogAppend = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());

// Confirmation store — module-scoped fake. Tests reach into it to
// inspect / pre-seed pending actions.
const confirmationStorage = vi.hoisted(() => new Map<string, string>());

const mockRedisSet = vi.hoisted(() =>
  vi.fn(async (key: string, value: string) => {
    confirmationStorage.set(key, value);
    return "OK";
  }),
);
const mockRedisEval = vi.hoisted(() =>
  vi.fn(async (_script: string, opts: { keys: string[] }) => {
    const key = opts.keys[0];
    const value = confirmationStorage.get(key);
    if (value === undefined) return null;
    confirmationStorage.delete(key);
    return value;
  }),
);

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    set: mockRedisSet,
    eval: mockRedisEval,
    get: vi.fn(),
    del: vi.fn(),
  })),
  rk: (k: string) => `ibatexas:${k}`,
  reaisToCentavos: (r: number) => Math.round(r * 100),
  medusaAdmin: vi.fn(async () => ({ orders: [], count: 0 })),
  medusaStore: vi.fn(),
  withLock: vi.fn(async (_resource: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({
    transitionStatus: mockTransitionStatus,
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelopeOrder,
  }),
  createOrderQueryService: () => ({
    getById: mockGetById,
  }),
  createPaymentCommandService: () => ({
    transitionStatus: mockTransitionStatusLegacyPayment,
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelopePayment,
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: mockGetActiveByOrderId,
  }),
  createOrderEventLogService: () => ({
    append: mockOrderEventLogAppend,
  }),
  prisma: {
    orderNote: {
      create: vi.fn(async () => ({
        id: "note_01",
        content: "x",
        createdAt: new Date(),
      })),
      findMany: vi.fn(async () => []),
    },
    payment: {
      update: mockPaymentUpdate,
    },
  },
}));

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: vi.fn(async () => undefined) }),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

async function buildOrderActionsServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminOrderActionRoutes } = await import("../order-actions.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Inject staff identity for the requireManager / requireStaff middleware.
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(adminOrderActionRoutes);
  await app.ready();
  return app;
}

async function buildPaymentsServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminPaymentRoutes } = await import("../payments.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(adminPaymentRoutes);
  await app.ready();
  return app;
}

function executeDecision(extra?: Partial<{ version: number; previousStatus: string; newStatus: string }>) {
  return {
    decision: { kind: "EXECUTE" as const, basis: [] },
    result: {
      version: extra?.version ?? 2,
      previousStatus: extra?.previousStatus ?? "pending",
      newStatus: extra?.newStatus ?? "canceled",
    },
  };
}

function refuseDecision(userFacing: string) {
  return {
    decision: {
      kind: "REFUSE" as const,
      refusal: {
        layer: "BUSINESS_RULE",
        code: "test.refuse",
        userFacing,
      },
      basis: [],
    },
  };
}

function makeOrder(overrides?: Partial<{ id: string; fulfillmentStatus: string; displayId: number }>) {
  return {
    id: overrides?.id ?? "order_01",
    displayId: overrides?.displayId ?? 42,
    customerId: "cust_01",
    fulfillmentStatus: overrides?.fulfillmentStatus ?? "pending",
  };
}

function makePayment(overrides?: Partial<{
  id: string;
  status: string;
  method: string;
  amountInCentavos: number;
  refundedAmountCentavos: number;
}>) {
  return {
    id: overrides?.id ?? "pay_01",
    status: overrides?.status ?? "paid",
    method: overrides?.method ?? "card",
    amountInCentavos: overrides?.amountInCentavos ?? 50_000,
    refundedAmountCentavos: overrides?.refundedAmountCentavos ?? 0,
    version: 1,
  };
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const OWNER: StaffContext = { staffId: "staff_own_01", staffRole: "OWNER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

// ── Tests: force-cancel ───────────────────────────────────────────────────

describe("POST /api/admin/orders/:id/force-cancel — two-step receipt protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmationStorage.clear();
    mockGetById.mockResolvedValue(makeOrder());
    mockGetActiveByOrderId.mockResolvedValue(null);
    mockOrderEventLogAppend.mockResolvedValue(undefined);
    mockTransitionStatusFromEnvelopeOrder.mockResolvedValue(
      executeDecision({ newStatus: "canceled" }),
    );
    mockTransitionStatusFromEnvelopePayment.mockResolvedValue(
      executeDecision({ newStatus: "pay_canceled" }),
    );
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  it("step 1 returns 202 with confirmationId + prompt + ttlSeconds", async () => {
    const server = await buildOrderActionsServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel",
        payload: { reason: "test" },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json() as {
        confirmationId: string;
        prompt: string;
        ttlSeconds: number;
        kind: string;
      };
      expect(body.confirmationId.length).toBeGreaterThan(8);
      expect(body.prompt).toMatch(/Cancelamento forçado/i);
      expect(body.ttlSeconds).toBe(600);
      expect(body.kind).toBe("order.status.transition");

      // The mutation MUST NOT have run at step 1.
      expect(mockTransitionStatusFromEnvelopeOrder).not.toHaveBeenCalled();
      expect(mockTransitionStatus).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("step 1 rejects ATTENDANT (role gate preserved)", async () => {
    const server = await buildOrderActionsServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel",
        payload: { reason: "x" },
      });
      // requireManager rejects ATTENDANT with 403.
      expect(res.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("step 1 returns 422 when order already in terminal state", async () => {
    mockGetById.mockResolvedValue(makeOrder({ fulfillmentStatus: "delivered" }));
    const server = await buildOrderActionsServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel",
        payload: {},
      });
      expect(res.statusCode).toBe(422);
    } finally {
      await server.close();
    }
  });

  it("step 2 with valid receipt dispatches transitionStatusFromEnvelope", async () => {
    const server = await buildOrderActionsServer(MANAGER);
    try {
      const step1 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel",
        payload: { reason: "fraud" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel/confirm",
        payload: { confirmationId },
      });

      expect(step2.statusCode).toBe(200);
      const body = step2.json() as { success: boolean; confirmationId: string };
      expect(body.success).toBe(true);
      expect(body.confirmationId).toBe(confirmationId);

      // The envelope-path was called exactly once.
      expect(mockTransitionStatusFromEnvelopeOrder).toHaveBeenCalledTimes(1);
      const envelope = mockTransitionStatusFromEnvelopeOrder.mock.calls[0][0] as {
        kind: string;
        actor: { principal: string; sessionId: string };
        taint: string;
        payload: { orderId: string; newStatus: string; actor: string };
      };
      expect(envelope.kind).toBe("order.status.transition");
      expect(envelope.actor.principal).toBe("user");
      expect(envelope.actor.sessionId).toBe("admin:staff_mgr_01");
      expect(envelope.taint).toBe("TRUSTED");
      expect(envelope.payload.orderId).toBe("order_01");
      expect(envelope.payload.newStatus).toBe("canceled");
      expect(envelope.payload.actor).toBe("admin");

      // Legacy bare-arg path must NOT have been called.
      expect(mockTransitionStatus).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("step 2 with unknown receipt returns 410", async () => {
    const server = await buildOrderActionsServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel/confirm",
        payload: { confirmationId: "deadbeef-bogus-id" },
      });
      expect(res.statusCode).toBe(410);
      expect(mockTransitionStatusFromEnvelopeOrder).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("step 2 replay (same confirmationId twice) returns 410 on second attempt", async () => {
    const server = await buildOrderActionsServer(MANAGER);
    try {
      const step1 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel",
        payload: { reason: "x" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      const first = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel/confirm",
        payload: { confirmationId },
      });
      expect(first.statusCode).toBe(200);

      const second = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel/confirm",
        payload: { confirmationId },
      });
      expect(second.statusCode).toBe(410);

      expect(mockTransitionStatusFromEnvelopeOrder).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("step 2 surfaces kernel REFUSE as 403 with pt-BR text", async () => {
    mockTransitionStatusFromEnvelopeOrder.mockResolvedValueOnce(
      refuseDecision("Pedido não encontrado."),
    );

    const server = await buildOrderActionsServer(MANAGER);
    try {
      const step1 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel",
        payload: {},
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel/confirm",
        payload: { confirmationId },
      });
      expect(step2.statusCode).toBe(403);
      const body = step2.json() as { error: string };
      expect(body.error).toBe("Pedido não encontrado.");
    } finally {
      await server.close();
    }
  });

  it("step 2 with mismatching orderId rejects with 410", async () => {
    const server = await buildOrderActionsServer(MANAGER);
    try {
      // Create receipt for order_01, then try to consume against order_02.
      const step1 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel",
        payload: { reason: "x" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      mockGetById.mockResolvedValue(makeOrder({ id: "order_02" }));
      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_02/force-cancel/confirm",
        payload: { confirmationId },
      });
      expect(step2.statusCode).toBe(410);
    } finally {
      await server.close();
    }
  });
});

// ── Tests: waive ──────────────────────────────────────────────────────────

describe("POST /api/admin/orders/:id/waive — two-step receipt protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmationStorage.clear();
    mockGetById.mockResolvedValue(makeOrder());
    mockGetActiveByOrderId.mockResolvedValue(makePayment({ status: "paid" }));
    mockOrderEventLogAppend.mockResolvedValue(undefined);
    mockTransitionStatusFromEnvelopePayment.mockResolvedValue(
      executeDecision({ newStatus: "waived" }),
    );
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  it("step 1 rejects MANAGER (OWNER-only gate)", async () => {
    const server = await buildOrderActionsServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/waive",
        payload: { reason: "test" },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: string }).error).toMatch(/proprietário/i);
    } finally {
      await server.close();
    }
  });

  it("step 1 returns 202 + confirmationId for OWNER", async () => {
    const server = await buildOrderActionsServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/waive",
        payload: { reason: "courtesy" },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { confirmationId: string; kind: string };
      expect(body.kind).toBe("payment.status.transition");
      expect(mockTransitionStatusFromEnvelopePayment).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("step 2 dispatches transitionStatusFromEnvelope with TRUSTED+user", async () => {
    const server = await buildOrderActionsServer(OWNER);
    try {
      const step1 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/waive",
        payload: { reason: "courtesy" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/waive/confirm",
        payload: { confirmationId },
      });
      expect(step2.statusCode).toBe(200);

      expect(mockTransitionStatusFromEnvelopePayment).toHaveBeenCalledTimes(1);
      const env = mockTransitionStatusFromEnvelopePayment.mock.calls[0][0] as {
        kind: string;
        payload: { newStatus: string; paymentId: string };
        taint: string;
      };
      expect(env.kind).toBe("payment.status.transition");
      expect(env.payload.newStatus).toBe("waived");
      expect(env.payload.paymentId).toBe("pay_01");
      expect(env.taint).toBe("TRUSTED");

      expect(mockTransitionStatusLegacyPayment).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("step 2 with consumed receipt returns 410 on replay", async () => {
    const server = await buildOrderActionsServer(OWNER);
    try {
      const step1 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/waive",
        payload: { reason: "courtesy" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      const first = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/waive/confirm",
        payload: { confirmationId },
      });
      expect(first.statusCode).toBe(200);

      const second = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/waive/confirm",
        payload: { confirmationId },
      });
      expect(second.statusCode).toBe(410);
    } finally {
      await server.close();
    }
  });
});

// ── Tests: refund ─────────────────────────────────────────────────────────

describe("POST /api/admin/orders/:id/payment/refund — threshold-driven flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmationStorage.clear();
    mockGetById.mockResolvedValue(makeOrder());
    mockGetActiveByOrderId.mockResolvedValue(
      makePayment({ status: "paid", amountInCentavos: 50_000 }),
    );
    mockOrderEventLogAppend.mockResolvedValue(undefined);
    mockTransitionStatusFromEnvelopePayment.mockResolvedValue(
      executeDecision({ newStatus: "refunded" }),
    );
    mockPaymentUpdate.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  it("direct execute below R$ 200 threshold returns 200 immediately", async () => {
    const server = await buildPaymentsServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 19_999, reason: "small refund" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { refundedAmount: number; success: boolean };
      expect(body.success).toBe(true);
      expect(body.refundedAmount).toBe(19_999);

      expect(mockTransitionStatusFromEnvelopePayment).toHaveBeenCalledTimes(1);
      const env = mockTransitionStatusFromEnvelopePayment.mock.calls[0][0] as {
        kind: string;
      };
      expect(env.kind).toBe("payment.status.transition");
      expect(mockPaymentUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("step 1 returns 202 for refund >= R$ 200", async () => {
    const server = await buildPaymentsServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 25_000, reason: "fraud" },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as {
        confirmationId: string;
        refundAmountCentavos: number;
      };
      expect(body.refundAmountCentavos).toBe(25_000);

      expect(mockTransitionStatusFromEnvelopePayment).not.toHaveBeenCalled();
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("step 2 dispatches transitionStatusFromEnvelope and updates payment", async () => {
    const server = await buildPaymentsServer(MANAGER);
    try {
      const step1 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 25_000, reason: "fraud" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund/confirm",
        payload: { confirmationId },
      });
      expect(step2.statusCode).toBe(200);

      expect(mockTransitionStatusFromEnvelopePayment).toHaveBeenCalledTimes(1);
      expect(mockPaymentUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("step 2 replay returns 410 on second attempt", async () => {
    const server = await buildPaymentsServer(MANAGER);
    try {
      const step1 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 25_000, reason: "fraud" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      const first = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund/confirm",
        payload: { confirmationId },
      });
      expect(first.statusCode).toBe(200);

      const second = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund/confirm",
        payload: { confirmationId },
      });
      expect(second.statusCode).toBe(410);

      expect(mockTransitionStatusFromEnvelopePayment).toHaveBeenCalledTimes(1);
      expect(mockPaymentUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("refund REFUSE from kernel returns 403", async () => {
    mockTransitionStatusFromEnvelopePayment.mockResolvedValueOnce(
      refuseDecision("Pagamento já está em estado terminal."),
    );

    const server = await buildPaymentsServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 5_000, reason: "test" },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json() as { error: string };
      expect(body.error).toMatch(/Pagamento já está em estado terminal/);
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

// ── Tests: force-status ───────────────────────────────────────────────────

describe("PATCH /api/admin/orders/:id/payment/status — two-step force-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmationStorage.clear();
    mockGetById.mockResolvedValue(makeOrder());
    mockGetActiveByOrderId.mockResolvedValue(makePayment());
    mockOrderEventLogAppend.mockResolvedValue(undefined);
    mockTransitionStatusFromEnvelopePayment.mockResolvedValue(
      executeDecision({ newStatus: "disputed" }),
    );
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  it("step 1 rejects MANAGER (OWNER-only)", async () => {
    const server = await buildPaymentsServer(MANAGER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01/payment/status",
        payload: { status: "disputed", reason: "test" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("step 1 returns 202 for OWNER (always requires confirmation)", async () => {
    const server = await buildPaymentsServer(OWNER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01/payment/status",
        payload: { status: "disputed", reason: "investigação" },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as {
        confirmationId: string;
        targetStatus: string;
      };
      expect(body.targetStatus).toBe("disputed");
      expect(mockTransitionStatusFromEnvelopePayment).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("step 2 dispatches transitionStatusFromEnvelope and returns 200", async () => {
    const server = await buildPaymentsServer(OWNER);
    try {
      const step1 = await server.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01/payment/status",
        payload: { status: "disputed", reason: "investigação" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/status/confirm",
        payload: { confirmationId },
      });
      expect(step2.statusCode).toBe(200);

      expect(mockTransitionStatusFromEnvelopePayment).toHaveBeenCalledTimes(1);
      const env = mockTransitionStatusFromEnvelopePayment.mock.calls[0][0] as {
        payload: { newStatus: string };
        actor: { principal: string };
      };
      expect(env.payload.newStatus).toBe("disputed");
      expect(env.actor.principal).toBe("user");
    } finally {
      await server.close();
    }
  });

  it("step 2 with unknown receipt returns 410", async () => {
    const server = await buildPaymentsServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/status/confirm",
        payload: { confirmationId: "bogus-id" },
      });
      expect(res.statusCode).toBe(410);
    } finally {
      await server.close();
    }
  });

  it("step 2 REFUSE from kernel returns 403", async () => {
    mockTransitionStatusFromEnvelopePayment.mockResolvedValueOnce(
      refuseDecision("Pagamento já está em estado final."),
    );

    const server = await buildPaymentsServer(OWNER);
    try {
      const step1 = await server.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01/payment/status",
        payload: { status: "paid", reason: "test" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/status/confirm",
        payload: { confirmationId },
      });
      expect(step2.statusCode).toBe(403);
      const body = step2.json() as { error: string };
      expect(body.error).toMatch(/estado final/);
    } finally {
      await server.close();
    }
  });
});

// ── Tests: confirm-cash (envelope migration, no confirmation flow) ────────

describe("POST /api/admin/orders/:id/payment/confirm-cash — envelope migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmationStorage.clear();
    mockGetById.mockResolvedValue(makeOrder());
    mockGetActiveByOrderId.mockResolvedValue(
      makePayment({ status: "cash_pending", method: "cash" }),
    );
    mockTransitionStatusFromEnvelopePayment.mockResolvedValue(
      executeDecision({ newStatus: "paid" }),
    );
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  it("dispatches transitionStatusFromEnvelope and returns 200 (no confirmation step)", async () => {
    const server = await buildPaymentsServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/confirm-cash",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(mockTransitionStatusFromEnvelopePayment).toHaveBeenCalledTimes(1);
      expect(mockTransitionStatusLegacyPayment).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

// ── Tests: admin-confirmation-store unit ──────────────────────────────────

describe("AdminConfirmationStore — Redis-backed atomic single-use store", () => {
  beforeEach(() => {
    confirmationStorage.clear();
    mockRedisSet.mockClear();
    mockRedisEval.mockClear();
  });

  it("create stores a pending action and returns confirmationId + ttl", async () => {
    const { createAdminConfirmationStore, ADMIN_CONFIRMATION_TTL_SECONDS } =
      await import("../admin-confirmation-store.js");
    const store = createAdminConfirmationStore();
    const { confirmationId, ttlSeconds } = await store.create({
      kind: "order.status.transition",
      payload: { orderId: "order_01", newStatus: "canceled", actor: "admin" },
      nonce: "n-1",
      staffId: "staff_01",
      staffRole: "MANAGER",
      actorPrincipal: "user",
      requestorIp: "127.0.0.1",
      prompt: "test",
      route: "force-cancel",
      createdAt: new Date().toISOString(),
      orderId: "order_01",
    });
    expect(confirmationId.length).toBeGreaterThan(8);
    expect(ttlSeconds).toBe(ADMIN_CONFIRMATION_TTL_SECONDS);
    expect(mockRedisSet).toHaveBeenCalledWith(
      `ibatexas:admin:confirmation:${confirmationId}`,
      expect.any(String),
      { EX: 600 },
    );
  });

  it("consume returns the pending action and removes it atomically (single-use)", async () => {
    const { createAdminConfirmationStore } = await import(
      "../admin-confirmation-store.js"
    );
    const store = createAdminConfirmationStore();
    const { confirmationId } = await store.create({
      kind: "payment.status.transition",
      payload: { paymentId: "pay_01" },
      nonce: "n-2",
      staffId: null,
      staffRole: null,
      actorPrincipal: "system",
      requestorIp: null,
      prompt: "test",
      route: "force-status",
      createdAt: new Date().toISOString(),
      orderId: "order_01",
    });
    const first = await store.consume(confirmationId);
    expect(first).not.toBeNull();
    expect(first?.kind).toBe("payment.status.transition");

    const second = await store.consume(confirmationId);
    expect(second).toBeNull();
  });

  it("consume returns null for unknown id", async () => {
    const { createAdminConfirmationStore } = await import(
      "../admin-confirmation-store.js"
    );
    const store = createAdminConfirmationStore();
    expect(await store.consume("nope")).toBeNull();
    expect(await store.consume("")).toBeNull();
  });
});
