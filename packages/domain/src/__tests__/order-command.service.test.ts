// Tests for OrderCommandService
// Mock-based; no DB required.
//
// Scenarios:
// - create: happy path — projection + history created, returns id + version 1
// - create: duplicate key handling (Prisma unique constraint)
// - transitionStatus: valid transition — version bumped, history recorded
// - transitionStatus: invalid transition — throws InvalidTransitionError
// - transitionStatus: version mismatch — throws ConcurrencyError
// - transitionStatus: missing projection — throws ProjectionNotFoundError
// - reconcileStatus: stale event — returns null
// - reconcileStatus: missing version — throws MissingEventVersionError
// - reconcileStatus: already at target status — returns null
// - reconcileStatus: valid reconciliation — updates projection
// - reconcileStatus: invalid transition — returns null (reordered events)
// - reconcileStatus: projection not found — returns null

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockProjectionCreate = vi.hoisted(() => vi.fn())
const mockProjectionFindUnique = vi.hoisted(() => vi.fn())
const mockProjectionUpdate = vi.hoisted(() => vi.fn())
const mockHistoryCreate = vi.hoisted(() => vi.fn())

// The $transaction mock calls the callback with a tx client that
// uses the same mock functions — same as real Prisma interactive transactions.
const txClient = {
  orderProjection: {
    create: mockProjectionCreate,
    findUnique: mockProjectionFindUnique,
    update: mockProjectionUpdate,
  },
  orderStatusHistory: { create: mockHistoryCreate },
}

