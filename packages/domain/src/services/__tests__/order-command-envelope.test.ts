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
import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionRefuse,
  refuse,
  type AuditSink,
} from "@adjudicate/core"
import { nameGuard, type Guard } from "@adjudicate/core/kernel"
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

// ── BKL-074 injected staff-role guard (locally built — domain tests must NOT
//    import apps/api) ─────────────────────────────────────────────────────────
//
// A faithful equivalent of apps/api's `createStaffRoleGuard`: engages ONLY on
// `admin:` sessionIds, REFUSEs `staff_role_violation` when the kind is off the
// matrix / the role is absent / unknown / not permitted, and is otherwise inert
// (null). Passed as the injected `authGuards` to prove the command-service
// backstop THROUGH the real kernel + the raw orders pack bundle.
const STAFF_ROLE_REFUSAL_CODE = "staff_role_violation"

/** CODE-TRUTH mirror of STAFF_KIND_ALLOWED_ROLES (staff-role-matrix.ts). */
const STAFF_KIND_ALLOWED_ROLES: Record<string, readonly string[]> = {
  "order.status.transition": ["OWNER", "MANAGER", "ATTENDANT"],
  "payment.status.transition": ["OWNER", "MANAGER", "ATTENDANT"],
  "payment.refund.issue": ["OWNER", "MANAGER"],
  "order.note.add": ["OWNER", "MANAGER", "ATTENDANT"],
  "reservation.checkin": ["OWNER", "MANAGER"],
  "reservation.complete": ["OWNER", "MANAGER"],
  "reservation.cancel": ["OWNER", "MANAGER"],
}

function invertMatrix(): Record<string, ReadonlySet<string>> {
  const acc: Record<string, Set<string>> = {
    OWNER: new Set(),
    MANAGER: new Set(),
    ATTENDANT: new Set(),
  }
  for (const [kind, roles] of Object.entries(STAFF_KIND_ALLOWED_ROLES)) {
    for (const role of roles) acc[role]!.add(kind)
  }
  return acc
}

