// Tests for anonymizeCustomer — LGPD Art. 18 erasure (P0-LGPD-1, RC-A2).
// Mock-based; prisma.$transaction is stubbed to run the callback against txClient.

import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCustomerFindUnique = vi.hoisted(() => vi.fn())
const mockCustomerUpdate = vi.hoisted(() => vi.fn())
const mockAddressDeleteMany = vi.hoisted(() => vi.fn())
const mockPrefsDeleteMany = vi.hoisted(() => vi.fn())
const mockReviewUpdateMany = vi.hoisted(() => vi.fn())
const mockConversationDeleteMany = vi.hoisted(() => vi.fn())
const mockOrderItemUpdateMany = vi.hoisted(() => vi.fn())

const txClient = {
  customer: { findUnique: mockCustomerFindUnique, update: mockCustomerUpdate },
  address: { deleteMany: mockAddressDeleteMany },
  customerPreferences: { deleteMany: mockPrefsDeleteMany },
  review: { updateMany: mockReviewUpdateMany },
  conversation: { deleteMany: mockConversationDeleteMany },
  customerOrderItem: { updateMany: mockOrderItemUpdateMany },
}

vi.mock("../client.js", () => ({
  prisma: {
    $transaction: vi.fn((fn: (tx: typeof txClient) => Promise<unknown>) => fn(txClient)),
  },
}))

import { anonymizeCustomer } from "../services/customer.service.js"

describe("anonymizeCustomer — LGPD Art. 18 erasure (P0-LGPD-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCustomerFindUnique.mockResolvedValue({ erasedAt: null })
    mockCustomerUpdate.mockResolvedValue({})
    mockAddressDeleteMany.mockResolvedValue({ count: 0 })
    mockPrefsDeleteMany.mockResolvedValue({ count: 0 })
    mockReviewUpdateMany.mockResolvedValue({ count: 0 })
    mockConversationDeleteMany.mockResolvedValue({ count: 0 })
    mockOrderItemUpdateMany.mockResolvedValue({ count: 0 })
  })

  it("erases phone (tombstone), cpf, name, email and sets erasedAt", async () => {
    const res = await anonymizeCustomer("cust_01")

    expect(res).toEqual({ success: true, alreadyErased: false })
    expect(mockCustomerUpdate).toHaveBeenCalledWith({
      where: { id: "cust_01" },
      data: expect.objectContaining({
        name: "Usuário Removido",
        email: null,
        phone: "removed:cust_01", // the @unique WhatsApp identity, tombstoned (cannot be null)
        cpf: null,
        erasedAt: expect.any(Date),
      }),
    })
  })

  it("redacts review prose and deletes conversation transcripts", async () => {
    await anonymizeCustomer("cust_01")

    expect(mockReviewUpdateMany).toHaveBeenCalledWith({
      where: { customerId: "cust_01" },
      data: { comment: null },
    })
    expect(mockConversationDeleteMany).toHaveBeenCalledWith({ where: { customerId: "cust_01" } })
  })

  it("deletes addresses + preferences and delinks order items (fiscal retention)", async () => {
    await anonymizeCustomer("cust_01")

    expect(mockAddressDeleteMany).toHaveBeenCalledWith({ where: { customerId: "cust_01" } })
    expect(mockPrefsDeleteMany).toHaveBeenCalledWith({ where: { customerId: "cust_01" } })
    expect(mockOrderItemUpdateMany).toHaveBeenCalledWith({
      where: { customerId: "cust_01" },
      data: { customerId: null },
    })
  })

  it("is idempotent — an already-erased customer is a no-op", async () => {
    mockCustomerFindUnique.mockResolvedValue({ erasedAt: new Date("2026-05-01") })

    const res = await anonymizeCustomer("cust_01")

    expect(res).toEqual({ success: true, alreadyErased: true })
    expect(mockCustomerUpdate).not.toHaveBeenCalled()
    expect(mockReviewUpdateMany).not.toHaveBeenCalled()
    expect(mockConversationDeleteMany).not.toHaveBeenCalled()
  })

  it("returns failure when the customer does not exist", async () => {
    mockCustomerFindUnique.mockResolvedValue(null)

    const res = await anonymizeCustomer("missing")

    expect(res).toEqual({ success: false, alreadyErased: false })
    expect(mockCustomerUpdate).not.toHaveBeenCalled()
  })
})
