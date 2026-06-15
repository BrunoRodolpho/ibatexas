// T1b-1 — reconciliation gate unit suite (pure: records built via the
// canonical @adjudicate/core builders, no I/O — the same fixture idiom as
// the matcher suite). The live wiring (run-scoped fetch + post-attempt
// verify outcome) lives in harness/run-journey-cli.ts; live validation is
// T1b-0's job.

import { describe, expect, it } from "vitest"
import {
  buildAuditRecord,
  buildEnvelope,
  decisionExecute,
  decisionRefuse,
  decisionRequestConfirmation,
  refuse,
  type AuditRecord,
  type Decision,
} from "@adjudicate/core"
import { reconcileExpects, RECONCILIATION_GATE_ID } from "../reconciliation.js"
import { validateJourney, type JourneyExpect, type JourneyVerify } from "../../schema/index.js"

const BASIS = [{ category: "business", code: "rule_satisfied" }] as const
const T0 = Date.parse("2026-06-12T12:00:00.000Z")
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString()

let nonceSeq = 0
function record(args: {
  kind: string
  decision?: Decision
  at: string
  supersedes?: AuditRecord["supersedes"]
  envelope?: ReturnType<typeof buildEnvelope>
}): AuditRecord {
  const envelope =
    args.envelope ??
    buildEnvelope({
      kind: args.kind,
      payload: {},
      actor: { principal: "user", sessionId: "hashed:t1b1test" },
      taint: "TRUSTED",
      nonce: `t1b1-recon-${nonceSeq++}`,
      createdAt: args.at,
    })
  return buildAuditRecord({
    envelope,
    decision: args.decision ?? decisionExecute([...BASIS]),
    durationMs: 1,
    at: args.at,
    ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
  })
}

// JOURNEY-001-shaped declaration: 3 required expects + 2 optional allowances.
const EXPECTS: JourneyExpect[] = [
  { intentKind: "order.checkout.create", decision: "EXECUTE" },
  { intentKind: "order.cancel", decision: "REQUEST_CONFIRMATION" },
  { intentKind: "order.cancel", decision: "EXECUTE" },
  { intentKind: "order.status.transition", decision: "EXECUTE", optional: true },
  { intentKind: "payment.status.transition", decision: "EXECUTE", optional: true },
]

const VERIFY: JourneyVerify[] = [
  { invariant: "audit.trajectory.in_order" },
  { invariant: "audit.record.verified" },
  { invariant: "order.goal-state", args: { status: "canceled" } },
]

function reconcile(records: AuditRecord[], expects = EXPECTS, verify = VERIFY) {
  return reconcileExpects({ journeyId: "JOURNEY-001", expects, verify, records })
}

// ── Fully explained ──────────────────────────────────────────────────────────

describe("reconcileExpects — fully-explained run", () => {
  it("passes when every observed envelope matches a declared entry (required or optional)", () => {
    const report = reconcile([
      record({ kind: "order.checkout.create", at: at(0) }),
      record({
        kind: "order.cancel",
        decision: decisionRequestConfirmation("Confirma o cancelamento?", [...BASIS]),
        at: at(1),
      }),
      record({ kind: "order.cancel", at: at(2) }),
      record({ kind: "order.status.transition", at: at(3) }),
      record({ kind: "payment.status.transition", at: at(4) }),
    ])
    expect(report.ok).toBe(true)
    expect(report.failures).toEqual([])
    expect(report.unexplained).toEqual([])
    expect(report.observed).toHaveLength(5)
    expect(report.observed.map((o) => o.explanation)).toEqual([
      "expected",
      "expected",
      "expected",
      "optional",
      "optional",
    ])
    // Each observed record points back at its explaining expects[] index.
    expect(report.observed.map((o) => o.expectIndex)).toEqual([0, 1, 2, 3, 4])
    expect(report.unobservedRequired).toEqual([])
    expect(report.report).toContain("reconciliation OK (JOURNEY-001)")
  })

  it("one entry explains every observed record sharing its tuple (re-parked confirm gate)", () => {
    const report = reconcile([
      record({ kind: "order.checkout.create", at: at(0) }),
      record({
        kind: "order.cancel",
        decision: decisionRequestConfirmation("Confirma?", [...BASIS]),
        at: at(1),
      }),
      record({
        kind: "order.cancel",
        decision: decisionRequestConfirmation("Confirma mesmo?", [...BASIS]),
        at: at(2),
      }),
      record({ kind: "order.cancel", at: at(3) }),
    ])
    expect(report.ok).toBe(true)
    expect(report.expected[1]).toMatchObject({
      intentKind: "order.cancel",
      decision: "REQUEST_CONFIRMATION",
      observedCount: 2,
    })
  })
})

