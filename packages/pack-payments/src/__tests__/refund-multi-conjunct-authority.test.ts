/**
 * D1 — Refund-action authority as a MULTI-CONJUNCT invariant (SDD Inv 11 strengthen).
 *
 * A `payment.refund.issue` is authorized iff
 *   `ownership ∧ payment-state-refundable ∧ refund-eligibility(not-already-refunded)
 *    ∧ resource-freshness(read live this turn)`
 * AND its amount band (Inv 11) resolves to EXECUTE/CONFIRM/ESCALATE. Ownership is the
 * AUTH-phase `enforcePaymentOwnership`; the other three are BUSINESS-phase guards
 * evaluated BEFORE the magnitude ladder. All four engage only when the host injects
 * `state.authority` (the 4-conjunct enforcement seam) and FAIL CLOSED.
 *
 * NON-VACUITY (sdd_selfcheck): each REFUSE case is paired with a proof that, absent
 * the relevant conjunct (no injected authority, or the signal flipped), the SAME
 * refund would EXECUTE through the amount-band path — so the guard, not the band, is
 * what REFUSED. The band verdicts themselves are left EXACTLY as Inv 11 specifies.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import {
  buildEnvelope,
  createAuthorityGraphStore,
  type IntentEnvelope,
} from "@adjudicate/core"
import {
  pixPolicyBundle,
  type PixCharge,
  type PixIntentKind,
  type PixState,
} from "@adjudicate/pack-payments-pix"
import {
  paymentsPolicyBundle,
  type PaymentIntentKind,
  type PaymentPayload,
  type PaymentState,
} from "../index.js"

const DET = "2026-06-26T12:00:00.000Z"
const CUST = "cust-A"
const SESS = "sess-A" // the conductor-authenticated session
const ORDER = "ord-A" // the owned order = the refund ownership resource

// ── Envelope builder for payment.refund.issue ────────────────────────────────
function refundEnv(opts: {
  amount: number
  refundable?: number
  currentRefunded?: number
  amountInCentavos?: number
  sessionId?: string
  owner?: string
  resource?: string
  withRefs?: boolean
}): IntentEnvelope<PaymentIntentKind, PaymentPayload> {
  const {
    amount,
    refundable = 1_000_000,
    currentRefunded = 0,
    amountInCentavos = 1_000_000,
    sessionId = SESS,
    owner = CUST,
    resource = ORDER,
    withRefs = true,
  } = opts
  return buildEnvelope({
    kind: "payment.refund.issue",
    payload: {
      paymentId: "pay-1",
      refundAmountCentavos: amount,
      refundableBalanceCentavos: refundable,
      amountInCentavos,
      currentRefundedCentavos: currentRefunded,
      actor: "admin",
    } as unknown as PaymentPayload,
    actor: { principal: "user", sessionId },
    taint: "UNTRUSTED",
    nonce: `n-${sessionId}-${amount}-${resource}-${withRefs}`,
    createdAt: DET,
    ...(withRefs ? { resourceRefs: { owner, resource } } : {}),
  }) as IntentEnvelope<PaymentIntentKind, PaymentPayload>
}

// Authority INJECTED → the 4-conjunct invariant is binding.
function authState(opts: {
  currentStatus?: string
  refundedAmountCentavos?: number
  amountInCentavos?: number
  paymentReadThisTurn?: boolean
  ownedResource?: string
  knownSession?: string
  owner?: string
} = {}): PaymentState {
  const {
    currentStatus = "paid",
    refundedAmountCentavos = 0,
    amountInCentavos = 1_000_000,
    paymentReadThisTurn = true,
    ownedResource = ORDER,
    knownSession = SESS,
    owner = CUST,
  } = opts
  return {
    ctx: {
      actor: { principal: "user" },
      tenantId: "ibatexas",
      exists: true,
      currentStatus,
      currentMethod: "pix",
      version: 1,
      orderId: ownedResource,
      isTerminal: false,
      refundedAmountCentavos,
      amountInCentavos,
      paymentReadThisTurn,
    },
    authority: {
      store: createAuthorityGraphStore({
        edges: [
          {
            principal: owner,
            relationship: "owns",
            resource: ownedResource,
            permits: { actions: ["payment.refund.issue"] },
          },
        ],
      }),
      principalOf: (sid: string) => (sid === knownSession ? owner : null),
    },
  } as unknown as PaymentState
}

// NO authority → legacy band-only posture (the four guards are inert).
function noAuthState(opts: {
  currentStatus?: string
  amountInCentavos?: number
  refundedAmountCentavos?: number
} = {}): PaymentState {
  return {
    ctx: {
      actor: { principal: "user" },
      exists: true,
      isTerminal: false,
      currentStatus: opts.currentStatus ?? "paid",
      refundedAmountCentavos: opts.refundedAmountCentavos ?? 0,
      amountInCentavos: opts.amountInCentavos ?? 1_000_000,
    },
  }
}

describe("D1 — refund multi-conjunct authority (SDD Inv 11 strengthen)", () => {
  // (a) ownership conjunct — cross-customer refund REFUSES below the EXECUTE band.
  it("(a) cross-customer refund < R$500 REFUSES via the OWNERSHIP authGuard", () => {
    // Authority binds ORDER to CUST, but the refund targets a NON-owned order.
    const d = adjudicate(
      refundEnv({ amount: 1_000, resource: "ord-OTHER" }),
      authState(),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("payment.ownership_denied")
  })
  it("(a non-vacuous) the SAME small cross-customer refund EXECUTEs with NO injected authority — so the guard, not the band, REFUSED", () => {
    const d = adjudicate(
      refundEnv({ amount: 1_000, resource: "ord-OTHER", withRefs: false }),
      noAuthState(),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("EXECUTE")
  })

  // (b) eligibility conjunct — already-fully-refunded REFUSES (live state, not snapshot).
  it("(b) already-fully-refunded payment REFUSES via the ELIGIBILITY guard, despite a stale 'balance available' snapshot", () => {
    const d = adjudicate(
      // Envelope SNAPSHOT lies: refundable=50_000. LIVE state: 30_000 of 30_000 refunded.
      refundEnv({ amount: 10_000, refundable: 50_000, currentRefunded: 30_000, amountInCentavos: 30_000 }),
      authState({ currentStatus: "partially_refunded", refundedAmountCentavos: 30_000, amountInCentavos: 30_000 }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("refund.already_refunded")
  })
  it("(b non-vacuous) the SAME exhausted-balance refund EXECUTEs through the band path with NO authority — the magnitude ladder trusts the snapshot, the eligibility guard reads live state", () => {
    const d = adjudicate(
      refundEnv({ amount: 10_000, refundable: 50_000, currentRefunded: 30_000, amountInCentavos: 30_000, withRefs: false }),
      noAuthState({ currentStatus: "partially_refunded", refundedAmountCentavos: 30_000, amountInCentavos: 30_000 }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("EXECUTE")
  })

  // (c) freshness conjunct — not-read-this-turn REFUSES.
  it("(c) stale (not read this turn) refund REFUSES via the FRESHNESS guard", () => {
    const d = adjudicate(
      refundEnv({ amount: 1_000 }),
      authState({ paymentReadThisTurn: false }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("refund.stale_read")
  })
  it("(c non-vacuous) the SAME refund EXECUTEs once the payment is read LIVE this turn — so the freshness guard is what REFUSED", () => {
    const d = adjudicate(
      refundEnv({ amount: 1_000 }),
      authState({ paymentReadThisTurn: true }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("EXECUTE")
  })

  // (d) refundable-state conjunct — unsettled payment REFUSES.
  it("(d) refund on a non-refundable (unsettled) payment REFUSES via the STATE-REFUNDABLE guard", () => {
    const d = adjudicate(
      refundEnv({ amount: 1_000 }),
      authState({ currentStatus: "awaiting_payment" }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("refund.not_refundable_state")
  })
  it("(d non-vacuous) the SAME refund EXECUTEs once the payment is settled (paid) — so the refundable-state guard is what REFUSED", () => {
    const d = adjudicate(
      refundEnv({ amount: 1_000 }),
      authState({ currentStatus: "paid" }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("EXECUTE")
  })

  // (e) legitimate small owner refund still EXECUTEs (Inv 11 build-error guard).
  it("(e) legitimate owner refund < R$500 of a refundable, not-exhausted, freshly-read payment EXECUTEs — the 4 conjuncts do NOT force a confirm/refuse on a small refund", () => {
    const d = adjudicate(refundEnv({ amount: 30_000 }), authState(), paymentsPolicyBundle)
    expect(d.kind).toBe("EXECUTE")
  })
})

describe("D1 — (f) Inv 11 amount bands preserved + B1 overlay honored", () => {
  // Interior band points (avoid the pre-existing strict-`>` boundary at the exact
  // thresholds, which is out of D1 scope — the magnitude ladder is untouched).
  it("EXECUTE band: < R$500, with the 4 conjuncts engaged", () => {
    expect(adjudicate(refundEnv({ amount: 30_000 }), authState(), paymentsPolicyBundle).kind).toBe("EXECUTE")
  })
  it("REQUEST_CONFIRMATION band: [R$500, R$1000), with the 4 conjuncts engaged", () => {
    expect(adjudicate(refundEnv({ amount: 60_000 }), authState(), paymentsPolicyBundle).kind).toBe("REQUEST_CONFIRMATION")
  })
  it("ESCALATE band: ≥ R$1000, with the 4 conjuncts engaged", () => {
    expect(adjudicate(refundEnv({ amount: 150_000 }), authState(), paymentsPolicyBundle).kind).toBe("ESCALATE")
  })

  // B1 overlay lives in the published @adjudicate/pack-payments-pix for the
  // agent-plane real-money kind `pix.charge.refund` (the in-repo `payment.refund.issue`
  // is the customer/staff path; no agent declares it). Lock it: an agent-session refund
  // REQUEST_CONFIRMATIONs regardless of amount; a non-agent small refund EXECUTEs.
  function pixState(): PixState {
    const charge: PixCharge = { id: "ch1", amountCentavos: 5_000, status: "confirmed", createdAt: DET }
    return { charges: new Map<string, PixCharge>([["ch1", charge]]) }
  }
  function pixRefundEnv(sessionId: string): IntentEnvelope<PixIntentKind, unknown> {
    return buildEnvelope({
      kind: "pix.charge.refund",
      payload: { chargeId: "ch1", refundCentavos: 1_000, reason: "r" },
      actor: { principal: sessionId.startsWith("agent:") ? "llm" : "user", sessionId },
      taint: "UNTRUSTED",
      nonce: `n-pix-${sessionId}`,
      createdAt: DET,
    }) as IntentEnvelope<PixIntentKind, unknown>
  }
  it("B1: an agent-session pix.charge.refund REQUEST_CONFIRMATIONs regardless of amount (published pack, untouched)", () => {
    const d = adjudicate(pixRefundEnv("agent:bot@1:entity:x"), pixState(), pixPolicyBundle)
    expect(d.kind).toBe("REQUEST_CONFIRMATION")
  })
  it("B1 non-vacuous: a NON-agent small pix.charge.refund EXECUTEs — so B1 (sessionId namespace), not the amount, gates the agent path", () => {
    const d = adjudicate(pixRefundEnv("staff:1"), pixState(), pixPolicyBundle)
    expect(d.kind).toBe("EXECUTE")
  })
})
