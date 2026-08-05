// BKL-146 — customer two-phase cancel COMPLETION.
//
// POST /api/orders/:id/cancel/confirm resumes a parked PAID cancel (the
// REQUEST_CONFIRMATION reply from POST /api/orders/:id/cancel): the single-use
// receipt is consumed, ownership re-checked (IDOR), the order re-loaded fresh,
// and the IDENTICAL order.cancel envelope re-adjudicated through the kernel
// carrying a confirmationReceipt. The kernel stays the confirm authority — the
// receipt substitutes the confirmation, never bypasses a guard.
//
// ── M2: the Lua emulation is GONE (census class (i), item 5) ───────────────
//
// Ruling: docs/architecture/redis-lua-testing-decision.md (Q2). Census:
// `apps/api/src/__tests__/helpers/redis-double-census.md`.
//
// The header used to read "`set` persists and `eval` runs the atomic GET+DEL,
// so the single-use consume semantics are exercised end-to-end". They were
// not: `eval` was a Map GET+DEL in this file, script-blind, and it cannot lose
// a race because there is no race inside one JS process.
//
// Where the invariant went: `lua-shape-consume-contract.test.ts` reads THIS
// site's `CONSUME_RECEIPT_SCRIPT` text and runs it against a real Redis — 20
// concurrent redemptions, exactly one winner — with a non-atomic control
// (client-side GET-then-DEL, i.e. exactly what this file used to do) that
// demonstrates the same setup handing one receipt to several callers.
//
// What this file owns instead, and it is the part that was never covered
// anywhere else: the ROUTE's behaviour on each answer the script can give.
// `receiptRedeems()` below declares the answer as a test input, so every case
// says out loud which branch of the CONSUME contract it is standing on.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { expectLuaCall, type LuaSiteRef } from "./helpers/lua-call-observer.js";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── Store-backed Redis; the CONSUME script is OBSERVED, not emulated ────────
const receiptStore = vi.hoisted(() => new Map<string, string>());
/** Records every Lua call the routes issue. Default nil = "no such receipt". */
const lua = vi.hoisted(() => {
  const calls: { script: string; keys: string[]; arguments: string[] }[] = [];
  const queued: unknown[] = [];
  return {
    calls,
    queued,
    reset() {
      calls.length = 0;
      queued.length = 0;
    },
    replyOnce(value: unknown) {
      queued.push(value);
    },
    async eval(script: string, opts: { keys: string[]; arguments?: string[] }) {
      calls.push({
        script,
        keys: [...opts.keys],
        arguments: [...(opts.arguments ?? [])],
      });
      return queued.length > 0 ? queued.shift() : null;
    },
  };
});
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
    // M2: the CONSUME script is OBSERVED, never emulated. Each case declares
    // the answer it is standing on via `receiptRedeems()`.
    eval: lua.eval,
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
  lua.reset();
  mockGetById.mockResolvedValue(PAID_ORDER);
  mockFindActiveByOrderId.mockResolvedValue(null);
});

/** The rk()-namespaced receipt key, as `order-cancel-confirmation-store.ts` builds it. */
const receiptKey = (confirmationId: string): string =>
  `ibatexas:order:cancel:confirmation:${confirmationId}`;

/** The production CONSUME site the confirm route runs. */
const CONSUME_SITE: LuaSiteRef = {
  file: "apps/api/src/routes/order-cancel-confirmation-store.ts",
  anchor: "const CONSUME_RECEIPT_SCRIPT =",
};

/**
 * Declare the CONSUME script's answer for the NEXT consume: the receipt this
 * test parked, redeemed successfully.
 *
 * Stated as an input, not computed. Whether a receipt CAN be redeemed twice is
 * the script's property and lives in `lua-shape-consume-contract.test.ts`; what
 * the route does with each answer is this file's, and making the answer
 * explicit is what keeps the two from being confused again.
 */
function receiptRedeems(confirmationId: string): void {
  lua.replyOnce(receiptStore.get(receiptKey(confirmationId)) ?? null);
}

