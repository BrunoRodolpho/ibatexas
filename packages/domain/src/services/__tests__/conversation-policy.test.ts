// conversation-policy — customer-scoping guard (Phase D · D3).
//
// Non-vacuous tests for `assertConversationOwnership`: the defense-in-depth
// PRIMITIVE for future customer-facing conversation reads. Strict-by-default,
// mirroring R0b's order ownership — every case below goes RED if the guard is
// reverted to a lenient default (cross-customer/null-owner allowed through).
//
// The guard is NOT wired into `getTranscript()` (staff path); the final block
// asserts that staff-reachable behavior is unchanged.

import { describe, it, expect, beforeEach, vi } from "vitest"

const mockConversationFindUnique = vi.hoisted(() => vi.fn())
const mockMessageFindMany = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    conversation: { findUnique: mockConversationFindUnique },
    conversationMessage: { findMany: mockMessageFindMany },
  },
}))

import { assertConversationOwnership } from "../__shared__/conversation-policy.js"
import { createConversationService } from "../conversation.service.js"
import { NonRetryableError } from "@ibatexas/types"

const CONV = "conv_01"

describe("assertConversationOwnership — strict-by-default customer scoping (D3)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // (a) cross-customer: owner ≠ caller → REFUSED. A lenient default would pass.
  it("REFUSES a cross-customer conversation (owner ≠ caller)", async () => {
    mockConversationFindUnique.mockResolvedValue({ customerId: "cust-B" })
    await expect(
      assertConversationOwnership(CONV, "cust-A"),
    ).rejects.toThrow(NonRetryableError)
    await expect(
      assertConversationOwnership(CONV, "cust-A"),
    ).rejects.toThrow(/outro cliente/)
  })

  // (a') the escape hatch NEVER relaxes a cross-customer mismatch.
  it("REFUSES a cross-customer conversation even with { allowUnowned: true }", async () => {
    mockConversationFindUnique.mockResolvedValue({ customerId: "cust-B" })
    await expect(
      assertConversationOwnership(CONV, "cust-A", { allowUnowned: true }),
    ).rejects.toThrow(NonRetryableError)
  })

  // (b) null/absent owner, no escape hatch → REFUSED (Inv 2: "no owner" ≠ "any owner").
  it("REFUSES a null-owner conversation with no escape hatch (Inv 2)", async () => {
    mockConversationFindUnique.mockResolvedValue({ customerId: null })
    await expect(
      assertConversationOwnership(CONV, "cust-A"),
    ).rejects.toThrow(NonRetryableError)
  })

  // (c) matching owner → passes (resolveOwnership binds the pair).
  it("PASSES a matching-owner conversation", async () => {
    mockConversationFindUnique.mockResolvedValue({ customerId: "cust-A" })
    await expect(
      assertConversationOwnership(CONV, "cust-A"),
    ).resolves.toBeUndefined()
  })

  // (c) staff escape: { allowUnowned: true } passes an unowned conversation —
  // the ONLY way an unowned conversation gets through.
  it("PASSES a null-owner conversation WITH { allowUnowned: true }", async () => {
    mockConversationFindUnique.mockResolvedValue({ customerId: null })
    await expect(
      assertConversationOwnership(CONV, "cust-A", { allowUnowned: true }),
    ).resolves.toBeUndefined()
  })

  it("REFUSES (not-found) when the conversation does not exist", async () => {
    mockConversationFindUnique.mockResolvedValue(null)
    await expect(
      assertConversationOwnership(CONV, "cust-A"),
    ).rejects.toThrow(/não encontrada/)
  })
})

// (d) Staff-reachable behavior unchanged: the customer guard is NOT wired into
// getTranscript(). A staff read returns the transcript without ANY ownership
// lookup (no conversation.findUnique), proving the staff path was not touched.
describe("getTranscript — staff path unchanged (D3 did not wire the customer guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the transcript with NO customer-ownership lookup", async () => {
    mockMessageFindMany.mockResolvedValue([
      { role: "user", content: "oi", sentAt: new Date(0), metadata: null },
    ])
    const svc = createConversationService()
    const rows = await svc.getTranscript(CONV)

    expect(rows).toHaveLength(1)
    expect(mockMessageFindMany).toHaveBeenCalledOnce()
    // The defense-in-depth customer guard was NOT invoked on the staff path.
    expect(mockConversationFindUnique).not.toHaveBeenCalled()
  })
})
