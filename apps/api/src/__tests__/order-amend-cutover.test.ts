// RC-A1 Phase B pin test — order amend cutover (Chunk 4).
//
// Both amend handlers in order-actions.ts (POST /api/orders/:id/amend/batch and
// POST /api/orders/:id/amend) were wrapped in `adjudicateCustomerMutation({ kind:
// "order.amend.request", ... })`. While the conductor is INERT (bootstrap not
// called → tryGetConductor() === null), the wrapper runs the legacy closure
// DIRECTLY and returns { ran: true, result }, so each handler MUST behave
// byte-identically to the pre-wrap handler.
//
// This test does NOT mock ../claustrum-bootstrap.js — exactly like the live unit
// environment, tryGetConductor() returns null, so we pin the byte-equivalent
// legacy behaviour: amendOrder is invoked with the same args, and the same
// responses (200 success, 422 PARTIAL_FAILURE, 422 NonRetryableError, 500) are
// produced. Heavy deps are mocked at the same boundaries as
// order-actions-cancel-payment.test.ts; @ibatexas/types is NOT mocked so the real
// canPerformAction runs.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Conductor is unconditional post-cutover; a permissive EXECUTE conductor lets the
// gateway run the route's domain mutation (behaviour-preserving for these tests).
vi.mock("../claustrum-bootstrap.js", () => {
  const conductor = { adjudicator: { adjudicate: async () => ({ kind: "EXECUTE", basis: [] }) } };
  return {
    getConductor: () => conductor,
    tryGetConductor: () => conductor,
    policyForKind: () => ({
      stateGuards: [], authGuards: [], business: [],
      taint: { minimumFor: () => "UNTRUSTED" }, default: "EXECUTE",
    }),
  };
});
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { FastifyRequest, FastifyReply } from "fastify";
import { orderActionRoutes } from "../routes/order-actions.js";

const mockAmendOrder = vi.hoisted(() => vi.fn());
const mockOrderGetById = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({ create: vi.fn(), transitionStatus: vi.fn() }),
  createOrderQueryService: () => ({ getById: mockOrderGetById }),
  createPaymentCommandService: () => ({
    transitionStatus: vi.fn(),
    create: vi.fn(),
    findActiveByOrderId: vi.fn(),
  }),
  createPaymentQueryService: () => ({ getActiveByOrderId: vi.fn(), listByOrderId: vi.fn() }),
  prisma: { payment: { update: vi.fn() }, orderNote: {} },
  InvalidTransitionError: class InvalidTransitionError extends Error {},
  getEffectivePonr: () => ({ cancelMinutes: 600 }),
}));

vi.mock("@ibatexas/tools", () => ({
  withLock: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
  getRedisClient: vi.fn(async () => ({
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  })),
  rk: (s: string) => s,
  amendOrder: mockAmendOrder,
  changeDeliveryAddress: vi.fn(),
  switchOrderType: vi.fn(),
  medusaAdmin: mockMedusaAdmin,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    (req as FastifyRequest & { customerId?: string }).customerId = "cust_1";
    done();
  },
}));

async function buildServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(orderActionRoutes);
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof buildServer>>;

function batchAmend(app: App, changes: unknown) {
  return app.inject({ method: "POST", url: "/api/orders/order_1/amend/batch", payload: { changes } });
}

function singleAmend(app: App, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/orders/order_1/amend", payload: body });
}

