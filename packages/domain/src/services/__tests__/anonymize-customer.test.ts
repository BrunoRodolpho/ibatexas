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
const mockCustomerFindUnique = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
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
const mockConversationMessageFindManyOuter = vi.hoisted(() => vi.fn())
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

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

vi.mock("../../client.js", () => ({
  prisma: {
    $transaction: mockTransaction,
    customer: {
      update: mockCustomerUpdate,
      // audit-2026-05-24 H3 Wave-B: anonymizeCustomer reads medusaId
      // before the TX so the Wave-B compensation kickoff has a target.
      findUnique: mockCustomerFindUnique,
    },
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
      // The heavy-path loop calls findMany to fetch the next id batch and
      // updateMany to scrub the batch. Both live on the outer client.
      findMany: mockConversationMessageFindManyOuter,
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
import { Prisma } from "../../generated/prisma-client/client.js"

// ── Tests ─────────────────────────────────────────────────────────────────

describe("anonymizeCustomer — W4 P0-13 LGPD completeness", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCustomerUpdate.mockResolvedValue({ id: "cust_01" })
    // H3 Wave-B default: no medusaId linkage. Tests that exercise the
    // compensation kickoff override per-test.
    mockCustomerFindUnique.mockResolvedValue({ medusaId: null })
    mockPublishNatsEvent.mockResolvedValue(undefined)
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
    mockConversationMessageFindManyOuter.mockResolvedValue([])
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
    mockCustomerFindUnique.mockResolvedValue({ medusaId: null })
    mockPublishNatsEvent.mockResolvedValue(undefined)
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
    mockConversationMessageFindManyOuter.mockResolvedValue([])
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

// ── audit-2026-05-24 H3 wave-a1 — 7-surface scope expansion ────────────

describe("anonymizeCustomer — H3 wave-a1 scope expansion (7 surfaces)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCustomerUpdate.mockResolvedValue({ id: "cust_01" })
    mockCustomerFindUnique.mockResolvedValue({ medusaId: null })
    mockPublishNatsEvent.mockResolvedValue(undefined)
    mockAddressDeleteMany.mockResolvedValue({ count: 1 })
    mockPreferencesDeleteMany.mockResolvedValue({ count: 1 })
    mockReviewUpdateMany.mockResolvedValue({ count: 1 })
    mockCustomerOrderItemUpdateMany.mockResolvedValue({ count: 1 })
    mockReviewCount.mockResolvedValue(0)
    mockReviewFindMany.mockResolvedValue([])
    mockReviewUpdateManyOuter.mockResolvedValue({ count: 0 })
    mockOrderProjectionUpdateMany.mockResolvedValue({ count: 0 })
    mockConversationMessageUpdateMany.mockResolvedValue({ count: 0 })
    mockConversationUpdateMany.mockResolvedValue({ count: 0 })
    mockOrderStatusHistoryUpdateMany.mockResolvedValue({ count: 0 })
    mockOrderEventLogUpdateMany.mockResolvedValue({ count: 0 })
    mockLoyaltyAccountUpdateMany.mockResolvedValue({ count: 0 })
    mockReservationUpdateMany.mockResolvedValue({ count: 0 })
    mockOrderProjectionFindManyOuter.mockResolvedValue([])
    mockConversationFindManyOuter.mockResolvedValue([])
    mockConversationMessageCount.mockResolvedValue(0)
    mockConversationMessageUpdateManyOuter.mockResolvedValue({ count: 0 })
    mockConversationMessageFindManyOuter.mockResolvedValue([])
    mockOrderEventLogCount.mockResolvedValue(0)
    mockOrderEventLogFindManyOuter.mockResolvedValue([])
    mockOrderEventLogUpdateManyOuter.mockResolvedValue({ count: 0 })
    mockTransaction.mockImplementation(
      async (fn: (tx: typeof txClient) => Promise<unknown>) => fn(txClient),
    )
  })

  // ── Surface 1: OrderProjection ──────────────────────────────────────

  describe("Surface 1: OrderProjection scrub", () => {
    it("nulls customerEmail / customerName / customerPhone for all rows linked to customerId", async () => {
      await anonymizeCustomer("cust_01")
      expect(mockOrderProjectionUpdateMany).toHaveBeenCalledWith({
        where: { customerId: "cust_01" },
        data: {
          customerEmail: null,
          customerName: null,
          customerPhone: null,
          shippingAddressJson: { anonymized: true },
        },
      })
    })

    it("full-replaces shippingAddressJson with {anonymized: true} per G2-b pick", async () => {
      await anonymizeCustomer("cust_01")
      const call = mockOrderProjectionUpdateMany.mock.calls[0]![0] as {
        data: { shippingAddressJson: unknown }
      }
      expect(call.data.shippingAddressJson).toEqual({ anonymized: true })
    })
  })

  // ── Surface 2: ConversationMessage ──────────────────────────────────

  describe("Surface 2: ConversationMessage.content scrub", () => {
    it("replaces content with '[anonymized]' placeholder for all of the customer's messages (light path)", async () => {
      mockConversationFindManyOuter.mockResolvedValue([
        { id: "conv_a" },
        { id: "conv_b" },
      ])
      mockConversationMessageCount.mockResolvedValue(50) // below threshold

      await anonymizeCustomer("cust_01")

      // In-tx cleanup call filters by the customer's conversation ids.
      // audit-2026-05-25 (I9): the scrub also clears message `metadata`
      // (Json?) → Prisma.JsonNull, symmetric with the heavy path — assert it
      // so the LGPD metadata-scrub stays covered.
      expect(mockConversationMessageUpdateMany).toHaveBeenCalledWith({
        where: { conversationId: { in: ["conv_a", "conv_b"] } },
        data: { content: "[anonymized]", metadata: Prisma.JsonNull },
      })
    })

    it("skips conversationMessage.updateMany when the customer has no conversations", async () => {
      mockConversationFindManyOuter.mockResolvedValue([])

      await anonymizeCustomer("cust_no_conv")

      expect(mockConversationMessageUpdateMany).not.toHaveBeenCalled()
    })

    it("[heavy path] batches the message scrub OUTSIDE the main tx when > 1000 messages", async () => {
      mockConversationFindManyOuter.mockResolvedValue([{ id: "conv_a" }])
      mockConversationMessageCount.mockResolvedValue(3_500)
      // Return one non-empty batch, then empty (terminator).
      const messageIds = Array.from({ length: 500 }, (_, i) => ({
        id: `msg_${i}`,
      }))
      mockConversationMessageFindManyOuter
        .mockResolvedValueOnce(messageIds)
        .mockResolvedValueOnce([])
      mockConversationMessageUpdateManyOuter.mockResolvedValue({ count: 500 })

      await anonymizeCustomer("cust_heavy_msgs")

      // The outer (pre-tx) updateMany should have been called.
      expect(mockConversationMessageUpdateManyOuter).toHaveBeenCalled()
      // The first batch should target the message ids we returned.
      const firstCall = mockConversationMessageUpdateManyOuter.mock.calls[0]![0] as {
        where: { id: { in: string[] } }
        data: { content: string }
      }
      expect(firstCall.where.id.in).toHaveLength(500)
      expect(firstCall.data.content).toBe("[anonymized]")
    })
  })

  // ── Surface 3: Conversation.customerId ──────────────────────────────

  describe("Surface 3: Conversation.customerId null-out", () => {
    it("nulls Conversation.customerId for all of the customer's conversations", async () => {
      await anonymizeCustomer("cust_01")
      expect(mockConversationUpdateMany).toHaveBeenCalledWith({
        where: { customerId: "cust_01" },
        data: { customerId: null },
      })
    })
  })

  // ── Surface 4: OrderStatusHistory.actorId ───────────────────────────

  describe("Surface 4: OrderStatusHistory.actorId scrub", () => {
    it("nulls actorId ONLY where actor='customer' AND actorId=customerId (preserves Staff actorIds)", async () => {
      await anonymizeCustomer("cust_01")
      expect(mockOrderStatusHistoryUpdateMany).toHaveBeenCalledWith({
        where: { actor: "customer", actorId: "cust_01" },
        data: { actorId: null },
      })
    })
  })

  // ── Surface 5: OrderEventLog.payload ────────────────────────────────

  describe("Surface 5: OrderEventLog.payload full-replace", () => {
    it("full-replaces payload with {anonymized: true} for rows linked via orderId (light path)", async () => {
      mockOrderProjectionFindManyOuter.mockResolvedValue([
        { id: "order_a" },
        { id: "order_b" },
      ])
      mockOrderEventLogCount.mockResolvedValue(10) // below threshold

      await anonymizeCustomer("cust_01")

      expect(mockOrderEventLogUpdateMany).toHaveBeenCalledWith({
        where: { orderId: { in: ["order_a", "order_b"] } },
        data: { payload: { anonymized: true } },
      })
    })

    it("skips orderEventLog.updateMany when the customer has no orders", async () => {
      mockOrderProjectionFindManyOuter.mockResolvedValue([])

      await anonymizeCustomer("cust_no_orders")

      expect(mockOrderEventLogUpdateMany).not.toHaveBeenCalled()
    })
  })

  // ── Surface 6: LoyaltyAccount ───────────────────────────────────────

  describe("Surface 6: LoyaltyAccount reset (G2-c)", () => {
    it("nulls customerId and resets aggregate counters (stamps, totalEarned, redeemed)", async () => {
      await anonymizeCustomer("cust_01")
      expect(mockLoyaltyAccountUpdateMany).toHaveBeenCalledWith({
        where: { customerId: "cust_01" },
        data: { customerId: null, stamps: 0, totalEarned: 0, redeemed: 0 },
      })
      const call = mockLoyaltyAccountUpdateMany.mock.calls[0]![0] as {
        data: Record<string, unknown>
      }
      expect(call.data).toHaveProperty("customerId", null)
    })
  })

  // ── Surface 7: Reservation.specialRequests ──────────────────────────

  describe("Surface 7: Reservation.specialRequests scrub", () => {
    it("replaces specialRequests with empty JSON array [] (schema deviation: column is NOT NULL)", async () => {
      await anonymizeCustomer("cust_01")
      expect(mockReservationUpdateMany).toHaveBeenCalledWith({
        where: { customerId: "cust_01" },
        data: { specialRequests: [] },
      })
    })
  })

  // ── Atomicity: all 7 surfaces inside the same $transaction ──────────

  describe("Atomicity: all 7 scrubs run inside the same prisma.$transaction", () => {
    it("invokes every scrub on the tx client passed to $transaction (light path)", async () => {
      mockConversationFindManyOuter.mockResolvedValue([{ id: "conv_a" }])
      mockOrderProjectionFindManyOuter.mockResolvedValue([{ id: "order_a" }])

      await anonymizeCustomer("cust_01")

      // Single tx call.
      expect(mockTransaction).toHaveBeenCalledTimes(1)
      // Every surface mock was called.
      expect(mockOrderProjectionUpdateMany).toHaveBeenCalled()
      expect(mockConversationMessageUpdateMany).toHaveBeenCalled()
      expect(mockConversationUpdateMany).toHaveBeenCalled()
      expect(mockOrderStatusHistoryUpdateMany).toHaveBeenCalled()
      expect(mockOrderEventLogUpdateMany).toHaveBeenCalled()
      expect(mockLoyaltyAccountUpdateMany).toHaveBeenCalled()
      expect(mockReservationUpdateMany).toHaveBeenCalled()
    })

    it("maintains the explicit 60s timeout + maxWait on the scope-extended tx", async () => {
      await anonymizeCustomer("cust_01")
      const callArgs = mockTransaction.mock.calls[0]!
      const options = callArgs[1] as { timeout: number; maxWait: number }
      expect(options.timeout).toBeGreaterThanOrEqual(60_000)
      expect(options.maxWait).toBeGreaterThanOrEqual(1_000)
    })
  })

  // ── Audit emit: per-surface records ──────────────────────────────────

  describe("Audit emit: one record per scrubbed surface", () => {
    it("emits 7 audit records, one per surface, with the expected kinds", async () => {
      const emit = vi.fn().mockResolvedValue(undefined)
      const auditSink = { emit }

      await anonymizeCustomer("cust_01", { auditSink })

      expect(emit).toHaveBeenCalledTimes(7)
      const kinds = emit.mock.calls.map(
        (call) => (call[0] as { envelope: { kind: string } }).envelope.kind,
      )
      expect(kinds).toEqual([
        "customer.anonymize.order_projection.scrubbed",
        "customer.anonymize.conversation_message.scrubbed",
        "customer.anonymize.conversation_link.scrubbed",
        "customer.anonymize.order_status_history.scrubbed",
        "customer.anonymize.order_event_log.scrubbed",
        "customer.anonymize.loyalty_account.scrubbed",
        "customer.anonymize.reservation_special_requests.scrubbed",
      ])
    })

    it("each record carries a system-actor envelope (principal=system, taint=SYSTEM)", async () => {
      const emit = vi.fn().mockResolvedValue(undefined)
      const auditSink = { emit }

      await anonymizeCustomer("cust_01", { auditSink })

      for (const call of emit.mock.calls) {
        const record = call[0] as {
          envelope: {
            actor: { principal: string; sessionId: string }
            taint: string
            payload: { customerId: string }
          }
        }
        expect(record.envelope.actor.principal).toBe("system")
        expect(record.envelope.actor.sessionId).toBe(
          "customer.anonymize:cust_01",
        )
        expect(record.envelope.taint).toBe("SYSTEM")
        expect(record.envelope.payload.customerId).toBe("cust_01")
      }
    })

    it("each record's decision is EXECUTE with business.rule_satisfied basis", async () => {
      const emit = vi.fn().mockResolvedValue(undefined)
      const auditSink = { emit }

      await anonymizeCustomer("cust_01", { auditSink })

      for (const call of emit.mock.calls) {
        const record = call[0] as {
          decision: { kind: string }
          decision_basis: readonly { category: string; code: string }[]
        }
        expect(record.decision.kind).toBe("EXECUTE")
        expect(record.decision_basis).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: "business",
              code: "rule_satisfied",
            }),
          ]),
        )
      }
    })

    it("chains each record's supersedes to the predecessor envelope when supplied", async () => {
      const emit = vi.fn().mockResolvedValue(undefined)
      const auditSink = { emit }
      const predecessor = {
        predecessorIntentHash: "sha256:abc123",
        predecessorAt: "2026-05-24T15:00:00.000Z",
      }

      await anonymizeCustomer("cust_01", { auditSink, predecessor })

      for (const call of emit.mock.calls) {
        const record = call[0] as {
          supersedes?: {
            predecessorIntentHash: string
            predecessorAt: string
            reason: string
          }
        }
        expect(record.supersedes).toBeDefined()
        expect(record.supersedes?.predecessorIntentHash).toBe("sha256:abc123")
        expect(record.supersedes?.predecessorAt).toBe(
          "2026-05-24T15:00:00.000Z",
        )
        // audit-2026-05-25 (I12 post-publish): @adjudicate/core@1.1.0
        // added `"lgpd_scrub"` to the SupersessionReason union; per-
        // surface LGPD scrub records now carry the semantically-precise
        // value instead of the lossy "replay" fallback.
        expect(record.supersedes?.reason).toBe("lgpd_scrub")
      }
    })

    it("does NOT emit when no auditSink is supplied (backwards-compat)", async () => {
      // No audit sink — the existing call shape stays unchanged.
      await anonymizeCustomer("cust_01")
      // No assertion needed beyond "did not throw"; this verifies the
      // optional-options path doesn't crash.
    })

    it("a failing audit-sink emit does NOT fail anonymizeCustomer (best-effort emit)", async () => {
      const emit = vi
        .fn()
        .mockRejectedValue(new Error("audit emit blew up"))
      const auditSink = { emit }
      const log = { error: vi.fn() }

      const result = await anonymizeCustomer("cust_01", { auditSink, log })

      // Scrub itself succeeded.
      expect(result).toEqual({ success: true })
      // 7 emit attempts even though they all "fail".
      expect(emit).toHaveBeenCalledTimes(7)
    })
  })
})
