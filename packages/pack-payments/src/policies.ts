/**
 * @ibatexas/pack-payments — PolicyBundle.
 *
 * Composed from `@adjudicate/primitives` factories
 * (`createSystemTaintPolicy`). Default polarity is REFUSE — per master
 * plan §"Governance principles" #4 and
 * `governance/04-decision-policy.md` §"Default refuse policy".
 *
 * Guard ordering inside each phase matters. Kernel evaluation order is
 * `state → taint → auth → business` (ADR-104). The refund-magnitude
 * ladder lives in the business phase so the structural REFUSE/CONFIRM/
 * ESCALATE bands fire after state preconditions (exists, terminal)
 * already passed.
 *
 * # Migrated from `paymentProjectionPolicyBundle`
 *
 * The W3 fixes ground-truthed five payment kinds inside
 * `packages/domain/src/services/__shared__/payment-projection-policy.ts`.
 * This Pack carries the same guards (`refundMagnitudeGuard`,
 * `regenerationCountCapGuard`, `requirePaymentExists`,
 * `refuseTerminalTransition`) PLUS the additional 12 kinds the
 * taxonomy enumerates. The legacy bundle becomes a re-export shim
 * (Decision D8 — parallel-surface during incremental migration).
 */

import {
  basis,
  BASIS_CODES,
  decisionEscalate,
  decisionExecute,
  decisionRefuse,
  decisionRequestConfirmation,
  resolveOwnership,
} from "@adjudicate/core"
import {
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { requireTenantBinding } from "@adjudicate/primitives"
import { classifyRefundMagnitudeBand } from "@ibatexas/types"
import {
  refundAlreadyExhausted,
  refundNotInRefundableState,
  refundStaleRead,
  refundStateDivergent,
  refuseAmountNonPositive,
  refuseDefault,
  refuseMethodInvalid,
  refusePaymentNotFound,
  refusePaymentOwnershipDenied,
  refusePaymentTerminal,
  refuseRefundAmountInvalid,
  refuseRefundOverBalance,
  refuseRegenerationCapExceeded,
  refuseRegenerationStateDivergent,
  refuseRetryCapExceeded,
  refuseSameMethodSwitch,
} from "./refusals.js"
import {
  getMaxPaymentRetriesPerDay,
  getMaxPixRegenerationsPerPayment,
  getRefundConfirmThresholdCentavos,
  getRefundEscalateThresholdCentavos,
  paymentsTaintPolicy,
  type PaymentCreatePayload,
  type PaymentIntentKind,
  type PaymentMethodSwitchPayload,
  type PaymentPayload,
  type PaymentPixRegeneratePayload,
  type PaymentRefundIssuePayload,
  type PaymentRetryPayload,
  type PaymentState,
} from "./types.js"

type PaymentGuard = Guard<PaymentIntentKind, PaymentPayload, PaymentState>

/**
 * Tenant binding (AuthReviewer-009 / RC-A1 D-12). REFUSEs a request whose
 * `state.ctx.tenantId` is not the configured tenant; lenient (no-op) when absent
 * (the gateway/legacy path that does not yet supply it). Reads (actor, state) →
 * Decision — no principal/hashed-byte change. Env-driven tenant (Hard Rule #3).
 *
 * F-29 — NAME COLLISION. This guard REFUSEs with the CODE
 * `tenant_binding_violation` (authored upstream, in `@adjudicate/primitives`).
 * The SAME string is also a basis REASON, stamped by `enforcePaymentOwnership`'s
 * IDOR conjunct below on a `payment.ownership_denied` refusal — a different
 * guard, a different field, a different mechanism. Both decisions carry
 * `refusal.kind: "SECURITY"` and basis `auth.scope_insufficient`, so the FIELD
 * is the only discriminator, and this guard is `authGuards[0]` — it
 * short-circuits before the ownership guard on all eight ownership-gated kinds.
 * A cross-tenant fixture therefore produces this refusal even with the ownership
 * guard removed entirely. Assert BOTH the code and the auth-basis reason; a
 * code-only assertion proves nothing about ownership. Pinned in apps/api
 * `claustrum/__tests__/ownership-set-agreement.test.ts` §4, which also records
 * why a rename was declined (the code is authored in an external package, so a
 * local rename cannot close the concept).
 */
const requireTenantBindingGuard: PaymentGuard = requireTenantBinding<
  PaymentIntentKind,
  PaymentPayload,
  PaymentState
>((_actor, state) => {
  const tenant = state.ctx.tenantId
  return tenant === undefined || tenant === (process.env.KERNEL_TENANT_ID ?? "ibatexas")
})

// ── State guards ────────────────────────────────────────────────────────

/**
 * Most payment kinds require an existing Payment row. The exceptions
 * are the creation kind (`payment.create`) and the method-switch kind
 * (which can run BEFORE the new method's payment row exists).
 */
const KINDS_REQUIRING_PAYMENT_EXISTS: ReadonlySet<PaymentIntentKind> = new Set([
  "payment.pix.regenerate",
  "payment.retry",
  "payment.refund.issue",
  "payment.refund.confirm",
  "payment.dispute.open",
  "payment.cash.confirm",
  "payment.waive",
  "payment.status.force",
  "payment.status.transition",
  "payment.status.reconcile",
])

const requirePaymentExists: PaymentGuard = (envelope, state) => {
  if (!KINDS_REQUIRING_PAYMENT_EXISTS.has(envelope.kind)) return null
  if (state.ctx.exists) return null
  return decisionRefuse(refusePaymentNotFound(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "payment_not_found",
      kind: envelope.kind,
    }),
  ])
}

