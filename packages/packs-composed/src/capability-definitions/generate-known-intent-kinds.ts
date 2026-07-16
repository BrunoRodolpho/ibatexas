/**
 * `KNOWN_INTENT_KINDS` projection generator — FE-4 MIGRATE 1 (FE-T20).
 *
 * `KNOWN_INTENT_KINDS` (`@ibatexas/intent-kinds`) is the union of the 6
 * first-party packs' `*_INTENT_KINDS` (66 kinds — exactly this registry's
 * 66 authored `CapabilityDefinition`s) PLUS two inputs deliberately OUTSIDE
 * this registry's scope:
 *
 *   - `PIX_INTENT_KINDS` (3 kinds, `pix.charge.{create,confirm,refund}`) —
 *     mirrors the FROZEN, externally-published `@adjudicate/pack-payments-
 *     pix`'s `PixIntentKind` union. Not one of our 6 first-party packs;
 *     `CapabilityPackId` deliberately does not include it (see types.ts).
 *   - `loyalty.stamp.add` (1 kind) — per `@ibatexas/intent-kinds`'s own
 *     comment, a real kernel-gated mutation that is NOT Pack-registered at
 *     all (dispatched with a domain-internal `PolicyBundle` straight to
 *     `adjudicate()`, bypassing the Pack registry entirely) — there is no
 *     Pack to own it, so no `CapabilityDefinition.pack` value could be
 *     honest here either.
 *
 * This generator does NOT fabricate those two — it takes them as explicit,
 * caller-supplied inputs (`KnownIntentKindsExternalInputs`), mirroring
 * EXACTLY how `intent-kinds/src/index.ts` itself imports and spreads them
 * (`...PIX_INTENT_KINDS, ...LOYALTY_INTENT_KINDS`) rather than deriving
 * them from the Pack surface. The freshness test supplies REAL runtime
 * materializations for both — `paymentsPixPack.intents` (the actual
 * installed PIX pack's own declared surface) and the exported
 * `LOYALTY_INTENT_KINDS` — never a hand-retyped copy.
 */

import type { CapabilityDefinition } from "./types.js"

export interface KnownIntentKindsExternalInputs {
  /** The 3 `pix.charge.*` kinds — supply `paymentsPixPack.intents` (a real
   *  runtime materialization), never a hand-retyped literal. */
  readonly pixIntentKinds: readonly string[]
  /** The 1 `loyalty.stamp.add` kind — supply the real, exported
   *  `LOYALTY_INTENT_KINDS` from `@ibatexas/intent-kinds`. */
  readonly loyaltyIntentKinds: readonly string[]
}

/**
 * Project `KNOWN_INTENT_KINDS` — the union of every authored capability's
 * `kind`, plus the two external inputs above. `KNOWN_INTENT_KINDS` is a
 * `ReadonlySet<string>` (order carries no meaning there — unlike the
 * per-pack list generators), so this returns a `Set` too; the freshness
 * test compares contents, not declaration order.
 */
export function generateKnownIntentKinds(
  defs: readonly CapabilityDefinition[],
  external: KnownIntentKindsExternalInputs,
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const def of defs) {
    out.add(def.kind)
  }
  for (const kind of external.pixIntentKinds) out.add(kind)
  for (const kind of external.loyaltyIntentKinds) out.add(kind)
  return out
}
