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

import type { AuditRecord } from "@adjudicate/core"
import type { PayloadPredicate } from "../oracle/audit-trail-matcher.js"
import type { ExpectPayload, FieldTrust, IrExpectation } from "./schema.js"

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
function readLanguageEngineMetadata(record: AuditRecord): LanguageEngineMetadataLike | undefined {
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
): string[] {
  const failures: string[] = []
  if (actual === undefined) {
    failures.push(`${label}: absent from record.metadata.languageEngine`)
    return failures
  }
  const actualPayload = actual.payload ?? {}

  if (expected.payload !== undefined) {
    for (const [key, value] of Object.entries(expected.payload)) {
      if (!Object.is(actualPayload[key], value) && actualPayload[key] !== value) {
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
 * Evaluate an `ExpectPayload` against one `AuditRecord`, returning per-check
 * failures (empty when everything the case declared matches). Pure.
 */
export function evaluateExpectPayload(expected: ExpectPayload, record: AuditRecord): ExpectPayloadEvaluation {
  const le = readLanguageEngineMetadata(record)
  if (le === undefined) {
    return { ok: false, failures: ["record.metadata.languageEngine is absent"] }
  }

  const failures = [...evaluateIr("extractionIR", expected.extractionIR, le.extractionIR)]

  if (expected.hydratedIntentIR !== undefined) {
    failures.push(...evaluateIr("hydratedIntentIR", expected.hydratedIntentIR, le.hydratedIntentIR))
    if (expected.hydratedIntentIR.confirmationRequired !== undefined) {
      const actual = le.hydratedIntentIR?.confirmationRequired
      if (actual !== expected.hydratedIntentIR.confirmationRequired) {
        failures.push(
          `hydratedIntentIR.confirmationRequired: expected ${expected.hydratedIntentIR.confirmationRequired}, got ${JSON.stringify(actual)}`,
        )
      }
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
