// Tests for SEC-002 ownership guards
// Mock-based; no database or network required.
//
// Scenarios per guard:
// - Own resource → passes (no throw)
// - Other customer's resource → throws "Acesso negado"
// - Non-existent resource → throws "não encontrado/encontrada"

import { describe, it, expect, beforeEach, vi } from "vitest"
import { assertOrderOwnership, assertReservationOwnership } from "../ownership.js"

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

  // R0b — STRICT BY DEFAULT (Inv 2: "no owner" ≠ "any owner" → REFUSED).
  // NON-VACUOUS: the OLD lenient default returned undefined here; the inverted
  // fail-closed default must THROW. Revert the default to lenient → this RED.
  it("throws 'Acesso negado' when order has NO owner attribution and NO opts (fail-closed, Inv 2)", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: { customer_id: undefined, metadata: {} },
    })

    await expect(
      assertOrderOwnership("order_01", "cus_01"),
    ).rejects.toThrow("Acesso negado")
  })

  it("throws when both customer_id and metadata.customerId are absent (no owner)", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: { customer_id: undefined, metadata: { someOtherKey: "x" } },
    })

    await expect(
      assertOrderOwnership("order_01", "cus_01"),
    ).rejects.toThrow("Acesso negado")
  })

  // R0b — the `allowUnowned: true` escape hatch (genuine staff/legacy path):
  // an unowned order passes ONLY when the hatch is explicitly opened.
  it("passes for an unowned order ONLY when allowUnowned:true (escape hatch)", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: { customer_id: undefined, metadata: {} },
    })

    await expect(
      assertOrderOwnership("order_01", "cus_01", { allowUnowned: true }),
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
