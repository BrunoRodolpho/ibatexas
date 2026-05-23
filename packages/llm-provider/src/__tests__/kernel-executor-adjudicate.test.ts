// Tests for kernel-executor's adjudicate-mutation gate (Task 06).
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
// The helper itself decides between pure-legacy / shadow / enforce paths
// based on `IBX_KERNEL_SHADOW` and `IBX_KERNEL_ENFORCE`. To keep these
// tests deterministic we drive the path explicitly via the env var.
//
// We mock @adjudicate/core/kernel.adjudicate to control the Decision the
// gate observes — that lets us assert the branching contract without
// dragging in the full policy bundle for every decision kind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Decision, IntentEnvelope } from "@adjudicate/core"

// ── Module-level mocks (vi.hoisted for vi.mock-factory access) ──────────────
// vi.mock factories run BEFORE module-level `const` initializers, so any
// shared mock state must be created via vi.hoisted so the factory can read
// it. See https://vitest.dev/api/vi.html#vi-mock — the "Cannot access X
// before initialization" trap is exactly this hoisting order.

const {
  adjudicateMock,
  adjudicateWithShadowMock,
  isEnforcedMock,
  isShadowedMock,
  redisSetMock,
  redisIncrMock,
  redisDecrMock,
  redisExpireMock,
  auditEmitMock,
} = vi.hoisted(() => ({
  adjudicateMock: vi.fn(),
  adjudicateWithShadowMock: vi.fn(),
  isEnforcedMock: vi.fn(),
  isShadowedMock: vi.fn(),
  redisSetMock: vi.fn(async () => "OK"),
  // parkDeferredIntent calls INCR → EXPIRE → SET. We default to count=1
  // so the quota check (default 16) is satisfied.
  redisIncrMock: vi.fn(async () => 1),
  redisDecrMock: vi.fn(async () => 0),
  redisExpireMock: vi.fn(async () => 1),
  auditEmitMock: vi.fn(async () => undefined),
}))

vi.mock("@adjudicate/core/kernel", async () => {
  const actual = (await vi.importActual(
    "@adjudicate/core/kernel",
  )) as Record<string, unknown>
  return {
    ...actual,
    adjudicate: adjudicateMock,
    adjudicateWithShadow: adjudicateWithShadowMock,
    isEnforced: isEnforcedMock,
    isShadowed: isShadowedMock,
    // legacyDecisionAsKernelDecision is pure — pass through the real impl.
  }
})

// Redis stub for the DEFER park path. We assert against `set` calls.
// parkDeferredIntent uses INCR/EXPIRE/SET so all four are needed.
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
  adjudicateWithShadowMock.mockReset()
  isEnforcedMock.mockReset()
  isShadowedMock.mockReset()
  redisSetMock.mockReset()
  auditEmitMock.mockReset()

  // Default: pure-legacy path (no shadow, no enforce). Individual tests
  // override these mocks to drive specific branches.
  isEnforcedMock.mockReturnValue(false)
  isShadowedMock.mockReturnValue(false)
  // Redis stub returns success by default.
  redisSetMock.mockResolvedValue("OK")
  auditEmitMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── Pure-legacy path (no shadow, no enforce) ────────────────────────────────

describe("adjudicateKernelMutation — pure-legacy path", () => {
  it("returns proceed:true with synthesized EXECUTE when neither shadow nor enforce names the kind", async () => {
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
    expect(gate.proceed).toBe(true)
    expect(gate.decision.kind).toBe("EXECUTE")
    // Audit MUST NOT emit for pure-legacy (investigation 01 §"P2 #7").
    expect(auditEmitMock).not.toHaveBeenCalled()
    // Real `adjudicate()` MUST NOT run in pure-legacy.
    expect(adjudicateMock).not.toHaveBeenCalled()
  })
})

// ── Enforce path ────────────────────────────────────────────────────────────

