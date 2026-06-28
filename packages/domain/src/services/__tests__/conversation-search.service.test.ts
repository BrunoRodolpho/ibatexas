// Tests for the admin conversation search methods (responder-trace-admin D1):
//   - findByCustomerId — per-customer conversation summaries.
//   - searchConversations — dispatch on sessionId → customerId → phone → recent.
//
// Mock-based; no DB. toE164BR runs for real (pure canonicalizer).

import { describe, it, expect, beforeEach, vi } from "vitest"

const mockConvFindMany = vi.hoisted(() => vi.fn())
const mockCustomerFindUnique = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    conversation: { findMany: mockConvFindMany },
    customer: { findUnique: mockCustomerFindUnique },
  },
}))

vi.mock("../../generated/prisma-client/client.js", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class {
      code = ""
    },
  },
}))

import { createConversationService } from "../conversation.service.js"

const ROW = (sessionId: string, customerId: string | null) => ({
  id: `id-${sessionId}`,
  sessionId,
  customerId,
  channel: "web",
  _count: { messages: 3 },
  messages: [{ sentAt: new Date("2026-06-14T00:00:00.000Z") }],
})

describe("conversation service — admin search (D1)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConvFindMany.mockResolvedValue([])
    mockCustomerFindUnique.mockResolvedValue(null)
  })

  it("findByCustomerId filters by customerId and maps summaries", async () => {
    mockConvFindMany.mockResolvedValue([ROW("s1", "cust-1")])
    const svc = createConversationService()
    const rows = await svc.findByCustomerId("cust-1", 25)

    expect(mockConvFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerId: "cust-1" }, take: 25 }),
    )
    expect(rows).toEqual([
      {
        id: "id-s1",
        sessionId: "s1",
        customerId: "cust-1",
        channel: "web",
        messageCount: 3,
        lastMessageAt: new Date("2026-06-14T00:00:00.000Z"),
      },
    ])
  })

  it("searchConversations(sessionId) queries by sessionId, take 1", async () => {
    mockConvFindMany.mockResolvedValue([ROW("sess-x", "cust-9")])
    const svc = createConversationService()
    const rows = await svc.searchConversations({ sessionId: "sess-x" })
    expect(mockConvFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: "sess-x" }, take: 1 }),
    )
    expect(rows[0]!.sessionId).toBe("sess-x")
  })

  it("searchConversations(customerId) delegates to the customerId filter", async () => {
    mockConvFindMany.mockResolvedValue([ROW("s2", "cust-2")])
    const svc = createConversationService()
    await svc.searchConversations({ customerId: "cust-2" })
    expect(mockConvFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerId: "cust-2" } }),
    )
  })

  it("searchConversations(phone) resolves phone → customerId via canonicalized lookup", async () => {
    mockCustomerFindUnique.mockResolvedValue({ id: "cust-3" })
    mockConvFindMany.mockResolvedValue([ROW("s3", "cust-3")])
    const svc = createConversationService()
    // Formatted E.164 input → stripped to the canonical @unique value.
    const rows = await svc.searchConversations({ phone: "+55 (11) 99999-8888" })

    expect(mockCustomerFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phone: "+5511999998888" } }),
    )
    expect(mockConvFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerId: "cust-3" } }),
    )
    expect(rows[0]!.customerId).toBe("cust-3")
  })

  it("searchConversations(phone) with no matching customer returns []", async () => {
    mockCustomerFindUnique.mockResolvedValue(null)
    const svc = createConversationService()
    const rows = await svc.searchConversations({ phone: "+5511000000000" })
    expect(rows).toEqual([])
    expect(mockConvFindMany).not.toHaveBeenCalled()
  })

  it("searchConversations(phone) with a malformed phone degrades to [] (no 500)", async () => {
    const svc = createConversationService()
    const rows = await svc.searchConversations({ phone: "not-a-phone" })
    expect(rows).toEqual([])
    expect(mockCustomerFindUnique).not.toHaveBeenCalled()
  })

  it("searchConversations({}) falls back to recent activity (listActive)", async () => {
    mockConvFindMany.mockResolvedValue([ROW("s4", null)])
    const svc = createConversationService()
    await svc.searchConversations({})
    expect(mockConvFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { startedAt: "desc" } }),
    )
  })
})
