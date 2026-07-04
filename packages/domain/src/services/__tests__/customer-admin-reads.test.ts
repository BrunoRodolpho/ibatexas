// customer.service.ts — the OPS-070 READ-ONLY admin reads.
//
//   - searchForAdmin  : case-insensitive name/email + phone substring, paginated,
//                       clamped limit, compact projection (no CPF select).
//   - getByIdForAdmin : null-returning single read WITH preferences include.
//
// Mock-based — no DB. Asserts the exact Prisma call shapes (the where/OR, the
// select whitelist, the clamp math) so a regression that widens the projection
// or drops the clamp fails here.

import { describe, it, expect, beforeEach, vi } from "vitest"

const h = vi.hoisted(() => ({
  customer: {
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
}))

vi.mock("../../client.js", () => ({
  prisma: {
    customer: h.customer,
    // array-form $transaction just settles the batched reads.
    $transaction: (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
  },
}))

vi.mock("@ibatexas/nats-client", () => ({ publishNatsEvent: vi.fn() }))

import { createCustomerService } from "../customer.service.js"

beforeEach(() => vi.clearAllMocks())

describe("searchForAdmin", () => {
  it("builds a case-insensitive name/email OR + phone substring for a query", async () => {
    h.customer.findMany.mockResolvedValue([
      { id: "c1", name: "Ana", phone: "+55119", email: "ana@x.com", source: "web", createdAt: new Date() },
    ])
    h.customer.count.mockResolvedValue(1)

    const svc = createCustomerService()
    const res = await svc.searchForAdmin({ q: "  ana  ", limit: 10, offset: 5 })

    expect(res.count).toBe(1)
    expect(res.customers).toHaveLength(1)

    const findArgs = h.customer.findMany.mock.calls[0][0]
    expect(findArgs.where).toEqual({
      OR: [
        { name: { contains: "ana", mode: "insensitive" } },
        { email: { contains: "ana", mode: "insensitive" } },
        { phone: { contains: "ana" } },
      ],
    })
    expect(findArgs.take).toBe(10)
    expect(findArgs.skip).toBe(5)
    expect(findArgs.orderBy).toEqual({ createdAt: "desc" })
    // Compact projection — CPF is NOT selected.
    expect(findArgs.select).toEqual({
      id: true,
      name: true,
      phone: true,
      email: true,
      source: true,
      createdAt: true,
    })
    expect(findArgs.select).not.toHaveProperty("cpf")
    // The count runs against the SAME where.
    expect(h.customer.count.mock.calls[0][0]).toEqual({ where: findArgs.where })
  })

  it("uses an empty where (list all) when no query is given", async () => {
    h.customer.findMany.mockResolvedValue([])
    h.customer.count.mockResolvedValue(0)

    const svc = createCustomerService()
    await svc.searchForAdmin({})

    expect(h.customer.findMany.mock.calls[0][0].where).toEqual({})
  })

  it("treats a whitespace-only query as no filter", async () => {
    h.customer.findMany.mockResolvedValue([])
    h.customer.count.mockResolvedValue(0)

    const svc = createCustomerService()
    await svc.searchForAdmin({ q: "   " })

    expect(h.customer.findMany.mock.calls[0][0].where).toEqual({})
  })

  it("clamps the limit into [1, 50] and floors offset at 0", async () => {
    h.customer.findMany.mockResolvedValue([])
    h.customer.count.mockResolvedValue(0)

    const svc = createCustomerService()
    await svc.searchForAdmin({ limit: 999, offset: -7 })
    expect(h.customer.findMany.mock.calls[0][0].take).toBe(50)
    expect(h.customer.findMany.mock.calls[0][0].skip).toBe(0)

    await svc.searchForAdmin({ limit: 0 })
    expect(h.customer.findMany.mock.calls[1][0].take).toBe(1)
  })

  it("defaults to limit 20 / offset 0 when unspecified", async () => {
    h.customer.findMany.mockResolvedValue([])
    h.customer.count.mockResolvedValue(0)

    const svc = createCustomerService()
    await svc.searchForAdmin()
    expect(h.customer.findMany.mock.calls[0][0].take).toBe(20)
    expect(h.customer.findMany.mock.calls[0][0].skip).toBe(0)
  })
})

describe("getByIdForAdmin", () => {
  it("does a null-returning findUnique that includes preferences", async () => {
    const row = { id: "c1", phone: "+55", preferences: { allergenExclusions: [] } }
    h.customer.findUnique.mockResolvedValue(row)

    const svc = createCustomerService()
    const res = await svc.getByIdForAdmin("c1")

    expect(res).toBe(row)
    expect(h.customer.findUnique).toHaveBeenCalledWith({
      where: { id: "c1" },
      include: { preferences: true },
    })
  })

  it("returns null for an unknown id (never throws)", async () => {
    h.customer.findUnique.mockResolvedValue(null)
    const svc = createCustomerService()
    await expect(svc.getByIdForAdmin("nope")).resolves.toBeNull()
  })
})
