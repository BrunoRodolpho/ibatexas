// Tests for update_preferences tool
// Mock-based; no database or Redis required.
//
// Scenarios:
// - Auth check: throws when no customerId
// - Happy path: writes to Prisma + Redis, returns success message
// - Allergens always explicit array [] (CLAUDE.md hard rule)
// - Partial updates: only provided fields go to Prisma update
// - Empty arrays handled correctly
// - Redis pipeline with TTL reset
// - pt-BR messages

import { describe, it, expect, beforeEach, vi } from "vitest"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

const mockPrefsUpsert = vi.hoisted(() => vi.fn())
const mockGetRedisClient = vi.hoisted(() => vi.fn())
const mockRk = vi.hoisted(() => vi.fn())
const mockHSet = vi.hoisted(() => vi.fn())
const mockPipelineExpire = vi.hoisted(() => vi.fn())
const mockPipelineExec = vi.hoisted(() => vi.fn())

const mockMulti = vi.hoisted(() =>
  vi.fn(() => ({
    hSet: mockHSet,
    expire: mockPipelineExpire,
    exec: mockPipelineExec,
  })),
)

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    customerPreferences: {
      upsert: mockPrefsUpsert,
    },
  },
  createCustomerService: () => ({
    updatePreferences: async (
      customerId: string,
      input: { dietaryRestrictions?: string[]; allergenExclusions?: string[]; favoriteCategories?: string[] },
    ) => {
      const allergenExclusions = Array.isArray(input.allergenExclusions) ? input.allergenExclusions : []
      const dietaryRestrictions = Array.isArray(input.dietaryRestrictions) ? input.dietaryRestrictions : []
      const favoriteCategories = Array.isArray(input.favoriteCategories) ? input.favoriteCategories : []
      await mockPrefsUpsert({
        where: { customerId },
        create: { customerId, allergenExclusions, dietaryRestrictions, favoriteCategories },
        update: {
          ...(input.allergenExclusions === undefined ? {} : { allergenExclusions }),
          ...(input.dietaryRestrictions === undefined ? {} : { dietaryRestrictions }),
          ...(input.favoriteCategories === undefined ? {} : { favoriteCategories }),
        },
      })
      return { allergenExclusions, dietaryRestrictions, favoriteCategories }
    },
  }),
}))

vi.mock("../../redis/client.js", () => ({
  getRedisClient: mockGetRedisClient,
}))

vi.mock("../../redis/key.js", () => ({
  rk: mockRk,
}))

// -- Imports ──────────────────────────────────────────────────────────────────

import { Channel } from "@ibatexas/types"
import type { AgentContext } from "@ibatexas/types"
import { updatePreferences } from "../update-preferences.js"
import { PROFILE_TTL_SECONDS } from "../types.js"

// -- Fixtures ─────────────────────────────────────────────────────────────────

const CTX_AUTH = {
  customerId: "cus_01",
  channel: Channel.WhatsApp,
  sessionId: "sess_01",
  userType: "customer" as const,
}

const CTX_GUEST = {
  channel: Channel.Web,
  sessionId: "sess_02",
  userType: "guest" as const,
}

// -- Tests ────────────────────────────────────────────────────────────────────

