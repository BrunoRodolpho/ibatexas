// BKL-159 (review fix, 2026-07-17) — the falsifier probes behind the claims
// refund/chargeback arm. Predicate-shaped findFirst reads: complete by
// construction (a where-clause sees EVERY payment row, unlike the paged
// listByOrderId the claims path previously scanned) and cheap (no $transaction,
// no count). These tests pin the PREDICATES — both sides of the ratified
// partial-refund boundary — by asserting the exact where-clauses handed to
// prisma, plus the passthrough of the matched row.

import { describe, it, expect, vi, beforeEach } from "vitest"

const findFirstMock = vi.fn<(args: unknown) => Promise<unknown>>()

vi.mock("../../client.js", () => ({
  prisma: {
    payment: {
      findFirst: (args: unknown) => findFirstMock(args),
    },
  },
}))

const { createPaymentQueryService } = await import("../payment-query.service.js")

interface FindFirstArgs {
  where: {
    orderId: string
    OR?: Array<Record<string, unknown>>
    status?: unknown
  }
  orderBy: Record<string, string>
}

describe("findRefundBearingByOrderId", () => {
  beforeEach(() => findFirstMock.mockReset())

  it("probes with the COMPLETE refund predicate: amount>0 OR refund statuses (RATIFIED — partial refunds fire)", async () => {
    findFirstMock.mockResolvedValue(null)
    const result = await createPaymentQueryService().findRefundBearingByOrderId("ord-1")

    expect(result).toBeNull()
    expect(findFirstMock).toHaveBeenCalledTimes(1)
    const args = findFirstMock.mock.calls[0][0] as FindFirstArgs
    expect(args.where.orderId).toBe("ord-1")
    expect(args.where.OR).toEqual([
      { refundedAmountCentavos: { gt: 0 } },
      { status: { in: ["refunded", "partially_refunded"] } },
    ])
    expect(args.orderBy).toEqual({ createdAt: "desc" })
  })

  it("returns the matched refund-bearing row verbatim (audit fields flow through)", async () => {
    const row = { id: "pay-1", orderId: "ord-1", status: "partially_refunded", refundedAmountCentavos: 500 }
    findFirstMock.mockResolvedValue(row)
    await expect(
      createPaymentQueryService().findRefundBearingByOrderId("ord-1"),
    ).resolves.toBe(row)
  })
})

describe("findDisputedByOrderId", () => {
  beforeEach(() => findFirstMock.mockReset())

  it("probes ONLY the disputed status (the chargeback signal), most-recent first", async () => {
    findFirstMock.mockResolvedValue(null)
    const result = await createPaymentQueryService().findDisputedByOrderId("ord-2")

    expect(result).toBeNull()
    const args = findFirstMock.mock.calls[0][0] as FindFirstArgs
    expect(args.where).toEqual({ orderId: "ord-2", status: "disputed" })
    expect(args.orderBy).toEqual({ createdAt: "desc" })
  })

  it("returns the matched disputed row verbatim", async () => {
    const row = { id: "pay-9", orderId: "ord-2", status: "disputed", refundedAmountCentavos: 0 }
    findFirstMock.mockResolvedValue(row)
    await expect(createPaymentQueryService().findDisputedByOrderId("ord-2")).resolves.toBe(row)
  })
})