// 034-F1 — kernel ownership/IDOR guard for customer money kinds (defense-in-depth;
// mirror of pack-orders). Engages ONLY when the host injects state.authority; the
// resource is the orderId (payment ownership flows through the order), bound in the
// per-customer authority graph of OWNED resources. A non-owned order is unbound ⇒
// REFUSE (de-vacuumed — see the pack-payments ownership canary).
//
// F-24 — this set MUST agree with the adopter's `OWNERSHIP_GATED_KINDS`
// (ibatexas apps/api claustrum/authority-wiring.ts), which decides what gets a
// `resourceRefs` stamp and an injected `state.authority`. Dropping a kind here
// leaves the adopter stamping an envelope this guard never reads — measured:
// removing `payment.refund.issue` turns a CROSS-CUSTOMER refund from REFUSE into
// REQUEST_CONFIRMATION. The agreement is pinned per kind by that adopter's
// claustrum/__tests__/ownership-set-agreement.test.ts.
const OWNERSHIP_GATED_PAYMENT_KINDS: ReadonlySet<string> = new Set([
  "payment.refund.issue",
  "payment.refund.confirm",
  "payment.pix.regenerate",
])

interface PaymentOwnershipAuthority {
  readonly store: Parameters<typeof resolveOwnership>[0]
  readonly principalOf?: (sessionId: string) => string | null
}

const enforcePaymentOwnership: PaymentGuard = (envelope, state) => {
  const authority = (state as { authority?: PaymentOwnershipAuthority }).authority
  if (authority === undefined) return null
  if (!OWNERSHIP_GATED_PAYMENT_KINDS.has(envelope.kind)) return null
  const fact = resolveOwnership(authority.store, envelope)
  if (!fact.bound) {
    return decisionRefuse(refusePaymentOwnershipDenied(), [
      basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, { reason: "resource_not_owned" }),
    ])
  }
  // IDOR gate: the AUTHENTICATED principal behind the acting session must EQUAL
  // the resource owner. `principalOf` is the host's authenticated session→principal
  // binding (sourced from the conductor-authenticated session, INDEPENDENT of the
  // envelope's self-reported actor.sessionId — see authority-wiring.ts), so a
  // forged / cross-session / unbound-agent actor resolves to null and is REFUSEd.
  const authed = authority.principalOf?.(envelope.actor.sessionId) ?? null
  if (authed === null || authed !== fact.principal) {
    // F-29 — this REASON is the same string as `requireTenantBindingGuard`'s
    // refusal CODE (see that guard above), but a different mechanism: here it
    // rides a `payment.ownership_denied` refusal, there it IS the code. The two
    // decisions agree on refusal.kind and on this very basis code, so only the
    // FIELD tells them apart. Pinned in apps/api
    // `claustrum/__tests__/ownership-set-agreement.test.ts` §4; renaming this
    // reason was considered and declined there (the colliding code is authored
    // in `@adjudicate/primitives`, and this string is in audit records).
    return decisionRefuse(refusePaymentOwnershipDenied(), [
      basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, { reason: "tenant_binding_violation" }),
    ])
  }
  return null
}

