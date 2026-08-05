// Coverage for the customer order-action handlers NOT exercised by the
// existing governance suites (cancel / payment-method / retry / regenerate /
// address / type). This file targets the remaining mutating + read handlers
// in apps/api/src/routes/order-actions.ts:
//
//   - GET  /api/orders/:id/payment        — payment status envelope build
//   - GET  /api/orders/:id/notes          — list non-internal notes
//   - POST /api/orders/:id/notes          — adjudicated note add (201 / 403)
//   - POST /api/orders/:id/amend/batch    — validate-all-then-apply atomic batch
//   - POST /api/orders/:id/amend          — single amend via the customer gateway
//
// Every external dependency is mocked (no DB / network / Redis / NATS / LLM).
// Assertions check real status codes, payload shapes, decision branches, and
// side-effects derived from the source — no coverage padding.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockGetById = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());
const mockListByOrderId = vi.hoisted(() => vi.fn());
const mockAddNoteFromEnvelope = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
);
const mockOrderNoteFindMany = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
);
const mockOrderNoteFindUnique = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
);

const mockAmendOrder = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockAdjudicate = vi.hoisted(() => vi.fn());

// ── R5 rollout, family 4 — this file's Redis double is RETIRED ──────────────
//
// It used to be five bare `vi.fn()`s behind `getRedisClient`, with `incr`
// answering a constant `1` and recording nothing. Two fictions rode on that:
//
//   1. `incr → 1` meant the rate-limit counter never counted. The 429 case had
//      to PLANT its own answer (`mockRedisIncr.mockResolvedValueOnce(6)`), so
//      nothing in this file could tell a working cap from a cap whose counter
//      is write-only — the exact fail-OPEN direction the counter exists to
//      prevent. It now seeds five real increments and lets the sixth trip.
//   2. `rk` was faked to `ibatexas:` — a prefix production has never written.
//      Under apps/api's vitest the real `rk` resolves to `development:`.
//
// The route now takes its client through `OrderActionRouteDeps.redis`, so the
// canonical in-memory adapter is injected and `getRedisClient` is a rejecting
// TRIPWIRE: if the threading is ever removed, these cases fall back to it and
// fail loudly rather than silently passing on a double.
//
// The real module is spread so `rk` is the real one (Hard Rule #7); only the
// members this file genuinely needs to fake are replaced.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return {
    ...real,
    getRedisClient: vi.fn(async () => {
      throw new Error(
        "order-actions notes/amend/payment: getRedisClient is a TRIPWIRE — the route must take its client through deps.redis",
      );
    }),
    withLock: vi.fn(async (_r: string, fn: () => Promise<unknown>) => fn()),
    amendOrder: mockAmendOrder,
    changeDeliveryAddress: vi.fn(),
    switchOrderType: vi.fn(),
    medusaAdmin: mockMedusaAdmin,
    medusaAdjudicated: vi.fn(),
  };
});

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({
    transitionStatusFromEnvelope: vi.fn(),
    createFromEnvelope: vi.fn(),
    addNoteFromEnvelope: mockAddNoteFromEnvelope,
  }),
  createOrderQueryService: () => ({
    getById: mockGetById,
  }),
  createPaymentCommandService: () => ({
    findActiveByOrderId: vi.fn(async () => null),
    transitionStatusFromEnvelope: vi.fn(),
    createFromEnvelope: vi.fn(),
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: mockGetActiveByOrderId,
    listByOrderId: mockListByOrderId,
  }),
  prisma: {
    orderNote: {
      findMany: mockOrderNoteFindMany,
      findUnique: mockOrderNoteFindUnique,
    },
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
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, adjudicate: mockAdjudicate };
});

