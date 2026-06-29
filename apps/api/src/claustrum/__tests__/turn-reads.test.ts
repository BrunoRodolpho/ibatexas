/**
 * turn-reads — the FIRST-PARTY, OWNER-SCOPED read backend the INVESTIGATE stage
 * gathers triad evidence from. These tests pin the LOAD-BEARING contract:
 *
 *   - PAYMENT_STATUS IDOR CLOSE (Inv 2/13): a cross-owner orderId yields `null`
 *     (refused/empty) — the payment is NEVER read — while the OWNER's own read
 *     returns the concrete status. Proven at BOTH layers (the owner-scoped
 *     getById call AND the post-check).
 *   - ORDER_FULFILLMENT_STAGE + reservation reads are owner-scoped the same way.
 *   - extractTurnResourceIds pulls (deduped) order/reservation ids from the
 *     resolved plan envelopes + read-tool inputs (pure).
 *
 * Pure unit tests — the `@ibatexas/domain` query services are mocked; no DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mutable mock controls ────────────────────────────────────────────────────
const OWNER = "cust-owner";
const ATTACKER = "cust-attacker";
const ORDER_ID = "order-42";

// Owner-scoped getById: returns the order ONLY when opts.customerId is the owner
// (mirrors the real domain owner-scoping); a non-owner gets `null`.
let orderGetById: (id: string, opts?: { customerId?: string }) => Promise<unknown> =
  async (id, opts) =>
    opts?.customerId === OWNER
      ? { id, customerId: OWNER, fulfillmentStatus: "preparing", paymentStatus: "paid" }
      : null;
let paymentGetActive: (orderId: string) => Promise<unknown> = async () => ({
  status: "paid",
  method: "pix",
});
let reservationGetById: (id: string, customerId: string) => Promise<unknown> = async (
  id,
  customerId,
) => {
  if (customerId !== OWNER) throw new Error("forbidden");
  return { id, status: "confirmed", partySize: 4, customerId: OWNER };
};

vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    getById: (id: string, opts?: { customerId?: string }) => orderGetById(id, opts),
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: (orderId: string) => paymentGetActive(orderId),
  }),
  createReservationService: () => ({
    getById: (id: string, customerId: string) => reservationGetById(id, customerId),
  }),
}));
vi.mock("@ibatexas/tools", () => ({
  loadSchedule: async () => ({}),
  getScheduleSignal: () => ({ isClosed: false, mealPeriod: "dinner" }),
}));

const {
  createDomainTriadReadBackend,
  extractTurnResourceIds,
} = await import("../turn-reads.js");

beforeEach(() => {
  orderGetById = async (id, opts) =>
    opts?.customerId === OWNER
      ? { id, customerId: OWNER, fulfillmentStatus: "preparing", paymentStatus: "paid" }
      : null;
  paymentGetActive = async () => ({ status: "paid", method: "pix" });
  reservationGetById = async (id, customerId) => {
    if (customerId !== OWNER) throw new Error("forbidden");
    return { id, status: "confirmed", partySize: 4, customerId: OWNER };
  };
});

// ── PAYMENT_STATUS IDOR close ────────────────────────────────────────────────

describe("turn-reads — PAYMENT_STATUS owner-scoping (IDOR close)", () => {
  it("the OWNER's own payment-status read succeeds", async () => {
    const backend = createDomainTriadReadBackend();
    const read = await backend.readPaymentStatus(ORDER_ID, OWNER);
    expect(read).toEqual({ orderId: ORDER_ID, status: "paid", method: "pix" });
  });

  it("a CROSS-OWNER payment-status read is refused (null) — payment never read", async () => {
    let paymentReadCalled = false;
    paymentGetActive = async () => {
      paymentReadCalled = true;
      return { status: "paid", method: "pix" };
    };
    const backend = createDomainTriadReadBackend();
    const read = await backend.readPaymentStatus(ORDER_ID, ATTACKER);
    // Refused/empty — the attacker gets NOTHING, and the payment read is never
    // reached (gated behind the owner-scoped order read).
    expect(read).toBeNull();
    expect(paymentReadCalled).toBe(false);
  });

  it("defense in depth: even if getById ignored the customerId scope, the post-check refuses", async () => {
    // Simulate an UNSCOPED getById (returns the owner's order regardless of opts).
    orderGetById = async (id) => ({
      id,
      customerId: OWNER,
      fulfillmentStatus: "preparing",
      paymentStatus: "paid",
    });
    const backend = createDomainTriadReadBackend();
    expect(await backend.readPaymentStatus(ORDER_ID, ATTACKER)).toBeNull();
    expect(await backend.readPaymentStatus(ORDER_ID, OWNER)).not.toBeNull();
  });

  it("an owned order with NO active payment reads null (absent), not another's data", async () => {
    paymentGetActive = async () => null;
    const backend = createDomainTriadReadBackend();
    expect(await backend.readPaymentStatus(ORDER_ID, OWNER)).toBeNull();
  });
});

// ── ORDER_FULFILLMENT_STAGE + reservation owner-scoping ──────────────────────

describe("turn-reads — order/reservation owner-scoping", () => {
  it("owner reads fulfillment stage; cross-owner is refused (null)", async () => {
    const backend = createDomainTriadReadBackend();
    expect(await backend.readOrderFulfillment(ORDER_ID, OWNER)).toEqual({
      orderId: ORDER_ID,
      fulfillmentStatus: "preparing",
    });
    expect(await backend.readOrderFulfillment(ORDER_ID, ATTACKER)).toBeNull();
  });

  it("owner reads reservation; cross-owner (ownership throw) is refused (null)", async () => {
    const backend = createDomainTriadReadBackend();
    expect(await backend.readReservation("r-1", OWNER)).toEqual({
      reservationId: "r-1",
      status: "confirmed",
      partySize: 4,
    });
    expect(await backend.readReservation("r-1", ATTACKER)).toBeNull();
  });

  it("reads the injected first-party schedule signal", async () => {
    const backend = createDomainTriadReadBackend({
      schedule: async () => ({ isClosed: true, mealPeriod: "closed", nextOpenDay: "amanhã" }),
    });
    expect(await backend.readSchedule()).toEqual({
      isClosed: true,
      mealPeriod: "closed",
      nextOpenDay: "amanhã",
    });
  });
});

// ── extractTurnResourceIds (pure) ─────────────────────────────────────────────

describe("turn-reads — extractTurnResourceIds", () => {
  it("collects + dedups order/reservation ids from envelopes and read-tool inputs", () => {
    const ids = extractTurnResourceIds({
      envelopes: [
        { payload: { orderId: "o-1" } },
        { payload: { reservationId: "r-1" } },
        { payload: { orderId: "o-1" } }, // dup
      ],
      readToolCalls: [
        { input: { orderId: "o-2" } },
        { input: { reservationId: "r-1" } }, // dup
        { input: { q: "linguiça" } }, // no id
      ],
    });
    expect(ids.orderIds).toEqual(["o-1", "o-2"]);
    expect(ids.reservationIds).toEqual(["r-1"]);
  });

  it("ignores non-string / empty / missing ids", () => {
    const ids = extractTurnResourceIds({
      envelopes: [{ payload: { orderId: 123 } }, { payload: {} }, { payload: null }],
      readToolCalls: [{ input: { orderId: "" } }],
    });
    expect(ids.orderIds).toEqual([]);
    expect(ids.reservationIds).toEqual([]);
  });
});