/**
 * Block direct transitions on terminal payments — terminal rows must
 * not be resurrected. The webhook reconcile path already enforces this
 * imperatively, but the kernel adjudication adds a uniform audit-
 * visible basis for the refusal.
 *
 * Applies to `payment.status.transition`, `payment.refund.issue`,
 * `payment.status.force`. `payment.status.reconcile` is exempt
 * (out-of-order Stripe events legitimately arrive after terminal).
 */
const KINDS_BLOCKED_ON_TERMINAL: ReadonlySet<PaymentIntentKind> = new Set([
  "payment.status.transition",
  "payment.refund.issue",
  "payment.status.force",
])

const refuseTerminalTransition: PaymentGuard = (envelope, state) => {
  if (!KINDS_BLOCKED_ON_TERMINAL.has(envelope.kind)) return null
  if (!state.ctx.isTerminal) return null
  return decisionRefuse(refusePaymentTerminal(state.ctx.currentStatus), [
    basis("state", BASIS_CODES.state.TERMINAL_STATE, {
      reason: "payment_terminal",
      currentStatus: state.ctx.currentStatus,
    }),
  ])
}

// ── Business guards ─────────────────────────────────────────────────────

const VALID_METHODS = new Set(["pix", "card", "cash"])

const validateCreateMethod: PaymentGuard = (envelope) => {
  if (envelope.kind !== "payment.create") {
    return null
  }
  const payload = envelope.payload as PaymentCreatePayload
  if (typeof payload.method !== "string" || !VALID_METHODS.has(payload.method)) {
    return decisionRefuse(refuseMethodInvalid(payload.method), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "method_valid",
        seen: payload.method,
      }),
    ])
  }
  if (
    typeof payload.amountInCentavos !== "number" ||
    !Number.isInteger(payload.amountInCentavos) ||
    payload.amountInCentavos <= 0
  ) {
    return decisionRefuse(refuseAmountNonPositive(payload.amountInCentavos), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "amount_positive_integer",
        seen: payload.amountInCentavos,
      }),
    ])
  }
  return null
}

const validateMethodSwitch: PaymentGuard = (envelope) => {
  if (envelope.kind !== "payment.method.switch") return null
  const payload = envelope.payload as PaymentMethodSwitchPayload
  if (
    typeof payload.toMethod !== "string" ||
    !VALID_METHODS.has(payload.toMethod) ||
    typeof payload.fromMethod !== "string" ||
    !VALID_METHODS.has(payload.fromMethod)
  ) {
    return decisionRefuse(refuseMethodInvalid(payload.toMethod), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "method_valid",
        from: payload.fromMethod,
        to: payload.toMethod,
      }),
    ])
  }
  if (payload.fromMethod === payload.toMethod) {
    return decisionRefuse(refuseSameMethodSwitch(payload.toMethod), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "method_switch_no_change",
        method: payload.toMethod,
      }),
    ])
  }
  return null
}

// ── D1 — refund-action authority as a MULTI-CONJUNCT invariant ──────────────
//
// SDD Inv 11 (strengthen) / structured-noodling §D1 / §5 fresh+outcome conjuncts:
// a refund is authorized iff
//   `ownership ∧ payment-state-refundable ∧ refund-eligibility(not-already-refunded)
//    ∧ resource-freshness(read live this turn)`.
// Ownership is the AUTH-phase guard (`enforcePaymentOwnership`); the other three
// are BUSINESS-phase guards on the `payment.refund.issue` verdict, evaluated
// BEFORE `refundMagnitudeGuard` so a non-refundable / already-refunded / stale
// refund REFUSEs before the amount band could ever EXECUTE. They do NOT touch the
// amount-band verdict — the bands stay the magnitude guard's job (Inv 11 EXACT).
//
// Like `enforcePaymentOwnership`, they engage ONLY when the host has injected
// `state.authority` (the documented 4-conjunct enforcement seam) and are INERT
// otherwise — so the legacy/standalone band-ladder corpus (no identity model)
// adjudicates exactly as before. When the host opts in they are BINDING and
// FAIL CLOSED: an unsettled status, an exhausted balance, or a not-read-this-turn
// projection → REFUSE, never EXECUTE. Eligibility/freshness are read from the
// LIVE per-turn state — NOT the envelope snapshot — so stale authority cannot
// authorize a refund another process already issued.

