// BKL-036 finding 3 — single-amend route PONR gating reaches the kernel.
//
// This suite uses the REAL adjudicate kernel (adjudicate is NOT mocked) so it
// proves the full HTTP → ctx-projection → requireAmendable → REFUSE path: the
// route now loads the order projection and threads `fulfillmentStatus` into the
// kernel ctx, and the pack-orders `canAmendOrder` guard gates the amend
// point-of-no-return. Before the fix the route passed a null projection, so the
// guard read no status and reduced to "order exists" — the gate never ran.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";

const mockGetById = vi.hoisted(() => vi.fn());
const mockAmendOrder = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const mockRedisIncr = vi.hoisted(() => vi.fn(async () => 1));
const mockRedisExpire = vi.hoisted(() => vi.fn(async () => 1));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    del: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
  })),
  rk: (k: string) => `ibatexas:${k}`,
  withLock: vi.fn(async (_resource: string, fn: () => Promise<unknown>) => fn()),
  amendOrder: mockAmendOrder,
  changeDeliveryAddress: vi.fn(),
  switchOrderType: vi.fn(),
  medusaAdmin: vi.fn(),
}));

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({
    transitionStatusFromEnvelope: vi.fn(),
    createFromEnvelope: vi.fn(),
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
  prisma: { orderNote: { create: vi.fn(), findMany: vi.fn(async () => []) }, payment: { update: vi.fn() } },
  InvalidTransitionError: class extends Error {},
  getEffectivePonr: () => ({ cancelMinutes: 30, amendMinutes: 30 }),
}));

vi.mock("@ibatexas/nats-client", () => ({ publishNatsEvent: vi.fn(async () => undefined) }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => {
    request.customerId = request.headers["x-customer-id"] as string;
    done();
  },
}));

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

function makeOrder(fulfillmentStatus: string) {
  return {
    id: "order_01",
    displayId: 7,
    customerId: "cust_01",
    fulfillmentStatus,
    createdAt: new Date(),
    totalInCentavos: 5000,
    paymentStatus: null,
  };
}

async function amend(fulfillmentStatus: string) {
  mockGetById.mockResolvedValue(makeOrder(fulfillmentStatus));
  const app = await buildTestServer();
  try {
    return await app.inject({
      method: "POST",
      url: "/api/orders/order_01/amend",
      headers: { "x-customer-id": "cust_01" },
      payload: { action: "remove", itemTitle: "Coca" },
    });
  } finally {
    await app.close();
  }
}

describe("POST /api/orders/:id/amend — BKL-036 amend PONR (real kernel)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAmendOrder.mockResolvedValue({ success: true });
  });

  it("REFUSE amend past the PONR (delivered) → kernel order.already_shipped, executor NOT run", async () => {
    const res = await amend("delivered");
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("order.already_shipped");
    expect(mockAmendOrder).not.toHaveBeenCalled();
  });

  it("REFUSE amend on a canceled order → kernel order.already_cancelled", async () => {
    const res = await amend("canceled");
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("order.already_cancelled");
    expect(mockAmendOrder).not.toHaveBeenCalled();
  });

  it("ALLOW amend while still amendable (pending) → EXECUTE, executor runs (200)", async () => {
    const res = await amend("pending");
    expect(res.statusCode).toBe(200);
    expect(mockAmendOrder).toHaveBeenCalledTimes(1);
  });

  it("ALLOW amend on a preparing order (add-item parity with the route validator)", async () => {
    const res = await amend("preparing");
    expect(res.statusCode).toBe(200);
    expect(mockAmendOrder).toHaveBeenCalledTimes(1);
  });
});
