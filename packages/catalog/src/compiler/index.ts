// The CATALOG COMPILER — static passes over the authored catalog (LE2-016).
//
// LE2 Implementation Decision 16: "**The catalog compiler is fully
// fail-closed.** Static passes (referential integrity, compensation
// completeness, slot dataflow, safety invariants, terminal coverage, graph
// shape, lifecycle) are compile/CI errors."
//
// LE2-016 landed the four passes the catalog's CURRENT data can carry, and
// LE2-018 added the fifth:
//
//   1. `referential-integrity`      — every cross-reference resolves; every
//                                     identity is unambiguous
//   2. `slot-dataflow`              — every declared slot is well-formed
//   3. `safety-implication-edges`   — the ratified BKL-143/123/171 rulings
//   4. `terminal-coverage`          — declared terminals are complete
//   5. `external-references`        — the declaration table is well-formed and
//                                     its consumers resolve (LE2-018)
//
// LE2-033 added the sixth, slotted after `slot-dataflow`:
//
//   6. `conversation-projection`    — the authored pt-BR trigger phrasings are
//                                     well-formed and no two capabilities
//                                     claim the same one
//
// Compensation completeness, graph shape and lifecycle are journey-shaped
// (tickets 20/22 add the objects AND the passes together).
//
// Pass 5 is the STATIC HALF of LE2-018 and only that half. The declaration
// table says which promotions and zones the code depends on; whether they
// EXIST is a live-store question, answered by `@ibatexas/tools`' reconciler at
// the api's boot gate and behind `ibx catalog check --live`. This module still
// performs no IO, and the day it does the catalog has stopped being a catalog.
//
// # The compiler is a BUILD tool, not a runtime authority
//
// The package's one rule ("the catalog defines; it never holds runtime
// authority") applies to the compiler most of all. Everything here is a pure
// function over the array it is handed: no clock, no RNG, no IO, no imports of
// anything that has any. Nothing at request time calls it. It runs in
// `pnpm --filter @ibatexas/catalog build`, in CI, and behind `ibx catalog
// check` — a catalog that does not compile cannot produce a `dist/` for any
// downstream package to consume, which is strictly earlier than a test.
//
// # Fail-closed means all passes run
//
// {@link compileCatalog} runs EVERY pass even after one rejects, and reports
// all of them. A compiler that stops at the first failing pass turns one bad
// commit into N build/fix cycles, and — worse for a safety pass — can hide an
// allergen-edge violation behind an unrelated typo. Fail-closed is about the
// EXIT CODE, not about how little the tool is willing to tell you.

import type { CapabilityDefinition } from "../capability-definitions/types.js"
import {
  EXTERNAL_REFERENCES,
  type ExternalReferenceDeclaration,
} from "../external-references.js"
import { CATALOG_VERSION } from "../version.js"
import {
  CATALOG_PASS_IDS,
  formatDiagnostic,
  sortDiagnostics,
  type CatalogDiagnostic,
  type CatalogPassId,
  type CatalogPassResult,
} from "./diagnostics.js"
import { runConversationProjectionPass } from "./passes/conversation-projection.js"
import { runExternalReferencesPass } from "./passes/external-references.js"
import { runReferentialIntegrityPass } from "./passes/referential-integrity.js"
import { runSafetyImplicationEdgesPass } from "./passes/safety-implication-edges.js"
import { runSlotDataflowPass } from "./passes/slot-dataflow.js"
import { runTerminalCoveragePass } from "./passes/terminal-coverage.js"