/**
 * Statuses from which money can legitimately be refunded — the payment actually
 * settled and still carries refundable balance. Mirrors the Prisma `PaymentStatus`
 * enum: `paid` (settled in full) and `partially_refunded` (settled, balance
 * remaining). Every other status (awaiting/pending/cash_pending/switching/failed/
 * expired/refunded/disputed/canceled/waived) is NOT refundable.
 */
const REFUNDABLE_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "paid",
  "partially_refunded",
])

/** TRUE when the host injected the authority context — the seam that opts the
 *  refund into the full 4-conjunct invariant (identical gate to
 *  `enforcePaymentOwnership`). No authority ⇒ the three guards are inert. */
function refundAuthorityEngaged(state: PaymentState): boolean {
  return (state as { authority?: unknown }).authority !== undefined
}

/** D1 conjunct: payment-state-refundable. REFUSEs a refund whose payment never
 *  settled (or is no longer refundable). Engages only with injected authority. */
const refundPaymentStateRefundableGuard: PaymentGuard = (envelope, state) => {
  if (envelope.kind !== "payment.refund.issue") return null
  if (!refundAuthorityEngaged(state)) return null
  const status = state.ctx.currentStatus
  if (typeof status === "string" && REFUNDABLE_PAYMENT_STATUSES.has(status)) {
    return null
  }
  return decisionRefuse(refundNotInRefundableState(status), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "payment_not_in_refundable_state",
      currentStatus: status,
    }),
  ])
}

/** D1 conjunct: refund-eligibility (not-already-refunded). REFUSEs when the LIVE
 *  state shows the refundable balance is exhausted (refunded ≥ original) — even if
 *  the envelope snapshot still claims balance. Engages only with injected authority. */
const refundEligibilityGuard: PaymentGuard = (envelope, state) => {
  if (envelope.kind !== "payment.refund.issue") return null
  if (!refundAuthorityEngaged(state)) return null
  const amount = state.ctx.amountInCentavos
  const refunded = state.ctx.refundedAmountCentavos ?? 0
  if (typeof amount === "number" && refunded >= amount) {
    return decisionRefuse(refundAlreadyExhausted(refunded, amount), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        reason: "refund_already_exhausted",
        refunded,
        amount,
      }),
    ])
  }
  return null
}

/** D1 conjunct: resource-freshness (must_read_this_turn). REFUSEs unless the
 *  payment projection was read LIVE this turn (`sourceMode == "live"`). Fail-closed:
 *  absent/false marker ⟹ stale ⟹ REFUSE. Engages only with injected authority. */
const refundFreshnessGuard: PaymentGuard = (envelope, state) => {
  if (envelope.kind !== "payment.refund.issue") return null
  if (!refundAuthorityEngaged(state)) return null
  if (state.ctx.paymentReadThisTurn === true) return null
  return decisionRefuse(refundStaleRead(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "payment_read_stale",
      paymentReadThisTurn: state.ctx.paymentReadThisTurn ?? null,
    }),
  ])
}

/**
 * W3 P0-1 — refund magnitude guard (migrated from
 * `paymentProjectionPolicyBundle`).
 *
 * Validates the refund amount and its relation to the refundable balance,
 * then emits the decision ladder per governance §"04-decision-policy.md":
 *
 *   - amount ≤ 0                                    → REFUSE (invalid)
 *   - amount > refundable balance                   → REFUSE (over-refund)
 *   - amount ≥ ESCALATE_REFUND_THRESHOLD_CENTAVOS   → ESCALATE (FE-T03/D2)
 *   - taint === "UNTRUSTED" (BKL-085 overlay)       → REQUEST_CONFIRMATION
 *   - amount > CONFIRM_REFUND_THRESHOLD_CENTAVOS    → REQUEST_CONFIRMATION
 *   - else                                          → EXECUTE
 *
 * The BKL-085 UNTRUSTED overlay sits BETWEEN the ESCALATE band and the
 * medium-CONFIRM band: a model-parsed (ops-plane) refund always confirms —
 * but a ≥ escalate-threshold one still ESCALATEs (escalate pre-empts), and
 * the TRUSTED admin-HTTP path is untouched (see the guard body). The route
 * layer's two-step receipt is a separate UX gate stacked on top of this
 * structural ladder.
 */