vi.mock("../../middleware/auth.js", () => ({
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

/**
 * The keyspace the route's rate-limit counters land on. Re-created per case in
 * `beforeEach` so no counter leaks across cases — which the retired constant
 * double could not express, because it had no keyspace to leak.
 */
let redis: InMemoryRedis;

async function buildTestServer() {
  const { orderActionRoutes } = await import("../order-actions.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(orderActionRoutes, {
    deps: { redis: async () => redis.client as unknown as never },
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  redis = createInMemoryRedis();
});

function makeOrder(
  overrides?: Partial<{
    id: string;
    customerId: string;
    fulfillmentStatus: string;
    itemsJson: Array<{ title: string; productType?: string }>;
  }>,
) {
  return {
    id: overrides?.id ?? "order_01",
    displayId: 42,
    customerId: overrides?.customerId ?? "cust_01",
    fulfillmentStatus: overrides?.fulfillmentStatus ?? "confirmed",
    createdAt: new Date(),
    totalInCentavos: 50_000,
    paymentMethod: "pix",
    paymentStatus: "awaiting_payment",
    itemsJson: overrides?.itemsJson ?? [
      { title: "X-Burger", productType: "food" },
      { title: "Coca-Cola", productType: "beverage" },
    ],
  };
}

// ── GET /api/orders/:id/payment ────────────────────────────────────────────

describe("GET /api/orders/:id/payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(makeOrder());
  });

  it("returns the active payment projection (centavos verbatim, ISO dates)", async () => {
    const pixExpiresAt = new Date("2026-06-28T12:00:00.000Z");
    const createdAt = new Date("2026-06-28T11:00:00.000Z");
    mockGetActiveByOrderId.mockResolvedValue({
      id: "pay_01",
      method: "pix",
      status: "awaiting_payment",
      amountInCentavos: 50_000,
      pixExpiresAt,
      version: 3,
      createdAt,
    });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/orders/order_01/payment",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { payment: Record<string, unknown> };
      expect(body.payment).toEqual({
        id: "pay_01",
        method: "pix",
        status: "awaiting_payment",
        amountInCentavos: 50_000,
        pixExpiresAt: pixExpiresAt.toISOString(),
        version: 3,
        createdAt: createdAt.toISOString(),
      });
    } finally {
      await app.close();
    }
  });

  it("returns { payment: null } when no active payment exists", async () => {
    mockGetActiveByOrderId.mockResolvedValue(null);
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/orders/order_01/payment",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ payment: null });
    } finally {
      await app.close();
    }
  });

  it("serializes a null pixExpiresAt as null (card/cash payments)", async () => {
    mockGetActiveByOrderId.mockResolvedValue({
      id: "pay_02",
      method: "card",
      status: "payment_pending",
      amountInCentavos: 12_345,
      pixExpiresAt: null,
      version: 1,
      createdAt: new Date("2026-06-28T10:00:00.000Z"),
    });
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/orders/order_01/payment",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { payment: { pixExpiresAt: unknown } };
      expect(body.payment.pixExpiresAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("returns 404 (pt-BR) when the order is not owned by the caller", async () => {
    mockGetById.mockResolvedValue(makeOrder({ customerId: "someone_else" }));
    mockMedusaAdmin.mockRejectedValue(new Error("not found"));
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/orders/order_01/payment",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe("Pedido não encontrado.");
      // Ownership failed before any payment lookup.
      expect(mockGetActiveByOrderId).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 401 when unauthenticated (no x-customer-id)", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/orders/order_01/payment",
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// ── GET /api/orders/:id/notes ──────────────────────────────────────────────

describe("GET /api/orders/:id/notes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(makeOrder());
  });

  it("maps the non-internal notes to the response shape with ISO dates", async () => {
    const createdAt = new Date("2026-06-28T09:30:00.000Z");
    mockOrderNoteFindMany.mockResolvedValue([
      { id: "note_01", author: "customer", content: "Sem cebola", createdAt },
    ]);
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/orders/order_01/notes",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { notes: Array<Record<string, unknown>> };
      expect(body.notes).toEqual([
        {
          id: "note_01",
          author: "customer",
          content: "Sem cebola",
          createdAt: createdAt.toISOString(),
        },
      ]);
      // Only customer-visible notes are queried.
      const whereArg = mockOrderNoteFindMany.mock.calls[0]![0] as {
        where: { orderId: string; isInternal: boolean };
      };
      expect(whereArg.where).toEqual({ orderId: "order_01", isInternal: false });
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the order is not owned by the caller", async () => {
    mockGetById.mockResolvedValue(makeOrder({ customerId: "intruder" }));
    mockMedusaAdmin.mockRejectedValue(new Error("nope"));
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/orders/order_01/notes",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(404);
      expect(mockOrderNoteFindMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/orders/:id/notes ─────────────────────────────────────────────

describe("POST /api/orders/:id/notes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(makeOrder());
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  it("EXECUTE → 201 with persisted content + emits order.note_added", async () => {
    mockAddNoteFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { noteId: "note_99", orderId: "order_01" },
    });
    const persistedCreatedAt = new Date("2026-06-28T08:00:00.000Z");
    mockOrderNoteFindUnique.mockResolvedValue({
      id: "note_99",
      content: "Entregar na portaria",
      createdAt: persistedCreatedAt,
    });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/notes",
        headers: { "x-customer-id": "cust_01" },
        payload: { content: "Entregar na portaria" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        id: "note_99",
        content: "Entregar na portaria",
        createdAt: persistedCreatedAt.toISOString(),
      });

      // The note add was routed through the kernel-adjudicated envelope.
      expect(mockAddNoteFromEnvelope).toHaveBeenCalledTimes(1);
      const envelopeArg = mockAddNoteFromEnvelope.mock.calls[0]![0] as {
        kind: string;
        payload: { orderId: string; body: string };
        taint: string;
      };
      expect(envelopeArg.kind).toBe("order.note.add");
      expect(envelopeArg.payload.body).toBe("Entregar na portaria");
      expect(envelopeArg.taint).toBe("UNTRUSTED");

      // The domain event was published with the new note id.
      const noteEvents = mockPublishNatsEvent.mock.calls.filter(
        (c) => c[0] === "order.note_added",
      );
      expect(noteEvents).toHaveLength(1);
      expect((noteEvents[0]![1] as { noteId: string }).noteId).toBe("note_99");
    } finally {
      await app.close();
    }
  });

  it("falls back to the request content + a fresh date when the re-read misses", async () => {
    mockAddNoteFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { noteId: "note_fallback", orderId: "order_01" },
    });
    mockOrderNoteFindUnique.mockResolvedValue(null);

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/notes",
        headers: { "x-customer-id": "cust_01" },
        payload: { content: "Sem talheres" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; content: string; createdAt: string };
      expect(body.id).toBe("note_fallback");
      expect(body.content).toBe("Sem talheres");
      expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("REFUSE → 403 with the kernel's pt-BR refusal copy + no event published", async () => {
    mockAddNoteFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          kind: "BUSINESS_RULE",
          code: "order.note.canceled",
          userFacing: "Pedido cancelado — não pode adicionar observações.",
        },
        basis: [],
      },
    });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/notes",
        headers: { "x-customer-id": "cust_01" },
        payload: { content: "tarde demais" },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: string }).error).toBe(
        "Pedido cancelado — não pode adicionar observações.",
      );
      expect(mockOrderNoteFindUnique).not.toHaveBeenCalled();
      expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the order is not owned", async () => {
    mockGetById.mockResolvedValue(makeOrder({ customerId: "intruder" }));
    mockMedusaAdmin.mockRejectedValue(new Error("nope"));
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/notes",
        headers: { "x-customer-id": "cust_01" },
        payload: { content: "oi" },
      });
      expect(res.statusCode).toBe(404);
      expect(mockAddNoteFromEnvelope).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an empty note body via schema validation (400)", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/notes",
        headers: { "x-customer-id": "cust_01" },
        payload: { content: "" },
      });
      expect(res.statusCode).toBe(400);
      expect(mockAddNoteFromEnvelope).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/orders/:id/amend/batch ───────────────────────────────────────

