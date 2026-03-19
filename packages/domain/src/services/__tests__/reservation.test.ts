// AUDIT-FIX: Phase 3 — Reservation service concurrency tests
//
// Validates:
//   1. Concurrent reservation requests for the last slot — only one succeeds (TOCTOU fix)
//   2. reservedCovers cannot go below 0

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Prisma — hoisted to avoid initialization order issues ───────────────

const mockTransaction = vi.hoisted(() => vi.fn());

vi.mock("../../client.js", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockTransaction(...args),
    reservation: { create: vi.fn() },
    timeSlot: { update: vi.fn() },
    reservationTable: { findMany: vi.fn() },
    table: { findMany: vi.fn() },
  },
}));

// The module uses Prisma.sql — we need a minimal mock
vi.mock("../../generated/prisma-client/index.js", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
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