describe("adjudicateKernelMutation — enforce path", () => {
  it("addItem EXECUTE → proceed:true (no rewritten payload)", async () => {
    isEnforcedMock.mockReturnValue(true)
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
    isEnforcedMock.mockReturnValue(true)
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
    isEnforcedMock.mockReturnValue(true)
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

  it("addItem DEFER → proceed:false + envelope parked in redis via parkDeferredIntent", async () => {
    isEnforcedMock.mockReturnValue(true)
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
    // P0-7: park flows through parkDeferredIntent which calls INCR (quota
    // counter), EXPIRE (TTL on counter), then SET (envelope blob).
    expect(redisIncrMock).toHaveBeenCalledTimes(1)
    const incrCall = redisIncrMock.mock.calls[0] as unknown as [string]
    expect(incrCall[0]).toBe(`ibatexas:defer:count:${SESSION_ID}`)
    expect(redisSetMock).toHaveBeenCalledTimes(1)
    const setCall = redisSetMock.mock.calls[0] as unknown as [
      string,
      string,
      { EX: number },
    ]
    expect(setCall[0]).toBe(`ibatexas:defer:pending:${SESSION_ID}`)
    const parsed = JSON.parse(setCall[1]) as {
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
    expect(setCall[2].EX).toBeGreaterThan(60)
  })

  it("addItem DEFER with quota_exceeded → proceed:false + userFacing pt-BR copy", async () => {
    // Simulate the quota threshold being exceeded by returning a count
    // above DEFAULT_DEFER_QUOTA_PER_SESSION (16).
    redisIncrMock.mockResolvedValueOnce(17)
    isEnforcedMock.mockReturnValue(true)
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
    // No park blob written because quota was exceeded.
    expect(redisSetMock).not.toHaveBeenCalled()
    // pt-BR refusal copy surfaces.
    expect(gate.userFacing).toMatch(/operações em espera/i)
  })

  it("addItem REQUEST_CONFIRMATION → proceed:false + pt-BR copy", async () => {
    isEnforcedMock.mockReturnValue(true)
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
    isEnforcedMock.mockReturnValue(true)
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
    isEnforcedMock.mockReturnValue(true)
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
    isEnforcedMock.mockReturnValue(true)
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

  it("regeneratePix REFUSE → proceed:false (envelope kind = order.pix.regenerate)", async () => {
    isEnforcedMock.mockReturnValue(true)
    adjudicateMock.mockReturnValue(refuseDecision("Pedido não encontrado."))

    const payload: KernelRegeneratePixPayload = { orderId: "ord_01" }
    const envelope = buildRegeneratePixEnvelope(payload, makeCtx(), SESSION_ID)
    const gate = await __testOnly__adjudicateKernelMutation(
      envelope,
      makeCtx(),
      SESSION_ID,
    )
    expect(gate.proceed).toBe(false)
    expect(adjudicateMock.mock.calls[0]![0].kind).toBe("order.pix.regenerate")
  })
})

// ── Shadow path ─────────────────────────────────────────────────────────────

describe("adjudicateKernelMutation — shadow path", () => {
  it("runs both legacy and adjudicate; proceed reflects the LEGACY EXECUTE baseline", async () => {
    isEnforcedMock.mockReturnValue(false)
    isShadowedMock.mockReturnValue(true)
    // adjudicateWithShadow's real return shape is
    //   { legacyDecision: { kind: "EXECUTE" | "REFUSE" },
    //     adjudicateDecision: Decision,
    //     divergence: DivergenceClass }
    // The gate calls `legacyDecisionAsKernelDecision(legacyDecision)`, so
    // we mock the legacy side as EXECUTE.
    adjudicateWithShadowMock.mockReturnValue({
      legacyDecision: { kind: "EXECUTE" },
      adjudicateDecision: refuseDecision("would-have-refused"),
      divergence: "DECISION_KIND",
    })

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
    // Legacy EXECUTE wins under shadow; the kernel's REFUSE only goes to audit.
    expect(gate.proceed).toBe(true)
    expect(gate.decision.kind).toBe("EXECUTE")
    expect(adjudicateWithShadowMock).toHaveBeenCalledTimes(1)
    // Audit emits for shadow.
    expect(auditEmitMock).toHaveBeenCalledTimes(1)
  })
})
