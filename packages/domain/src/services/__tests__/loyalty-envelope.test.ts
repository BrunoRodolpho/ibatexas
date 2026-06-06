// LoyaltyService — envelope-typed entry-point smoke tests.
//
// Audit 2026-05-23 NEW-W9-V4: verifies the kernel chokepoint applies to
// the loyalty stamp award. The legacy `addStamp` tests stay the primary
// suite for the bare-arg shape; these tests narrowly verify:
//
//   - EXECUTE on SYSTEM taint → result populated, Prisma write occurred.
//   - REFUSE on UNTRUSTED taint → executor NOT invoked (taint floor).

import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildEnvelope } from "@adjudicate/core"

const mockUpsert = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    loyaltyAccount: {
      upsert: mockUpsert,
      update: mockUpdate,
    },
  },
}))

import { createLoyaltyService } from "../loyalty.service.js"
import type {
  LoyaltyStampAddPayload,
  LoyaltyState,
} from "../__shared__/loyalty-policy.js"

function makeAccount(stamps: number, totalEarned = stamps, redeemed = 0) {
  return {
    id: "loyalty_01",
    customerId: "cust_01",
    stamps,
    totalEarned,
    redeemed,
  }
}

const state: LoyaltyState = { ctx: { customerId: "cust_01" } }

const systemEnv = (payload: LoyaltyStampAddPayload) =>
  buildEnvelope({
    kind: "loyalty.stamp.add" as const,
    payload,
    actor: { principal: "system" as const, sessionId: "order.placed:order_01" },
    taint: "SYSTEM" as const,
    nonce: "loyalty:order_01",
  })

const untrustedEnv = (payload: LoyaltyStampAddPayload) =>
  buildEnvelope({
    kind: "loyalty.stamp.add" as const,
    payload,
    actor: { principal: "llm" as const, sessionId: "wa:test" },
    taint: "UNTRUSTED" as const,
    nonce: "loyalty:untrusted",
  })

describe("LoyaltyService — addStampFromEnvelope", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("EXECUTE on SYSTEM taint: persists the stamp and returns result", async () => {
    mockUpsert.mockResolvedValue(makeAccount(0))
    mockUpdate.mockResolvedValue(makeAccount(1))

    const svc = createLoyaltyService()
    const out = await svc.addStampFromEnvelope(
      systemEnv({ customerId: "cust_01" }),
      state,
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.result).toEqual({ stamps: 1, rewarded: false })
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })

  it("REFUSE on UNTRUSTED taint: executor never runs (SYSTEM-only)", async () => {
    const svc = createLoyaltyService()
    const out = await svc.addStampFromEnvelope(
      untrustedEnv({ customerId: "cust_01" }),
      state,
    )

    expect(out.decision.kind).toBe("REFUSE")
    expect(out.result).toBeUndefined()
    expect(mockUpsert).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("EXECUTE at reward threshold: stamps reset, rewarded=true", async () => {
    mockUpsert.mockResolvedValue(makeAccount(9))
    mockUpdate.mockResolvedValue(makeAccount(0, 10, 1))

    const svc = createLoyaltyService()
    const out = await svc.addStampFromEnvelope(
      systemEnv({ customerId: "cust_01" }),
      state,
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.result).toEqual({ stamps: 0, rewarded: true })
  })
})
