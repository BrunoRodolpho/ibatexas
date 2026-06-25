/**
 * 034-F1 (review findings 6/7/11) — the IDOR/ownership guard must actually ENGAGE
 * for refund money-kinds (whose payloads carry only paymentId) and must NOT
 * REFUSE the true owner on a transient DB error.
 *
 * Verifies the RESOLVER wiring end-to-end: for a refund the customer owns, the
 * resolver stamps resourceRefs AND injects state.authority (so the kernel guard
 * binds); when ownership is INDETERMINATE (the scoped load threw), it injects
 * NEITHER (guard inert → service-layer scoping, never a false REFUSE).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let orderGetById: (id: string) => Promise<unknown> = async () => null;
let paymentGetById: (id: string) => Promise<unknown> = async () => null;

vi.mock("@ibatexas/tools", () => ({
  rk: (s: string) => s,
  getRedisClient: async () => ({ get: async () => null }),
  medusaStore: async () => ({}),
  reaisToCentavos: (reais: number) => Math.round(reais * 100),
}));
vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    getById: (id: string) => orderGetById(id),
    listByCustomer: async () => ({ orders: [], count: 0 }),
  }),
  createPaymentQueryService: () => ({
    getById: (id: string) => paymentGetById(id),
    getActiveByOrderId: async () => null,
    listByOrderId: async () => ({ payments: [], count: 0 }),
  }),
  createCustomerService: () => ({ getById: async () => null }),
  createReservationService: () => ({
    getById: async () => null,
    listByCustomer: async () => ({ reservations: [], total: 0 }),
  }),
  prisma: { timeSlot: { findUnique: async () => null } },
}));

const { createIbatexasResolver } = await import("../ibatexas-resolver.js");
const { buildEnvelope } = await import("@adjudicate/core");

function refundPlan() {
  return {
    envelopes: [
      buildEnvelope({
        kind: "payment.refund.issue",
        payload: { paymentId: "pay1", refundAmountCentavos: 1000 },
        actor: { principal: "llm", sessionId: "conv-1" },
        taint: "UNTRUSTED",
        nonce: "n-1",
      }),
    ],
  };
}

const input = (plan: ReturnType<typeof refundPlan>) => ({
  plan,
  cognition: { conversationId: "conv-1" },
  customerId: "c1",
  channel: "web",
}) as unknown as Parameters<ReturnType<typeof createIbatexasResolver>["resolve"]>[0];

beforeEach(() => {
  orderGetById = async () => null;
  paymentGetById = async () => null;
});

describe("refund ownership wiring", () => {
  it("engages the guard (resourceRefs + authority) for a refund the customer owns", async () => {
    paymentGetById = async () => ({ id: "pay1", orderId: "o1" });
    orderGetById = async () => ({ customerId: "c1" });
    const [resolved] = await createIbatexasResolver().resolve(input(refundPlan()));
    const env = resolved!.envelope as { resourceRefs?: Record<string, string> };
    const state = resolved!.state as { authority?: unknown };
    expect(env.resourceRefs).toEqual({ owner: "c1", resource: "o1" });
    expect(state.authority).toBeDefined();
  });

  it("does NOT engage the guard when ownership is INDETERMINATE (DB threw) — no false REFUSE", async () => {
    paymentGetById = async () => ({ id: "pay1", orderId: "o1" });
    orderGetById = async () => {
      throw new Error("db timeout");
    };
    const [resolved] = await createIbatexasResolver().resolve(input(refundPlan()));
    const env = resolved!.envelope as { resourceRefs?: Record<string, string> };
    const state = resolved!.state as { authority?: unknown };
    expect(env.resourceRefs).toBeUndefined();
    expect(state.authority).toBeUndefined();
  });
});
