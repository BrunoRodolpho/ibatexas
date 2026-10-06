// CROSS-REFERENCE CHECK v0 — capability -> claim references resolve.
//
// LE2 Implementation Decision 13 asks the catalog to hold "capability
// definitions and claim-registry references ... with cross-reference checks".
// This is that check, at its v0 scope: every claim reference a
// `CapabilityDefinition` carries must name a claim the runtime actually
// defines. A DANGLER — a link to a claim id nothing defines — fails the
// catalog's build.
//
// # ABSORBED by the catalog compiler (LE2-016) — this module is the v0 API
//
// The v0 gate was written against a REFERENCE-EXTRACTOR table rather than one
// hard-coded field, precisely so the check could grow "by appending one
// extractor, never by rewriting the gate". LE2-016 collected that growth: the
// edge table now lives in `../compiler/passes/referential-integrity.ts` (where
// it gained the pack-id edges), and this module is a THIN ADAPTER over the
// same table — the compiler's referential pass and the functions below run the
// identical `CLAIM_REFERENCE_EDGES` array, so there is nothing to drift.
//
// Nothing here changed shape or behavior. `findClaimReferenceDanglers`,
// `assertClaimReferencesResolve`, `formatClaimReferenceReport` and
// `CatalogCrossReferenceError` keep their exact v0 signatures, message format,
// and semantics (a non-string in a reference slot is still reported as a
// dangler — `isClaimClassReference` accepts `unknown`), so every caller and
// the `src/__tests__/claim-references.test.ts` pins stay valid.
//
// What DID change is where the failure surfaces first: the package build now
// runs `scripts/check-catalog.ts` (all four static passes), which subsumes
// this check. `pnpm --filter @ibatexas/catalog run check:claim-refs` still
// runs the v0 check alone, and the compiler's `referential-integrity` pass
// reports the same faults as structured diagnostics.
//
// This does NOT replace `apps/api/src/claustrum/__tests__/capability-
// definitions.success-claim-round-trip.test.ts`. That test checks the same
// invariant against the LIVE `SUCCESS_CLAIM_CLASSES` export (and the reverse
// direction, and the two hand-verified exclusions); it is the pin that keeps
// this package's `CLAIM_CLASS_REFERENCES` mirror honest. This gate is the
// cheap, early, dependency-free half that runs where the data lives.
//
// Pure: no clock, no RNG, no IO.

import {
  CLAIM_CLASS_REFERENCES,
  isRegistryClaimTypeReference,
  REGISTRY_CLAIM_TYPE_REFERENCES,
} from "../claim-references.js"
import {
  CLAIM_REFERENCE_EDGES,
  countEdgeReferences,
  findEdgeDanglers,
} from "../compiler/passes/referential-integrity.js"
import type { CapabilityDefinition } from "../capability-definitions/types.js"

/** One unresolved claim reference found on a capability definition. */
export interface ClaimReferenceDangler {
  /** The `CapabilityDefinition.kind` carrying the bad reference. */
  readonly kind: string
  /** The definition field the reference came from. */
  readonly field: string
  /** The reference that resolved to nothing. */
  readonly reference: string
  /** The vocabulary it was checked against (named, for the failure message). */
  readonly vocabulary: string
}

/**
 * Every unresolved claim reference across `definitions`, in definition order
 * then field order (deterministic — the failure message must be stable so a
 * CI log diff is meaningful). Empty array means the catalog is coherent.
 */
export function findClaimReferenceDanglers(
  definitions: readonly CapabilityDefinition[],
): readonly ClaimReferenceDangler[] {
  return findEdgeDanglers(definitions, CLAIM_REFERENCE_EDGES).map(
    ({ kind, field, reference, vocabulary }) => ({
      kind,
      field,
      reference,
      vocabulary,
    }),
  )
}

/** The human-readable failure report for a non-empty dangler list. */
export function formatClaimReferenceReport(
  danglers: readonly ClaimReferenceDangler[],
): string {
  const lines = danglers.map(
    (d) =>
      `  - "${d.kind}".${d.field} -> "${d.reference}" does not resolve against ${d.vocabulary}`,
  )
  return [
    `[catalog] cross-reference check FAILED — ${danglers.length} dangling claim reference(s):`,
    ...lines,
    "",
    "Every claim reference on a capability definition must name a claim the runtime defines.",
    "Fix by either (a) correcting the reference in src/capability-definitions/definitions.ts,",
    "or (b) — if the claim genuinely exists now — adding it to src/claim-references.ts AND to",
    "the runtime source it mirrors (apps/api/src/claustrum/ibatexas-responder.ts's",
    "SUCCESS_CLAIM_CLASSES), which the apps/api round-trip test pins in both directions.",
  ].join("\n")
}

/** Thrown by {@link assertClaimReferencesResolve} when a dangler exists. */
export class CatalogCrossReferenceError extends Error {
  readonly danglers: readonly ClaimReferenceDangler[]

  constructor(danglers: readonly ClaimReferenceDangler[]) {
    super(formatClaimReferenceReport(danglers))
    this.name = "CatalogCrossReferenceError"
    this.danglers = danglers
  }
}

/**
 * Fail-closed assertion: throws {@link CatalogCrossReferenceError} on the first
 * build where any capability points at a claim that does not exist. Returns the
 * number of references CHECKED on success — a non-zero count is the proof the
 * gate actually looked at something (a gate that silently checks nothing is the
 * failure mode the FE-4 freshness work called "generated-vs-generated").
 */
export function assertClaimReferencesResolve(
  definitions: readonly CapabilityDefinition[],
): number {
  const danglers = findClaimReferenceDanglers(definitions)
  if (danglers.length > 0) throw new CatalogCrossReferenceError(danglers)
  return countEdgeReferences(definitions, CLAIM_REFERENCE_EDGES)
}

/** The vocabularies this gate resolves against, for the runner's summary. */
export const CHECKED_VOCABULARIES = {
  CLAIM_CLASS_REFERENCES,
  REGISTRY_CLAIM_TYPE_REFERENCES,
} as const

/**
 * Exported so a future edge into the registry-type name space has its resolver
 * already named and tested. Not referenced by `CLAIM_REFERENCE_EDGES` today —
 * no definition field points at that name space yet (see claim-references.ts).
 */
export const registryClaimTypeResolver = isRegistryClaimTypeReference
