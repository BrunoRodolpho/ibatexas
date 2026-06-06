// Tests for OrderCommandService — envelope-typed surface only.
//
// R1-DELETE (W1 correctness remediation): the bare-arg @deprecated
// methods (`create`, `transitionStatus`, `reconcileStatus`) were removed
// from the interface. Coverage shifted to the envelope-typed methods
// which internally invoke the same executors.
//
// Scenarios:
// - createFromEnvelope: happy path — projection + history created
// - createFromEnvelope: duplicate key handling (Prisma unique constraint)
// - transitionStatusFromEnvelope: valid transition — version bumped, history recorded
// - transitionStatusFromEnvelope: invalid transition — throws InvalidTransitionError
// - transitionStatusFromEnvelope: version mismatch — throws ConcurrencyError
// - transitionStatusFromEnvelope: missing projection — throws ProjectionNotFoundError
// - reconcileStatusFromEnvelope: stale event — returns null result
// - reconcileStatusFromEnvelope: missing version — throws MissingEventVersionError
// - reconcileStatusFromEnvelope: already at target status — returns null
// - reconcileStatusFromEnvelope: valid reconciliation — updates projection
// - reconcileStatusFromEnvelope: invalid transition — returns null (reordered events)
// - reconcileStatusFromEnvelope: projection not found — returns null

import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildEnvelope } from "@adjudicate/core"

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

function buildCreateEnvelope(input: ReturnType<typeof makeCreateInput>) {
  return buildEnvelope<
    "order.projection.create",
    {
      orderId: string;
      displayId: number;
      customerId: string | null;
      fulfillmentStatus: string;
      paymentStatus: string | null;
      totalInCentavos: number;
    }
  >({
    kind: "order.projection.create",
    payload: {
      orderId: input.id,
      displayId: input.displayId,
      customerId: input.customerId,
      fulfillmentStatus: input.fulfillmentStatus,
      paymentStatus: input.paymentStatus,
      totalInCentavos: input.totalInCentavos,
    },
    nonce: "n-test",
    actor: { principal: "system", sessionId: `lazy-create:${input.id}` },
    taint: "SYSTEM",
  })
}

function buildTransitionEnvelope(orderId: string, payload: {
  newStatus: string;
  actor: "admin" | "system" | "customer";
  actorId?: string;
  reason?: string;
  expectedVersion?: number;
}) {
  return buildEnvelope<
    "order.status.transition",
    {
      orderId: string;
      newStatus: string;
      actor: "admin" | "system" | "customer";
      actorId?: string;
      reason?: string;
      expectedVersion?: number;
    }
  >({
    kind: "order.status.transition",
    payload: {
      orderId,
      newStatus: payload.newStatus,
      actor: payload.actor,
      actorId: payload.actorId,
      reason: payload.reason,
      expectedVersion: payload.expectedVersion,
    },
    nonce: "n-test",
    actor: { principal: payload.actor === "customer" ? "user" : "system", sessionId: payload.actorId ?? "test" },
    taint: payload.actor === "admin" ? "TRUSTED" : "UNTRUSTED",
  })
}

