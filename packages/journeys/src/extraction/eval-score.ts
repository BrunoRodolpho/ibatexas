// extraction/eval-score.ts — LE2-05 ("Eval harness v1"): the PURE core of the
// OFFLINE structural scorer. Zero I/O, fully TDD-able with scripted fixtures.
//
// ── What this is ────────────────────────────────────────────────────────────
//
// The THIRD producer of `AccuracyCaseResult` (after `accuracy-runner.ts`'s
// live drive and `read-tool-corpus/score.ts`'s read-tool adapter), feeding the
// SAME `computeAccuracyReport` pipeline. It scores a pinned EVAL CASE —
// an authored expectation + the parse artifact(s) captured for its utterance —
// without a model, a server, or a database in the loop. Every input is a
// committed file (see `eval-schema.ts`), so the same inputs always produce the
// same numbers: LE2-05's determinism AC is a property of the design, not of a
// retry loop.
//
// The harness is a CONSUMER of evidence the turn seam already emits (design
// doc "Extraction corpus → harness"): it adds no runtime hook anywhere.
//
// ── What "structural" means here ────────────────────────────────────────────
//
// Scoring runs over the PARSED ENVELOPE, never over rendered prose:
//   - the capability must match exactly (no tolerance whatsoever);
//   - each authored slot must match STRUCTURALLY — `deepEqualArgs`
//     (read-tool-corpus/score.ts, the existing sanctioned comparator: object
//     key ORDER irrelevant, array order significant) over values put through
//     `normalizeStructuralValue`, so casing / Unicode NFC form / padding /
//     collapsed inner whitespace are tolerated;
//   - `payloadExactKeys` discipline is preserved verbatim — an extra or
//     missing slot key fails, exactly as it does for the live meter (the
//     expectation clauses are evaluated by `evaluateExpectPayload` itself,
//     with only the leaf comparator swapped).
//
// DELIBERATELY NOT tolerated (documented so nobody "fixes" it later): type
// coercion. `"2"` is not `2`, `"true"` is not `true`. The wire schema
// (apps/api language-engine/wire-schemas.ts) pins each slot's JSON type, so a
// type mismatch is a WRONG SLOT the harness must keep catching — it is not
// formatting noise.
//
// ── Refusal / irrelevance is a first-class scored category ──────────────────
//
// Net-new in LE2-05 (nothing in the tree scored it). A case may declare that
// its utterance must parse to NO capability at all — the extraction-plane
// mirror of the read-tool sound-abstain mode. Refusal is NOT folded into the
// pass/fail of extraction: it is scored on its own axis, as the ∅ CLASS of an
// ordinary per-class confusion matrix over the capability the parse selected.
// That gives, from one uniform mechanism:
//   - per-capability precision/recall for every capability, AND
//   - refusal precision/recall as the ∅ class's own row + the aggregate
//     `refusal` block.
// The slot-level pass/fail (did it extract the right VALUES) stays completely
// separate, in the `AccuracyReport` this module also produces.
//
// ── No artifact ⇒ UNSCOREABLE, never a silent skip ──────────────────────────
//
// A case whose utterance appears in no pinned fixture, or whose expectation
// needs an observability the artifact's source cannot give (a `wire` attempt
// has no resolver output, hence no hydration / provenance / kernel decision),
// is reported `unscoreable` with a machine-readable reason. It is counted, it
// is never passed, and it is never failed.

import type { AccuracyCaseResult } from "./accuracy.js"
import { deepEqualArgs } from "../read-tool-corpus/score.js"
import { evaluateExpectPayload } from "./expect-payload.js"
import type { ExpectPayload } from "./schema.js"
import { EVAL_REFUSAL_CAPABILITY } from "./eval-schema.js"
import type { EvalArtifactSource, EvalAuditGoldArtifact, EvalWireArtifact } from "./eval-schema.js"

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * The JOIN KEY between an eval case and a captured artifact: NFC form, outer
 * padding stripped, inner whitespace runs collapsed, case-folded. Two
 * utterances that differ only by those are the SAME utterance — a captured
 * turn must not miss its case because a corpus author typed two spaces.
 */
