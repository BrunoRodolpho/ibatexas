// Tests for IngredientService (NEW-003 stock slice — CRUD + adjustStock +
// listLowStock). Mock-based; no DB required.
//
// Scenarios:
// - create: threads name/unit + defaults stockMilli/lowStockMilli to 0, omits
//   `active` when not passed (lets the DB default apply)
// - update: writes ONLY defined patch fields (row-or-null); null when missing
// - list: activeOnly toggles the where filter; ordered by name
// - remove: returns the deleted row; null (no throw, no delete) when missing
// - adjustStock: adds/subtracts milli-units; CLAMPS at 0; null when missing
// - listLowStock: fetches active + filters stockMilli <= lowStockMilli

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockCreate = vi.hoisted(() => vi.fn())
const mockFindMany = vi.hoisted(() => vi.fn())
const mockFindUnique = vi.hoisted(() => vi.fn())
const mockUpdateMany = vi.hoisted(() => vi.fn())
const mockDeleteMany = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    ingredient: {
      create: mockCreate,
      findMany: mockFindMany,
      findUnique: mockFindUnique,
      updateMany: mockUpdateMany,
      deleteMany: mockDeleteMany,
    },
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import { createIngredientService } from "../ingredient.service.js"

// ── Tests ───────────────────────────────────────────────────────────────────

describe("IngredientService.create", () => {
  let svc: ReturnType<typeof createIngredientService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createIngredientService()
  })

  it("creates, threading name/unit and defaulting quantities to 0", async () => {
    mockCreate.mockResolvedValue({ id: "ing_1", name: "Farinha de trigo", unit: "kg" })

    const row = await svc.create({ name: "Farinha de trigo", unit: "kg" })

    expect(row).toMatchObject({ id: "ing_1" })
    expect(mockCreate).toHaveBeenCalledWith({
      data: { name: "Farinha de trigo", unit: "kg", stockMilli: 0, lowStockMilli: 0 },
    })
    // `active` omitted → DB default applies (not sent).
    expect(mockCreate.mock.calls[0]?.[0]?.data).not.toHaveProperty("active")
  })

  it("threads provided quantities and active", async () => {
    mockCreate.mockResolvedValue({ id: "ing_2" })

    await svc.create({ name: "Carne", unit: "kg", stockMilli: 2500, lowStockMilli: 1000, active: false })

    expect(mockCreate).toHaveBeenCalledWith({
      data: { name: "Carne", unit: "kg", stockMilli: 2500, lowStockMilli: 1000, active: false },
    })
  })
})

describe("IngredientService.update", () => {
  let svc: ReturnType<typeof createIngredientService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createIngredientService()
  })

  it("writes ONLY the defined patch fields and returns the merged row", async () => {
    mockFindUnique.mockResolvedValue({ id: "ing_1", name: "Farinha", unit: "kg", stockMilli: 2000, lowStockMilli: 500, active: true })
    mockUpdateMany.mockResolvedValue({ count: 1 })

    const row = await svc.update("ing_1", { lowStockMilli: 800 })

    expect(row).toMatchObject({ id: "ing_1", lowStockMilli: 800, stockMilli: 2000 })
    // Only lowStockMilli written — name/unit/stock untouched.
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ing_1" },
      data: { lowStockMilli: 800 },
    })
  })

  it("returns null (no update) when the id does not exist", async () => {
    mockFindUnique.mockResolvedValue(null)

    const row = await svc.update("missing", { name: "x" })

    expect(row).toBeNull()
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })
})

