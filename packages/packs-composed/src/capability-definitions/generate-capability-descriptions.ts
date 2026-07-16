/**
 * `IBATEXAS_CAPABILITY_DESCRIPTIONS` projection generator — FE-4 MIGRATE 2
 * (FE-T21).
 *
 * `IBATEXAS_CAPABILITY_DESCRIPTIONS` (`apps/api/src/tools/register-
 * ibatexas-tool-packs.ts`) is the pt-BR description map, keyed by
 * `capability` (=== `intentKind` === `CapabilityDefinition.kind`),
 * single-sourced from `IBATEXAS_TOOLS` — the SAME registered-tool-roster
 * artifact `CHAT_DRIVABLE_TOOL_KINDS` (FE-T19's `generateChatDrivableToolKinds`)
 * already projects the CAPABILITY-KEY side of. `capability === intentKind`
 * for every registered tool (RC-A1 Phase A, asserted by `toolRosterDrift()`),
 * so "the registered tool roster" as a set of KEYS is not a fourth thing to
 * generate — it IS `CHAT_DRIVABLE_TOOL_KINDS`, already done (this ticket
 * absorbs it rather than duplicating it; see the freshness test's count
 * assertions). What's genuinely net-new here is the VALUE side — the pt-BR
 * description text for each key — which this generator projects from
 * `CapabilityDefinition.description` (populated for exactly the 18
 * chat-tier instances, the same 18 `IBATEXAS_TOOLS` registers).
 *
 * Freshness target lives in `apps/api` (`IBATEXAS_CAPABILITY_DESCRIPTIONS`
 * is not exported there today — the freshness test imports
 * `listIbatexasToolPacks()`, which IS exported, and rebuilds the same
 * `{capability: description}` shape from it — an independent
 * materialization of the real registered roster, not a re-derivation of
 * this generator's own output). packs-composed cannot import from
 * apps/api (apps depend on packages, never the reverse), so that test
 * lives in `apps/api/src/tools/__tests__/`, not here — mirroring FE-T19's
 * `assertCapabilityGuardRefsWired` tests, which live in apps/api for the
 * same reason.
 */

import type { CapabilityDefinition } from "./types.js"

/**
 * Project `{ [kind]: description }` for every `tier: "chat"` capability.
 * Record key ORDER carries no meaningful contract here (unlike the
 * array-shaped intent-identity family in FE-T20) — `IBATEXAS_CAPABILITY_
 * DESCRIPTIONS` is a plain object compared by key/value contents, not
 * declaration order, so this does not need `CHAT_DRIVABLE_TOOL_KINDS`'s
 * `PACK_GROUP_ORDER` re-grouping (a linear scan in `CAPABILITY_DEFINITIONS`
 * declaration order is sufficient and — verified — already produces the
 * pack-grouped order `generateChatDrivableToolKinds` uses, since both
 * generators read the SAME source array).
 */
export function generateCapabilityDescriptions(
  defs: readonly CapabilityDefinition[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const def of defs) {
    if (def.tier !== "chat") continue
    out[def.kind] = def.description
  }
  return out
}
