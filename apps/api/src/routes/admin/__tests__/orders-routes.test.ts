// Unit tests for the admin order READ/WRITE routes (apps/api/src/routes/admin/orders.ts).
//
// Coverage targets (the file was ~0% covered):
//   GET  /api/admin/orders        — projection list, payment-batch degrade,
//                                    empty list, P2021 → Medusa fallback,
//                                    generic error → 502, filter passthrough.
//   GET  /api/admin/orders/:id    — projection detail (+ currentPayment),
//                                    payment lookup degrade, Medusa fallback,
//                                    canceled normalization, 404, P2021 path,
//                                    generic error → 502.
//   PATCH /api/admin/orders/:id   — x-request-id dedup (409), kernel REFUSE (403),
//                                    ConcurrencyError (409), InvalidTransitionError (422),
//                                    happy-path EXECUTE (200 + NATS publish),
//                                    ProjectionNotFound → Medusa fallback (200 / 422 / 404).
//
// External deps are fully mocked — no DB, network, Redis, NATS or LLM is hit.
// `buildEnvelope` (@adjudicate/core) and `@ibatexas/types` are kept REAL because
// they are pure and load-bearing (zod enum + canTransition matrix).

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { orderRoutes } from "../orders.js";

// ── Hoisted mock fns / classes ───────────────────────────────────────────────

const mockListAll = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderIds = vi.hoisted(() => vi.fn());
const mockTransition = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());

const MockConcurrencyError = vi.hoisted(
  () =>
    class extends Error {
      constructor() {
        super("Concurrency conflict");
        this.name = "ConcurrencyError";
      }
    },
);
const MockProjectionNotFoundError = vi.hoisted(
  () =>
    class extends Error {
      constructor() {
        super("Order projection not found");
        this.name = "ProjectionNotFoundError";
      }
    },
);
const MockInvalidTransitionError = vi.hoisted(
  () =>
    class extends Error {
      from: string;
      to: string;
      constructor(from: string, to: string) {
        super(`Invalid transition ${from} → ${to}`);
        this.name = "InvalidTransitionError";
        this.from = from;
        this.to = to;
      }
    },
);

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    listAll: mockListAll,
    getById: mockGetById,
  }),
  createOrderCommandService: () => ({
    transitionStatusFromEnvelope: mockTransition,
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: mockGetActiveByOrderId,
    getActiveByOrderIds: mockGetActiveByOrderIds,
  }),
  ConcurrencyError: MockConcurrencyError,
  ProjectionNotFoundError: MockProjectionNotFoundError,
  InvalidTransitionError: MockInvalidTransitionError,
}));

