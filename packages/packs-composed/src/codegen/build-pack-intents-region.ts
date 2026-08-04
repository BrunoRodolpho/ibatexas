// build-pack-intents-region.ts — R6 leg 1a: the SECOND intent-identity family
// member (each Pack's OWN runtime `intents[]` literal, e.g.
// `ordersPack.intents` in packages/pack-orders/src/index.ts) becomes a
// GENERATED region, spliced by the exact marker pattern
// `build-generated-region.ts` already proved on packages/intent-kinds/src/
// index.ts.
//
// Before this module, family member 3 was guarded only by an ARRAY-EQUALITY
// freshness test (capability-definitions.intent-identity-family.test.ts) —
// which tells a maintainer their hand edit is stale but still requires them to
// hand-write the fix in six files. `generatePackIntents` (packages/catalog/src/
// capability-definitions/generate-pack-intent-kinds.ts) could always have
// WRITTEN those arrays; nothing was calling it for that purpose. Now it does.
//
// ── Why the annotations table exists (the one non-obvious thing here) ────────
// The generator's own doc claims the two family members are "STRUCTURALLY
// IDENTICAL DATA". That is true of the DATA — the kind list and its order —
// and it is NOT true of the SOURCE TEXT. Two of the six committed arrays carry
// hand-written rationale comments INSIDE the array literal:
//   • pack-payments — one 2-line BKL-176 note explaining an ABSENCE (5 retired
//     `payment.charge.*` kinds), physically preceding `payment.create`.
//   • pack-ops — FOUR notes, genuinely INTERLEAVED between elements (NEW-004,
//     SCN-114, BKL-088, SCN-127), each explaining the kind(s) it precedes.
// None of that text exists anywhere in `CAPABILITY_DEFINITIONS`
// (`definitions.ts`'s pack-ops section carries only `adminLabel`s), so a
// generator that emitted bare `"kind",` lines would DELETE five blocks of
// real rationale — a silent documentation loss dressed up as codegen. The
// annotations below are that text, moved (not retyped: transcribed and then
// proven byte-identical by a zero-diff first regen) into the generator that
// now owns those lines.
//
// Carrying emitted comment text in the codegen module is the pattern
// `build-generated-region.ts` already established — its per-pack headings, the
// "Mirrors <Type>" doc lines and the whole `KNOWN_INTENT_KINDS` explanation
// block are codegen-local literals for the same reason. A future home for
// per-kind rationale is an optional `CapabilityDefinition` note field, which
// would let ONE source feed both mirrors; that is deliberately NOT this slice,
// because adding it would also change the intent-kinds region's committed
// bytes (it renders no per-kind comments today).
//
// Marker placement: immediately after `intents: [`, so the region is EXACTLY
// the array contents and nothing hand-written can live between the brackets.
// A maintainer who adds a comment there gets a red freshness gate pointing at
// this table — which is why no per-pack doc note was added to the six pack
// files: the guidance arrives at the moment it is needed, and costs the
// generated arrays zero bytes.
//
// Cycle-free by construction, exactly like the intent-kinds region: the six
// pack files are reached by a plain relative FILESYSTEM path from the
// tooling/test side (see `packageDir` below), never by a package import. The
// packs gain NO dependency on `@ibatexas/packs-composed` — the markers they
// carry are comments, and generation is offline.

import {
  CAPABILITY_DEFINITIONS,
  generatePackIntents,
  type CapabilityPackId,
} from "@ibatexas/catalog"

import { GENERATED_BEGIN, GENERATED_END } from "./build-generated-region.js"

/** Indentation of an element inside `xxxPack.intents: [ … ]` — two levels
 *  (object literal member, then array element) at this repo's 2-space width. */
const ELEMENT_INDENT = "    "

/** Comment lines to emit immediately BEFORE a given kind, without their `// `
 *  prefix (the renderer adds it). Keyed by kind within one pack's table so a
 *  note can never silently attach itself to a same-named kind in another
 *  pack's array. */
type PackIntentAnnotations = Readonly<Record<string, readonly string[]>>

interface PackIntentsTarget {
  readonly packId: CapabilityPackId
  /** Directory name under `packages/` holding this pack — joined with
   *  `src/index.ts` by each caller against its OWN path to `packages/`, so
   *  this pure module stays free of `node:path` and of any assumption about
   *  where the caller sits. */
  readonly packageDir: string
  /** The `PackV0` const whose `intents` array carries the region — recorded so
   *  a failing freshness message can name the exact symbol, not just a file. */
  readonly constName: string
  readonly annotations?: PackIntentAnnotations
}

