// Reservation service concurrency tests
//
// Validates:
//   1. Concurrent reservation requests for the last slot — only one succeeds (TOCTOU fix)
//   2. reservedCovers cannot go below 0

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Prisma — hoisted to avoid initialization order issues ───────────────

const mockTransaction = vi.hoisted(() => vi.fn());
const mockReservationFindUnique = vi.hoisted(() => vi.fn());
const mockTimeSlotFindUnique = vi.hoisted(() => vi.fn());
// FE-T17b review fix — listByCustomer's findMany/count, mocked separately so the
// pagination-burying regression test can inject a FAITHFUL where/orderBy/take
// simulation without touching the create/modify tests above.
const mockReservationFindMany = vi.hoisted(() => vi.fn());
const mockReservationCount = vi.hoisted(() => vi.fn());

vi.mock("../../client.js", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockTransaction(...args),
    reservation: {
      create: vi.fn(),
      findUnique: (...args: unknown[]) => mockReservationFindUnique(...args),
      update: vi.fn(),
      findMany: (...args: unknown[]) => mockReservationFindMany(...args),
      count: (...args: unknown[]) => mockReservationCount(...args),
    },
    timeSlot: { update: vi.fn(), findUnique: (...args: unknown[]) => mockTimeSlotFindUnique(...args) },
    reservationTable: { findMany: vi.fn(), deleteMany: vi.fn() },
    table: { findMany: vi.fn() },
  },
}));

// The module uses Prisma.sql + Prisma.join — we need a minimal mock. `join`
// returns a marker object so tests can inspect the interpolated id list.
vi.mock("../../generated/prisma-client/client.js", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    join: (values: unknown[], separator = ",") => ({ __join: values, separator }),
  },
  PrismaReservationStatus: {},
}));

import { createReservationService } from "../reservation.service.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTimeSlotRow(overrides: Partial<{
  id: string; maxCovers: number; reservedCovers: number;
}> = {}) {
  return {
    id: overrides.id ?? "slot_01",
    date: new Date("2026-03-18"),
    startTime: "19:00",
    durationMinutes: 120,
    maxCovers: overrides.maxCovers ?? 20,
    reservedCovers: overrides.reservedCovers ?? 18,
    createdAt: new Date(),
  };
}