function buildReconcileEnvelope(orderId: string, payload: {
  newStatus: string;
  eventVersion: number | null | undefined;
  actor?: "admin" | "system" | "customer";
}) {
  // Cast through any so we can build envelopes with null/undefined
  // eventVersion (the executor throws MissingEventVersionError on these).
  return buildEnvelope({
    kind: "order.status.reconcile",
    payload: {
      orderId,
      newStatus: payload.newStatus,
      eventVersion: payload.eventVersion,
      actor: payload.actor ?? "system",
    },
    nonce: "n-test",
    actor: { principal: "system", sessionId: "reconcile-test" },
    taint: "SYSTEM",
  } as unknown as Parameters<typeof buildEnvelope>[0]) as Parameters<
    ReturnType<typeof createOrderCommandService>["reconcileStatusFromEnvelope"]
  >[0]
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OrderCommandService — R1-DELETE envelope-typed surface", () => {
  let svc: ReturnType<typeof createOrderCommandService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createOrderCommandService()
  })

  // ── createFromEnvelope ──────────────────────────────────────────────────

  describe("createFromEnvelope", () => {
    it("creates projection and initial history, returns id + version 1 wrapped in AdjudicatedResult", async () => {
      const input = makeCreateInput()
      mockProjectionCreate.mockResolvedValue({ id: input.id, version: 1 })
      mockHistoryCreate.mockResolvedValue({})

      const envelope = buildCreateEnvelope(input)
      const out = await svc.createFromEnvelope(envelope, input)

      // Adjudicator may return EXECUTE or REWRITE; either way the executor runs.
      expect(["EXECUTE", "REWRITE"]).toContain(out.decision.kind)
      expect(out.result).toEqual({ id: "order_01", version: 1 })
      expect(mockProjectionCreate).toHaveBeenCalledOnce()
      expect(mockHistoryCreate).toHaveBeenCalledOnce()
    })

    it("propagates Prisma unique constraint error on duplicate", async () => {
      mockProjectionCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      )

      const input = makeCreateInput()
      const envelope = buildCreateEnvelope(input)
      await expect(svc.createFromEnvelope(envelope, input)).rejects.toThrow(
        "Unique constraint failed",
      )
    })
  })

  // ── transitionStatusFromEnvelope ────────────────────────────────────────

  describe("transitionStatusFromEnvelope", () => {
    it("valid transition — bumps version and records history", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection())
      mockProjectionUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = buildTransitionEnvelope("order_01", {
        newStatus: "confirmed",
        actor: "admin",
        actorId: "staff_01",
      })
      const out = await svc.transitionStatusFromEnvelope(envelope)

      expect(["EXECUTE", "REWRITE"]).toContain(out.decision.kind)
      expect(out.result).toEqual({ version: 2, previousStatus: "pending", newStatus: "confirmed" })
      expect(mockProjectionUpdate).toHaveBeenCalledOnce()
      expect(mockHistoryCreate).toHaveBeenCalledOnce()
    })

    it("throws InvalidTransitionError on invalid transition", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection())

      const envelope = buildTransitionEnvelope("order_01", { newStatus: "delivered", actor: "admin" })
      await expect(svc.transitionStatusFromEnvelope(envelope)).rejects.toThrow(InvalidTransitionError)
    })

    it("throws ConcurrencyError on version mismatch", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection({ version: 3 }))

      const envelope = buildTransitionEnvelope("order_01", {
        newStatus: "confirmed",
        actor: "admin",
        expectedVersion: 2,
      })
      await expect(svc.transitionStatusFromEnvelope(envelope)).rejects.toThrow(ConcurrencyError)
    })

    it("throws ProjectionNotFoundError when projection missing", async () => {
      mockProjectionFindUnique.mockResolvedValue(null)

      const envelope = buildTransitionEnvelope("order_01", { newStatus: "confirmed", actor: "admin" })
      await expect(svc.transitionStatusFromEnvelope(envelope)).rejects.toThrow(ProjectionNotFoundError)
    })

    it("skips version check when expectedVersion is undefined", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection({ version: 5 }))
      mockProjectionUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = buildTransitionEnvelope("order_01", {
        newStatus: "confirmed",
        actor: "admin",
        // no expectedVersion
      })
      const out = await svc.transitionStatusFromEnvelope(envelope)

      expect(out.result?.version).toBe(6)
    })
  })

  // ── reconcileStatusFromEnvelope ─────────────────────────────────────────

  describe("reconcileStatusFromEnvelope", () => {
    it("throws MissingEventVersionError when eventVersion is null", async () => {
      const envelope = buildReconcileEnvelope("order_01", { newStatus: "confirmed", eventVersion: null })
      await expect(svc.reconcileStatusFromEnvelope(envelope)).rejects.toThrow(MissingEventVersionError)
    })

    it("throws MissingEventVersionError when eventVersion is undefined", async () => {
      const envelope = buildReconcileEnvelope("order_01", { newStatus: "confirmed", eventVersion: undefined })
      await expect(svc.reconcileStatusFromEnvelope(envelope)).rejects.toThrow(MissingEventVersionError)
    })

    it("returns null when projection not found", async () => {
      mockProjectionFindUnique.mockResolvedValue(null)

      const envelope = buildReconcileEnvelope("order_01", {
        newStatus: "confirmed",
        eventVersion: 2,
      })
      const out = await svc.reconcileStatusFromEnvelope(envelope)

      expect(out.result).toBeNull()
    })

    it("returns null for stale event (eventVersion <= projection.version)", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection({ version: 3 }))

      const envelope = buildReconcileEnvelope("order_01", {
        newStatus: "confirmed",
        eventVersion: 2,
      })
      const out = await svc.reconcileStatusFromEnvelope(envelope)

      expect(out.result).toBeNull()
      expect(mockProjectionUpdate).not.toHaveBeenCalled()
    })

    it("returns null when already at target status", async () => {
      mockProjectionFindUnique.mockResolvedValue(
        makeProjection({ fulfillmentStatus: "confirmed", version: 1 }),
      )

      const envelope = buildReconcileEnvelope("order_01", {
        newStatus: "confirmed",
        eventVersion: 2,
      })
      const out = await svc.reconcileStatusFromEnvelope(envelope)

      expect(out.result).toBeNull()
    })

    it("returns null on invalid transition (reordered events)", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection({ fulfillmentStatus: "pending" }))

      // pending → delivered is invalid (must go through confirmed, preparing, ready first)
      const envelope = buildReconcileEnvelope("order_01", {
        newStatus: "delivered",
        eventVersion: 2,
      })
      const out = await svc.reconcileStatusFromEnvelope(envelope)

      expect(out.result).toBeNull()
    })

    it("valid reconciliation — updates projection and records history", async () => {
      mockProjectionFindUnique.mockResolvedValue(makeProjection({ fulfillmentStatus: "pending", version: 1 }))
      mockProjectionUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = buildReconcileEnvelope("order_01", {
        newStatus: "confirmed",
        eventVersion: 2,
        actor: "system",
      })
      const out = await svc.reconcileStatusFromEnvelope(envelope)

      expect(out.result).toEqual({ version: 2 })
      expect(mockProjectionUpdate).toHaveBeenCalledOnce()
      expect(mockHistoryCreate).toHaveBeenCalledOnce()
    })
  })
})
