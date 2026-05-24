// Tests for kernel-executor's adjudicate-mutation gate.
//
// Verifies the branching behaviour of `adjudicateKernelMutation` (the helper
// exported via `__testOnly__adjudicateKernelMutation`) for every Decision
// kind the kernel can return:
//   - EXECUTE              → caller proceeds, runs the underlying mutation
//   - REWRITE              → caller proceeds with the rewritten payload
//   - REFUSE               → caller short-circuits, userFacing set
//   - DEFER                → caller short-circuits, envelope parked
//   - REQUEST_CONFIRMATION → caller short-circuits with pt-BR copy
//   - ESCALATE             → caller short-circuits with pt-BR copy
//
// The kernel is always authoritative — every envelope is adjudicated. We
// mock @adjudicate/core/kernel.adjudicate to control the Decision the gate
// observes, so we can assert the branching contract per decision kind
// without dragging in the full policy bundle.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Decision, IntentEnvelope } from "@adjudicate/core"

// ── Module-level mocks (vi.hoisted for vi.mock-factory access) ──────────────
// vi.mock factories run BEFORE module-level `const` initializers, so any
// shared mock state must be created via vi.hoisted so the factory can read
// it. See https://vitest.dev/api/vi.html#vi-mock — the "Cannot access X
// before initialization" trap is exactly this hoisting order.

const {
  adjudicateMock,
  redisSetMock,
  redisIncrMock,
  redisDecrMock,
  redisExpireMock,
  redisDelMock,
  auditEmitMock,
} = vi.hoisted(() => ({
  adjudicateMock: vi.fn(),
  redisSetMock: vi.fn(async () => "OK"),
  // parkDeferredIntent calls INCR → EXPIRE → SET. We default to count=1
  // so the quota check (default 16) is satisfied.
  redisIncrMock: vi.fn(async () => 1),
  redisDecrMock: vi.fn(async () => 0),
  redisExpireMock: vi.fn(async () => 1),
  // audit-2026-05-24 P0-1: the NX wrapper calls `del` to release its
  // placeholder when the framework returns quota_exceeded or mid-flight
  // throws. Stub it so those branches don't blow up.
  redisDelMock: vi.fn(async () => 1),
  auditEmitMock: vi.fn(async () => undefined),
}))

vi.mock("@adjudicate/core/kernel", async () => {
  const actual = (await vi.importActual(
    "@adjudicate/core/kernel",
  )) as Record<string, unknown>
  return {
    ...actual,
    adjudicate: adjudicateMock,
  }
})

// Redis stub for the DEFER park path. We assert against `set` calls.
// parkDeferredIntent uses INCR/EXPIRE/SET; the NX wrapper additionally uses
// SET (NX placeholder) and DEL (placeholder release on quota / mid-flight
// failure), so the stub covers all five methods.
vi.mock("@ibatexas/tools", async () => {
  const actual = (await vi.importActual("@ibatexas/tools")) as Record<
    string,
    unknown
  >
  return {
    ...actual,
    getRedisClient: vi.fn(async () => ({
      set: redisSetMock,
      incr: redisIncrMock,
      decr: redisDecrMock,
      expire: redisExpireMock,
      del: redisDelMock,
    })),
    rk: (k: string) => `ibatexas:${k}`,
  }
})

// Audit sink stub — we just want emit to not throw.
vi.mock("../intent-audit-wiring.js", () => ({
  getAuditSink: () => ({ emit: auditEmitMock }),
  _resetAuditSink: vi.fn(),
}))

// ── SUT + envelope factories ────────────────────────────────────────────────