vi.mock("@ibatexas/tools", () => ({
  reaisToCentavos: (amount: number) => Math.round((amount ?? 0) * 100),
  getRedisClient: mockGetRedisClient,
  rk: (key: string) => `ibatexas:${key}`,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("../_shared.js", () => ({
  medusaAdmin: mockMedusaAdmin,
}));

vi.mock("../../../middleware/staff-auth.js", () => ({
  requireManagerRole: (
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ) => {
    (request as unknown as { staffId: string }).staffId = "staff_01";
    (request as unknown as { staffRole: string }).staffRole = "MANAGER";
    done();
  },
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function projectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_01",
    displayId: 1001,
    customerEmail: "ana@example.com",
    customerName: "Ana",
    customerPhone: "+5511999999999",
    customerId: "cust_01",
    itemsJson: [{ variantId: "var_1", priceInCentavos: 2500, name: "Costela" }],
    totalInCentavos: 5000,
    subtotalInCentavos: 4500,
    shippingInCentavos: 500,
    fulfillmentStatus: "confirmed",
    paymentStatus: "captured",
    paymentMethod: "pix",
    deliveryType: "delivery",
    tipInCentavos: 300,
    version: 3,
    medusaCreatedAt: new Date("2026-06-01T12:00:00.000Z"),
    shippingAddressJson: { city: "São Paulo" },
    statusHistory: [
      {
        id: "h1",
        fromStatus: "pending",
        toStatus: "confirmed",
        actor: "admin",
        actorId: "staff_01",
        reason: "Confirmado",
        createdAt: new Date("2026-06-01T12:05:00.000Z"),
      },
    ],
    ...overrides,
  };
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_01",
    method: "pix",
    status: "captured",
    amountInCentavos: 5000,
    pixExpiresAt: new Date("2026-06-01T13:00:00.000Z"),
    version: 2,
    ...overrides,
  };
}

// ── Server factory ───────────────────────────────────────────────────────────

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(orderRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRedisClient.mockResolvedValue({
    set: vi.fn().mockResolvedValue("OK"),
  });
  mockPublishNatsEvent.mockResolvedValue(undefined);
});

// ── GET /api/admin/orders ────────────────────────────────────────────────────

describe("GET /api/admin/orders", () => {
  it("returns the projection list with currentPayment merged (source=projection)", async () => {
    mockListAll.mockResolvedValue({ orders: [projectionRow()], count: 1 });
    mockGetActiveByOrderIds.mockResolvedValue(
      new Map([["order_01", paymentRow()]]),
    );

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(1);
      const o = body.orders[0];
      expect(o.source).toBe("projection");
      // payment_status comes from the active payment, not the projection field.
      expect(o.payment_status).toBe("captured");
      expect(o.currentPayment).toMatchObject({ id: "pay_01", method: "pix" });
      expect(o.total).toBe(5000);
      expect(o.created_at).toBe("2026-06-01T12:00:00.000Z");
      // mapProjectionItems derives id from variantId and unit_price from priceInCentavos.
      expect(o.items[0]).toMatchObject({ id: "var_1", unit_price: 2500 });
    } finally {
      await app.close();
    }
  });

  it("renders the list even when the active-payment batch lookup fails (graceful degrade)", async () => {
    mockListAll.mockResolvedValue({
      orders: [projectionRow({ paymentStatus: "authorized" })],
      count: 1,
    });
    mockGetActiveByOrderIds.mockRejectedValue(new Error("redis down"));

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders" });
      expect(res.statusCode).toBe(200);
      const o = res.json().orders[0];
      expect(o.currentPayment).toBeNull();
      // payment_status falls back to the projection's own value.
      expect(o.payment_status).toBe("authorized");
    } finally {
      await app.close();
    }
  });

  it("returns an empty list without calling the payment batch lookup", async () => {
    mockListAll.mockResolvedValue({ orders: [], count: 0 });

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ orders: [], count: 0 });
      expect(mockGetActiveByOrderIds).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("falls back to Medusa (reais→centavos) when the projection table is missing (P2021)", async () => {
    mockListAll.mockRejectedValue({ code: "P2021" });
    mockMedusaAdmin.mockResolvedValue({
      orders: [
        { id: "o1", total: 89, subtotal: 80, shipping_total: 9, items: [{ unit_price: 25 }] },
      ],
      count: 1,
    });

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders" });
      expect(res.statusCode).toBe(200);
      const o = res.json().orders[0];
      expect(o.source).toBe("medusa_fallback");
      expect(o.total).toBe(8900);
      expect(o.items[0].unit_price).toBe(2500);
      expect(mockMedusaAdmin).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("returns 502 with pt-BR copy on a non-P2021 projection error", async () => {
    mockListAll.mockRejectedValue(new Error("connection refused"));

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders" });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("Falha ao buscar pedidos.");
      // The Medusa fallback must NOT run for a generic (non-table-missing) error.
      expect(mockMedusaAdmin).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("parses + forwards filters (status/payment/date/limit/offset) into listAll", async () => {
    mockListAll.mockResolvedValue({ orders: [], count: 0 });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/orders?fulfillment_status=confirmed&payment_status=captured&date_from=2026-06-01&date_to=2026-06-30&limit=5&offset=10",
      });
      expect(res.statusCode).toBe(200);
      const arg = mockListAll.mock.calls[0]?.[0];
      expect(arg.fulfillmentStatus).toBe("confirmed");
      expect(arg.paymentStatus).toBe("captured");
      expect(arg.limit).toBe(5);
      expect(arg.offset).toBe(10);
      expect(arg.dateFrom).toBeInstanceOf(Date);
      expect(arg.dateFrom.toISOString()).toContain("2026-06-01");
      expect(arg.dateTo).toBeInstanceOf(Date);
    } finally {
      await app.close();
    }
  });
});

// ── GET /api/admin/orders/:id ────────────────────────────────────────────────

describe("GET /api/admin/orders/:id", () => {
  it("returns the projection detail with currentPayment + statusHistory", async () => {
    mockGetById.mockResolvedValue(projectionRow());
    mockGetActiveByOrderId.mockResolvedValue(paymentRow());

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders/order_01" });
      expect(res.statusCode).toBe(200);
      const order = res.json().order;
      expect(order.source).toBe("projection");
      expect(order.payment_status).toBe("captured");
      expect(order.version).toBe(3);
      expect(order.currentPayment.pixExpiresAt).toBe("2026-06-01T13:00:00.000Z");
      expect(order.statusHistory[0]).toMatchObject({
        toStatus: "confirmed",
        actor: "admin",
      });
      expect(order.statusHistory[0].createdAt).toBe("2026-06-01T12:05:00.000Z");
    } finally {
      await app.close();
    }
  });

  it("returns the projection detail with currentPayment null when payment lookup rejects", async () => {
    mockGetById.mockResolvedValue(projectionRow({ paymentStatus: "authorized" }));
    mockGetActiveByOrderId.mockRejectedValue(new Error("payment svc down"));

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders/order_01" });
      expect(res.statusCode).toBe(200);
      const order = res.json().order;
      expect(order.currentPayment).toBeNull();
      expect(order.payment_status).toBe("authorized");
    } finally {
      await app.close();
    }
  });

  it("falls back to Medusa when the projection row is absent (source=medusa_fallback)", async () => {
    mockGetById.mockResolvedValue(null);
    mockMedusaAdmin.mockResolvedValue({
      order: {
        id: "o9",
        status: "completed",
        fulfillment_status: "delivered",
        total: 100,
        subtotal: 90,
        shipping_total: 10,
        items: [{ unit_price: 5 }],
      },
    });

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders/o9" });
      expect(res.statusCode).toBe(200);
      const order = res.json().order;
      expect(order.source).toBe("medusa_fallback");
      expect(order.status).toBe("delivered");
      expect(order.fulfillment_status).toBe("delivered");
      expect(order.total).toBe(10000);
      expect(order.items[0].unit_price).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("normalizes a Medusa-canceled order so status and fulfillment_status agree", async () => {
    mockGetById.mockResolvedValue(null);
    mockMedusaAdmin.mockResolvedValue({
      order: { id: "o9", status: "canceled", fulfillment_status: "delivered" },
    });

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders/o9" });
      expect(res.statusCode).toBe(200);
      const order = res.json().order;
      expect(order.status).toBe("canceled");
      expect(order.fulfillment_status).toBe("canceled");
    } finally {
      await app.close();
    }
  });

  it("returns 404 when neither the projection nor Medusa has the order", async () => {
    mockGetById.mockResolvedValue(null);
    mockMedusaAdmin.mockResolvedValue({});

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders/ghost" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("Pedido nao encontrado.");
    } finally {
      await app.close();
    }
  });

  it("falls back to Medusa when the projection table is missing (P2021)", async () => {
    mockGetById.mockRejectedValue({ code: "P2021" });
    mockMedusaAdmin.mockResolvedValue({ order: { id: "o9", status: "pending" } });

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders/o9" });
      expect(res.statusCode).toBe(200);
      expect(res.json().order.source).toBe("medusa_fallback");
    } finally {
      await app.close();
    }
  });

  it("returns 502 on a non-P2021 projection error", async () => {
    mockGetById.mockRejectedValue(new Error("boom"));

    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/orders/order_01" });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("Falha ao buscar detalhes do pedido.");
    } finally {
      await app.close();
    }
  });
});

