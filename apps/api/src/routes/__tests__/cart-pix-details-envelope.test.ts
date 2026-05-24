// W7 — cart.ts: cachePixDetailsForCustomer envelope routing
//
// The coverage-baseline audit flagged `apps/api/src/routes/cart.ts:130` as a
// bare-arg `updatePixDetails` caller. This file asserts that after the
// migration the route helper builds a `customer.pix.details.save` envelope
// (UNTRUSTED customer-actor, sessionId = customerId) and dispatches via
// `updatePixDetailsFromEnvelope` — never the deprecated bare-arg surface.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────

const mockUpdatePixDetails = vi.hoisted(() => vi.fn());
const mockUpdatePixDetailsFromEnvelope = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((k: string) => `ibatexas:${k}`));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  estimateDelivery: vi.fn(),
  createCheckout: vi.fn(),
  reaisToCentavos: vi.fn(),
  MedusaRequestError: class {},
  cancelStalePaymentIntent: vi.fn(),
  loadSchedule: vi.fn(),
  getMealPeriodFromSchedule: vi.fn(),
  medusaAdjudicated: vi.fn(),
  MedusaAdjudicateRefusedError: class {},
  MedusaAdjudicateDeferredError: class {},
  MedusaAdjudicateNeedsReviewError: class {},
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    updatePixDetails: mockUpdatePixDetails,
    updatePixDetailsFromEnvelope: mockUpdatePixDetailsFromEnvelope,
  }),
  createOrderCommandService: vi.fn(),
  createPaymentQueryService: vi.fn(),
  prisma: {},
}));

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: vi.fn(async () => undefined) }),
}));

import { cachePixDetailsForCustomer } from "../cart.js";

function createMockRedis() {
  const pipeline = {
    hSet: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  return {
    multi: vi.fn(() => pipeline),
    hGetAll: vi.fn().mockResolvedValue({}),
    expire: vi.fn().mockResolvedValue(true),
    _pipeline: pipeline,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("cart.ts — cachePixDetailsForCustomer envelope routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockUpdatePixDetailsFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: undefined,
    });
  });

  it("routes DB persist through updatePixDetailsFromEnvelope (not bare-arg)", async () => {
    await cachePixDetailsForCustomer("cust_01", {
      name: "Alice",
      email: "alice@example.com",
      cpf: "39053344705",
    });

    expect(mockUpdatePixDetailsFromEnvelope).toHaveBeenCalledTimes(1);
    expect(mockUpdatePixDetails).not.toHaveBeenCalled();
  });

  it("builds envelope with customer.pix.details.save kind + UNTRUSTED + user actor", async () => {
    await cachePixDetailsForCustomer("cust_42", {
      name: "Bob",
      email: "bob@example.com",
      cpf: "39053344705",
    });

    const [envelope, state, extras] = mockUpdatePixDetailsFromEnvelope.mock.calls[0]!;
    expect(envelope.kind).toBe("customer.pix.details.save");
    expect(envelope.taint).toBe("UNTRUSTED");
    expect(envelope.actor.principal).toBe("user");
    expect(envelope.actor.sessionId).toBe("cust_42");
    expect(envelope.payload).toEqual({
      name: "Bob",
      email: "bob@example.com",
      cpf: "39053344705",
    });
    expect(state.ctx.customerId).toBe("cust_42");
    expect(state.ctx.isAuthenticated).toBe(true);
    expect(state.ctx.customerExists).toBe(true);
    expect(extras).toEqual({ customerId: "cust_42" });
  });

  it("propagates Redis-cache writes even when the envelope dispatch refuses", async () => {
    mockUpdatePixDetailsFromEnvelope.mockRejectedValue(new Error("CPF invalid"));
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);

    // The helper catches errors internally (best-effort persistence).
    await expect(
      cachePixDetailsForCustomer("cust_03", {
        name: "Carol",
        email: "carol@example.com",
        cpf: "bad",
      }),
    ).resolves.toBeUndefined();

    // Redis pipeline was still flushed.
    expect(redis._pipeline.exec).toHaveBeenCalledTimes(1);
    // Bare-arg path was NOT used.
    expect(mockUpdatePixDetails).not.toHaveBeenCalled();
  });
});