function createTestStaffRoleGuard(): Guard<string, unknown, unknown> {
  const matrix = invertMatrix()
  const staffPlaneKinds = new Set<string>()
  for (const kinds of Object.values(matrix)) {
    for (const k of kinds) staffPlaneKinds.add(k)
  }
  const refuseStaffRole = (detail: string) =>
    refuse(
      "AUTH",
      STAFF_ROLE_REFUSAL_CODE,
      "Seu nível de acesso não permite executar esta ação.",
      detail,
    )
  const guard: Guard<string, unknown, unknown> = (envelope, _state) => {
    const { sessionId, role } = envelope.actor
    if (!sessionId.startsWith("admin:")) return null
    const kind = envelope.kind
    if (!staffPlaneKinds.has(kind)) {
      return decisionRefuse(refuseStaffRole(`kind "${kind}" off matrix`), [
        basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, { sessionId, kind }),
      ])
    }
    if (role === undefined) {
      return decisionRefuse(refuseStaffRole(`no role for "${kind}"`), [
        basis("auth", BASIS_CODES.auth.IDENTITY_MISSING, { sessionId, kind }),
      ])
    }
    const allowed = matrix[role]
    if (allowed === undefined) {
      return decisionRefuse(refuseStaffRole(`unknown role "${role}"`), [
        basis("auth", BASIS_CODES.auth.IDENTITY_MISSING, { sessionId, kind, role }),
      ])
    }
    if (allowed.has(kind)) return null
    return decisionRefuse(
      refuseStaffRole(`role "${role}" not permitted for "${kind}"`),
      [basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, { sessionId, kind, role })],
    )
  }
  return nameGuard("staffRole", guard)
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

  // ── writeAdjudicatedNote (BKL-083 extraction) ─────────────────────────

  describe("writeAdjudicatedNote — the post-adjudication write body (BKL-083 option b)", () => {
    it("persists the note WITHOUT adjudicating (caller already holds a positive Decision)", async () => {
      const svc = createOrderCommandService()
      mockNoteCreate.mockResolvedValue({ id: "note_99" })

      const result = await svc.writeAdjudicatedNote(
        { orderId: "order_01", body: "86 na costela" },
        { author: "staff", authorId: "staff_1" },
      )

      // Same result shape as the addNoteFromEnvelope EXECUTE branch.
      expect(result).toEqual({ noteId: "note_99", orderId: "order_01" })
      expect(mockNoteCreate).toHaveBeenCalledOnce()
      // Author mapping preserved: staff → admin (Prisma OrderActor enum).
      expect(mockNoteCreate.mock.calls[0]![0]).toEqual({
        data: {
          orderId: "order_01",
          author: "admin",
          authorId: "staff_1",
          content: "86 na costela",
        },
      })
    })

    it("maps llm → system and threads isInternal through", async () => {
      const svc = createOrderCommandService()
      mockNoteCreate.mockResolvedValue({ id: "note_100" })

      await svc.writeAdjudicatedNote(
        { orderId: "order_02", body: "nota interna", isInternal: true },
        { author: "llm" },
      )

      expect(mockNoteCreate.mock.calls[0]![0]).toEqual({
        data: {
          orderId: "order_02",
          author: "system",
          authorId: undefined,
          content: "nota interna",
          isInternal: true,
        },
      })
    })

    it("addNoteFromEnvelope delegates to the same write body on EXECUTE", async () => {
      const svc = createOrderCommandService()
      mockNoteCreate.mockResolvedValue({ id: "note_delegated" })

      const orderState: OrderState = {
        ctx: {
          channel: "whatsapp",
          customerId: "cust_01",
          cartId: null,
          orderId: "order_03",
        },
      }
      const envelope = buildEnvelope({
        kind: "order.note.add" as const,
        payload: { orderId: "order_03", body: "via envelope" },
        nonce: randomUUID(),
        actor: llmActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.addNoteFromEnvelope(envelope, orderState, {
        author: "customer",
        authorId: "cust_01",
      })

      expect(outcome.decision.kind).toBe("EXECUTE")
      // Delegated to writeAdjudicatedNote → same result shape + single write.
      expect(outcome.result).toEqual({
        noteId: "note_delegated",
        orderId: "order_03",
      })
      expect(mockNoteCreate).toHaveBeenCalledOnce()
      expect(mockNoteCreate.mock.calls[0]![0]).toEqual({
        data: {
          orderId: "order_03",
          author: "customer",
          authorId: "cust_01",
          content: "via envelope",
        },
      })
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

  // ── BKL-074 — kernel-level staff-role backstop on order.note.add ───────────
  //
  // Proves the injected `authGuards: [staffRoleGuard]` runs INSIDE the
  // command-service adjudication (against the RAW orders pack bundle that
  // carries NO adopter auth guards). ATTENDANT IS permitted for order.note.add
  // (so the note still EXECUTEs), an admin envelope with NO role is REFUSED, and
  // the guard is inert for non-`admin:` (customer/LLM) note traffic.
  describe("BKL-074 — injected staffRoleGuard backstop on order.note.add", () => {
    const guard = createTestStaffRoleGuard()

    const noteState: OrderState = {
      ctx: {
        channel: "web",
        customerId: "cust_01",
        cartId: null,
        orderId: "order_01",
      },
    }

    it("EXECUTE: admin ATTENDANT order.note.add passes the injected guard (ATTENDANT is permitted for notes)", async () => {
      const svc = createOrderCommandService(undefined, { authGuards: [guard] })
      mockNoteCreate.mockResolvedValue({ id: "note_att" })

      const envelope = buildEnvelope({
        kind: "order.note.add" as const,
        payload: { orderId: "order_01", body: "Mesa 5 chegou" },
        nonce: randomUUID(),
        actor: {
          principal: "user" as const,
          sessionId: "admin:att_1",
          role: "ATTENDANT",
        },
        taint: "TRUSTED",
      })

      const outcome = await svc.addNoteFromEnvelope(envelope, noteState, {
        author: "staff",
        authorId: "att_1",
      })

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toEqual({ noteId: "note_att", orderId: "order_01" })
      expect(mockNoteCreate).toHaveBeenCalledOnce()
    })

    it("REFUSE: admin order.note.add with NO actor.role is blocked at AUTH — executor NEVER runs", async () => {
      const svc = createOrderCommandService(undefined, { authGuards: [guard] })

      const envelope = buildEnvelope({
        kind: "order.note.add" as const,
        payload: { orderId: "order_01", body: "Sem cargo" },
        nonce: randomUUID(),
        // admin: session but NO role — fail-closed on the staff plane.
        actor: { principal: "user" as const, sessionId: "admin:norole_1" },
        taint: "TRUSTED",
      })

      const outcome = await svc.addNoteFromEnvelope(envelope, noteState, {
        author: "staff",
        authorId: "norole_1",
      })

      expect(outcome.decision.kind).toBe("REFUSE")
      if (outcome.decision.kind === "REFUSE") {
        expect(outcome.decision.refusal.code).toBe(STAFF_ROLE_REFUSAL_CODE)
        expect(outcome.decision.refusal.kind).toBe("AUTH")
      }
      // Load-bearing: the note was never written.
      expect(mockNoteCreate).not.toHaveBeenCalled()
    })

    it("EXECUTE (guard inert): a customer/LLM (non-admin) order.note.add still EXECUTEs with the guard injected — no regression", async () => {
      const svc = createOrderCommandService(undefined, { authGuards: [guard] })
      mockNoteCreate.mockResolvedValue({ id: "note_cust" })

      const envelope = buildEnvelope({
        kind: "order.note.add" as const,
        payload: { orderId: "order_01", body: "Molho extra" },
        nonce: randomUUID(),
        // Non-`admin:` session — the staff-role guard must stay inert.
        actor: { principal: "llm" as const, sessionId: "llm:test-suite" },
        taint: "UNTRUSTED",
      })

      const outcome = await svc.addNoteFromEnvelope(envelope, noteState, {
        author: "customer",
        authorId: "cust_01",
      })

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(mockNoteCreate).toHaveBeenCalledOnce()
    })
  })
})
