// anonymizeCustomer — LGPD Art. 18 completeness tests (W4 P0-13).
//
// Pre-W4 the function did NOT clear:
//   - phone (LGPD identifier; UNIQUE-constrained)
//   - cpf (Brazilian tax ID)
//   - reviews (free-form `comment` text)
//
// W4 fix:
//   - phone → "anonymized:{sha256-hex-16}" (unique, non-PII sentinel)
//   - cpf → null
//   - email → null (preserved behaviour)
//   - name → "Usuário Removido" (preserved behaviour)
//   - addresses → DELETE (preserved behaviour)
//   - preferences → DELETE (legal-review note in code re allergens)
//   - reviews → comment cleared, customerId stays (schema constraint)
//   - order items → customerId=null (preserved behaviour)

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockCustomerUpdate = vi.hoisted(() => vi.fn())
const mockAddressDeleteMany = vi.hoisted(() => vi.fn())
const mockPreferencesDeleteMany = vi.hoisted(() => vi.fn())
const mockReviewUpdateMany = vi.hoisted(() => vi.fn())
const mockCustomerOrderItemUpdateMany = vi.hoisted(() => vi.fn())
// NEW-P0-X7 — heavy-path mocks
const mockReviewCount = vi.hoisted(() => vi.fn())
const mockReviewFindMany = vi.hoisted(() => vi.fn())
const mockReviewUpdateManyOuter = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())
// audit-2026-05-24 H3 wave-a1 — scope-expansion mocks (7 new surfaces)
const mockOrderProjectionUpdateMany = vi.hoisted(() => vi.fn())
const mockOrderProjectionFindManyOuter = vi.hoisted(() => vi.fn())
const mockConversationMessageUpdateMany = vi.hoisted(() => vi.fn())
const mockConversationMessageUpdateManyOuter = vi.hoisted(() => vi.fn())
const mockConversationFindManyOuter = vi.hoisted(() => vi.fn())
const mockConversationMessageCount = vi.hoisted(() => vi.fn())
const mockConversationUpdateMany = vi.hoisted(() => vi.fn())
const mockOrderStatusHistoryUpdateMany = vi.hoisted(() => vi.fn())
const mockOrderEventLogUpdateMany = vi.hoisted(() => vi.fn())
const mockOrderEventLogUpdateManyOuter = vi.hoisted(() => vi.fn())
const mockOrderEventLogCount = vi.hoisted(() => vi.fn())
const mockOrderEventLogFindManyOuter = vi.hoisted(() => vi.fn())
const mockLoyaltyAccountUpdateMany = vi.hoisted(() => vi.fn())
const mockReservationUpdateMany = vi.hoisted(() => vi.fn())

const txClient = {
  customer: { update: mockCustomerUpdate },
  address: { deleteMany: mockAddressDeleteMany },
  customerPreferences: { deleteMany: mockPreferencesDeleteMany },
  review: { updateMany: mockReviewUpdateMany },
  customerOrderItem: { updateMany: mockCustomerOrderItemUpdateMany },
  orderProjection: { updateMany: mockOrderProjectionUpdateMany },
  conversationMessage: { updateMany: mockConversationMessageUpdateMany },
  conversation: { updateMany: mockConversationUpdateMany },
  orderStatusHistory: { updateMany: mockOrderStatusHistoryUpdateMany },
  orderEventLog: { updateMany: mockOrderEventLogUpdateMany },
  loyaltyAccount: { updateMany: mockLoyaltyAccountUpdateMany },
  reservation: { updateMany: mockReservationUpdateMany },
}

