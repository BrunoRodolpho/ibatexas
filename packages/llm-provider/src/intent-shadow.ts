// IBX-IGE Phase P0-a — Shadow-mode infrastructure with classified divergence.
//
// Runs `adjudicate()` alongside the legacy boolean path and classifies the
// outcome into one of four divergence classes:
//
//   NONE             — same kind, same basis. Pure agreement.
//   BASIS_ONLY       — same kind, different basis. Outcome agrees; reasoning
//                      differs (expected during basis-vocabulary upgrade).
//   DECISION_KIND    — different kind. The kernel would change the outcome.
//                      PAGE on rate >0.1% per intent class.
//   PAYLOAD_REWRITE  — adjudicate returned REWRITE; legacy did not rewrite.
//                      Always alert; manual review.
//
// Operational policy: `BASIS_ONLY` is metric-only; `DECISION_KIND` and
// `PAYLOAD_REWRITE` page on-call. A class flips from shadow → enforce only
// after 7 consecutive days of zero `DECISION_KIND` and `PAYLOAD_REWRITE`
// events (14 days for stage-4 financial reversals).

import type {
  Decision,
  DecisionBasis,
  IntentEnvelope,
} from "@adjudicate/intent-core"
import { adjudicate, type PolicyBundle } from "@adjudicate/intent-kernel"

export type DivergenceClass =
  | "NONE"
  | "BASIS_ONLY"
  | "DECISION_KIND"
  | "PAYLOAD_REWRITE"

export interface LegacyDecisionResult {
  readonly kind: "EXECUTE" | "REFUSE"
}

export interface ShadowResult {
  readonly legacyDecision: LegacyDecisionResult
  readonly adjudicateDecision: Decision
  readonly divergence: DivergenceClass
}

export interface ShadowTelemetrySink {
  /** BASIS_ONLY → metric only. */
  recordBasisOnly(intentKind: string, decision: Decision): void
  /** DECISION_KIND → Sentry alert + AnalyticsEvent. */
  alertDecisionKind(
    intentKind: string,
    legacy: LegacyDecisionResult,
    adjudicate: Decision,
  ): void
  /** PAYLOAD_REWRITE → Sentry alert + AnalyticsEvent. */
  alertPayloadRewrite(intentKind: string, adjudicate: Decision): void
}

let _sink: ShadowTelemetrySink = noopSink()

/** Replace the telemetry sink (called by IbateXas wiring at boot). */
export function setShadowTelemetrySink(sink: ShadowTelemetrySink): void {
  _sink = sink
}

/** @internal — for tests. */
export function _resetShadowTelemetrySink(): void {
  _sink = noopSink()
}

function noopSink(): ShadowTelemetrySink {
  return {
    recordBasisOnly() {},
    alertDecisionKind() {},
    alertPayloadRewrite() {},
  }
}

/**
 * Classify the divergence between the legacy boolean path and the new
 * adjudicate() Decision. Pure function; tests assert behavior directly.
 */
export function classifyDivergence(
  legacy: LegacyDecisionResult,
  adj: Decision,
): DivergenceClass {
  // PAYLOAD_REWRITE is its own class regardless of legacy outcome —
  // the kernel proposed a substituted payload, which is always worth review.
  if (adj.kind === "REWRITE") return "PAYLOAD_REWRITE"

  // Compare effective outcomes: EXECUTE on the legacy side maps to EXECUTE.
  // Anything other than EXECUTE on the adjudicate side counts as not-execute.
  const adjudicateExecutes = adj.kind === "EXECUTE"
  const legacyExecutes = legacy.kind === "EXECUTE"

  if (adjudicateExecutes !== legacyExecutes) {
    return "DECISION_KIND"
  }

  // Same outcome — check basis equality. Legacy has no `basis`, so any
  // structured basis on the adjudicate side counts as "different reasoning."
  if (adj.basis.length === 0) return "NONE"
  return "BASIS_ONLY"
}

export interface AdjudicateWithShadowInput<S> {
  readonly envelope: IntentEnvelope
  readonly state: S
  readonly policy: PolicyBundle<string, unknown, S>
  readonly legacy: () => boolean
}

/**
 * Run `adjudicate()` alongside the legacy boolean path. Emits classified
 * divergence telemetry per the operational policy above. Returns both
 * decisions plus the classification — the caller decides which is
 * authoritative based on `IBX_KERNEL_ENFORCE` config.
 */
export function adjudicateWithShadow<S>(
  input: AdjudicateWithShadowInput<S>,
): ShadowResult {
  const adjudicateDecision = adjudicate(
    input.envelope,
    input.state,
    input.policy,
  )
  const legacyExecute = input.legacy()
  const legacyDecision: LegacyDecisionResult = {
    kind: legacyExecute ? "EXECUTE" : "REFUSE",
  }

  const divergence = classifyDivergence(legacyDecision, adjudicateDecision)
  emitDivergence(input.envelope.kind, divergence, legacyDecision, adjudicateDecision)

  return {
    legacyDecision,
    adjudicateDecision,
    divergence,
  }
}

function emitDivergence(
  intentKind: string,
  divergence: DivergenceClass,
  legacy: LegacyDecisionResult,
  adj: Decision,
): void {
  switch (divergence) {
    case "NONE":
      return
    case "BASIS_ONLY":
      _sink.recordBasisOnly(intentKind, adj)
      return
    case "DECISION_KIND":
      _sink.alertDecisionKind(intentKind, legacy, adj)
      return
    case "PAYLOAD_REWRITE":
      _sink.alertPayloadRewrite(intentKind, adj)
      return
  }
}

/**
 * Helper for callers that have a legacy boolean path and need to convert it
 * into a Decision shape so downstream code can treat both paths uniformly.
 */
export function legacyDecisionAsKernelDecision(
  legacy: LegacyDecisionResult,
): Decision {
  if (legacy.kind === "EXECUTE") {
    return { kind: "EXECUTE", basis: [] as readonly DecisionBasis[] }
  }
  return {
    kind: "REFUSE",
    refusal: {
      kind: "BUSINESS_RULE",
      code: "legacy.refused",
      userFacing: "Essa ação não é permitida no momento.",
    },
    basis: [] as readonly DecisionBasis[],
  }
}
