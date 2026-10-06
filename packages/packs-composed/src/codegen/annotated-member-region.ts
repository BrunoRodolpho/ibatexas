// annotated-member-region.ts — R6 leg 1b: the ONE definition of "a GENERATED
// region that is a list of per-kind members, some of which carry hand-written
// rationale comments".
//
// R6 leg 1a introduced this shape once, inline in build-pack-intents-region.ts,
// for the six packs' `intents[]` arrays. Leg 1b needs the same shape a second
// time for the six packs' kind TYPE UNIONS — same markers, same per-kind
// annotations behaviour, different member syntax (`| "kind"` rather than
// `"kind",`) at a different indent. Two independently hand-written renderers
// for one concept is exactly the hand-mirror class this whole R6 program is
// deleting, so the loop lives here and both builders call it.
//
// Extracting it is byte-safe by construction, not by inspection: leg 1a's
// regen-pack-intents-freshness.test.ts diffs the committed pack `intents[]`
// regions against `buildPackIntentsRegion()` output, so if this extraction had
// changed a single byte of the six committed arrays that gate would be red.

import { GENERATED_BEGIN, GENERATED_END } from "./build-generated-region.js"

/** Comment lines to emit immediately BEFORE a given kind, without their `// `
 *  prefix (the renderer adds it). Keyed by kind within ONE region's own table
 *  so a note can never silently attach itself to a same-named kind in another
 *  pack's region — nor leak across the two family members, whose committed
 *  rationale genuinely differs (see each builder's own table). */
export type KindAnnotations = Readonly<Record<string, readonly string[]>>

export interface AnnotatedMemberRegionSpec {
  readonly kinds: readonly string[]
  /** Indentation carried by every emitted line EXCEPT the leading
   *  `GENERATED_BEGIN`, whose indentation stays whatever the committed marker
   *  line already has — the splice's `before` slice ends at that marker's
   *  `//`, exactly as `regenerate-intent-kinds.ts` has always done. */
  readonly indent: string
  /** One kind → its member source text, unindented (e.g. `"order.cancel",` or
   *  `| "order.cancel"`). */
  readonly renderMember: (kind: string) => string
  readonly annotations?: KindAnnotations
}

/**
 * Render one GENERATED region — markers included — as the exact TypeScript
 * source text belonging between its committed sentinels.
 *
 * Deterministic: two calls on equal input produce byte-identical output.
 */
export function renderAnnotatedMemberRegion(spec: AnnotatedMemberRegionSpec): string {
  const lines: string[] = [GENERATED_BEGIN]
  for (const kind of spec.kinds) {
    for (const note of spec.annotations?.[kind] ?? []) {
      lines.push(`${spec.indent}// ${note}`)
    }
    lines.push(`${spec.indent}${spec.renderMember(kind)}`)
  }
  lines.push(`${spec.indent}${GENERATED_END}`)
  return lines.join("\n")
}
