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
const mockIssueRefundFromEnvelope = vi.hoisted(() => vi.fn());
const mockBumpRegenerationCountFromEnvelope = vi.hoisted(() => vi.fn());
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

// W3 P1-I — drip cap reads a per-staff-day Redis counter.
const dripBuckets = vi.hoisted(() => new Map<string, number>());
const mockRedisGet = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    if (key.startsWith("ibatexas:refund:daily-total:")) {
      const n = dripBuckets.get(key);
      return n !== undefined ? String(n) : null;
    }
    return null;
  }),
);
const mockRedisIncrBy = vi.hoisted(() =>
  vi.fn(async (key: string, by: number) => {
    const cur = dripBuckets.get(key) ?? 0;
    const next = cur + by;
    dripBuckets.set(key, next);
    return next;
  }),
);
const mockRedisExpire = vi.hoisted(() => vi.fn(async () => 1));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    set: mockRedisSet,
    eval: mockRedisEval,
    get: mockRedisGet,
    del: vi.fn(),
    incrBy: mockRedisIncrBy,
    expire: mockRedisExpire,
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
    issueRefundFromEnvelope: mockIssueRefundFromEnvelope,
    bumpRegenerationCountFromEnvelope: mockBumpRegenerationCountFromEnvelope,
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
  /**
   * P1-H: when the test simulates an API-key path (staffId === null),
   * set the resolved registry role to mimic what the admin guard would
   * attach after a successful `ADMIN_API_KEY_ROLES_JSON` lookup. Used
   * by the "API-key actor uses shared bucket" drip-cap test.
   */
  readonly adminApiKeyRole?: "OWNER" | "MANAGER";
}

