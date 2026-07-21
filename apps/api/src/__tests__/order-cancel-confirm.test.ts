// BKL-146 — customer two-phase cancel COMPLETION.
//
// POST /api/orders/:id/cancel/confirm resumes a parked PAID cancel (the
// REQUEST_CONFIRMATION reply from POST /api/orders/:id/cancel): the single-use
// receipt is consumed, ownership re-checked (IDOR), the order re-loaded fresh,
// and the IDENTICAL order.cancel envelope re-adjudicated through the kernel
// carrying a confirmationReceipt. The kernel stays the confirm authority — the
// receipt substitutes the confirmation, never bypasses a guard.
//
// Redis is store-backed here (a Map): `set` persists and `eval` runs the atomic
// GET+DEL, so the single-use consume semantics are exercised end-to-end.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── Store-backed Redis (single-use receipt semantics) ───────────────────────
const receiptStore = vi.hoisted(() => new Map<string, string>());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockFindActiveByOrderId = vi.hoisted(() => vi.fn(async () => null));
const mockOrderTransition = vi.hoisted(() =>
  vi.fn(async () => ({
    decision: { kind: "EXECUTE", basis: [] },
    result: { version: 2, previousStatus: "confirmed", newStatus: "canceled" },
  })),
);
const mockAdjudicate = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    get: vi.fn(async (k: string) => receiptStore.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      receiptStore.set(k, v);
      return "OK";
    }),
    // Atomic GET+DEL (the store's single-use consume script).
    eval: vi.fn(async (_script: string, opts: { keys: string[] }) => {
      const key = opts.keys[0]!;
      const v = receiptStore.get(key);
      if (v === undefined) return null;
      receiptStore.delete(key);
      return v;
    }),
  })),
  rk: (k: string) => `ibatexas:${k}`,
  withLock: vi.fn(async (_r: string, fn: () => Promise<unknown>) => fn()),
  amendOrder: vi.fn(),
  changeDeliveryAddress: vi.fn(),
  switchOrderType: vi.fn(),
  medusaAdmin: vi.fn(),
}));

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({
    transitionStatusFromEnvelope: mockOrderTransition,
    createFromEnvelope: vi.fn(),
    transitionStatus: vi.fn(),
  }),
  createOrderQueryService: () => ({ getById: mockGetById }),
  createPaymentCommandService: () => ({
    findActiveByOrderId: mockFindActiveByOrderId,
    transitionStatusFromEnvelope: vi.fn(async () => ({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2, newStatus: "canceled" },
    })),
    transitionStatus: vi.fn(),
  }),
  createPaymentQueryService: () => ({
    listByOrderId: vi.fn(async () => ({ count: 0 })),
    getActiveByOrderId: vi.fn(async () => null),
  }),
  prisma: { orderNote: { create: vi.fn(), findMany: vi.fn(async () => []) }, payment: { update: vi.fn() } },
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
  isStructurallyMalformed: () => false,
  STRUCTURAL_REJECTION_CODE: "envelope_malformed",
  createReservationService: () => ({
    getById: vi.fn().mockResolvedValue(null),
    listByCustomer: vi.fn().mockResolvedValue({ reservations: [] }),
  }),
}));

vi.mock("@ibatexas/nats-client", () => ({ publishNatsEvent: mockPublishNatsEvent }));

vi.mock("@adjudicate/core/kernel", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, adjudicate: mockAdjudicate };
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

const mockAuditEmit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@ibatexas/audit-sink", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getAuditSink: () => ({ emit: mockAuditEmit }) };
});

// ── Server + helpers ────────────────────────────────────────────────────────

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

const PAID_ORDER = {
  id: "order_01",
  displayId: 42,
  customerId: "cust_01",
  fulfillmentStatus: "confirmed",
  createdAt: new Date(),
  totalInCentavos: 5000,
};

/** Drive POST /cancel (parks on REQUEST_CONFIRMATION) → returns the receipt id. */
async function park(app: Awaited<ReturnType<typeof buildTestServer>>): Promise<string> {
  mockAdjudicate.mockReturnValue({
    kind: "REQUEST_CONFIRMATION",
    prompt: "Esse pedido já foi pago (R$ 50,00). Cancelar implica reembolso — confirma?",
    basis: [],
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/orders/order_01/cancel",
    headers: { "x-customer-id": "cust_01" },
    payload: { reason: "Mudei de ideia" },
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { confirmationId: string }).confirmationId;
}

/** The order.cancel envelopes that reached the kernel, in call order. */
function cancelAdjudications(): Array<{ payload: unknown; nonce: unknown }> {
  return mockAdjudicate.mock.calls
    .map((c) => c[0] as { kind?: string; payload?: unknown; nonce?: unknown })
    .filter((e) => e?.kind === "order.cancel") as Array<{ payload: unknown; nonce: unknown }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset drains the adjudicate return-value + once-queue so a decision set
  // in one test can never leak into the next (clearAllMocks keeps impls).
  mockAdjudicate.mockReset();
  receiptStore.clear();
  mockGetById.mockResolvedValue(PAID_ORDER);
  mockFindActiveByOrderId.mockResolvedValue(null);
});

