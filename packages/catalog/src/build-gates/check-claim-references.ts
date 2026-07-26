// CROSS-REFERENCE CHECK v0 — capability -> claim references resolve.
//
// LE2 Implementation Decision 13 asks the catalog to hold "capability
// definitions and claim-registry references ... with cross-reference checks".
// This is that check, at its v0 scope: every claim reference a
// `CapabilityDefinition` carries must name a claim the runtime actually
// defines. A DANGLER — a link to a claim id nothing defines — fails the
// catalog's build.
//
// # Why a build gate and not (only) a test
//
// The repo's existing idiom for "this data must stay consistent with that
// data" is a fail-closed gate rather than a hope: the capability-definitions
// freshness gates, the roster-integrity pins, and `toolRosterDrift()` running
// fail-closed at boot in `claustrum-bootstrap.ts`. A dangling claim link is
// the same class of fault — a generated/derived surface silently pointing at
// nothing — so it gets the same treatment. Wiring it into `pnpm build` means a
// broken catalog cannot even produce a `dist/` for a downstream package to
// consume, which is strictly earlier than a test failure.
//
// This does NOT replace `apps/api/src/claustrum/__tests__/capability-
// definitions.success-claim-round-trip.test.ts`. That test checks the same
// invariant against the LIVE `SUCCESS_CLAIM_CLASSES` export (and the reverse
// direction, and the two hand-verified exclusions); it is the pin that keeps
// this package's `CLAIM_CLASS_REFERENCES` mirror honest. This gate is the
// cheap, early, dependency-free half that runs where the data lives.
//
// # v0 scope
//
// v0 checks the ONE capability->claim edge that exists today:
// `CapabilityDefinition.successClaimLinks` -> `CLAIM_CLASS_REFERENCES`. The
// checker is written against a REFERENCE-EXTRACTOR list rather than that one
// field, so the claims-expansion workstream adds an edge (e.g. a future
// registry-claim-type field -> `REGISTRY_CLAIM_TYPE_REFERENCES`) by appending
// one extractor, never by rewriting the gate. Nothing speculative is wired
// today — there is exactly one extractor below because there is exactly one
// edge.
//
// Pure: no clock, no RNG, no IO. `scripts/check-claim-references.ts` is the
// thin process-exiting runner.

import {
  CLAIM_CLASS_REFERENCES,
  isClaimClassReference,
  isRegistryClaimTypeReference,
  REGISTRY_CLAIM_TYPE_REFERENCES,
} from "../claim-references.js"
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
 * One capability->claim edge: where the references live on a definition, and
 * which vocabulary resolves them. Adding an edge is adding an entry here.
 */
interface ClaimReferenceEdge {
  readonly field: string
  readonly vocabulary: string
  readonly read: (def: CapabilityDefinition) => readonly string[]
  readonly resolves: (reference: string) => boolean
}

const EDGES: readonly ClaimReferenceEdge[] = [
  {
    field: "successClaimLinks",
    vocabulary: "CLAIM_CLASS_REFERENCES",
    read: (def) => def.successClaimLinks ?? [],
    resolves: isClaimClassReference,
  },
]

/**
 * Every unresolved claim reference across `definitions`, in definition order
 * then field order (deterministic — the failure message must be stable so a
 * CI log diff is meaningful). Empty array means the catalog is coherent.
 */
export function findClaimReferenceDanglers(
  definitions: readonly CapabilityDefinition[],
): readonly ClaimReferenceDangler[] {
  const danglers: ClaimReferenceDangler[] = []
  for (const def of definitions) {
    for (const edge of EDGES) {
      for (const reference of edge.read(def)) {
        if (!edge.resolves(reference)) {
          danglers.push({
            kind: def.kind,
            field: edge.field,
            reference,
            vocabulary: edge.vocabulary,
          })
        }
      }
    }
  }
  return danglers
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
  let checked = 0
  for (const def of definitions) {
    for (const edge of EDGES) checked += edge.read(def).length
  }
  return checked
}

/** The vocabularies this gate resolves against, for the runner's summary. */
export const CHECKED_VOCABULARIES = {
  CLAIM_CLASS_REFERENCES,
  REGISTRY_CLAIM_TYPE_REFERENCES,
} as const

/**
 * Exported so a future edge into the registry-type name space has its resolver
 * already named and tested. Not referenced by {@link EDGES} today — no
 * definition field points at that name space yet (see claim-references.ts).
 */
export const registryClaimTypeResolver = isRegistryClaimTypeReference