vi.mock("../client.js", () => ({
  prisma: {
    $transaction: vi.fn((fn: (tx: typeof txClient) => Promise<unknown>) => fn(txClient)),
    orderProjection: {
      create: mockProjectionCreate,
      findUnique: mockProjectionFindUnique,
      update: mockProjectionUpdate,
    },
    orderStatusHistory: { create: mockHistoryCreate },
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import {
  createOrderCommandService,
  ConcurrencyError,
  ProjectionNotFoundError,
  InvalidTransitionError,
  MissingEventVersionError,
} from "../services/order-command.service.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeProjection(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_01",
    displayId: 1001,
    customerId: "cust_01",
    fulfillmentStatus: "pending",
    version: 1,
    ...overrides,
  }
}

function makeCreateInput() {
  return {
    id: "order_01",
    displayId: 1001,
    customerId: "cust_01",
    customerEmail: "test@example.com",
    customerName: "Test User",
    customerPhone: "+5511999999999",
    fulfillmentStatus: "pending",
    paymentStatus: "captured",
    totalInCentavos: 8900,
    subtotalInCentavos: 7900,
    shippingInCentavos: 1000,
    itemCount: 2,
    itemsJson: [{ productId: "prod_01", variantId: "var_01", title: "Costela", quantity: 1, priceInCentavos: 7900 }],
    itemsSchemaVersion: 1,
    shippingAddressJson: null,
    deliveryType: "delivery",
    paymentMethod: "pix",
    tipInCentavos: 0,
    medusaCreatedAt: new Date(),
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OrderCommandService", () => {
  let svc: ReturnType<typeof createOrderCommandService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createOrderCommandService()
  })

  // ── create ──────────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates projection and initial history, returns id + version 1", async () => {
      const input = makeCreateInput()
      mockProjectionCreate.mockResolvedValue({ id: input.id, version: 1 })
      mockHistoryCreate.mockResolvedValue({})

      const result = await svc.create(input)

      expect(result).toEqual({ id: "order_01", version: 1 })
      expect(mockProjectionCreate).toHaveBeenCalledOnce()
      expect(mockHistoryCreate).toHaveBeenCalledOnce()

      // History should record initial status as both from and to
      const historyCall = mockHistoryCreate.mock.calls[0][0]
      expect(historyCall.data.fromStatus).toBe("pending")
      expect(historyCall.data.toStatus).toBe("pending")
      expect(historyCall.data.actor).toBe("system")
      expect(historyCall.data.version).toBe(1)
    })

    it("propagates Prisma unique constraint error on duplicate", async () => {
      mockProjectionCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      )

      await expect(svc.create(makeCreateInput())).rejects.toThrow("Unique constraint failed")
    })
  })

  // ── transitionStatus ────────────────────────────────────────────────────

  describe("transitionStatus", () => {
    it("valid transition — bumps version and records history", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection())
      mockProjectionUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const result = await svc.transitionStatus("order_01", {
        newStatus: "confirmed",
        actor: "admin",
        actorId: "staff_01",
      })

      expect(result).toEqual({ version: 2, previousStatus: "pending", newStatus: "confirmed" })
      expect(mockProjectionUpdate).toHaveBeenCalledOnce()
      expect(mockHistoryCreate).toHaveBeenCalledOnce()
    })

    it("throws InvalidTransitionError on invalid transition", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection())

      await expect(
        svc.transitionStatus("order_01", { newStatus: "delivered", actor: "admin" }),
      ).rejects.toThrow(InvalidTransitionError)
    })

    it("throws ConcurrencyError on version mismatch", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection({ version: 3 }))

      await expect(
        svc.transitionStatus("order_01", {
          newStatus: "confirmed",
          actor: "admin",
          expectedVersion: 2,
        }),
      ).rejects.toThrow(ConcurrencyError)
    })

    it("throws ProjectionNotFoundError when projection missing", async () => {
      mockProjectionFindUnique.mockResolvedValue(null)

      await expect(
        svc.transitionStatus("order_01", { newStatus: "confirmed", actor: "admin" }),
      ).rejects.toThrow(ProjectionNotFoundError)
    })

    it("skips version check when expectedVersion is undefined", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection({ version: 5 }))
      mockProjectionUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const result = await svc.transitionStatus("order_01", {
        newStatus: "confirmed",
        actor: "admin",
        // no expectedVersion
      })

      expect(result.version).toBe(6)
    })
  })

  // ── reconcileStatus ─────────────────────────────────────────────────────

  describe("reconcileStatus", () => {
    it("throws MissingEventVersionError when eventVersion is null", async () => {
      await expect(
        svc.reconcileStatus("order_01", { newStatus: "confirmed", eventVersion: null }),
      ).rejects.toThrow(MissingEventVersionError)
    })

    it("throws MissingEventVersionError when eventVersion is undefined", async () => {
      await expect(
        svc.reconcileStatus("order_01", { newStatus: "confirmed", eventVersion: undefined }),
      ).rejects.toThrow(MissingEventVersionError)
    })

    it("returns null when projection not found", async () => {
      mockProjectionFindUnique.mockResolvedValue(null)

      const result = await svc.reconcileStatus("order_01", {
        newStatus: "confirmed",
        eventVersion: 2,
      })

      expect(result).toBeNull()
    })

    it("returns null for stale event (eventVersion <= projection.version)", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection({ version: 3 }))

      const result = await svc.reconcileStatus("order_01", {
        newStatus: "confirmed",
        eventVersion: 2,
      })

      expect(result).toBeNull()
      expect(mockProjectionUpdate).not.toHaveBeenCalled()
    })

    it("returns null when already at target status", async () => {
      mockProjectionFindUnique.mockResolvedValue(
        makeProjection({ fulfillmentStatus: "confirmed", version: 1 }),
      )

      const result = await svc.reconcileStatus("order_01", {
        newStatus: "confirmed",
        eventVersion: 2,
      })

      expect(result).toBeNull()
    })

    it("returns null on invalid transition (reordered events)", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection({ fulfillmentStatus: "pending" }))

      // pending → delivered is invalid (must go through confirmed, preparing, ready first)
      const result = await svc.reconcileStatus("order_01", {
        newStatus: "delivered",
        eventVersion: 2,
      })

      expect(result).toBeNull()
    })

    it("valid reconciliation — updates projection and records history", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection({ fulfillmentStatus: "pending", version: 1 }))
      mockProjectionUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const result = await svc.reconcileStatus("order_01", {
        newStatus: "confirmed",
        eventVersion: 2,
        actor: "system",
      })

      expect(result).toEqual({ version: 2 })
      expect(mockProjectionUpdate).toHaveBeenCalledOnce()
      expect(mockHistoryCreate).toHaveBeenCalledOnce()
    })
  })
})