import {
  __testOnly__adjudicateKernelMutation,
} from "../kernel-executor.js"
import {
  buildAddItemEnvelope,
  buildCheckoutEnvelope,
  buildCancelOrderEnvelope,
  buildRegeneratePixEnvelope,
  type KernelAddItemPayload,
  type KernelCheckoutPayload,
  type KernelCancelPayload,
  type KernelRegeneratePixPayload,
} from "../kernel-executor-envelopes.js"
import type { OrderContext } from "../machine/types.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(): OrderContext {
  return {
    channel: "whatsapp",
    customerId: "cust_01",
    customerName: "Cliente",
    isAuthenticated: true,
    isNewCustomer: false,
    cartId: "cart_01",
    items: [],
    totalInCentavos: 0,
    couponApplied: null,
    fulfillment: "pickup",
    deliveryCep: null,
    deliveryFeeInCentavos: null,
    deliveryEtaMinutes: null,
    paymentMethod: "pix",
    tipInCentavos: 0,
    customerEmail: null,
    customerTaxId: null,
    upsellRound: 0,
    hasMainDish: false,
    hasSide: false,
    hasDrink: false,
    isCombo: false,
    mealPeriod: "lunch",
    lastError: null,
    pendingProduct: null,
    alternatives: [],
    lastSearchResult: null,
    checkoutResult: null,
    orderId: null,
    orderCreatedAt: null,
    lastAction: null,
    loyaltyStamps: null,
    secondaryIntent: null,
    momentum: "high",
    lastObjectionSubtype: null,
    fallbackCount: 0,
    activeOrderId: null,
    activeOrderDisplayId: null,
    activeOrderStatus: null,
    paymentId: null,
    paymentStatus: null,
    pixExpiresAt: null,
  }
}

const SESSION_ID = "sess_test_adj"

function refuseDecision(userFacing: string, code = "test_refuse"): Decision {
  return {
    kind: "REFUSE",
    refusal: {
      kind: "BUSINESS_RULE",
      code,
      userFacing,
    },
    basis: [],
  }
}

function executeDecision(): Decision {
  return { kind: "EXECUTE", basis: [] }
}

function deferDecision(): Decision {
  return {
    kind: "DEFER",
    signal: "payment.confirmed",
    timeoutMs: 60_000,
    basis: [],
  }
}

function confirmDecision(): Decision {
  return {
    kind: "REQUEST_CONFIRMATION",
    prompt: "Confirma?",
    basis: [],
  }
}

function escalateDecision(): Decision {
  return {
    kind: "ESCALATE",
    to: "human",
    reason: "test_escalate",
    basis: [],
  }
}

function rewriteDecision<K extends string, P>(
  rewrittenPayload: P,
  originalEnvelope: IntentEnvelope<K, P>,
): Decision {
  // Build a "rewritten" envelope mirroring the original shape but with the
  // new payload. The gate's REWRITE branch reads `decision.rewritten.payload`.
  const rewritten: IntentEnvelope<K, P> = {
    ...originalEnvelope,
    payload: rewrittenPayload,
  }
  return {
    kind: "REWRITE",
    rewritten: rewritten as IntentEnvelope,
    reason: "test_rewrite",
    basis: [],
  }
}

// ── Test lifecycle ──────────────────────────────────────────────────────────

