// The CATALOG COMPILER's diagnostic contract (LE2-016).
//
// Ticket 16's third acceptance criterion is the whole design brief for this
// file: "Diagnostics name the object, the offending edge/slot, and the
// violated rule". A {@link CatalogDiagnostic} carries exactly those three
// things as SEPARATE FIELDS — not prose a human has to parse back apart:
//
//   object  — the named catalog object ("capability:order.cart.ensure")
//   field   — the offending slot or edge, with its index ("successClaimLinks[1]")
//   rule    — the violated rule's stable id ("claim-reference-dangling")
//
// plus `message` (the actionable sentence) and, where the fault is an EDGE,
// the `reference` that failed. A build log, a `--json` consumer, and a future
// conformance suite (ticket 17) all read the same structure; the formatter
// below is the only thing that turns it into text.
//
// # Determinism
//
// LE2 Testing Decisions pin the catalog compiler to the golden/freshness/drift
// idiom, and a golden is worthless if the output order wobbles. Every pass
// therefore emits into a list that {@link sortDiagnostics} totally orders
// before anyone sees it: (pass, object, field, rule, reference, message). The
// comparison is byte-wise on the string fields — no locale collation, which
// would make CI output machine-dependent.
//
// Pure: no clock, no RNG, no IO.

/** The static passes, in execution and report order. */
export const CATALOG_PASS_IDS = [
  "referential-integrity",
  "slot-dataflow",
  // LE2-033 — sits directly after `slot-dataflow` because the two speak about
  // the same slots from opposite sides: slot-dataflow reports that
  // `conversationTriggers` is missing or misshapen, this pass reports that its
  // CONTENTS do not separate capabilities. Adjacency puts both halves of one
  // authoring mistake next to each other in a build log.
  "conversation-projection",
  // LE2-025a — the second half of the language surface, and so adjacent to the
  // first: `conversation-projection` governs how a capability is ASKED FOR,
  // this pass governs how the things it acts on are NAMED. Both compare under
  // one word-space normal form, and an author reading a build log sees the two
  // customer-vocabulary passes together.
  "alias-gazetteer",
  "safety-implication-edges",
  "terminal-coverage",
  "external-references",
] as const

/** One static pass's stable id. */
export type CatalogPassId = (typeof CATALOG_PASS_IDS)[number]

const PASS_ORDER: ReadonlyMap<string, number> = new Map(
  CATALOG_PASS_IDS.map((id, index) => [id, index]),
)

/**
 * Diagnostic severity. Deliberately a single-member union today: LE2
 * Implementation Decision 16 is "the catalog compiler is fully fail-closed —
 * static passes … are compile/CI errors". There is no warning tier to hide a
 * violation in, and adding one later must be an explicit, reviewed widening of
 * this type rather than a field a pass can quietly set.
 */
export type CatalogDiagnosticSeverity = "error"

/** One static rejection: the object, the offending slot/edge, and the rule. */
export interface CatalogDiagnostic {
  /** Which pass rejected. */
  readonly pass: CatalogPassId
  /** Stable rule id, e.g. `"claim-reference-dangling"`. */
  readonly rule: string
  /** Always `"error"` — see {@link CatalogDiagnosticSeverity}. */
  readonly severity: CatalogDiagnosticSeverity
  /**
   * The named catalog object, NAMESPACE-PREFIXED so a diagnostic is
   * unambiguous once the catalog holds more than capabilities:
   * `"capability:<kind>"`, `"pack:<pack id>"`. An object whose own name slot
   * is unusable (missing/blank `kind`) is named by its array position —
   * `"capability:#7"` — which is still enough to find it.
   */
  readonly object: string
  /**
   * The offending slot or edge, indexed where the slot is an array:
   * `"successClaimLinks[1]"`, `"guardRefs[3].phase"`. `""` when the fault is
   * about the object as a whole rather than one of its slots.
   */
  readonly field: string
  /** What broke and how to fix it — the entire UX of a failed build. */
  readonly message: string
  /** The edge target that failed, when the fault is a reference. */
  readonly reference?: string
}

/** One pass's outcome over one catalog. */
export interface CatalogPassResult {
  readonly pass: CatalogPassId
  /**
   * How many things this pass actually LOOKED AT (references, slots, edges,
   * objects — each pass documents its own unit). The anti-vacuous-gate
   * measure the FE-4 freshness work named: a pass reporting `checked: 0` on
   * the real catalog is not passing, it is not running.
   */
  readonly checked: number
  /** Stable-ordered rejections. Empty means the pass is satisfied. */
  readonly diagnostics: readonly CatalogDiagnostic[]
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Total, locale-independent order over diagnostics: pass (declaration order),
 * then object, field, rule, reference, message. Returns a new array; the input
 * is untouched.
 */
export function sortDiagnostics(
  diagnostics: readonly CatalogDiagnostic[],
): readonly CatalogDiagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const byPass =
      (PASS_ORDER.get(a.pass) ?? Number.MAX_SAFE_INTEGER) -
      (PASS_ORDER.get(b.pass) ?? Number.MAX_SAFE_INTEGER)
    if (byPass !== 0) return byPass
    return (
      compare(a.object, b.object) ||
      compare(a.field, b.field) ||
      compare(a.rule, b.rule) ||
      compare(a.reference ?? "", b.reference ?? "") ||
      compare(a.message, b.message)
    )
  })
}

/** One diagnostic as a single line: `pass/rule: object · field — message`. */
export function formatDiagnostic(d: CatalogDiagnostic): string {
  const slot = d.field === "" ? "" : ` · ${d.field}`
  return `${d.pass}/${d.rule}: ${d.object}${slot} — ${d.message}`
}

/**
 * Name a capability for {@link CatalogDiagnostic.object}. Falls back to the
 * array position when the `kind` slot is itself unusable — a nameless object
 * must still be findable, and `"capability:#7"` beats `"capability:undefined"`.
 */
export function capabilityObjectName(kind: unknown, index: number): string {
  return typeof kind === "string" && kind.trim() !== ""
    ? `capability:${kind}`
    : `capability:#${index}`
}

/** Name a pack for {@link CatalogDiagnostic.object}. */
export function packObjectName(pack: string): string {
  return `pack:${pack}`
}

/**
 * Name an external-reference declaration for {@link CatalogDiagnostic.object}.
 * Same fallback discipline as {@link capabilityObjectName}: a declaration whose
 * own `id` slot is unusable is still findable by its array position.
 */
export function externalReferenceObjectName(id: unknown, index: number): string {
  return typeof id === "string" && id.trim() !== ""
    ? `external-reference:${id}`
    : `external-reference:#${index}`
}

/**
 * Name an alias edge for {@link CatalogDiagnostic.object} (LE2-025a).
 *
 * The SURFACE FORM is the name, spelled exactly as authored — it is what a
 * human searches `alias-gazetteer.ts` for. Two edges of one ambiguous surface
 * therefore share an object name, which is correct: the ambiguity is a
 * property of the surface, not of either row, and the pair reads as one
 * finding in a sorted build log. The array-position fallback is the same
 * discipline as {@link capabilityObjectName}.
 */
export function aliasObjectName(surface: unknown, index: number): string {
  return typeof surface === "string" && surface.trim() !== ""
    ? `alias:${surface}`
    : `alias:#${index}`
}