/** All six first-party packs. Order is presentational only (it mirrors
 *  `build-generated-region.ts`'s `PACK_SPECS`); each pack's array is spliced
 *  into its own file independently, so nothing here is load-bearing the way
 *  `KNOWN_INTENT_KINDS`'s spread order is there. */
export const PACK_INTENTS_TARGETS: readonly PackIntentsTarget[] = [
  {
    packId: "ibatexas/pack-orders",
    packageDir: "pack-orders",
    constName: "ordersPack",
  },
  {
    packId: "ibatexas/pack-reservations",
    packageDir: "pack-reservations",
    constName: "reservationsPack",
  },
  {
    packId: "ibatexas/pack-whatsapp",
    packageDir: "pack-whatsapp",
    constName: "whatsappPack",
  },
  {
    packId: "ibatexas/pack-payments",
    packageDir: "pack-payments",
    constName: "paymentsPack",
    annotations: {
      "payment.create": [
        "BKL-176 — the 5 dead `payment.charge.*` kinds were retired (governance-",
        "only shadow of payment.create / payment.status.*; zero emitters).",
      ],
    },
  },
  {
    packId: "ibatexas/pack-customer-onboarding",
    packageDir: "pack-customer-onboarding",
    constName: "customerOnboardingPack",
  },
  {
    packId: "ibatexas/pack-ops",
    packageDir: "pack-ops",
    constName: "opsPack",
    annotations: {
      "product.price.set": [
        "NEW-004 — the OWNED price-change verb (confirm-gated on UNTRUSTED taint;",
        "executor re-prices via the same medusaAdjudicated admin egress).",
      ],
      "menu.special.set": [
        "SCN-114 — the OWNED daily-special-by-message verb (confirm-gated on",
        "UNTRUSTED taint; executor upserts a DailySpecial via the domain service,",
        "NO Medusa egress — the same service the NEW-005 admin route uses).",
      ],
      // Covers BOTH resolution verbs — it precedes the first of the pair in the
      // committed file, and says so ("the two OWNED staff-plane RESOLUTION
      // verbs"), so it is keyed to that first kind only.
      "ops.alert.resolve.staff": [
        "BKL-088 — the two OWNED staff-plane RESOLUTION verbs (their executors",
        "drive the SAME-named SYSTEM domain write layer; see types.ts header).",
      ],
      "schedule.override.set": [
        "SCN-127 — the OWNED schedule-override verb (\"fecha amanhã\" / custom hours);",
        "its executor drives the SAME scheduleService.upsertOverride the admin",
        "schedule route uses (a domain-service verb; NO Medusa egress).",
      ],
    },
  },
]

/**
 * Build one pack's GENERATED region — markers included — as the exact
 * TypeScript source text that belongs between its `intents: [` and `],`.
 *
 * The FIRST line is the bare `GENERATED_BEGIN` marker with no indentation:
 * the splice keeps whatever indentation the committed marker line already
 * has (`before` ends immediately at the marker's `//`), exactly as
 * `regenerate-intent-kinds.ts` has always done for the intent-kinds region.
 * Every subsequent line carries its own indentation.
 *
 * Deterministic: two calls on the same `CAPABILITY_DEFINITIONS` produce
 * byte-identical output.
 */
export function buildPackIntentsRegion(target: PackIntentsTarget): string {
  const kinds = generatePackIntents(CAPABILITY_DEFINITIONS, target.packId)
  const lines: string[] = [GENERATED_BEGIN]
  for (const kind of kinds) {
    for (const note of target.annotations?.[kind] ?? []) {
      lines.push(`${ELEMENT_INDENT}// ${note}`)
    }
    lines.push(`${ELEMENT_INDENT}"${kind}",`)
  }
  lines.push(`${ELEMENT_INDENT}${GENERATED_END}`)
  return lines.join("\n")
}

/** Guidance the freshness gate and the write-side script both surface when a
 *  pack file's region has drifted — the single place that explains BOTH ways a
 *  region legitimately changes. */
export const PACK_INTENTS_DRIFT_GUIDANCE =
  "Do not hand-edit a pack's intents[] region: change the kind list in " +
  "packages/catalog/src/capability-definitions/definitions.ts (or a per-kind " +
  "rationale comment in PACK_INTENTS_TARGETS' annotations table in " +
  "packages/packs-composed/src/codegen/build-pack-intents-region.ts), then run " +
  "`pnpm --filter @ibatexas/packs-composed run regen:intent-kinds`."