// ── Unexplained envelope = drift, not pass ───────────────────────────────────

describe("reconcileExpects — unexplained envelope", () => {
  it("fails with unexplained_envelope when an observed record matches no entry", () => {
    const report = reconcile([
      record({ kind: "order.checkout.create", at: at(0) }),
      record({
        kind: "order.cancel",
        decision: decisionRequestConfirmation("Confirma?", [...BASIS]),
        at: at(1),
      }),
      record({ kind: "order.cancel", at: at(2) }),
      // Drift: an envelope the journey never declared.
      record({ kind: "loyalty.points.adjust", at: at(3) }),
    ])
    expect(report.ok).toBe(false)
    expect(report.failures.map((f) => f.code)).toEqual(["unexplained_envelope"])
    expect(report.unexplained).toHaveLength(1)
    expect(report.unexplained[0]).toMatchObject({
      intentKind: "loyalty.points.adjust",
      decision: "EXECUTE",
      explanation: "unexplained",
    })
    expect(report.report).toContain("reconciliation FAILED (JOURNEY-001)")
    expect(report.report).toContain("loyalty.points.adjust/EXECUTE")
    expect(report.report).toContain("UNEXPLAINED")
  })

  it("a declared kind with an UNDECLARED decision is still unexplained (tuple match)", () => {
    const report = reconcile([
      record({ kind: "order.checkout.create", at: at(0) }),
      record({ kind: "order.cancel", at: at(1) }),
      // Declared kind, undeclared decision: REFUSE was never expected.
      record({
        kind: "order.checkout.create",
        decision: decisionRefuse(
          refuse("BUSINESS_RULE", "replay_suppressed", "Pedido já processado."),
          [{ category: "ledger", code: "replay_suppressed" }],
        ),
        at: at(2),
      }),
    ])
    expect(report.ok).toBe(false)
    expect(report.failures.map((f) => f.code)).toEqual(["unexplained_envelope"])
    expect(report.unexplained[0]).toMatchObject({
      intentKind: "order.checkout.create",
      decision: "REFUSE",
    })
  })
})

// ── Fixture-act governance: no fixture-forged assertions ─────────────────────

describe("reconcileExpects — fixture-forged assertion", () => {
  it("fails with the named error when verify[] asserts state but NO envelope was audited", () => {
    const report = reconcile([])
    expect(report.ok).toBe(false)
    expect(report.failures.map((f) => f.code)).toContain("fixture_forged_assertion")
    expect(report.failures.find((f) => f.code === "fixture_forged_assertion")?.message).toContain(
      "order.goal-state",
    )
  })

  it("fails when audited decisions exist but none could have produced state (no EXECUTE/REWRITE)", () => {
    const report = reconcile([
      record({
        kind: "order.cancel",
        decision: decisionRequestConfirmation("Confirma?", [...BASIS]),
        at: at(0),
      }),
    ])
    expect(report.ok).toBe(false)
    expect(report.failures.map((f) => f.code)).toContain("fixture_forged_assertion")
  })

  it("does not fire for audit-only verify[] (the trail IS the assertion target)", () => {
    const report = reconcile(
      [],
      [{ intentKind: "order.checkout.create", decision: "EXECUTE" }],
      [{ invariant: "audit.trajectory.in_order" }, { invariant: "audit.record.verified" }],
    )
    // No state asserted, nothing observed: the missing required expect is the
    // trajectory matcher's failure, not reconciliation's.
    expect(report.ok).toBe(true)
    expect(report.unobservedRequired).toEqual([
      { intentKind: "order.checkout.create", decision: "EXECUTE", expectIndex: 0 },
    ])
  })
})