export {
  CATALOG_PASS_IDS,
  capabilityObjectName,
  externalReferenceObjectName,
  formatDiagnostic,
  packObjectName,
  sortDiagnostics,
  type CatalogDiagnostic,
  type CatalogDiagnosticSeverity,
  type CatalogPassId,
  type CatalogPassResult,
} from "./diagnostics.js"
export {
  ALLERGEN_MARKERS,
  DIETARY_RESTRICTION_MARKERS,
  normalizeReference,
  safetyMarkerOf,
  SAFETY_MARKERS,
  type SafetyFamily,
  type SafetyMarker,
} from "./safety-markers.js"
export {
  CLAIM_REFERENCE_EDGES,
  countEdgeReferences,
  findEdgeDanglers,
  PACK_REFERENCE_EDGES,
  REFERENCE_EDGES,
  runReferentialIntegrityPass,
  type CatalogReferenceEdge,
  type EdgeDangler,
} from "./passes/referential-integrity.js"
export { runConversationProjectionPass } from "./passes/conversation-projection.js"
export { runExternalReferencesPass } from "./passes/external-references.js"
export { runSafetyImplicationEdgesPass } from "./passes/safety-implication-edges.js"
export { runSlotDataflowPass } from "./passes/slot-dataflow.js"
export { runTerminalCoveragePass } from "./passes/terminal-coverage.js"
export { SLOT_SPECS, type SlotKind, type SlotSpec } from "./slots.js"

/**
 * One registered static pass.
 *
 * A pass receives the WHOLE authored catalog — the capability definitions and
 * the external-reference declarations — and takes what it needs. Four of the
 * five ignore the second argument entirely (JS arity makes that free, and a
 * one-argument pass function stays assignable), which keeps the fact that only
 * `external-references` reads the declaration table visible in its signature
 * rather than buried in a shared context object.
 */
export interface CatalogPass {
  readonly id: CatalogPassId
  /** One line, dev/CI English (the repo's convention for tooling output). */
  readonly summary: string
  readonly run: (
    definitions: readonly CapabilityDefinition[],
    externalReferences: readonly ExternalReferenceDeclaration[],
  ) => CatalogPassResult
}

/**
 * The registered passes, in execution and report order. The order is
 * COHERENCE-FIRST on purpose — referential and slot faults are the ones that
 * make later diagnostics confusing, so they are reported above the safety and
 * terminal findings. It carries no dependency: every pass is independent and
 * all of them run regardless of what the ones before found.
 */
export const CATALOG_PASSES = [
  {
    id: "referential-integrity",
    summary: "every cross-reference resolves and every identity is unambiguous",
    run: runReferentialIntegrityPass,
  },
  {
    id: "slot-dataflow",
    summary: "every declared slot is well-formed for its tier contract",
    run: runSlotDataflowPass,
  },
  {
    id: "conversation-projection",
    summary: "trigger phrasings are well-formed and no two capabilities share one",
    run: runConversationProjectionPass,
  },
  {
    id: "safety-implication-edges",
    summary: "no claim edge terminates in an allergen/dietary attribute (BKL-143/123/171)",
    run: runSafetyImplicationEdgesPass,
  },
  {
    id: "terminal-coverage",
    summary: "declared terminals are complete and pack-coherent",
    run: runTerminalCoveragePass,
  },
  {
    id: "external-references",
    summary: "every declared external reference is well-formed and consumer-attributed",
    run: runExternalReferencesPass,
  },
] as const satisfies readonly CatalogPass[]

// Compile-time proof that every declared pass id is REGISTERED. A pass added
// to `CATALOG_PASS_IDS` and forgotten here would be a rejection class the
// compiler advertises (and stable-sorts for) and never actually runs.
type UnregisteredPass = Exclude<CatalogPassId, (typeof CATALOG_PASSES)[number]["id"]>
const _PASSES_REGISTERED: UnregisteredPass extends never ? true : UnregisteredPass = true
void _PASSES_REGISTERED

/** The compiler's verdict on one catalog. */
export interface CatalogCompileResult {
  /** `true` when every pass is satisfied. */
  readonly ok: boolean
  /** The catalog serial this build compiled under (`CATALOG_VERSION`). */
  readonly catalogVersion: number
  /** How many capability definitions were compiled. */
  readonly capabilities: number
  /** How many external-reference declarations were compiled (LE2-018). */
  readonly externalReferences: number
  /** Per-pass results, in {@link CATALOG_PASSES} order. */
  readonly passes: readonly CatalogPassResult[]
  /** Every diagnostic, flattened and stable-ordered. */
  readonly diagnostics: readonly CatalogDiagnostic[]
}

