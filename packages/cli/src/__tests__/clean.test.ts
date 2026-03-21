// Tests for lib/clean.ts — FK-safe domain table cleanup.
// Mocks Prisma instance; never touches real DB.
import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mock Prisma ──────────────────────────────────────────────────────────────

function makeMockPrisma() {
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 })
  return {
    reservationTable: { deleteMany },
    waitlist: { deleteMany },
    reservation: { deleteMany },
    review: { deleteMany },
    customerOrderItem: { deleteMany },
    address: { deleteMany },
    customerPreferences: { deleteMany },
    customer: { deleteMany },
    timeSlot: { deleteMany },
    table: { deleteMany },
    deliveryZone: { deleteMany },
    _deleteManyMock: deleteMany,
  }
}

// ── Import source ────────────────────────────────────────────────────────────

import { cleanDomainTables } from "../lib/clean.js"

// ── Tests ────────────────────────────────────────────────────────────────────

describe("cleanDomainTables", () => {
  let mockPrisma: ReturnType<typeof makeMockPrisma>

  beforeEach(() => {
    mockPrisma = makeMockPrisma()
    vi.clearAllMocks()
  })

  it("deletes from all domain tables", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cleanDomainTables(mockPrisma as any)

    expect(mockPrisma.reservationTable.deleteMany).toHaveBeenCalled()
    expect(mockPrisma.waitlist.deleteMany).toHaveBeenCalled()
    expect(mockPrisma.reservation.deleteMany).toHaveBeenCalled()
    expect(mockPrisma.review.deleteMany).toHaveBeenCalled()
    expect(mockPrisma.customerOrderItem.deleteMany).toHaveBeenCalled()
    expect(mockPrisma.address.deleteMany).toHaveBeenCalled()
    expect(mockPrisma.customerPreferences.deleteMany).toHaveBeenCalled()
    expect(mockPrisma.customer.deleteMany).toHaveBeenCalled()
    expect(mockPrisma.timeSlot.deleteMany).toHaveBeenCalled()
    expect(mockPrisma.table.deleteMany).toHaveBeenCalled()
    expect(mockPrisma.deliveryZone.deleteMany).toHaveBeenCalled()
  })

  it("deletes children before parents (FK-safe order)", async () => {
    const callOrder: string[] = []

    const trackOrder = (tableName: string) =>
      vi.fn().mockImplementation(async () => {
        callOrder.push(tableName)
        return { count: 0 }
      })

    const orderedPrisma = {
      reservationTable: { deleteMany: trackOrder("reservationTable") },
      waitlist: { deleteMany: trackOrder("waitlist") },
      reservation: { deleteMany: trackOrder("reservation") },
      review: { deleteMany: trackOrder("review") },
      customerOrderItem: { deleteMany: trackOrder("customerOrderItem") },
      address: { deleteMany: trackOrder("address") },
      customerPreferences: { deleteMany: trackOrder("customerPreferences") },
      customer: { deleteMany: trackOrder("customer") },
      timeSlot: { deleteMany: trackOrder("timeSlot") },
      table: { deleteMany: trackOrder("table") },
      deliveryZone: { deleteMany: trackOrder("deliveryZone") },
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cleanDomainTables(orderedPrisma as any)

    // reservationTable depends on reservation & table, so must come first
    expect(callOrder.indexOf("reservationTable")).toBeLessThan(
      callOrder.indexOf("reservation"),
    )
    expect(callOrder.indexOf("reservationTable")).toBeLessThan(
      callOrder.indexOf("table"),
    )

    // customerOrderItem, address, customerPreferences depend on customer
    expect(callOrder.indexOf("customerOrderItem")).toBeLessThan(
      callOrder.indexOf("customer"),
    )
    expect(callOrder.indexOf("address")).toBeLessThan(
      callOrder.indexOf("customer"),
    )
    expect(callOrder.indexOf("customerPreferences")).toBeLessThan(
      callOrder.indexOf("customer"),
    )

    // review should come before customer
    expect(callOrder.indexOf("review")).toBeLessThan(
      callOrder.indexOf("customer"),
    )

    // timeSlot should come before table
    expect(callOrder.indexOf("timeSlot")).toBeLessThan(
      callOrder.indexOf("table"),
    )
  })

  it("propagates errors from deleteMany", async () => {
    mockPrisma.reservationTable.deleteMany.mockRejectedValueOnce(
      new Error("FK violation"),
    )

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cleanDomainTables(mockPrisma as any),
    ).rejects.toThrow("FK violation")
  })
})