const refundMagnitudeGuard: PaymentGuard = (envelope, state) => {
  if (envelope.kind !== "payment.refund.issue") return null
  const payload = envelope.payload as PaymentRefundIssuePayload

  // NEW-P0-X6: `Number.isFinite(NaN) === false` and `Number.isFinite(Infinity)
  // === false`, so this single predicate rejects all three pathological
  // cases the audit flagged (NaN, +Infinity, -Infinity) plus the prior
  // non-number-type and non-positive bands. Without this guard, NaN
  // silently passes every `>` and `<=` comparison in the ladder below
  // (NaN comparisons are always false), and EXECUTEs an "invalid"
  // refund.
  if (
    typeof payload.refundAmountCentavos !== "number" ||
    !Number.isFinite(payload.refundAmountCentavos) ||
    payload.refundAmountCentavos <= 0
  ) {
    return decisionRefuse(refuseRefundAmountInvalid(payload.refundAmountCentavos), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        reason: "refund_amount_invalid",
        amount: payload.refundAmountCentavos,
      }),
    ])
  }

  // Cross-check the snapshot in the payload against the state. If they
  // diverge (concurrent partial refund), refuse so the operator
  // re-opens the route with a fresh snapshot.
  const stateRefunded = state.ctx.refundedAmountCentavos ?? 0
  if (
    typeof payload.currentRefundedCentavos === "number" &&
    payload.currentRefundedCentavos !== stateRefunded
  ) {
    return decisionRefuse(
      refundStateDivergent(payload.currentRefundedCentavos, stateRefunded),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          reason: "refund_state_divergent",
          envelope: payload.currentRefundedCentavos,
          state: stateRefunded,
        }),
      ],
    )
  }

  const refundable = payload.refundableBalanceCentavos
  if (
    typeof refundable === "number" &&
    payload.refundAmountCentavos > refundable
  ) {
    return decisionRefuse(
      refuseRefundOverBalance(payload.refundAmountCentavos, refundable),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          reason: "refund_over_balance",
          amount: payload.refundAmountCentavos,
          refundable,
        }),
      ],
    )
  }

  const escalateThreshold = getRefundEscalateThresholdCentavos()
  const confirmThreshold = getRefundConfirmThresholdCentavos()
  // FE-D07: the EXECUTE / CONFIRM / ESCALATE band mapping is single-sourced
  // in `@ibatexas/types.classifyRefundMagnitudeBand` and shared byte-for-byte
  // with the domain admin-HTTP bundle (`paymentProjectionPolicyBundle`), so
  // the money bands can never fork by channel again (the FE-T03 lockstep pair
  // is now ONE comparator). FE-T03/D2 lives inside that helper: escalate uses
  // `>=` (`isAtOrAboveMoneyBand`), so an exact R$1000 (100_000 centavos)
  // refund ESCALATEs instead of parking at REQUEST_CONFIRMATION — see
  // refund-magnitude-ladder.test.ts, conformance.test.ts, and the cross-bundle
  // parity pin in apps/api (refund-band-channel-parity.test.ts). The
  // channel-specific overlays below (AUT-017 owner-approval, BKL-085 UNTRUSTED
  // taint) stay ordered exactly as before around the shared band.
  const band = classifyRefundMagnitudeBand(
    payload.refundAmountCentavos,
    confirmThreshold,
    escalateThreshold,
  )

  if (band === "ESCALATE") {
    // ── AUT-017 — ESCALATE→OWNER-approve→executable-resume overlay ──────────
    //
    // When (and ONLY when) an OWNER has approved THIS exact escalated refund
    // out-of-band, the resume path re-projects the fresh PaymentState and stamps
    // `state.ctx.escalationApproval`. The marker converts the escalate band's OWN
    // ESCALATE into a REQUEST_CONFIRMATION, which the paired `confirmationReceipt`
    // (same `intentHash`) then flips to EXECUTE via the kernel's 2a override. The
    // conditions are ALL structural:
    //   - `intentHash === envelope.intentHash` — the approval is for THIS envelope,
    //     not a replay onto a different one (the marker rides state, but this ties
    //     it to the exact adjudicated intent).
    //   - `approverRole === "OWNER"` — only the owner approves an escalated refund
    //     (a MANAGER-approver marker leaves the ESCALATE intact).
    //   - `approverId !== payload.actorId` — SEPARATION OF DUTY: the approver may
    //     NOT be the staff member who PROPOSED the refund (the ops resolver stamps
    //     the proposer's staffId onto `payload.actorId`). A self-approval marker
    //     leaves the ESCALATE intact. This is the deepest self-approve gate (the
    //     resolve route + module refuse a self-approval earlier, but even a slipped
    //     one cannot convert the verdict here).
    // The marker is ABSENT on every ordinary turn ⟹ byte-identical ESCALATE. This
    // overlay is MONOTONIC — it converts only the escalate band's own ESCALATE, and
    // only DOWN to REQUEST_CONFIRMATION (friction), never rescuing a REFUSE. A
    // receipt-less conversion stops at REQUEST_CONFIRMATION (the operator still
    // confirms) — friction, never a bypass.
    const approval = state.ctx.escalationApproval
    if (
      approval !== undefined &&
      approval.intentHash === envelope.intentHash &&
      approval.approverRole === "OWNER" &&
      approval.approverId !== payload.actorId
    ) {
      const reais = (payload.refundAmountCentavos / 100)
        .toFixed(2)
        .replace(".", ",")
      return decisionRequestConfirmation(
        `Reembolso de R$ ${reais} aprovado por ${approval.approverId}. Confirmar execução?`,
        [
          basis("business", BASIS_CODES.business.RULE_SATISFIED, {
            reason: "refund_escalation_approved",
            approvedBy: approval.approverId,
            approverRole: approval.approverRole,
            escalateThreshold,
            amount: payload.refundAmountCentavos,
          }),
        ],
      )
    }
    return decisionEscalate("human", "refund_above_escalate_threshold", [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        reason: "refund_above_escalate_threshold",
        amount: payload.refundAmountCentavos,
        escalateThreshold,
      }),
    ])
  }

  // ── BKL-085 — UNTRUSTED-taint refund CONFIRM overlay ────────────────────
  //
  // A model-PARSED refund (`taint === "UNTRUSTED"` — the ops-actor persona
  // extracted the amount from a staff message) must ALWAYS be human-confirmed
  // regardless of the amount band, because a misparse ("cinquenta" → 5000 vs
  // 50000, or a wrong order) sends REAL money the wrong way. This overlay fires
  // for exactly the model-authored refunds:
  //
  //   - It is ORDERED AFTER the ESCALATE band above so a ≥ escalate-threshold
  //     LLM refund still ESCALATEs (escalate pre-empts — the overlay NEVER
  //     downgrades a >R$1000 model refund to a self-confirmable one).
  //   - It is ORDERED BEFORE the medium-CONFIRM/EXECUTE bands below so an
  //     UNTRUSTED refund at ANY sub-escalate amount (including ≤ the confirm
  //     threshold, which the TRUSTED path EXECUTEs directly) parks for
  //     confirmation instead.
  //   - It keys on `taint`, so the TRUSTED admin-HTTP refund path
  //     (`principalFor` stamps `taint: "TRUSTED"` after `requireManagerRole`)
  //     is UNTOUCHED — honest taint provenance semantics, no band weakened. A
  //     SYSTEM-tainted refund (webhook/reconcile) is likewise untouched.
  //
  // The over-balance / amount-invalid / state-divergent REFUSEs above still
  // pre-empt this overlay (a forgeable-balance or nonsensical refund REFUSEs
  // before it could ever park). The prompt states the parsed amount + the
  // payment reference so the staff confirms the NUMBERS, not just the intent.
  if (envelope.taint === "UNTRUSTED") {
    const reais = (payload.refundAmountCentavos / 100)
      .toFixed(2)
      .replace(".", ",")
    return decisionRequestConfirmation(
      `Confirmar reembolso de R$ ${reais} do pagamento ${payload.paymentId}? Responda "sim" para confirmar.`,
      [
        basis("business", BASIS_CODES.business.RULE_SATISFIED, {
          reason: "refund_untrusted_requires_confirmation",
          amount: payload.refundAmountCentavos,
          taint: envelope.taint,
        }),
      ],
    )
  }

  if (band === "CONFIRM") {
    const reais = (payload.refundAmountCentavos / 100)
      .toFixed(2)
      .replace(".", ",")
    return decisionRequestConfirmation(
      `Confirmar reembolso de R$ ${reais}? Esta ação envia dinheiro de volta ao cliente.`,
      [
        basis("business", BASIS_CODES.business.RULE_SATISFIED, {
          reason: "refund_within_confirm_band",
          amount: payload.refundAmountCentavos,
          confirmThreshold,
          escalateThreshold,
        }),
      ],
    )
  }

  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
      amount: payload.refundAmountCentavos,
    }),
  ])
}