// ── Optional allowances tolerated when absent ────────────────────────────────

describe("reconcileExpects — optional expects", () => {
  it("tolerates declared optional entries that never appear", () => {
    const report = reconcile([
      record({ kind: "order.checkout.create", at: at(0) }),
      record({
        kind: "order.cancel",
        decision: decisionRequestConfirmation("Confirma?", [...BASIS]),
        at: at(1),
      }),
      record({ kind: "order.cancel", at: at(2) }),
      // Neither optional transition row landed — must still pass.
    ])
    expect(report.ok).toBe(true)
    expect(report.expected[3]).toMatchObject({ optional: true, observedCount: 0 })
    expect(report.expected[4]).toMatchObject({ optional: true, observedCount: 0 })
    // Absent optionals are NOT unobservedRequired (matcher never wants them).
    expect(report.unobservedRequired).toEqual([])
    expect(report.report).toContain("[optional] — absent (tolerated)")
  })

  it("required entries absent are informational only — the trajectory matcher owns that failure", () => {
    const report = reconcile([
      record({ kind: "order.checkout.create", at: at(0) }),
      record({ kind: "order.cancel", at: at(1) }),
      // REQUEST_CONFIRMATION (required) missing; state EXECUTEs present.
    ])
    expect(report.ok).toBe(true)
    expect(report.unobservedRequired).toEqual([
      { intentKind: "order.cancel", decision: "REQUEST_CONFIRMATION", expectIndex: 1 },
    ])
  })
})

// ── Supersession resolution (same final-state view as the matcher) ───────────

describe("reconcileExpects — supersession resolution", () => {
  it("superseded intermediates need no allowance — chain heads are reconciled", () => {
    const checkoutEnvelope = buildEnvelope({
      kind: "order.checkout.create",
      payload: {},
      actor: { principal: "user", sessionId: "hashed:t1b1test" },
      taint: "TRUSTED",
      nonce: "t1b1-recon-chain",
      createdAt: at(0),
    })
    const awaiting = record({
      kind: "order.checkout.create",
      envelope: checkoutEnvelope,
      decision: decisionRequestConfirmation("Confirma o pedido?", [...BASIS]),
      at: at(0),
    })
    const resolved = record({
      kind: "order.checkout.create",
      envelope: checkoutEnvelope,
      at: at(1),
      supersedes: {
        predecessorIntentHash: awaiting.intentHash,
        predecessorAt: awaiting.at,
        reason: "confirmation_resolved",
      },
    })
    const report = reconcileExpects({
      journeyId: "JOURNEY-001",
      expects: [{ intentKind: "order.checkout.create", decision: "EXECUTE" }],
      verify: [{ invariant: "order.goal-state", args: { status: "preparing" } }],
      records: [awaiting, resolved],
    })
    // The awaiting REQUEST_CONFIRMATION is NOT unexplained: the chain
    // resolves to its EXECUTE head, exactly as the trajectory matcher sees it.
    expect(report.ok).toBe(true)
    expect(report.supersededCount).toBe(1)
    expect(report.observed).toHaveLength(1)
    expect(report.observed[0]).toMatchObject({
      intentKind: "order.checkout.create",
      decision: "EXECUTE",
      explanation: "expected",
    })
  })
})

// ── Schema acceptance of the allowance flag ──────────────────────────────────

describe("expects[].optional schema flag", () => {
  it("validateJourney accepts optional: true on an expects entry", () => {
    const result = validateJourney({
      id: "JOURNEY-001",
      title: "t",
      businessCase: "b",
      persona: "p",
      channel: "web",
      acts: [{ kind: "http", method: "POST", path: "/api/cart", body: {} }],
      expects: [
        { intentKind: "order.checkout.create", decision: "EXECUTE" },
        { intentKind: "order.status.transition", decision: "EXECUTE", optional: true },
      ],
      verify: [],
      status: "active",
      source: "test",
    })
    expect(result.ok).toBe(true)
  })

  it("exports the runner's verify-outcome id for the gate", () => {
    expect(RECONCILIATION_GATE_ID).toBe("gate.reconciliation")
  })
})
