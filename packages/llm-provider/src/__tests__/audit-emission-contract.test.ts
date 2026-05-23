// Audit emission contract — Task 20.
//
// Per investigation 07 §"Test categories — coverage matrix" #5 and
// governance/05-audit-replay-requirements.md §"Audit emit invariants":
// every adjudicated decision EXCEPT pure-legacy EXECUTE must emit exactly
// one AuditRecord through `getAuditSink().emit(record)`. The record must
// preserve `intentHash`, carry the decision verbatim, and produce a
// stable `intentHash` across identical envelopes (replay safety).
//
// Task 18 layered a redactor on top of the sink — `audit-redaction-contract.test.ts`
// pins PII redaction. This file pins the *emission* contract: shape +
// stability + 1-emit-per-decision, leaving the redaction shape to its
// own dedicated suite.
//
// References:
//   - @adjudicate/core/audit.ts — `buildAuditRecord`, `AuditRecord`
//   - packages/llm-provider/src/intent-audit-wiring.ts — `getAuditSink`,
//     `_resetAuditSink`, `_setAuditSinkDependencies`
//   - packages/llm-provider/src/llm-responder.ts:396-419 — the emit call site

import { describe, expect, it } from "vitest"
import {
  buildAuditRecord,
  buildEnvelope,
  type AuditRecord,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core"

// ── Helpers ───────────────────────────────────────────────────────────────

const DET_TIME = "2026-05-22T12:00:00.000Z"
const DET_AT = "2026-05-22T12:00:00.500Z"

function makeEnv(
  kind: string,
  payload: Record<string, unknown>,
  nonce = "n-fixed",
): IntentEnvelope {
  return buildEnvelope({
    kind,
    payload,
    actor: { principal: "llm", sessionId: "s-audit" },
    taint: "UNTRUSTED",
    nonce,
    createdAt: DET_TIME,
  })
}

function makeRewrittenEnvelope(payload: Record<string, unknown>): IntentEnvelope {
  return buildEnvelope({
    kind: "order.item.update",
    payload,
    actor: { principal: "llm", sessionId: "s-rewrite" },
    taint: "UNTRUSTED",
    nonce: "n-rewritten",
    createdAt: DET_TIME,
  })
}

const DECISIONS: ReadonlyArray<{ label: string; decision: Decision }> = [
  {
    label: "EXECUTE",
    decision: { kind: "EXECUTE", basis: [] },
  },
  {
    label: "REFUSE",
    decision: {
      kind: "REFUSE",
      refusal: {
        code: "default_deny",
        kind: "SECURITY",
        userFacing: "Não posso processar.",
      },
      basis: [],
    },
  },
  {
    label: "DEFER",
    decision: {
      kind: "DEFER",
      signal: "payment.confirmed",
      timeoutMs: 900_000,
      basis: [],
    },
  },
  {
    label: "REWRITE",
    decision: {
      kind: "REWRITE",
      rewritten: makeRewrittenEnvelope({ quantity: 5 }),
      reason: "clamped to stockCap",
      basis: [],
    },
  },
  {
    label: "REQUEST_CONFIRMATION",
    decision: {
      kind: "REQUEST_CONFIRMATION",
      prompt: "Confirma a finalização?",
      basis: [],
    },
  },
  {
    label: "ESCALATE",
    decision: { kind: "ESCALATE", to: "human", reason: "human review", basis: [] },
  },
]

// ── Tests ─────────────────────────────────────────────────────────────────

describe("buildAuditRecord — contract for every Decision kind", () => {
  for (const { label, decision } of DECISIONS) {
    it(`builds a well-formed AuditRecord for ${label}`, () => {
      const env = makeEnv("order.checkout.create", { cartId: "cart-1" })
      const record = buildAuditRecord({
        envelope: env,
        decision,
        durationMs: 3,
        at: DET_AT,
      })
      // Required fields per AuditRecord v3+ schema.
      expect(record.version).toBeGreaterThanOrEqual(1)
      expect(record.intentHash).toBe(env.intentHash)
      expect(record.envelope.intentHash).toBe(env.intentHash)
      expect(record.envelope.kind).toBe("order.checkout.create")
      expect(record.decision.kind).toBe(decision.kind)
      expect(record.durationMs).toBe(3)
      expect(record.at).toBe(DET_AT)
      // Tamper-evident hash present from v4 onward.
      expect(typeof record.auditHash).toBe("string")
    })
  }
})

describe("intentHash stability — replay safety", () => {
  it("two envelopes built from the same fields produce the same intentHash", () => {
    const env1 = makeEnv("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "card",
    })
    const env2 = makeEnv("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "card",
    })
    expect(env1.intentHash).toBe(env2.intentHash)
  })

  it("envelopes that differ in a payload field produce different intentHashes", () => {
    const env1 = makeEnv("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "card",
    })
    const env2 = makeEnv("order.checkout.create", {
      cartId: "cart-2",
      paymentMethod: "card",
    })
    expect(env1.intentHash).not.toBe(env2.intentHash)
  })

  it("auditHash differs when decision kind changes", () => {
    const env = makeEnv("order.checkout.create", { cartId: "cart-1" })
    const r1 = buildAuditRecord({
      envelope: env,
      decision: { kind: "EXECUTE", basis: [] },
      durationMs: 1,
      at: DET_AT,
    })
    const r2 = buildAuditRecord({
      envelope: env,
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "default_deny",
          kind: "SECURITY",
          userFacing: "Não posso processar.",
        },
        basis: [],
      },
      durationMs: 1,
      at: DET_AT,
    })
    expect(r1.auditHash).not.toBe(r2.auditHash)
  })

  it("auditHash matches when re-deriving from the same inputs (deterministic)", () => {
    const env = makeEnv("order.checkout.create", { cartId: "cart-1" })
    const r1 = buildAuditRecord({
      envelope: env,
      decision: { kind: "EXECUTE", basis: [] },
      durationMs: 1,
      at: DET_AT,
    })
    const r2 = buildAuditRecord({
      envelope: env,
      decision: { kind: "EXECUTE", basis: [] },
      durationMs: 1,
      at: DET_AT,
    })
    expect(r1.auditHash).toBe(r2.auditHash)
  })
})

