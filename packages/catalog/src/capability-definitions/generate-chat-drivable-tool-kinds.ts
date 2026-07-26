/**
 * Exemplar codegen-freshness projection — FE-4.3 EXPAND (FE-T19).
 *
 * Projects `CHAT_DRIVABLE_TOOL_KINDS` (`../index.ts`) FROM the authored
 * `CapabilityDefinition`s, to prove the EXPAND mechanism can reproduce a
 * hand-maintained list byte-for-byte. `CHAT_DRIVABLE_TOOL_KINDS` was chosen
 * as the exemplar (per the ticket: "pick a clean one") because it is a
 * flat `ReadonlyArray<string>` with a single, unambiguous derivation rule —
 * "chat"-surfaced capabilities, pack-grouped, declaration order — unlike
 * e.g. `KNOWN_INTENT_KINDS`, which folds in non-composed namespaces
 * (`pix.*`) this registry does not model yet.
 *
 * This generator does NOT become the new source of `CHAT_DRIVABLE_TOOL_KINDS`
 * — nothing is switched over in this step (FE-4.3 EXPAND, not MIGRATE). The
 * hand list stays authoritative; `__tests__/capability-definitions.
 * freshness.test.ts` asserts this function's OUTPUT still equals it
 * (empty diff) — the freshness gate a real generator/consumer cutover
 * would need, proven here before anything depends on it.
 */

import type { CapabilityDefinition } from "./types.js"

/**
 * Reproduce `CHAT_DRIVABLE_TOOL_KINDS`'s exact ordering. NOTE this is NOT
 * `IBATEXAS_COMPOSED_PACKS` order (orders, payments, reservations,
 * customer-onboarding, whatsapp, ops) — the hand list's own section
 * comments ("// pack-orders (10)", "// pack-reservations (4)", "//
 * pack-customer-onboarding (2)", "// pack-payments (1)", "// pack-whatsapp
 * (1)") group it orders → reservations → customer-onboarding → payments →
 * whatsapp, a distinct, independently hand-chosen ordering. Declaration
 * order within each pack group. `defs` is expected pre-ordered this way (as
 * `CAPABILITY_DEFINITIONS` is) — this function does not re-sort; re-sorting
 * would silently paper over an ordering drift the freshness gate exists to
 * catch.
 */
const PACK_GROUP_ORDER: readonly CapabilityDefinition["pack"][] = [
  "ibatexas/pack-orders",
  "ibatexas/pack-reservations",
  "ibatexas/pack-customer-onboarding",
  "ibatexas/pack-payments",
  "ibatexas/pack-whatsapp",
  "ibatexas/pack-ops",
]

/**
 * Project the chat-drivable, mutating capability roster from a
 * `CapabilityDefinition` list — a capability qualifies iff `mutating` is
 * `true` and `"chat"` appears in `surfaces`. Output order: pack-grouped per
 * {@link PACK_GROUP_ORDER}, declaration order within each group — exactly
 * `CHAT_DRIVABLE_TOOL_KINDS`'s convention (see that constant's own doc
 * comment: "// pack-orders (10)", "// pack-reservations (4)", …).
 */
export function generateChatDrivableToolKinds(defs: readonly CapabilityDefinition[]): readonly string[] {
  const out: string[] = []
  for (const pack of PACK_GROUP_ORDER) {
    for (const def of defs) {
      if (def.pack !== pack) continue
      if (!def.mutating) continue
      // FE-T20: `surfaces` exists ONLY on the `tier: "chat"` union member —
      // narrowing on `tier` correctly excludes every identity-tier def
      // (which has no `surfaces` property at all) rather than reaching for
      // a fallback default.
      if (def.tier !== "chat") continue
      if (!def.surfaces.includes("chat")) continue
      out.push(def.kind)
    }
  }
  return out
}
