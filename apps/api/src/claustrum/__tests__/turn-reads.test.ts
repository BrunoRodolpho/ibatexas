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
// FE-T17b — the discovery-fallback query. Default: no reservations (tests that
// exercise discovery override this).
let reservationListByCustomer: (
  customerId: string,
  options?: { status?: string | readonly string[]; limit?: number },
) => Promise<{ reservations: unknown[]; total: number }> = async () => ({
  reservations: [],
  total: 0,
});
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
    listByCustomer: (
      customerId: string,
      options?: { status?: string | readonly string[]; limit?: number },
    ) => reservationListByCustomer(customerId, options),
  }),
}));
// BKL-121 default-backend controls: today's-hours value + the holiday table the
// (mocked) schedule carries. `null` hours = schedule unavailable (must THROW).
let todayHoursText: string | null = "11h\u201315h / 18h\u201323h";
let scheduleHolidays: Array<{ date: string; name: string }> = [];

vi.mock("@ibatexas/tools", () => ({
  loadSchedule: async () => {
    loadScheduleCalls++;
    return { overrides: [], holidays: scheduleHolidays };
  },
  getScheduleSignal: () => ({ isClosed: false, mealPeriod: "dinner" }),
  getTodayHoursText: () => todayHoursText,
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
  reservationListByCustomer = async () => ({ reservations: [], total: 0 });
  loadScheduleCalls = 0;
  todayHoursText = "11h\u201315h / 18h\u201323h";
  scheduleHolidays = [];
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
      // BKL-185 — the pre-composed localized scalar (bare: the DTO stub has no slot).
      statusLine: "confirmada",
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

// ── FE-T17b review fix — listActiveReservationIds status filter + pagination ───
//
// Closes the loop between the domain-level fix (reservation.test.ts
// `listByCustomer` status-filter tests) and the caller: `listActiveReservationIds`
// MUST pass `status: [...ACTIVE_RESERVATION_STATUSES]` to `listByCustomer` so the
// DB filters BEFORE `take`, never relying on the client-side filter alone to
// survive a pagination-burying scenario (a block of far-future non-active
// reservations sorting ahead of a near-future active one).
describe("turn-reads — listActiveReservationIds (FE-T17b discovery + pagination-burying fix)", () => {
  it("passes the active-status set to listByCustomer as a server-side filter", async () => {
    let capturedOptions: { status?: string | readonly string[]; limit?: number } | undefined;
    reservationListByCustomer = async (customerId, options) => {
      capturedOptions = options;
      return { reservations: [], total: 0 };
    };
    const backend = createDomainTriadReadBackend();
    await backend.listActiveReservationIds(OWNER);
    expect(capturedOptions?.status).toEqual(
      expect.arrayContaining(["pending", "confirmed", "seated"]),
    );
    expect(capturedOptions?.status).toHaveLength(3);
  });

  it("REGRESSION (pagination-burying) — discovery still yields the near-future confirmed id even behind >20 far-future cancelled reservations", async () => {
    // FAITHFUL (filter → sort → limit) simulation of the real Prisma query, mirroring
    // the domain-level reservation.test.ts fixture: 22 far-future CANCELLED rows
    // (2027-02-01..22) that would bury a near-future (2026-08-01) CONFIRMED row past
    // a `take:20` page if the status filter were only applied client-side.
    const buried = Array.from({ length: 22 }, (_, i) => ({
      id: `res_cancelled_${i}`,
      status: "cancelled",
      date: new Date(`2027-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
    }));
    const nearFutureConfirmed = {
      id: "res_confirmed",
      status: "confirmed",
      date: new Date("2026-08-01T00:00:00.000Z"),
    };
    const rows = [...buried, nearFutureConfirmed];

    reservationListByCustomer = async (customerId, options) => {
      if (customerId !== OWNER) return { reservations: [], total: 0 };
      let filtered = rows;
      const statusArg = options?.status;
      if (typeof statusArg === "string") {
        filtered = filtered.filter((r) => r.status === statusArg);
      } else if (Array.isArray(statusArg)) {
        filtered = filtered.filter((r) => statusArg.includes(r.status));
      }
      filtered = [...filtered].sort((a, b) => b.date.getTime() - a.date.getTime());
      const paged = options?.limit !== undefined ? filtered.slice(0, options.limit) : filtered;
      return {
        reservations: paged.map((r) => ({ id: r.id, status: r.status, partySize: 2 })),
        total: filtered.length,
      };
    };

    const backend = createDomainTriadReadBackend();
    const ids = await backend.listActiveReservationIds(OWNER);

    // The fix: the confirmed row is discovered despite 22 far-future cancelled
    // rows that would otherwise bury it past a client-side-only `take: 20` page.
    expect(ids).toContain("res_confirmed");
    expect(ids).not.toEqual(expect.arrayContaining(["res_cancelled_0"]));
  });

  it("a customer with zero active reservations returns []", async () => {
    reservationListByCustomer = async () => ({ reservations: [], total: 0 });
    const backend = createDomainTriadReadBackend();
    expect(await backend.listActiveReservationIds(OWNER)).toEqual([]);
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

// ── STORE_HOURS + holiday default reads (BKL-121 backend wiring) ───────────────

describe("turn-reads — STORE_HOURS / holiday default backend (BKL-121)", () => {
  it("readStoreHours returns today's hours from the per-turn schedule memo", async () => {
    const backend = createDomainTriadReadBackend();
    await expect(backend.readStoreHours()).resolves.toEqual({
      hoursText: "11h\u201315h / 18h\u201323h",
    });
  });

  it("readStoreHours THROWS (Inv 7 read error) when the schedule is unavailable — never fabricates", async () => {
    todayHoursText = null;
    const backend = createDomainTriadReadBackend();
    await expect(backend.readStoreHours()).rejects.toThrow(/store_hours unavailable/);
  });

  it("readHoliday resolves TODAY's holiday (tz-local date match)", async () => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo",
    }).format(new Date());
    scheduleHolidays = [
      { date: "1999-01-01", name: "Ano antigo" },
      { date: today, name: "Feriado de hoje" },
    ];
    const backend = createDomainTriadReadBackend();
    await expect(backend.readHoliday()).resolves.toEqual({
      date: today,
      name: "Feriado de hoje",
    });
  });

  it("readHoliday resolves null on a non-holiday (falsifier absence, never a fabricated present)", async () => {
    scheduleHolidays = [{ date: "1999-01-01", name: "Ano antigo" }];
    const backend = createDomainTriadReadBackend();
    await expect(backend.readHoliday()).resolves.toBeNull();
  });

  it("hours + holiday + signal + override share ONE schedule load per turn", async () => {
    const backend = createDomainTriadReadBackend();
    await Promise.all([
      backend.readSchedule(),
      backend.readScheduleOverride(),
      backend.readStoreHours(),
      backend.readHoliday(),
    ]);
    expect(loadScheduleCalls).toBe(1);
  });
});