function makeReservationRow(overrides: Partial<{
  id: string; customerId: string; partySize: number; status: string;
}> = {}) {
  return {
    id: overrides.id ?? "res_01",
    customerId: overrides.customerId ?? "cust_01",
    partySize: overrides.partySize ?? 2,
    status: overrides.status ?? "confirmed",
    specialRequests: [],
    confirmedAt: new Date(),
    checkedInAt: null,
    cancelledAt: null,
    noShowAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    timeSlotId: "slot_01",
    timeSlot: makeTimeSlotRow(),
    tables: [
      {
        reservationId: overrides.id ?? "res_01",
        tableId: "table_01",
        table: { id: "table_01", number: "1", capacity: 4, location: "indoor", active: true, createdAt: new Date() },
      },
    ],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ReservationService.create — concurrency safety (TOCTOU fix)", () => {
  let svc: ReturnType<typeof createReservationService>;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = createReservationService();
  });

  it("succeeds when there are enough covers available", async () => {
    // Slot has 20 max, 18 reserved → 2 available, requesting 2
    const slot = makeTimeSlotRow({ reservedCovers: 18, maxCovers: 20 });

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([slot]),
        reservationTable: { findMany: vi.fn().mockResolvedValue([]) },
        table: { findMany: vi.fn().mockResolvedValue([
          { id: "table_01", number: "1", capacity: 4, location: "indoor", active: true, createdAt: new Date() },
        ]) },
        reservation: {
          create: vi.fn().mockResolvedValue(makeReservationRow()),
        },
        timeSlot: { update: vi.fn().mockResolvedValue(slot) },
      };
      return fn(tx);
    });

    const result = await svc.create({
      customerId: "cust_01",
      timeSlotId: "slot_01",
      partySize: 2,
    });

    expect(result.reservation).toBeDefined();
    expect(result.reservation.id).toBe("res_01");
    expect(result.reservation.status).toBe("confirmed");
  });

  it("rejects when last slot is taken by a concurrent request — TOCTOU prevented by FOR UPDATE lock", async () => {
    // The FOR UPDATE lock ensures that when the second request reads the slot,
    // it sees the updated reservedCovers from the first request.
    // Simulate: slot has 20 max, 19 reserved → only 1 cover left, requesting 2
    const slot = makeTimeSlotRow({ reservedCovers: 19, maxCovers: 20 });

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        // SELECT ... FOR UPDATE returns the already-incremented slot
        $queryRaw: vi.fn().mockResolvedValue([slot]),
        reservationTable: { findMany: vi.fn().mockResolvedValue([]) },
        table: { findMany: vi.fn().mockResolvedValue([]) },
        reservation: { create: vi.fn() },
        timeSlot: { update: vi.fn() },
      };
      return fn(tx);
    });

    await expect(
      svc.create({
        customerId: "cust_02",
        timeSlotId: "slot_01",
        partySize: 2,
      }),
    ).rejects.toThrow("esgotado");
  });

  it("handles two concurrent requests — second one fails when both race for last slot", async () => {
    let callCount = 0;

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      callCount++;
      const isFirstRequest = callCount === 1;

      // First request sees 18 reserved (2 available, wants 2) → succeeds
      // Second request sees 20 reserved (0 available, wants 2) → fails
      const slot = makeTimeSlotRow({
        reservedCovers: isFirstRequest ? 18 : 20,
        maxCovers: 20,
      });

      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([slot]),
        reservationTable: { findMany: vi.fn().mockResolvedValue([]) },
        table: {
          findMany: vi.fn().mockResolvedValue(
            isFirstRequest
              ? [{ id: "table_01", number: "1", capacity: 4, location: "indoor", active: true, createdAt: new Date() }]
              : [],
          ),
        },
        reservation: {
          create: vi.fn().mockResolvedValue(makeReservationRow({ id: `res_0${callCount}` })),
        },
        timeSlot: { update: vi.fn() },
      };
      return fn(tx);
    });

    // Run both concurrently
    const results = await Promise.allSettled([
      svc.create({ customerId: "cust_01", timeSlotId: "slot_01", partySize: 2 }),
      svc.create({ customerId: "cust_02", timeSlotId: "slot_01", partySize: 2 }),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason.message).toContain("esgotado");
  });

  it("rejects when slot does not exist", async () => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        reservationTable: { findMany: vi.fn() },
        table: { findMany: vi.fn() },
        reservation: { create: vi.fn() },
        timeSlot: { update: vi.fn() },
      };
      return fn(tx);
    });

    await expect(
      svc.create({
        customerId: "cust_01",
        timeSlotId: "nonexistent",
        partySize: 2,
      }),
    ).rejects.toThrow("Horário não encontrado");
  });

  it("rejects when reservedCovers exactly equals maxCovers (zero availability)", async () => {
    const slot = makeTimeSlotRow({ reservedCovers: 20, maxCovers: 20 });

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([slot]),
        reservationTable: { findMany: vi.fn() },
        table: { findMany: vi.fn() },
        reservation: { create: vi.fn() },
        timeSlot: { update: vi.fn() },
      };
      return fn(tx);
    });

    await expect(
      svc.create({
        customerId: "cust_01",
        timeSlotId: "slot_01",
        partySize: 1,
      }),
    ).rejects.toThrow("esgotado");
  });
});