describe("POST /api/orders/:id/cancel/confirm — two-phase completion (BKL-146)", () => {
  it("happy path: park → 202{confirmationId} → confirm → EXECUTE 200, order.canceled published", async () => {
    const app = await buildTestServer();
    try {
      const confirmationId = await park(app);

      // The confirm re-adjudicates → EXECUTE (kernel resolves the receipt).
      mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId },
      });

      expect(res.statusCode).toBe(200);
      // The SHARED executor ran: order.canceled emitted after the committed write.
      const canceled = mockPublishNatsEvent.mock.calls.filter((c) => c[0] === "order.canceled");
      expect(canceled).toHaveLength(1);
      // The confirm re-adjudicated an order.cancel envelope through the kernel.
      const confirmEnv = cancelAdjudications().at(-1)!;
      expect(confirmEnv.payload).toMatchObject({ orderId: "order_01" });
    } finally {
      await app.close();
    }
  });

  it("re-uses the SAME parked envelope shape (identical intentHash inputs) on confirm", async () => {
    const app = await buildTestServer();
    try {
      const confirmationId = await park(app);
      mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
      await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId },
      });
      const cancels = cancelAdjudications();
      const parkEnv = cancels[0]!;
      const confirmEnv = cancels.at(-1)!;
      // Same payload + nonce → same intentHash → the receipt matches.
      expect(confirmEnv.payload).toEqual(parkEnv.payload);
      expect(confirmEnv.nonce).toEqual(parkEnv.nonce);
    } finally {
      await app.close();
    }
  });

  it("410 CONFIRMATION_EXPIRED on an unknown/foreign confirmationId", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId: "00000000-0000-4000-8000-000000000000" },
      });
      expect(res.statusCode).toBe(410);
      expect(res.json().code).toBe("CONFIRMATION_EXPIRED");
    } finally {
      await app.close();
    }
  });

  it("410 on a REUSED receipt — single-use consume (a second confirm fails)", async () => {
    const app = await buildTestServer();
    try {
      const confirmationId = await park(app);
      mockAdjudicate.mockReturnValueOnce({ kind: "EXECUTE", basis: [] });
      const first = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId },
      });
      expect(first.statusCode).toBe(200);
      // Replay the SAME receipt — the atomic GET+DEL already drained it → 410.
      const replay = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId },
      });
      expect(replay.statusCode).toBe(410);
      expect(replay.json().code).toBe("CONFIRMATION_EXPIRED");
    } finally {
      await app.close();
    }
  });

  it("IDOR: a DIFFERENT customer cannot confirm someone else's parked cancel → 403", async () => {
    const app = await buildTestServer();
    try {
      const confirmationId = await park(app); // parked by cust_01
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_ATTACKER" },
        payload: { confirmationId },
      });
      expect(res.statusCode).toBe(403);
      // The executor never ran for the attacker.
      expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("IDOR: a receipt cannot be replayed against a DIFFERENT order id → 403", async () => {
    const app = await buildTestServer();
    try {
      const confirmationId = await park(app); // parked for order_01
      // Owner, but confirms at a different order path — pending.orderId !== :id.
      mockGetById.mockResolvedValue({ ...PAID_ORDER, id: "order_99" });
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_99/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId },
      });
      expect(res.statusCode).toBe(403);
      expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("kernel authority: a since-changed order still REFUSEs THROUGH the receipt (past-PONR → 422, no bypass)", async () => {
    const app = await buildTestServer();
    try {
      const confirmationId = await park(app);
      // The order moved past the cancel PONR since the park. Even with a valid
      // receipt, the kernel REFUSEs — the receipt substitutes the confirmation,
      // it does NOT bypass the state guard.
      mockGetById.mockResolvedValue({ ...PAID_ORDER, fulfillmentStatus: "preparing" });
      mockAdjudicate.mockReturnValue({
        kind: "REFUSE",
        refusal: {
          kind: "BUSINESS_RULE",
          code: "order.past_ponr",
          userFacing: "Não é mais possível cancelar este pedido.",
        },
        basis: [],
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("PONR_EXPIRED");
      // No cancel executed — the guard held despite the receipt.
      expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
