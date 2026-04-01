// Tests for get_loyalty_balance tool
// Mock-based; no DB or network required.
//
// Scenarios:
// - Returns balance with correct message (stamps < 10)
// - No customerId returns login prompt
// - stampsNeeded=0 returns reward message

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockGetBalance = vi.hoisted(() => vi.fn())
const mockGetOrCreateAccount = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  createLoyaltyService: () => ({
    getBalance: mockGetBalance,
    getOrCreateAccount: mockGetOrCreateAccount,
  }),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

import { getLoyaltyBalance } from "../../intelligence/get-loyalty-balance.js"
import { Channel, type AgentContext } from "@ibatexas/types"

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    channel: Channel.WhatsApp,
    sessionId: "sess_test",
    customerId: "cust_test",
    userType: "customer",
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getLoyaltyBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns balance with correct message when stamps < 10", async () => {
    mockGetBalance.mockResolvedValue({ stamps: 3, stampsNeeded: 7, totalEarned: 3, redeemed: 0 })

    const result = await getLoyaltyBalance({}, makeCtx())

    expect(result.stamps).toBe(3)
    expect(result.stampsNeeded).toBe(7)
    expect(result.totalEarned).toBe(3)
    expect(result.message).toContain("3 de 10 selos")
    expect(result.message).toContain("7 pedidos")
  })

  it("uses singular 'pedido' when stampsNeeded=1", async () => {
    mockGetBalance.mockResolvedValue({ stamps: 9, stampsNeeded: 1, totalEarned: 9, redeemed: 0 })

    const result = await getLoyaltyBalance({}, makeCtx())

    expect(result.message).toContain("1 pedido")
    expect(result.message).not.toContain("pedidos")
  })

  it("returns login prompt when customerId is missing", async () => {
    const ctx = makeCtx({ customerId: undefined })

    const result = await getLoyaltyBalance({}, ctx)

    expect(result.stamps).toBe(0)
    expect(result.stampsNeeded).toBe(10)
    expect(result.totalEarned).toBe(0)
    expect(result.message).toContain("login")
    expect(mockGetBalance).not.toHaveBeenCalled()
  })

  it("returns reward message when stampsNeeded=0", async () => {
    mockGetBalance.mockResolvedValue({ stamps: 0, stampsNeeded: 0, totalEarned: 10, redeemed: 0 })

    const result = await getLoyaltyBalance({}, makeCtx())

    expect(result.message).toContain("FIEL20")
    expect(result.message).toContain("desconto")
  })
})
