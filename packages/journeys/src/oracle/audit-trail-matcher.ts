// oracle/audit-trail-matcher.ts — trajectory matchers over fetched
// AuditRecords (T1a-7).
//
// A journey asserts the kernel's governance trail as a TRAJECTORY: an
// expected sequence of `{intentKind, decision}` tuples (with optional payload
// predicates) compared against the run-scoped records the AuditReader
// fetched. Three modes:
//
//   EXACT     — observed sequence equals the expected sequence, index by
//               index (same length, same order).
//   IN_ORDER  — expected is a subsequence of observed (extras allowed,
//               relative order enforced). Greedy earliest-match — correct
//               for subsequence existence by the standard exchange argument.
//   ANY_ORDER — multiset equality: every expected step pairs with a distinct
//               observed record and nothing is left over on either side.
//               Solved as bipartite maximum matching (Kuhn's augmenting
//               paths), NOT greedily — overlapping payload predicates would
//               make a greedy pass report false misses.
//
// Supersession chains (REQUEST_CONFIRMATION resolved, DEFER resumed, REWRITE
// executed, replay, LGPD scrub) are resolved via the UPSTREAM walker
// `buildSupersessionChains` from `@adjudicate/audit` — imported, never
// re-implemented (plan §5 / verified-present pin). Resolution collapses each
// chain to its head (latest) record so journeys assert the FINAL state of an
// intent, not its awaiting intermediates.
//
// Matcher failures return rich machine-readable mismatches plus a rendered
// `diff` (expected vs observed trajectory) for flake diagnosis. Dev/test
// output stays English, matching the existing CLI style.

import {
  buildSupersessionChains,
  explainSupersessionChainReport,
  type SupersessionChainReport,
} from "@adjudicate/audit"
import type { AuditRecord, DecisionKind } from "@adjudicate/core"

// ── Expected / observed step shapes ──────────────────────────────────────────

/**
 * Optional payload predicate for one expected step. Receives the envelope
 * payload (and the full record for advanced checks, e.g. refusal basis).
 * Pure — never mutate the record.
 */
export type PayloadPredicate = (payload: unknown, record: AuditRecord) => boolean

export interface ExpectedTrajectoryStep {
  /** Envelope intent kind, e.g. `order.checkout.create`. */
  readonly intentKind: string
  /** Kernel decision kind, e.g. `EXECUTE` / `REFUSE`. */
  readonly decision: DecisionKind
  /** Optional payload predicate — the step only matches records satisfying it. */
  readonly where?: PayloadPredicate
  /** Optional human label surfaced in diffs (defaults to kind/decision). */
  readonly label?: string
}

/** Projection of one fetched record into the tuple space journeys assert on. */
export interface ObservedTrajectoryStep {
  readonly intentKind: string
  readonly decision: DecisionKind
  readonly intentHash: string
  readonly at: string
}

export type TrajectoryMode = "EXACT" | "IN_ORDER" | "ANY_ORDER"

// ── Result shape ─────────────────────────────────────────────────────────────

export type TrajectoryMismatchReason =
  | "kind_mismatch"
  | "decision_mismatch"
  | "payload_predicate_failed"
  | "no_matching_record"

export interface TrajectoryStepMismatch {
  readonly expectedIndex: number
  /** Observed index compared against (EXACT) — absent when observed ran out. */
  readonly observedIndex?: number
  readonly reason: TrajectoryMismatchReason
}

export interface TrajectoryMatchResult {
  readonly ok: boolean
  readonly mode: TrajectoryMode
  readonly expected: readonly ExpectedTrajectoryStep[]
  readonly observed: readonly ObservedTrajectoryStep[]
  /**
   * Per expected step: the observed index it matched, or undefined. For
   * EXACT a step only ever pairs with its own index.
   */
  readonly matchedObservedIndex: ReadonlyArray<number | undefined>
  /** Expected steps that found no match. */
  readonly unmatchedExpected: readonly number[]
  /**
   * Observed records left unconsumed. Failure for EXACT/ANY_ORDER (multiset
   * equality); informational for IN_ORDER (subsequence allows extras).
   */
  readonly unmatchedObserved: readonly number[]
  readonly mismatches: readonly TrajectoryStepMismatch[]
  /** Present when supersession resolution ran (matchTrajectory option). */
  readonly supersession?: SupersessionChainReport
  /** Rendered expected-vs-observed diff for flake diagnosis. Always present. */
  readonly diff: string
}

// ── Supersession resolution (upstream walker) ────────────────────────────────

export interface ResolvedTrajectory {
  /**
   * Chain heads + singletons in the input (chronological) order — superseded
   * intermediates (chain tails, cycle tails) removed.
   */
  readonly records: AuditRecord[]
  /** The upstream walker's full report, for diagnosis. */
  readonly report: SupersessionChainReport
}

/**
 * Node identity in the chain report. A confirmation-resolved EXECUTE shares
 * its predecessor's intentHash (same envelope), so identity is (hash, at) —
 * the same disambiguation the upstream walker applies.
 */
function nodeKey(intentHash: string, at: string): string {
  return `${intentHash}|${at}`
}

