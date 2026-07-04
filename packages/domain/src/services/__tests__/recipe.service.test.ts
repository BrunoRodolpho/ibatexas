// Tests for RecipeService + the COGS math (NEW-035 recipe/BOM + per-dish COGS).
// Mock-based; no DB required.
//
// Scenarios:
// - create: threads medusaProductId, omits yield/active when not passed (DB default),
//   nested-creates the BOM lines
// - get / getByProduct: findUnique by id / medusaProductId with the lines include;
//   row-or-null
// - list: findMany with lines, most-recent first
// - setIngredients: replace-the-BOM — existence check, deleteMany then createMany,
//   inside a transaction; row-or-null (null → no delete/create)
// - remove: returns the deleted row; null (no throw, no delete) when missing
// - getCogs: row-or-null wiring around computeRecipeCogs
// - computeRecipeCogs (pure): batch = Σ line costs, per-serving = round(batch/yield),
//   per-line round-once, null-cost line flagged + excluded, empty recipe

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Ingredient, RecipeIngredient } from "../../generated/prisma-client/client.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockRecipeCreate = vi.hoisted(() => vi.fn())
const mockRecipeFindUnique = vi.hoisted(() => vi.fn())
const mockRecipeFindMany = vi.hoisted(() => vi.fn())
const mockRecipeDeleteMany = vi.hoisted(() => vi.fn())
const mockRiDeleteMany = vi.hoisted(() => vi.fn())
const mockRiCreateMany = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    recipe: {
      create: mockRecipeCreate,
      findUnique: mockRecipeFindUnique,
      findMany: mockRecipeFindMany,
      deleteMany: mockRecipeDeleteMany,
    },
    recipeIngredient: {
      deleteMany: mockRiDeleteMany,
      createMany: mockRiCreateMany,
    },
    $transaction: mockTransaction,
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import { createRecipeService, computeRecipeCogs, type RecipeWithLines } from "../recipe.service.js"

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A BOM line joined to its ingredient (only the fields COGS reads are load-bearing). */
function mkLine(
  ingredientId: string,
  name: string,
  qtyMilli: number,
  costCentavosPerUnit: number | null,
): RecipeIngredient & { ingredient: Ingredient } {
  return {
    id: `ri_${ingredientId}`,
    recipeId: "rec_1",
    ingredientId,
    qtyMilli,
    ingredient: {
      id: ingredientId,
      name,
      unit: "kg",
      stockMilli: 0,
      lowStockMilli: 0,
      costCentavosPerUnit,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  }
}

function mkRecipe(
  lines: (RecipeIngredient & { ingredient: Ingredient })[],
  yieldN = 1,
): RecipeWithLines {
  return {
    id: "rec_1",
    medusaProductId: "prod_1",
    yield: yieldN,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ingredients: lines,
  }
}

// ── computeRecipeCogs (pure COGS math) ───────────────────────────────────────

describe("computeRecipeCogs", () => {
  it("batch = Σ line costs; per-serving = round(batch / yield)", () => {
    // Flour: 2.5 kg × 400 c/kg = 1000 c; Meat: 1 kg × 3500 c/kg = 3500 c.
    const recipe = mkRecipe(
      [mkLine("ing_flour", "Farinha", 2500, 400), mkLine("ing_meat", "Carne", 1000, 3500)],
      10,
    )

    const cogs = computeRecipeCogs(recipe)

    expect(cogs.lines.map((l) => l.lineCostCentavos)).toEqual([1000, 3500])
    expect(cogs.batchCogsCentavos).toBe(4500)
    expect(cogs.perServingCogsCentavos).toBe(450) // round(4500 / 10)
    expect(cogs.anyCostMissing).toBe(false)
    expect(cogs).toMatchObject({ recipeId: "rec_1", medusaProductId: "prod_1", yield: 10 })
  })

  it("rounds each line's money EXACTLY once (half-up); per-serving rounds once", () => {
    // 0.5 kg × 333 c/kg = 166.5 → Math.round → 167 (rounded once, at the line).
    const recipe = mkRecipe([mkLine("ing_x", "Tempero", 500, 333)], 3)

    const cogs = computeRecipeCogs(recipe)

    expect(cogs.lines[0]!.lineCostCentavos).toBe(167)
    expect(cogs.batchCogsCentavos).toBe(167) // exact integer sum, no second round
    expect(cogs.perServingCogsCentavos).toBe(56) // round(167 / 3) = round(55.66…)
  })

  it("FLAGS a null-cost line: costMissing, contributes 0, sets anyCostMissing", () => {
    const recipe = mkRecipe(
      [mkLine("ing_priced", "Farinha", 2000, 400), mkLine("ing_unpriced", "Sal", 100000, null)],
      1,
    )

    const cogs = computeRecipeCogs(recipe)

    const priced = cogs.lines.find((l) => l.ingredientId === "ing_priced")!
    const unpriced = cogs.lines.find((l) => l.ingredientId === "ing_unpriced")!
    expect(priced).toMatchObject({ lineCostCentavos: 800, costMissing: false })
    expect(unpriced).toMatchObject({ lineCostCentavos: 0, costMissing: true })
    // Batch is the priced line only — the null-cost line is EXCLUDED, never guessed.
    expect(cogs.batchCogsCentavos).toBe(800)
    expect(cogs.anyCostMissing).toBe(true)
  })

  it("empty recipe → batch 0, per-serving 0, no missing costs", () => {
    const cogs = computeRecipeCogs(mkRecipe([], 4))

    expect(cogs.lines).toEqual([])
    expect(cogs.batchCogsCentavos).toBe(0)
    expect(cogs.perServingCogsCentavos).toBe(0) // round(0 / 4)
    expect(cogs.anyCostMissing).toBe(false)
  })
})

// ── Service CRUD ──────────────────────────────────────────────────────────────

describe("RecipeService.create", () => {
  let svc: ReturnType<typeof createRecipeService>
  beforeEach(() => {
    vi.clearAllMocks()
    svc = createRecipeService()
  })

  it("creates, threading medusaProductId + nested BOM lines, defaulting yield/active", async () => {
    mockRecipeCreate.mockResolvedValue({ id: "rec_1", medusaProductId: "prod_1", ingredients: [] })

    const row = await svc.create({
      medusaProductId: "prod_1",
      lines: [{ ingredientId: "ing_1", qtyMilli: 2500 }],
    })

    expect(row).toMatchObject({ id: "rec_1" })
    const arg = mockRecipeCreate.mock.calls[0]?.[0]
    expect(arg.data).toMatchObject({
      medusaProductId: "prod_1",
      ingredients: { create: [{ ingredientId: "ing_1", qtyMilli: 2500 }] },
    })
    // yield / active omitted → DB defaults apply (not sent).
    expect(arg.data).not.toHaveProperty("yield")
    expect(arg.data).not.toHaveProperty("active")
    expect(arg).toHaveProperty("include")
  })

  it("threads a provided yield + active and omits the nested create when no lines", async () => {
    mockRecipeCreate.mockResolvedValue({ id: "rec_2", ingredients: [] })

    await svc.create({ medusaProductId: "prod_2", yield: 8, active: false })

    const arg = mockRecipeCreate.mock.calls[0]?.[0]
    expect(arg.data).toMatchObject({ medusaProductId: "prod_2", yield: 8, active: false })
    expect(arg.data).not.toHaveProperty("ingredients")
  })
})

describe("RecipeService.get / getByProduct", () => {
  let svc: ReturnType<typeof createRecipeService>
  beforeEach(() => {
    vi.clearAllMocks()
    svc = createRecipeService()
  })

  it("get loads by id with the lines include (row)", async () => {
    mockRecipeFindUnique.mockResolvedValue({ id: "rec_1", ingredients: [] })

    const row = await svc.get("rec_1")

    expect(row).toMatchObject({ id: "rec_1" })
    const arg = mockRecipeFindUnique.mock.calls[0]?.[0]
    expect(arg.where).toEqual({ id: "rec_1" })
    expect(arg.include).toHaveProperty("ingredients")
  })

  it("get returns null when no such recipe", async () => {
    mockRecipeFindUnique.mockResolvedValue(null)
    expect(await svc.get("missing")).toBeNull()
  })

  it("getByProduct loads by medusaProductId (soft reference)", async () => {
    mockRecipeFindUnique.mockResolvedValue({ id: "rec_1", medusaProductId: "prod_1", ingredients: [] })

    const row = await svc.getByProduct("prod_1")

    expect(row).toMatchObject({ medusaProductId: "prod_1" })
    expect(mockRecipeFindUnique.mock.calls[0]?.[0]?.where).toEqual({ medusaProductId: "prod_1" })
  })
})

describe("RecipeService.list", () => {
  let svc: ReturnType<typeof createRecipeService>
  beforeEach(() => {
    vi.clearAllMocks()
    svc = createRecipeService()
  })

  it("lists recipes with lines, most-recent first", async () => {
    mockRecipeFindMany.mockResolvedValue([{ id: "rec_1", ingredients: [] }])

    const rows = await svc.list()

    expect(rows.map((r) => r.id)).toEqual(["rec_1"])
    const arg = mockRecipeFindMany.mock.calls[0]?.[0]
    expect(arg.orderBy).toEqual({ createdAt: "desc" })
    expect(arg.include).toHaveProperty("ingredients")
  })
})

describe("RecipeService.setIngredients (replace the BOM)", () => {
  let svc: ReturnType<typeof createRecipeService>
  beforeEach(() => {
    vi.clearAllMocks()
    svc = createRecipeService()
    // $transaction runs the callback with a tx that delegates to the same mocks.
    mockTransaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        recipe: { findUnique: mockRecipeFindUnique },
        recipeIngredient: { deleteMany: mockRiDeleteMany, createMany: mockRiCreateMany },
      }),
    )
  })

  it("deletes existing lines then creates the new set; returns the reloaded recipe", async () => {
    // 1st findUnique = existence check; 2nd = reload with include.
    mockRecipeFindUnique
      .mockResolvedValueOnce({ id: "rec_1" })
      .mockResolvedValueOnce({ id: "rec_1", ingredients: [{ id: "ri_1", ingredientId: "ing_1", qtyMilli: 3000 }] })
    mockRiDeleteMany.mockResolvedValue({ count: 2 })
    mockRiCreateMany.mockResolvedValue({ count: 1 })

    const row = await svc.setIngredients("rec_1", [{ ingredientId: "ing_1", qtyMilli: 3000 }])

    expect(mockRiDeleteMany).toHaveBeenCalledWith({ where: { recipeId: "rec_1" } })
    expect(mockRiCreateMany).toHaveBeenCalledWith({
      data: [{ recipeId: "rec_1", ingredientId: "ing_1", qtyMilli: 3000 }],
    })
    expect(row).toMatchObject({ id: "rec_1" })
    expect(row?.ingredients?.[0]).toMatchObject({ ingredientId: "ing_1", qtyMilli: 3000 })
  })

  it("clears the BOM when given an empty list (delete, no create)", async () => {
    mockRecipeFindUnique
      .mockResolvedValueOnce({ id: "rec_1" })
      .mockResolvedValueOnce({ id: "rec_1", ingredients: [] })
    mockRiDeleteMany.mockResolvedValue({ count: 3 })

    const row = await svc.setIngredients("rec_1", [])

    expect(mockRiDeleteMany).toHaveBeenCalledWith({ where: { recipeId: "rec_1" } })
    expect(mockRiCreateMany).not.toHaveBeenCalled()
    expect(row?.ingredients).toEqual([])
  })

  it("returns null (no delete/create) when the recipe does not exist", async () => {
    mockRecipeFindUnique.mockResolvedValueOnce(null)

    const row = await svc.setIngredients("missing", [{ ingredientId: "ing_1", qtyMilli: 100 }])

    expect(row).toBeNull()
    expect(mockRiDeleteMany).not.toHaveBeenCalled()
    expect(mockRiCreateMany).not.toHaveBeenCalled()
  })
})

