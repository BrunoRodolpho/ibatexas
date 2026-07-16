/**
 * Per-pack `*_TOOL_TO_INTENT` map projection generator — FE-4 MIGRATE 2
 * (FE-T21).
 *
 * Each pack's `capabilities.ts` exports a `Readonly<Record<string,
 * XIntentKind>>` (e.g. `ORDER_TOOL_TO_INTENT`) bridging a legacy snake_case
 * tool NAME to its intent KIND — two different namespaces the intent-bridge
 * needs to translate an LLM-proposed tool call into an `IntentEnvelope`.
 * This projects that map from `CapabilityDefinition.legacyNames[0]` ONLY —
 * a tool→intent map is inherently 1:1 (one canonical tool name resolves to
 * one kind), whereas `generate-mutating-tool-names.ts`'s `MUTATING`
 * projection legitimately wants EVERY `legacyNames` entry (a `Set`, where
 * "this kind has 2 historical aliases" would mean 2 MUTATING-classified
 * names). Today every populated instance carries EXACTLY one legacy name
 * (verified across all 66), so the two generators' behavior is currently
 * indistinguishable. If a future instance ever needed a second alias, THIS
 * generator would silently use only `legacyNames[0]` for the map key — but
 * that is not a silent failure in practice: the freshness test diffs the
 * result against the real committed `*_TOOL_TO_INTENT` map, which would
 * then have an entry (the second alias) this generator never produces, so
 * the mismatch fails LOUDLY the moment it would matter, not silently.
 *

 * # Scope: 5 packs, not 6
 *
 * `pack-ops` has NO `*_TOOL_TO_INTENT` map at all — its capabilities are
 * staff/ops-plane-only, wired through a SEPARATE ops-tool-registry
 * (out of this family's scope per the ticket). This generator is never
 * called with `"ibatexas/pack-ops"`.
 *
 * # Coverage beyond `tier: "chat"`
 *
 * Reads `legacyNames` off the COMMON base (available on both tiers — see
 * types.ts), not narrowed to chat-tier only: `PAYMENT_TOOL_TO_INTENT` has 3
 * entries, not 1 — `payment.method.switch` / `payment.retry` are
 * DE-ADVERTISED (`tier: "identity"`) but still real, mapped, MUTATING-
 * classified tool names (see `types.ts`'s `legacyNames` doc for the full
 * grounding). Every other pack's map is covered entirely by its chat-tier
 * instances.
 */

import type { CapabilityDefinition } from "./types.js"

/**
 * Project `{ [toolName]: kind }` for one pack. Object key order carries no
 * meaningful contract (compared by content, not declaration order, exactly
 * like `generate-capability-descriptions.ts`).
 */
export function generateToolToIntentMap(
  defs: readonly CapabilityDefinition[],
  pack: CapabilityDefinition["pack"],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const def of defs) {
    if (def.pack !== pack) continue
    const names = def.legacyNames
    if (names === undefined || names.length === 0) continue
    const [name] = names
    if (name === undefined) continue
    out[name] = def.kind
  }
  return out
}
