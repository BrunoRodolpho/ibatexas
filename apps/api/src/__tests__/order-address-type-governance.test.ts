// Unit tests for Task 14 customer order address-change + type-switch governance.
//
// Coverage:
//   - PATCH /api/orders/:id/address wraps the kernel `order.address.change`
//     envelope (actor.user, taint=UNTRUSTED). EXECUTE → tool runs, returns 200.
//     REFUSE → 403 + pt-BR copy, tool NOT called.
//   - PATCH /api/orders/:id/type wraps the kernel `order.type.switch`
//     envelope. Same branches; HTTP `pickup`/`dine_in` collapse to pack's
//     `takeout` in the envelope payload.
//   - Bypass-detection: the legacy direct-tool path is exercised only on
//     EXECUTE — never on REFUSE.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockGetById = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockAdjudicate = vi.hoisted(() => vi.fn());

type ChangeAddressInput = {
  orderId: string;
  address: {
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    neighborhood?: string;
  };
};
type ChangeAddressResult = {
  success: boolean;
  message: string;
  needsEscalation?: boolean;
};
type SwitchTypeInput = {
  orderId: string;
  newType: "delivery" | "pickup" | "dine_in";
};
type SwitchTypeResult = {
  success: boolean;
  message: string;
  needsEscalation?: boolean;
  paymentMethodChangeRequired?: boolean;
};

const mockChangeDeliveryAddress = vi.hoisted(() =>
  vi.fn<(input: ChangeAddressInput, ctx: unknown) => Promise<ChangeAddressResult>>(
    async () => ({ success: true, message: "Endereço de entrega atualizado." }),
  ),
);
const mockSwitchOrderType = vi.hoisted(() =>
  vi.fn<(input: SwitchTypeInput, ctx: unknown) => Promise<SwitchTypeResult>>(
    async () => ({ success: true, message: "Tipo do pedido alterado para entrega." }),
  ),
);