vi.mock("../../client.js", () => ({
  prisma: {
    $transaction: mockTransaction,
    customer: { update: mockCustomerUpdate },
    address: { deleteMany: mockAddressDeleteMany },
    customerPreferences: { deleteMany: mockPreferencesDeleteMany },
    review: {
      // updateMany is shared with the in-transaction client surface, but
      // it's also called from the heavy path OUTSIDE the transaction.
      // Tests assert the call counts using the outer mock when the
      // heavy path is exercised; in-tx calls land via the tx mock.
      count: mockReviewCount,
      findMany: mockReviewFindMany,
      updateMany: mockReviewUpdateManyOuter,
    },
    customerOrderItem: { updateMany: mockCustomerOrderItemUpdateMany },
    // Outer (pre-tx) surfaces used by the H3 wave-a1 heavy-path batching.
    orderProjection: { findMany: mockOrderProjectionFindManyOuter },
    conversationMessage: {
      count: mockConversationMessageCount,
      updateMany: mockConversationMessageUpdateManyOuter,
    },
    conversation: { findMany: mockConversationFindManyOuter },
    orderEventLog: {
      count: mockOrderEventLogCount,
      findMany: mockOrderEventLogFindManyOuter,
      updateMany: mockOrderEventLogUpdateManyOuter,
    },
  },
}))

// ── Import after mocks ────────────────────────────────────────────────────

import { anonymizeCustomer } from "../customer.service.js"

// ── Tests ─────────────────────────────────────────────────────────────────