describe("ReservationService.modify — concurrency safety (TOCTOU)", () => {
  let svc: ReturnType<typeof createReservationService>;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = createReservationService();
  });

  it("two concurrent modifies to the same new slot — only one succeeds, second rejected by FOR UPDATE lock", async () => {
    // Existing reservation on slot_01 (the one being changed away from)
    const existingReservation = makeReservationRow({
      id: "res_01",
      customerId: "cust_01",
      partySize: 2,
      status: "confirmed",
    });
    // Both concurrent requests read the same existing reservation
    mockReservationFindUnique.mockResolvedValue(existingReservation);

    // New target slot: stale read (what the buggy out-of-tx prisma.timeSlot.findUnique sees)
    // It shows 18 reserved / 20 max → 2 available. Both concurrent callers see this
    // because the lock-free check runs before either transaction commits.
    const staleNewSlot = {
      id: "slot_02",
      date: new Date("2026-03-18"),
      startTime: "20:00",
      durationMinutes: 120,
      maxCovers: 20,
      reservedCovers: 18,
      createdAt: new Date(),
    };
    mockTimeSlotFindUnique.mockResolvedValue(staleNewSlot);

    // Under the FIXED code the tx.$queryRaw (FOR UPDATE) sees the true state:
    //   call 1 → 18 reserved (2 available, partySize 2) → succeeds
    //   call 2 → 20 reserved (0 available, partySize 2) → throws
    let queryRawCallCount = 0;

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      queryRawCallCount++;
      const isFirst = queryRawCallCount === 1;

      // What the in-tx FOR UPDATE lock returns for the new slot
      const lockedNewSlot = {
        ...staleNewSlot,
        reservedCovers: isFirst ? 18 : 20, // first caller has space, second does not
      };

      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([lockedNewSlot]),
        timeSlot: { update: vi.fn().mockResolvedValue({}) },
        reservationTable: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        table: {
          findMany: vi.fn().mockResolvedValue(
            isFirst
              ? [{ id: "table_02", number: "2", capacity: 4, location: "indoor", active: true, createdAt: new Date() }]
              : [],
          ),
        },
        reservation: {
          update: vi.fn().mockResolvedValue({
            ...existingReservation,
            timeSlotId: "slot_02",
            timeSlot: { ...staleNewSlot },
          }),
        },
      };
      return fn(tx);
    });

    const results = await Promise.allSettled([
      svc.modify("res_01", "cust_01", { newTimeSlotId: "slot_02", newPartySize: 2 }),
      svc.modify("res_01", "cust_01", { newTimeSlotId: "slot_02", newPartySize: 2 }),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    // With the BUGGY code both succeed (both pass the unlocked out-of-tx check → overbook)
    // With the FIXED code only one succeeds (second sees full slot under FOR UPDATE lock)
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason.message).toContain("não tem vagas para 2 pessoa(s)");
  });

  it("[C3] locks BOTH old and new slots in deterministic id order (deadlock-safe)", async () => {
    // existing reservation sits on slot_01; moving to slot_02.
    const existingReservation = makeReservationRow({
      id: "res_01",
      customerId: "cust_01",
      partySize: 2,
      status: "confirmed",
    });
    mockReservationFindUnique.mockResolvedValue(existingReservation);

    let capturedSql: { strings: string[]; values: unknown[] } | undefined;
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn(async (sql: { strings: string[]; values: unknown[] }) => {
          capturedSql = sql;
          // The lock returns both rows; modify().find() picks the new slot.
          return [
            makeTimeSlotRow({ id: "slot_01", reservedCovers: 2, maxCovers: 20 }),
            makeTimeSlotRow({ id: "slot_02", reservedCovers: 10, maxCovers: 20 }),
          ];
        }),
        timeSlot: { update: vi.fn().mockResolvedValue({}) },
        reservationTable: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        table: {
          findMany: vi.fn().mockResolvedValue([
            { id: "table_02", number: "2", capacity: 4, location: "indoor", active: true, createdAt: new Date() },
          ]),
        },
        reservation: {
          update: vi.fn().mockResolvedValue({
            ...existingReservation,
            timeSlotId: "slot_02",
            timeSlot: makeTimeSlotRow({ id: "slot_02" }),
          }),
        },
      };
      return fn(tx);
    });

    await svc.modify("res_01", "cust_01", { newTimeSlotId: "slot_02", newPartySize: 2 });

    // The single FOR UPDATE lock query references BOTH slots and orders by id —
    // a consistent global lock order that prevents the AB-BA swap deadlock.
    expect(capturedSql).toBeDefined();
    const text = capturedSql!.strings.join(" ");
    expect(text).toMatch(/ORDER BY id/i);
    expect(text).toMatch(/FOR UPDATE/i);
    const joined = capturedSql!.values[0] as { __join: string[] };
    expect(joined.__join).toEqual(expect.arrayContaining(["slot_01", "slot_02"]));
  });
});

