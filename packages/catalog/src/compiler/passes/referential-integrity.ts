// PASS 1 — REFERENTIAL INTEGRITY (LE2-016).
//
// Every cross-reference a catalog object carries resolves, and every name the
// catalog uses as an IDENTITY is unambiguous. Ticket 16's first rejection
// class: "referential breaks (dangling capability/claim/template references)".
//
// # This pass ABSORBS the cross-reference check v0
//
// LE2-014 shipped `build-gates/check-claim-references.ts` — one edge
// (`successClaimLinks` -> `CLAIM_CLASS_REFERENCES`) behind an EDGE-TABLE
// design chosen precisely so that "the claims-expansion workstream adds an
// edge … by appending one extractor, never by rewriting the gate". This pass
// is that generalization: the edge table moved HERE and grew the pack-id
// edges. `build-gates/check-claim-references.ts` now delegates to
// {@link findEdgeDanglers} over {@link CLAIM_REFERENCE_EDGES}, keeping its
// public API byte-identical (`findClaimReferenceDanglers`,
// `assertClaimReferencesResolve`, `CatalogCrossReferenceError`, the report
// format) — the v0 gate is subsumed, not duplicated and not weakened.
//
// # The two rule families
//
// OUTBOUND edges (`*-reference-dangling`) — a slot naming something defined
// elsewhere: a claim class the responder defines, a Pack that exists. The
// resolver is a vocabulary membership test.
//
// IDENTITY collisions (`duplicate-capability-kind`, `ambiguous-legacy-name`) —
// the INBOUND direction, and the one a per-object check can never see. A name
// the catalog uses to address an object must address exactly one:
// `generate-known-intent-kinds.ts` and friends project `kind`, and
// `generate-tool-to-intent-map.ts` INVERTS `legacyNames` into a
// name -> kind map. A collision does not throw there; it silently drops one
// side into a `Map` overwrite. That is exactly the class of fault this pass
// exists to make loud.
//
// # Layering
//
// A reference is only a REFERENCE if it is a string. A non-string in a
// reference slot (`successClaimLinks: [42]`) is a malformed SLOT — the
// slot-dataflow pass owns it. This pass still reports such a value as a
// dangler, deliberately: that is v0's behavior (`isClaimClassReference`
// accepts `unknown` and rejects a number), and narrowing it here would weaken
// the absorbed gate.
//
// Resolving a reference is NOT the same as being allowed to point at it. The
// safety pass rejects allergen/dietary edge targets that resolve here
// perfectly well.
//
// Pure: no clock, no RNG, no IO.

import {
  isClaimClassReference,
} from "../../claim-references.js"
import { CAPABILITY_PACK_IDS } from "../../capability-definitions/vocabularies.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import {
  capabilityObjectName,
  type CatalogDiagnostic,
  type CatalogPassResult,
} from "../diagnostics.js"
import { asRecord } from "../slots.js"

const PASS = "referential-integrity" as const

const PACK_ID_SET: ReadonlySet<string> = new Set<string>(CAPABILITY_PACK_IDS)

function isCapabilityPackId(value: unknown): boolean {
  return typeof value === "string" && PACK_ID_SET.has(value)
}

/**
 * One outbound reference edge: where the references live on a definition, and
 * which vocabulary resolves them. Adding an edge is adding an entry — the v0
 * design contract, preserved.
 */
export interface CatalogReferenceEdge {
  /** The slot the references live in. */
  readonly field: string
  /** The vocabulary they resolve against, NAMED for the failure message. */
  readonly vocabulary: string
  /** `true` when the slot is an array, so diagnostics carry a `[i]` suffix. */
  readonly indexed: boolean
  /** Every value the slot carries, in declaration order. Never throws. */
  readonly read: (def: CapabilityDefinition) => readonly unknown[]
  /** Does this value name something the vocabulary defines? */
  readonly resolves: (value: unknown) => boolean
  /** The actionable half of the failure message. */
  readonly hint: string
}

function readArraySlot(def: CapabilityDefinition, name: string): readonly unknown[] {
  const value = asRecord(def)[name]
  return Array.isArray(value) ? (value as readonly unknown[]) : []
}

function readScalarSlot(def: CapabilityDefinition, name: string): readonly unknown[] {
  const value = asRecord(def)[name]
  return value === undefined ? [] : [value]
}

