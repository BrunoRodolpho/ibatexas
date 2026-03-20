// Tests for SEC-002 ownership guards
// Mock-based; no database or network required.
//
// Scenarios per guard:
// - Own resource → passes (no throw)
// - Other customer's resource → throws "Acesso negado"
// - Non-existent resource → throws "não encontrado/encontrada"

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockMedusaAdmin = vi.hoisted(() => vi.fn())
const mockReservationFindUnique = vi.hoisted(() => vi.fn())

vi.mock("../../medusa/client.js", () => ({
  medusaAdmin: mockMedusaAdmin,
  medusaStore: vi.fn(),
}))

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    reservation: {
      findUnique: mockReservationFindUnique,
    },
  },
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { assertOrderOwnership, assertReservationOwnership } from "../ownership.js"

// ── assertOrderOwnership ───────────────────────────────────────────────────────

describe("assertOrderOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("passes when order belongs to the customer", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: { customer_id: "cus_01", metadata: {} },
    })

    await expect(
      assertOrderOwnership("order_01", "cus_01"),
    ).resolves.toBeUndefined()
  })

  it("passes when ownership is in metadata.customerId", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: { customer_id: undefined, metadata: { customerId: "cus_01" } },
    })

    await expect(
      assertOrderOwnership("order_01", "cus_01"),
    ).resolves.toBeUndefined()
  })

  it("passes when order has no customer (guest/legacy order)", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: { customer_id: undefined, metadata: {} },
    })

    await expect(
      assertOrderOwnership("order_01", "cus_01"),
    ).resolves.toBeUndefined()
  })

  it("throws 'Acesso negado' when order belongs to another customer", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: { customer_id: "cus_OTHER", metadata: {} },
    })

    await expect(
      assertOrderOwnership("order_01", "cus_01"),
    ).rejects.toThrow("Acesso negado")
  })

  it("throws 'Acesso negado' when metadata.customerId belongs to another customer", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: { customer_id: undefined, metadata: { customerId: "cus_OTHER" } },
    })

    await expect(
      assertOrderOwnership("order_01", "cus_01"),
    ).rejects.toThrow("Acesso negado")
  })

  it("throws 'não encontrado' when order does not exist", async () => {
    mockMedusaAdmin.mockResolvedValue({ order: undefined })

    await expect(
      assertOrderOwnership("order_nonexistent", "cus_01"),
    ).rejects.toThrow("não encontrado")
  })

  it("calls Medusa admin with correct path", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: { customer_id: "cus_01" },
    })

    await assertOrderOwnership("order_xyz", "cus_01")

    expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/orders/order_xyz")
  })
})

// ── assertReservationOwnership ─────────────────────────────────────────────────

describe("assertReservationOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("passes when reservation belongs to the customer", async () => {
    mockReservationFindUnique.mockResolvedValue({ customerId: "cus_01" })

    await expect(
      assertReservationOwnership("res_01", "cus_01"),
    ).resolves.toBeUndefined()
  })

  it("throws 'Acesso negado' when reservation belongs to another customer", async () => {
    mockReservationFindUnique.mockResolvedValue({ customerId: "cus_OTHER" })

    await expect(
      assertReservationOwnership("res_01", "cus_01"),
    ).rejects.toThrow("Acesso negado")
  })

  it("throws 'não encontrada' when reservation does not exist", async () => {
    mockReservationFindUnique.mockResolvedValue(null)

    await expect(
      assertReservationOwnership("res_nonexistent", "cus_01"),
    ).rejects.toThrow("não encontrada")
  })

  it("queries Prisma with correct id and select", async () => {
    mockReservationFindUnique.mockResolvedValue({ customerId: "cus_01" })

    await assertReservationOwnership("res_xyz", "cus_01")

    expect(mockReservationFindUnique).toHaveBeenCalledWith({
      where: { id: "res_xyz" },
      select: { customerId: true },
    })
  })
})