// ── PATCH /api/admin/orders/:id ──────────────────────────────────────────────

describe("PATCH /api/admin/orders/:id", () => {
  const goodBody = { fulfillment_status: "preparing", version: 3 };

  it("returns 409 for a duplicate x-request-id and never touches the kernel", async () => {
    mockGetRedisClient.mockResolvedValue({
      set: vi.fn().mockResolvedValue(null), // SET NX → null = key already existed
    });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        headers: { "x-request-id": "req-dup" },
        payload: goodBody,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("Requisicao duplicada.");
      expect(mockTransition).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 403 with the kernel's pt-BR refusal text when the transition is REFUSED", async () => {
    mockTransition.mockResolvedValue({
      decision: { kind: "REFUSE", refusal: { userFacing: "Transição não permitida pela política." } },
    });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: goodBody,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("Transição não permitida pela política.");
    } finally {
      await app.close();
    }
  });

  it("maps a ConcurrencyError to 409", async () => {
    mockTransition.mockRejectedValue(new MockConcurrencyError());

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: goodBody,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("Pedido foi atualizado por outro atendente.");
    } finally {
      await app.close();
    }
  });

  it("maps an InvalidTransitionError to 422 with from/to", async () => {
    mockTransition.mockRejectedValue(new MockInvalidTransitionError("pending", "ready"));

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: goodBody,
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.error).toBe("Transicao de status invalida.");
      expect(body.from).toBe("pending");
      expect(body.to).toBe("ready");
    } finally {
      await app.close();
    }
  });

  it("executes the transition, publishes order.status_changed, and returns the projection", async () => {
    mockTransition.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { version: 4, previousStatus: "confirmed", newStatus: "preparing" },
    });
    // getById is called twice: once for the event payload, once for the response.
    mockGetById.mockResolvedValue(projectionRow({ fulfillmentStatus: "preparing", version: 4 }));

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        headers: { "x-request-id": "req-ok" },
        payload: goodBody,
      });
      expect(res.statusCode).toBe(200);
      const order = res.json().order;
      expect(order.source).toBe("projection");
      expect(order.fulfillment_status).toBe("preparing");
      expect(order.version).toBe(4);

      expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
      const [subject, payload] = mockPublishNatsEvent.mock.calls[0];
      expect(subject).toBe("order.status_changed");
      expect(payload).toMatchObject({
        orderId: "order_01",
        previousStatus: "confirmed",
        newStatus: "preparing",
        version: 4,
        updatedBy: "admin",
        correlationId: "req-ok",
      });
    } finally {
      await app.close();
    }
  });

  it("uses the Medusa fallback when the projection is not found (still publishes + 200)", async () => {
    mockTransition.mockRejectedValue(new MockProjectionNotFoundError());
    mockMedusaAdmin.mockResolvedValue({
      order: {
        id: "order_01",
        display_id: 1001,
        fulfillment_status: "confirmed",
        metadata: { customerId: "cust_77" },
      },
    });
    // loadUpdatedOrderResponse re-reads the projection — still absent → final fallback body.
    mockGetById.mockResolvedValue(null);

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: goodBody,
      });
      expect(res.statusCode).toBe(200);
      const order = res.json().order;
      expect(order.source).toBe("medusa_fallback");
      expect(order.payment_status).toBe("unknown");
      expect(order.fulfillment_status).toBe("preparing");
      expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("returns 422 from the Medusa fallback when the requested transition is illegal", async () => {
    mockTransition.mockRejectedValue(new MockProjectionNotFoundError());
    // delivered → preparing is not a legal forward transition.
    mockMedusaAdmin.mockResolvedValue({
      order: { id: "order_01", display_id: 1001, fulfillment_status: "delivered" },
    });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: goodBody,
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.error).toBe("Transicao de status invalida.");
      expect(body.from).toBe("delivered");
      expect(body.to).toBe("preparing");
      expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 from the Medusa fallback when the order does not exist there either", async () => {
    mockTransition.mockRejectedValue(new MockProjectionNotFoundError());
    mockMedusaAdmin.mockResolvedValue({}); // no order

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: goodBody,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("Pedido nao encontrado.");
    } finally {
      await app.close();
    }
  });

  it("rejects a body missing the required version field with 400 (schema validation)", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/orders/order_01",
        payload: { fulfillment_status: "preparing" }, // no version
      });
      expect(res.statusCode).toBe(400);
      expect(mockTransition).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
