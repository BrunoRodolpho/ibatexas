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
  /** BKL-085: taint defaults to UNTRUSTED (the model-parsed customer/ops refund
   *  this D1 suite models). A test that needs the RAW Inv-11 band (no taint
   *  overlay) passes "TRUSTED" — the admin-HTTP provenance. */
  taint?: "TRUSTED" | "UNTRUSTED" | "SYSTEM"
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
    taint = "UNTRUSTED",
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
    taint,
    nonce: `n-${sessionId}-${amount}-${resource}-${withRefs}-${taint}`,
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
  it("(a) cross-customer refund < R$500 REFUSES via the OWNERSHIP authGuard's BINDING conjunct", () => {
    // Authority binds ORDER to CUST, but the refund targets a NON-owned order.
    //
    // F-26 — `enforcePaymentOwnership` has TWO conjuncts refusing with the SAME code
    // (`payment.ownership_denied`): the BINDING (declared owner does not own the
    // resource) and the IDOR gate (authenticated session ≠ declared owner). This case
    // is the BINDING one — the session here IS the authenticated owner. A code-only
    // pin would also pass if the binding branch were neutered, because an unbound
    // resource resolves principal to null and then trips the IDOR branch instead.
    // Measured: with the two branches' reasons swapped, all 135 tests in this package
    // stayed green. The auth basis `reason` is the discriminator; the basis row is
    // keyed `category` (never `kind`).
    const d = adjudicate(
      refundEnv({ amount: 1_000, resource: "ord-OTHER" }),
      authState(),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind !== "REFUSE") return
    expect(d.refusal.code).toBe("payment.ownership_denied")
    const reason = (
      d as unknown as { basis?: readonly { category?: string; detail?: { reason?: string } }[] }
    ).basis?.find((b) => b.category === "auth")?.detail?.reason
    expect(reason).toBe("resource_not_owned")
  })
  it("(a non-vacuous) the SAME small cross-customer refund reaches a POSITIVE terminal with NO injected authority — so the ownership guard, not the band, REFUSED", () => {
    // Absent authority, the ownership REFUSE cannot fire; the refund reaches a
    // positive terminal. Post-BKL-085 that terminal is REQUEST_CONFIRMATION (the
    // envelope is UNTRUSTED, so the taint overlay confirms it) rather than the
    // pre-overlay EXECUTE — still NOT a REFUSE, so the ownership guard's REFUSE in
    // the paired test above was load-bearing.
    const d = adjudicate(
      refundEnv({ amount: 1_000, resource: "ord-OTHER", withRefs: false }),
      noAuthState(),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("REQUEST_CONFIRMATION")
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
  it("(b non-vacuous) the SAME exhausted-balance refund reaches a POSITIVE terminal through the band path with NO authority — the magnitude ladder trusts the snapshot, the eligibility guard reads live state", () => {
    // No authority ⇒ the eligibility guard is inert; the magnitude ladder trusts
    // the (lying) snapshot and reaches a positive terminal — REQUEST_CONFIRMATION
    // post-BKL-085 (UNTRUSTED taint overlay), not the pre-overlay EXECUTE. Still
    // NOT a REFUSE, so the eligibility guard's REFUSE above was load-bearing.
    const d = adjudicate(
      refundEnv({ amount: 10_000, refundable: 50_000, currentRefunded: 30_000, amountInCentavos: 30_000, withRefs: false }),
      noAuthState({ currentStatus: "partially_refunded", refundedAmountCentavos: 30_000, amountInCentavos: 30_000 }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("REQUEST_CONFIRMATION")
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
  it("(c non-vacuous) the SAME refund reaches a POSITIVE terminal once the payment is read LIVE this turn — so the freshness guard is what REFUSED", () => {
    // Freshness satisfied ⇒ the freshness REFUSE cannot fire; the refund reaches a
    // positive terminal — REQUEST_CONFIRMATION post-BKL-085 (UNTRUSTED overlay).
    const d = adjudicate(
      refundEnv({ amount: 1_000 }),
      authState({ paymentReadThisTurn: true }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("REQUEST_CONFIRMATION")
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
  it("(d non-vacuous) the SAME refund reaches a POSITIVE terminal once the payment is settled (paid) — so the refundable-state guard is what REFUSED", () => {
    // Settled ⇒ the refundable-state REFUSE cannot fire; the refund reaches a
    // positive terminal — REQUEST_CONFIRMATION post-BKL-085 (UNTRUSTED overlay).
    const d = adjudicate(
      refundEnv({ amount: 1_000 }),
      authState({ currentStatus: "paid" }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("REQUEST_CONFIRMATION")
  })

  // (e) legitimate small owner refund: the 4 conjuncts do NOT REFUSE it (they all
  //     pass); the CONFIRM comes from the BKL-085 UNTRUSTED taint overlay, NOT the
  //     conjuncts. (A TRUSTED admin-HTTP refund of the same shape EXECUTEs — see
  //     the taint matrix in refund-taint-confirm.test.ts.)
  it("(e) legitimate owner refund < R$500 of a refundable, not-exhausted, freshly-read payment passes all 4 conjuncts (no conjunct REFUSE) — the UNTRUSTED taint overlay confirms it", () => {
    const d = adjudicate(refundEnv({ amount: 30_000 }), authState(), paymentsPolicyBundle)
    expect(d.kind).toBe("REQUEST_CONFIRMATION")
    // Prove it is the TAINT overlay (not a conjunct): the SAME refund on the
    // TRUSTED admin-HTTP provenance EXECUTEs — the conjuncts are taint-agnostic.
    const trusted = adjudicate(
      refundEnv({ amount: 30_000, taint: "TRUSTED" }),
      authState(),
      paymentsPolicyBundle,
    )
    expect(trusted.kind).toBe("EXECUTE")
  })
})

describe("D1 — (f) Inv 11 amount bands preserved + B1 overlay honored", () => {
  // Interior band points (avoid the pre-existing strict-`>` boundary at the exact
  // thresholds, which is out of D1 scope — the magnitude ladder is untouched).
  it("EXECUTE band: < R$500, with the 4 conjuncts engaged (TRUSTED — raw Inv-11 band, no taint overlay)", () => {
    // TRUSTED provenance so the BKL-085 overlay does NOT apply — this pins the raw
    // Inv-11 EXECUTE band is preserved with the 4 conjuncts engaged.
    expect(adjudicate(refundEnv({ amount: 30_000, taint: "TRUSTED" }), authState(), paymentsPolicyBundle).kind).toBe("EXECUTE")
  })
  it("REQUEST_CONFIRMATION band: [R$500, R$1000), with the 4 conjuncts engaged", () => {
    expect(adjudicate(refundEnv({ amount: 60_000 }), authState(), paymentsPolicyBundle).kind).toBe("REQUEST_CONFIRMATION")
  })
  it("ESCALATE band: ≥ R$1000, with the 4 conjuncts engaged (overlay never pre-empts ESCALATE)", () => {
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