/**
 * The CLAIM-space edges — the v0 table, moved here intact. Exported so the
 * back-compatible `build-gates/check-claim-references.ts` runs the SAME table
 * this pass runs (one table, two entry points; nothing to drift).
 *
 * Still exactly one entry, because there is still exactly one claim edge on
 * the definition contract. `REGISTRY_CLAIM_TYPE_REFERENCES` has a resolver
 * ready (`isRegistryClaimTypeReference`) and no slot points at it yet — wiring
 * a speculative edge would be a gate that checks nothing.
 */
export const CLAIM_REFERENCE_EDGES: readonly CatalogReferenceEdge[] = [
  {
    field: "successClaimLinks",
    vocabulary: "CLAIM_CLASS_REFERENCES",
    indexed: true,
    read: (def) => readArraySlot(def, "successClaimLinks"),
    resolves: isClaimClassReference,
    hint:
      "Correct the reference, or — if the claim genuinely exists now — add it to " +
      "src/claim-references.ts AND to the runtime source it mirrors " +
      "(apps/api/src/claustrum/ibatexas-responder.ts's SUCCESS_CLAIM_CLASSES).",
  },
]

/**
 * The PACK-space edges. `pack` is the owning Pack (a scalar); each
 * `plannerAdvertisedBy` entry is a Pack whose planner advertises this kind —
 * deliberately decoupled from ownership (a pack-ops planner advertises three
 * foreign-owned kinds), so both are genuine references, not a repeat of `pack`.
 */
export const PACK_REFERENCE_EDGES: readonly CatalogReferenceEdge[] = [
  {
    field: "pack",
    vocabulary: "CAPABILITY_PACK_IDS",
    indexed: false,
    read: (def) => readScalarSlot(def, "pack"),
    resolves: isCapabilityPackId,
    hint:
      "A capability must be owned by one of the six first-party Packs " +
      "(src/capability-definitions/vocabularies.ts).",
  },
  {
    field: "plannerAdvertisedBy",
    vocabulary: "CAPABILITY_PACK_IDS",
    indexed: true,
    read: (def) => readArraySlot(def, "plannerAdvertisedBy"),
    resolves: isCapabilityPackId,
    hint:
      "plannerAdvertisedBy names the Pack(s) whose CapabilityPlanner.plan() can " +
      "return this kind; every entry must be a real first-party Pack id.",
  },
]

/** Every outbound edge this pass resolves. */
export const REFERENCE_EDGES: readonly CatalogReferenceEdge[] = [
  ...CLAIM_REFERENCE_EDGES,
  ...PACK_REFERENCE_EDGES,
]

/** One unresolved reference, in the shape both entry points build from. */
export interface EdgeDangler {
  readonly kind: string
  readonly field: string
  /** Position within an array slot; `-1` for a scalar slot. */
  readonly index: number
  readonly reference: string
  readonly vocabulary: string
  readonly hint: string
}

/**
 * Every unresolved reference across `definitions` for `edges`, in definition
 * order then edge order then position — deterministic, so a CI log diff is
 * meaningful.
 */
export function findEdgeDanglers(
  definitions: readonly CapabilityDefinition[],
  edges: readonly CatalogReferenceEdge[],
): readonly EdgeDangler[] {
  const danglers: EdgeDangler[] = []
  for (const def of definitions) {
    const kind = asRecord(def)["kind"]
    for (const edge of edges) {
      const values = edge.read(def)
      for (const [index, value] of values.entries()) {
        if (edge.resolves(value)) continue
        danglers.push({
          kind: typeof kind === "string" ? kind : String(kind),
          field: edge.field,
          index: edge.indexed ? index : -1,
          reference: String(value),
          vocabulary: edge.vocabulary,
          hint: edge.hint,
        })
      }
    }
  }
  return danglers
}

/** How many references `edges` carry across `definitions` (the checked count). */
export function countEdgeReferences(
  definitions: readonly CapabilityDefinition[],
  edges: readonly CatalogReferenceEdge[],
): number {
  let checked = 0
  for (const def of definitions) {
    for (const edge of edges) checked += edge.read(def).length
  }
  return checked
}

function fieldPath(field: string, index: number): string {
  return index < 0 ? field : `${field}[${index}]`
}

/** Rule id for a dangling edge, derived from the slot it lives on. */
function danglingRuleFor(field: string): string {
  return field === "successClaimLinks"
    ? "claim-reference-dangling"
    : "pack-reference-dangling"
}

