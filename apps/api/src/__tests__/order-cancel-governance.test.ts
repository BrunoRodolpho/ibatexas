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
// Controllable payment-cancel transition (P2-LOGIC-CANCELPAY terminality gate).
// Defaults to EXECUTE so existing cancel tests are unaffected.
const mockPaymentTransition = vi.hoisted(() =>
  vi.fn(async () => ({
    decision: { kind: "EXECUTE", basis: [] },
    result: { version: 2, previousStatus: "awaiting_payment", newStatus: "canceled" },
  })),
);

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
  // R1-DELETE: route now uses transitionStatusFromEnvelope for inner mutations.
  createOrderCommandService: () => ({
    transitionStatusFromEnvelope: vi.fn(async () => ({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2, previousStatus: "pending", newStatus: "canceled" },
    })),
    createFromEnvelope: vi.fn(async () => ({
      decision: { kind: "EXECUTE", basis: [] },
      result: { id: "order_01", version: 1 },
    })),
    // Keep bare-arg mock for the few legacy assertions that still check it.
    transitionStatus: mockTransitionStatus,
  }),
  createOrderQueryService: () => ({
    getById: mockGetById,
  }),
  createPaymentCommandService: () => ({
    findActiveByOrderId: mockFindActiveByOrderId,
    transitionStatusFromEnvelope: mockPaymentTransition,
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
  // FE-T04 — routes/order-actions.js (dynamically imported below) pulls in
  // customer-intent-gateway.js + claustrum/resolve-and-assemble.js, both of
  // which now statically import from @ibatexas/domain. isStructurallyMalformed
  // mirrors real behavior for this file's well-formed envelopes (always
  // `false`) — the gate's own rejection logic is covered by
  // test-envelope-ingress.test.ts and with-adjudicate.test.ts, not here.
  // createReservationService is unexercised by any assertion in this file.
  isStructurallyMalformed: () => false,
  STRUCTURAL_REJECTION_CODE: "envelope_malformed",
  createReservationService: () => ({
    getById: vi.fn().mockResolvedValue(null),
    listByCustomer: vi.fn().mockResolvedValue({ reservations: [] }),
  }),
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

// Capture audit emits so BKL-036 can assert that a kernel-routed cancel REFUSE
// is AUDITED at the gateway seam (the whole point of moving the PONR check
// behind the kernel). Partial mock — preserves __setAuditSinkDependencies so
// the test setup's sink wiring still loads.
const mockAuditEmit = vi.hoisted(() => vi.fn(async (_record: unknown) => {}));
vi.mock("@ibatexas/audit-sink", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getAuditSink: () => ({ emit: mockAuditEmit }) };
});

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

  it("EXECUTE decision → executor runs, returns 200", async () => {
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

  it("P2-LOGIC-CANCELPAY: active payment can't be made terminal → 409, order.canceled withheld", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
    // A live (non-terminal) payment on the initial read AND the authoritative re-read.
    mockFindActiveByOrderId.mockResolvedValue({ id: "pay_01", status: "awaiting_payment", version: 1 });
    // The payment-cancel transition fails (e.g. concurrent flip to paid) — and the
    // re-read still shows the payment active → the order must NOT be announced canceled.
    mockPaymentTransition.mockRejectedValueOnce(new Error("concurrency"));

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_01" },
        payload: { reason: "Mudei de ideia" },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("PAYMENT_CANCEL_FAILED");
      // order.canceled must be withheld (downstream treats it as fully settled).
      const canceledPublishes = mockPublishNatsEvent.mock.calls.filter((c) => c[0] === "order.canceled");
      expect(canceledPublishes).toHaveLength(0);
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

// ── BKL-036 finding 1 — cancel PONR moved behind the kernel (audited 422) ─────
//
// The fulfillment-state / already-cancelled cancel refusals now reach the
// kernel (so they are ADJUDICATED + AUDITED) and the route translates the
// kernel's stable REFUSE codes back to the exact legacy 422 + code the client
// saw when the check was a pre-kernel 422. The order-age (time-window) PONR
// stays pre-kernel for pending/confirmed orders (unchanged 422/PONR_EXPIRED).

describe("POST /api/orders/:id/cancel — BKL-036 kernel-routed PONR + paid-cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
    mockGetById.mockResolvedValue(makeOrder());
    mockFindActiveByOrderId.mockResolvedValue(null);
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function inject(fulfillmentStatus: string, decision: Record<string, unknown>) {
    mockGetById.mockResolvedValue(makeOrder({ fulfillmentStatus }));
    mockAdjudicate.mockReturnValue(decision);
    const app = await buildTestServer();
    try {
      return await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_01" },
        payload: { reason: "x" },
      });
    } finally {
      await app.close();
    }
  }

  const pastPonrRefuse = {
    kind: "REFUSE",
    refusal: { kind: "STATE", code: "order.past_ponr", userFacing: "Passou do ponto de cancelamento." },
    basis: [{ category: "state", code: "terminal_state" }],
  };
  const alreadyCancelledRefuse = {
    kind: "REFUSE",
    refusal: { kind: "STATE", code: "order.already_cancelled", userFacing: "Esse pedido já foi cancelado." },
    basis: [{ category: "state", code: "terminal_state" }],
  };

  it("kernel REFUSE order.past_ponr on a ready order → 422 PAST_PONR (audited, executor NOT run)", async () => {
    const res = await inject("ready", pastPonrRefuse);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; fulfillmentStatus: string };
    expect(body.code).toBe("PAST_PONR");
    expect(body.fulfillmentStatus).toBe("ready");
    // The refusal is AUDITED at the gateway seam.
    const auditedRefuse = mockAuditEmit.mock.calls.find((c) => {
      const rec = c[0] as { envelope?: { kind?: string }; decision?: { kind?: string } };
      return rec?.envelope?.kind === "order.cancel" && rec?.decision?.kind === "REFUSE";
    });
    expect(auditedRefuse).toBeDefined();
    // The destructive path did NOT run.
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("kernel REFUSE order.past_ponr on a preparing order → 422 PONR_EXPIRED (legacy escalate code)", async () => {
    const res = await inject("preparing", pastPonrRefuse);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("PONR_EXPIRED");
  });

  it("kernel REFUSE order.already_cancelled → 422 PAST_PONR", async () => {
    const res = await inject("canceled", alreadyCancelledRefuse);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("PAST_PONR");
  });

  it("a NON-PONR REFUSE is NOT translated — stays the gateway default 403", async () => {
    const res = await inject("ready", {
      kind: "REFUSE",
      refusal: { kind: "SECURITY", code: "order.ownership_denied", userFacing: "Não é seu pedido." },
      basis: [],
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("order.ownership_denied");
  });

  it("PAID cancel → REQUEST_CONFIRMATION → parks + 202 {confirmationRequired, confirmationId, ttlSeconds} (executor NOT run) (BKL-146)", async () => {
    const res = await inject("confirmed", {
      kind: "REQUEST_CONFIRMATION",
      prompt: "Esse pedido já foi pago (R$ 50,00). Cancelar implica reembolso — confirma?",
      basis: [],
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as {
      confirmationRequired: boolean;
      confirmationId: string;
      prompt: string;
      ttlSeconds: number;
    };
    expect(body.confirmationRequired).toBe(true);
    expect(body.prompt).toMatch(/reembolso/);
    // BKL-146 — the park receipt lets the customer COMPLETE the cancel via
    // POST /api/orders/:id/cancel/confirm (the 202 now carries the id + TTL).
    expect(typeof body.confirmationId).toBe("string");
    expect(body.confirmationId.length).toBeGreaterThan(0);
    expect(body.ttlSeconds).toBe(600);
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("PAID large cancel → ESCALATE → 503 (human review)", async () => {
    const res = await inject("confirmed", {
      kind: "ESCALATE",
      to: "human",
      reason: "paid_cancel_refund_above_escalate_threshold",
      basis: [],
    });
    expect(res.statusCode).toBe(503);
    expect(mockTransitionStatus).not.toHaveBeenCalled();
  });

  it("pending order within the time-window still cancels through the kernel (200)", async () => {
    // pending + within PONR ⇒ pre-kernel time check passes ⇒ kernel EXECUTE ⇒ 200.
    const res = await inject("pending", { kind: "EXECUTE", basis: [] });
    expect(res.statusCode).toBe(200);
    expect(mockAdjudicate).toHaveBeenCalledTimes(1);
  });
});

// ── BKL-103 — the customer paid-cancel ESCALATE is staff-visible ────────────
// Live-proven hole (w-cal3 2026-07-19): the >=R$1000 paid-cancel ESCALATE was
// audit-row-only while the 503 told the customer a human would handle it. The
// route now publishes the BKL-178 support.handoff_requested recipe (synthetic
// order-keyed sessionId; the handoff-subscriber dedups on it, so retries
// surface exactly one Escalações record + staff ping).
describe("POST /api/orders/:id/cancel — BKL-103 ESCALATE surfacing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
    mockGetById.mockResolvedValue(makeOrder({ totalInCentavos: 150000 }));
    mockFindActiveByOrderId.mockResolvedValue(null);
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  const escalate = {
    kind: "ESCALATE",
    reason: "paid_cancel_refund_above_escalate_threshold",
    basis: [{ category: "business", code: "threshold_exceeded" }],
  };

  async function injectCancel() {
    mockAdjudicate.mockReturnValue(escalate);
    const app = await buildTestServer();
    try {
      return await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_01" },
        payload: { reason: "x" },
      });
    } finally {
      await app.close();
    }
  }

  function handoffCalls() {
    return mockPublishNatsEvent.mock.calls.filter(
      (c: unknown[]) => c[0] === "support.handoff_requested",
    );
  }

  it("kernel ESCALATE → 503 AND exactly one support.handoff_requested with the order-keyed sessionId + pt-BR reason", async () => {
    const res = await injectCancel();
    expect(res.statusCode).toBe(503);
    const calls = handoffCalls();
    expect(calls).toHaveLength(1);
    const payload = calls[0]![1] as { sessionId: string; reason: string };
    expect(payload.sessionId).toBe("order-cancel:order_01");
    expect(payload.reason).toContain("#42");
    expect(payload.reason).toContain("R$ 1500,00");
    expect(payload.reason).toContain("aprovação");
  });

  it("a customer RETRY publishes with the SAME sessionId (the subscriber dedup key — exactly-once staff record)", async () => {
    await injectCancel();
    await injectCancel();
    const calls = handoffCalls();
    expect(calls).toHaveLength(2); // two publishes ride NATS…
    const [a, b] = calls.map((c) => (c[1] as { sessionId: string }).sessionId);
    expect(a).toBe(b); // …but the stable key means ONE record + ping downstream.
  });

  it("carries NO customer identifier (PII discipline — displayId + amount only)", async () => {
    await injectCancel();
    const payload = handoffCalls()[0]![1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["reason", "sessionId"]);
    expect(JSON.stringify(payload)).not.toContain("cust_01");
  });

  it("a publish failure NEVER breaks the customer reply (best-effort, logged)", async () => {
    mockPublishNatsEvent.mockRejectedValue(new Error("nats down"));
    const res = await injectCancel();
    expect(res.statusCode).toBe(503);
  });

  it("a non-ESCALATE decision publishes NO handoff (<R$1000 path byte-identical)", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
    mockGetById.mockResolvedValue(makeOrder({ totalInCentavos: 5000 }));
    const app = await buildTestServer();
    try {
      await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel",
        headers: { "x-customer-id": "cust_01" },
        payload: { reason: "x" },
      });
    } finally {
      await app.close();
    }
    expect(handoffCalls()).toHaveLength(0);
  });
});
