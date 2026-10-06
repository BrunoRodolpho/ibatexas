/**
 * The conversation projection's shared vocabulary — LE2-033.
 *
 * Holds the two things both the authored data
 * (`CapabilityDefinition.conversationTriggers`) and its compiler pass
 * (`compiler/passes/conversation-projection.ts`) must agree on: the
 * per-capability floor, and the normal form phrasings are COMPARED under.
 *
 * Kept beside the definitions (not inside `compiler/`) because the normal
 * form is part of the authoring contract a human reads before writing a
 * phrasing, not an implementation detail of the checker.
 */

import { normalizeProseForm } from "../text-normalization.js"
import type { CapabilityDefinition } from "./types.js"

/**
 * The minimum number of trigger phrasings a chat-tier (parser-emittable)
 * capability must declare.
 *
 * Six, not one: the field exists to close a REGISTER gap (LE2-008 measured
 * recall@5 = 73.8% on descriptions alone), and one or two phrasings cannot
 * span the ways a customer asks for something — imperative (*"tira a coca do
 * carrinho"*), desiderative (*"quero um refrigerante"*), and interrogative
 * (*"dá pra usar um cupom?"*) are three different neighbourhoods of the
 * embedding space. The floor is deliberately well below what every
 * capability actually carries today, so it catches an author who forgot,
 * not an author who was merely less prolific than average.
 *
 * A floor is enforceable where a CEILING is not: there is no principled
 * maximum, and capping would penalise exactly the high-traffic capabilities
 * that most need coverage.
 */
export const MIN_CONVERSATION_TRIGGERS = 6

/**
 * The normal form two phrasings are compared under for duplicate detection.
 *
 * Lowercases, folds diacritics (NFD + combining-mark strip — the repo's
 * standard pt-BR folding idiom), drops everything that is not a letter,
 * digit or space, and collapses whitespace. So *"Tira a Coca!"*,
 * *"tira a coça"* and *"tira  a  coca"* all share one key.
 *
 * This is used ONLY to compare and to validate. The value STORED in
 * `conversationTriggers` stays the natural pt-BR sentence, accents and all
 * — it is the text that gets embedded downstream, and folding accents out
 * of the stored form would degrade the very retrieval this projection
 * exists to improve (and would violate Hard Rule #4's spirit besides).
 *
 * The fold is NOT reimplemented here: it is `normalizeProseForm` from
 * `../text-normalization.ts`, the package's single word-space fold, shared
 * since LE2-025a with the alias gazetteer's `normalizeAliasSurface`. This
 * function survives as the NAME the projection's authoring contract uses —
 * a phrasing and an alias surface are compared the same way, and that is a
 * property worth being unable to break by editing one of them.
 */
export function normalizeTriggerPhrasing(phrasing: string): string {
  return normalizeProseForm(phrasing)
}

/**
 * Project `{ [kind]: readonly phrasings }` for every `tier: "chat"`
 * capability — the retrieval-index-shaped view of the projection, and the
 * seam LE2-008 consumes.
 *
 * Pure and inert, like every other `generate-*` projection in this
 * directory: it reads the authored array and returns it, holding no
 * runtime authority (README's one rule). Key order follows
 * `CAPABILITY_DEFINITIONS` declaration order, matching
 * `generateCapabilityDescriptions`.
 */
export function generateConversationTriggers(
  defs: readonly CapabilityDefinition[],
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {}
  for (const def of defs) {
    if (def.tier !== "chat") continue
    out[def.kind] = def.conversationTriggers
  }
  return out
}