describe("IngredientService.list", () => {
  let svc: ReturnType<typeof createIngredientService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createIngredientService()
  })

  it("lists all (no filter) ordered by name when activeOnly is falsy", async () => {
    mockFindMany.mockResolvedValue([{ id: "ing_1" }])

    const rows = await svc.list()

    expect(rows.map((r: { id: string }) => r.id)).toEqual(["ing_1"])
    expect(mockFindMany).toHaveBeenCalledWith({ where: {}, orderBy: { name: "asc" } })
  })

  it("filters to active only when activeOnly is true", async () => {
    mockFindMany.mockResolvedValue([])

    await svc.list({ activeOnly: true })

    expect(mockFindMany).toHaveBeenCalledWith({ where: { active: true }, orderBy: { name: "asc" } })
  })
})

describe("IngredientService.remove", () => {
  let svc: ReturnType<typeof createIngredientService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createIngredientService()
  })

  it("deletes an existing ingredient and returns the row", async () => {
    mockFindUnique.mockResolvedValue({ id: "ing_1", name: "Farinha" })
    mockDeleteMany.mockResolvedValue({ count: 1 })

    const row = await svc.remove("ing_1")

    expect(row).toMatchObject({ id: "ing_1" })
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: "ing_1" } })
  })

  it("returns null (no throw, no delete) when the id does not exist", async () => {
    mockFindUnique.mockResolvedValue(null)

    const row = await svc.remove("missing")

    expect(row).toBeNull()
    expect(mockDeleteMany).not.toHaveBeenCalled()
  })
})

describe("IngredientService.adjustStock", () => {
  let svc: ReturnType<typeof createIngredientService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createIngredientService()
  })

  it("adds a positive delta to stock (integer-precise)", async () => {
    mockFindUnique.mockResolvedValue({ id: "ing_1", stockMilli: 2000 })
    mockUpdateMany.mockResolvedValue({ count: 1 })

    const row = await svc.adjustStock("ing_1", 500)

    expect(row).toMatchObject({ id: "ing_1", stockMilli: 2500 })
    expect(mockUpdateMany).toHaveBeenCalledWith({ where: { id: "ing_1" }, data: { stockMilli: 2500 } })
  })

  it("subtracts a negative delta from stock", async () => {
    mockFindUnique.mockResolvedValue({ id: "ing_1", stockMilli: 2000 })
    mockUpdateMany.mockResolvedValue({ count: 1 })

    const row = await svc.adjustStock("ing_1", -750)

    expect(row).toMatchObject({ stockMilli: 1250 })
    expect(mockUpdateMany).toHaveBeenCalledWith({ where: { id: "ing_1" }, data: { stockMilli: 1250 } })
  })

  it("CLAMPS at 0 — stock never goes negative", async () => {
    mockFindUnique.mockResolvedValue({ id: "ing_1", stockMilli: 300 })
    mockUpdateMany.mockResolvedValue({ count: 1 })

    const row = await svc.adjustStock("ing_1", -1000)

    expect(row).toMatchObject({ stockMilli: 0 })
    expect(mockUpdateMany).toHaveBeenCalledWith({ where: { id: "ing_1" }, data: { stockMilli: 0 } })
  })

  it("returns null (no update) when the id does not exist", async () => {
    mockFindUnique.mockResolvedValue(null)

    const row = await svc.adjustStock("missing", 100)

    expect(row).toBeNull()
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })
})

describe("IngredientService.listLowStock", () => {
  let svc: ReturnType<typeof createIngredientService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createIngredientService()
  })

  it("fetches active ingredients and returns only those at/below threshold", async () => {
    mockFindMany.mockResolvedValue([
      { id: "low", stockMilli: 500, lowStockMilli: 1000 }, // below → low
      { id: "eq", stockMilli: 1000, lowStockMilli: 1000 }, // equal → low (<=)
      { id: "ok", stockMilli: 2000, lowStockMilli: 1000 }, // above → not low
    ])

    const rows = await svc.listLowStock()

    expect(rows.map((r: { id: string }) => r.id)).toEqual(["low", "eq"])
    // Only active ingredients are scanned.
    expect(mockFindMany).toHaveBeenCalledWith({ where: { active: true }, orderBy: { name: "asc" } })
  })
})