export function normalizeUtterance(utterance: string): string {
  return utterance.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase()
}

/**
 * Recursively canonicalize a slot value for STRUCTURAL comparison: strings
 * get `normalizeUtterance`'s treatment (the same definition of "formatting
 * noise" in both places, deliberately); arrays keep their order; objects are
 * rebuilt with sorted keys (belt-and-braces — `deepEqualArgs` is already key-
 * order-insensitive); every other scalar is returned untouched, so no type
 * coercion can sneak in.
 */
export function normalizeStructuralValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeUtterance(value)
  if (Array.isArray(value)) return value.map(normalizeStructuralValue)
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) out[key] = normalizeStructuralValue(record[key])
    return out
  }
  return value
}

/** The leaf comparator injected into `evaluateExpectPayload` — see the header. */
export function structuralEquals(actual: unknown, expected: unknown): boolean {
  return deepEqualArgs(normalizeStructuralValue(actual), normalizeStructuralValue(expected))
}

// ── Artifact → parsed envelope ──────────────────────────────────────────────

/** What every artifact, whatever its source, is reduced to before scoring. */
export interface ParsedEnvelope {
  /** The capability the parse selected, or `null` when it selected none. */
  capability: string | null
  extractionIR?: { payload: Record<string, unknown>; provenance?: Record<string, unknown> }
  hydratedIntentIR?: {
    payload: Record<string, unknown>
    provenance?: Record<string, unknown>
    confirmationRequired?: boolean
  }
  decision?: string
  /** Which store this envelope was reconstructed from (report attribution). */
  source: EvalArtifactSource
  /** The fixture file id it came from (report attribution). */
  fixtureId: string
}

/**
 * Read one raw model completion into a parsed envelope.
 *
 * DELIBERATELY CONSERVATIVE — and that is the point. It accepts exactly:
 *   - the whole trimmed completion being ONE JSON object, optionally wrapped
 *     in a single ```json … ``` fence;
 *   - that object carrying a `capability` key.
 * Anything else — prose, a JSON object with no `capability` key, JSON buried
 * inside a sentence, several objects — reads as `capability: null`, i.e. NO
 * PARSE.
 *
 * It performs NO salvage. LE2 ticket 02 owns envelope salvage (promoting
 * exact, unambiguous capability JSON stranded in the model's text); this
 * reader is the BEFORE side of that ticket's before/after score, so teaching
 * it to salvage would erase the very measurement it exists to provide. When
 * 02 lands, its translator becomes a SECOND, explicitly-selected reader here
 * and the delta between the two is the ticket's number.
 */
export function parseWireCompletion(completion: string): {
  capability: string | null
  payload: Record<string, unknown>
} {
  const trimmed = completion.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed)
  const body = (fence?.[1] ?? trimmed).trim()
  if (!body.startsWith("{") || !body.endsWith("}")) return { capability: null, payload: {} }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { capability: null, payload: {} }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { capability: null, payload: {} }
  }
  const record = parsed as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, "capability")) {
    return { capability: null, payload: {} }
  }
  const capability = record["capability"]
  if (typeof capability !== "string" || capability.length === 0) {
    return { capability: null, payload: {} }
  }
  const payload = record["payload"]
  return {
    capability,
    payload: payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {},
  }
}

/** Reduce an `audit-gold` artifact to a `ParsedEnvelope`. */
export function envelopeFromAuditGold(
  artifact: EvalAuditGoldArtifact,
  fixtureId: string,
): ParsedEnvelope {
  return {
    capability: artifact.capability,
    ...(artifact.extractionIR === undefined ? {} : { extractionIR: artifact.extractionIR }),
    ...(artifact.hydratedIntentIR === undefined
      ? {}
      : { hydratedIntentIR: artifact.hydratedIntentIR }),
    ...(artifact.decision === undefined ? {} : { decision: artifact.decision }),
    source: "audit-gold",
    fixtureId,
  }
}

