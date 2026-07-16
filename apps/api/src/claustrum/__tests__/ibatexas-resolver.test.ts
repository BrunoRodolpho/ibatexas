/**
 * FE-T09b (BKL-154 live-disproof follow-up) — the amend-preference
 * correction wired into the real resolver.
 *
 * Proves the full re-route seam, end to end through the REAL production
 * functions (only the DB/search-layer deps are mocked, same harness style
 * as resolve-and-assemble.test.ts):
 *
 *   createIbatexasResolver().resolve() [wires correctAmendPreference]
 *     -> the REAL resolveAndAssemble() [ORDER_AUTORESOLVE_KINDS auto-resolve
 *        + variantId/allergens hydration]
 *     -> the REAL confirmOnAutoResolveGuard [existing guard — no new
 *        confirm machinery needed; the re-routed kind already sits in
 *        AUTORESOLVE_CONFIRM_KINDS from FE-T09]
 *
 * Pins Drive F's exact attempt-3 utterance (the live disproof this ticket
 * fixes): "quero adicionar um refrigerante no pedido que eu já fiz, o
 * pedido 910226" — pre-fix this routed to order.item.add and silently
 * mutated a phantom new cart; post-fix it must re-route to
 * order.amend.add_item and reach REQUEST_CONFIRMATION.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import type { CognitiveState, Plan } from "@claustrum/core";

// ── Mutable mock controls (mirrors resolve-and-assemble.test.ts's harness) ──
let orderGetById: (id: string) => Promise<unknown> = async () => null;
let orderListByCustomer: (cid: string, input?: unknown) => Promise<{ orders: unknown[]; count: number }> =
  async () => ({ orders: [], count: 0 });
let searchProductsMock: (input: unknown, ctx?: unknown) => Promise<unknown> = async () => ({ products: [] });
let redisGet: (key: string) => Promise<string | null> = async () => null;

vi.mock("@ibatexas/tools", () => ({
  rk: (s: string) => s,
  getRedisClient: async () => ({ get: (k: string) => redisGet(k) }),
  medusaAdmin: {},
  medusaStore: async () => ({}),
  reaisToCentavos: (reais: number) => Math.round(reais * 100),
  searchProducts: (input: unknown, ctx?: unknown) => searchProductsMock(input, ctx),
}));
vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    getById: (id: string) => orderGetById(id),
    listByCustomer: (cid: string, input?: unknown) => orderListByCustomer(cid, input),
  }),
  createOrderService: () => ({
    getOrder: async () => {
      throw new Error("not used by this test");
    },
  }),
  createPaymentQueryService: () => ({
    getById: async () => null,
    getActiveByOrderId: async () => null,
    listByOrderId: async () => ({ payments: [], count: 0 }),
  }),
  createCustomerService: () => ({ getById: async () => null }),
  createReservationService: () => ({
    getById: async () => {
      throw new Error("not found");
    },
    listByCustomer: async () => ({ reservations: [], total: 0 }),
  }),
  prisma: { timeSlot: { findUnique: async () => null } },
}));

// Import AFTER mocks (vitest hoists vi.mock).
const { createIbatexasResolver } = await import("../ibatexas-resolver.js");
const { confirmOnAutoResolveGuard } = await import("../compose-policy-packs.js");

const AMENDABLE_ORDER = { id: "ord_910226", fulfillmentStatus: "pending" };
const OWNED_ORDER_PROJECTION = {
  customerId: "c1",
  fulfillmentStatus: "pending",
  paymentStatus: "paid",
  paymentMethod: "pix",
  totalInCentavos: 5000,
};

beforeEach(() => {
  orderGetById = async () => null;
  orderListByCustomer = async () => ({ orders: [], count: 0 });
  searchProductsMock = async () => ({ products: [] });
  redisGet = async () => null;
});

/** Minimal CognitiveState — only `perception.text` + `conversationId` are
 *  read by the resolver seam under test. */
function cognitionWithText(text: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-07-17T00:00:00.000Z" },
    memory: {},
    retrieval: { docs: [], retrievedAt: "2026-07-17T00:00:00.000Z", modelId: "m" },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  } as unknown as CognitiveState;
}

