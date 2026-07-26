// The CONFORMANCE SUITE's fixture contract (LE2-017).
//
// LE2 Testing Decisions, "Build gate (existing, extended)": "every rejection
// class gets a fixture catalog that must fail to compile, and compiled
// projections are golden-pinned exactly like today's generated rosters".
//
// A {@link ConformanceFixture} is one such fixture catalog: a tiny,
// hand-authored, SELF-CONTAINED array in the shape `compileCatalog` consumes,
// which exists to make exactly one rule id fire. It never imports the real
// `CAPABILITY_DEFINITIONS` — a fixture that read live data would change
// meaning every time the catalog is edited, which is the opposite of a pinned
// contract.
//
// # Why the definitions are widened
//
// Most rejection fixtures are values `types.ts` cannot express: a `mutating`
// that is a string, a slot the contract has never heard of, a chat-tier object
// missing a required slot. That is the point — the type system already rejects
// a malformed AUTHORED literal, and the compiler's job starts where the type
// system's ends (`compiler/slots.ts`: "`readonly CapabilityDefinition[]` is
// what a pass receives; a widened cast, a fixture, or a future generated
// catalog can hold anything"). {@link fixtureCatalog} performs that widening
// in ONE place, so a fixture file never spells an `as unknown as` cast itself.
//
// CLEAN fixtures take the opposite discipline: they are typed
// `readonly CapabilityDefinition[]` directly, so a clean fixture that stops
// being a legal authored literal is a compile error rather than a golden diff.
//
// Pure: no clock, no RNG, no IO.

import type { CapabilityDefinition } from "../capability-definitions/types.js"
import type { ExternalReferenceDeclaration } from "../external-references.js"

/** One fixture catalog and the rule it exists to prove. */
export interface ConformanceFixture {
  /**
   * Unique, file-safe id — also the golden's basename. `<pass>.<rule>` for a
   * rejection fixture, `clean.<name>` for a clean one.
   */
  readonly name: string
  /**
   * The rule this fixture is the witness for, as `<pass>/<rule>`. `null` for a
   * clean fixture (which witnesses the absence of every rule).
   */
  readonly targets: string | null
  /**
   * Other `<pass>/<rule>` ids this catalog ALSO emits, declared explicitly.
   *
   * A fixture is single-purpose wherever the compiler's own layering allows
   * it; a handful of faults are genuinely visible to two passes at once (a
   * chat capability with no `refusalCode` is both a missing required slot and
   * an uncovered terminal), and the fail-closed design means both are
   * reported. Listing them here — and asserting the list is EXACT against the
   * compiled output — keeps a co-emission a reviewed statement rather than
   * fixture slop that quietly grows.
   */
  readonly alsoEmits?: readonly string[]
  /** Why this catalog is the minimal witness for {@link targets}. */
  readonly why: string
  /** The fixture catalog itself. */
  readonly definitions: readonly CapabilityDefinition[]
  /**
   * The fixture's external-reference declarations (LE2-018). Omitted means
   * NONE — never "the real table". `compileCatalog` defaults this argument to
   * the authored `EXTERNAL_REFERENCES` so a production caller cannot forget
   * it, but a fixture that inherited real data would change meaning every time
   * an operator declared a new coupon, which is the opposite of a pinned
   * contract; the suite therefore always passes a table explicitly.
   */
  readonly externalReferences?: readonly ExternalReferenceDeclaration[]
}

/**
 * Widen hand-authored fixture objects into the array shape a pass receives.
 *
 * The single place the suite casts. A rejection fixture is deliberately not a
 * legal `CapabilityDefinition` — see the module doc.
 */
export function fixtureCatalog(
  ...objects: readonly unknown[]
): readonly CapabilityDefinition[] {
  return objects as readonly CapabilityDefinition[]
}

/**
 * Widen hand-authored declaration objects into the external-reference table a
 * pass receives — the same single-cast discipline as {@link fixtureCatalog},
 * for the same reason: an unknown store or a malformed `keyFrom` is precisely
 * what the pass exists to reject, and the authored type will not express it.
 */
export function fixtureExternalReferences(
  ...objects: readonly unknown[]
): readonly ExternalReferenceDeclaration[] {
  return objects as readonly ExternalReferenceDeclaration[]
}

/** `<pass>/<rule>` — the suite's stable id for one rejection class. */
export function ruleId(diagnostic: { readonly pass: string; readonly rule: string }): string {
  return `${diagnostic.pass}/${diagnostic.rule}`
}

/** Every `<pass>/<rule>` id a fixture declares it will emit, sorted. */
export function declaredRules(fixture: ConformanceFixture): readonly string[] {
  const declared = [
    ...(fixture.targets === null ? [] : [fixture.targets]),
    ...(fixture.alsoEmits ?? []),
  ]
  return [...new Set(declared)].sort()
}
