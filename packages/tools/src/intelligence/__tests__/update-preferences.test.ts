// Tests for update_preferences tool
// Mock-based; no database or Redis required.
//
// ── Kernel routing (post-W9) ──────────────────────────────────────────────
//
// The tool now builds a `customer.preferences.update` IntentEnvelope and
// routes via `svc.updatePreferencesFromEnvelope`. The mock surfaces both
// the EXECUTE happy path and the REFUSE path so we can assert that:
//   - The envelope is built with the right kind / taint / actor
//   - The pack's safety guards reach the executor via the wrapper
//   - The Redis cache layer fires only on EXECUTE
//
// Scenarios:
// - Auth check: throws when no customerId
// - Happy path: builds envelope, routes via FromEnvelope, writes Redis
// - Allergens default to [] when omitted (CLAUDE.md hard rule)
// - REFUSE outcome surfaces refusal copy and does NOT touch Redis
// - Empty / partial inputs
// - pt-BR messages

import { describe, it, expect, beforeEach, vi } from "vitest"
import { Channel } from "@ibatexas/types"
import type { AgentContext } from "@ibatexas/types"
import { updatePreferences } from "../update-preferences.js"
import { PROFILE_TTL_SECONDS } from "../types.js"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

const mockUpdatePreferencesFromEnvelope = vi.hoisted(() => vi.fn())
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
  createCustomerService: () => ({
    updatePreferencesFromEnvelope: mockUpdatePreferencesFromEnvelope,
  }),
}))

vi.mock("../../redis/client.js", () => ({
  getRedisClient: mockGetRedisClient,
}))

vi.mock("../../redis/key.js", () => ({
  rk: mockRk,
}))

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

function execOutcome(result: {
  allergenExclusions: string[]
  dietaryRestrictions: string[]
  favoriteCategories: string[]
}) {
  return {
    decision: { kind: "EXECUTE" as const },
    result,
  }
}

// -- Tests ────────────────────────────────────────────────────────────────────

