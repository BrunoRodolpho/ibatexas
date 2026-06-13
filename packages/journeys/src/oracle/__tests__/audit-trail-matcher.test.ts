// T1a-7 — AuditTrailMatcher unit suite (pure: records built via the
// canonical @adjudicate/core builders, no I/O). The DB-backed end of the
// oracle (fetch + scoping + tamper-evidence over a real migrated schema,
// plus one matcher pass over FETCHED records) lives in audit-reader.test.ts.

import { describe, expect, it } from "vitest"
import {
  buildAuditRecord,
  buildEnvelope,
  decisionExecute,
  decisionRequestConfirmation,
  decisionRefuse,
  refuse,
  type AuditRecord,
  type Decision,
} from "@adjudicate/core"
import {
  matchTrajectory,
  resolveSupersessionChains,
  type ExpectedTrajectoryStep,
} from "../audit-trail-matcher.js"

const BASIS = [{ category: "business", code: "rule_satisfied" }] as const
const T0 = Date.parse("2026-06-12T10:00:00.000Z")
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString()

let nonceSeq = 0
function record(args: {
  kind: string
  decision?: Decision
  payload?: Record<string, unknown>
  at: string
  supersedes?: AuditRecord["supersedes"]
  envelope?: ReturnType<typeof buildEnvelope>
}): AuditRecord {
  const envelope =
    args.envelope ??
    buildEnvelope({
      kind: args.kind,
      payload: args.payload ?? {},
      actor: { principal: "llm", sessionId: "web:sess-matcher" },
      taint: "UNTRUSTED",
      nonce: `t1a7-matcher-${nonceSeq++}`,
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

const step = (
  intentKind: string,
  decision: ExpectedTrajectoryStep["decision"] = "EXECUTE",
  extra: Partial<ExpectedTrajectoryStep> = {},
): ExpectedTrajectoryStep => ({ intentKind, decision, ...extra })

// ── EXACT ────────────────────────────────────────────────────────────────────

describe("matchTrajectory EXACT", () => {
  const trail = [
    record({ kind: "cart.item.add", payload: { handle: "costela-bovina-defumada" }, at: at(0) }),
    record({ kind: "order.checkout.create", at: at(1) }),
  ]

  it("passes when the sequence equals index by index", () => {
    const result = matchTrajectory(
      trail,
      [step("cart.item.add"), step("order.checkout.create")],
      { mode: "EXACT" },
    )
    expect(result.ok).toBe(true)
    expect(result.matchedObservedIndex).toEqual([0, 1])
    expect(result.unmatchedObserved).toEqual([])
    expect(result.diff).toContain("audit trajectory matched (mode=EXACT)")
  })

  it("fails on order swap with per-index mismatch reasons", () => {
    const result = matchTrajectory(
      trail,
      [step("order.checkout.create"), step("cart.item.add")],
      { mode: "EXACT" },
    )
    expect(result.ok).toBe(false)
    expect(result.mismatches).toEqual([
      { expectedIndex: 0, observedIndex: 0, reason: "kind_mismatch" },
      { expectedIndex: 1, observedIndex: 1, reason: "kind_mismatch" },
    ])
    expect(result.diff).toContain("MISMATCH (mode=EXACT)")
    expect(result.diff).toContain("MISS")
  })

  it("fails on a decision mismatch with reason decision_mismatch", () => {
    const result = matchTrajectory(
      trail,
      [step("cart.item.add"), step("order.checkout.create", "REFUSE")],
      { mode: "EXACT" },
    )
    expect(result.ok).toBe(false)
    expect(result.mismatches).toEqual([
      { expectedIndex: 1, observedIndex: 1, reason: "decision_mismatch" },
    ])
  })

  it("fails when observed has extra records (sequence equality, not prefix)", () => {
    const result = matchTrajectory(trail, [step("cart.item.add")], { mode: "EXACT" })
    expect(result.ok).toBe(false)
    expect(result.unmatchedObserved).toEqual([1])
    expect(result.diff).toContain("[unconsumed]")
  })

  it("fails when expected outruns observed (no_matching_record)", () => {
    const result = matchTrajectory(
      trail,
      [step("cart.item.add"), step("order.checkout.create"), step("order.cancel")],
      { mode: "EXACT" },
    )
    expect(result.ok).toBe(false)
    expect(result.mismatches).toEqual([
      { expectedIndex: 2, reason: "no_matching_record" },
    ])
  })
})

// ── IN_ORDER ─────────────────────────────────────────────────────────────────

describe("matchTrajectory IN_ORDER", () => {
  const trail = [
    record({ kind: "cart.item.add", payload: { qty: 1 }, at: at(0) }),
    record({ kind: "cart.item.add", payload: { qty: 2 }, at: at(1) }),
    record({ kind: "order.checkout.create", at: at(2) }),
    record({ kind: "order.note.add", at: at(3) }),
  ]

  it("passes as a subsequence — extras allowed, order enforced", () => {
    const result = matchTrajectory(
      trail,
      [step("cart.item.add"), step("order.checkout.create")],
      { mode: "IN_ORDER" },
    )
    expect(result.ok).toBe(true)
    expect(result.matchedObservedIndex).toEqual([0, 2])
    // Extras are informational for IN_ORDER, never a failure.
    expect(result.unmatchedObserved).toEqual([1, 3])
  })

  it("fails when relative order is violated", () => {
    const result = matchTrajectory(
      trail,
      [step("order.checkout.create"), step("cart.item.add")],
      { mode: "IN_ORDER" },
    )
    expect(result.ok).toBe(false)
    expect(result.matchedObservedIndex).toEqual([2, undefined])
    expect(result.unmatchedExpected).toEqual([1])
    expect(result.diff).toContain("no_matching_record")
  })

  it("payload predicates narrow the subsequence match", () => {
    const result = matchTrajectory(
      trail,
      [
        step("cart.item.add", "EXECUTE", {
          where: (payload) => (payload as { qty: number }).qty === 2,
          label: "second add",
        }),
        step("order.checkout.create"),
      ],
      { mode: "IN_ORDER" },
    )
    expect(result.ok).toBe(true)
    expect(result.matchedObservedIndex).toEqual([1, 2])
    expect(result.diff).toContain("second add")
  })

  it("fails when no record satisfies the payload predicate", () => {
    const result = matchTrajectory(
      trail,
      [step("cart.item.add", "EXECUTE", { where: (p) => (p as { qty: number }).qty === 9 })],
      { mode: "IN_ORDER" },
    )
    expect(result.ok).toBe(false)
    expect(result.unmatchedExpected).toEqual([0])
  })
})

// ── ANY_ORDER ────────────────────────────────────────────────────────────────

describe("matchTrajectory ANY_ORDER", () => {
  it("passes on a scrambled multiset", () => {
    const trail = [
      record({ kind: "order.checkout.create", at: at(0) }),
      record({ kind: "cart.item.add", at: at(1) }),
    ]
    const result = matchTrajectory(
      trail,
      [step("cart.item.add"), step("order.checkout.create")],
      { mode: "ANY_ORDER" },
    )
    expect(result.ok).toBe(true)
    expect(result.matchedObservedIndex).toEqual([1, 0])
  })

  it("fails on a missing step and on leftover observed records", () => {
    const trail = [
      record({ kind: "cart.item.add", at: at(0) }),
      record({ kind: "order.note.add", at: at(1) }),
    ]
    const result = matchTrajectory(
      trail,
      [step("cart.item.add"), step("order.checkout.create")],
      { mode: "ANY_ORDER" },
    )
    expect(result.ok).toBe(false)
    expect(result.unmatchedExpected).toEqual([1])
    expect(result.unmatchedObserved).toEqual([1])
    expect(result.diff).toContain("[unconsumed]")
  })

  it("resolves overlapping predicates via augmenting paths (greedy would miss)", () => {
    const qtyOne = record({ kind: "cart.item.add", payload: { qty: 1 }, at: at(0) })
    const qtyTwo = record({ kind: "cart.item.add", payload: { qty: 2 }, at: at(1) })
    // First expected step matches BOTH records; second matches ONLY qty=1.
    // A greedy pass hands qty=1 to the first step and strands the second —
    // maximum matching must reassign.
    const result = matchTrajectory(
      [qtyOne, qtyTwo],
      [
        step("cart.item.add", "EXECUTE", { label: "any add" }),
        step("cart.item.add", "EXECUTE", {
          where: (p) => (p as { qty: number }).qty === 1,
          label: "qty-1 add",
        }),
      ],
      { mode: "ANY_ORDER" },
    )
    expect(result.ok).toBe(true)
    expect(result.matchedObservedIndex).toEqual([1, 0])
  })
})

// ── Supersession resolution (upstream walker) ────────────────────────────────

describe("supersession chains (via @adjudicate/audit walker)", () => {
  // Confirmation chain: same envelope adjudicated twice — the awaiting
  // REQUEST_CONFIRMATION record, then the resolved EXECUTE superseding it.
  const checkoutEnvelope = buildEnvelope({
    kind: "order.checkout.create",
    payload: { customerId: "cus_matcher" },
    actor: { principal: "llm", sessionId: "web:sess-matcher" },
    taint: "UNTRUSTED",
    nonce: "t1a7-matcher-chain",
    createdAt: at(10),
  })
  const awaiting = record({
    kind: "order.checkout.create",
    envelope: checkoutEnvelope,
    decision: decisionRequestConfirmation("Confirma o pedido?", [...BASIS]),
    at: at(10),
  })
  const resolved = record({
    kind: "order.checkout.create",
    envelope: checkoutEnvelope,
    decision: decisionExecute([...BASIS]),
    at: at(11),
    supersedes: {
      predecessorIntentHash: awaiting.intentHash,
      predecessorAt: awaiting.at,
      reason: "confirmation_resolved",
    },
  })
  const refusal = record({
    kind: "order.cancel",
    decision: decisionRefuse(
      refuse("BUSINESS_RULE", "replay_suppressed", "Pedido já processado."),
      [{ category: "ledger", code: "replay_suppressed" }],
    ),
    at: at(12),
  })
  const trail = [awaiting, resolved, refusal]

  it("resolveSupersessionChains drops superseded intermediates, keeps heads + singletons", () => {
    const { records, report } = resolveSupersessionChains(trail)
    expect(records).toEqual([resolved, refusal])
    expect(report.chains).toHaveLength(1)
    expect(report.chains[0]!.head.intentHash).toBe(resolved.intentHash)
    expect(report.chains[0]!.length).toBe(2)
    expect(report.cycles).toEqual([])
    expect(report.danglingReferences).toEqual([])
  })

  it("matchTrajectory resolves chains by default — final state asserted, not the awaiting record", () => {
    const result = matchTrajectory(
      trail,
      [step("order.checkout.create", "EXECUTE"), step("order.cancel", "REFUSE")],
      { mode: "EXACT" },
    )
    expect(result.ok).toBe(true)
    expect(result.observed).toHaveLength(2)
    expect(result.supersession?.chains).toHaveLength(1)
    expect(result.diff).toContain("supersession: ")
  })

  it("resolveSupersessions:false matches the raw trail (awaiting record visible)", () => {
    const result = matchTrajectory(
      trail,
      [
        step("order.checkout.create", "REQUEST_CONFIRMATION"),
        step("order.checkout.create", "EXECUTE"),
        step("order.cancel", "REFUSE"),
      ],
      { mode: "EXACT", resolveSupersessions: false },
    )
    expect(result.ok).toBe(true)
    expect(result.supersession).toBeUndefined()
  })

  it("payload predicate can pin the refusal basis tuple (audit.refusal-basis shape)", () => {
    const result = matchTrajectory(
      trail,
      [
        step("order.cancel", "REFUSE", {
          where: (_payload, r) =>
            r.decision_basis.some(
              (b) => b.category === "ledger" && b.code === "replay_suppressed",
            ),
        }),
      ],
      { mode: "IN_ORDER" },
    )
    expect(result.ok).toBe(true)
  })
})
