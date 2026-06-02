// Route-level parity tests for admin PATCH /api/admin/orders/:id
// (D-C: land BEFORE cutting the primary status transition over to the staff
// gateway, so byte-equivalent legacy behavior is proven inert).
//
// Legacy behavior under test (projection-primary status transition):
//   - duplicate x-request-id        → 409 (idempotency dedup, BEFORE transition)
//   - happy path                    → 200, transitionStatus(expectedVersion) called,
//                                     order.status_changed published, projection returned
//   - ConcurrencyError              → 409
//   - InvalidTransitionError        → 422 (with from/to)
//
// The Medusa backfill-fallback path is a read-only/event-only grace path (it does
// no DB write) and is out of scope for the adjudication seam — only the primary
// commandSvc.transitionStatus mutation is gated.

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
import { orderRoutes } from "../routes/admin/orders.js";

const mockTransitionStatus = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockPublishNats = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({ transitionStatus: mockTransitionStatus }),
  createOrderQueryService: () => ({ getById: mockGetById }),
  createPaymentQueryService: () => ({ getActiveByOrderId: vi.fn() }),
  ConcurrencyError: class ConcurrencyError extends Error {},
  ProjectionNotFoundError: class ProjectionNotFoundError extends Error {},
  InvalidTransitionError: class InvalidTransitionError extends Error {
    from: string;
    to: string;
    constructor(from = "pending", to = "delivered") {
      super("invalid transition");
      this.from = from;
      this.to = to;
    }
  },
}));

vi.mock("@ibatexas/tools", () => ({
  reaisToCentavos: (v: number) => Math.round(v * 100),
  getRedisClient: vi.fn(async () => ({ set: mockRedisSet })),
  rk: (s: string) => s,
}));

vi.mock("@ibatexas/nats-client", () => ({ publishNatsEvent: mockPublishNats }));

vi.mock("../routes/admin/_shared.js", () => ({ medusaAdmin: mockMedusaAdmin }));

vi.mock("../middleware/staff-auth.js", () => ({
  requireManagerRole: (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    (req as FastifyRequest & { staffId?: string; staffRole?: string }).staffId = "staff_mgr";
    (req as FastifyRequest & { staffRole?: string }).staffRole = "MANAGER";
    done();
  },
}));

async function buildServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(orderRoutes);
  await app.ready();
  return app;
}

function patch(
  app: Awaited<ReturnType<typeof buildServer>>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({ method: "PATCH", url: "/api/admin/orders/order_1", payload: body, headers });
}

describe("admin PATCH /orders/:id — legacy parity (inert)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue("OK"); // not a duplicate
    mockPublishNats.mockResolvedValue(undefined);
    mockGetById.mockResolvedValue({
      id: "order_1", displayId: 7, fulfillmentStatus: "preparing", paymentStatus: "paid",
      customerId: "c1", version: 3,
    });
    mockTransitionStatus.mockResolvedValue({ version: 3, previousStatus: "pending", newStatus: "preparing" });
  });

  it("duplicate x-request-id → 409, no transition", async () => {
    mockRedisSet.mockResolvedValue(null); // SET NX returns null → already seen
    const app = await buildServer();
    const res = await patch(app, { fulfillment_status: "preparing", version: 2 }, { "x-request-id": "req-1" });
    expect(res.statusCode).toBe(409);
    expect(mockTransitionStatus).not.toHaveBeenCalled();
  });

  it("happy path: transitions with expectedVersion, publishes, returns projection", async () => {
    const app = await buildServer();
    const res = await patch(app, { fulfillment_status: "preparing", version: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json().order).toMatchObject({ id: "order_1", fulfillment_status: "preparing", source: "projection" });
    expect(mockTransitionStatus).toHaveBeenCalledWith(
      "order_1",
      expect.objectContaining({ newStatus: "preparing", actor: "admin", expectedVersion: 2 }),
    );
    expect(mockPublishNats).toHaveBeenCalledWith("order.status_changed", expect.objectContaining({ orderId: "order_1", updatedBy: "admin" }));
  });

  it("ConcurrencyError → 409", async () => {
    const { ConcurrencyError } = (await import("@ibatexas/domain")) as unknown as {
      ConcurrencyError: new () => Error;
    };
    mockTransitionStatus.mockRejectedValue(new ConcurrencyError());
    const app = await buildServer();
    const res = await patch(app, { fulfillment_status: "preparing", version: 2 });
    expect(res.statusCode).toBe(409);
    expect(mockPublishNats).not.toHaveBeenCalled();
  });

  it("InvalidTransitionError → 422 with from/to", async () => {
    const { InvalidTransitionError } = (await import("@ibatexas/domain")) as unknown as {
      InvalidTransitionError: new (from?: string, to?: string) => Error;
    };
    mockTransitionStatus.mockRejectedValue(new InvalidTransitionError("delivered", "preparing"));
    const app = await buildServer();
    const res = await patch(app, { fulfillment_status: "preparing", version: 2 });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ from: "delivered", to: "preparing" });
    expect(mockPublishNats).not.toHaveBeenCalled();
  });
});
