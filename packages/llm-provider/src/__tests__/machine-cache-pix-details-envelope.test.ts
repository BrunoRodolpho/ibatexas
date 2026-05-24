// W7 — machine/actions.ts: cachePixDetails envelope routing
//
// The coverage-baseline audit flagged
// `packages/llm-provider/src/machine/actions.ts:401` as a bare-arg
// `updatePixDetails` caller. This file asserts that after the migration the
// machine action builds a `customer.pix.details.save` envelope with the
// system-actor pattern (consistent with kernel-executor-envelopes) and
// dispatches via `updatePixDetailsFromEnvelope`.

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────

const mockUpdatePixDetails = vi.hoisted(() => vi.fn())
const mockUpdatePixDetailsFromEnvelope = vi.hoisted(() => vi.fn())
const mockGetRedisClient = vi.hoisted(() => vi.fn())
const mockRk = vi.hoisted(() => vi.fn((k: string) => `ibatexas:${k}`))

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  searchProducts: vi.fn(),
  getOrCreateCart: vi.fn(),
  addToCart: vi.fn(),
  createCheckout: vi.fn(),
  estimateDelivery: vi.fn(),
  getLoyaltyBalance: vi.fn(),
  scheduleFollowUp: vi.fn(),
  getCustomerProfile: vi.fn(),
  reaisToCentavos: vi.fn(),
}))

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    updatePixDetails: mockUpdatePixDetails,
    updatePixDetailsFromEnvelope: mockUpdatePixDetailsFromEnvelope,
  }),
  createOrderQueryService: vi.fn(),
  createPaymentQueryService: vi.fn(),
}))

vi.mock("../intent-audit-wiring.js", () => ({
  getAuditSink: () => ({ emit: vi.fn(async () => undefined) }),
}))

import { cachePixDetails } from "../machine/actions.js"

function createMockRedis() {
  const pipeline = {
    hSet: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  }
  return {
    multi: vi.fn(() => pipeline),
    _pipeline: pipeline,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("machine/actions.ts — cachePixDetails envelope routing", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetRedisClient.mockResolvedValue(createMockRedis())
    mockUpdatePixDetailsFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: undefined,
    })
  })

  it("routes DB persist through updatePixDetailsFromEnvelope (not bare-arg)", async () => {
    await cachePixDetails("cust_01", {
      name: "Alice",
      email: "alice@example.com",
      cpf: "39053344705",
    })

    expect(mockUpdatePixDetailsFromEnvelope).toHaveBeenCalledTimes(1)
    expect(mockUpdatePixDetails).not.toHaveBeenCalled()
  })

  it("builds envelope with customer.pix.details.save kind + SYSTEM taint + system actor", async () => {
    await cachePixDetails("cust_42", {
      name: "Bob",
      email: "bob@example.com",
      cpf: "39053344705",
    })

    const [envelope, state, extras] = mockUpdatePixDetailsFromEnvelope.mock.calls[0]!
    expect(envelope.kind).toBe("customer.pix.details.save")
    expect(envelope.taint).toBe("SYSTEM")
    expect(envelope.actor.principal).toBe("system")
    expect(envelope.actor.sessionId).toBe("cust_42")
    expect(envelope.payload).toEqual({
      name: "Bob",
      email: "bob@example.com",
      cpf: "39053344705",
    })
    expect(state.ctx.customerId).toBe("cust_42")
    expect(state.ctx.isAuthenticated).toBe(true)
    expect(state.ctx.customerExists).toBe(true)
    expect(extras).toEqual({ customerId: "cust_42" })
  })

  it("coerces null fields to empty strings so the policy validates shape", async () => {
    await cachePixDetails("cust_03", {
      name: null,
      email: null,
      cpf: "39053344705",
    })

    const [envelope] = mockUpdatePixDetailsFromEnvelope.mock.calls[0]!
    expect(envelope.payload).toEqual({
      name: "",
      email: "",
      cpf: "39053344705",
    })
  })

  it("flushes Redis pipeline even when the DB persist resolves", async () => {
    const redis = createMockRedis()
    mockGetRedisClient.mockResolvedValue(redis)

    await cachePixDetails("cust_04", {
      name: "Dora",
      email: "dora@example.com",
      cpf: "39053344705",
    })

    expect(redis._pipeline.hSet).toHaveBeenCalledWith(expect.any(String), "name", "Dora")
    expect(redis._pipeline.hSet).toHaveBeenCalledWith(expect.any(String), "email", "dora@example.com")
    expect(redis._pipeline.hSet).toHaveBeenCalledWith(expect.any(String), "cpf", "39053344705")
    expect(redis._pipeline.exec).toHaveBeenCalledTimes(1)
  })
})