describe("POST /api/orders/:id/amend/batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(makeOrder());
  });

  it("applies all changes and returns success with per-item results", async () => {
    mockAmendOrder.mockResolvedValue({ success: true, message: "ok" });
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend/batch",
        headers: { "x-customer-id": "cust_01" },
        payload: {
          changes: [{ type: "update_qty", itemTitle: "X-Burger", quantity: 2 }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        success: boolean;
        results: Array<{ itemTitle: string; success: boolean }>;
      };
      expect(body.success).toBe(true);
      expect(body.results).toEqual([
        { itemTitle: "X-Burger", success: true, message: "ok" },
      ]);
      expect(mockAmendOrder).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("returns 422 ACTION_NOT_ALLOWED when the order is preparing", async () => {
    mockGetById.mockResolvedValue(makeOrder({ fulfillmentStatus: "preparing" }));
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend/batch",
        headers: { "x-customer-id": "cust_01" },
        payload: { changes: [{ type: "remove", itemTitle: "X-Burger" }] },
      });
      expect(res.statusCode).toBe(422);
      const body = res.json() as { code: string; error: string };
      expect(body.code).toBe("ACTION_NOT_ALLOWED");
      expect(body.error.length).toBeGreaterThan(0);
      // Validation refused before any mutation ran.
      expect(mockAmendOrder).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 422 ALL_ITEMS_REMOVED when every item would be removed", async () => {
    mockGetById.mockResolvedValue(
      makeOrder({ itemsJson: [{ title: "X-Burger", productType: "food" }] }),
    );
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend/batch",
        headers: { "x-customer-id": "cust_01" },
        payload: { changes: [{ type: "remove", itemTitle: "X-Burger" }] },
      });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { code: string }).code).toBe("ALL_ITEMS_REMOVED");
      expect(mockAmendOrder).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 422 PARTIAL_FAILURE and stops when a change fails", async () => {
    mockAmendOrder.mockResolvedValue({
      success: false,
      message: "Item não encontrado",
    });
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend/batch",
        headers: { "x-customer-id": "cust_01" },
        payload: { changes: [{ type: "remove", itemTitle: "X-Burger" }] },
      });
      expect(res.statusCode).toBe(422);
      const body = res.json() as {
        code: string;
        results: Array<{ success: boolean; message: string }>;
      };
      expect(body.code).toBe("PARTIAL_FAILURE");
      expect(body.results[0]!.success).toBe(false);
      expect(body.results[0]!.message).toBe("Item não encontrado");
    } finally {
      await app.close();
    }
  });

  it("returns 429 RATE_LIMIT on the 6th attempt within the window", async () => {
    // Five REAL increments on the injected keyspace, so the sixth — the one
    // this case drives — is the one that trips. The retired double planted the
    // answer `6` instead, which passes identically against a counter that never
    // counts.
    const { rk } = await import("@ibatexas/tools");
    for (let i = 0; i < 5; i += 1) {
      await redis.client.incr(rk("rate:amend:cust_01"));
    }
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend/batch",
        headers: { "x-customer-id": "cust_01" },
        payload: { changes: [{ type: "remove", itemTitle: "X-Burger" }] },
      });
      expect(res.statusCode).toBe(429);
      expect((res.json() as { code: string }).code).toBe("RATE_LIMIT");
      // Rate limit fires before ownership / state lookups.
      expect(mockGetById).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the order is not owned", async () => {
    mockGetById.mockResolvedValue(makeOrder({ customerId: "intruder" }));
    mockMedusaAdmin.mockRejectedValue(new Error("nope"));
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend/batch",
        headers: { "x-customer-id": "cust_01" },
        payload: { changes: [{ type: "remove", itemTitle: "X-Burger" }] },
      });
      expect(res.statusCode).toBe(404);
      expect(mockAmendOrder).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 when ownership passes but the order state can't be loaded", async () => {
    // Ownership read succeeds (owned), then the state load misses the
    // projection AND the Medusa fallback throws → loadAmendOrderState
    // reports { found: false }.
    mockGetById
      .mockResolvedValueOnce(makeOrder())
      .mockResolvedValueOnce(null);
    mockMedusaAdmin.mockRejectedValue(new Error("medusa down"));
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend/batch",
        headers: { "x-customer-id": "cust_01" },
        payload: { changes: [{ type: "remove", itemTitle: "X-Burger" }] },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe("Pedido não encontrado.");
      expect(mockAmendOrder).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/orders/:id/amend (single action via the customer gateway) ─────

