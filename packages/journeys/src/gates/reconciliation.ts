// gates/reconciliation.ts — declared expects[] vs observed intent_audit
// (T1b-1).
//
// After a journey attempt completes, the harness fetches EVERY audit row in
// the run's namespaces (the hashed chat conversationIds + the http-act
// actor namespaces, time-scoped `since=runStartedAt` — the exact scope the
// verify[] phase already uses, see harness/run-journey-cli.ts) and
// reconciles the observed trail against the journey's declared `expects[]`.
//
// Division of labour (reuse, don't duplicate):
//
//   * "every expects[] entry must be observed"  → the TRAJECTORY MATCHER's
//     job (oracle/audit-trail-matcher.ts), driven by the journey's declared
//     `audit.trajectory.*` invariant. This gate only REPORTS required
//     entries with zero observed matches (`unobservedRequired`,
//     informational) — it never fails for them.
//
//   * "every OBSERVED envelope must be EXPLAINED" → THIS gate's job. An
//     observed record is explained when its (intentKind, decision) tuple
//     matches an expects[] entry — required or `optional: true` (the
//     journey-declared allowance for envelopes the run legitimately
//     produces but does not assert, e.g. an executor's inner
//     projection-level transitions). Noop/smalltalk dispatches need no
//     exclusion rule: turns proposing zero envelopes write no intent_audit
//     rows at all (plan §5 fact 18), so they are structurally invisible
//     here. Superseded intermediates (awaiting REQUEST_CONFIRMATION, resumed
//     DEFER…) drop out via the upstream chain walker before matching — the
//     same `resolveSupersessionChains` default the matcher applies, so both
//     gates see the identical FINAL-state trail. Anything left over is an
//     UNEXPLAINED envelope: the run drifted from its declared spec — gate
//     FAILURE (`unexplained_envelope`), never a pass.
//
//     Matching is tuple-level (kind + decision), not count-level: an entry
//     explains ALL observed records sharing its tuple (e.g. a chat act that
//     parks/re-parks the same confirm gate). Count/order drift is the
//     trajectory invariant's domain (EXACT / ANY_ORDER modes).
//
//   * fixture-act governance (schema/journey.ts header: a fixture act may
//     NEVER produce state the journey asserts) → also THIS gate. A journey
//     whose verify[] asserts goal STATE (any non-`audit.*` invariant —
//     order.goal-state, reservation.goal-state, cart.goal-state…) while the
//     run's namespaces contain NO mutation-capable audited decision
//     (EXECUTE / REWRITE) is asserting state that no audited envelope
//     produced — i.e. state forged by a fixture or pre-existing. Named
//     failure: `fixture_forged_assertion`.

import type { AuditRecord, DecisionKind } from "@adjudicate/core"
import { resolveSupersessionChains } from "../oracle/audit-trail-matcher.js"
import type { JourneyExpect, JourneyVerify } from "../schema/journey.js"

// ── Report shapes ────────────────────────────────────────────────────────────

/** Verify-outcome id the runner reports this gate under (not a journey-declarable invariant). */
export const RECONCILIATION_GATE_ID = "gate.reconciliation"

/** Kernel decisions that can have produced state (everything else parks/declines). */
const MUTATION_DECISIONS: ReadonlySet<DecisionKind> = new Set(["EXECUTE", "REWRITE"])

export type EnvelopeExplanation = "expected" | "optional" | "unexplained"

/** One observed (post-supersession-resolution) audit record, reconciled. */
export interface ReconciledEnvelope {
  intentKind: string
  decision: DecisionKind
  intentHash: string
  at: string
  explanation: EnvelopeExplanation
  /** Index into expects[] of the explaining entry (absent when unexplained). */
  expectIndex?: number
}

/** One declared expects[] entry with its observed tally. */
export interface ReconciledExpect {
  intentKind: string
  decision: DecisionKind
  optional: boolean
  observedCount: number
}

export type ReconciliationFailureCode =
  | "unexplained_envelope"
  | "fixture_forged_assertion"

export interface ReconciliationFailure {
  code: ReconciliationFailureCode
  message: string
}

export interface ReconciliationReport {
  ok: boolean
  journeyId: string
  /** Declared expects[] (required + optional) in file order, with tallies. */
  expected: ReconciledExpect[]
  /** Every observed record in the run's namespaces, post chain resolution. */
  observed: ReconciledEnvelope[]
  /** The observed records no expects[] entry explains — the drift set. */
  unexplained: ReconciledEnvelope[]
  /**
   * REQUIRED expects with zero observed matches. INFORMATIONAL — the
   * trajectory matcher (the journey's `audit.trajectory.*` invariant) owns
   * required-presence failures; this gate never duplicates them.
   */
  unobservedRequired: Array<{ intentKind: string; decision: DecisionKind; expectIndex: number }>
  /** Superseded intermediates dropped by chain resolution before matching. */
  supersededCount: number
  failures: ReconciliationFailure[]
  /** Rendered expected/observed/unexplained report (flake/drift diagnosis). */
  report: string
}

