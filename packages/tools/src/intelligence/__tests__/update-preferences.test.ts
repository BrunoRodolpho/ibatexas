// Tests for update_preferences tool
// Mock-based; no database or Redis required.
//
// ── BKL-242 — the tool is DISPATCH-ONLY and must NOT re-adjudicate ────────
//
// This tool's only caller is the claustrum tool registry, which dispatches it
// on a kernel EXECUTE the Conductor already adjudicated and ledger-claimed.
// Pre-fix it minted a second `customer.preferences.update` envelope and ran
// `svc.updatePreferencesFromEnvelope` again — an AUDIT-BLIND second decision
// (`createCustomerService()` takes no auditSink here), live-proven by conductor
// EXECUTE `intent_audit` 6172 having no second row behind it.
//
// So `updatePreferencesFromEnvelope` is mocked here purely as a TRIPWIRE: every
// arm asserts it was never called. The write now goes through the bare
// `svc.updatePreferences`, whose docstring names this caller as sanctioned.
//
// Scenarios:
// - Auth check: throws when no customerId
// - Happy path: writes via the bare service method, NEVER re-adjudicates
// - Allergens must be an explicit array (CLAUDE.md hard rule) — tool-boundary
//   guard, unchanged by the fix and still fail-closed
// - The Redis cache layer fires only after a successful write
// - Empty / partial inputs
// - pt-BR messages

import { describe, it, expect, beforeEach, vi } from "vitest"
import { Channel } from "@ibatexas/types"
import type { AgentContext } from "@ibatexas/types"
import { updatePreferences } from "../update-preferences.js"
import { PROFILE_TTL_SECONDS } from "../types.js"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

/**
 * BKL-242 tripwire. The tool must never call this again: it is the
 * second-adjudication path. Kept on the mocked service (rather than deleted)
 * so a regression calls a REAL spy we assert on, instead of dying on
 * `not a function` — a failure mode that reads like a mock gap, not a defect.
 */
const mockUpdatePreferencesFromEnvelope = vi.hoisted(() => vi.fn())
const mockUpdatePreferences = vi.hoisted(() => vi.fn())
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
    updatePreferences: mockUpdatePreferences,
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

/** What the bare `svc.updatePreferences` resolves with. */
function prefs(result: {
  allergenExclusions: string[]
  dietaryRestrictions: string[]
  favoriteCategories: string[]
}) {
  return result
}

// -- Tests ────────────────────────────────────────────────────────────────────

describe("updatePreferences", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRk.mockImplementation((key: string) => key)
    mockGetRedisClient.mockResolvedValue({ multi: mockMulti })
    mockPipelineExec.mockResolvedValue([])
    mockUpdatePreferences.mockResolvedValue(
      prefs({
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
    expect(mockUpdatePreferences).not.toHaveBeenCalled()
    expect(mockUpdatePreferencesFromEnvelope).not.toHaveBeenCalled()
  })

  // ── BKL-242 — no second adjudication on the dispatch path ─────────────

  it("writes via the bare service method and NEVER re-adjudicates", async () => {
    mockUpdatePreferences.mockResolvedValue(
      prefs({
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

    // No second envelope, no second kernel run, no audit-blind inner decision.
    expect(mockUpdatePreferencesFromEnvelope).not.toHaveBeenCalled()
    // The write still runs exactly once, with the customerId from the verified
    // ctx (never from the model payload) and the caller's explicit arrays.
    expect(mockUpdatePreferences).toHaveBeenCalledExactlyOnceWith("cus_01", {
      allergenExclusions: ["lactose"],
      dietaryRestrictions: ["vegetariano"],
      favoriteCategories: ["churrasco"],
    })
  })

  // ── audit-2026-05-24 P1-1: refuse when allergens are missing ──────────
  //
  // CLAUDE.md rule #1: allergens MUST always be an explicit array — never
  // inferred. The previous behavior silently coerced `undefined` → `[]`,
  // which zeroed any stored allergens whenever the LLM omitted the
  // field. The tool REFUSEs at its boundary so no write happens; the customer
  // must explicitly say "no allergens" (`[]`) or list their allergens. This is a
  // TOOL-BOUNDARY guard, not a kernel guard — BKL-242 left it exactly as it was.
  it("REFUSEs when allergenExclusions is omitted (CLAUDE.md rule #1)", async () => {
    await expect(
      updatePreferences({ dietaryRestrictions: ["vegano"] }, CTX_AUTH),
    ).rejects.toThrow(/alergias precisam ser informadas/i)
    expect(mockUpdatePreferences).not.toHaveBeenCalled()
    expect(mockUpdatePreferencesFromEnvelope).not.toHaveBeenCalled()
    expect(mockMulti).not.toHaveBeenCalled()
    expect(mockHSet).not.toHaveBeenCalled()
  })

  it("REFUSEs when allergenExclusions is the empty object input (no fields)", async () => {
    await expect(updatePreferences({}, CTX_AUTH)).rejects.toThrow(
      /alergias precisam ser informadas/i,
    )
    expect(mockUpdatePreferences).not.toHaveBeenCalled()
  })

  it("PASSes through when caller sends explicit empty `[]` (no allergens)", async () => {
    mockUpdatePreferences.mockResolvedValue(
      prefs({
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
    expect(mockUpdatePreferences).toHaveBeenCalledExactlyOnceWith("cus_01", {
      allergenExclusions: [],
      dietaryRestrictions: ["vegano"],
    })
  })

  it("omits dietaryRestrictions from the write when caller does not provide one", async () => {
    await updatePreferences({ allergenExclusions: ["lactose"] }, CTX_AUTH)

    const [, patch] = mockUpdatePreferences.mock.calls[0]
    expect(patch).not.toHaveProperty("dietaryRestrictions")
  })

  it("omits favoriteCategories from the write when caller does not provide one", async () => {
    await updatePreferences({ allergenExclusions: ["lactose"] }, CTX_AUTH)

    const [, patch] = mockUpdatePreferences.mock.calls[0]
    expect(patch).not.toHaveProperty("favoriteCategories")
  })

  // ── Cache layer fires on EXECUTE ──────────────────────────────────────

  it("writes preferences to Redis hash via pipeline after the write", async () => {
    mockUpdatePreferences.mockResolvedValue(
      prefs({
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

  // ── A failed write does not refresh the cache ────────────────────────
  //
  // Pre-BKL-242 this arm asserted the INNER kernel's REFUSE copy propagated.
  // There is no inner kernel any more (the Conductor's decision is the only
  // one), so what is left to pin is that a write failure still short-circuits
  // the cache layer rather than leaving Redis claiming a change that never
  // committed.
  it("propagates a write failure and skips Redis", async () => {
    mockUpdatePreferences.mockRejectedValue(new Error("preferences write failed"))

    await expect(
      updatePreferences({ allergenExclusions: ["lactose"] }, CTX_AUTH),
    ).rejects.toThrow("preferences write failed")

    expect(mockMulti).not.toHaveBeenCalled()
    expect(mockHSet).not.toHaveBeenCalled()
  })

  // ── Output message ────────────────────────────────────────────────────

  it("returns success with pt-BR message listing preferences", async () => {
    mockUpdatePreferences.mockResolvedValue(
      prefs({
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