describe("POST /api/orders/:id/amend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(makeOrder());
  });

  it("EXECUTE → runs amendOrder and surfaces its result (200)", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
    mockAmendOrder.mockResolvedValue({ success: true, message: "Item adicionado" });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend",
        headers: { "x-customer-id": "cust_01" },
        payload: { action: "add", variantId: "var_1", quantity: 1 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, message: "Item adicionado" });
      expect(mockAmendOrder).toHaveBeenCalledTimes(1);
      // The kernel adjudicated an order.amend.request envelope.
      const envelope = mockAdjudicate.mock.calls[0]![0] as {
        kind: string;
        actor: { principal: string };
      };
      expect(envelope.kind).toBe("order.amend.request");
      expect(envelope.actor.principal).toBe("user");
    } finally {
      await app.close();
    }
  });

  it("REFUSE → 403 and amendOrder is never invoked", async () => {
    mockAdjudicate.mockReturnValue({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "order.amend.past_ponr",
        userFacing: "Não é mais possível alterar este pedido.",
      },
      basis: [],
    });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend",
        headers: { "x-customer-id": "cust_01" },
        payload: { action: "remove", itemTitle: "X-Burger" },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: string }).error.length).toBeGreaterThan(0);
      expect(mockAmendOrder).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("maps a NonRetryableError thrown by amendOrder to 422", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
    const err = new Error("Item não pode ser removido neste estado.");
    err.name = "NonRetryableError";
    mockAmendOrder.mockRejectedValue(err);

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend",
        headers: { "x-customer-id": "cust_01" },
        payload: { action: "remove", itemTitle: "X-Burger" },
      });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { error: string }).error).toBe(
        "Item não pode ser removido neste estado.",
      );
    } finally {
      await app.close();
    }
  });

  it("maps an unexpected amendOrder error to a 500 with a pt-BR message", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
    mockAmendOrder.mockRejectedValue(new Error("boom"));

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend",
        headers: { "x-customer-id": "cust_01" },
        payload: { action: "add", variantId: "var_1", quantity: 1 },
      });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: string }).error).toBe("Erro ao alterar pedido.");
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the order is not owned", async () => {
    mockGetById.mockResolvedValue(makeOrder({ customerId: "intruder" }));
    mockMedusaAdmin.mockRejectedValue(new Error("nope"));
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/orders/order_01/amend",
        headers: { "x-customer-id": "cust_01" },
        payload: { action: "add", variantId: "var_1", quantity: 1 },
      });
      expect(res.statusCode).toBe(404);
      expect(mockAdjudicate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