function danglerDiagnostics(
  definitions: readonly CapabilityDefinition[],
): readonly CatalogDiagnostic[] {
  const indexByKind = new Map<string, number>()
  definitions.forEach((def, i) => {
    const kind = asRecord(def)["kind"]
    if (typeof kind === "string" && !indexByKind.has(kind)) indexByKind.set(kind, i)
  })
  return findEdgeDanglers(definitions, REFERENCE_EDGES).map((d) => ({
    pass: PASS,
    rule: danglingRuleFor(d.field),
    severity: "error" as const,
    object: capabilityObjectName(d.kind, indexByKind.get(d.kind) ?? -1),
    field: fieldPath(d.field, d.index),
    message:
      `"${d.reference}" does not resolve against ${d.vocabulary}. ${d.hint}`,
    reference: d.reference,
  }))
}

/** Group array positions by the string value they hold. */
function groupByValue(
  definitions: readonly CapabilityDefinition[],
  slot: string,
): ReadonlyMap<string, readonly { kind: string; index: number; position: number }[]> {
  const byValue = new Map<string, { kind: string; index: number; position: number }[]>()
  definitions.forEach((def, index) => {
    const record = asRecord(def)
    const kind = record["kind"]
    const values = record[slot]
    if (!Array.isArray(values)) return
    values.forEach((value, position) => {
      if (typeof value !== "string") return
      const bucket = byValue.get(value) ?? []
      bucket.push({ kind: typeof kind === "string" ? kind : String(kind), index, position })
      byValue.set(value, bucket)
    })
  })
  return byValue
}

function duplicateKindDiagnostics(
  definitions: readonly CapabilityDefinition[],
): readonly CatalogDiagnostic[] {
  const positionsByKind = new Map<string, number[]>()
  definitions.forEach((def, index) => {
    const kind = asRecord(def)["kind"]
    if (typeof kind !== "string") return
    positionsByKind.set(kind, [...(positionsByKind.get(kind) ?? []), index])
  })
  const diagnostics: CatalogDiagnostic[] = []
  for (const [kind, positions] of positionsByKind) {
    if (positions.length < 2) continue
    for (const index of positions) {
      diagnostics.push({
        pass: PASS,
        rule: "duplicate-capability-kind",
        severity: "error",
        object: capabilityObjectName(kind, index),
        field: "kind",
        message:
          `"${kind}" is declared by ${positions.length} capabilities (array positions ` +
          `${positions.join(", ")}). A kind is the catalog's identity for a capability — ` +
          "every projection (KNOWN_INTENT_KINDS, the pack intent mirrors, the planner " +
          "allowlists) addresses it by that name, so a duplicate silently resolves to " +
          "whichever entry a consumer happens to reach first.",
        reference: kind,
      })
    }
  }
  return diagnostics
}

function ambiguousLegacyNameDiagnostics(
  definitions: readonly CapabilityDefinition[],
): readonly CatalogDiagnostic[] {
  const diagnostics: CatalogDiagnostic[] = []
  for (const [name, claimants] of groupByValue(definitions, "legacyNames")) {
    const kinds = [...new Set(claimants.map((c) => c.kind))]
    if (kinds.length < 2) continue
    for (const claimant of claimants) {
      diagnostics.push({
        pass: PASS,
        rule: "ambiguous-legacy-name",
        severity: "error",
        object: capabilityObjectName(claimant.kind, claimant.index),
        field: `legacyNames[${claimant.position}]`,
        message:
          `the tool name "${name}" is claimed by ${kinds.length} capabilities ` +
          `(${[...kinds].sort().join(", ")}). generate-tool-to-intent-map.ts INVERTS ` +
          "legacyNames into a name -> kind map, so a shared name silently drops all " +
          "but one claimant. Give the tool one owning capability.",
        reference: name,
      })
    }
  }
  return diagnostics
}

/**
 * Run the referential-integrity pass.
 *
 * `checked` counts every reference examined: the outbound edge values, plus
 * each capability's `kind` (checked for collision) — the identities and the
 * edges are both references, and both are what a non-vacuous run must have
 * looked at.
 */
export function runReferentialIntegrityPass(
  definitions: readonly CapabilityDefinition[],
): CatalogPassResult {
  const diagnostics = [
    ...danglerDiagnostics(definitions),
    ...duplicateKindDiagnostics(definitions),
    ...ambiguousLegacyNameDiagnostics(definitions),
  ]
  const legacyNameCount = definitions.reduce((n, def) => {
    const names = asRecord(def)["legacyNames"]
    return n + (Array.isArray(names) ? names.length : 0)
  }, 0)
  return {
    pass: PASS,
    checked:
      countEdgeReferences(definitions, REFERENCE_EDGES) +
      definitions.length +
      legacyNameCount,
    diagnostics,
  }
}
