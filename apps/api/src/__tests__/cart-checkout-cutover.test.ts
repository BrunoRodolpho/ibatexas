// RC-A1 Chunk 7b pin test — order.checkout.create routed path (lazy resolveState).
//
// POST /api/cart/checkout is wrapped in adjudicateCustomerMutation with createCheckout
// as the legacy closure and a lazy `resolveState` that reads the Medusa cart total ONLY
// on the routed path. Byte-equivalence of the inert path (and the guest-card-200 /
// idempotency-409 / SEC-001 pre-checks) is proven by cart-routes.test.ts UNCHANGED;
// this test drives the routed path (a controllable conductor is injected) and pins:
//   1. ROUTED EXECUTE: resolveState resolves totalInCentavos into the kernel state, and
//      the legacy createCheckout runs on EXECUTE (200).
//   2. ROUTED REFUSE: createCheckout does NOT run and the idempotency gate is released.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";
import { decisionExecute, decisionRefuse, refuse } from "@adjudicate/core";
import type { Decision, IntentEnvelope } from "@adjudicate/core";
import { cartRoutes } from "../routes/cart.js";

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockMedusaStore = vi.hoisted(() => vi.fn());
const mockCreateCheckout = vi.hoisted(() => vi.fn());
const h = vi.hoisted(() => ({ conductor: null as unknown }));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: (s: string) => `ibatexas:${s}`,
  estimateDelivery: vi.fn(),
  createCheckout: mockCreateCheckout,
  reaisToCentavos: (n: number) => Math.round(n * 100),
  MedusaRequestError: class extends Error {},
  cancelStalePaymentIntent: vi.fn(),
  loadSchedule: vi.fn().mockResolvedValue({ days: {} }),
  getMealPeriodFromSchedule: vi.fn().mockReturnValue("lunch"),
  isValidCpf: vi.fn(),
  normalizeCpf: vi.fn(),
  COLLECTION: "products",
  getTypesenseClient: () => ({ collections: () => ({ documents: () => ({ search: vi.fn() }) }) }),
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({ getById: vi.fn().mockResolvedValue(null) }),
  createPaymentQueryService: () => ({ getActiveByOrderId: vi.fn() }),
  prisma: { orderProjection: { findFirst: vi.fn() }, orderNote: { create: vi.fn() } },
}));

vi.mock("@ibatexas/nats-client", () => ({ publishNatsEvent: vi.fn() }));

vi.mock("../routes/admin/_shared.js", () => ({ medusaStore: mockMedusaStore, medusaAdmin: vi.fn() }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: FastifyRequest, _r: FastifyReply, done: () => void) => done(),
  optionalAuth: (req: FastifyRequest, _r: FastifyReply, done: () => void) => {
    const id = req.headers["x-customer-id"] as string | undefined;
    if (id) (req as FastifyRequest & { customerId?: string }).customerId = id;
    done();
  },
}));

vi.mock("../claustrum-bootstrap.js", () => ({
  tryGetConductor: () => h.conductor,
  getConductor: () => h.conductor,
  policyForKind: () => ({
    stateGuards: [], authGuards: [], business: [],
    taint: { minimumFor: () => "UNTRUSTED" as const }, default: "EXECUTE" as const,
  }),
}));

let capturedState: { ctx?: Record<string, unknown> } | undefined;
function routeConductor(decide: () => Decision): void {
  capturedState = undefined;
  h.conductor = {
    adjudicator: {
      adjudicate: async (_env: IntentEnvelope, state: unknown): Promise<Decision> => {
        capturedState = state as { ctx?: Record<string, unknown> };
        return decide();
      },
    },
  };
}

async function buildServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(cartRoutes);
  await app.ready();
  return app;
}

const redisDel = vi.fn().mockResolvedValue(1);

describe("order.checkout.create cutover — routed path (lazy resolveState)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.conductor = null;
    redisDel.mockClear();
    mockGetRedisClient.mockResolvedValue({
      get: vi.fn().mockResolvedValue("cus_1"), // ownership: caller owns the cart
      set: vi.fn().mockResolvedValue("OK"), // idempotency SET-NX acquires
      del: redisDel,
      hSet: vi.fn().mockResolvedValue(1),
      hDel: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
    });
    // resolveState reads the synced cart for the kernel state (total + items).
    mockMedusaStore.mockResolvedValue({ cart: { total: 50, items: [{ variant_id: "v1", quantity: 2, unit_price: 25 }] } });
    mockCreateCheckout.mockResolvedValue({ success: true, orderId: "pi_123" });
  });

  it("ROUTED EXECUTE: resolveState resolves totalInCentavos into the kernel state; legacy createCheckout runs", async () => {
    routeConductor(() => decisionExecute([]));
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      headers: { "x-customer-id": "cus_1" },
      payload: { cartId: "cart_1", paymentMethod: "card" },
    });
    expect(res.statusCode).toBe(200);
    // resolveState read the Medusa cart total (50 reais → 5000 centavos) — routed only.
    expect(capturedState?.ctx?.totalInCentavos).toBe(5000);
    expect(capturedState?.ctx?.paymentMethod).toBe("card");
    // EXECUTE ⇒ the legacy money mutation ran.
    expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
  });

  it("ROUTED REFUSE: createCheckout does NOT run and the idempotency gate is released", async () => {
    routeConductor(() =>
      decisionRefuse(refuse("SECURITY", "nope", "Não posso.", "test refuse"), []),
    );
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      headers: { "x-customer-id": "cus_1" },
      payload: { cartId: "cart_1", paymentMethod: "card" },
    });
    expect(res.statusCode).toBe(403); // replyForIntent → refuse → 403
    expect(mockCreateCheckout).not.toHaveBeenCalled();
    // idempotency gate released so the customer can retry (rk("checkout:idem:cart_1")).
    expect(redisDel).toHaveBeenCalledWith("ibatexas:checkout:idem:cart_1");
  });
});