const mockRedisIncr = vi.hoisted(() => vi.fn(async () => 1));
const mockRedisExpire = vi.hoisted(() => vi.fn(async () => 1));
const mockRedisDel = vi.hoisted(() => vi.fn(async () => 1));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    del: mockRedisDel,
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
  })),
  rk: (k: string) => `ibatexas:${k}`,
  withLock: vi.fn(async (_resource: string, fn: () => Promise<unknown>) => fn()),
  amendOrder: vi.fn(),
  changeDeliveryAddress: mockChangeDeliveryAddress,
  switchOrderType: mockSwitchOrderType,
  medusaAdmin: mockMedusaAdmin,
}));

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({
    transitionStatusFromEnvelope: vi.fn(async () => ({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2, previousStatus: "pending", newStatus: "canceled" },
    })),
    createFromEnvelope: vi.fn(async () => ({
      decision: { kind: "EXECUTE", basis: [] },
      result: { id: "order_01", version: 1 },
    })),
    transitionStatus: vi.fn(),
  }),
  createOrderQueryService: () => ({ getById: mockGetById }),
  createPaymentCommandService: () => ({
    findActiveByOrderId: vi.fn(async () => null),
    transitionStatusFromEnvelope: vi.fn(),
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

function makeOrder(overrides?: Partial<{ id: string; fulfillmentStatus: string; deliveryType: string }>) {
  return {
    id: overrides?.id ?? "order_01",
    displayId: 42,
    customerId: "cust_01",
    fulfillmentStatus: overrides?.fulfillmentStatus ?? "pending",
    deliveryType: overrides?.deliveryType ?? "delivery",
    createdAt: new Date(),
    totalInCentavos: 5000,
  };
}

// ── PATCH /address tests ───────────────────────────────────────────────────

describe("PATCH /api/orders/:id/address — envelope governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(makeOrder());
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const addressBody = {
    address: {
      address1: "Rua A",
      address2: "Apto 12",
      city: "Belo Horizonte",
      state: "MG",
      postalCode: "30000-000",
      neighborhood: "Centro",
    },
  };

  it("EXECUTE decision → executor runs (tool called), returns 200", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/address",
        headers: { "x-customer-id": "cust_01" },
        payload: addressBody,
      });

      expect(res.statusCode).toBe(200);
      expect(mockAdjudicate).toHaveBeenCalledTimes(1);
      expect(mockChangeDeliveryAddress).toHaveBeenCalledTimes(1);

      // Outer envelope shape — kind, actor, taint
      const env = mockAdjudicate.mock.calls[0]![0] as {
        kind: string;
        actor: { principal: string; sessionId: string };
        taint: string;
        payload: { orderId: string; address: { street: string; zip: string; complement?: string; neighborhood?: string } };
      };
      expect(env.kind).toBe("order.address.change");
      expect(env.actor.principal).toBe("user");
      expect(env.actor.sessionId).toBe("cust_01");
      expect(env.taint).toBe("UNTRUSTED");
      expect(env.payload.orderId).toBe("order_01");
      // HTTP→Pack vocab mapping
      expect(env.payload.address.street).toBe("Rua A");
      expect(env.payload.address.zip).toBe("30000-000");
      expect(env.payload.address.complement).toBe("Apto 12");
      expect(env.payload.address.neighborhood).toBe("Centro");
    } finally {
      await app.close();
    }
  });

  it("REFUSE decision → 403 + pt-BR copy + tool NOT called", async () => {
    mockAdjudicate.mockReturnValue({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "order.address.past_ponr",
        userFacing: "Não é mais possível alterar o endereço deste pedido.",
      },
      basis: [],
    });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/address",
        headers: { "x-customer-id": "cust_01" },
        payload: addressBody,
      });

      expect(res.statusCode).toBe(403);
      const body = res.json() as { error: string; code: string };
      expect(body.error.length).toBeGreaterThan(0);
      expect(body.code).toBe("order.address.past_ponr");

      // The tool function was NOT called — outer adjudicate refused.
      expect(mockChangeDeliveryAddress).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("EXECUTE outer but inner tool returns success:false → 422 + message", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
    mockChangeDeliveryAddress.mockResolvedValueOnce({
      success: false,
      message: "Pedido em preparo — alteração requer atendimento.",
      needsEscalation: true,
    });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/address",
        headers: { "x-customer-id": "cust_01" },
        payload: addressBody,
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string; needsEscalation: boolean };
      expect(body.error).toContain("preparo");
      expect(body.needsEscalation).toBe(true);
    } finally {
      await app.close();
    }
  });
});

// ── PATCH /type tests ──────────────────────────────────────────────────────