export interface ReconcileExpectsOptions {
  /**
   * Resolve supersession chains before reconciling (default true — mirrors
   * `matchTrajectory`, so both gates assert the same final-state trail).
   */
  resolveSupersessions?: boolean
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderReport(args: {
  ok: boolean
  journeyId: string
  expected: ReconciledExpect[]
  observed: ReconciledEnvelope[]
  unexplained: ReconciledEnvelope[]
  unobservedRequired: ReconciliationReport["unobservedRequired"]
  supersededCount: number
  failures: ReconciliationFailure[]
}): string {
  const lines: string[] = []
  lines.push(
    args.ok
      ? `reconciliation OK (${args.journeyId})`
      : `reconciliation FAILED (${args.journeyId})`,
  )
  lines.push(`expected (${args.expected.length} declared):`)
  args.expected.forEach((e, i) => {
    const tag = e.optional ? " [optional]" : ""
    const tally =
      e.observedCount > 0
        ? `observed ${e.observedCount}`
        : e.optional
          ? "absent (tolerated)"
          : "absent (trajectory matcher owns this failure)"
    lines.push(`  [${i}] ${e.intentKind}/${e.decision}${tag} — ${tally}`)
  })
  lines.push(
    `observed (${args.observed.length} record(s) in the run namespaces` +
      `${args.supersededCount > 0 ? `, ${args.supersededCount} superseded intermediate(s) dropped` : ""}):`,
  )
  args.observed.forEach((o, j) => {
    const tail =
      o.explanation === "unexplained"
        ? "UNEXPLAINED"
        : `expects[${o.expectIndex}]${o.explanation === "optional" ? " (optional)" : ""}`
    lines.push(
      `  [${j}] ${o.intentKind}/${o.decision} intentHash=${o.intentHash.slice(0, 12)} at=${o.at} <- ${tail}`,
    )
  })
  if (args.unexplained.length > 0) {
    lines.push(`unexplained (${args.unexplained.length}):`)
    for (const u of args.unexplained) {
      lines.push(`  ${u.intentKind}/${u.decision} at=${u.at}`)
    }
  }
  for (const f of args.failures) lines.push(`failure ${f.code}: ${f.message}`)
  return lines.join("\n")
}

// ── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Reconcile the run's observed audit trail against the journey's declared
 * `expects[]`. Pure over fetched records — the runner supplies the
 * namespace-scoped, `since=runStartedAt` fetch (harness/run-journey-cli.ts);
 * unit tests supply fixture records.
 */
export function reconcileExpects(
  args: {
    journeyId: string
    expects: readonly JourneyExpect[]
    verify: readonly JourneyVerify[]
    records: readonly AuditRecord[]
  },
  opts: ReconcileExpectsOptions = {},
): ReconciliationReport {
  // Same final-state view the trajectory matcher asserts (default on).
  let trail: readonly AuditRecord[] = args.records
  let supersededCount = 0
  if (opts.resolveSupersessions !== false) {
    const resolved = resolveSupersessionChains(args.records)
    trail = resolved.records
    supersededCount = args.records.length - trail.length
  }

  const expected: ReconciledExpect[] = args.expects.map((e) => ({
    intentKind: e.intentKind,
    decision: e.decision,
    optional: e.optional === true,
    observedCount: 0,
  }))

  // Every observed envelope must be explained by a declared tuple.
  const observed: ReconciledEnvelope[] = trail.map((record) => {
    const intentKind = record.envelope.kind
    const decision = record.decision.kind
    const expectIndex = expected.findIndex(
      (e) => e.intentKind === intentKind && e.decision === decision,
    )
    if (expectIndex >= 0) expected[expectIndex]!.observedCount += 1
    return {
      intentKind,
      decision,
      intentHash: record.intentHash,
      at: record.at,
      explanation:
        expectIndex < 0
          ? "unexplained"
          : expected[expectIndex]!.optional
            ? "optional"
            : "expected",
      ...(expectIndex >= 0 ? { expectIndex } : {}),
    }
  })

  const unexplained = observed.filter((o) => o.explanation === "unexplained")
  const unobservedRequired = expected.reduce<ReconciliationReport["unobservedRequired"]>(
    (acc, e, i) => {
      if (!e.optional && e.observedCount === 0) {
        acc.push({ intentKind: e.intentKind, decision: e.decision, expectIndex: i })
      }
      return acc
    },
    [],
  )

  const failures: ReconciliationFailure[] = []
  if (unexplained.length > 0) {
    failures.push({
      code: "unexplained_envelope",
      message:
        `${unexplained.length} observed envelope(s) match no expects[] entry — drift, not pass: ` +
        unexplained.map((u) => `${u.intentKind}/${u.decision}`).join(", ") +
        " (declare the trajectory, or an explicit `optional: true` allowance)",
    })
  }

  // Fixture-act governance: verify[] may only assert state an AUDITED
  // envelope produced. `audit.*` invariants assert the trail itself; every
  // other registered invariant asserts goal STATE.
  const stateInvariants = args.verify.filter((v) => !v.invariant.startsWith("audit."))
  const hasMutation = trail.some((r) => MUTATION_DECISIONS.has(r.decision.kind))
  if (stateInvariants.length > 0 && !hasMutation) {
    failures.push({
      code: "fixture_forged_assertion",
      message:
        `verify[] asserts goal state (${stateInvariants.map((v) => v.invariant).join(", ")}) ` +
        `but the run's audit namespaces contain no EXECUTE/REWRITE decision — ` +
        `no audited envelope produced the asserted state (fixture-forged or ` +
        `pre-existing state may never be asserted)`,
    })
  }

  const ok = failures.length === 0
  return {
    ok,
    journeyId: args.journeyId,
    expected,
    observed,
    unexplained,
    unobservedRequired,
    supersededCount,
    failures,
    report: renderReport({
      ok,
      journeyId: args.journeyId,
      expected,
      observed,
      unexplained,
      unobservedRequired,
      supersededCount,
      failures,
    }),
  }
}
