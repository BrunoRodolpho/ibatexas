/**
 * Per-pack `ToolClassification.MUTATING` projection generator — FE-4
 * MIGRATE 2 (FE-T21).
 *
 * Each pack's `capabilities.ts` exports a `ToolClassification` with
 * `READ_ONLY` and `MUTATING` `Set<string>`s of legacy tool names.
 * `READ_ONLY` is OUT OF SCOPE — `CapabilityDefinition` models capabilities
 * (mutating kinds only; reads never route through `adjudicate()`), so
 * there is no read-only source data to project from. This is exactly the
 * spec's own framing (FE-4.2's generation-targets table): "mutating
 * tool-classification HALF" is generatable, not the whole
 * `ToolClassification`. `MUTATING` is a `Set`, not an array — comparison
 * is by CONTENT, never declaration order (unlike the intent-identity
 * family's array-shaped targets in FE-T20).
 *
 * # Two verified, honest exceptions — never fabricated
 *
 * Reading all 5 relevant packs' `capabilities.ts` in full (FE-T21) found
 * TWO tool names in a `MUTATING` set with NO `CapabilityDefinition.kind`
 * to derive them from at all — not merely de-advertised (that case,
 * `payment.method.switch` / `payment.retry`, IS covered via `legacyNames`
 * — see `generate-tool-to-intent-map.ts`'s doc):
 *
 *   - `pack-orders`: `"reorder"` — its own `ORDER_TOOL_TO_INTENT`'s comment
 *     says it plainly: "a higher-level orchestration that produces
 *     MULTIPLE `order.item.add` envelopes; not a single-intent map." There
 *     is no `order.reorder`-shaped 1:1 relationship to invent one from —
 *     `order.reorder` (the real, distinct intent kind in
 *     `ORDER_INTENT_KINDS`) is a DIFFERENT capability, coincidentally
 *     similar-sounding, not the same thing as the tool name.
 *   - `pack-whatsapp`: `"send_whatsapp_message"`, `"send_whatsapp_template"`,
 *     `"handover_whatsapp_session"` — the module doc informally correlates
 *     these to `whatsapp.message.send` / `whatsapp.template.send` /
 *     `whatsapp.session.handover`, but the pack's OWN structured
 *     `WHATSAPP_TOOL_TO_INTENT` map deliberately does NOT include them
 *     (only `request_human_handoff` is mapped there). Inferring a
 *     kind↔name pairing from doc PROSE that the pack's own structured map
 *     omits would be fabrication, not authoring — the same bar FE-T19/20
 *     already held generation to. `legacyNames` is NOT populated for these
 *     three on that basis (see `types.ts`).
 *
 * Both are supplied to the generator as an EXPLICIT, caller-acknowledged
 * input (`extraToolNames`) — never invented, mirroring FE-T20's
 * `KnownIntentKindsExternalInputs` pattern (PIX/loyalty kinds supplied
 * explicitly rather than fabricated). The freshness test's own
 * `extraToolNames` values are hand-transcribed ONCE, directly from the
 * real committed `MUTATING` sets, with a citing comment — exactly like
 * every other hand-authored input in this registry.
 */

import type { CapabilityDefinition } from "./types.js"

/**
 * Project the pack's `MUTATING` tool-name set: every `legacyNames` entry
 * across all instances (chat-tier + the narrow identity-tier exceptions)
 * that pack owns, UNIONED with the caller-supplied `extraToolNames` (tool
 * names with no kind mapping at all — see module doc). Returns a
 * `readonly string[]`; the freshness test compares as a SET (sorted array
 * or `Set` equality), matching the real target's `Set<string>` contract.
 */
export function generateMutatingToolNames(
  defs: readonly CapabilityDefinition[],
  pack: CapabilityDefinition["pack"],
  extraToolNames: readonly string[] = [],
): readonly string[] {
  const out: string[] = []
  for (const def of defs) {
    if (def.pack !== pack) continue
    const names = def.legacyNames
    if (names === undefined) continue
    for (const name of names) out.push(name)
  }
  out.push(...extraToolNames)
  return out
}