describe("PATCH /api/orders/:id/type — envelope governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(makeOrder({ deliveryType: "delivery" }));
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("EXECUTE decision → executor runs (tool called), returns 200", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/type",
        headers: { "x-customer-id": "cust_01" },
        payload: { type: "pickup" },
      });

      expect(res.statusCode).toBe(200);
      expect(mockAdjudicate).toHaveBeenCalledTimes(1);
      expect(mockSwitchOrderType).toHaveBeenCalledTimes(1);

      const env = mockAdjudicate.mock.calls[0]![0] as {
        kind: string;
        actor: { principal: string; sessionId: string };
        taint: string;
        payload: { orderId: string; newType: "delivery" | "takeout" };
      };
      expect(env.kind).toBe("order.type.switch");
      expect(env.actor.principal).toBe("user");
      expect(env.taint).toBe("UNTRUSTED");
      // HTTP `pickup` collapses to Pack `takeout`.
      expect(env.payload.newType).toBe("takeout");

      // Inner tool preserves the precise HTTP vocab.
      const innerArgs = mockSwitchOrderType.mock.calls[0]?.[0];
      expect(innerArgs?.newType).toBe("pickup");
    } finally {
      await app.close();
    }
  });

  it("HTTP `dine_in` collapses to Pack `takeout` in outer envelope", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/type",
        headers: { "x-customer-id": "cust_01" },
        payload: { type: "dine_in" },
      });

      expect(res.statusCode).toBe(200);
      const env = mockAdjudicate.mock.calls[0]![0] as {
        payload: { newType: "delivery" | "takeout" };
      };
      expect(env.payload.newType).toBe("takeout");

      const innerArgs = mockSwitchOrderType.mock.calls[0]?.[0];
      expect(innerArgs?.newType).toBe("dine_in");
    } finally {
      await app.close();
    }
  });

  // ── audit-2026-05-24 P2-3: preserve HTTP vocab in audit ──────────────
  //
  // D3 commit migrated /type to use the customer-intent-gateway. The
  // outer envelope's `newType` is collapsed to the pack vocabulary
  // (`takeout`) for adjudication. The audit record is built from the
  // envelope's payload — without preserving the original HTTP vocab,
  // an operator reading the audit row can't tell whether the customer
  // asked for `pickup` or `dine_in`. We carry both via `httpVocab`.
  it("preserves HTTP `pickup` in envelope payload `httpVocab` for audit fidelity", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/type",
        headers: { "x-customer-id": "cust_01" },
        payload: { type: "pickup" },
      });

      expect(res.statusCode).toBe(200);
      const env = mockAdjudicate.mock.calls[0]![0] as {
        payload: {
          newType: "delivery" | "takeout";
          httpVocab?: "delivery" | "pickup" | "dine_in";
        };
      };
      // Pack vocab — collapsed
      expect(env.payload.newType).toBe("takeout");
      // HTTP vocab — preserved for audit
      expect(env.payload.httpVocab).toBe("pickup");
    } finally {
      await app.close();
    }
  });

  it("preserves HTTP `dine_in` in envelope payload `httpVocab` for audit fidelity", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/type",
        headers: { "x-customer-id": "cust_01" },
        payload: { type: "dine_in" },
      });

      expect(res.statusCode).toBe(200);
      const env = mockAdjudicate.mock.calls[0]![0] as {
        payload: {
          newType: "delivery" | "takeout";
          httpVocab?: "delivery" | "pickup" | "dine_in";
        };
      };
      expect(env.payload.newType).toBe("takeout");
      expect(env.payload.httpVocab).toBe("dine_in");
    } finally {
      await app.close();
    }
  });

  it("preserves HTTP `delivery` in envelope payload `httpVocab` (1:1 mapping)", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/type",
        headers: { "x-customer-id": "cust_01" },
        payload: { type: "delivery" },
      });

      expect(res.statusCode).toBe(200);
      const env = mockAdjudicate.mock.calls[0]![0] as {
        payload: {
          newType: "delivery" | "takeout";
          httpVocab?: "delivery" | "pickup" | "dine_in";
        };
      };
      expect(env.payload.newType).toBe("delivery");
      expect(env.payload.httpVocab).toBe("delivery");
    } finally {
      await app.close();
    }
  });

  it("REFUSE decision → 403 + pt-BR copy + tool NOT called", async () => {
    mockAdjudicate.mockReturnValue({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "order.type.past_ponr",
        userFacing: "Não é mais possível alterar o tipo deste pedido.",
      },
      basis: [],
    });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/type",
        headers: { "x-customer-id": "cust_01" },
        payload: { type: "pickup" },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json() as { error: string; code: string };
      expect(body.error.length).toBeGreaterThan(0);
      expect(body.code).toBe("order.type.past_ponr");
      expect(mockSwitchOrderType).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("EXECUTE outer but inner tool returns success:false → 422 + message", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
    mockSwitchOrderType.mockResolvedValueOnce({
      success: false,
      message: "Pedido já é deste tipo.",
    });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/orders/order_01/type",
        headers: { "x-customer-id": "cust_01" },
        payload: { type: "delivery" },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string };
      expect(body.error).toContain("já é deste tipo");
    } finally {
      await app.close();
    }
  });
});