describe("updatePreferences", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRk.mockImplementation((key: string) => key)
    mockGetRedisClient.mockResolvedValue({ multi: mockMulti })
    mockPrefsUpsert.mockResolvedValue({})
    mockPipelineExec.mockResolvedValue([])
  })

  // ── Auth ────────────────────────────────────────────────────────────────

  it("throws when customerId is missing", async () => {
    await expect(updatePreferences({}, CTX_GUEST as AgentContext)).rejects.toThrow(
      "Autenticação necessária",
    )
  })

  // ── Happy path ─────────────────────────────────────────────────────────

  it("upserts preferences in Prisma on happy path", async () => {
    await updatePreferences(
      {
        allergenExclusions: ["lactose"],
        dietaryRestrictions: ["vegetariano"],
        favoriteCategories: ["churrasco"],
      },
      CTX_AUTH,
    )

    expect(mockPrefsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: "cus_01" },
        create: expect.objectContaining({
          customerId: "cus_01",
          allergenExclusions: ["lactose"],
          dietaryRestrictions: ["vegetariano"],
          favoriteCategories: ["churrasco"],
        }),
      }),
    )
  })

  it("writes preferences to Redis hash via pipeline", async () => {
    await updatePreferences(
      {
        allergenExclusions: ["amendoim"],
        dietaryRestrictions: ["sem glúten"],
        favoriteCategories: ["grelhados"],
      },
      CTX_AUTH,
    )

    expect(mockMulti).toHaveBeenCalledOnce()
    expect(mockHSet).toHaveBeenCalledWith(
      "customer:profile:cus_01",
      "preferences",
      expect.any(String),
    )
    // Verify the JSON payload contains correct data
    const jsonArg = mockHSet.mock.calls[0][2]
    const parsed = JSON.parse(jsonArg)
    expect(parsed.allergenExclusions).toEqual(["amendoim"])
    expect(parsed.dietaryRestrictions).toEqual(["sem glúten"])
    expect(parsed.favoriteCategories).toEqual(["grelhados"])
  })

  it("resets Redis TTL via pipeline", async () => {
    await updatePreferences({}, CTX_AUTH)

    expect(mockPipelineExpire).toHaveBeenCalledWith(
      "customer:profile:cus_01",
      PROFILE_TTL_SECONDS,
    )
    expect(mockPipelineExec).toHaveBeenCalledOnce()
  })

  it("uses rk() to build the profile key", async () => {
    await updatePreferences({}, CTX_AUTH)

    expect(mockRk).toHaveBeenCalledWith("customer:profile:cus_01")
  })

  it("returns success with pt-BR message listing preferences", async () => {
    const result = await updatePreferences(
      {
        allergenExclusions: ["lactose", "gluten"],
        dietaryRestrictions: ["vegetariano"],
        favoriteCategories: ["churrasco"],
      },
      CTX_AUTH,
    )

    expect(result.success).toBe(true)
    expect(result.message).toContain("Preferências salvas!")
    expect(result.message).toContain("alérgenos excluídos")
    expect(result.message).toContain("lactose, gluten")
    expect(result.message).toContain("restrições")
    expect(result.message).toContain("vegetariano")
    expect(result.message).toContain("categorias favoritas")
    expect(result.message).toContain("churrasco")
  })

  // ── Allergens always explicit array (CLAUDE.md hard rule) ──────────────

  it("defaults allergenExclusions to [] when undefined", async () => {
    await updatePreferences({ dietaryRestrictions: ["vegano"] }, CTX_AUTH)

    expect(mockPrefsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          allergenExclusions: [],
        }),
      }),
    )
  })

  it("defaults dietaryRestrictions to [] when undefined", async () => {
    await updatePreferences({ allergenExclusions: ["lactose"] }, CTX_AUTH)

    expect(mockPrefsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          dietaryRestrictions: [],
        }),
      }),
    )
  })

  it("defaults favoriteCategories to [] when undefined", async () => {
    await updatePreferences({}, CTX_AUTH)

    expect(mockPrefsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          favoriteCategories: [],
        }),
      }),
    )
  })

  // ── Partial updates ────────────────────────────────────────────────────

  it("only includes provided fields in Prisma update clause", async () => {
    await updatePreferences(
      { allergenExclusions: ["lactose"] },
      CTX_AUTH,
    )

    const call = mockPrefsUpsert.mock.calls[0][0]
    expect(call.update).toHaveProperty("allergenExclusions")
    expect(call.update).not.toHaveProperty("dietaryRestrictions")
    expect(call.update).not.toHaveProperty("favoriteCategories")
  })

  it("includes all fields in update when all are provided", async () => {
    await updatePreferences(
      {
        allergenExclusions: ["gluten"],
        dietaryRestrictions: ["vegano"],
        favoriteCategories: ["sopas"],
      },
      CTX_AUTH,
    )

    const call = mockPrefsUpsert.mock.calls[0][0]
    expect(call.update).toHaveProperty("allergenExclusions")
    expect(call.update).toHaveProperty("dietaryRestrictions")
    expect(call.update).toHaveProperty("favoriteCategories")
  })

  // ── Empty input ────────────────────────────────────────────────────────

  it("returns generic message when all arrays are empty", async () => {
    const result = await updatePreferences(
      {
        allergenExclusions: [],
        dietaryRestrictions: [],
        favoriteCategories: [],
      },
      CTX_AUTH,
    )

    expect(result.success).toBe(true)
    expect(result.message).toBe("Preferências atualizadas.")
  })

  it("returns generic message when no fields provided", async () => {
    const result = await updatePreferences({}, CTX_AUTH)

    expect(result.success).toBe(true)
    expect(result.message).toBe("Preferências atualizadas.")
  })

  // ── Redis always written ───────────────────────────────────────────────

  it("writes to Redis even when all arrays are empty", async () => {
    await updatePreferences({}, CTX_AUTH)

    expect(mockHSet).toHaveBeenCalled()
    const jsonArg = mockHSet.mock.calls[0][2]
    const parsed = JSON.parse(jsonArg)
    expect(parsed.allergenExclusions).toEqual([])
    expect(parsed.dietaryRestrictions).toEqual([])
    expect(parsed.favoriteCategories).toEqual([])
  })
})