// ── FE-T17b review fix — listByCustomer status filter + pagination-burying ─────
//
// `listByCustomer` orders by `timeSlot.date` DESC (farthest-future FIRST), so a
// caller that fetches WITHOUT a status filter and applies `take` BEFORE any
// client-side status filter can have a near-future MATCHING row buried past the
// page by a block of far-future NON-matching rows (e.g. cancelled reservations
// dated well ahead of an upcoming confirmed one). The fix threads `status` as a
// query-level WHERE clause (Prisma `{ in: [...] }` for an array) so the DB filters
// BEFORE `take` is applied — the limit is spent only on rows that could actually
// match. This mock FAITHFULLY reproduces real Prisma where/orderBy/take semantics
// (filter → sort → limit, in that order) so the test is a genuine regression
// guard, not a tautology over a stub that already assumes the fix.
describe("ReservationService.listByCustomer — status filter + pagination-burying fix (FE-T17b review)", () => {
  const CUSTOMER = "cust_burying";

  /** A single fixture row: a customer-owned reservation with an explicit
   *  status + time-slot date/time (independent of the shared makeReservationRow
   *  helper, whose timeSlot date is fixed — this test needs many distinct dates). */
  function row(id: string, status: string, isoDate: string, startTime: string) {
    return {
      id,
      customerId: CUSTOMER,
      partySize: 2,
      status,
      specialRequests: [],
      confirmedAt: null,
      checkedInAt: null,
      cancelledAt: null,
      noShowAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      timeSlotId: `slot_${id}`,
      timeSlot: {
        id: `slot_${id}`,
        date: new Date(`${isoDate}T00:00:00.000Z`),
        startTime,
        durationMinutes: 120,
        maxCovers: 20,
        reservedCovers: 2,
        createdAt: new Date(),
      },
      tables: [],
    };
  }

  // 22 CANCELLED reservations, far-future dated (2027-02-01 .. 2027-02-22) — every
  // one sorts AHEAD of the confirmed row below under `orderBy timeSlot.date desc`.
  // 22 > the service's `take: 20` default page — enough to bury a same-page target.
  const buriedCancelled = Array.from({ length: 22 }, (_, i) =>
    row(
      `res_cancelled_${i}`,
      "cancelled",
      `2027-02-${String(i + 1).padStart(2, "0")}`,
      "19:00",
    ),
  );
  // The ONE near-future ACTIVE (confirmed) reservation — dated BEFORE all 22
  // cancelled rows, so it sorts LAST among this customer's reservations.
  const nearFutureConfirmed = row("res_confirmed", "confirmed", "2026-08-01", "19:30");

  const fixture = [...buriedCancelled, nearFutureConfirmed];

  /** A FAITHFUL (filter → sort → limit) simulation of the real Prisma query
   *  `listByCustomer` issues — not a stub that special-cases the expected call. */
  function simulateQuery(args: {
    where?: { customerId?: string; status?: { in?: string[] } | string };
    take?: number;
  }): typeof fixture {
    let rows = fixture.filter((r) => r.customerId === args.where?.customerId);
    const statusArg = args.where?.status;
    if (typeof statusArg === "string") {
      rows = rows.filter((r) => r.status === statusArg);
    } else if (statusArg && Array.isArray(statusArg.in)) {
      rows = rows.filter((r) => statusArg.in!.includes(r.status));
    }
    rows = [...rows].sort((a, b) => {
      const byDate = b.timeSlot.date.getTime() - a.timeSlot.date.getTime();
      return byDate !== 0 ? byDate : b.timeSlot.startTime.localeCompare(a.timeSlot.startTime);
    });
    return args.take !== undefined ? rows.slice(0, args.take) : rows;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockReservationFindMany.mockImplementation(async (args: Parameters<typeof simulateQuery>[0]) =>
      simulateQuery(args),
    );
    mockReservationCount.mockImplementation(
      async (args: Parameters<typeof simulateQuery>[0]) =>
        simulateQuery({ ...args, take: undefined }).length,
    );
  });

  it("NON-VACUITY — without a status filter, take:20 genuinely buries the confirmed row (proves the fixture reproduces the bug)", async () => {
    const svc = createReservationService();
    const { reservations } = await svc.listByCustomer(CUSTOMER, { limit: 20 });
    expect(reservations.map((r) => r.id)).not.toContain("res_confirmed");
    expect(reservations).toHaveLength(20);
  });

  it("THE FIX — status:[pending,confirmed,seated] filters server-side BEFORE take, so the confirmed row is never buried", async () => {
    const svc = createReservationService();
    const { reservations } = await svc.listByCustomer(CUSTOMER, {
      limit: 20,
      status: ["pending", "confirmed", "seated"],
    });
    expect(reservations.map((r) => r.id)).toEqual(["res_confirmed"]);
  });

  it("passes status as a Prisma `{ in: [...] }` clause when given an array", async () => {
    const svc = createReservationService();
    await svc.listByCustomer(CUSTOMER, { status: ["pending", "confirmed", "seated"] });
    expect(mockReservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["pending", "confirmed", "seated"] },
        }),
      }),
    );
  });

  it("preserves the EXISTING single-status behavior (exact match, not `{ in: [...] }`) for backward compatibility", async () => {
    const svc = createReservationService();
    await svc.listByCustomer(CUSTOMER, { status: "confirmed" });
    expect(mockReservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "confirmed" }),
      }),
    );
  });
});