/**
 * Reduce a `wire` artifact to a `ParsedEnvelope`. A tool call wins over the
 * text completion when both are present (the model used the sanctioned
 * channel; the text is then commentary). `express_intent(capability, payload)`
 * is the only mutation-proposing tool the planner ever exposes
 * (apps/api/src/claustrum/ibatexas-planner.ts) — any other tool name is a read
 * tool and proposes NO capability.
 *
 * A wire envelope carries `extractionIR` ONLY: an attempt is captured at the
 * fetch boundary, before any resolver ran, so hydration / provenance / the
 * kernel decision simply do not exist yet. `unscoreableReason` below turns
 * that into an honest UNSCOREABLE rather than a fake failure.
 */
export function envelopeFromWire(artifact: EvalWireArtifact, fixtureId: string): ParsedEnvelope {
  const fromToolCall =
    artifact.toolCall === undefined || artifact.toolCall.name !== "express_intent"
      ? undefined
      : {
          capability:
            typeof artifact.toolCall.arguments["capability"] === "string"
              ? (artifact.toolCall.arguments["capability"] as string)
              : null,
          payload:
            artifact.toolCall.arguments["payload"] !== null &&
            typeof artifact.toolCall.arguments["payload"] === "object" &&
            !Array.isArray(artifact.toolCall.arguments["payload"])
              ? (artifact.toolCall.arguments["payload"] as Record<string, unknown>)
              : {},
        }
  const read =
    fromToolCall ??
    (artifact.completion === undefined
      ? { capability: null, payload: {} }
      : parseWireCompletion(artifact.completion))

  return {
    capability: read.capability,
    ...(read.capability === null ? {} : { extractionIR: { payload: read.payload } }),
    source: "wire",
    fixtureId,
  }
}

// ── Eval cases ──────────────────────────────────────────────────────────────

/** An authored PARSE expectation — a corpus case, consumed unmodified. */
export interface EvalParseCase {
  kind: "parse"
  capability: string
  caseId: string
  utterance: string
  expectPayload: ExpectPayload
}

/** An authored REFUSAL expectation — the ∅ class (`expectCapability: null`). */
export interface EvalRefusalCase {
  kind: "refusal"
  /** Always `EVAL_REFUSAL_CAPABILITY` — the report key for the ∅ class. */
  capability: string
  caseId: string
  utterance: string
}

export type EvalCase = EvalParseCase | EvalRefusalCase

export const EVAL_UNSCOREABLE_REASONS = [
  "no_artifact",
  "hydration_not_observed",
  "provenance_not_observed",
  "decision_not_observed",
] as const

export type EvalUnscoreableReason = (typeof EVAL_UNSCOREABLE_REASONS)[number]

/**
 * Can THIS artifact answer what THIS case asks? Returns the blocking reason,
 * or `null` when the pairing is fully scoreable. Checked BEFORE scoring so a
 * case never fails for a question its evidence could not have answered.
 *
 * Note the asymmetry that makes this safe: a `null`-capability envelope (the
 * parse refused) is always SCOREABLE against a parse case — that is the
 * `wronglyRefused` false negative the refusal axis exists to count, not a
 * missing observation.
 */
export function unscoreableReason(
  evalCase: EvalCase,
  envelope: ParsedEnvelope,
): EvalUnscoreableReason | null {
  if (evalCase.kind === "refusal") return null
  if (envelope.capability === null) return null

  const expected = evalCase.expectPayload
  if (expected.hydratedIntentIR !== undefined && envelope.hydratedIntentIR === undefined) {
    return "hydration_not_observed"
  }
  if (expected.extractionIR.provenanceTrust !== undefined && envelope.extractionIR?.provenance === undefined) {
    return "provenance_not_observed"
  }
  if (expected.hydratedIntentIR?.provenanceTrust !== undefined && envelope.hydratedIntentIR?.provenance === undefined) {
    return "provenance_not_observed"
  }
  if (expected.decision !== undefined && envelope.decision === undefined) {
    return "decision_not_observed"
  }
  return null
}

