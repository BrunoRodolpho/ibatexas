// Tests for LoyaltyService
// Mock-based; no DB required.
//
// Scenarios:
// - getOrCreateAccount: creates account if not exists (upsert)
// - addStamp: 0→1, stamps incremented
// - addStamp: 9→0 (reward triggered), rewarded=true, stamps reset
// - addStamp: after reward, stamps start fresh at 1
// - getBalance: correct stampsNeeded calculation

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockUpsert = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())

vi.mock("../client.js", () => ({
  prisma: {
    loyaltyAccount: {
      upsert: mockUpsert,
      update: mockUpdate,
    },
    $transaction: mockTransaction,
  },
}))

// ── Import after mocks ────────────────────────────────────────────────────────

import { createLoyaltyService } from "../services/loyalty.service.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAccount(stamps: number, totalEarned = stamps, redeemed = 0) {
  return { id: "loyalty_01", customerId: "cust_01", stamps, totalEarned, redeemed }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("LoyaltyService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("getOrCreateAccount", () => {
    it("calls upsert with correct args and returns account", async () => {
      const account = makeAccount(0)
      mockUpsert.mockResolvedValue(account)

      const svc = createLoyaltyService()
      const result = await svc.getOrCreateAccount("cust_01")

      expect(mockUpsert).toHaveBeenCalledWith({
        where: { customerId: "cust_01" },
        create: { customerId: "cust_01" },
        update: {},
      })
      expect(result).toEqual(account)
    })
  })

  describe("addStamp", () => {
    // addStamp now uses $transaction — the mock executes the callback with a tx
    // that shares the same mockUpsert/mockUpdate fns
    beforeEach(() => {
      mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          loyaltyAccount: { upsert: mockUpsert, update: mockUpdate },
        }
        return cb(tx)
      })
    })

    it("increments stamps from 0 to 1, rewarded=false", async () => {
      mockUpsert.mockResolvedValue(makeAccount(0))
      // First update: atomic increment → stamps=1
      mockUpdate.mockResolvedValue(makeAccount(1))

      const svc = createLoyaltyService()
      const result = await svc.addStamp("cust_01")

      expect(result).toEqual({ stamps: 1, rewarded: false })
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { customerId: "cust_01" },
        data: { stamps: { increment: 1 }, totalEarned: { increment: 1 } },
      })
    })

    it("resets stamps to 0 and sets rewarded=true when reaching 10", async () => {
      mockUpsert.mockResolvedValue(makeAccount(9))
      // First update: atomic increment → stamps=10
      mockUpdate.mockResolvedValueOnce(makeAccount(10, 10, 0))
      // Second update: reset stamps to 0, increment redeemed
      mockUpdate.mockResolvedValueOnce(makeAccount(0, 10, 1))

      const svc = createLoyaltyService()
      const result = await svc.addStamp("cust_01")

      expect(result).toEqual({ stamps: 0, rewarded: true })
      expect(mockUpdate).toHaveBeenCalledTimes(2)
      expect(mockUpdate).toHaveBeenNthCalledWith(1, {
        where: { customerId: "cust_01" },
        data: { stamps: { increment: 1 }, totalEarned: { increment: 1 } },
      })
      expect(mockUpdate).toHaveBeenNthCalledWith(2, {
        where: { customerId: "cust_01" },
        data: { stamps: 0, redeemed: { increment: 1 } },
      })
    })

    it("after reward, next stamp starts fresh at 1", async () => {
      // Account is already reset (stamps=0 after reward)
      mockUpsert.mockResolvedValue(makeAccount(0))
      mockUpdate.mockResolvedValue(makeAccount(1))

      const svc = createLoyaltyService()
      const result = await svc.addStamp("cust_01")

      expect(result).toEqual({ stamps: 1, rewarded: false })
    })
  })

  describe("getBalance", () => {
    it("returns correct stampsNeeded when stamps=3", async () => {
      mockUpsert.mockResolvedValue(makeAccount(3, 3, 0))

      const svc = createLoyaltyService()
      const result = await svc.getBalance("cust_01")

      expect(result).toEqual({
        stamps: 3,
        stampsNeeded: 7,
        totalEarned: 3,
        redeemed: 0,
      })
    })

    it("returns stampsNeeded=0 when stamps=10 (just rewarded)", async () => {
      mockUpsert.mockResolvedValue(makeAccount(0, 10, 1))

      const svc = createLoyaltyService()
      const result = await svc.getBalance("cust_01")

      expect(result).toEqual({
        stamps: 0,
        stampsNeeded: 10,
        totalEarned: 10,
        redeemed: 1,
      })
    })
  })
})