/**
 * Resolve supersession chains over a fetched trail using the canonical
 * walker from `@adjudicate/audit`: every record superseded by a later one
 * (it appears in a chain's tail) is dropped; chain heads and singletons
 * survive in their original chronological positions.
 */
export function resolveSupersessionChains(
  records: readonly AuditRecord[],
): ResolvedTrajectory {
  const report = buildSupersessionChains(records)
  const superseded = new Set<string>()
  for (const chain of [...report.chains, ...report.cycles]) {
    for (const node of chain.tail) superseded.add(nodeKey(node.intentHash, node.at))
  }
  return {
    records: records.filter((r) => !superseded.has(nodeKey(r.intentHash, r.at))),
    report,
  }
}

// ── Matching ─────────────────────────────────────────────────────────────────

function stepMatches(step: ExpectedTrajectoryStep, record: AuditRecord): boolean {
  return (
    record.envelope.kind === step.intentKind &&
    record.decision.kind === step.decision &&
    (step.where === undefined || step.where(record.envelope.payload, record) === true)
  )
}

/** Classify WHY a specific record fails a specific step (EXACT diagnosis). */
function mismatchReason(
  step: ExpectedTrajectoryStep,
  record: AuditRecord,
): TrajectoryMismatchReason {
  if (record.envelope.kind !== step.intentKind) return "kind_mismatch"
  if (record.decision.kind !== step.decision) return "decision_mismatch"
  return "payload_predicate_failed"
}

function observedOf(record: AuditRecord): ObservedTrajectoryStep {
  return {
    intentKind: record.envelope.kind,
    decision: record.decision.kind,
    intentHash: record.intentHash,
    at: record.at,
  }
}

interface MatchInternals {
  matchedObservedIndex: Array<number | undefined>
  mismatches: TrajectoryStepMismatch[]
}

function matchExact(
  expected: readonly ExpectedTrajectoryStep[],
  records: readonly AuditRecord[],
): MatchInternals {
  const matchedObservedIndex: Array<number | undefined> = []
  const mismatches: TrajectoryStepMismatch[] = []
  for (let i = 0; i < expected.length; i++) {
    const step = expected[i]!
    const record = records[i]
    if (record === undefined) {
      matchedObservedIndex.push(undefined)
      mismatches.push({ expectedIndex: i, reason: "no_matching_record" })
      continue
    }
    if (stepMatches(step, record)) {
      matchedObservedIndex.push(i)
    } else {
      matchedObservedIndex.push(undefined)
      mismatches.push({
        expectedIndex: i,
        observedIndex: i,
        reason: mismatchReason(step, record),
      })
    }
  }
  return { matchedObservedIndex, mismatches }
}

function matchInOrder(
  expected: readonly ExpectedTrajectoryStep[],
  records: readonly AuditRecord[],
): MatchInternals {
  const matchedObservedIndex: Array<number | undefined> = []
  const mismatches: TrajectoryStepMismatch[] = []
  let cursor = 0
  for (let i = 0; i < expected.length; i++) {
    const step = expected[i]!
    let found: number | undefined
    for (let j = cursor; j < records.length; j++) {
      if (stepMatches(step, records[j]!)) {
        found = j
        break
      }
    }
    matchedObservedIndex.push(found)
    if (found === undefined) {
      mismatches.push({ expectedIndex: i, observedIndex: cursor, reason: "no_matching_record" })
    } else {
      cursor = found + 1
    }
  }
  return { matchedObservedIndex, mismatches }
}

/**
 * ANY_ORDER — bipartite maximum matching (Kuhn's augmenting paths). Exact for
 * overlapping predicates; journey trajectories are tiny, so O(E·V) is free.
 */
function matchAnyOrder(
  expected: readonly ExpectedTrajectoryStep[],
  records: readonly AuditRecord[],
): MatchInternals {
  const candidates: number[][] = expected.map((step) =>
    records.reduce<number[]>((acc, record, j) => {
      if (stepMatches(step, record)) acc.push(j)
      return acc
    }, []),
  )
  // observedOwner[j] = expected index currently matched to observed j.
  const observedOwner: Array<number | undefined> = new Array(records.length).fill(undefined)

  function augment(i: number, visited: Set<number>): boolean {
    for (const j of candidates[i]!) {
      if (visited.has(j)) continue
      visited.add(j)
      const owner = observedOwner[j]
      if (owner === undefined || augment(owner, visited)) {
        observedOwner[j] = i
        return true
      }
    }
    return false
  }

  for (let i = 0; i < expected.length; i++) augment(i, new Set())

  const matchedObservedIndex: Array<number | undefined> = new Array(expected.length).fill(
    undefined,
  )
  for (let j = 0; j < observedOwner.length; j++) {
    const owner = observedOwner[j]
    if (owner !== undefined) matchedObservedIndex[owner] = j
  }
  const mismatches: TrajectoryStepMismatch[] = []
  for (let i = 0; i < expected.length; i++) {
    if (matchedObservedIndex[i] === undefined) {
      mismatches.push({ expectedIndex: i, reason: "no_matching_record" })
    }
  }
  return { matchedObservedIndex, mismatches }
}