/** Assert the confirm route consumed through THIS site's script and key. */
function expectConsumedReceipt(confirmationId: string, index = 0): void {
  expectLuaCall(lua, index, {
    site: CONSUME_SITE,
    keys: [receiptKey(confirmationId)],
    arguments: [],
  });
}

describe("POST /api/orders/:id/cancel/confirm — two-phase completion (BKL-146)", () => {
  it("happy path: park → 202{confirmationId} → confirm → EXECUTE 200, order.canceled published", async () => {
    const app = await buildTestServer();
    try {
      const confirmationId = await park(app);

      // The confirm re-adjudicates → EXECUTE (kernel resolves the receipt).
      mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
      receiptRedeems(confirmationId);
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId },
      });

      expect(res.statusCode).toBe(200);
      // The route reached the receipt through THIS site's CONSUME script.
      expectConsumedReceipt(confirmationId);
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
      receiptRedeems(confirmationId);
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

  // RENAMED from "410 on a REUSED receipt — single-use consume (a second
  // confirm fails)". THAT the receipt can only be redeemed once is the CONSUME
  // script's property, proven against a real Redis in
  // `lua-shape-consume-contract.test.ts`. What this case now pins — and it is
  // the half that lives in the route, not the script — is that the confirm
  // handler treats a drained receipt as terminal: 410 CONFIRMATION_EXPIRED, no
  // re-adjudication, no second cancel.
  it("410 CONFIRMATION_EXPIRED when the CONSUME script reports the receipt already drained", async () => {
    const app = await buildTestServer();
    try {
      const confirmationId = await park(app);
      mockAdjudicate.mockReturnValueOnce({ kind: "EXECUTE", basis: [] });
      receiptRedeems(confirmationId); // first redemption wins
      const first = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId },
      });
      expect(first.statusCode).toBe(200);
      const adjudicationsAfterWinner = cancelAdjudications().length;

      // Replay the SAME receipt. No `receiptRedeems` this time: the script
      // returns nil, which is the CONSUME contract's answer to a second
      // redemption.
      const replay = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId },
      });
      expect(replay.statusCode).toBe(410);
      expect(replay.json().code).toBe("CONFIRMATION_EXPIRED");

      // Both attempts went through the same script and key — the replay was
      // not short-circuited by some other gate that happens to answer 410.
      expectConsumedReceipt(confirmationId, 0);
      expectConsumedReceipt(confirmationId, 1);
      // …and the drained replay never reached the kernel: no order.cancel was
      // adjudicated between the winning confirm and the end of the replay.
      expect(cancelAdjudications()).toHaveLength(adjudicationsAfterWinner);
    } finally {
      await app.close();
    }
  });

  it("IDOR: a DIFFERENT customer cannot confirm someone else's parked cancel → 403", async () => {
    const app = await buildTestServer();
    try {
      const confirmationId = await park(app); // parked by cust_01
      // The attacker's receipt REDEEMS — otherwise the route would answer 410
      // (drained) and this case would pass without ever reaching the ownership
      // check it is named for.
      receiptRedeems(confirmationId);
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_ATTACKER" },
        payload: { confirmationId },
      });
      expect(res.statusCode).toBe(403);
      expectConsumedReceipt(confirmationId);
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
      // Redeems, so the 403 is the ORDER-BINDING refusal and not a 410 the
      // route would have given a drained receipt.
      receiptRedeems(confirmationId);
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_99/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId },
      });
      expect(res.statusCode).toBe(403);
      expectConsumedReceipt(confirmationId);
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
      // A VALID receipt — the point of the case is that a valid one still does
      // not bypass the state guard.
      receiptRedeems(confirmationId);
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/cancel/confirm",
        headers: { "x-customer-id": "cust_01" },
        payload: { confirmationId },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("PONR_EXPIRED");
      expectConsumedReceipt(confirmationId);
      // No cancel executed — the guard held despite the receipt.
      expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