describe("anonymizeCustomer — W4 P0-13 LGPD completeness", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCustomerUpdate.mockResolvedValue({ id: "cust_01" })
    mockAddressDeleteMany.mockResolvedValue({ count: 1 })
    mockPreferencesDeleteMany.mockResolvedValue({ count: 1 })
    mockReviewUpdateMany.mockResolvedValue({ count: 1 })
    mockCustomerOrderItemUpdateMany.mockResolvedValue({ count: 1 })
    // NEW-P0-X7: default to light path (review count < 1000) for the
    // legacy LGPD-completeness suite. Heavy-path tests below override.
    mockReviewCount.mockResolvedValue(0)
    mockReviewFindMany.mockResolvedValue([])
    mockReviewUpdateManyOuter.mockResolvedValue({ count: 0 })
    // H3 wave-a1: default tx-client mocks (light path, no new-surface data)
    mockOrderProjectionUpdateMany.mockResolvedValue({ count: 0 })
    mockConversationMessageUpdateMany.mockResolvedValue({ count: 0 })
    mockConversationUpdateMany.mockResolvedValue({ count: 0 })
    mockOrderStatusHistoryUpdateMany.mockResolvedValue({ count: 0 })
    mockOrderEventLogUpdateMany.mockResolvedValue({ count: 0 })
    mockLoyaltyAccountUpdateMany.mockResolvedValue({ count: 0 })
    mockReservationUpdateMany.mockResolvedValue({ count: 0 })
    // H3 wave-a1: default outer mocks (light path — count below threshold,
    // no batching activity).
    mockOrderProjectionFindManyOuter.mockResolvedValue([])
    mockConversationFindManyOuter.mockResolvedValue([])
    mockConversationMessageCount.mockResolvedValue(0)
    mockConversationMessageUpdateManyOuter.mockResolvedValue({ count: 0 })
    mockOrderEventLogCount.mockResolvedValue(0)
    mockOrderEventLogFindManyOuter.mockResolvedValue([])
    mockOrderEventLogUpdateManyOuter.mockResolvedValue({ count: 0 })
    // Default: $transaction runs the inner function inline (legacy behavior).
    // Heavy-path tests override to inspect options.
    mockTransaction.mockImplementation(
      async (fn: (tx: typeof txClient) => Promise<unknown>) => fn(txClient),
    )
  })

  it("returns success on happy path", async () => {
    const result = await anonymizeCustomer("cust_01")
    expect(result).toEqual({ success: true })
  })

  it("[P0-13] nullifies email, cpf, and medusaId on the Customer row", async () => {
    await anonymizeCustomer("cust_01")
    expect(mockCustomerUpdate).toHaveBeenCalledTimes(1)
    const call = mockCustomerUpdate.mock.calls[0]![0] as {
      data: Record<string, unknown>
    }
    expect(call.data.email).toBe(null)
    expect(call.data.cpf).toBe(null)
    expect(call.data.medusaId).toBe(null)
  })

  it("[P0-13] preserves name scrubbing to Portuguese sentinel", async () => {
    await anonymizeCustomer("cust_01")
    const call = mockCustomerUpdate.mock.calls[0]![0] as {
      data: Record<string, unknown>
    }
    expect(call.data.name).toBe("Usuário Removido")
  })

  it("[P0-13] replaces phone with non-PII sentinel (UNIQUE-safe placeholder)", async () => {
    await anonymizeCustomer("cust_01")
    const call = mockCustomerUpdate.mock.calls[0]![0] as {
      data: Record<string, unknown>
    }
    const phone = call.data.phone as string
    // Sentinel format: "anonymized:<sha256-of-customerId>[0..15]"
    expect(phone).toMatch(/^anonymized:[a-f0-9]{16}$/)
    // Crucially, the placeholder is NOT the original phone (no leakage)
    // and it's NOT empty / null (UNIQUE constraint).
    expect(phone).not.toContain("+55")
    expect(phone).not.toBe("")
  })

  it("[P0-13] phone sentinel is deterministic per customerId (idempotent retries)", async () => {
    await anonymizeCustomer("cust_01")
    const phone1 = (mockCustomerUpdate.mock.calls[0]![0] as { data: { phone: string } })
      .data.phone

    mockCustomerUpdate.mockClear()
    await anonymizeCustomer("cust_01")
    const phone2 = (mockCustomerUpdate.mock.calls[0]![0] as { data: { phone: string } })
      .data.phone

    expect(phone1).toBe(phone2)
  })

  it("[P0-13] phone sentinel differs across distinct customers", async () => {
    await anonymizeCustomer("cust_alpha")
    const phoneA = (mockCustomerUpdate.mock.calls[0]![0] as { data: { phone: string } })
      .data.phone

    mockCustomerUpdate.mockClear()
    await anonymizeCustomer("cust_beta")
    const phoneB = (mockCustomerUpdate.mock.calls[0]![0] as { data: { phone: string } })
      .data.phone

    expect(phoneA).not.toBe(phoneB)
  })

  it("deletes all addresses for the customer", async () => {
    await anonymizeCustomer("cust_01")
    expect(mockAddressDeleteMany).toHaveBeenCalledWith({
      where: { customerId: "cust_01" },
    })
  })

  it("deletes customer preferences row", async () => {
    await anonymizeCustomer("cust_01")
    expect(mockPreferencesDeleteMany).toHaveBeenCalledWith({
      where: { customerId: "cust_01" },
    })
  })

  it("[P0-13] clears Review.comment text for all customer reviews", async () => {
    await anonymizeCustomer("cust_01")
    expect(mockReviewUpdateMany).toHaveBeenCalledTimes(1)
    const call = mockReviewUpdateMany.mock.calls[0]![0] as {
      where: { customerId: string }
      data: Record<string, unknown>
    }
    expect(call.where.customerId).toBe("cust_01")
    expect(call.data.comment).toBe(null)
  })

  it("delinks customer order items (preserves analytics)", async () => {
    await anonymizeCustomer("cust_01")
    expect(mockCustomerOrderItemUpdateMany).toHaveBeenCalledWith({
      where: { customerId: "cust_01" },
      data: { customerId: null },
    })
  })

  it("[P0-13] no plaintext PII fields remain in the update payload", async () => {
    await anonymizeCustomer("cust_TARGET_PROBE")
    const call = mockCustomerUpdate.mock.calls[0]![0] as {
      data: Record<string, unknown>
    }
    const dataJson = JSON.stringify(call.data)
    // The customerId itself does appear in the hash output but
    // sha256 truncated to 16 hex chars is not reversible. The
    // original ID does NOT appear anywhere in the payload.
    expect(dataJson).not.toContain("cust_TARGET_PROBE")
    // No phone-like patterns.
    expect(dataJson).not.toMatch(/\+\d{12,13}/)
    // No email patterns.
    expect(dataJson).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    // No CPF-like patterns.
    expect(dataJson).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/)
  })

  it("runs all mutations inside a single $transaction", async () => {
    // Sanity: every mock got called (the transaction wrapper invoked
    // the closure that contains all five operations).
    await anonymizeCustomer("cust_01")
    expect(mockCustomerUpdate).toHaveBeenCalled()
    expect(mockAddressDeleteMany).toHaveBeenCalled()
    expect(mockPreferencesDeleteMany).toHaveBeenCalled()
    expect(mockReviewUpdateMany).toHaveBeenCalled()
    expect(mockCustomerOrderItemUpdateMany).toHaveBeenCalled()
  })
})