async function buildOrderActionsServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminOrderActionRoutes } = await import("../order-actions.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Inject staff identity for the requireManager / requireStaff middleware.
  // P0-5 two-person tests need a per-request override so step 2 can use a
  // different staffId from step 1; honour `x-staff-id` header when present.
  app.addHook("preHandler", async (req) => {
    const overrideStaffId = req.headers["x-staff-id"] as string | undefined;
    const overrideRole = req.headers["x-staff-role"] as
      | StaffContext["staffRole"]
      | undefined;
    const effectiveStaffId = overrideStaffId ?? staff.staffId;
    const effectiveRole = overrideRole ?? staff.staffRole;
    if (effectiveStaffId) {
      (req as unknown as { staffId: string | null }).staffId = effectiveStaffId;
      (req as unknown as { staffRole: string | null }).staffRole = effectiveRole;
    } else if (staff.adminApiKeyRole) {
      // P1-H: simulate the admin guard finding a registry-mapped API key.
      (req as unknown as { adminApiKeyRole: "OWNER" | "MANAGER" }).adminApiKeyRole =
        staff.adminApiKeyRole;
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
    const overrideStaffId = req.headers["x-staff-id"] as string | undefined;
    const overrideRole = req.headers["x-staff-role"] as
      | StaffContext["staffRole"]
      | undefined;
    const effectiveStaffId = overrideStaffId ?? staff.staffId;
    const effectiveRole = overrideRole ?? staff.staffRole;
    if (effectiveStaffId) {
      (req as unknown as { staffId: string | null }).staffId = effectiveStaffId;
      (req as unknown as { staffRole: string | null }).staffRole = effectiveRole;
    } else if (staff.adminApiKeyRole) {
      // P1-H: simulate the admin guard finding a registry-mapped API key.
      (req as unknown as { adminApiKeyRole: "OWNER" | "MANAGER" }).adminApiKeyRole =
        staff.adminApiKeyRole;
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

// P0-5: step 2 of the two-person flow MUST be confirmed by a different
// staff. Step-1 requests use the server's default staff; step-2 requests
// send these headers to identify a *second* operator.
const MANAGER_2_HEADERS = {
  "x-staff-id": "staff_mgr_02",
  "x-staff-role": "MANAGER",
};
const OWNER_2_HEADERS = {
  "x-staff-id": "staff_own_02",
  "x-staff-role": "OWNER",
};

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

      // P0-5: second operator confirms step 2.
      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel/confirm",
        payload: { confirmationId },
        headers: MANAGER_2_HEADERS,
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
      // Step 2 actor identity wins in the executed envelope.
      expect(envelope.actor.sessionId).toBe("admin:staff_mgr_02");
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

  // P0-5: same operator on both steps must be refused.
  it("step 2 by the SAME staff as step 1 is refused (P0-5 same-actor)", async () => {
    const server = await buildOrderActionsServer(MANAGER);
    try {
      const step1 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel",
        payload: { reason: "fraud" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      // NO override header — step 2 uses the same MANAGER identity.
      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel/confirm",
        payload: { confirmationId },
      });

      expect(step2.statusCode).toBe(403);
      const body = step2.json() as { error: string };
      // pt-BR refusal text (CLAUDE.md rule #4).
      expect(body.error).toMatch(/Outro operador/i);

      // The kernel envelope path MUST NOT have fired.
      expect(mockTransitionStatusFromEnvelopeOrder).not.toHaveBeenCalled();

      // Receipt was drained — a retry returns 410 (audit trail visible).
      const replay = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel/confirm",
        payload: { confirmationId },
        headers: MANAGER_2_HEADERS,
      });
      expect(replay.statusCode).toBe(410);
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
        headers: MANAGER_2_HEADERS,
      });
      expect(first.statusCode).toBe(200);

      const second = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/force-cancel/confirm",
        payload: { confirmationId },
        headers: MANAGER_2_HEADERS,
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
        headers: MANAGER_2_HEADERS,
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
        headers: MANAGER_2_HEADERS,
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

      // P0-5: second owner confirms.
      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/waive/confirm",
        payload: { confirmationId },
        headers: OWNER_2_HEADERS,
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
        headers: OWNER_2_HEADERS,
      });
      expect(first.statusCode).toBe(200);

      const second = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/waive/confirm",
        payload: { confirmationId },
        headers: OWNER_2_HEADERS,
      });
      expect(second.statusCode).toBe(410);
    } finally {
      await server.close();
    }
  });

  // P0-5: same owner on both steps must be refused.
  it("waive step 2 by SAME owner as step 1 is refused (P0-5)", async () => {
    const server = await buildOrderActionsServer(OWNER);
    try {
      const step1 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/waive",
        payload: { reason: "courtesy" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      // Same OWNER consumes — must be refused (same actor).
      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/waive/confirm",
        payload: { confirmationId },
      });
      expect(step2.statusCode).toBe(403);
      expect(step2.json().error).toMatch(/Outro operador/i);
      expect(mockTransitionStatusFromEnvelopePayment).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

// ── Tests: refund ─────────────────────────────────────────────────────────

function refundExecuteDecision(overrides?: Partial<{
  version: number;
  refundAmountCentavos: number;
  totalRefundedCentavos: number;
  previousStatus: string;
  newStatus: string;
}>) {
  return {
    decision: { kind: "EXECUTE" as const, basis: [] },
    result: {
      version: overrides?.version ?? 2,
      previousStatus: overrides?.previousStatus ?? "paid",
      newStatus: overrides?.newStatus ?? "refunded",
      refundAmountCentavos: overrides?.refundAmountCentavos ?? 19_999,
      totalRefundedCentavos: overrides?.totalRefundedCentavos ?? 19_999,
    },
  };
}

function refundRequestConfirmationDecision(prompt: string) {
  return {
    decision: {
      kind: "REQUEST_CONFIRMATION" as const,
      prompt,
      basis: [],
    },
  };
}

function refundEscalateDecision(reason: string) {
  return {
    decision: {
      kind: "ESCALATE" as const,
      to: "human" as const,
      reason,
      basis: [],
    },
  };
}

describe("POST /api/admin/orders/:id/payment/refund — threshold-driven flow + W3 P0-1 kernel magnitude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmationStorage.clear();
    mockGetById.mockResolvedValue(makeOrder());
    mockGetActiveByOrderId.mockResolvedValue(
      makePayment({ status: "paid", amountInCentavos: 50_000 }),
    );
    mockOrderEventLogAppend.mockResolvedValue(undefined);
    mockIssueRefundFromEnvelope.mockResolvedValue(
      refundExecuteDecision({ newStatus: "refunded" }),
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

      // W3 P0-1: refund flows through issueRefundFromEnvelope with the
      // magnitude in the payload — kernel sees the amount, not just
      // the status transition.
      expect(mockIssueRefundFromEnvelope).toHaveBeenCalledTimes(1);
      const env = mockIssueRefundFromEnvelope.mock.calls[0][0] as {
        kind: string;
        payload: { refundAmountCentavos: number };
      };
      expect(env.kind).toBe("payment.refund.issue");
      expect(env.payload.refundAmountCentavos).toBe(19_999);
      // The legacy status-transition path MUST NOT have been called.
      expect(mockTransitionStatusFromEnvelopePayment).not.toHaveBeenCalled();
      // The direct prisma.payment.update for refundedAmountCentavos
      // is GONE — it now lives inside issueRefundFromEnvelope's executor.
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
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

      expect(mockIssueRefundFromEnvelope).not.toHaveBeenCalled();
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("step 2 dispatches issueRefundFromEnvelope (kernel-adjudicated magnitude)", async () => {
    mockIssueRefundFromEnvelope.mockResolvedValue(
      refundExecuteDecision({
        newStatus: "refunded",
        refundAmountCentavos: 25_000,
        totalRefundedCentavos: 25_000,
      }),
    );
    const server = await buildPaymentsServer(MANAGER);
    try {
      const step1 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 25_000, reason: "fraud" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      // P0-5: second manager confirms (refund is a money path).
      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund/confirm",
        payload: { confirmationId },
        headers: MANAGER_2_HEADERS,
      });
      expect(step2.statusCode).toBe(200);

      expect(mockIssueRefundFromEnvelope).toHaveBeenCalledTimes(1);
      const env = mockIssueRefundFromEnvelope.mock.calls[0][0] as {
        kind: string;
        payload: {
          refundAmountCentavos: number;
          refundableBalanceCentavos: number;
        };
      };
      expect(env.kind).toBe("payment.refund.issue");
      expect(env.payload.refundAmountCentavos).toBe(25_000);
      expect(env.payload.refundableBalanceCentavos).toBe(50_000);
      // P0-1: no more out-of-band prisma.payment.update.
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("step 2 replay returns 410 on second attempt", async () => {
    mockIssueRefundFromEnvelope.mockResolvedValue(
      refundExecuteDecision({ refundAmountCentavos: 25_000 }),
    );
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
        headers: MANAGER_2_HEADERS,
      });
      expect(first.statusCode).toBe(200);

      const second = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund/confirm",
        payload: { confirmationId },
        headers: MANAGER_2_HEADERS,
      });
      expect(second.statusCode).toBe(410);

      expect(mockIssueRefundFromEnvelope).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  // P0-5: refund step 2 by SAME manager as step 1 is refused.
  it("refund step 2 by SAME manager as step 1 is refused (P0-5)", async () => {
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
      expect(step2.statusCode).toBe(403);
      expect(step2.json().error).toMatch(/Outro operador/i);
      // Money path MUST NOT have been called.
      expect(mockIssueRefundFromEnvelope).not.toHaveBeenCalled();
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("refund REFUSE from kernel returns 403", async () => {
    mockIssueRefundFromEnvelope.mockResolvedValueOnce(
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

  // W3 P0-1 — kernel magnitude ladder
  it("W3 P0-1: kernel REQUEST_CONFIRMATION surfaces as 202 (refund > R$500)", async () => {
    mockIssueRefundFromEnvelope.mockResolvedValueOnce(
      refundRequestConfirmationDecision(
        "Confirmar reembolso de R$ 6,00? Esta ação envia dinheiro de volta ao cliente.",
      ),
    );
    const server = await buildPaymentsServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 600, reason: "x" },
      });
      // Below the route's R$200 threshold → direct-execute branch.
      // The kernel sees the magnitude and returns REQUEST_CONFIRMATION
      // for amounts > R$500. The route surfaces 202 with the kernel's
      // pt-BR prompt.
      expect(res.statusCode).toBe(202);
      const body = res.json() as { code: string; prompt: string };
      expect(body.code).toBe("REQUEST_CONFIRMATION");
      expect(body.prompt).toMatch(/Confirmar reembolso/);
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("W3 P0-1: kernel ESCALATE surfaces as 503 (refund > R$1000)", async () => {
    mockIssueRefundFromEnvelope.mockResolvedValueOnce(
      refundEscalateDecision("refund_above_escalate_threshold"),
    );
    const server = await buildPaymentsServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 1_500, reason: "x" },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { reason: string; error: string };
      expect(body.reason).toBe("refund_above_escalate_threshold");
      expect(body.error).toMatch(/aprovação humana/);
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

// ── Tests: refund drip cap (W3 P1-I) ──────────────────────────────────────

describe("POST /api/admin/orders/:id/payment/refund — W3 P1-I daily drip cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmationStorage.clear();
    dripBuckets.clear();
    mockGetById.mockResolvedValue(makeOrder());
    mockGetActiveByOrderId.mockResolvedValue(
      makePayment({ status: "paid", amountInCentavos: 500_000 }),
    );
    mockOrderEventLogAppend.mockResolvedValue(undefined);
    mockIssueRefundFromEnvelope.mockResolvedValue(
      refundExecuteDecision({
        newStatus: "partially_refunded",
        refundAmountCentavos: 10_000,
        totalRefundedCentavos: 10_000,
      }),
    );
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  it("EXECUTE + increments daily bucket on sub-threshold refund", async () => {
    const server = await buildPaymentsServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 10_000, reason: "small" },
      });
      expect(res.statusCode).toBe(200);
      // The bucket holds R$100 (10000 centavos).
      const bucketKey =
        [...dripBuckets.keys()].find((k) =>
          k.startsWith("ibatexas:refund:daily-total:staff_mgr_01:"),
        ) ?? "";
      expect(dripBuckets.get(bucketKey)).toBe(10_000);
    } finally {
      await server.close();
    }
  });

  it("falls back to two-step receipt when cumulative + this > daily cap (R$2000 default)", async () => {
    // Pre-seed the bucket close to the cap: R$1950 already refunded today.
    const bucketKey = (() => {
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(now.getUTCDate()).padStart(2, "0");
      return `ibatexas:refund:daily-total:staff_mgr_01:${yyyy}-${mm}-${dd}`;
    })();
    dripBuckets.set(bucketKey, 195_000);

    const server = await buildPaymentsServer(MANAGER);
    try {
      // This R$100 refund + existing R$1950 = R$2050 > R$2000 cap.
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 10_000, reason: "drip-cap" },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as {
        confirmationId: string;
        code: string;
        cumulativeTodayCentavos: number;
        dailyCapCentavos: number;
        refundAmountCentavos: number;
      };
      expect(body.code).toBe("REFUND_DRIP_CAP");
      expect(body.cumulativeTodayCentavos).toBe(195_000);
      expect(body.dailyCapCentavos).toBe(200_000);
      expect(body.refundAmountCentavos).toBe(10_000);
      expect(body.confirmationId.length).toBeGreaterThan(8);

      // The refund executor MUST NOT have been called — drip cap held.
      expect(mockIssueRefundFromEnvelope).not.toHaveBeenCalled();
      // The bucket still shows the pre-seeded value (no increment on
      // the drip-cap-deferred branch).
      expect(dripBuckets.get(bucketKey)).toBe(195_000);
    } finally {
      await server.close();
    }
  });

  it("respects REFUND_DAILY_NO_CONFIRM_CAP_CENTAVOS env override", async () => {
    vi.stubEnv("REFUND_DAILY_NO_CONFIRM_CAP_CENTAVOS", "50000"); // R$500
    const bucketKey = (() => {
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(now.getUTCDate()).padStart(2, "0");
      return `ibatexas:refund:daily-total:staff_mgr_01:${yyyy}-${mm}-${dd}`;
    })();
    dripBuckets.set(bucketKey, 45_000); // R$450 already

    const server = await buildPaymentsServer(MANAGER);
    try {
      // R$60 + R$450 = R$510 > R$500 cap → drip cap fires.
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 6_000, reason: "small" },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { code: string; dailyCapCentavos: number };
      expect(body.code).toBe("REFUND_DRIP_CAP");
      expect(body.dailyCapCentavos).toBe(50_000);
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  });

  it("does NOT trigger drip cap when below cap (sum stays under)", async () => {
    const bucketKey = (() => {
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(now.getUTCDate()).padStart(2, "0");
      return `ibatexas:refund:daily-total:staff_mgr_01:${yyyy}-${mm}-${dd}`;
    })();
    dripBuckets.set(bucketKey, 100_000); // R$1000 used today

    const server = await buildPaymentsServer(MANAGER);
    try {
      // R$100 + R$1000 = R$1100 < R$2000 cap → direct execute.
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 10_000, reason: "small" },
      });
      expect(res.statusCode).toBe(200);
      // Bucket bumped to 110_000.
      expect(dripBuckets.get(bucketKey)).toBe(110_000);
    } finally {
      await server.close();
    }
  });

  it("API-key actor uses shared 'api-key' bucket", async () => {
    // When staffId is null (API-key path), the bucket key uses
    // 'api-key' as the actor — so any leaked key shares one cap.
    // P1-H: the API-key path now requires a registry-mapped role on
    // the request (set by the admin guard from ADMIN_API_KEY_ROLES_JSON).
    // We simulate that here with adminApiKeyRole: "MANAGER".
    const apiKeyContext: StaffContext = {
      staffId: null,
      staffRole: null,
      adminApiKeyRole: "MANAGER",
    };
    const bucketKey = (() => {
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(now.getUTCDate()).padStart(2, "0");
      return `ibatexas:refund:daily-total:api-key:${yyyy}-${mm}-${dd}`;
    })();
    dripBuckets.set(bucketKey, 195_000);

    const server = await buildPaymentsServer(apiKeyContext);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 10_000, reason: "drip" },
      });
      // 195k + 10k > 200k cap → drip cap fires.
      expect(res.statusCode).toBe(202);
      const body = res.json() as { code: string };
      expect(body.code).toBe("REFUND_DRIP_CAP");
    } finally {
      await server.close();
    }
  });

  it("[P1-H] API-key WITHOUT registry role gets 403 (regression: pre-W4 passed)", async () => {
    // No JWT, no admin-api-key-role set — pre-W4 this hit the refund
    // logic anyway. Now requireManagerRole fails-closed.
    const apiKeyNoRole: StaffContext = {
      staffId: null,
      staffRole: null,
    };
    const server = await buildPaymentsServer(apiKeyNoRole);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/refund",
        payload: { amountInCentavos: 5_000, reason: "leak attempt" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain("chave de API sem permissão");
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

      // P0-5: second owner confirms.
      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/status/confirm",
        payload: { confirmationId },
        headers: OWNER_2_HEADERS,
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

      // P0-5: second owner consumes; kernel REFUSEs the underlying transition.
      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/status/confirm",
        payload: { confirmationId },
        headers: OWNER_2_HEADERS,
      });
      expect(step2.statusCode).toBe(403);
      const body = step2.json() as { error: string };
      expect(body.error).toMatch(/estado final/);
    } finally {
      await server.close();
    }
  });

  // P0-5: force-status by SAME owner on both steps is refused even
  // though force-status is OWNER-only — separation-of-duty.
  it("force-status step 2 by SAME owner as step 1 is refused (P0-5)", async () => {
    const server = await buildPaymentsServer(OWNER);
    try {
      const step1 = await server.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01/payment/status",
        payload: { status: "disputed", reason: "test" },
      });
      const { confirmationId } = step1.json() as { confirmationId: string };

      const step2 = await server.inject({
        method: "POST",
        url: "/api/admin/orders/order_01/payment/status/confirm",
        payload: { confirmationId },
      });
      expect(step2.statusCode).toBe(403);
      expect(step2.json().error).toMatch(/Outro operador/i);
      expect(mockTransitionStatusFromEnvelopePayment).not.toHaveBeenCalled();
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

// ── Tests: concurrent two-step confirm — Lua atomicity (W6-5) ─────────────

describe("AdminConfirmationStore — concurrent consume Lua atomicity (W6-5)", () => {
  beforeEach(() => {
    confirmationStorage.clear();
    mockRedisSet.mockClear();
    mockRedisEval.mockClear();
  });

  it("exactly one of two concurrent consumes succeeds (Promise.all)", async () => {
    // Per audit/08 item #2 and audit §"Concurrency gaps": Task 13's Lua
    // GET+DEL script claims atomic single-use semantics. This test fires
    // two concurrent consume()s against the SAME receipt; the contract
    // says exactly one returns the pending payload and the other returns
    // null.
    //
    // The mocked redis.eval (defined at the top of the file) emulates the
    // Lua script: it reads from the in-memory map then deletes the key
    // in the same JS turn — equivalent to Redis's single-threaded EVAL
    // semantics. We pin the contract under that emulation.
    const { createAdminConfirmationStore } = await import(
      "../admin-confirmation-store.js"
    );
    const store = createAdminConfirmationStore();
    const { confirmationId } = await store.create({
      kind: "order.status.transition",
      payload: { orderId: "order_w6_5", newStatus: "canceled", actor: "admin" },
      nonce: "n-w6-5",
      staffId: "staff_w6_5_a",
      staffRole: "MANAGER",
      actorPrincipal: "user",
      requestorIp: "127.0.0.1",
      prompt: "test",
      route: "force-cancel",
      createdAt: new Date().toISOString(),
      orderId: "order_w6_5",
    });

    // Two concurrent consumes — Promise.all wakes both microtasks at
    // ~the same tick. Node's event loop is single-threaded so the Lua
    // GET+DEL emulation cannot interleave at the JS level; the contract
    // is "exactly one wins, the other gets null".
    const [a, b] = await Promise.all([
      store.consume(confirmationId),
      store.consume(confirmationId),
    ]);

    const successes = [a, b].filter((v): v is NonNullable<typeof a> => v !== null);
    const failures = [a, b].filter((v) => v === null);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(successes[0]!.kind).toBe("order.status.transition");

    // A third consume after the race also returns null — the receipt
    // is permanently consumed.
    const third = await store.consume(confirmationId);
    expect(third).toBeNull();
  });

  it("ten concurrent consumes: exactly one wins, nine return null", async () => {
    // Stress version — proves the Lua single-use semantics hold even
    // under a thundering herd.
    const { createAdminConfirmationStore } = await import(
      "../admin-confirmation-store.js"
    );
    const store = createAdminConfirmationStore();
    const { confirmationId } = await store.create({
      kind: "payment.status.transition",
      payload: { paymentId: "pay_w6_5" },
      nonce: "n-w6-5-stress",
      staffId: "staff_w6_5_stress",
      staffRole: "MANAGER",
      actorPrincipal: "user",
      requestorIp: null,
      prompt: "test",
      route: "force-status",
      createdAt: new Date().toISOString(),
      orderId: "order_w6_5_stress",
    });

    const consumes = await Promise.all(
      Array.from({ length: 10 }, () => store.consume(confirmationId)),
    );

    const winners = consumes.filter((v) => v !== null);
    const losers = consumes.filter((v) => v === null);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);
  });

  it("consumeWithSameActorCheck races behave consistently: only one outcome wins", async () => {
    // The route layer wraps `consume()` in `consumeWithSameActorCheck`
    // (P0-5 same-actor refusal). Even when two operators race against
    // the same receipt, exactly one sees the pending payload.
    const { createAdminConfirmationStore, consumeWithSameActorCheck } =
      await import("../admin-confirmation-store.js");
    const store = createAdminConfirmationStore();
    const { confirmationId } = await store.create({
      kind: "order.status.transition",
      payload: { orderId: "order_w6_5_sa", newStatus: "canceled" },
      nonce: "n-w6-5-sa",
      staffId: "staff_w6_5_step1",
      staffRole: "MANAGER",
      actorPrincipal: "user",
      requestorIp: null,
      prompt: "t",
      route: "force-cancel",
      createdAt: new Date().toISOString(),
      orderId: "order_w6_5_sa",
    });

    const [a, b] = await Promise.all([
      consumeWithSameActorCheck(store, confirmationId, "staff_w6_5_step2_a"),
      consumeWithSameActorCheck(store, confirmationId, "staff_w6_5_step2_b"),
    ]);

    // Exactly one is `ok` (the winner of the Lua race), the other is
    // `missing` (the receipt was already drained).
    const oks = [a, b].filter((v) => v.kind === "ok");
    const misses = [a, b].filter((v) => v.kind === "missing");
    expect(oks).toHaveLength(1);
    expect(misses).toHaveLength(1);
  });
});