describe("RecipeService.remove", () => {
  let svc: ReturnType<typeof createRecipeService>
  beforeEach(() => {
    vi.clearAllMocks()
    svc = createRecipeService()
  })

  it("deletes an existing recipe and returns the row (lines cascade at the DB)", async () => {
    mockRecipeFindUnique.mockResolvedValue({ id: "rec_1", ingredients: [] })
    mockRecipeDeleteMany.mockResolvedValue({ count: 1 })

    const row = await svc.remove("rec_1")

    expect(row).toMatchObject({ id: "rec_1" })
    expect(mockRecipeDeleteMany).toHaveBeenCalledWith({ where: { id: "rec_1" } })
  })

  it("returns null (no throw, no delete) when the id does not exist", async () => {
    mockRecipeFindUnique.mockResolvedValue(null)

    const row = await svc.remove("missing")

    expect(row).toBeNull()
    expect(mockRecipeDeleteMany).not.toHaveBeenCalled()
  })
})

describe("RecipeService.getCogs", () => {
  let svc: ReturnType<typeof createRecipeService>
  beforeEach(() => {
    vi.clearAllMocks()
    svc = createRecipeService()
  })

  it("loads the recipe and returns its COGS", async () => {
    mockRecipeFindUnique.mockResolvedValue(
      mkRecipe([mkLine("ing_1", "Farinha", 2000, 400)], 2),
    )

    const cogs = await svc.getCogs("rec_1")

    expect(cogs).toMatchObject({
      recipeId: "rec_1",
      batchCogsCentavos: 800, // 2 kg × 400
      perServingCogsCentavos: 400, // round(800 / 2)
      anyCostMissing: false,
    })
  })

  it("returns null when the recipe does not exist", async () => {
    mockRecipeFindUnique.mockResolvedValue(null)
    expect(await svc.getCogs("missing")).toBeNull()
  })
})
