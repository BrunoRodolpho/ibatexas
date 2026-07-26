// Tests for DailySpecialService (NEW-005 daily-specials / promo-of-the-day, ADMIN
// AUTHORING slice — create + list + getForDate + update + remove). Mock-based; no DB.
//
// Scenarios:
// - create: threads medusaProductId/date; omits promoPrice/headline/active when not
//   passed (lets the DB default apply); threads them when provided
// - list: date and/or activeOnly toggle the where filter; ordered by date desc, createdAt asc
// - getForDate: active specials for one YYYY-MM-DD, ordered by createdAt asc (the menu read)
// - update: writes ONLY defined patch fields; explicit null CLEARS promoPrice/headline;
//   null (no update) when missing
// - remove: returns the deleted row; null (no throw, no delete) when missing

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockCreate = vi.hoisted(() => vi.fn())
const mockFindMany = vi.hoisted(() => vi.fn())
const mockFindUnique = vi.hoisted(() => vi.fn())
const mockUpdateMany = vi.hoisted(() => vi.fn())
const mockDeleteMany = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    dailySpecial: {
      create: mockCreate,
      findMany: mockFindMany,
      findUnique: mockFindUnique,
      updateMany: mockUpdateMany,
      deleteMany: mockDeleteMany,
    },
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import { createDailySpecialService } from "../daily-special.service.js"

// ── Tests ───────────────────────────────────────────────────────────────────

describe("DailySpecialService.create", () => {
  let svc: ReturnType<typeof createDailySpecialService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createDailySpecialService()
  })

  it("creates, threading medusaProductId/date and omitting the optionals", async () => {
    mockCreate.mockResolvedValue({ id: "ds_1", medusaProductId: "prod_1", date: "2026-07-04" })

    const row = await svc.create({ medusaProductId: "prod_1", date: "2026-07-04" })

    expect(row).toMatchObject({ id: "ds_1" })
    expect(mockCreate).toHaveBeenCalledWith({
      data: { medusaProductId: "prod_1", date: "2026-07-04" },
    })
    // Optionals omitted → DB defaults apply (not sent).
    const sent = mockCreate.mock.calls[0]?.[0]?.data
    expect(sent).not.toHaveProperty("promoPriceCentavos")
    expect(sent).not.toHaveProperty("headline")
    expect(sent).not.toHaveProperty("active")
  })

  it("threads promoPriceCentavos, headline and active when provided", async () => {
    mockCreate.mockResolvedValue({ id: "ds_2" })

    await svc.create({
      medusaProductId: "prod_2",
      date: "2026-07-04",
      promoPriceCentavos: 3900,
      headline: "Feijoada da casa com 20% off",
      active: false,
    })

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        medusaProductId: "prod_2",
        date: "2026-07-04",
        promoPriceCentavos: 3900,
        headline: "Feijoada da casa com 20% off",
        active: false,
      },
    })
  })
})

