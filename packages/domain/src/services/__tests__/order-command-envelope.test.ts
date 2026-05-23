// OrderCommandService — envelope-typed entry-point tests.
//
// Task 15 (M3): verifies the new `*FromEnvelope` surface added alongside
// the legacy bare-arg methods (Decision D8 in decisions-log.md).
//
// Coverage:
//   - Each new entry point accepts only IntentEnvelope inputs (TypeScript
//     strict catches non-envelope calls at compile time).
//   - EXECUTE branch runs the underlying Prisma path and returns a typed
//     result.
//   - REFUSE branch (via taint mismatch) does NOT run the Prisma path.
//   - Audit sink emits once per call (best-effort fire-and-forget).
//   - Version counter is bumped on projection-mutating ops (transition,
//     switch type, change address).
//   - 3 rogue-writer consolidation: addNote/switchType/changeAddress all
//     route through the service rather than bare prisma.
//   - Idempotency keys preserved when an envelope is replayed (nonce is
//     the load-bearing key — same nonce = same intentHash).

import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildEnvelope, type AuditSink } from "@adjudicate/core"
import { randomUUID } from "node:crypto"

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockProjectionCreate = vi.hoisted(() => vi.fn())
const mockProjectionFindUnique = vi.hoisted(() => vi.fn())
const mockProjectionUpdate = vi.hoisted(() => vi.fn())
const mockHistoryCreate = vi.hoisted(() => vi.fn())
const mockNoteCreate = vi.hoisted(() => vi.fn())

const txClient = {
  orderProjection: {
    create: mockProjectionCreate,
    findUnique: mockProjectionFindUnique,
    update: mockProjectionUpdate,
  },
  orderStatusHistory: { create: mockHistoryCreate },
  orderNote: { create: mockNoteCreate },
}

vi.mock("../../client.js", () => ({
  prisma: {
    $transaction: vi.fn((fn: (tx: typeof txClient) => Promise<unknown>) =>
      fn(txClient),
    ),
    orderProjection: {
      create: mockProjectionCreate,
      findUnique: mockProjectionFindUnique,
      update: mockProjectionUpdate,
    },
    orderStatusHistory: { create: mockHistoryCreate },
    orderNote: { create: mockNoteCreate },
  },
}))

// ── Import after mocks ────────────────────────────────────────────────────

import {
  createOrderCommandService,
} from "../order-command.service.js"
import type {
  OrderProjectionCreatePayload,
  OrderStatusTransitionPayload,
  OrderStatusReconcilePayload,
  OrderTypeSwitchPayload,
  OrderAddressChangePayload,
} from "../__shared__/order-projection-policy.js"
import type { OrderNoteAddPayload, OrderState } from "@ibatexas/pack-orders"

// ── Helpers ───────────────────────────────────────────────────────────────

function makeProjectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_01",
    displayId: 1001,
    customerId: "cust_01",
    fulfillmentStatus: "pending",
    paymentStatus: "captured",
    deliveryType: "pickup",
    version: 1,
    ...overrides,
  }
}

function makeCreatePayload(): OrderProjectionCreatePayload {
  return {
    orderId: "order_01",
    displayId: 1001,
    customerId: "cust_01",
    fulfillmentStatus: "pending",
    paymentStatus: "captured",
    totalInCentavos: 8900,
  }
}

function makeFullCreateInput() {
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
    itemsJson: [
      {
        productId: "prod_01",
        variantId: "var_01",
        title: "Costela",
        quantity: 1,
        priceInCentavos: 7900,
      },
    ],
    itemsSchemaVersion: 1,
    shippingAddressJson: null,
    deliveryType: "delivery",
    paymentMethod: "pix",
    tipInCentavos: 0,
    medusaCreatedAt: new Date(),
  }
}

// SYSTEM-only kinds need SYSTEM taint.
function systemActor() {
  return {
    principal: "system" as const,
    sessionId: "system:test-suite",
  }
}

// User-driven kinds tolerate UNTRUSTED.
function userActor() {
  return {
    principal: "user" as const,
    sessionId: "user:test-suite",
  }
}

function llmActor() {
  return {
    principal: "llm" as const,
    sessionId: "llm:test-suite",
  }
}