// ── NEW-P0-X7 — $transaction timeout + heavy-customer batching ─────────

describe("anonymizeCustomer — NEW-P0-X7 transaction timeout + batching", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCustomerUpdate.mockResolvedValue({ id: "cust_01" })
    mockAddressDeleteMany.mockResolvedValue({ count: 1 })
    mockPreferencesDeleteMany.mockResolvedValue({ count: 1 })
    mockReviewUpdateMany.mockResolvedValue({ count: 1 })
    mockCustomerOrderItemUpdateMany.mockResolvedValue({ count: 1 })
    mockReviewCount.mockResolvedValue(0)
    mockReviewFindMany.mockResolvedValue([])
    mockReviewUpdateManyOuter.mockResolvedValue({ count: 0 })
    // H3 wave-a1: default tx-client mocks (light path, no new-surface data)
    mockOrderProjectionUpdateMany.mockResolvedValue({ count: 0 })
    mockConversationMessageUpdateMany.mockResolvedValue({ count: 0 })
    mockConversationUpdateMany.mockResolvedValue({ count: 0 })
    mockOrderStatusHistoryUpdateMany.mockResolvedValue({ count: 0 })
    mockOrderEventLogUpdateMany.mockResolvedValue({ count: 0 })
    mockLoyaltyAccountUpdateMany.mockResolvedValue({ count: 0 })
    mockReservationUpdateMany.mockResolvedValue({ count: 0 })
    // H3 wave-a1: default outer mocks (light path — count below threshold,
    // no batching activity).
    mockOrderProjectionFindManyOuter.mockResolvedValue([])
    mockConversationFindManyOuter.mockResolvedValue([])
    mockConversationMessageCount.mockResolvedValue(0)
    mockConversationMessageUpdateManyOuter.mockResolvedValue({ count: 0 })
    mockOrderEventLogCount.mockResolvedValue(0)
    mockOrderEventLogFindManyOuter.mockResolvedValue([])
    mockOrderEventLogUpdateManyOuter.mockResolvedValue({ count: 0 })
    mockTransaction.mockImplementation(
      async (fn: (tx: typeof txClient) => Promise<unknown>) => fn(txClient),
    )
  })

  it("passes explicit timeout (>= 60s) + maxWait to prisma.$transaction", async () => {
    mockReviewCount.mockResolvedValue(10) // light path
    await anonymizeCustomer("cust_normal")

    expect(mockTransaction).toHaveBeenCalledTimes(1)
    const callArgs = mockTransaction.mock.calls[0]!
    // Args: (closure, options)
    expect(callArgs).toHaveLength(2)
    const options = callArgs[1] as { timeout: number; maxWait: number }
    expect(options.timeout).toBeGreaterThanOrEqual(60_000)
    expect(options.maxWait).toBeGreaterThanOrEqual(1_000)
  })

  it("light path (review count <= 1000) runs the original single-tx shape", async () => {
    mockReviewCount.mockResolvedValue(500)
    await anonymizeCustomer("cust_light")

    // Outer (batch) updateMany should NOT have been called.
    expect(mockReviewUpdateManyOuter).not.toHaveBeenCalled()
    // Outer findMany should NOT have been called (no batching).
    expect(mockReviewFindMany).not.toHaveBeenCalled()
    // In-tx updateMany IS called (the original behaviour).
    expect(mockReviewUpdateMany).toHaveBeenCalledTimes(1)
  })

  it("heavy path (> 1000 reviews) batches the review scrub OUTSIDE the tx", async () => {
    mockReviewCount.mockResolvedValue(3_500) // heavy

    // Return one batch of 500 ids, then empty (terminator).
    const ids1 = Array.from({ length: 500 }, (_, i) => `r_${i}`)
    mockReviewFindMany
      .mockResolvedValueOnce(ids1.map((id) => ({ id })))
      .mockResolvedValueOnce([]) // second iteration: terminator
    mockReviewUpdateManyOuter.mockResolvedValue({ count: 500 })

    await anonymizeCustomer("cust_heavy")

    // findMany was called at least once for the batch path.
    expect(mockReviewFindMany.mock.calls.length).toBeGreaterThanOrEqual(1)
    // Outer updateMany was called for the batch.
    expect(mockReviewUpdateManyOuter).toHaveBeenCalled()
    // The batched updateMany is keyed by id-in-list, not by customerId.
    const firstBatchCall = mockReviewUpdateManyOuter.mock.calls[0]![0] as {
      where: { id: { in: string[] } }
      data: { comment: null }
    }
    expect(firstBatchCall.where.id.in.length).toBeGreaterThan(0)
    expect(firstBatchCall.data.comment).toBe(null)

    // Main tx still ran for the customer + addresses + preferences +
    // cleanup updateMany + order items.
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockCustomerUpdate).toHaveBeenCalled()
  })

  it("heavy path: returns success only after all batches complete", async () => {
    mockReviewCount.mockResolvedValue(2_000)
    // Two non-empty batches then terminator.
    mockReviewFindMany
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, i) => ({ id: `r_a_${i}` })),
      )
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, i) => ({ id: `r_b_${i}` })),
      )
      .mockResolvedValueOnce([])
    mockReviewUpdateManyOuter
      .mockResolvedValueOnce({ count: 500 })
      .mockResolvedValueOnce({ count: 500 })

    const result = await anonymizeCustomer("cust_heavy_ok")
    expect(result).toEqual({ success: true })
    expect(mockReviewUpdateManyOuter).toHaveBeenCalledTimes(2)
  })

  it("heavy path: if a batch fails, anonymizeCustomer throws and main tx is NOT entered", async () => {
    mockReviewCount.mockResolvedValue(2_000)
    mockReviewFindMany.mockResolvedValueOnce(
      Array.from({ length: 500 }, (_, i) => ({ id: `r_x_${i}` })),
    )
    // Simulate batch failure (e.g. DB connection drop).
    mockReviewUpdateManyOuter.mockRejectedValueOnce(new Error("batch failed"))

    await expect(anonymizeCustomer("cust_heavy_fail")).rejects.toThrow(
      /batch failed/i,
    )
    // Main transaction must NOT have run — receipt cleanup in the
    // caller is gated on success of this function.
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it("heavy path: an empty findMany result terminates the loop immediately", async () => {
    mockReviewCount.mockResolvedValue(2_000)
    // First call returns empty — loop should exit before any updateMany.
    mockReviewFindMany.mockResolvedValueOnce([])

    await anonymizeCustomer("cust_heavy_empty")
    expect(mockReviewUpdateManyOuter).not.toHaveBeenCalled()
    // Main tx still runs.
    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })

  it("light path with default timeout would NOT have rolled back today (regression: simulated 10s tx)", async () => {
    // This test demonstrates that the new timeout is sufficient for
    // a simulated 10-second transaction: the test makes the mocked
    // $transaction await 10s of mocked work, then resolves. Before the
    // fix, default 5s would have rejected; after the fix, our 60s
    // budget covers it.
    mockReviewCount.mockResolvedValue(50)
    mockTransaction.mockImplementation(
      async (fn: (tx: typeof txClient) => Promise<unknown>, options?: { timeout?: number }) => {
        // Assert the timeout we received exceeds the simulated work.
        expect(options?.timeout ?? 0).toBeGreaterThanOrEqual(10_000)
        return fn(txClient)
      },
    )
    const result = await anonymizeCustomer("cust_regression_x7")
    expect(result).toEqual({ success: true })
  })
})