/**
 * W3 P0-2 — PIX regeneration count cap guard (migrated from
 * `paymentProjectionPolicyBundle`).
 *
 * Refuses regenerations above `getMaxPixRegenerationsPerPayment()`. The
 * current count is read from the projection state (auth source) and
 * validated against the payload's `currentRegenerationCount` snapshot.
 */
const regenerationCountCapGuard: PaymentGuard = (envelope, state) => {
  if (envelope.kind !== "payment.pix.regenerate") return null
  const payload = envelope.payload as PaymentPixRegeneratePayload

  const stateCount = state.ctx.regenerationCount ?? 0
  if (
    typeof payload.currentRegenerationCount === "number" &&
    payload.currentRegenerationCount !== stateCount
  ) {
    return decisionRefuse(
      refuseRegenerationStateDivergent(
        payload.currentRegenerationCount,
        stateCount,
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          reason: "regen_state_divergent",
          envelope: payload.currentRegenerationCount,
          state: stateCount,
        }),
      ],
    )
  }

  const cap = getMaxPixRegenerationsPerPayment()
  if (stateCount + 1 > cap) {
    return decisionRefuse(refuseRegenerationCapExceeded(stateCount, cap), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        reason: "regen_cap_exceeded",
        current: stateCount,
        cap,
      }),
    ])
  }

  return null
}

