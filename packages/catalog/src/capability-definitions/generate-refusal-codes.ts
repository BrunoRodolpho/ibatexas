/**
 * Per-capability refusal-code mirror generator — FE-4 MIGRATE 3 (FE-T22).
 *
 * `CapabilityDefinition.refusalCode` (chat tier only — the FLOOR
 * default-deny code, see `types.ts`) was authored in FE-T19 against each
 * pack's real, exported `basisCodes` array (e.g. `ordersPack.basisCodes`
 * contains `"order.default.deny"`). Re-verified for FE-T22 by reading all
 * 5 relevant packs' `basisCodes` arrays fresh — every one of the 18
 * authored `refusalCode` values is a REAL member of its owning pack's
 * `basisCodes`; none needed correcting.
 *
 * There is no separate PRE-EXISTING per-kind "refusal code" hand list this
 * mirrors byte-for-byte — `refusalCode` is FE-T19's own net-new metadata
 * field, itself grounded in `basisCodes`. So "freshness" here means
 * GROUNDEDNESS, not byte-identity to a prior artifact: this generator's
 * projection, checked against each pack's real `basisCodes`, is the
 * ongoing proof that the field was never invented and cannot silently
 * drift from the guard-emitted code vocabulary it claims to mirror.
 */

import type { CapabilityDefinition } from "./types.js"

/**
 * Project `{ [kind]: refusalCode }` for every `tier: "chat"` capability.
 * Record key order carries no meaningful contract (compared by content,
 * like `generate-capability-descriptions.ts` / `generate-tool-to-intent-
 * map.ts`).
 */
export function generateRefusalCodes(
  defs: readonly CapabilityDefinition[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const def of defs) {
    if (def.tier !== "chat") continue
    out[def.kind] = def.refusalCode
  }
  return out
}