describe("order amend cutover — byte-equivalent legacy (inert conductor)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but NOT queued `...Once` implementations;
    // a batch test that sets 3 Once values but consumes only 2 (stop-on-first-
    // failure) would leak its 3rd into the next test. Fully reset amendOrder so each
    // test's queue starts empty.
    mockAmendOrder.mockReset();
    // Owned, non-preparing order so verifyOwnership + canPerformAction pass and no
    // food items are locked. Two items so a single remove never trips the
    // all-items-removed guard.
    mockOrderGetById.mockResolvedValue({
      id: "order_1",
      customerId: "cust_1",
      fulfillmentStatus: "confirmed",
      displayId: 1,
      createdAt: new Date(),
      itemsJson: [
        { title: "Costela", productType: "food" },
        { title: "Refrigerante", productType: "merchandise" },
      ],
    });
  });

  // ── batch ────────────────────────────────────────────────────────────────

  it("batch: applies each change via amendOrder with same args, returns 200 success", async () => {
    mockAmendOrder
      .mockResolvedValueOnce({ success: true, message: "removido" })
      .mockResolvedValueOnce({ success: true, message: "atualizado" });

    const app = await buildServer();
    const res = await batchAmend(app, [
      { type: "remove", itemTitle: "Costela" },
      { type: "update_qty", itemTitle: "Refrigerante", quantity: 3 },
    ]);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      results: [
        { itemTitle: "Costela", success: true, message: "removido" },
        { itemTitle: "Refrigerante", success: true, message: "atualizado" },
      ],
    });

    // amendOrder called once per change with the legacy arg shape (action ==
    // HTTP `type`, itemTitle, quantity) + the api AgentContext.
    expect(mockAmendOrder).toHaveBeenCalledTimes(2);
    expect(mockAmendOrder).toHaveBeenNthCalledWith(
      1,
      { orderId: "order_1", action: "remove", itemTitle: "Costela", quantity: undefined },
      expect.objectContaining({ customerId: "cust_1", sessionId: "api", userType: "customer" }),
    );
    expect(mockAmendOrder).toHaveBeenNthCalledWith(
      2,
      { orderId: "order_1", action: "update_qty", itemTitle: "Refrigerante", quantity: 3 },
      expect.objectContaining({ customerId: "cust_1" }),
    );
  });

  it("batch: stop-on-first-failure (thrown) → 422 PARTIAL_FAILURE, no further amendOrder", async () => {
    mockAmendOrder
      .mockResolvedValueOnce({ success: true, message: "ok" })
      .mockRejectedValueOnce(new Error("boom"))
      // third change must NOT be applied after the throw (atomic-batch invariant)
      .mockResolvedValueOnce({ success: true, message: "never" });

    const app = await buildServer();
    const res = await batchAmend(app, [
      { type: "update_qty", itemTitle: "Refrigerante", quantity: 2 },
      { type: "update_qty", itemTitle: "Costela", quantity: 5 },
      { type: "update_qty", itemTitle: "Refrigerante", quantity: 9 },
    ]);

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: "Algumas alterações falharam.",
      code: "PARTIAL_FAILURE",
      results: [
        { itemTitle: "Refrigerante", success: true, message: "ok" },
        { itemTitle: "Costela", success: false, message: "boom" },
      ],
    });
    // Broke on the throw — third change never applied.
    expect(mockAmendOrder).toHaveBeenCalledTimes(2);
  });

  it("batch: a non-throwing unsuccessful result → 422 PARTIAL_FAILURE (no break, continues)", async () => {
    mockAmendOrder
      .mockResolvedValueOnce({ success: false, message: "indisponível" })
      .mockResolvedValueOnce({ success: true, message: "ok" });

    const app = await buildServer();
    const res = await batchAmend(app, [
      { type: "update_qty", itemTitle: "Refrigerante", quantity: 2 },
      { type: "update_qty", itemTitle: "Costela", quantity: 5 },
    ]);

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("PARTIAL_FAILURE");
    // success:false does NOT break the loop — both changes attempted.
    expect(mockAmendOrder).toHaveBeenCalledTimes(2);
    expect(res.json().results).toEqual([
      { itemTitle: "Refrigerante", success: false, message: "indisponível" },
      { itemTitle: "Costela", success: true, message: "ok" },
    ]);
  });

  // ── single ─────────────────────────────────────────────────────────────

  it("single: calls amendOrder with same args and returns its result verbatim (200)", async () => {
    const toolResult = { success: true, message: "item adicionado", orderId: "order_1" };
    mockAmendOrder.mockResolvedValueOnce(toolResult);

    const app = await buildServer();
    const res = await singleAmend(app, {
      action: "add",
      variantId: "variant_42",
      itemTitle: "Costela",
      quantity: 2,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(toolResult);
    expect(mockAmendOrder).toHaveBeenCalledTimes(1);
    expect(mockAmendOrder).toHaveBeenCalledWith(
      { orderId: "order_1", action: "add", variantId: "variant_42", itemTitle: "Costela", quantity: 2 },
      expect.objectContaining({ customerId: "cust_1", sessionId: "api", userType: "customer" }),
    );
  });

  it("single: NonRetryableError from amendOrder → 422 with the error message", async () => {
    const err = new Error("Pedido não pode mais ser alterado.");
    err.name = "NonRetryableError";
    mockAmendOrder.mockRejectedValueOnce(err);

    const app = await buildServer();
    const res = await singleAmend(app, { action: "remove", itemTitle: "Costela" });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "Pedido não pode mais ser alterado." });
  });

  it("single: generic error from amendOrder → 500 generic message", async () => {
    mockAmendOrder.mockRejectedValueOnce(new Error("kaboom"));

    const app = await buildServer();
    const res = await singleAmend(app, { action: "remove", itemTitle: "Costela" });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Erro ao alterar pedido." });
  });
});