function makeAuditSink(): AuditSink & { emit: ReturnType<typeof vi.fn> } {
  return {
    emit: vi.fn().mockResolvedValue(undefined),
  } as never
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("OrderCommandService — envelope-typed entry points", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── createFromEnvelope ────────────────────────────────────────────────

  describe("createFromEnvelope", () => {
    it("EXECUTE: creates projection + history + emits audit", async () => {
      const sink = makeAuditSink()
      const svc = createOrderCommandService(undefined, { auditSink: sink })
      const payload = makeCreatePayload()
      const envelope = buildEnvelope({
        kind: "order.projection.create" as const,
        payload,
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "SYSTEM",
      })
      mockProjectionCreate.mockResolvedValue({ id: payload.orderId, version: 1 })
      mockHistoryCreate.mockResolvedValue({})

      const outcome = await svc.createFromEnvelope(envelope, makeFullCreateInput())

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toEqual({ id: "order_01", version: 1 })
      expect(mockProjectionCreate).toHaveBeenCalledOnce()
      expect(mockHistoryCreate).toHaveBeenCalledOnce()
      // Audit emit is fire-and-forget — flush microtasks before assert.
      await new Promise((r) => setImmediate(r))
      expect(sink.emit).toHaveBeenCalledOnce()
    })

    it("REFUSE: UNTRUSTED taint on system-only kind blocks the create", async () => {
      const sink = makeAuditSink()
      const svc = createOrderCommandService(undefined, { auditSink: sink })
      const envelope = buildEnvelope({
        kind: "order.projection.create" as const,
        payload: makeCreatePayload(),
        nonce: randomUUID(),
        actor: llmActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.createFromEnvelope(envelope, makeFullCreateInput())

      expect(outcome.decision.kind).toBe("REFUSE")
      expect(outcome.result).toBeUndefined()
      // Prisma path NOT called.
      expect(mockProjectionCreate).not.toHaveBeenCalled()
    })
  })

  // ── transitionStatusFromEnvelope ──────────────────────────────────────

  describe("transitionStatusFromEnvelope", () => {
    it("EXECUTE: bumps version on valid transition", async () => {
      const svc = createOrderCommandService()
      const projection = makeProjectionRow({ version: 1 })
      mockProjectionFindUnique.mockResolvedValue(projection)
      mockProjectionUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const payload: OrderStatusTransitionPayload = {
        orderId: "order_01",
        newStatus: "confirmed",
        actor: "admin",
        actorId: "staff_01",
      }
      const envelope = buildEnvelope({
        kind: "order.status.transition" as const,
        payload,
        nonce: randomUUID(),
        actor: { ...systemActor() },
        taint: "TRUSTED",
      })

      const outcome = await svc.transitionStatusFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toEqual({
        version: 2,
        previousStatus: "pending",
        newStatus: "confirmed",
      })
      // Version bumped (was 1, became 2) — load-bearing per CLAUDE invariant.
      expect(mockProjectionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "order_01" },
          data: expect.objectContaining({ version: 2 }),
        }),
      )
    })

    it("REFUSE: missing projection — kernel returns 'projection_not_found'", async () => {
      const svc = createOrderCommandService()
      // For state snapshot: row missing.
      mockProjectionFindUnique.mockResolvedValue(null)

      const missingPayload: OrderStatusTransitionPayload = {
        orderId: "missing_order",
        newStatus: "confirmed",
        actor: "admin",
      }
      const envelope = buildEnvelope({
        kind: "order.status.transition" as const,
        payload: missingPayload,
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "TRUSTED",
      })

      const outcome = await svc.transitionStatusFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
      // Refusal code is the policy's stable identifier.
      if (outcome.decision.kind === "REFUSE") {
        expect(outcome.decision.refusal.code).toBe("order.projection.not_found")
      }
      // No mutation occurred.
      expect(mockProjectionUpdate).not.toHaveBeenCalled()
    })
  })

  // ── reconcileStatusFromEnvelope ───────────────────────────────────────

  describe("reconcileStatusFromEnvelope", () => {
    it("EXECUTE: stale eventVersion → executor returns null (no version bump)", async () => {
      const svc = createOrderCommandService()
      mockProjectionFindUnique
        // First call: state snapshot (exists, version 5).
        .mockResolvedValueOnce(makeProjectionRow({ version: 5 }))
        // Second call: executor's own fetch.
        .mockResolvedValueOnce(makeProjectionRow({ version: 5 }))

      const payload: OrderStatusReconcilePayload = {
        orderId: "order_01",
        newStatus: "confirmed",
        eventVersion: 3, // stale (<= projection.version)
      }
      const envelope = buildEnvelope({
        kind: "order.status.reconcile" as const,
        payload,
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "SYSTEM",
      })

      const outcome = await svc.reconcileStatusFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      // Stale event — executor returns null (the legacy semantics preserved).
      expect(outcome.result).toBeNull()
      expect(mockProjectionUpdate).not.toHaveBeenCalled()
    })

    it("REFUSE: UNTRUSTED taint blocks the SYSTEM-only kind", async () => {
      const svc = createOrderCommandService()

      const envelope = buildEnvelope({
        kind: "order.status.reconcile" as const,
        payload: {
          orderId: "order_01",
          newStatus: "confirmed",
          eventVersion: 7,
        },
        nonce: randomUUID(),
        actor: llmActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.reconcileStatusFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
    })
  })

  // ── addNoteFromEnvelope (consolidation #1) ────────────────────────────

  describe("addNoteFromEnvelope — replaces packages/tools/src/cart/add-order-note.ts direct write", () => {
    it("EXECUTE: writes note via service (no direct prisma in tools)", async () => {
      const svc = createOrderCommandService()
      mockNoteCreate.mockResolvedValue({ id: "note_01" })

      const payload: OrderNoteAddPayload = {
        orderId: "order_01",
        body: "Adicionar molho extra",
      }
      const orderState: OrderState = {
        ctx: {
          channel: "whatsapp",
          customerId: "cust_01",
          cartId: null,
          orderId: "order_01",
        },
      }
      const envelope = buildEnvelope({
        kind: "order.note.add" as const,
        payload,
        nonce: randomUUID(),
        actor: llmActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.addNoteFromEnvelope(envelope, orderState, {
        author: "customer",
        authorId: "cust_01",
      })

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toEqual({ noteId: "note_01", orderId: "order_01" })
      expect(mockNoteCreate).toHaveBeenCalledOnce()
    })

    it("REFUSE: empty body — pack-orders refuses (load-bearing safety)", async () => {
      const svc = createOrderCommandService()

      const orderState: OrderState = {
        ctx: {
          channel: "whatsapp",
          customerId: "cust_01",
          cartId: null,
          orderId: "order_01",
        },
      }
      const envelope = buildEnvelope({
        kind: "order.note.add" as const,
        payload: { orderId: "order_01", body: "" },
        nonce: randomUUID(),
        actor: llmActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.addNoteFromEnvelope(envelope, orderState, {
        author: "customer",
        authorId: "cust_01",
      })

      expect(outcome.decision.kind).toBe("REFUSE")
      expect(mockNoteCreate).not.toHaveBeenCalled()
    })
  })

  // ── switchTypeFromEnvelope (consolidation #2) ─────────────────────────

  describe("switchTypeFromEnvelope — replaces packages/tools/src/cart/switch-order-type.ts direct write", () => {
    it("EXECUTE: bumps version (was missing in legacy direct write — investigation 03 P0 #2)", async () => {
      const svc = createOrderCommandService()
      const projection = makeProjectionRow({
        version: 3,
        deliveryType: "delivery",
        fulfillmentStatus: "pending",
      })
      mockProjectionFindUnique.mockResolvedValue(projection)
      mockProjectionUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const payload: OrderTypeSwitchPayload = {
        orderId: "order_01",
        newType: "pickup",
        customerId: "cust_01",
      }
      const envelope = buildEnvelope({
        kind: "order.type.switch" as const,
        payload,
        nonce: randomUUID(),
        actor: llmActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.switchTypeFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toEqual({
        orderId: "order_01",
        version: 4, // bumped from 3
        previousType: "delivery",
        newType: "pickup",
      })
      // Projection write carries the new version.
      expect(mockProjectionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: 4,
            deliveryType: "pickup",
            // Pickup removes delivery shipping fee.
            shippingInCentavos: 0,
          }),
        }),
      )
      // History row keyed to the new version.
      expect(mockHistoryCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: 4 }),
        }),
      )
    })

    it("REFUSE: no-op switch (same type) blocked by policy", async () => {
      const svc = createOrderCommandService()
      mockProjectionFindUnique.mockResolvedValue(
        makeProjectionRow({ deliveryType: "pickup" }),
      )

      const noOpPayload: OrderTypeSwitchPayload = {
        orderId: "order_01",
        newType: "pickup",
        customerId: "cust_01",
      }
      const envelope = buildEnvelope({
        kind: "order.type.switch" as const,
        payload: noOpPayload,
        nonce: randomUUID(),
        actor: llmActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.switchTypeFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
      expect(mockProjectionUpdate).not.toHaveBeenCalled()
    })

    it("REFUSE: ownership mismatch (different customer) blocked", async () => {
      const svc = createOrderCommandService()
      mockProjectionFindUnique.mockResolvedValue(
        makeProjectionRow({ customerId: "other_customer", deliveryType: "delivery" }),
      )

      const ownerMismatchPayload: OrderTypeSwitchPayload = {
        orderId: "order_01",
        newType: "pickup",
        customerId: "cust_01",
      }
      const envelope = buildEnvelope({
        kind: "order.type.switch" as const,
        payload: ownerMismatchPayload,
        nonce: randomUUID(),
        actor: llmActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.switchTypeFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
      if (outcome.decision.kind === "REFUSE") {
        expect(outcome.decision.refusal.code).toBe("order.projection.not_owner")
      }
    })
  })

  // ── changeAddressFromEnvelope (consolidation #3) ──────────────────────

  describe("changeAddressFromEnvelope — replaces packages/tools/src/cart/change-delivery-address.ts direct write", () => {
    it("EXECUTE: bumps version + writes history row", async () => {
      const svc = createOrderCommandService()
      mockProjectionFindUnique.mockResolvedValue(
        makeProjectionRow({ version: 7 }),
      )
      mockProjectionUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const payload: OrderAddressChangePayload = {
        orderId: "order_01",
        customerId: "cust_01",
        address: {
          address1: "Rua das Flores, 100",
          city: "Curitiba",
          state: "PR",
          postalCode: "80000-000",
        },
      }
      const envelope = buildEnvelope({
        kind: "order.address.change" as const,
        payload,
        nonce: randomUUID(),
        actor: llmActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.changeAddressFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toEqual({ orderId: "order_01", version: 8 })
      expect(mockProjectionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: 8 }),
        }),
      )
      expect(mockHistoryCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: 8,
            reason: "address_changed",
          }),
        }),
      )
    })
  })

  // ── Idempotency (nonce-based) ─────────────────────────────────────────

  describe("Idempotency: same nonce → same intentHash → ledger-dedup-ready", () => {
    it("two envelopes with same payload + nonce produce identical intentHash", () => {
      const payload = makeCreatePayload()
      const nonce = randomUUID()
      const env1 = buildEnvelope({
        kind: "order.projection.create" as const,
        payload,
        nonce,
        actor: systemActor(),
        taint: "SYSTEM",
      })
      const env2 = buildEnvelope({
        kind: "order.projection.create" as const,
        payload,
        nonce,
        actor: systemActor(),
        taint: "SYSTEM",
      })
      expect(env1.intentHash).toBe(env2.intentHash)
    })

    it("different nonce → different intentHash", () => {
      const payload = makeCreatePayload()
      const env1 = buildEnvelope({
        kind: "order.projection.create" as const,
        payload,
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "SYSTEM",
      })
      const env2 = buildEnvelope({
        kind: "order.projection.create" as const,
        payload,
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "SYSTEM",
      })
      expect(env1.intentHash).not.toBe(env2.intentHash)
    })
  })

  // ── Audit emission survives a failing sink ────────────────────────────

  describe("Audit emission resilience", () => {
    it("sink emit failure does not fail the mutation (best-effort)", async () => {
      const svc = createOrderCommandService(undefined, {
        auditSink: {
          emit: vi.fn().mockRejectedValue(new Error("sink down")),
        },
      })
      const projection = makeProjectionRow({ version: 1 })
      mockProjectionFindUnique.mockResolvedValue(projection)
      mockProjectionUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const auditFailurePayload: OrderStatusTransitionPayload = {
        orderId: "order_01",
        newStatus: "confirmed",
        actor: "admin",
      }
      const envelope = buildEnvelope({
        kind: "order.status.transition" as const,
        payload: auditFailurePayload,
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "TRUSTED",
      })

      // Should NOT throw — audit failure is logged + swallowed.
      const outcome = await svc.transitionStatusFromEnvelope(envelope)
      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toBeDefined()
    })
  })
})