/**
 * Evaluate one parse expectation against ONE envelope via the EXISTING
 * `evaluateExpectPayload` compiler — the same clause semantics the live meter
 * uses (payload / payloadExactKeys / payloadPresent / provenanceTrust /
 * confirmationRequired / decision), with only the leaf comparator swapped for
 * the structural one. No second copy of the expectation semantics exists.
 */
function evaluateParseAgainstEnvelope(
  evalCase: EvalParseCase,
  envelope: ParsedEnvelope,
): readonly string[] {
  if (envelope.capability === null) {
    return [
      `capability: expected "${evalCase.capability}" but the captured parse selected NO capability ` +
        `(source ${envelope.source}, fixture ${envelope.fixtureId})`,
    ]
  }
  if (envelope.capability !== evalCase.capability) {
    return [
      `capability: expected "${evalCase.capability}", got "${envelope.capability}" ` +
        `(source ${envelope.source}, fixture ${envelope.fixtureId})`,
    ]
  }
  const record = {
    metadata: {
      languageEngine: {
        ...(envelope.extractionIR === undefined ? {} : { extractionIR: envelope.extractionIR }),
        ...(envelope.hydratedIntentIR === undefined
          ? {}
          : { hydratedIntentIR: envelope.hydratedIntentIR }),
      },
    },
    decision: { kind: envelope.decision ?? "" },
  }
  return evaluateExpectPayload(evalCase.expectPayload, record, { equals: structuralEquals }).failures
}

/** One artifact's observation, kept for the capability-classification matrix. */
export interface EvalObservation {
  /** The class the case EXPECTS: a capability, or `null` for the ∅ class. */
  expected: string | null
  /** The class the captured parse SELECTED: a capability, or `null`. */
  observed: string | null
}

export interface EvalCaseOutcome {
  /** The unit `computeAccuracyReport` consumes. */
  result: AccuracyCaseResult
  /** `null` when the case was unscoreable (no observation to attribute). */
  observations: readonly EvalObservation[]
  /** Set only when the case is unscoreable. */
  unscoreable: EvalUnscoreableReason | null
}

/**
 * Score ONE eval case against every artifact captured for its utterance.
 *
 * MULTI-ARTIFACT RULE (deterministic, no tie-break needed): a case passes IFF
 * EVERY captured parse of its utterance satisfies the expectation. Re-driving
 * the same utterance N times (the program's N× re-drive) therefore measures
 * STABILITY for free — an unstable parser is a failing parser — and the score
 * never depends on which capture happened to be picked. Each artifact
 * contributes its own observation to the classification matrix.
 *
 * Pure.
 */
