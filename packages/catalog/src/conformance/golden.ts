// The GOLDEN shape and its canonical serialization (LE2-017).
//
// LE2 Testing Decisions pin the catalog compiler to the golden/freshness/drift
// idiom, and LE2-016 built the diagnostic list to be TOTALLY ORDERED precisely
// so a golden could be byte-identical rather than fuzzy. This module is the
// one place that turns a compile result into those bytes.
//
// # What the golden pins, and what it deliberately does not
//
// PINNED: `ok`, the per-pass `checked` counts and diagnostic counts, every
// diagnostic field (pass, rule, severity, object, field, message, reference),
// the diagnostic ORDER exactly as the compiler emitted it, and each
// diagnostic's one-line `formatDiagnostic` rendering — the whole build-log UX.
//
// NOT PINNED: `catalogVersion`. It is the catalog's serial, not the compiler's
// diagnostic contract, and a fixture catalog is not the catalog. Including it
// would turn every version bump into a twenty-file golden regeneration whose
// diff carries no signal — the exact noise that teaches people to regenerate
// goldens without reading them.
//
// # The one normalization, and why it is not papering over anything
//
// Diagnostics are re-serialized with their fields in a FIXED KEY ORDER. JSON
// key order is an artifact of the order a pass happens to spell its object
// literal (`reference` sits in a different position in each pass); it is not
// part of the contract, and pinning it would make an editorial reshuffle look
// like a behavior change. The ARRAY order — the total order LE2-016
// guarantees — is written exactly as `compileCatalog` returned it. The suite
// never sorts, filters, or normalizes the diagnostics themselves; if the order
// ever wobbles, the golden must fail.
//
// Pure over its inputs, apart from the path helpers.

import { fileURLToPath } from "node:url"

import {
  CATALOG_PASS_IDS,
  compileCatalog,
  formatDiagnostic,
  type CatalogDiagnostic,
} from "../compiler/index.js"
import { scanPassRuleInventory, type PassRuleInventory } from "./rule-inventory.js"
import { ruleId, type ConformanceFixture } from "./types.js"

/** One diagnostic, re-serialized in a fixed key order. */
export interface GoldenDiagnostic {
  readonly pass: string
  readonly rule: string
  readonly severity: string
  readonly object: string
  readonly field: string
  readonly message: string
  readonly reference?: string
}

/** One pass's outcome over one fixture. */
export interface GoldenPass {
  readonly pass: string
  readonly checked: number
  readonly diagnostics: number
}

/** One fixture's pinned compiler output. */
export interface ConformanceGolden {
  readonly fixture: string
  /** The rule the fixture exists to prove; `null` for a clean fixture. */
  readonly targets: string | null
  readonly ok: boolean
  readonly capabilities: number
  /** Every `<pass>/<rule>` the fixture actually emitted, sorted. */
  readonly rulesEmitted: readonly string[]
  readonly passes: readonly GoldenPass[]
  readonly diagnostics: readonly GoldenDiagnostic[]
  /** `formatDiagnostic` over the same list, in the same order. */
  readonly formatted: readonly string[]
}

/** The pinned inventory of passes and rule ids, in pass-registration order. */
export interface InventoryGolden {
  readonly passes: readonly PassRuleInventory[]
  readonly ruleCount: number
}

/** Where the committed goldens live. */
export const GOLDEN_DIR = fileURLToPath(new URL("./__golden__/", import.meta.url))

/** The golden file for one fixture. */
export function goldenPath(fixtureName: string): string {
  return `${GOLDEN_DIR}${fixtureName}.json`
}

/** The basename (with extension) of one fixture's golden. */
export function goldenFileName(fixtureName: string): string {
  return `${fixtureName}.json`
}

/** The pass/rule inventory golden's file name. */
export const INVENTORY_GOLDEN_NAME = "pass-rule-inventory"

function canonicalDiagnostic(diagnostic: CatalogDiagnostic): GoldenDiagnostic {
  return {
    pass: diagnostic.pass,
    rule: diagnostic.rule,
    severity: diagnostic.severity,
    object: diagnostic.object,
    field: diagnostic.field,
    message: diagnostic.message,
    ...(diagnostic.reference === undefined ? {} : { reference: diagnostic.reference }),
  }
}

/** Compile one fixture and shape its result as a golden. */
export function computeGolden(fixture: ConformanceFixture): ConformanceGolden {
  const result = compileCatalog(fixture.definitions)
  return {
    fixture: fixture.name,
    targets: fixture.targets,
    ok: result.ok,
    capabilities: result.capabilities,
    rulesEmitted: [...new Set(result.diagnostics.map(ruleId))].sort(),
    passes: result.passes.map((pass) => ({
      pass: pass.pass,
      checked: pass.checked,
      diagnostics: pass.diagnostics.length,
    })),
    diagnostics: result.diagnostics.map(canonicalDiagnostic),
    formatted: result.diagnostics.map(formatDiagnostic),
  }
}

/**
 * The pass/rule inventory as a golden — ordered by {@link CATALOG_PASS_IDS} so
 * the file reads in the compiler's own execution order, with any pass the
 * scanner found that is NOT registered sorted after them (where it is
 * immediately visible; the meta-gate fails on it separately).
 */
export function computeInventoryGolden(): InventoryGolden {
  const registrationIndex = (pass: string): number => {
    const index = (CATALOG_PASS_IDS as readonly string[]).indexOf(pass)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  const passes = [...scanPassRuleInventory()].sort(
    (a, b) => registrationIndex(a.pass) - registrationIndex(b.pass),
  )
  return { passes, ruleCount: passes.reduce((n, p) => n + p.rules.length, 0) }
}

/** The exact bytes a golden file holds. */
export function canonicalize(golden: ConformanceGolden | InventoryGolden): string {
  return `${JSON.stringify(golden, null, 2)}\n`
}
