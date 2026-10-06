// extraction/expect-payload.ts — compile a declarative `ExpectPayload` (an
// authored corpus case's assertion) into the SAME `PayloadPredicate` the
// oracle's `where` clause already consumes (FE-2.2 — "the load-bearing
// change that turns a decision-trajectory suite into an extraction suite").
//
// No new assertion MECHANISM: `matchTrajectory` (audit-trail-matcher.ts)
// already accepts `ExpectedTrajectoryStep.where: PayloadPredicate`; this
// module is a pure compiler in front of it, reading the Language Engine's
// materialized IR pair off `AuditRecord.metadata.languageEngine`
// (apps/api/src/claustrum/language-engine/audit-metadata.ts —
// `buildLanguageEngineAuditMetadata`, the FE-T05 v5 metadata sidecar). This
// package never imports that apps/api module (TEST-PLANE ONLY, check-bypass
// leg 6/7); the shape read here is a small, duplicated, structurally-typed
// mirror of its documented contract, not a compile-time dependency on it.

import type { PayloadPredicate } from "../oracle/audit-trail-matcher.js"
import type { ExpectPayload, FieldTrust, IrExpectation } from "./schema.js"

/**
 * The ONLY two fields `evaluateExpectPayload` ever reads off a record —
 * widened (LE2-05) from the concrete `AuditRecord` so the OFFLINE eval
 * harness (`eval-score.ts`) can score an artifact-derived envelope through
 * this SAME evaluator instead of fabricating a whole AuditRecord (and thus
 * a second, drifting copy of the expectation semantics). `AuditRecord`
 * satisfies this structurally, so every existing caller type-checks and
 * behaves byte-identically.
 */
export interface ExpectPayloadRecordLike {
  readonly metadata?: unknown
  readonly decision: { readonly kind: string }
}

/** Exact leaf comparison — the pre-LE2-05 behavior, and still the default. */
function exactEquals(actual: unknown, expected: unknown): boolean {
  return Object.is(actual, expected) || actual === expected
}

export interface EvaluateExpectPayloadOptions {
  /**
   * Leaf comparator for `payload` values. Default: {@link exactEquals} —
   * byte-identical to the pre-LE2-05 behavior for every existing caller
   * (the live accuracy runner and the oracle's compiled predicate).
   *
   * LE2-05 injects a STRUCTURAL comparator here (`structuralEquals` in
   * `eval-score.ts`: `deepEqualArgs` over formatting-normalized values) so
   * the offline harness tolerates formatting noise — casing, NFC form,
   * padding/inner whitespace — while staying intolerant of a wrong slot
   * value, and compares arrays/objects BY VALUE (the default comparator's
   * reference equality can never match a structured expectation).
   */
  equals?: (actual: unknown, expected: unknown) => boolean
}

/** Structural mirror of `FieldProvenance` (apps/api language-engine/field-trust.ts). */
interface FieldProvenanceLike {
  readonly trust?: unknown
}

/** Structural mirror of `ExtractionIR` / `HydratedIntentIR`. */
interface MaterializedIrLike {
  readonly payload?: Record<string, unknown>
  readonly provenance?: Readonly<Record<string, FieldProvenanceLike>>
  readonly confirmationRequired?: boolean
}

interface LanguageEngineMetadataLike {
  readonly extractionIR?: MaterializedIrLike
  readonly hydratedIntentIR?: MaterializedIrLike
}

/** Read `record.metadata.languageEngine`, tolerating any absent/malformed shape. */
function readLanguageEngineMetadata(
  record: ExpectPayloadRecordLike,
): LanguageEngineMetadataLike | undefined {
  const metadata = record.metadata as { languageEngine?: unknown } | undefined
  const le = metadata?.languageEngine
  if (le === null || typeof le !== "object") return undefined
  return le as LanguageEngineMetadataLike
}

/** One check's outcome + a human-readable reason (for authoring/debugging —
 *  the compiled `PayloadPredicate` collapses this to a bare boolean, but a
 *  case author or CI log benefits from knowing WHICH clause failed). */
export interface ExpectPayloadEvaluation {
  readonly ok: boolean
  readonly failures: readonly string[]
}

