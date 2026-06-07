/**
 * @ibatexas/pack-payments — conformance test.
 *
 * Two-part:
 *
 *   1. Corpus of 30+ envelope+state fixtures covering EXECUTE,
 *      REFUSE, DEFER, REWRITE, REQUEST_CONFIRMATION, and ESCALATE
 *      outcomes across the Pack's intent kinds. Each fixture asserts
 *      the expected Decision shape against `paymentsPack.policy`.
 *
 *   2. Kernel-invariant suite — `runConformance(paymentsPack)` from
 *      `@adjudicate/conformance` verifies taint protection, replay
 *      determinism, intent-hash determinism, basis-vocabulary purity,
 *      guard ordering, and default polarity hold for the Pack.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import { runConformance } from "@adjudicate/conformance"
import { analyzePolicy, type PlannerProbe } from "@adjudicate/analyze"
import {
  paymentsPack,
  type PaymentContext,
  type PaymentIntentKind,
  type PaymentPayload,
  type PaymentState,
} from "../index.js"

const DET_TIME = "2026-05-22T12:00:00.000Z"

function env(
  kind: PaymentIntentKind,
  payload: Record<string, unknown>,
  taint: "SYSTEM" | "TRUSTED" | "UNTRUSTED" = "SYSTEM",
): IntentEnvelope<PaymentIntentKind, PaymentPayload> {
  return buildEnvelope({
    kind,
    payload: payload as unknown as PaymentPayload,
    actor: { principal: "system", sessionId: "s-1" },
    taint,
    nonce: "n-test",
    createdAt: DET_TIME,
  })
}

function existsState(overrides: Partial<PaymentState["ctx"]> = {}): PaymentState {
  return {
    ctx: {
      actor: { principal: "system" },
      exists: true,
      currentStatus: "pending",
      currentMethod: "pix",
      version: 1,
      orderId: "ord-1",
      isTerminal: false,
      refundedAmountCentavos: 0,
      amountInCentavos: 50_000,
      regenerationCount: 0,
      dailyRetryCount: 0,
      ...overrides,
    },
  }
}

function freshState(overrides: Partial<PaymentState["ctx"]> = {}): PaymentState {
  return {
    ctx: {
      actor: { principal: "system" },
      exists: false,
      ...overrides,
    },
  }
}

// ── Corpus ──────────────────────────────────────────────────────────────

type Fixture = {
  readonly name: string
  readonly envelope: IntentEnvelope<PaymentIntentKind, PaymentPayload>
  readonly state: PaymentState
  readonly expect: {
    readonly kind:
      | "EXECUTE"
      | "REFUSE"
      | "DEFER"
      | "REWRITE"
      | "REQUEST_CONFIRMATION"
      | "ESCALATE"
    readonly refusalCode?: string
    readonly signal?: string
    readonly escalateTo?: "human" | "supervisor"
  }
}

const corpus: ReadonlyArray<Fixture> = [
  // ── EXECUTE (12 cases) ────────────────────────────────────────────────
  {
    name: "EXECUTE: payment.create (SYSTEM) — valid PIX",
    envelope: env("payment.create", {
      orderId: "ord-1",
      method: "pix",
      amountInCentavos: 50_000,
    }),
    state: freshState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.charge.create (SYSTEM) — valid card",
    envelope: env("payment.charge.create", {
      orderId: "ord-1",
      method: "card",
      amountInCentavos: 25_000,
    }),
    state: freshState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.charge.confirm (SYSTEM) — Stripe webhook",
    envelope: env("payment.charge.confirm", {
      orderId: "ord-1",
      paymentId: "pay-1",
      wireStatus: "succeeded",
      stripeEventId: "evt_1",
    }),
    state: existsState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.charge.fail (SYSTEM) — Stripe webhook",
    envelope: env("payment.charge.fail", {
      orderId: "ord-1",
      paymentId: "pay-1",
      reason: "card_declined",
    }),
    state: existsState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.charge.expire (SYSTEM) — PIX expiry",
    envelope: env("payment.charge.expire", {
      paymentId: "pay-1",
      reason: "pix_expired",
    }),
    state: existsState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.charge.cancel (SYSTEM) — Stripe webhook",
    envelope: env("payment.charge.cancel", {
      paymentId: "pay-1",
      reason: "user_request",
    }),
    state: existsState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.pix.regenerate (UNTRUSTED) — within cap",
    envelope: env(
      "payment.pix.regenerate",
      {
        orderId: "ord-1",
        paymentId: "pay-1",
        currentRegenerationCount: 0,
      },
      "UNTRUSTED",
    ),
    state: existsState({ regenerationCount: 0 }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.method.switch (UNTRUSTED) — pix→card",
    envelope: env(
      "payment.method.switch",
      {
        orderId: "ord-1",
        fromMethod: "pix",
        toMethod: "card",
        customerId: "cust-1",
      },
      "UNTRUSTED",
    ),
    state: existsState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.retry (UNTRUSTED) — within daily cap",
    envelope: env(
      "payment.retry",
      {
        orderId: "ord-1",
        previousPaymentId: "pay-1",
      },
      "UNTRUSTED",
    ),
    state: existsState({ dailyRetryCount: 0 }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: small refund (≤ R$500)",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: 20_000,
      refundableBalanceCentavos: 50_000,
      amountInCentavos: 50_000,
      currentRefundedCentavos: 0,
      actor: "admin",
      actorId: "staff-1",
    }, "TRUSTED"),
    state: existsState({ refundedAmountCentavos: 0 }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.refund.confirm (SYSTEM) — Stripe webhook",
    envelope: env("payment.refund.confirm", {
      paymentId: "pay-1",
      wireStatus: "succeeded",
      stripeEventId: "evt_1",
    }),
    state: existsState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.cash.confirm (TRUSTED) — staff at counter",
    envelope: env("payment.cash.confirm", {
      orderId: "ord-1",
      paymentId: "pay-1",
      amountCentavos: 50_000,
      staffId: "staff-1",
    }, "TRUSTED"),
    state: existsState({ currentMethod: "cash" }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.status.transition (TRUSTED) — admin advance",
    envelope: env("payment.status.transition", {
      paymentId: "pay-1",
      newStatus: "paid",
      actor: "admin",
      actorId: "staff-1",
    }, "TRUSTED"),
    state: existsState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: payment.status.reconcile (SYSTEM) — Stripe webhook",
    envelope: env("payment.status.reconcile", {
      paymentId: "pay-1",
      newStatus: "paid",
      stripeEventId: "evt_1",
    }),
    state: existsState({ isTerminal: true, currentStatus: "paid" }),
    expect: { kind: "EXECUTE" },
  },

  // ── REFUSE (10 cases) ────────────────────────────────────────────────
  {
    name: "REFUSE: payment.refund.issue on missing payment",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: 20_000,
      refundableBalanceCentavos: 50_000,
      amountInCentavos: 50_000,
      currentRefundedCentavos: 0,
      actor: "admin",
    }, "TRUSTED"),
    state: freshState(),
    expect: { kind: "REFUSE", refusalCode: "payment.not_found" },
  },
  {
    name: "REFUSE: payment.refund.issue on terminal payment",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: 20_000,
      refundableBalanceCentavos: 50_000,
      amountInCentavos: 50_000,
      currentRefundedCentavos: 0,
      actor: "admin",
    }, "TRUSTED"),
    state: existsState({ isTerminal: true, currentStatus: "refunded" }),
    expect: { kind: "REFUSE", refusalCode: "payment.terminal_state" },
  },
  {
    name: "REFUSE: payment.status.transition on terminal payment",
    envelope: env("payment.status.transition", {
      paymentId: "pay-1",
      newStatus: "paid",
      actor: "admin",
    }, "TRUSTED"),
    state: existsState({ isTerminal: true, currentStatus: "refunded" }),
    expect: { kind: "REFUSE", refusalCode: "payment.terminal_state" },
  },
  {
    name: "REFUSE: payment.refund.issue with non-positive amount",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: -100,
      refundableBalanceCentavos: 50_000,
      amountInCentavos: 50_000,
      currentRefundedCentavos: 0,
      actor: "admin",
    }, "TRUSTED"),
    state: existsState({ refundedAmountCentavos: 0 }),
    expect: { kind: "REFUSE", refusalCode: "refund.amount_invalid" },
  },
  {
    name: "REFUSE: payment.refund.issue over refundable balance",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: 60_000,
      refundableBalanceCentavos: 50_000,
      amountInCentavos: 50_000,
      currentRefundedCentavos: 0,
      actor: "admin",
    }, "TRUSTED"),
    state: existsState({ refundedAmountCentavos: 0 }),
    expect: { kind: "REFUSE", refusalCode: "refund.amount_invalid" },
  },
  {
    name: "REFUSE: payment.refund.issue with divergent state (concurrent partial refund)",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: 10_000,
      refundableBalanceCentavos: 50_000,
      amountInCentavos: 50_000,
      currentRefundedCentavos: 0,
      actor: "admin",
    }, "TRUSTED"),
    state: existsState({ refundedAmountCentavos: 25_000 }),
    expect: { kind: "REFUSE", refusalCode: "refund.state_divergent" },
  },
  {
    name: "REFUSE: payment.pix.regenerate at cap",
    envelope: env(
      "payment.pix.regenerate",
      {
        orderId: "ord-1",
        paymentId: "pay-1",
        currentRegenerationCount: 5,
      },
      "UNTRUSTED",
    ),
    state: existsState({ regenerationCount: 5 }),
    expect: { kind: "REFUSE", refusalCode: "regeneration.cap_exceeded" },
  },
  {
    name: "REFUSE: payment.retry at daily cap",
    envelope: env(
      "payment.retry",
      {
        orderId: "ord-1",
        previousPaymentId: "pay-1",
      },
      "UNTRUSTED",
    ),
    state: existsState({ dailyRetryCount: 3 }),
    expect: { kind: "REFUSE", refusalCode: "retry.cap_exceeded" },
  },
  {
    name: "REFUSE: payment.method.switch with same method",
    envelope: env(
      "payment.method.switch",
      {
        orderId: "ord-1",
        fromMethod: "pix",
        toMethod: "pix",
        customerId: "cust-1",
      },
      "UNTRUSTED",
    ),
    state: existsState(),
    expect: { kind: "REFUSE", refusalCode: "payment.method.same" },
  },
  {
    name: "REFUSE: payment.create with invalid method",
    envelope: env("payment.create", {
      orderId: "ord-1",
      method: "crypto" as "pix",
      amountInCentavos: 50_000,
    }),
    state: freshState(),
    expect: { kind: "REFUSE", refusalCode: "payment.method.invalid" },
  },
  {
    name: "REFUSE: payment.create with non-positive amount",
    envelope: env("payment.create", {
      orderId: "ord-1",
      method: "pix",
      amountInCentavos: 0,
    }),
    state: freshState(),
    expect: { kind: "REFUSE", refusalCode: "payment.amount_invalid" },
  },
  {
    name: "REFUSE: UNTRUSTED payment.create (taint gate)",
    envelope: env(
      "payment.create",
      {
        orderId: "ord-1",
        method: "pix",
        amountInCentavos: 50_000,
      },
      "UNTRUSTED",
    ),
    state: freshState(),
    expect: { kind: "REFUSE" },
  },

  // ── REQUEST_CONFIRMATION (5 cases) ────────────────────────────────────
  {
    name: "REQUEST_CONFIRMATION: medium refund (R$500 < x ≤ R$1000)",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: 75_000,
      refundableBalanceCentavos: 100_000,
      amountInCentavos: 100_000,
      currentRefundedCentavos: 0,
      actor: "admin",
    }, "TRUSTED"),
    state: existsState({ refundedAmountCentavos: 0, amountInCentavos: 100_000 }),
    expect: { kind: "REQUEST_CONFIRMATION" },
  },
  {
    name: "REQUEST_CONFIRMATION: refund just above R$500 threshold",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: 50_001,
      refundableBalanceCentavos: 100_000,
      amountInCentavos: 100_000,
      currentRefundedCentavos: 0,
      actor: "admin",
    }, "TRUSTED"),
    state: existsState({ refundedAmountCentavos: 0, amountInCentavos: 100_000 }),
    expect: { kind: "REQUEST_CONFIRMATION" },
  },
  {
    name: "REQUEST_CONFIRMATION: payment.waive (always)",
    envelope: env("payment.waive", {
      paymentId: "pay-1",
      reason: "customer hardship",
      adminId: "staff-1",
    }, "TRUSTED"),
    state: existsState(),
    expect: { kind: "REQUEST_CONFIRMATION" },
  },
  {
    name: "REQUEST_CONFIRMATION: payment.status.force (always)",
    envelope: env("payment.status.force", {
      paymentId: "pay-1",
      newStatus: "paid",
      reason: "manual override",
      adminId: "staff-1",
    }, "TRUSTED"),
    state: existsState(),
    expect: { kind: "REQUEST_CONFIRMATION" },
  },
  {
    name: "REQUEST_CONFIRMATION: medium refund at R$1000 threshold",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: 100_000,
      refundableBalanceCentavos: 200_000,
      amountInCentavos: 200_000,
      currentRefundedCentavos: 0,
      actor: "admin",
    }, "TRUSTED"),
    state: existsState({ refundedAmountCentavos: 0, amountInCentavos: 200_000 }),
    expect: { kind: "REQUEST_CONFIRMATION" },
  },

  // ── ESCALATE (4 cases) ────────────────────────────────────────────────
  {
    name: "ESCALATE: refund above R$1000 escalate threshold",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: 150_000,
      refundableBalanceCentavos: 200_000,
      amountInCentavos: 200_000,
      currentRefundedCentavos: 0,
      actor: "admin",
    }, "TRUSTED"),
    state: existsState({ refundedAmountCentavos: 0, amountInCentavos: 200_000 }),
    expect: { kind: "ESCALATE", escalateTo: "human" },
  },
  {
    name: "ESCALATE: refund just above R$1000",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: 100_001,
      refundableBalanceCentavos: 200_000,
      amountInCentavos: 200_000,
      currentRefundedCentavos: 0,
      actor: "admin",
    }, "TRUSTED"),
    state: existsState({ refundedAmountCentavos: 0, amountInCentavos: 200_000 }),
    expect: { kind: "ESCALATE", escalateTo: "human" },
  },
  {
    name: "ESCALATE: payment.dispute.open (always)",
    envelope: env("payment.dispute.open", {
      paymentId: "pay-1",
      stripeEventId: "evt_1",
    }),
    state: existsState(),
    expect: { kind: "ESCALATE", escalateTo: "human" },
  },
  {
    name: "ESCALATE: large refund with explicit reason",
    envelope: env("payment.refund.issue", {
      paymentId: "pay-1",
      refundAmountCentavos: 500_000,
      refundableBalanceCentavos: 500_000,
      amountInCentavos: 500_000,
      currentRefundedCentavos: 0,
      actor: "admin",
      reason: "fraudulent_charge",
    }, "TRUSTED"),
    state: existsState({
      refundedAmountCentavos: 0,
      amountInCentavos: 500_000,
    }),
    expect: { kind: "ESCALATE", escalateTo: "human" },
  },
]

describe("paymentsPack — corpus (30+ cases across 4 decision kinds)", () => {
  it("corpus is at least 30 cases (acceptance criterion)", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(30)
  })

  for (const fixture of corpus) {
    it(fixture.name, () => {
      const decision = adjudicate(
        fixture.envelope,
        fixture.state,
        paymentsPack.policy,
      )
      expect(decision.kind).toBe(fixture.expect.kind)
      if (fixture.expect.refusalCode && decision.kind === "REFUSE") {
        expect(decision.refusal.code).toBe(fixture.expect.refusalCode)
      }
      if (fixture.expect.signal && decision.kind === "DEFER") {
        expect(decision.signal).toBe(fixture.expect.signal)
      }
      if (fixture.expect.escalateTo && decision.kind === "ESCALATE") {
        expect(decision.to).toBe(fixture.expect.escalateTo)
      }
    })
  }
})

// ── Kernel-invariant suite ──────────────────────────────────────────────

describe("paymentsPack — kernel invariants via runConformance()", () => {
  it("runConformance returns zero failures", () => {
    const report = runConformance(paymentsPack)
    if (!report.passed) {
      for (const r of report.results) {
        if (!r.passed) console.error(`[${r.id}] ${r.name}: ${r.details}`)
      }
    }
    expect(report.passed).toBe(true)
    expect(report.summary.failed).toBe(0)
  })

  it("policy default is REFUSE (default-polarity / bypass-detection)", () => {
    expect(paymentsPack.policy.default).toBe("REFUSE")
  })
})

// ── Tier-3 policy coherence (AJD-301) via analyzePolicy() ───────────────────
//
// F11 gate: the planner must never offer an intent the Pack doesn't declare
// (`phantom_intent`, the only error-severity rule → flips `report.passed`).
// System-only kinds (taint minimum above UNTRUSTED) are intentionally not
// planner-proposable; the analyzer auto-excludes them from `unreachable_intent`
// via `pack.policy.taint.minimumFor`. We pin that carve-out so a future drop of
// `payment.charge.confirm` from the taint policy fails loudly here.
//
// NOTE: we deliberately do NOT assert `summary.warning === 0` — the planner
// omits the many declared, non-system intents (refund.issue, cash.confirm,
// waive, status.force/transition, …) that are reached by webhook / cron / staff
// flows, each a benign `unreachable_intent` warning. `report.passed` stays true
// (error === 0).

describe("paymentsPack — policy coherence via analyzePolicy() (AJD-301)", () => {
  // The payments planner `void`s both `state` and `context` — it returns the
  // same customer-driven `allowedIntents` for every input. We still vary the
  // probe actor (the only meaningful axis) to exercise the planner over the
  // surface a turn would feed it. `context` carries the per-turn actor shape.
  const probes: ReadonlyArray<PlannerProbe<PaymentState, PaymentContext>> = [
    {
      label: "customer-pending-pix",
      state: existsState({ currentStatus: "pending", currentMethod: "pix" }),
      context: { actor: { principal: "user", id: "cust-1" } },
    },
    {
      label: "system-fresh",
      state: freshState(),
      context: { actor: { principal: "system" } },
    },
  ]

  // Derive the system-only set the SAME way the analyzer does (taint minimum),
  // never a hand-list — so this test cannot drift from `paymentsTaintPolicy`.
  const systemOnlyKinds = paymentsPack.intents.filter((k) => {
    const min = paymentsPack.policy.taint.minimumFor(k)
    return min !== undefined && min !== "UNTRUSTED"
  })

  it("planner proposes no phantom intents (report.passed, zero errors)", () => {
    const report = analyzePolicy({ pack: paymentsPack, plannerProbes: probes })
    for (const d of report.diagnostics) {
      if (d.severity === "error") console.error(`[${d.code}] ${d.message}`)
    }
    expect(report.passed).toBe(true)
    expect(report.summary.error).toBe(0)
  })

  it("system-only kinds (payment.charge.confirm, …) are carved out", () => {
    const report = analyzePolicy({ pack: paymentsPack, plannerProbes: probes })
    // Guard against a vacuous pass: the carve-out subject must really be system-only.
    expect(systemOnlyKinds).toContain("payment.charge.confirm")
    for (const kind of systemOnlyKinds) {
      const unreachable = report.diagnostics.find(
        (d) =>
          d.detail?.rule === "unreachable_intent" && d.detail?.intent === kind,
      )
      expect(
        unreachable,
        `${kind} is system-only — must NOT be flagged unreachable`,
      ).toBeUndefined()
      const contradiction = report.diagnostics.find(
        (d) =>
          d.detail?.rule === "system_taint_contradiction" &&
          d.detail?.intent === kind,
      )
      expect(
        contradiction,
        `${kind} is system-only — planner must NOT offer it`,
      ).toBeUndefined()
    }
  })
})