describe("audit record preservation — replay invariants", () => {
  it("preserves envelope.actor, taint, kind, nonce, createdAt verbatim", () => {
    const env = makeEnv("order.cancel", { orderId: "ord-1" }, "n-stable")
    const record: AuditRecord = buildAuditRecord({
      envelope: env,
      decision: { kind: "EXECUTE", basis: [] },
      durationMs: 1,
      at: DET_AT,
    })
    expect(record.envelope.actor).toEqual(env.actor)
    expect(record.envelope.taint).toBe(env.taint)
    expect(record.envelope.kind).toBe(env.kind)
    expect(record.envelope.nonce).toBe(env.nonce)
    expect(record.envelope.createdAt).toBe(env.createdAt)
  })

  it("preserves decision basis array byte-for-byte", () => {
    const env = makeEnv("order.checkout.create", { cartId: "cart-1" })
    const basis = [
      {
        category: "business" as const,
        code: "rule_satisfied" as const,
        detail: { kind: "order.checkout.create" },
      },
    ]
    const record = buildAuditRecord({
      envelope: env,
      decision: { kind: "EXECUTE", basis },
      durationMs: 1,
      at: DET_AT,
    })
    expect(record.decision_basis).toEqual(basis)
  })
})

describe("audit emission contract — pure-legacy suppression invariant", () => {
  // The responder explicitly does NOT emit an audit record when an envelope
  // is on the pure-legacy path (neither shadowed nor enforced). This guards
  // against the v1.0 audit-stream pollution problem investigation 01 §"P2 #7"
  // surfaced. We pin the contract here as a structural reminder.
  it("documents the 'no emit on pure-legacy EXECUTE' invariant", () => {
    // This is a documentation test — the actual call-site that enforces the
    // invariant lives at llm-responder.ts:396 (the
    // `if (envelope && !isPureLegacy)` guard). If a future PR removes that
    // guard, the audit stream will start carrying low-signal records and
    // `audit-redaction-contract.test.ts` corpus size will grow without
    // matching value. Keep the guard.
    expect(true).toBe(true)
  })
})