export function scoreEvalCase(
  evalCase: EvalCase,
  envelopes: readonly ParsedEnvelope[],
): EvalCaseOutcome {
  const base = {
    capability: evalCase.capability,
    caseId: evalCase.caseId,
    utterance: evalCase.utterance,
  }

  if (envelopes.length === 0) {
    return {
      result: {
        ...base,
        ok: false,
        unscoreable: true,
        failures: [
          "no_artifact: no pinned parse artifact carries this utterance " +
            "(packages/journeys/extraction-eval/fixtures/) — the case is UNSCOREABLE, neither passed nor failed",
        ],
      },
      observations: [],
      unscoreable: "no_artifact",
    }
  }

  const blocked = envelopes
    .map((envelope) => unscoreableReason(evalCase, envelope))
    .filter((reason): reason is EvalUnscoreableReason => reason !== null)
  if (blocked.length === envelopes.length) {
    const reason = blocked[0] as EvalUnscoreableReason
    return {
      result: {
        ...base,
        ok: false,
        unscoreable: true,
        failures: [
          `${reason}: every artifact captured for this utterance comes from a source that cannot ` +
            "observe what the expectation asserts — the case is UNSCOREABLE, neither passed nor failed",
        ],
      },
      observations: envelopes.map((envelope) => ({
        expected: evalCase.kind === "refusal" ? null : evalCase.capability,
        observed: envelope.capability,
      })),
      unscoreable: reason,
    }
  }

  // Only artifacts that CAN answer the case are scored; a mixed set (one
  // audit-gold + one wire artifact for the same utterance) scores the ones
  // that can and ignores the ones that cannot, rather than discarding real
  // evidence because a weaker capture existed alongside it.
  const scoreable = envelopes.filter((envelope) => unscoreableReason(evalCase, envelope) === null)

  const observations: EvalObservation[] = scoreable.map((envelope) => ({
    expected: evalCase.kind === "refusal" ? null : evalCase.capability,
    observed: envelope.capability,
  }))

  const failures: string[] = []
  for (const envelope of scoreable) {
    if (evalCase.kind === "refusal") {
      if (envelope.capability !== null) {
        failures.push(
          `expected a REFUSAL (no capability parsed) but the captured parse selected ` +
            `"${envelope.capability}" (source ${envelope.source}, fixture ${envelope.fixtureId})`,
        )
      }
      continue
    }
    failures.push(...evaluateParseAgainstEnvelope(evalCase, envelope))
  }

  return {
    result: { ...base, ok: failures.length === 0, failures },
    observations,
    unscoreable: null,
  }
}

// ── Capability classification (per-capability + refusal precision/recall) ────

export interface EvalClassRow {
  /** A capability, or `EVAL_REFUSAL_CAPABILITY` for the ∅ (no-parse) class. */
  capability: string
  /** Observations whose EXPECTED class is this one (the support). */
  expected: number
  /** Observations whose OBSERVED class is this one. */
  observed: number
  truePositives: number
  falsePositives: number
  falseNegatives: number
  /** `tp / (tp + fp)`, `0` when the denominator is 0 (never NaN). */
  precision: number
  /** `tp / (tp + fn)`, `0` when the denominator is 0 (never NaN). */
  recall: number
}

function classKey(klass: string | null): string {
  return klass ?? EVAL_REFUSAL_CAPABILITY
}

/**
 * The per-class confusion matrix over the CAPABILITY the parse selected —
 * completely independent of slot accuracy. The ∅ class rides it as
 * `EVAL_REFUSAL_CAPABILITY`, so refusal precision/recall is not a bolted-on
 * special case but the same number computed the same way for every class.
 * Sorted by capability; ratios never NaN.
 */
export function computeClassification(
  observations: readonly EvalObservation[],
): EvalClassRow[] {
  const rows = new Map<string, { expected: number; observed: number; tp: number }>()
  const touch = (key: string): { expected: number; observed: number; tp: number } => {
    const existing = rows.get(key)
    if (existing !== undefined) return existing
    const created = { expected: 0, observed: 0, tp: 0 }
    rows.set(key, created)
    return created
  }

  for (const observation of observations) {
    const expectedKey = classKey(observation.expected)
    const observedKey = classKey(observation.observed)
    touch(expectedKey).expected += 1
    touch(observedKey).observed += 1
    if (expectedKey === observedKey) touch(expectedKey).tp += 1
  }

  return [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([capability, { expected, observed, tp }]) => ({
      capability,
      expected,
      observed,
      truePositives: tp,
      falsePositives: observed - tp,
      falseNegatives: expected - tp,
      precision: observed === 0 ? 0 : tp / observed,
      recall: expected === 0 ? 0 : tp / expected,
    }))
}

// ── The refusal / irrelevance category ──────────────────────────────────────

export interface EvalRefusalLeak {
  /** The capability a refusal-expected utterance leaked into. */
  capability: string
  /** How many observations leaked into it. */
  observations: number
}

