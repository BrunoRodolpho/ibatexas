/**
 * @ibatexas/pack-payments — AUT-017 ESCALATE→OWNER-approve→resume overlay.
 *
 * The decision-table for the escalate band's escalation-approval overlay. Proves
 *
 *   1. the overlay converts ESCALATE→REQUEST_CONFIRMATION ONLY for a VALID marker
 *      (present, `intentHash` matches, `approverRole === "OWNER"`, approver ≠
 *      proposer);
 *   2. every malformed / absent / mismatched marker leaves the ESCALATE INTACT
 *      (byte-identical to the pre-AUT-017 band) — marker absent, hash mismatch,
 *      MANAGER approver, self-approval (approverId === payload.actorId);
 *   3. a matching `confirmationReceipt` threaded through `adjudicateAndAudit` then
 *      flips the REQUEST_CONFIRMATION to EXECUTE, with the auto-derived
 *      `confirmation_resolved` supersession carrying the bound `approver`;
 *   4. the marker NEVER rescues an over-balance / state-divergent REFUSE (those
 *      REFUSE bands are ordered before the escalate band).
 *
 * The marker rides STATE (`state.ctx.escalationApproval`), NEVER the payload, so
 * `intentHash` is unchanged — the receipt matches the ordinary-turn hash.
 */

import { describe, expect, it } from "vitest"
import { adjudicate, adjudicateAndAudit } from "@adjudicate/core/kernel"
import {
  buildEnvelope,
  type AuditRecord,
  type AuditSink,
  type IntentEnvelope,
} from "@adjudicate/core"
import {
  paymentsPolicyBundle,
  type PaymentIntentKind,
  type PaymentPayload,
  type PaymentState,
} from "../index.js"

const AT = "2026-07-04T12:00:00.000Z"
const PROPOSER = "owner_proposer"
const APPROVER = "owner_approver"

/** An escalated (>R$1000) UNTRUSTED refund envelope proposed by PROPOSER. */
function escalatedRefundEnv(): IntentEnvelope<PaymentIntentKind, PaymentPayload> {
  return buildEnvelope({
    kind: "payment.refund.issue",
    payload: {
      paymentId: "pay_1",
      refundAmountCentavos: 150_000, // R$1500 > R$1000 escalate threshold
      refundableBalanceCentavos: 500_000,
      amountInCentavos: 500_000,
      currentRefundedCentavos: 0,
      actor: "admin",
      actorId: PROPOSER,
    } as unknown as PaymentPayload,
    actor: { principal: "user", sessionId: `admin:${PROPOSER}`, role: "OWNER" },
    taint: "UNTRUSTED",
    nonce: "n-escalate-approve",
    createdAt: AT,
  })
}

/** Fresh refund state (R$5000 balance, none refunded), optionally with a marker. */
function refundState(
  escalationApproval?: PaymentState["ctx"]["escalationApproval"],
): PaymentState {
  return {
    ctx: {
      actor: { principal: "admin" },
      exists: true,
      isTerminal: false,
      currentStatus: "paid",
      refundedAmountCentavos: 0,
      amountInCentavos: 500_000,
      ...(escalationApproval ? { escalationApproval } : {}),
    },
  }
}

/** A well-formed OWNER approval marker for `env`, by a DIFFERENT owner. */
function validMarker(
  env: IntentEnvelope,
): NonNullable<PaymentState["ctx"]["escalationApproval"]> {
  return {
    intentHash: env.intentHash,
    approverId: APPROVER,
    approverRole: "OWNER",
    at: AT,
  }
}

function makeCapturingSink(): AuditSink & { records: AuditRecord[] } {
  const records: AuditRecord[] = []
  return { emit: async (r: AuditRecord) => void records.push(r), records }
}

