// build-generated-region.ts — FE-4 CONTRACT (FE-T26): the shared templating
// logic behind packages/intent-kinds/src/index.ts's GENERATED region.
//
// Per FE-4.3's own mandate ("Add a codegen-freshness CI gate: regenerate in
// a clean tree; fail on any diff") this is the "regenerate" half — a pure
// function producing the exact TypeScript SOURCE TEXT for the 6 per-pack
// `*_INTENT_KINDS` arrays + `KNOWN_INTENT_KINDS`, from `CAPABILITY_
// DEFINITIONS` (this package's own `src/capability-definitions/`). Both
// `scripts/regenerate-intent-kinds.ts` (the write side) and `src/__tests__/
// regen-intent-kinds-freshness.test.ts` (the CI check side) import THIS
// SAME function — never two independently hand-typed template strings
// that could silently drift from each other.
//
// Lives under `src/` (not `scripts/`, where the write-side entry point and
// its file-I/O live) SOLELY so this package's own `tsc --outDir dist`
// build can compile `src/__tests__/regen-intent-kinds-freshness.test.ts`
// without a `rootDir` violation (a test file under `src/` importing
// something outside it fails `tsc`'s rootDir check). `scripts/
// regenerate-intent-kinds.ts` imports this module INWARD across that same
// boundary, which is unproblematic — only "inside importing outside"
// trips the rootDir rule.
//
// Deliberately lives in packs-composed, not intent-kinds, at the package
// level too: `@ibatexas/packs-composed` ALREADY depends on `@ibatexas/
// intent-kinds` (a devDependency, for its own freshness tests reading
// `KNOWN_INTENT_KINDS` et al.) — the natural, pre-existing direction.
// Putting the regen tooling on THIS side and reaching intent-kinds'
// committed file via a plain relative filesystem path (never a new package
// import) means `@ibatexas/intent-kinds` gains NO new dependency at all,
// so its build-graph relationship with packs-composed stays
// one-directional — no cycle. (An earlier attempt at this ticket added
// `@ibatexas/packs-composed` as an intent-kinds devDependency instead;
// turbo immediately flagged the resulting circular `build` task graph.
// This is the corrected design.)

import {
  CAPABILITY_DEFINITIONS,
  generatePackIntents,
  type CapabilityPackId,
} from "@ibatexas/catalog"

/** The sentinel markers `regenerate-intent-kinds.ts` splices between.
 *  Exported so the freshness test can locate the same region in the
 *  committed file without duplicating the literal marker strings. */
export const GENERATED_BEGIN =
  "// ═══ GENERATED — regenerate via `pnpm --filter @ibatexas/packs-composed run regen:intent-kinds` after editing packages/catalog/src/capability-definitions/definitions.ts. DO NOT HAND-EDIT BELOW THIS LINE. ═══"
export const GENERATED_END = "// ═══ END GENERATED REGION ═══"

/**
 * Slice a committed file's GENERATED region out, markers included — the read
 * side of the splice `regenerate-intent-kinds.ts` performs. Shared by the
 * write-side script and BOTH freshness gates (this file's region and the six
 * pack `intents[]` regions) so there is one definition of "the region",
 * whatever file it lives in. `label` names the file in the throw, because a
 * missing marker is always a hand-edit report, never an internal error.
 *
 * Leading indentation is deliberately NOT part of the returned text: the
 * markers are located by `indexOf` on their own comment text, so the same
 * region machinery works at column 0 (intent-kinds) and nested inside an
 * object literal (a pack's `intents: [`).
 */
export function extractGeneratedRegion(fileText: string, label: string): string {
  const beginIdx = fileText.indexOf(GENERATED_BEGIN)
  const endIdx = fileText.indexOf(GENERATED_END)
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(
      `GENERATED_BEGIN/GENERATED_END markers not found in ${label} — ` +
        "has the sentinel-comment structure been edited by hand? Restore the markers before regenerating.",
    )
  }
  return fileText.slice(beginIdx, endIdx + GENERATED_END.length)
}

interface PackSpec {
  readonly packId: CapabilityPackId
  readonly constName: string
  readonly typeName: string
  readonly heading: string
}