/**
 * Daily retry cap guard for `payment.retry`. Refuses retries above
 * `getMaxPaymentRetriesPerDay()` (default 3). The counter is projected
 * by the adopter from Redis (key `payment-retry:{customerId}:{YYYY-MM-DD}`).
 */
const retryDailyCapGuard: PaymentGuard = (envelope, state) => {
  if (envelope.kind !== "payment.retry") return null
  const payload = envelope.payload as PaymentRetryPayload
  void payload

  const cap = getMaxPaymentRetriesPerDay()
  const current = state.ctx.dailyRetryCount ?? 0
  if (current + 1 > cap) {
    return decisionRefuse(refuseRetryCapExceeded(current, cap), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        reason: "retry_cap_exceeded",
        current,
        cap,
      }),
    ])
  }
  return null
}

/**
 * `payment.dispute.open` always escalates — Stripe chargeback events
 * are too serious to auto-process. The route layer logs the dispute,
 * notifies ops, and freezes the order until a human resolves.
 */
const escalateAlwaysOnDispute: PaymentGuard = (envelope) => {
  if (envelope.kind !== "payment.dispute.open") return null
  return decisionEscalate("human", "dispute_opened_requires_review", [
    basis("business", BASIS_CODES.business.RULE_VIOLATED, {
      reason: "dispute_opened",
      kind: envelope.kind,
    }),
  ])
}

/**
 * `payment.waive` always requests confirmation — irreversible debt
 * forgiveness must be intentional.
 */
const confirmAlwaysOnWaive: PaymentGuard = (envelope) => {
  if (envelope.kind !== "payment.waive") return null
  return decisionRequestConfirmation(
    "Confirmar perdão de pagamento? Esta ação não pode ser desfeita.",
    [
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        reason: "waive_requires_confirmation",
        kind: envelope.kind,
      }),
    ],
  )
}

/**
 * `payment.status.force` always requests confirmation — admin
 * override of state machine; should be intentional.
 */
const confirmAlwaysOnStatusForce: PaymentGuard = (envelope) => {
  if (envelope.kind !== "payment.status.force") return null
  return decisionRequestConfirmation(
    "Confirmar alteração manual de status do pagamento?",
    [
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        reason: "status_force_requires_confirmation",
        kind: envelope.kind,
      }),
    ],
  )
}