describe("DailySpecialService.update", () => {
  let svc: ReturnType<typeof createDailySpecialService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createDailySpecialService()
  })

  it("writes ONLY the defined patch fields and returns the merged row", async () => {
    mockFindUnique.mockResolvedValue({
      id: "ds_1",
      medusaProductId: "prod_1",
      date: "2026-07-04",
      promoPriceCentavos: 3900,
      headline: "Antigo",
      active: true,
    })
    mockUpdateMany.mockResolvedValue({ count: 1 })

    const row = await svc.update("ds_1", { headline: "Novo headline" })

    expect(row).toMatchObject({ id: "ds_1", headline: "Novo headline", promoPriceCentavos: 3900 })
    // Only headline written — the rest untouched.
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ds_1" },
      data: { headline: "Novo headline" },
    })
  })

  it("returns null (no update) when the id does not exist", async () => {
    mockFindUnique.mockResolvedValue(null)

    const row = await svc.update("missing", { active: false })

    expect(row).toBeNull()
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  // BKL-265 — the row VANISHED between mutateOrNull's findUnique and its
  // updateMany, so the write matched NOTHING. Returning the merged row here would
  // report a specialId that was never persisted (executeMenuSpecialSet renders
  // success off a truthy id).
  it("returns null when the row vanishes between the read and the write (count === 0)", async () => {
    mockFindUnique.mockResolvedValue({
      id: "ds_1",
      medusaProductId: "prod_1",
      date: "2026-07-04",
      promoPriceCentavos: 3900,
      headline: "Antigo",
      active: true,
    })
    mockUpdateMany.mockResolvedValue({ count: 0 })

    const row = await svc.update("ds_1", { headline: "Novo headline" })

    expect(row).toBeNull()
    // The write WAS attempted — this is the between-reads window, not the
    // missing-id short circuit above.
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ds_1" },
      data: { headline: "Novo headline" },
    })
  })

  it("an explicit null CLEARS promoPriceCentavos and headline", async () => {
    mockFindUnique.mockResolvedValue({
      id: "ds_1",
      medusaProductId: "prod_1",
      date: "2026-07-04",
      promoPriceCentavos: 3900,
      headline: "Feijoada com desconto",
      active: true,
    })
    mockUpdateMany.mockResolvedValue({ count: 1 })

    const cleared = await svc.update("ds_1", { promoPriceCentavos: null, headline: null })

    // Explicit null is a DEFINED value → written (clears both); merged row reflects it.
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ds_1" },
      data: { promoPriceCentavos: null, headline: null },
    })
    expect(cleared).toMatchObject({ promoPriceCentavos: null, headline: null })
  })
})

describe("DailySpecialService.list", () => {
  let svc: ReturnType<typeof createDailySpecialService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createDailySpecialService()
  })

  it("lists all (no filter) ordered by date desc then createdAt asc", async () => {
    mockFindMany.mockResolvedValue([{ id: "ds_1" }])

    const rows = await svc.list()

    expect(rows.map((r: { id: string }) => r.id)).toEqual(["ds_1"])
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {},
      orderBy: [{ date: "desc" }, { createdAt: "asc" }],
    })
  })

  it("filters by date and active when both are passed", async () => {
    mockFindMany.mockResolvedValue([])

    await svc.list({ date: "2026-07-04", activeOnly: true })

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { date: "2026-07-04", active: true },
      orderBy: [{ date: "desc" }, { createdAt: "asc" }],
    })
  })

  it("filters by date only (activeOnly falsy → no active filter)", async () => {
    mockFindMany.mockResolvedValue([])

    await svc.list({ date: "2026-07-04" })

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { date: "2026-07-04" },
      orderBy: [{ date: "desc" }, { createdAt: "asc" }],
    })
  })
})

describe("DailySpecialService.getForDate", () => {
  let svc: ReturnType<typeof createDailySpecialService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createDailySpecialService()
  })

  it("fetches ACTIVE specials for the day, ordered by createdAt asc", async () => {
    mockFindMany.mockResolvedValue([{ id: "ds_1" }, { id: "ds_2" }])

    const rows = await svc.getForDate("2026-07-04")

    expect(rows.map((r: { id: string }) => r.id)).toEqual(["ds_1", "ds_2"])
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { date: "2026-07-04", active: true },
      orderBy: { createdAt: "asc" },
    })
  })
})

describe("DailySpecialService.remove", () => {
  let svc: ReturnType<typeof createDailySpecialService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createDailySpecialService()
  })

  it("deletes an existing special and returns the row", async () => {
    mockFindUnique.mockResolvedValue({ id: "ds_1", medusaProductId: "prod_1" })
    mockDeleteMany.mockResolvedValue({ count: 1 })

    const row = await svc.remove("ds_1")

    expect(row).toMatchObject({ id: "ds_1" })
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: "ds_1" } })
  })

  it("returns null (no throw, no delete) when the id does not exist", async () => {
    mockFindUnique.mockResolvedValue(null)

    const row = await svc.remove("missing")

    expect(row).toBeNull()
    expect(mockDeleteMany).not.toHaveBeenCalled()
  })
})
