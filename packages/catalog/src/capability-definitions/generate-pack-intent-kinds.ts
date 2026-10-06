/**
 * Per-pack intent-list projection generators — FE-4 MIGRATE 1 (FE-T20).
 *
 * Two of the ticket's four intent-identity family members —
 * "per-pack type unions" (the `*_INTENT_KINDS` mirror arrays in
 * `@ibatexas/intent-kinds`, e.g. `ORDER_INTENT_KINDS`) and "per-pack
 * runtime `intents[]`" (each Pack's OWN `xxxPack.intents` literal, e.g.
 * `ordersPack.intents`) — are STRUCTURALLY IDENTICAL DATA living in two
 * independently hand-maintained files. Verified byte-for-byte for all 6
 * packs before writing this generator (not assumed): `ORDER_INTENT_KINDS`
 * (intent-kinds/src/index.ts) and `ordersPack.intents`
 * (pack-orders/src/index.ts) are the same 22 kinds in the same order; same
 * for all 5 other packs. `intent-kinds/src/index.ts`'s own comment
 * confirms this is BY DESIGN, not coincidence: "Mirrors the `OrderIntentKind`
 * union in packages/pack-orders/src/types.ts. If you add a kind there, add
 * it here too."
 *
 * One projection function therefore serves BOTH family members —
 * `projectPackIntentKinds` — exported under two distinct, purpose-named
 * entry points so each keeps its own freshness test diffing against its
 * own independently-committed file (never the other generator's output,
 * which would make the pair tautological against each other instead of
 * against the real hand lists).
 */

import type { CapabilityDefinition } from "./types.js"

/**
 * Project one pack's full intent-kind list, in declaration order.
 * `CAPABILITY_DEFINITIONS` is authored in EXACTLY each pack's canonical
 * `*_INTENT_KINDS` order (see `definitions.ts`'s own module doc) — this
 * function does not re-sort; re-sorting would silently paper over an
 * ordering drift the freshness gate exists to catch, exactly like FE-T19's
 * `generateChatDrivableToolKinds`.
 */
function projectPackIntentKinds(
  defs: readonly CapabilityDefinition[],
  pack: CapabilityDefinition["pack"],
): readonly string[] {
  const out: string[] = []
  for (const def of defs) {
    if (def.pack !== pack) continue
    out.push(def.kind)
  }
  return out
}

/**
 * Family member "per-pack type unions" — projects the `*_INTENT_KINDS`
 * mirror array a given pack has in `@ibatexas/intent-kinds/src/index.ts`
 * (e.g. `ORDER_INTENT_KINDS`).
 */
export function generateIntentKindsMirror(
  defs: readonly CapabilityDefinition[],
  pack: CapabilityDefinition["pack"],
): readonly string[] {
  return projectPackIntentKinds(defs, pack)
}

/**
 * Family member "per-pack runtime `intents[]`" — projects the `intents`
 * array a given pack embeds in its OWN `PackV0` object (e.g.
 * `ordersPack.intents` in `pack-orders/src/index.ts`).
 */
export function generatePackIntents(
  defs: readonly CapabilityDefinition[],
  pack: CapabilityDefinition["pack"],
): readonly string[] {
  return projectPackIntentKinds(defs, pack)
}