// ── Diff rendering ───────────────────────────────────────────────────────────

function stepLabel(step: ExpectedTrajectoryStep): string {
  const base = `${step.intentKind}/${step.decision}`
  return step.label === undefined ? base : `${step.label} (${base})`
}

function renderDiff(args: {
  ok: boolean
  mode: TrajectoryMode
  expected: readonly ExpectedTrajectoryStep[]
  observed: readonly ObservedTrajectoryStep[]
  matchedObservedIndex: ReadonlyArray<number | undefined>
  mismatches: readonly TrajectoryStepMismatch[]
  unmatchedObserved: readonly number[]
  report?: SupersessionChainReport
}): string {
  const lines: string[] = []
  lines.push(
    args.ok
      ? `audit trajectory matched (mode=${args.mode})`
      : `audit trajectory MISMATCH (mode=${args.mode})`,
    `expected (${args.expected.length} steps):`,
  )
  for (let i = 0; i < args.expected.length; i++) {
    const matched = args.matchedObservedIndex[i]
    if (matched === undefined) {
      const mismatch = args.mismatches.find((m) => m.expectedIndex === i)
      const reason = mismatch?.reason ?? "no_matching_record"
      const at =
        mismatch?.observedIndex === undefined ? "" : ` vs observed[${mismatch.observedIndex}]`
      lines.push(`  [${i}] MISS  ${stepLabel(args.expected[i]!)} (${reason}${at})`)
    } else {
      lines.push(`  [${i}] MATCH ${stepLabel(args.expected[i]!)} -> observed[${matched}]`)
    }
  }
  lines.push(`observed (${args.observed.length} records):`)
  for (let j = 0; j < args.observed.length; j++) {
    const o = args.observed[j]!
    const extra = args.unmatchedObserved.includes(j) ? " [unconsumed]" : ""
    lines.push(
      `  [${j}] ${o.intentKind}/${o.decision} intentHash=${o.intentHash.slice(0, 12)} at=${o.at}${extra}`,
    )
  }
  if (args.report !== undefined) {
    lines.push(`supersession: ${explainSupersessionChainReport(args.report)}`)
  }
  return lines.join("\n")
}

// ── Public entry point ───────────────────────────────────────────────────────

export interface MatchTrajectoryOptions {
  readonly mode: TrajectoryMode
  /**
   * Resolve supersession chains (upstream `buildSupersessionChains`) before
   * matching: superseded intermediates (e.g. the awaiting
   * REQUEST_CONFIRMATION record) drop out and each intent is asserted by its
   * chain head. Default true — journeys assert final state.
   */
  readonly resolveSupersessions?: boolean
}

/**
 * Match a fetched, chronologically-ordered audit trail against an expected
 * trajectory. Backs the `audit.trajectory.exact` / `audit.trajectory.in_order`
 * / `audit.trajectory.any_order` invariants.
 */
export function matchTrajectory(
  records: readonly AuditRecord[],
  expected: readonly ExpectedTrajectoryStep[],
  opts: MatchTrajectoryOptions,
): TrajectoryMatchResult {
  let trail: readonly AuditRecord[] = records
  let report: SupersessionChainReport | undefined
  if (opts.resolveSupersessions !== false) {
    const resolved = resolveSupersessionChains(records)
    trail = resolved.records
    report = resolved.report
  }

  let internals: MatchInternals
  if (opts.mode === "EXACT") {
    internals = matchExact(expected, trail)
  } else if (opts.mode === "IN_ORDER") {
    internals = matchInOrder(expected, trail)
  } else {
    internals = matchAnyOrder(expected, trail)
  }

  const consumed = new Set(
    internals.matchedObservedIndex.filter((j): j is number => j !== undefined),
  )
  const unmatchedObserved: number[] = []
  for (let j = 0; j < trail.length; j++) {
    if (!consumed.has(j)) unmatchedObserved.push(j)
  }
  const unmatchedExpected = internals.matchedObservedIndex.reduce<number[]>((acc, m, i) => {
    if (m === undefined) acc.push(i)
    return acc
  }, [])

  // IN_ORDER is a subsequence check — extras never fail it. EXACT and
  // ANY_ORDER are full-sequence/multiset equality — leftovers fail.
  const extrasFail = opts.mode !== "IN_ORDER" && unmatchedObserved.length > 0
  const ok = unmatchedExpected.length === 0 && !extrasFail

  const observed = trail.map(observedOf)
  const diff = renderDiff({
    ok,
    mode: opts.mode,
    expected,
    observed,
    matchedObservedIndex: internals.matchedObservedIndex,
    mismatches: internals.mismatches,
    unmatchedObserved: opts.mode === "IN_ORDER" ? [] : unmatchedObserved,
    report,
  })

  return {
    ok,
    mode: opts.mode,
    expected,
    observed,
    matchedObservedIndex: internals.matchedObservedIndex,
    unmatchedExpected,
    unmatchedObserved,
    mismatches: internals.mismatches,
    ...(report === undefined ? {} : { supersession: report }),
    diff,
  }
}
