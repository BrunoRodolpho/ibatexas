// TableService unit tests — OPS-018 (table CRUD) + OPS-019 (slot generation).
//
// Validates:
//   1. create — success + duplicate-number rejection (P2002 → typed error)
//   2. update — partial patch, not-found (P2025), duplicate (P2002)
//   3. generateTimeSlots — explicit start-times, hours+interval derivation,
//      now-relative default range (injected clock), idempotency arg, validation
//   4. slotStartTimesFromHours — env windows, interval stepping, half-open bound

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ── Mock Prisma — hoisted to avoid initialization order issues ───────────────

const mockTableFindMany = vi.hoisted(() => vi.fn())
const mockTableCreate = vi.hoisted(() => vi.fn())
const mockTableUpdate = vi.hoisted(() => vi.fn())
const mockTimeSlotCreateMany = vi.hoisted(() => vi.fn())
const mockReservationTableCount = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    table: {
      findMany: (...a: unknown[]) => mockTableFindMany(...a),
      create: (...a: unknown[]) => mockTableCreate(...a),
      update: (...a: unknown[]) => mockTableUpdate(...a),
    },
    timeSlot: { createMany: (...a: unknown[]) => mockTimeSlotCreateMany(...a) },
    reservationTable: { count: (...a: unknown[]) => mockReservationTableCount(...a) },
  },
}))

vi.mock("../../generated/prisma-client/client.js", () => ({
  // The service casts a string into this enum; the runtime value is opaque.
  TableLocation: { indoor: "indoor", outdoor: "outdoor", bar: "bar", terrace: "terrace" },
}))

import {
  createTableService,
  slotStartTimesFromHours,
  DuplicateTableNumberError,
  TableNotFoundError,
  TableHasFutureReservationsError,
} from "../table.service.js"

// ── Env isolation for the hours/interval/horizon reads ───────────────────────

