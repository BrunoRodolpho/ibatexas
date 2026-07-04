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
// Owner-scoped payment count (BKL-079): the real countByCustomer counts ALL of the
// owner's payments via the `where: { order: { customerId } }` join.
let paymentCountByCustomer: (customerId: string) => Promise<number> = async () => 0;
let reservationGetById: (id: string, customerId: string) => Promise<unknown> = async (
  id,
  customerId,
) => {
  if (customerId !== OWNER) throw new Error("forbidden");
  return { id, status: "confirmed", partySize: 4, customerId: OWNER };
};
// Per-turn schedule read-through call counter — proves the open/closed signal +
// the override falsifier share ONE loadSchedule() per backend (turn).
let loadScheduleCalls = 0;

vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    getById: (id: string, opts?: { customerId?: string }) => orderGetById(id, opts),
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: (orderId: string) => paymentGetActive(orderId),
    countByCustomer: (customerId: string) => paymentCountByCustomer(customerId),
  }),
  createReservationService: () => ({
    getById: (id: string, customerId: string) => reservationGetById(id, customerId),
  }),
}));
vi.mock("@ibatexas/tools", () => ({
  loadSchedule: async () => {
    loadScheduleCalls++;
    return { overrides: [] };
  },
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
  paymentCountByCustomer = async () => 0;
  reservationGetById = async (id, customerId) => {
    if (customerId !== OWNER) throw new Error("forbidden");
    return { id, status: "confirmed", partySize: 4, customerId: OWNER };
  };
  loadScheduleCalls = 0;
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

// ── countActivePayments (BKL-079 owner-scoped payment enumeration count) ───────

describe("turn-reads — countActivePayments (BKL-079)", () => {
  it("returns the owner-scoped payment count via countByCustomer", async () => {
    paymentCountByCustomer = async (customerId) => (customerId === OWNER ? 3 : 0);
    const backend = createDomainTriadReadBackend();
    // Owner-scoped by construction — keyed ONLY by the passed customerId.
    expect(await backend.countActivePayments(OWNER)).toBe(3);
    expect(await backend.countActivePayments(ATTACKER)).toBe(0);
  });

  it("returns 0 for a customer with no payment rows (the provable-empty witness)", async () => {
    paymentCountByCustomer = async () => 0;
    const backend = createDomainTriadReadBackend();
    expect(await backend.countActivePayments(OWNER)).toBe(0);
  });
});

// ── Per-turn memoization (no cross-turn cache; owner-scoped) ──────────────────

describe("turn-reads — per-turn memoization", () => {
  it("shares ONE owner-scoped getById across fulfillment + payment (identical read runs once)", async () => {
    let getByIdCalls = 0;
    orderGetById = async (id, opts) => {
      getByIdCalls++;
      return opts?.customerId === OWNER
        ? { id, customerId: OWNER, fulfillmentStatus: "preparing", paymentStatus: "paid" }
        : null;
    };
    const backend = createDomainTriadReadBackend();
    const [ful, pay] = await Promise.all([
      backend.readOrderFulfillment(ORDER_ID, OWNER),
      backend.readPaymentStatus(ORDER_ID, OWNER),
    ]);
    expect(ful).toEqual({ orderId: ORDER_ID, fulfillmentStatus: "preparing" });
    expect(pay).toEqual({ orderId: ORDER_ID, status: "paid", method: "pix" });
    // The identical owner-scoped getById ran ONCE this turn (memoized), not twice.
    expect(getByIdCalls).toBe(1);
  });

  it("keeps owner-scoping: a cross-owner read does NOT reuse the owner's cached order", async () => {
    let getByIdCalls = 0;
    orderGetById = async (id, opts) => {
      getByIdCalls++;
      return opts?.customerId === OWNER
        ? { id, customerId: OWNER, fulfillmentStatus: "preparing", paymentStatus: "paid" }
        : null;
    };
    const backend = createDomainTriadReadBackend();
    // Different owners → distinct cache keys → the attacker never sees the owner's row.
    expect(await backend.readOrderFulfillment(ORDER_ID, OWNER)).not.toBeNull();
    expect(await backend.readOrderFulfillment(ORDER_ID, ATTACKER)).toBeNull();
    expect(getByIdCalls).toBe(2);
  });

  it("loads the schedule ONCE for both the open/closed signal and the override read", async () => {
    const backend = createDomainTriadReadBackend();
    const [sig, override] = await Promise.all([
      backend.readSchedule(),
      backend.readScheduleOverride(),
    ]);
    expect(sig).toEqual({ isClosed: false, mealPeriod: "dinner" });
    expect(override).toBeNull(); // no override today → falsifier stays absent
    // Single read-through this turn (memoized), not one per read.
    expect(loadScheduleCalls).toBe(1);
  });

  it("a fresh backend (next turn) re-reads — the memo is per-turn, not cross-turn", async () => {
    const first = createDomainTriadReadBackend();
    await first.readSchedule();
    await first.readScheduleOverride();
    expect(loadScheduleCalls).toBe(1);
    // A new backend instance == a new turn → a fresh read-through, no stale cache.
    const second = createDomainTriadReadBackend();
    await second.readSchedule();
    expect(loadScheduleCalls).toBe(2);
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