beforeEach(() => {
  adjudicateMock.mockReset()
  redisSetMock.mockReset()
  redisDelMock.mockReset()
  auditEmitMock.mockReset()
  // Redis stub returns success by default. Both the NX placeholder SET
  // and the framework's plain SET return "OK"; default to the happy
  // path so the wrapper's SETNX claim succeeds and delegation runs.
  redisSetMock.mockResolvedValue("OK")
  redisDelMock.mockResolvedValue(1)
  auditEmitMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── Kernel always-on (single decision path) ─────────────────────────────────

describe("adjudicateKernelMutation", () => {
  it("addItem EXECUTE → proceed:true (no rewritten payload)", async () => {
adjudicateMock.mockReturnValue(executeDecision())

    const payload: KernelAddItemPayload = {
      cartId: "c",
      variantId: "v",
      quantity: 1,
      allergens: [],
    }
    const envelope = buildAddItemEnvelope(payload, makeCtx(), SESSION_ID)
    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(true)
    expect(gate.decision.kind).toBe("EXECUTE")
    expect(gate.rewrittenPayload).toBeUndefined()
    expect(auditEmitMock).toHaveBeenCalledTimes(1)
  })

  it("addItem REFUSE → proceed:false + userFacing from refusal", async () => {
adjudicateMock.mockReturnValue(refuseDecision("Sem permissão."))

    const envelope = buildAddItemEnvelope(
      { cartId: "c", variantId: "v", quantity: 1, allergens: [] },
      makeCtx(),
      SESSION_ID,
    )
    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(false)
    expect(gate.userFacing).toBe("Sem permissão.")
  })

  it("addItem REWRITE → proceed:true + rewrittenPayload propagated", async () => {
const originalPayload: KernelAddItemPayload = {
      cartId: "c",
      variantId: "v",
      quantity: 99, // would-exceed-stock
      allergens: [],
    }
    const envelope = buildAddItemEnvelope(originalPayload, makeCtx(), SESSION_ID)
    const cappedPayload: KernelAddItemPayload = {
      ...originalPayload,
      quantity: 5, // stock cap
    }
    adjudicateMock.mockReturnValue(rewriteDecision(cappedPayload, envelope))

    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(true)
    expect(gate.decision.kind).toBe("REWRITE")
    expect(gate.rewrittenPayload).toEqual(cappedPayload)
  })

  it("addItem DEFER → proceed:false + envelope parked in redis via parkDeferredIntentWithNxGuard", async () => {
adjudicateMock.mockReturnValue(deferDecision())

    const envelope = buildAddItemEnvelope(
      { cartId: "c", variantId: "v", quantity: 1, allergens: [] },
      makeCtx(),
      SESSION_ID,
    )
    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(false)
    expect(gate.parked).toBe(true)
    // P0-7 + audit-2026-05-24 P0-1: park flows through the NX-guarded wrapper
    // (`parkDeferredIntentWithNxGuard`), which performs:
    //   1. SETNX placeholder write at `defer:pending:{sessionId}` to atomically
    //      claim the park slot. (Without NX, a second DEFER would silently
    //      overwrite the first parked envelope.)
    //   2. The framework's INCR on the quota counter at `defer:count:{sessionId}`.
    //   3. EXPIRE on the counter (TTL hygiene).
    //   4. The framework's plain SET that overwrites our placeholder with the
    //      real envelope blob.
    // Total SET calls: 2 — first the NX placeholder, then the real envelope.
    expect(redisIncrMock).toHaveBeenCalledTimes(1)
    const incrCall = redisIncrMock.mock.calls[0] as unknown as [string]
    expect(incrCall[0]).toBe(`ibatexas:defer:count:${SESSION_ID}`)
    expect(redisSetMock).toHaveBeenCalledTimes(2)
    type SetCall = [string, string, { EX: number; NX?: boolean }]
    const setCalls = redisSetMock.mock.calls as unknown as SetCall[]
    // Call 1 — NX placeholder (audit-2026-05-24 P0-1 collision guard).
    expect(setCalls[0][0]).toBe(`ibatexas:defer:pending:${SESSION_ID}`)
    const placeholder = JSON.parse(setCalls[0][1]) as { __nx_placeholder__?: boolean }
    expect(placeholder.__nx_placeholder__).toBe(true)
    expect(setCalls[0][2].NX).toBe(true)
    // Call 2 — the real envelope blob written by the framework primitive
    // (no NX, just EX). This is the parked payload we read on resume.
    expect(setCalls[1][0]).toBe(`ibatexas:defer:pending:${SESSION_ID}`)
    expect(setCalls[1][2].NX).toBeUndefined()
    const parsed = JSON.parse(setCalls[1][1]) as {
      envelope: {
        intentHash: string
        version: number
        nonce: string
        taint: string
        actorPrincipal: string
      }
      signal: string
    }
    expect(parsed.envelope.intentHash).toBe(envelope.intentHash)
    expect(parsed.signal).toBe("payment.confirmed")
    // T-005: verification fields are populated so verifyParkedEnvelopeHash
    // can re-derive the intentHash on resume.
    expect(parsed.envelope.version).toBe(envelope.version)
    expect(parsed.envelope.nonce).toBe(envelope.nonce)
    expect(parsed.envelope.taint).toBe(envelope.taint)
    expect(parsed.envelope.actorPrincipal).toBe(envelope.actor.principal)
    expect(setCalls[1][2].EX).toBeGreaterThan(60)
  })

  it("addItem DEFER with quota_exceeded → proceed:false + userFacing pt-BR copy (NX placeholder released)", async () => {
    // Simulate the quota threshold being exceeded by returning a count
    // above DEFAULT_DEFER_QUOTA_PER_SESSION (16).
    redisIncrMock.mockResolvedValueOnce(17)
adjudicateMock.mockReturnValue(deferDecision())

    const envelope = buildAddItemEnvelope(
      { cartId: "c", variantId: "v", quantity: 1, allergens: [] },
      makeCtx(),
      SESSION_ID,
    )
    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(false)
    // Only the NX placeholder was written (NX:true) — no real envelope SET,
    // because the framework primitive bailed before its blob write.
    expect(redisSetMock).toHaveBeenCalledTimes(1)
    type SetCall = [string, string, { EX: number; NX?: boolean }]
    const setCalls = redisSetMock.mock.calls as unknown as SetCall[]
    expect(setCalls[0][2].NX).toBe(true)
    // audit-2026-05-24 P0-1: the wrapper releases the placeholder when quota
    // fails so the next legitimate DEFER for this session isn't blocked.
    expect(redisDelMock).toHaveBeenCalledWith(
      `ibatexas:defer:pending:${SESSION_ID}`,
    )
    // pt-BR refusal copy surfaces.
    expect(gate.userFacing).toMatch(/operações em espera/i)
  })

  it("addItem DEFER with COLLISION (existing parked envelope) → proceed:false + pt-BR collision refusal, framework primitive NOT invoked", async () => {
    // audit-2026-05-24 P0-1 regression test: when an envelope is already
    // parked at `defer:pending:{sessionId}`, the NX wrapper's SETNX returns
    // null and we MUST refuse rather than let the framework primitive
    // silently overwrite the existing parked payload.
    //
    // We simulate "slot already claimed" by having SET-with-NX return null
    // (the node-redis semantics for SET NX when the key exists). Cast
    // through `unknown` because the mock's inferred signature returns
    // `string`, but the real client returns `string | null`.
    redisSetMock.mockResolvedValueOnce(null as unknown as string)
    adjudicateMock.mockReturnValue(deferDecision())

    const envelope = buildAddItemEnvelope(
      { cartId: "c", variantId: "v", quantity: 1, allergens: [] },
      makeCtx(),
      SESSION_ID,
    )
    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(false)
    // Only the SETNX attempt was made — the framework primitive (INCR
    // followed by plain SET) is never reached because the slot is taken.
    expect(redisSetMock).toHaveBeenCalledTimes(1)
    expect(redisIncrMock).not.toHaveBeenCalled()
    // The collision refusal copy is the canonical pt-BR string from the
    // wrapper module — proves we routed through the NX guard, not the
    // raw framework primitive.
    expect(gate.userFacing).toBe(
      "Já existe operação em espera para esta sessão.",
    )
  })

  it("addItem REQUEST_CONFIRMATION → proceed:false + pt-BR copy", async () => {
adjudicateMock.mockReturnValue(confirmDecision())

    const envelope = buildAddItemEnvelope(
      { cartId: "c", variantId: "v", quantity: 1, allergens: [] },
      makeCtx(),
      SESSION_ID,
    )
    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(false)
    expect(gate.userFacing).toMatch(/confirmação/i)
  })

  it("addItem ESCALATE → proceed:false + pt-BR copy", async () => {
adjudicateMock.mockReturnValue(escalateDecision())

    const envelope = buildAddItemEnvelope(
      { cartId: "c", variantId: "v", quantity: 1, allergens: [] },
      makeCtx(),
      SESSION_ID,
    )
    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(false)
    expect(gate.userFacing).toMatch(/revisão|atendente/i)
  })

  it("processCheckout REFUSE → proceed:false (envelope kind = order.checkout.create)", async () => {
adjudicateMock.mockReturnValue(refuseDecision("Carrinho vazio."))

    const payload: KernelCheckoutPayload = {
      cartId: "c",
      paymentMethod: "pix",
      tipInCentavos: 0,
      deliveryCep: null,
    }
    const envelope = buildCheckoutEnvelope(payload, makeCtx(), SESSION_ID)
    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(false)
    expect(gate.userFacing).toBe("Carrinho vazio.")
    // adjudicate received the right envelope kind.
    expect(adjudicateMock.mock.calls[0]![0].kind).toBe("order.checkout.create")
  })

  it("cancelOrder EXECUTE → proceed:true (envelope kind = order.cancel)", async () => {
adjudicateMock.mockReturnValue(executeDecision())

    const payload: KernelCancelPayload = { orderId: "ord_01" }
    const envelope = buildCancelOrderEnvelope(payload, makeCtx(), SESSION_ID)
    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(true)
    expect(adjudicateMock.mock.calls[0]![0].kind).toBe("order.cancel")
  })

  it("regeneratePix REFUSE → proceed:false (envelope kind = payment.pix.regenerate)", async () => {
adjudicateMock.mockReturnValue(refuseDecision("Pedido não encontrado."))

    const payload: KernelRegeneratePixPayload = { orderId: "ord_01" }
    const envelope = buildRegeneratePixEnvelope(payload, makeCtx(), SESSION_ID)
    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(false)
    expect(adjudicateMock.mock.calls[0]![0].kind).toBe("payment.pix.regenerate")
  })
})