describe("updatePreferences", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRk.mockImplementation((key: string) => key)
    mockGetRedisClient.mockResolvedValue({ multi: mockMulti })
    mockPipelineExec.mockResolvedValue([])
    mockUpdatePreferencesFromEnvelope.mockResolvedValue(
      execOutcome({
        allergenExclusions: [],
        dietaryRestrictions: [],
        favoriteCategories: [],
      }),
    )
  })

  // ── Auth ────────────────────────────────────────────────────────────────

  it("throws when customerId is missing", async () => {
    await expect(updatePreferences({}, CTX_GUEST as AgentContext)).rejects.toThrow(
      "Autenticação necessária",
    )
    expect(mockUpdatePreferencesFromEnvelope).not.toHaveBeenCalled()
  })

  // ── Envelope construction ─────────────────────────────────────────────

  it("builds a customer.preferences.update envelope with UNTRUSTED taint + llm principal", async () => {
    mockUpdatePreferencesFromEnvelope.mockResolvedValue(
      execOutcome({
        allergenExclusions: ["lactose"],
        dietaryRestrictions: ["vegetariano"],
        favoriteCategories: ["churrasco"],
      }),
    )

    await updatePreferences(
      {
        allergenExclusions: ["lactose"],
        dietaryRestrictions: ["vegetariano"],
        favoriteCategories: ["churrasco"],
      },
      CTX_AUTH,
    )

    expect(mockUpdatePreferencesFromEnvelope).toHaveBeenCalledOnce()
    const [envelope, state, extras] = mockUpdatePreferencesFromEnvelope.mock.calls[0]
    expect(envelope.kind).toBe("customer.preferences.update")
    expect(envelope.taint).toBe("UNTRUSTED")
    expect(envelope.actor.principal).toBe("llm")
    expect(envelope.actor.sessionId).toBe("customer:cus_01")
    expect(envelope.payload.allergenExclusions).toEqual(["lactose"])
    expect(envelope.payload.dietaryFlags).toEqual(["vegetariano"])
    expect(envelope.payload.favoriteCategories).toEqual(["churrasco"])
    expect(state.ctx.customerId).toBe("cus_01")
    expect(state.ctx.isAuthenticated).toBe(true)
    expect(state.ctx.customerExists).toBe(true)
    expect(extras).toEqual({ customerId: "cus_01" })
  })

  // ── audit-2026-05-24 P1-1: refuse when allergens are missing ──────────
  //
  // CLAUDE.md rule #1: allergens MUST always be an explicit array — never
  // inferred. The previous behavior silently coerced `undefined` → `[]`,
  // which zeroed any stored allergens whenever the LLM omitted the
  // field. The tool now REFUSEs at its boundary so the envelope is never
  // built; the customer must explicitly say "no allergens" (`[]`) or
  // list their allergens.
  it("REFUSEs when allergenExclusions is omitted (CLAUDE.md rule #1)", async () => {
    await expect(
      updatePreferences({ dietaryRestrictions: ["vegano"] }, CTX_AUTH),
    ).rejects.toThrow(/alergias precisam ser informadas/i)
    expect(mockUpdatePreferencesFromEnvelope).not.toHaveBeenCalled()
    expect(mockMulti).not.toHaveBeenCalled()
    expect(mockHSet).not.toHaveBeenCalled()
  })

  it("REFUSEs when allergenExclusions is the empty object input (no fields)", async () => {
    await expect(updatePreferences({}, CTX_AUTH)).rejects.toThrow(
      /alergias precisam ser informadas/i,
    )
    expect(mockUpdatePreferencesFromEnvelope).not.toHaveBeenCalled()
  })

  it("PASSes through when caller sends explicit empty `[]` (no allergens)", async () => {
    mockUpdatePreferencesFromEnvelope.mockResolvedValue(
      execOutcome({
        allergenExclusions: [],
        dietaryRestrictions: ["vegano"],
        favoriteCategories: [],
      }),
    )
    const result = await updatePreferences(
      { allergenExclusions: [], dietaryRestrictions: ["vegano"] },
      CTX_AUTH,
    )
    expect(result.success).toBe(true)
    expect(mockUpdatePreferencesFromEnvelope).toHaveBeenCalledOnce()
    const [envelope] = mockUpdatePreferencesFromEnvelope.mock.calls[0]
    expect(envelope.payload.allergenExclusions).toEqual([])
  })

  it("omits dietaryFlags from the envelope when caller does not provide one", async () => {
    await updatePreferences({ allergenExclusions: ["lactose"] }, CTX_AUTH)

    const [envelope] = mockUpdatePreferencesFromEnvelope.mock.calls[0]
    expect(envelope.payload).not.toHaveProperty("dietaryFlags")
  })

  it("omits favoriteCategories from the envelope when caller does not provide one", async () => {
    await updatePreferences({ allergenExclusions: ["lactose"] }, CTX_AUTH)

    const [envelope] = mockUpdatePreferencesFromEnvelope.mock.calls[0]
    expect(envelope.payload).not.toHaveProperty("favoriteCategories")
  })

  // ── Cache layer fires on EXECUTE ──────────────────────────────────────

  it("writes preferences to Redis hash via pipeline on EXECUTE", async () => {
    mockUpdatePreferencesFromEnvelope.mockResolvedValue(
      execOutcome({
        allergenExclusions: ["amendoim"],
        dietaryRestrictions: ["sem glúten"],
        favoriteCategories: ["grelhados"],
      }),
    )

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
    const jsonArg = mockHSet.mock.calls[0][2]
    const parsed = JSON.parse(jsonArg)
    expect(parsed.allergenExclusions).toEqual(["amendoim"])
    expect(parsed.dietaryRestrictions).toEqual(["sem glúten"])
    expect(parsed.favoriteCategories).toEqual(["grelhados"])
  })

  it("resets Redis TTL via pipeline", async () => {
    await updatePreferences({ allergenExclusions: [] }, CTX_AUTH)

    expect(mockPipelineExpire).toHaveBeenCalledWith(
      "customer:profile:cus_01",
      PROFILE_TTL_SECONDS,
    )
    expect(mockPipelineExec).toHaveBeenCalledOnce()
  })

  it("uses rk() to build the profile key", async () => {
    await updatePreferences({ allergenExclusions: [] }, CTX_AUTH)

    expect(mockRk).toHaveBeenCalledWith("customer:profile:cus_01")
  })

  // ── REFUSE propagates ────────────────────────────────────────────────

  it("surfaces the kernel refusal copy and skips Redis when decision is REFUSE", async () => {
    mockUpdatePreferencesFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE" as const,
        refusal: {
          category: "BUSINESS_RULE",
          code: "customer.allergens.must_be_explicit",
          userFacing: "Por segurança, alergias precisam ser informadas explicitamente.",
        },
      },
    })

    await expect(
      updatePreferences(
        { allergenExclusions: ["lactose"] },
        CTX_AUTH,
      ),
    ).rejects.toThrow("Por segurança, alergias precisam ser informadas explicitamente.")

    expect(mockMulti).not.toHaveBeenCalled()
    expect(mockHSet).not.toHaveBeenCalled()
  })

  // ── Output message ────────────────────────────────────────────────────

  it("returns success with pt-BR message listing preferences", async () => {
    mockUpdatePreferencesFromEnvelope.mockResolvedValue(
      execOutcome({
        allergenExclusions: ["lactose", "gluten"],
        dietaryRestrictions: ["vegetariano"],
        favoriteCategories: ["churrasco"],
      }),
    )

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

  it("returns generic message when only the required `allergenExclusions: []` is provided", async () => {
    const result = await updatePreferences(
      { allergenExclusions: [] },
      CTX_AUTH,
    )

    expect(result.success).toBe(true)
    expect(result.message).toBe("Preferências atualizadas.")
  })
})