export interface EvalRefusalCategory {
  /** Authored refusal cases in the pinned set (scoreable or not). */
  cases: number
  /** Of those, the ones an artifact existed for. */
  scored: number
  /** Of those, the ones with NO artifact (UNSCOREABLE). */
  unscoreable: number
  /** Refusal observations the parser correctly produced no capability for. */
  correctlyRefused: number
  /** Refusal observations that LEAKED into some capability (false positives). */
  leaked: number
  /** Parse observations whose parse produced no capability (false negatives). */
  wronglyRefused: number
  /** Parse observations that produced SOME capability (right or wrong). */
  parsed: number
  /** `correctlyRefused / (correctlyRefused + wronglyRefused)` — of everything
   *  the parser refused, how much SHOULD have been refused. */
  precision: number
  /** `correctlyRefused / (correctlyRefused + leaked)` — of everything that
   *  should have been refused, how much WAS. */
  recall: number
  /** Where the leaks went, sorted by capability. */
  leaksByCapability: EvalRefusalLeak[]
}

/**
 * The first-class refusal/irrelevance category. Computed from the SAME
 * observations the classification matrix uses — never from the extraction
 * pass/fail, which is a different question (a leaked greeting and a
 * mis-extracted slot are different defects and must never cancel out).
 */
export function computeRefusalCategory(
  outcomes: readonly EvalCaseOutcome[],
): EvalRefusalCategory {
  const refusalOutcomes = outcomes.filter((o) => o.result.capability === EVAL_REFUSAL_CAPABILITY)
  const unscoreable = refusalOutcomes.filter((o) => o.result.unscoreable === true).length

  let correctlyRefused = 0
  let leaked = 0
  let wronglyRefused = 0
  let parsed = 0
  const leaks = new Map<string, number>()

  for (const outcome of outcomes) {
    if (outcome.result.unscoreable === true) continue
    const isRefusalCase = outcome.result.capability === EVAL_REFUSAL_CAPABILITY
    for (const observation of outcome.observations) {
      if (isRefusalCase) {
        if (observation.observed === null) correctlyRefused += 1
        else {
          leaked += 1
          leaks.set(observation.observed, (leaks.get(observation.observed) ?? 0) + 1)
        }
      } else if (observation.observed === null) wronglyRefused += 1
      else parsed += 1
    }
  }

  const precisionDenominator = correctlyRefused + wronglyRefused
  const recallDenominator = correctlyRefused + leaked

  return {
    cases: refusalOutcomes.length,
    scored: refusalOutcomes.length - unscoreable,
    unscoreable,
    correctlyRefused,
    leaked,
    wronglyRefused,
    parsed,
    precision: precisionDenominator === 0 ? 0 : correctlyRefused / precisionDenominator,
    recall: recallDenominator === 0 ? 0 : correctlyRefused / recallDenominator,
    leaksByCapability: [...leaks.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([capability, observations]) => ({ capability, observations })),
  }
}

// ── Unscoreable roll-up ─────────────────────────────────────────────────────

export interface EvalUnscoreableRow {
  reason: EvalUnscoreableReason
  cases: number
}

export interface EvalUnscoreableSummary {
  total: number
  byReason: EvalUnscoreableRow[]
}

/** Roll the unscoreable cases up by reason, sorted by the declared reason order. */
export function computeUnscoreableSummary(
  outcomes: readonly EvalCaseOutcome[],
): EvalUnscoreableSummary {
  const counts = new Map<EvalUnscoreableReason, number>()
  for (const outcome of outcomes) {
    if (outcome.unscoreable === null) continue
    counts.set(outcome.unscoreable, (counts.get(outcome.unscoreable) ?? 0) + 1)
  }
  return {
    total: [...counts.values()].reduce((a, b) => a + b, 0),
    byReason: EVAL_UNSCOREABLE_REASONS.filter((reason) => counts.has(reason)).map((reason) => ({
      reason,
      cases: counts.get(reason) as number,
    })),
  }
}
