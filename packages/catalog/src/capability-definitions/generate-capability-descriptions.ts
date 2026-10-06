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
 * `IBATEXAS_CAPABILITY_DESCRIPTIONS` IS exported (`register-ibatexas-
 * tool-packs.ts:400`), so its freshness test compares this generator's
 * output against it DIRECTLY (`toEqual`) — not indirectly rebuilt from
 * `listIbatexasToolPacks()`. That test lives in `apps/api/src/__tests__/
 * chat-drivable-roster-drift.test.ts` (extended, not a new file — that
 * file already covers the CAPABILITY-KEY side of this same registered-
 * tool-roster artifact), not here: packs-composed cannot import from
 * apps/api (apps depend on packages, never the reverse), mirroring why
 * FE-T19's `assertCapabilityGuardRefsWired` tests live in apps/api too.
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