const HOUR_ENVS = [
  "RESTAURANT_LUNCH_START_HOUR",
  "RESTAURANT_LUNCH_END_HOUR",
  "RESTAURANT_DINNER_START_HOUR",
  "RESTAURANT_DINNER_END_HOUR",
  "RESERVATION_SLOT_INTERVAL_MINUTES",
  "RESERVATION_SLOT_HORIZON_DAYS",
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of HOUR_ENVS) savedEnv[k] = process.env[k]
  vi.clearAllMocks()
})
afterEach(() => {
  for (const k of HOUR_ENVS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ── create ───────────────────────────────────────────────────────────────────

describe("TableService.create", () => {
  it("creates a table and returns the row", async () => {
    mockTableCreate.mockResolvedValueOnce({ id: "t1", number: "12" })
    const svc = createTableService()
    const row = await svc.create({
      number: "12",
      capacity: 4,
      location: "indoor",
      accessible: false,
      active: true,
    })
    expect(row).toEqual({ id: "t1", number: "12" })
    expect(mockTableCreate).toHaveBeenCalledOnce()
  })

  it("rejects a duplicate number (P2002) with DuplicateTableNumberError", async () => {
    mockTableCreate.mockRejectedValueOnce({ code: "P2002" })
    const svc = createTableService()
    await expect(
      svc.create({ number: "12", capacity: 4, location: "indoor", accessible: false, active: true }),
    ).rejects.toBeInstanceOf(DuplicateTableNumberError)
  })

  it("rethrows a non-P2002 prisma error untranslated", async () => {
    mockTableCreate.mockRejectedValueOnce({ code: "P9999" })
    const svc = createTableService()
    await expect(
      svc.create({ number: "12", capacity: 4, location: "indoor", accessible: false, active: true }),
    ).rejects.not.toBeInstanceOf(DuplicateTableNumberError)
  })
})

// ── update ───────────────────────────────────────────────────────────────────

describe("TableService.update", () => {
  it("passes ONLY the provided fields to prisma (partial patch)", async () => {
    mockTableUpdate.mockResolvedValueOnce({ id: "t1", capacity: 6 })
    const svc = createTableService()
    await svc.update("t1", { capacity: 6 })
    expect(mockTableUpdate).toHaveBeenCalledWith({ where: { id: "t1" }, data: { capacity: 6 } })
  })

  it("soft-deactivates via active:false when no active reservations block it", async () => {
    mockReservationTableCount.mockResolvedValueOnce(0)
    mockTableUpdate.mockResolvedValueOnce({ id: "t1", active: false })
    const svc = createTableService()
    await svc.update("t1", { active: false })
    expect(mockTableUpdate).toHaveBeenCalledWith({ where: { id: "t1" }, data: { active: false } })
  })

  it("BLOCKS deactivation when the table holds active future reservations", async () => {
    mockReservationTableCount.mockResolvedValueOnce(3)
    const svc = createTableService()
    await expect(svc.update("t1", { active: false })).rejects.toBeInstanceOf(
      TableHasFutureReservationsError,
    )
    // Must not touch the table row when blocked.
    expect(mockTableUpdate).not.toHaveBeenCalled()
  })

  it("queries active/future reservations by the ReservationTable join with the injected clock", async () => {
    mockReservationTableCount.mockResolvedValueOnce(0)
    mockTableUpdate.mockResolvedValueOnce({ id: "t1", active: false })
    const svc = createTableService({ now: () => new Date("2026-07-10T18:00:00.000Z") })
    await svc.update("t1", { active: false })
    const arg = mockReservationTableCount.mock.calls[0][0]
    expect(arg.where.tableId).toBe("t1")
    expect(arg.where.reservation.status).toEqual({ in: ["pending", "confirmed", "seated"] })
    // Threshold is start-of-today (UTC) so slots earlier today still block.
    expect(arg.where.reservation.timeSlot.date.gte.toISOString()).toBe("2026-07-10T00:00:00.000Z")
  })

  it("proceeds (200) when only past/cancelled reservations exist — the guard filter excludes them", async () => {
    // The join query filters to status ∈ {pending,confirmed,seated} AND
    // date ≥ today, so past-date or cancelled/completed/no_show rows never
    // count → the DB returns 0 and deactivation proceeds.
    mockReservationTableCount.mockResolvedValueOnce(0)
    mockTableUpdate.mockResolvedValueOnce({ id: "t1", active: false })
    const svc = createTableService()
    await svc.update("t1", { active: false })
    expect(mockTableUpdate).toHaveBeenCalledWith({ where: { id: "t1" }, data: { active: false } })
  })

  it("does NOT run the reservation guard for non-deactivating updates", async () => {
    mockTableUpdate.mockResolvedValueOnce({ id: "t1", active: true })
    const svc = createTableService()
    await svc.update("t1", { active: true, capacity: 8 })
    expect(mockReservationTableCount).not.toHaveBeenCalled()
  })

  it("maps P2025 to TableNotFoundError", async () => {
    mockReservationTableCount.mockResolvedValueOnce(0)
    mockTableUpdate.mockRejectedValueOnce({ code: "P2025" })
    const svc = createTableService()
    await expect(svc.update("missing", { active: false })).rejects.toBeInstanceOf(TableNotFoundError)
  })

  it("maps P2002 (renamed to a taken number) to DuplicateTableNumberError", async () => {
    mockTableUpdate.mockRejectedValueOnce({ code: "P2002" })
    const svc = createTableService()
    await expect(svc.update("t1", { number: "7" })).rejects.toBeInstanceOf(DuplicateTableNumberError)
  })
})

// ── generateTimeSlots ────────────────────────────────────────────────────────

describe("TableService.generateTimeSlots", () => {
  it("creates one row per (date, startTime) over an explicit range, skipDuplicates", async () => {
    mockTimeSlotCreateMany.mockResolvedValueOnce({ count: 4 })
    const svc = createTableService()
    const result = await svc.generateTimeSlots({
      fromDate: "2026-08-01",
      toDate: "2026-08-02",
      startTimes: ["19:00", "20:00"],
      maxCovers: 40,
      durationMinutes: 90,
    })
    expect(result).toEqual({ count: 4 })
    const arg = mockTimeSlotCreateMany.mock.calls[0][0]
    expect(arg.skipDuplicates).toBe(true)
    // 2 days × 2 start-times = 4 rows.
    expect(arg.data).toHaveLength(4)
    expect(arg.data.every((r: { maxCovers: number }) => r.maxCovers === 40)).toBe(true)
    expect(new Set(arg.data.map((r: { startTime: string }) => r.startTime))).toEqual(
      new Set(["19:00", "20:00"]),
    )
  })

  it("is idempotent by construction: re-running the same range still passes skipDuplicates", async () => {
    mockTimeSlotCreateMany.mockResolvedValueOnce({ count: 0 })
    const svc = createTableService()
    const result = await svc.generateTimeSlots({
      fromDate: "2026-08-01",
      toDate: "2026-08-01",
      startTimes: ["19:00"],
      maxCovers: 40,
    })
    // Second run: DB reports 0 inserted (all pairs already present).
    expect(result).toEqual({ count: 0 })
    expect(mockTimeSlotCreateMany.mock.calls[0][0].skipDuplicates).toBe(true)
  })

  it("derives start-times from restaurant hours + interval when startTimes omitted", async () => {
    process.env.RESTAURANT_LUNCH_START_HOUR = "12"
    process.env.RESTAURANT_LUNCH_END_HOUR = "14"
    process.env.RESTAURANT_DINNER_START_HOUR = "19"
    process.env.RESTAURANT_DINNER_END_HOUR = "21"
    mockTimeSlotCreateMany.mockResolvedValueOnce({ count: 8 })
    const svc = createTableService()
    await svc.generateTimeSlots({
      fromDate: "2026-08-01",
      toDate: "2026-08-02",
      intervalMinutes: 60,
      maxCovers: 20,
    })
    const arg = mockTimeSlotCreateMany.mock.calls[0][0]
    // lunch 12:00,13:00 + dinner 19:00,20:00 = 4 start-times × 2 days = 8 rows.
    expect(arg.data).toHaveLength(8)
    expect(new Set(arg.data.map((r: { startTime: string }) => r.startTime))).toEqual(
      new Set(["12:00", "13:00", "19:00", "20:00"]),
    )
  })

  it("defaults the date range from an injected clock (deterministic)", async () => {
    process.env.RESERVATION_SLOT_HORIZON_DAYS = "2"
    mockTimeSlotCreateMany.mockResolvedValueOnce({ count: 3 })
    const svc = createTableService({ now: () => new Date("2026-07-10T12:00:00.000Z") })
    await svc.generateTimeSlots({ startTimes: ["19:00"], maxCovers: 10 })
    const arg = mockTimeSlotCreateMany.mock.calls[0][0]
    // [2026-07-10 .. +2] inclusive = 3 days × 1 start-time.
    expect(arg.data).toHaveLength(3)
    const isoDays = arg.data.map((r: { date: Date }) => r.date.toISOString().slice(0, 10))
    expect(isoDays).toEqual(["2026-07-10", "2026-07-11", "2026-07-12"])
  })

  it("returns count 0 (no DB call side effects asserted) when no start-times resolve", async () => {
    // Degenerate window: lunch/dinner start === end → zero derived start-times.
    process.env.RESTAURANT_LUNCH_START_HOUR = "12"
    process.env.RESTAURANT_LUNCH_END_HOUR = "12"
    process.env.RESTAURANT_DINNER_START_HOUR = "19"
    process.env.RESTAURANT_DINNER_END_HOUR = "19"
    const svc = createTableService()
    const result = await svc.generateTimeSlots({
      fromDate: "2026-08-01",
      toDate: "2026-08-01",
      intervalMinutes: 30,
      maxCovers: 10,
    })
    expect(result).toEqual({ count: 0 })
    expect(mockTimeSlotCreateMany).not.toHaveBeenCalled()
  })

  it("throws RangeError when fromDate is after toDate", async () => {
    const svc = createTableService()
    await expect(
      svc.generateTimeSlots({
        fromDate: "2026-08-05",
        toDate: "2026-08-01",
        startTimes: ["19:00"],
        maxCovers: 10,
      }),
    ).rejects.toBeInstanceOf(RangeError)
  })

  it("throws RangeError on a malformed explicit start-time", async () => {
    const svc = createTableService()
    await expect(
      svc.generateTimeSlots({
        fromDate: "2026-08-01",
        toDate: "2026-08-01",
        startTimes: ["7pm"],
        maxCovers: 10,
      }),
    ).rejects.toBeInstanceOf(RangeError)
  })
})

// ── slotStartTimesFromHours ──────────────────────────────────────────────────

describe("slotStartTimesFromHours", () => {
  it("steps across both meal windows, half-open, sorted + de-duplicated", () => {
    process.env.RESTAURANT_LUNCH_START_HOUR = "11"
    process.env.RESTAURANT_LUNCH_END_HOUR = "13"
    process.env.RESTAURANT_DINNER_START_HOUR = "18"
    process.env.RESTAURANT_DINNER_END_HOUR = "20"
    // 30-min interval, half-open: 11:00,11:30,12:00,12:30 | 18:00,18:30,19:00,19:30
    expect(slotStartTimesFromHours(30)).toEqual([
      "11:00",
      "11:30",
      "12:00",
      "12:30",
      "18:00",
      "18:30",
      "19:00",
      "19:30",
    ])
  })

  it("excludes the closing boundary (a slot never starts at end-hour)", () => {
    process.env.RESTAURANT_LUNCH_START_HOUR = "11"
    process.env.RESTAURANT_LUNCH_END_HOUR = "12"
    process.env.RESTAURANT_DINNER_START_HOUR = "18"
    process.env.RESTAURANT_DINNER_END_HOUR = "19"
    expect(slotStartTimesFromHours(60)).toEqual(["11:00", "18:00"])
  })

  it("throws on a non-positive interval", () => {
    expect(() => slotStartTimesFromHours(0)).toThrow(RangeError)
    expect(() => slotStartTimesFromHours(-15)).toThrow(RangeError)
  })
})