describe("AUT-017 escalate-approve overlay — decision table", () => {
  it("marker ABSENT → ESCALATE (byte-identical to the pre-AUT-017 band)", () => {
    const d = adjudicate(escalatedRefundEnv(), refundState(), paymentsPolicyBundle)
    expect(d.kind).toBe("ESCALATE")
    if (d.kind === "ESCALATE") expect(d.to).toBe("human")
  })

  it("marker with a MISMATCHED intentHash → ESCALATE (not this envelope's approval)", () => {
    const env = escalatedRefundEnv()
    const d = adjudicate(
      env,
      refundState({ ...validMarker(env), intentHash: "sha256:not-this-one" }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("ESCALATE")
  })

  it("MANAGER approver marker → ESCALATE (only OWNER approves an escalated refund)", () => {
    const env = escalatedRefundEnv()
    const d = adjudicate(
      env,
      refundState({ ...validMarker(env), approverRole: "MANAGER" }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("ESCALATE")
  })

  it("self-approval (approverId === payload.actorId) → ESCALATE (separation of duty)", () => {
    const env = escalatedRefundEnv()
    const d = adjudicate(
      env,
      refundState({ ...validMarker(env), approverId: PROPOSER }),
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("ESCALATE")
  })

  it("VALID OWNER marker (approver ≠ proposer, hash matches) → REQUEST_CONFIRMATION", () => {
    const env = escalatedRefundEnv()
    const d = adjudicate(env, refundState(validMarker(env)), paymentsPolicyBundle)
    expect(d.kind).toBe("REQUEST_CONFIRMATION")
    if (d.kind !== "REQUEST_CONFIRMATION") return
    // The pt-BR prompt names the amount + the approving owner and asks to confirm.
    expect(d.prompt).toContain("R$ 1500,00")
    expect(d.prompt).toContain(APPROVER)
    expect(d.prompt.toLowerCase()).toContain("confirmar")
  })

  it("VALID marker + matching confirmationReceipt through adjudicateAndAudit → EXECUTE with confirmation_resolved + binding.approver", async () => {
    const env = escalatedRefundEnv()
    const sink = makeCapturingSink()
    const { decision } = await adjudicateAndAudit(
      env,
      refundState(validMarker(env)) as never,
      paymentsPolicyBundle as never,
      {
        sink,
        confirmationReceipt: {
          intentHash: env.intentHash,
          at: AT,
          token: "escalation-park-token-1",
          binding: {
            approver: { confirmed: `staff:${APPROVER}` },
            channel: { confirmed: "admin-dashboard" },
          },
        },
      },
    )
    expect(decision.kind).toBe("EXECUTE")
    // The kernel auto-derived the confirmation_resolved supersession with the
    // forensic (confirmed) approver/channel binding — the lineage of the resume.
    const rec = sink.records.at(-1)!
    expect(rec.supersedes?.reason).toBe("confirmation_resolved")
    expect(rec.supersedes?.token).toBe("escalation-park-token-1")
    expect(rec.supersedes?.binding).toMatchObject({
      approver: `staff:${APPROVER}`,
      channel: "admin-dashboard",
    })
  })

  it("a matching receipt WITHOUT the marker stops at REQUEST_CONFIRMATION only via the taint overlay — the escalate band stays ESCALATE (receipt cannot override ESCALATE)", async () => {
    // Defense: the receipt override fires ONLY on a REQUEST_CONFIRMATION verdict.
    // Without the state marker the escalate band returns ESCALATE, which the
    // kernel returns UNCHANGED even with a receipt present (friction, never bypass).
    const env = escalatedRefundEnv()
    const sink = makeCapturingSink()
    const { decision } = await adjudicateAndAudit(
      env,
      refundState() as never, // NO marker
      paymentsPolicyBundle as never,
      {
        sink,
        confirmationReceipt: {
          intentHash: env.intentHash,
          at: AT,
          token: "escalation-park-token-2",
        },
      },
    )
    expect(decision.kind).toBe("ESCALATE")
  })

  it("the marker NEVER rescues an over-balance REFUSE (REFUSE bands pre-empt the escalate band)", () => {
    const env = buildEnvelope({
      kind: "payment.refund.issue",
      payload: {
        paymentId: "pay_1",
        refundAmountCentavos: 150_000, // R$1500 …
        refundableBalanceCentavos: 10_000, // … but only R$100 refundable
        amountInCentavos: 10_000,
        currentRefundedCentavos: 0,
        actor: "admin",
        actorId: PROPOSER,
      } as unknown as PaymentPayload,
      actor: { principal: "user", sessionId: `admin:${PROPOSER}`, role: "OWNER" },
      taint: "UNTRUSTED",
      nonce: "n-overbalance",
      createdAt: AT,
    })
    const d = adjudicate(
      env,
      {
        ctx: {
          actor: { principal: "admin" },
          exists: true,
          isTerminal: false,
          currentStatus: "paid",
          refundedAmountCentavos: 0,
          amountInCentavos: 10_000,
          escalationApproval: validMarker(env),
        },
      } as PaymentState,
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
  })

  it("the marker NEVER rescues a state-divergent REFUSE", () => {
    const env = escalatedRefundEnv() // payload.currentRefundedCentavos = 0 …
    const d = adjudicate(
      env,
      // … but the live state says 25_000 already refunded → divergence REFUSE.
      {
        ctx: {
          actor: { principal: "admin" },
          exists: true,
          isTerminal: false,
          currentStatus: "paid",
          refundedAmountCentavos: 25_000,
          amountInCentavos: 500_000,
          escalationApproval: validMarker(env),
        },
      } as PaymentState,
      paymentsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
  })
})
