// RC-A1 Chunk 1b pin test — order.item.add lazy-payload allergen resolution.
//
// The POST /api/cart/:id/line-items handler is wrapped in adjudicateCustomerMutation
// with a `resolvePayload` thunk that resolves catalog-authoritative allergens from
// Typesense ONLY on the routed path. This test drives the routed path (a controllable
// conductor is injected via the claustrum-bootstrap mock) and pins:
//   1. INERT (no conductor): legacy Medusa add runs, NO Typesense call (byte-equiv).
//   2. ROUTED + product has allergens: the envelope payload carries the resolved
//      array, the legacy add runs on EXECUTE, 201.
//   3. ROUTED + product not found in Typesense: fail-closed → payload.allergens null.
// (The kernel REFUSE-on-null-allergens is pack-policy behavior, covered by
// pack-orders conformance; here we pin that the resolver fail-closes to null.)

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";
import { decisionExecute } from "@adjudicate/core";
import type { Decision, IntentEnvelope } from "@adjudicate/core";
import { cartRoutes } from "../routes/cart.js";

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockMedusaStore = vi.hoisted(() => vi.fn());
const mockTypesenseSearch = vi.hoisted(() => vi.fn());
const h = vi.hoisted(() => ({ conductor: null as unknown }));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: (s: string) => `ibatexas:${s}`,
  estimateDelivery: vi.fn(),
  createCheckout: vi.fn(),
  reaisToCentavos: (n: number) => Math.round(n * 100),
  MedusaRequestError: class extends Error {},
  cancelStalePaymentIntent: vi.fn(),
  loadSchedule: vi.fn(),
  getMealPeriodFromSchedule: vi.fn(),
  isValidCpf: vi.fn(),
  normalizeCpf: vi.fn(),
  COLLECTION: "products",
  getTypesenseClient: () => ({
    collections: () => ({ documents: () => ({ search: mockTypesenseSearch }) }),
  }),
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({ getById: vi.fn().mockResolvedValue(null) }),
  createPaymentQueryService: () => ({ getActiveByOrderId: vi.fn() }),
  prisma: { orderProjection: { findFirst: vi.fn() }, orderNote: { create: vi.fn() } },
}));

vi.mock("@ibatexas/nats-client", () => ({ publishNatsEvent: vi.fn() }));

vi.mock("../routes/admin/_shared.js", () => ({
  medusaStore: mockMedusaStore,
  medusaAdmin: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: FastifyRequest, _r: FastifyReply, done: () => void) => done(),
  optionalAuth: (req: FastifyRequest, _r: FastifyReply, done: () => void) => {
    const id = req.headers["x-customer-id"] as string | undefined;
    if (id) (req as FastifyRequest & { customerId?: string }).customerId = id;
    done();
  },
}));

// Controllable conductor: null ⇒ inert; set ⇒ routed (captures the envelope).
vi.mock("../claustrum-bootstrap.js", () => ({
  tryGetConductor: () => h.conductor,
  getConductor: () => h.conductor,
  policyForKind: () => ({
    stateGuards: [], authGuards: [], business: [],
    taint: { minimumFor: () => "UNTRUSTED" as const }, default: "EXECUTE" as const,
  }),
}));

let captured: IntentEnvelope | undefined;
function routeConductor(): void {
  captured = undefined;
  h.conductor = {
    adjudicator: {
      adjudicate: async (env: IntentEnvelope): Promise<Decision> => {
        captured = env;
        return decisionExecute([]);
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

function addItem(app: Awaited<ReturnType<typeof buildServer>>, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/cart/cart_1/line-items", payload: body });
}

describe("order.item.add cutover — lazy allergen resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.conductor = null;
    mockGetRedisClient.mockResolvedValue({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      hSet: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
    });
    mockMedusaStore.mockResolvedValue({ id: "li_1" });
  });

  it("INERT: legacy add runs and NO Typesense lookup happens (byte-equivalent)", async () => {
    const app = await buildServer();
    const res = await addItem(app, { variant_id: "v_1", quantity: 2 });
    expect(res.statusCode).toBe(201);
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/carts/cart_1/line-items",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ variant_id: "v_1", quantity: 2 }) }),
    );
    // Lazy resolver must NOT run while inert.
    expect(mockTypesenseSearch).not.toHaveBeenCalled();
  });

  it("ROUTED: resolves catalog allergens into the envelope payload, then runs legacy on EXECUTE", async () => {
    routeConductor();
    mockTypesenseSearch.mockResolvedValue({ hits: [{ document: { allergens: ["gluten", "lactose"] } }] });
    const app = await buildServer();
    const res = await addItem(app, { variant_id: "v_1", quantity: 1 });
    expect(res.statusCode).toBe(201);
    // Typesense searched by the variant id; payload carried the resolved allergens.
    expect(mockTypesenseSearch).toHaveBeenCalledWith(expect.objectContaining({ q: "v_1", query_by: "variantsJson" }));
    const payload = captured?.payload as { allergens?: unknown; variantId?: string };
    expect(payload?.allergens).toEqual(["gluten", "lactose"]);
    expect(payload?.variantId).toBe("v_1");
    // EXECUTE ⇒ legacy Medusa add ran.
    expect(mockMedusaStore).toHaveBeenCalledWith("/store/carts/cart_1/line-items", expect.objectContaining({ method: "POST" }));
  });

  it("ROUTED fail-closed: product not found ⇒ payload.allergens is null (kernel would REFUSE, never guess)", async () => {
    routeConductor();
    mockTypesenseSearch.mockResolvedValue({ hits: [] });
    const app = await buildServer();
    await addItem(app, { variant_id: "v_unknown", quantity: 1 });
    const payload = captured?.payload as { allergens?: unknown };
    expect(payload?.allergens).toBeNull();
  });

  it("ROUTED fail-closed: Typesense throws ⇒ payload.allergens is null", async () => {
    routeConductor();
    mockTypesenseSearch.mockRejectedValue(new Error("typesense down"));
    const app = await buildServer();
    await addItem(app, { variant_id: "v_1", quantity: 1 });
    const payload = captured?.payload as { allergens?: unknown };
    expect(payload?.allergens).toBeNull();
  });
});
