// OrderQueryService.getById — owner-scoping tests (SDD §N P0-3, Inv 2/13).
//
// Mock-based; no DB required. Closes the IDOR where an orderId-only read
// returned any customer's order projection.
//
// Scenarios:
// - customer-scoped read of a non-owned order            → null (no leak)
// - customer-scoped read of an owned order               → projection (no regression)
// - Inv 2: customer-scoped read of a NULL-owner order     → null (REFUSED, not leaked)
// - internal/staff unscoped read (no customerId)          → projection (no regression)
// - non-vacuity guard: removing the owner filter would leak (documented)

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockOrderFindUnique = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    orderProjection: {
      findUnique: mockOrderFindUnique,
    },
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import { createOrderQueryService } from "../order-query.service.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_01",
    displayId: 1001,
    customerId: "cus_owner",
    customerEmail: "owner@example.com",
    customerName: "Owner",
    customerPhone: null,
    fulfillmentStatus: "pending",
    paymentStatus: "payment_pending",
    totalInCentavos: 8900,
    subtotalInCentavos: 8900,
    shippingInCentavos: 0,
    itemCount: 1,
    itemsJson: null,
    itemsSchemaVersion: 1,
    shippingAddressJson: null,
    deliveryType: "delivery",
    paymentMethod: "pix",
    tipInCentavos: 0,
    version: 1,
    medusaCreatedAt: new Date("2026-04-12T10:00:00Z"),
    createdAt: new Date("2026-04-12T10:00:00Z"),
    updatedAt: new Date("2026-04-12T10:05:00Z"),
    currentPaymentId: null,
    statusHistory: [],
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OrderQueryService.getById — owner-scoping (SDD §N P0-3, Inv 2/13)", () => {
  let svc: ReturnType<typeof createOrderQueryService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createOrderQueryService()
  })

  // 1. Cross-customer read is REFUSED — the core IDOR.
  it("returns null for a customer-scoped read of an order owned by another customer", async () => {
    mockOrderFindUnique.mockResolvedValue(makeOrder({ customerId: "cus_owner" }))

    const result = await svc.getById("order_01", { customerId: "cus_attacker" })

    // No cross-customer order data is returned.
    expect(result).toBeNull()
  })

  // 2. Owned read still works — no regression.
  it("returns the projection for a customer-scoped read of an owned order", async () => {
    const order = makeOrder({ customerId: "cus_owner" })
    mockOrderFindUnique.mockResolvedValue(order)

    const result = await svc.getById("order_01", { customerId: "cus_owner" })

    expect(result).toEqual(order)
  })

  // 3. Inv 2 — "no owner" ≠ "any owner": a NULL-owner order is REFUSED, not leaked.
  it("returns null for a customer-scoped read of an order with NULL owner attribution (Inv 2)", async () => {
    mockOrderFindUnique.mockResolvedValue(makeOrder({ customerId: null }))

    const result = await svc.getById("order_01", { customerId: "cus_owner" })

    expect(result).toBeNull()
  })

  // 4. Internal/staff/system unscoped path is preserved — no regression.
  it("returns the projection for an unscoped read (no customerId) regardless of owner", async () => {
    const ownedByOther = makeOrder({ customerId: "cus_someone_else" })
    mockOrderFindUnique.mockResolvedValue(ownedByOther)

    // No customerId → internal/staff/system read (admin, projection builders,
    // subscribers, jobs). Owner is not enforced.
    const result = await svc.getById("order_01")

    expect(result).toEqual(ownedByOther)
  })

  it("returns the projection for an unscoped read even of a NULL-owner order", async () => {
    const unattributed = makeOrder({ customerId: null })
    mockOrderFindUnique.mockResolvedValue(unattributed)

    const result = await svc.getById("order_01")

    expect(result).toEqual(unattributed)
  })

  // Not-found is null under both paths.
  it("returns null when the order does not exist (scoped)", async () => {
    mockOrderFindUnique.mockResolvedValue(null)

    const result = await svc.getById("order_missing", { customerId: "cus_owner" })
    expect(result).toBeNull()
  })

  it("returns null when the order does not exist (unscoped)", async () => {
    mockOrderFindUnique.mockResolvedValue(null)

    const result = await svc.getById("order_missing")
    expect(result).toBeNull()
  })

  // The query shape is unchanged (findUnique by id); scoping is a post-read gate.
  it("queries by id with the status-history include and honours historyLimit", async () => {
    mockOrderFindUnique.mockResolvedValue(makeOrder())

    await svc.getById("order_01", { customerId: "cus_owner", historyLimit: 5 })

    expect(mockOrderFindUnique).toHaveBeenCalledWith({
      where: { id: "order_01" },
      include: {
        statusHistory: {
          orderBy: { createdAt: "asc" },
          take: 5,
        },
      },
    })
  })

  // NON-VACUITY (sdd_selfcheck): tests 1 and 3 are RED if the owner filter is
  // removed. With the filter gone, getById would return `order` directly, so
  // `result` in test 1 would equal the cross-customer order (non-null) and in
  // test 3 would equal the NULL-owner order (non-null) — both assertions
  // (`toBeNull`) would fail. The filter is the sole thing that makes them pass.
  // Verified transiently by deleting the `if (opts?.customerId ...)` guard, then
  // restored.
})