// ── EXECUTE producers (default is REFUSE; positive matches required) ────

/**
 * Each happy-path kind needs an explicit EXECUTE guard because the
 * Pack's default is REFUSE.
 */
const executeAll: PaymentGuard = (envelope) => {
  switch (envelope.kind) {
    case "payment.create":
    case "payment.pix.regenerate":
    case "payment.method.switch":
    case "payment.retry":
    case "payment.refund.confirm":
    case "payment.cash.confirm":
    case "payment.status.transition":
    case "payment.status.reconcile":
      return decisionExecute([
        basis("business", BASIS_CODES.business.RULE_SATISFIED, {
          kind: envelope.kind,
        }),
      ])
    default:
      return null
  }
}

// ── PolicyBundle ────────────────────────────────────────────────────────

/**
 * The payment-domain PolicyBundle. Feed to `adjudicate()` from
 * `@adjudicate/core/kernel` to decide whether to execute a proposed
 * envelope. Default is REFUSE — any kind not covered by an explicit
 * EXECUTE guard is denied by construction.
 *
 * Phase order is fixed by the kernel: `state → taint → auth →
 * business → default`. Within each phase, guards run in declared
 * order; the FIRST non-null decision wins.
 *
 * # Guard ordering rationale
 *
 *   state:
 *     1. requirePaymentExists           — short-circuit if no projection
 *     2. refuseTerminalTransition       — block resurrecting terminal
 *
 *   auth: (none — auth is at the route layer)
 *
 *   taint: paymentsTaintPolicy (system-only kinds gated)
 *
 *   business:
 *     1. validateCreateMethod           — shape check create kinds
 *     2. validateMethodSwitch           — shape check switch kind
 *     3. refundPaymentStateRefundableGuard — D1 conjunct: state-refundable
 *     4. refundEligibilityGuard         — D1 conjunct: not-already-refunded
 *     5. refundFreshnessGuard           — D1 conjunct: read-live-this-turn
 *     6. refundMagnitudeGuard           — refund ladder (W3 P0-1; Inv 11 bands)
 *     7. regenerationCountCapGuard      — PIX regen cap (W3 P0-2)
 *     8. retryDailyCapGuard             — retry rate limit
 *     9. escalateAlwaysOnDispute        — disputes always ESCALATE
 *    10. confirmAlwaysOnWaive           — waive always REQUEST_CONFIRMATION
 *    11. confirmAlwaysOnStatusForce     — force-status always confirm
 *    12. executeAll                     — EXECUTE producers
 *
 *   D1 (Inv 11 strengthen): guards 3-5 gate the refund verdict on the three
 *   non-ownership conjuncts (ownership is the AUTH-phase `enforcePaymentOwnership`).
 *   They run BEFORE the magnitude ladder and are inert unless the host injected
 *   `state.authority`; they NEVER alter the amount-band verdict (that stays #6).
 */
export const paymentsPolicyBundle: PolicyBundle<
  PaymentIntentKind,
  PaymentPayload,
  PaymentState
> = {
  stateGuards: [requirePaymentExists, refuseTerminalTransition],
  authGuards: [requireTenantBindingGuard, enforcePaymentOwnership],
  taint: paymentsTaintPolicy,
  business: [
    validateCreateMethod,
    validateMethodSwitch,
    // D1 — the three non-ownership conjuncts of the refund-authority invariant,
    // BEFORE the magnitude ladder so a non-refundable / already-refunded / stale
    // refund REFUSEs before any amount band could EXECUTE. Inert unless the host
    // injected state.authority (the 4-conjunct enforcement seam).
    refundPaymentStateRefundableGuard,
    refundEligibilityGuard,
    refundFreshnessGuard,
    refundMagnitudeGuard,
    regenerationCountCapGuard,
    retryDailyCapGuard,
    escalateAlwaysOnDispute,
    confirmAlwaysOnWaive,
    confirmAlwaysOnStatusForce,
    executeAll,
  ],
  /**
   * Fail-safe per master plan §"Governance principles" #4 — an intent
   * that no positive guard matched is REFUSEd.
   */
  default: "REFUSE",
}

// ── Re-exports for adopter convenience ──────────────────────────────────

export { refuseDefault }