function cartAddItemPlan(item: string, quantity?: number): Plan {
  return {
    envelopes: [
      buildEnvelope({
        kind: "order.item.add",
        payload: quantity === undefined ? { item } : { item, quantity },
        actor: { principal: "llm", sessionId: "conv-1" },
        taint: "UNTRUSTED",
        nonce: "n-1",
      }),
    ],
  };
}

describe("createIbatexasResolver — FE-T09b amend-preference re-route (BKL-154)", () => {
  it("re-routes order.item.add -> order.amend.add_item on Drive F's exact attempt-3 utterance, and the amend confirm prompt fires", async () => {
    orderListByCustomer = async () => ({ orders: [AMENDABLE_ORDER], count: 1 });
    orderGetById = async () => OWNED_ORDER_PROJECTION;
    searchProductsMock = async () => ({
      products: [
        { id: "prod_1", title: "Refrigerante Guaraná", variants: [{ id: "var_guarana" }], allergens: [] },
      ],
    });

    const plan = cartAddItemPlan("refrigerante", 1);
    const cognition = cognitionWithText(
      "quero adicionar um refrigerante no pedido que eu já fiz, o pedido 910226",
    );

    const resolved = await createIbatexasResolver().resolve({
      plan,
      cognition,
      customerId: "c1",
      channel: "web",
    });

    expect(resolved).toHaveLength(1);
    const { envelope, state } = resolved[0]!;

    // The re-route landed: the ADJUDICATED envelope (what gets EXECUTEd,
    // dispatched, and audited) carries the granular amend kind, never the
    // sibling cart-op kind the model proposed.
    expect(envelope.kind).toBe("order.amend.add_item");

    // The item/quantity threaded through and hydrated (variantId/allergens
    // via resolveProductForItem — the SAME resolver path order.item.add
    // already used).
    const payload = envelope.payload as { item?: string; variantId?: string; allergens?: string[] };
    expect(payload.item).toBe("refrigerante");
    expect(payload.variantId).toBe("var_guarana");
    expect(payload.allergens).toEqual([]);

    // No orderId was ever shown to the model (order-amend-granular.schema.ts
    // forbids it) — ORDER_AUTORESOLVE_KINDS auto-resolved it to the
    // customer's most-recent order and stamped the confirm flag.
    const ctx = (state as { ctx?: { autoResolvedMoneyRef?: boolean; orderId?: string } }).ctx;
    expect(ctx?.orderId).toBe("ord_910226");
    expect(ctx?.autoResolvedMoneyRef).toBe(true);

    // Reply honesty (ticket item 3) — the EXISTING guard (no new confirm
    // machinery) fires REQUEST_CONFIRMATION with the amend prompt for this
    // exact envelope/state, not a mocked stand-in.
    const decision = confirmOnAutoResolveGuard(envelope, state as never);
    expect(decision?.kind).toBe("REQUEST_CONFIRMATION");
  });

  it("does NOT re-route ordinary cart-building ('quero uma coca') even with an amendable order on file — the adversarial bar stays friction-free", async () => {
    orderListByCustomer = async () => ({ orders: [AMENDABLE_ORDER], count: 1 });
    searchProductsMock = async () => ({
      products: [{ id: "prod_2", title: "Coca-Cola 350ml", variants: [{ id: "var_coke" }], allergens: [] }],
    });

    const plan = cartAddItemPlan("coca", 1);
    const cognition = cognitionWithText("quero uma coca");

    const resolved = await createIbatexasResolver().resolve({
      plan,
      cognition,
      customerId: "c1",
      channel: "web",
    });

    expect(resolved[0]!.envelope.kind).toBe("order.item.add");
  });

  it("does NOT re-route when the customer has no amendable order, even with existing-order phrasing", async () => {
    orderListByCustomer = async () => ({ orders: [], count: 0 });
    searchProductsMock = async () => ({
      products: [{ id: "prod_1", title: "Refrigerante Guaraná", variants: [{ id: "var_g" }], allergens: [] }],
    });

    const plan = cartAddItemPlan("refrigerante", 1);
    const cognition = cognitionWithText("no pedido que eu já fiz");

    const resolved = await createIbatexasResolver().resolve({
      plan,
      cognition,
      customerId: "c1",
      channel: "web",
    });

    expect(resolved[0]!.envelope.kind).toBe("order.item.add");
  });
});