/** Declaration order is load-bearing — mirrors the pre-CONTRACT hand file's
 *  own section order AND `KNOWN_INTENT_KINDS`'s spread order exactly (pix
 *  sits between whatsapp and payments in that spread, historically). */
const PACK_SPECS: readonly PackSpec[] = [
  {
    packId: "ibatexas/pack-orders",
    constName: "ORDER_INTENT_KINDS",
    typeName: "OrderIntentKind",
    heading: "Pack-orders intent surface",
  },
  {
    packId: "ibatexas/pack-reservations",
    constName: "RESERVATION_INTENT_KINDS",
    typeName: "ReservationIntentKind",
    heading: "Pack-reservations intent surface",
  },
  {
    packId: "ibatexas/pack-whatsapp",
    constName: "WHATSAPP_INTENT_KINDS",
    typeName: "WhatsAppIntentKind",
    heading: "Pack-whatsapp intent surface",
  },
  {
    packId: "ibatexas/pack-payments",
    constName: "PAYMENT_INTENT_KINDS",
    typeName: "PaymentIntentKind",
    heading: "Pack-payments intent surface",
  },
  {
    packId: "ibatexas/pack-customer-onboarding",
    constName: "CUSTOMER_ONBOARDING_INTENT_KINDS",
    typeName: "CustomerOnboardingIntentKind",
    heading: "Pack-customer-onboarding intent surface",
  },
  {
    packId: "ibatexas/pack-ops",
    constName: "OPS_INTENT_KINDS",
    typeName: "OpsIntentKind",
    heading: "Pack-ops intent surface",
  },
]

function renderPackArray(spec: PackSpec): string {
  const kinds = generatePackIntents(CAPABILITY_DEFINITIONS, spec.packId)
  const lines: string[] = []
  const rule = "─".repeat(Math.max(4, 74 - spec.heading.length))
  lines.push(`// ── ${spec.heading} ${rule}`)
  lines.push("//")
  lines.push(
    `// Mirrors ${spec.typeName} (packages/${spec.packId.replace("ibatexas/", "")}/src/types.ts),`,
  )
  lines.push(
    "// projected from CAPABILITY_DEFINITIONS — see definitions.ts for per-kind rationale.",
  )
  lines.push(`export const ${spec.constName} = [`)
  for (const kind of kinds) lines.push(`  "${kind}",`)
  lines.push(`] as const satisfies readonly ${spec.typeName}[]`)
  return lines.join("\n")
}

/**
 * Build the full GENERATED region's TypeScript source text (markers
 * included) — the 6 per-pack arrays + `KNOWN_INTENT_KINDS`. Deterministic:
 * calling this twice on the same `CAPABILITY_DEFINITIONS` produces
 * byte-identical output.
 */
export function buildGeneratedRegion(): string {
  const lines: string[] = [GENERATED_BEGIN, ""]
  for (const spec of PACK_SPECS) {
    lines.push(renderPackArray(spec))
    lines.push("")
  }
  lines.push(
    "// ── Combined set ────────────────────────────────────────────────────────────",
  )
  lines.push("//")
  lines.push(
    "// PIX_INTENT_KINDS + LOYALTY_INTENT_KINDS are the two hand-authored EXTERNAL",
  )
  lines.push(
    "// inputs (declared ABOVE, outside this generated region) — see their own doc",
  )
  lines.push("// comments for why neither is CapabilityDefinition-derivable.")
  lines.push("export const KNOWN_INTENT_KINDS: ReadonlySet<string> = new Set<string>([")
  lines.push("  ...ORDER_INTENT_KINDS,")
  lines.push("  ...RESERVATION_INTENT_KINDS,")
  lines.push("  ...WHATSAPP_INTENT_KINDS,")
  lines.push("  ...PIX_INTENT_KINDS,")
  lines.push("  ...PAYMENT_INTENT_KINDS,")
  lines.push("  ...CUSTOMER_ONBOARDING_INTENT_KINDS,")
  lines.push("  ...OPS_INTENT_KINDS,")
  lines.push("  ...LOYALTY_INTENT_KINDS,")
  lines.push("])")
  lines.push("")
  lines.push(GENERATED_END)
  return lines.join("\n")
}
