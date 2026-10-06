// F-47 — `reservationWithRelationsArgs` is a declared single source of truth for
// the reservation relation shape. Its TYPE half was always real (it is the
// `typeof` source for `ReservationWithRelations`, which type-checks `toDTO`).
// Its VALUE half was not: six query sites hand-wrote the same `include` inline.
//
// This suite pins the VALUE half at the Prisma boundary. Each test drives one
// real service method and asserts the `include` that method handed to Prisma.
//
// IMPORTANT — the expected object below is HAND-WRITTEN on purpose. It is NOT
// imported from, spread from, or otherwise derived from
// `reservationWithRelationsArgs`. A control derived from the thing under test
// cannot fail when that thing changes; this one can, and must. Changing the
// SSOT without changing this literal is meant to turn all six tests RED.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Prisma — hoisted, mirroring reservation.test.ts ────────────────────

const mockTransaction = vi.hoisted(() => vi.fn());
const mockReservationFindUnique = vi.hoisted(() => vi.fn());
const mockReservationFindMany = vi.hoisted(() => vi.fn());
const mockReservationCount = vi.hoisted(() => vi.fn());

vi.mock("../../client.js", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockTransaction(...args),
    reservation: {
      findUnique: (...args: unknown[]) => mockReservationFindUnique(...args),
      findMany: (...args: unknown[]) => mockReservationFindMany(...args),
      count: (...args: unknown[]) => mockReservationCount(...args),
      create: vi.fn(),
      update: vi.fn(),
    },
    timeSlot: { update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    reservationTable: { findMany: vi.fn(), deleteMany: vi.fn() },
    table: { findMany: vi.fn() },
  },
}));

vi.mock("../../generated/prisma-client/client.js", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    join: (values: unknown[], separator = ",") => ({ __join: values, separator }),
  },
  PrismaReservationStatus: {},
}));

import { createReservationService } from "../reservation.service.js";

// ── The hand-written control ────────────────────────────────────────────────

const EXPECTED_RELATION_INCLUDE = {
  timeSlot: true,
  tables: { include: { table: true } },
};

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeReservationRow() {
  return {
    id: "res_01",
    displayId: "R-0001",
    customerId: "cust_01",
    partySize: 2,
    status: "confirmed",
    specialRequests: [],
    timeSlotId: "slot_01",
    confirmedAt: new Date("2026-03-01T10:00:00.000Z"),
    checkedInAt: null,
    cancelledAt: null,
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
    updatedAt: new Date("2026-03-01T10:00:00.000Z"),
    timeSlot: {
      id: "slot_01",
      date: new Date("2026-03-18"),
      startTime: "19:00",
      durationMinutes: 120,
      maxCovers: 20,
      reservedCovers: 18,
      createdAt: new Date(),
    },
    tables: [
      {
        reservationId: "res_01",
        tableId: "table_01",
        table: {
          id: "table_01", number: "1", capacity: 4,
          location: "indoor", active: true, createdAt: new Date(),
        },
      },
    ],
  };
}

const TABLE_ROW = {
  id: "table_01", number: "1", capacity: 4,
  location: "indoor", active: true, createdAt: new Date(),
};

const SLOT_ROW = {
  id: "slot_01",
  date: new Date("2026-03-18"),
  startTime: "19:00",
  durationMinutes: 120,
  maxCovers: 20,
  reservedCovers: 10,
  createdAt: new Date(),
};

// ── Site-by-site pins ───────────────────────────────────────────────────────