/**
 * Run every static pass over the authored catalog. Pure and total — it never
 * throws on bad data; a malformed catalog comes back as diagnostics, which is
 * what makes the same function usable from a build gate, the CLI, and a
 * fixture test.
 *
 * `externalReferences` defaults to the REAL authored table rather than to `[]`.
 * The asymmetry with `definitions` is deliberate and fail-closed: a production
 * caller that forgot the argument would otherwise compile zero declarations
 * and report a green `external-references` pass over nothing — a vacuous gate,
 * the exact failure mode `checked` exists to expose. Fixtures pass their own
 * (usually empty) table explicitly, so the default never leaks real data into
 * a pinned golden.
 */
export function compileCatalog(
  definitions: readonly CapabilityDefinition[],
  externalReferences: readonly ExternalReferenceDeclaration[] = EXTERNAL_REFERENCES,
): CatalogCompileResult {
  const passes = CATALOG_PASSES.map((pass) => {
    const result = pass.run(definitions, externalReferences)
    return { ...result, diagnostics: sortDiagnostics(result.diagnostics) }
  })
  const diagnostics = sortDiagnostics(passes.flatMap((p) => p.diagnostics))
  return {
    ok: diagnostics.length === 0,
    catalogVersion: CATALOG_VERSION,
    capabilities: definitions.length,
    externalReferences: externalReferences.length,
    passes,
    diagnostics,
  }
}

/** The human-readable report for a compile result — clean or not. */
export function formatCatalogReport(result: CatalogCompileResult): string {
  const header = result.ok
    ? `[catalog] catalog check OK — v${result.catalogVersion}: ` +
      `${result.capabilities} capability definition(s), ` +
      `${result.externalReferences} external reference(s), ` +
      `${result.passes.length} static pass(es), 0 diagnostics.`
    : `[catalog] catalog check FAILED — v${result.catalogVersion}: ` +
      `${result.diagnostics.length} diagnostic(s) across ` +
      `${result.passes.filter((p) => p.diagnostics.length > 0).length} of ` +
      `${result.passes.length} static pass(es).`

  const lines: string[] = [header]
  for (const pass of result.passes) {
    const status = pass.diagnostics.length === 0 ? "OK" : `${pass.diagnostics.length} error(s)`
    lines.push(`  ${pass.diagnostics.length === 0 ? "✓" : "✗"} ${pass.pass} — ${status} (${pass.checked} checked)`)
    for (const d of pass.diagnostics) lines.push(`      ${formatDiagnostic(d)}`)
  }
  if (!result.ok) {
    lines.push(
      "",
      "A catalog that does not compile cannot build. Fix the authored data in " +
        "packages/catalog/src/ — never the pass — or, if a diagnostic is wrong, change " +
        "the rule deliberately and say why.",
    )
  }
  return lines.join("\n")
}

/** Thrown by {@link assertCatalogCompiles} when any pass rejects. */
export class CatalogCompileError extends Error {
  readonly result: CatalogCompileResult

  constructor(result: CatalogCompileResult) {
    super(formatCatalogReport(result))
    this.name = "CatalogCompileError"
    this.result = result
  }
}

/**
 * Fail-closed assertion: throws {@link CatalogCompileError} when any pass
 * rejects, and otherwise returns the clean result (whose per-pass `checked`
 * counts are the proof the passes actually looked at something).
 */
export function assertCatalogCompiles(
  definitions: readonly CapabilityDefinition[],
  externalReferences?: readonly ExternalReferenceDeclaration[],
): CatalogCompileResult {
  const result = compileCatalog(definitions, externalReferences)
  if (!result.ok) throw new CatalogCompileError(result)
  return result
}
