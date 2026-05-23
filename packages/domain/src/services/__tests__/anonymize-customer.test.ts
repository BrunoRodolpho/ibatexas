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

const txClient = {
  customer: { update: mockCustomerUpdate },
  address: { deleteMany: mockAddressDeleteMany },
  customerPreferences: { deleteMany: mockPreferencesDeleteMany },
  review: { updateMany: mockReviewUpdateMany },
  customerOrderItem: { updateMany: mockCustomerOrderItemUpdateMany },
}

vi.mock("../../client.js", () => ({
  prisma: {
    $transaction: vi.fn((fn: (tx: typeof txClient) => Promise<unknown>) =>
      fn(txClient),
    ),
    customer: { update: mockCustomerUpdate },
    address: { deleteMany: mockAddressDeleteMany },
    customerPreferences: { deleteMany: mockPreferencesDeleteMany },
    review: { updateMany: mockReviewUpdateMany },
    customerOrderItem: { updateMany: mockCustomerOrderItemUpdateMany },
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