describe("reservationWithRelationsArgs — the value half, pinned at each query site", () => {
  let svc: ReturnType<typeof createReservationService>;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = createReservationService();
  });

  it("site 1 — getById passes the relation include to reservation.findUnique", async () => {
    mockReservationFindUnique.mockResolvedValue(makeReservationRow());

    await svc.getById("res_01");

    expect(mockReservationFindUnique).toHaveBeenCalledTimes(1);
    expect(mockReservationFindUnique.mock.calls[0]?.[0]).toEqual({
      where: { id: "res_01" },
      include: EXPECTED_RELATION_INCLUDE,
    });
  });

  it("site 2 — listByCustomer passes the relation include to reservation.findMany", async () => {
    mockReservationFindMany.mockResolvedValue([makeReservationRow()]);
    mockReservationCount.mockResolvedValue(1);

    await svc.listByCustomer("cust_01");

    expect(mockReservationFindMany).toHaveBeenCalledTimes(1);
    expect(mockReservationFindMany.mock.calls[0]?.[0]).toEqual({
      where: { customerId: "cust_01" },
      include: EXPECTED_RELATION_INCLUDE,
      orderBy: [{ timeSlot: { date: "desc" } }, { timeSlot: { startTime: "desc" } }],
      take: 10,
    });
  });

  it("site 3 — listAll passes the relation include to reservation.findMany", async () => {
    mockReservationFindMany.mockResolvedValue([makeReservationRow()]);
    mockReservationCount.mockResolvedValue(1);

    await svc.listAll({}, { limit: 20, offset: 0 });

    expect(mockReservationFindMany).toHaveBeenCalledTimes(1);
    expect(mockReservationFindMany.mock.calls[0]?.[0]).toEqual({
      where: {},
      include: EXPECTED_RELATION_INCLUDE,
      orderBy: [{ timeSlot: { date: "asc" } }, { timeSlot: { startTime: "asc" } }],
      take: 20,
      skip: 0,
    });
  });

  it("site 4 — create passes the relation include to tx.reservation.create", async () => {
    const txCreate = vi.fn().mockResolvedValue(makeReservationRow());

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: vi.fn().mockResolvedValue([SLOT_ROW]),
        reservationTable: { findMany: vi.fn().mockResolvedValue([]) },
        table: { findMany: vi.fn().mockResolvedValue([TABLE_ROW]) },
        reservation: { create: txCreate },
        timeSlot: { update: vi.fn().mockResolvedValue(SLOT_ROW) },
      }),
    );

    await svc.create({ customerId: "cust_01", timeSlotId: "slot_01", partySize: 2 });

    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(txCreate.mock.calls[0]?.[0]).toMatchObject({ include: EXPECTED_RELATION_INCLUDE });
    expect(txCreate.mock.calls[0]?.[0]?.include).toEqual(EXPECTED_RELATION_INCLUDE);
  });

  it("site 5 — modify passes the relation include to its reservation.findUnique read", async () => {
    mockReservationFindUnique.mockResolvedValue(makeReservationRow());
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        timeSlot: { update: vi.fn().mockResolvedValue(SLOT_ROW) },
        reservationTable: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        table: { findMany: vi.fn().mockResolvedValue([TABLE_ROW]) },
        reservation: { update: vi.fn().mockResolvedValue(makeReservationRow()) },
      }),
    );

    await svc.modify("res_01", "cust_01", { newPartySize: 3 });

    expect(mockReservationFindUnique).toHaveBeenCalledTimes(1);
    expect(mockReservationFindUnique.mock.calls[0]?.[0]).toEqual({
      where: { id: "res_01" },
      include: EXPECTED_RELATION_INCLUDE,
    });
  });

  it("site 6 — modify passes the relation include to tx.reservation.update", async () => {
    const txUpdate = vi.fn().mockResolvedValue(makeReservationRow());

    mockReservationFindUnique.mockResolvedValue(makeReservationRow());
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        timeSlot: { update: vi.fn().mockResolvedValue(SLOT_ROW) },
        reservationTable: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        table: { findMany: vi.fn().mockResolvedValue([TABLE_ROW]) },
        reservation: { update: txUpdate },
      }),
    );

    await svc.modify("res_01", "cust_01", { newPartySize: 3 });

    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txUpdate.mock.calls[0]?.[0]?.include).toEqual(EXPECTED_RELATION_INCLUDE);
  });
});

// ── Structural gate: the duplication must not come back ─────────────────────
//
// The six pins above prove each site currently sends the right shape. They do
// NOT prove the site reads it from the SSOT — an inline literal satisfies them
// just as well (that is exactly the state F-47 found). This gate is the half
// that makes the SSOT load-bearing: after the wiring, the relation literal may
// appear EXACTLY ONCE in the file, inside the const declaration itself.

describe("reservationWithRelationsArgs — no inline duplicate of the relation shape", () => {
  it("spells the tables-relation include exactly once, in the SSOT declaration", () => {
    const source = readFileSync(
      join(__dirname, "..", "reservation.service.ts"),
      "utf8",
    );

    // Whitespace-insensitive: matches both the multi-line declaration and any
    // single-line inline copy.
    const flattened = source.replace(/\s+/g, "");
    const occurrences = flattened.split("tables:{include:{table:true}}").length - 1;

    expect(occurrences).toBe(1);
  });
});