function evaluateIr(
  label: "extractionIR" | "hydratedIntentIR",
  expected: IrExpectation,
  actual: MaterializedIrLike | undefined,
  equals: (actual: unknown, expected: unknown) => boolean,
): string[] {
  const failures: string[] = []
  if (actual === undefined) {
    failures.push(`${label}: absent from record.metadata.languageEngine`)
    return failures
  }
  const actualPayload = actual.payload ?? {}

  if (expected.payload !== undefined) {
    for (const [key, value] of Object.entries(expected.payload)) {
      if (!equals(actualPayload[key], value)) {
        failures.push(
          `${label}.payload.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actualPayload[key])}`,
        )
      }
    }
  }

  // Default true for extractionIR (FE-2.2's core claim — "the model
  // extracted ONLY these fields"); an author opts OUT per-case via
  // `payloadExactKeys: false`. hydratedIntentIR defaults to false (its
  // payload legitimately carries resolver-stamped fields a case may not
  // want to enumerate exhaustively) unless the author opts IN.
  const wantExactKeys = expected.payloadExactKeys ?? (label === "extractionIR")
  if (wantExactKeys && expected.payload !== undefined) {
    const expectedKeys = Object.keys(expected.payload).sort()
    const actualKeys = Object.keys(actualPayload).sort()
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
      failures.push(
        `${label}.payload keys: expected exactly [${expectedKeys.join(", ")}], got [${actualKeys.join(", ")}]`,
      )
    }
  }

  if (expected.payloadPresent !== undefined) {
    for (const key of expected.payloadPresent) {
      const value = actualPayload[key]
      if (typeof value !== "string" || value.length === 0) {
        failures.push(`${label}.payload.${key}: expected present (non-empty), got ${JSON.stringify(value)}`)
      }
    }
  }

  if (expected.provenanceTrust !== undefined) {
    for (const [key, trust] of Object.entries(expected.provenanceTrust) as Array<[string, FieldTrust]>) {
      const actualTrust = actual.provenance?.[key]?.trust
      if (actualTrust !== trust) {
        failures.push(`${label}.provenance.${key}.trust: expected "${trust}", got ${JSON.stringify(actualTrust)}`)
      }
    }
  }

  return failures
}

/**
 * Evaluate an `ExpectPayload` against one record — an `AuditRecord` from a
 * live drive, or (LE2-05) any {@link ExpectPayloadRecordLike} the offline
 * harness reconstructs from a pinned artifact — returning per-check failures
 * (empty when everything the case declared matches). Pure.
 */
export function evaluateExpectPayload(
  expected: ExpectPayload,
  record: ExpectPayloadRecordLike,
  options: EvaluateExpectPayloadOptions = {},
): ExpectPayloadEvaluation {
  const equals = options.equals ?? exactEquals
  const le = readLanguageEngineMetadata(record)
  if (le === undefined) {
    return { ok: false, failures: ["record.metadata.languageEngine is absent"] }
  }

  const failures = [...evaluateIr("extractionIR", expected.extractionIR, le.extractionIR, equals)]

  if (expected.hydratedIntentIR !== undefined) {
    failures.push(
      ...evaluateIr("hydratedIntentIR", expected.hydratedIntentIR, le.hydratedIntentIR, equals),
    )
    if (expected.hydratedIntentIR.confirmationRequired !== undefined) {
      const actual = le.hydratedIntentIR?.confirmationRequired
      if (actual !== expected.hydratedIntentIR.confirmationRequired) {
        failures.push(
          `hydratedIntentIR.confirmationRequired: expected ${expected.hydratedIntentIR.confirmationRequired}, got ${JSON.stringify(actual)}`,
        )
      }
    }
  }

  // FE-T10 — the kernel-level decision assertion (see schema.ts's
  // ExpectPayloadSchema doc for why this is distinct from
  // hydratedIntentIR.confirmationRequired). Absent `expected.decision` (every
  // pre-FE-T10 case) runs no check — byte-identical to before.
  if (expected.decision !== undefined) {
    const actualKind = record.decision.kind
    if (actualKind !== expected.decision) {
      failures.push(`decision.kind: expected "${expected.decision}", got ${JSON.stringify(actualKind)}`)
    }
  }

  return { ok: failures.length === 0, failures }
}

/**
 * Compile a declarative `ExpectPayload` into the `PayloadPredicate` shape
 * `ExpectedTrajectoryStep.where` consumes (audit-trail-matcher.ts) — the
 * FE-2.2 load-bearing wiring. The richer per-clause diagnostics
 * (`evaluateExpectPayload`) are available separately for authoring/CI-log
 * purposes; the compiled predicate itself is a bare boolean, matching the
 * oracle's existing contract exactly (no new assertion mechanism).
 */
export function compileExpectPayload(expected: ExpectPayload): PayloadPredicate {
  return (_payload, record) => evaluateExpectPayload(expected, record).ok
}
