// The conformance corpus's two WELL-FORMED base capabilities (LE2-017).
//
// Every rejection fixture is one of these with exactly one slot changed,
// removed or added, and `clean.minimal-identity` / `clean.minimal-chat` are
// these bases compiled unmodified. That is what makes a rejection fixture's
// diagnostics attributable: the control and the specimen differ in one place.
//
// Both are typed `Omit<…CapabilityDefinition, "kind">`, so a base that stops
// being a legal authored literal is a COMPILE error rather than a golden diff
// on twenty files. (A rejection fixture then widens it back to `unknown`
// through `fixtureCatalog` — see `../types.ts`.)
//
// Self-contained: nothing here reads the real `CAPABILITY_DEFINITIONS`.

import type {
  ChatCapabilityDefinition,
  IdentityCapabilityDefinition,
} from "../../capability-definitions/types.js"

/**
 * The Pack every fixture capability belongs to. One pack throughout, because
 * the terminal-coverage pass's divergence rules are PER-PACK — a fixture that
 * spread its capabilities across packs would silence exactly the rules it is
 * there to prove.
 */
export const FIXTURE_PACK = "ibatexas/pack-orders"

/** A well-formed identity-tier capability, minus its `kind`. */
export const IDENTITY_BASE: Omit<IdentityCapabilityDefinition, "kind"> = {
  pack: FIXTURE_PACK,
  mutating: true,
  tier: "identity",
}

/**
 * `MIN_CONVERSATION_TRIGGERS` (6) well-formed phrasings, namespaced by
 * `discriminator` so that two capabilities in ONE fixture never accidentally
 * share one (LE2-033).
 *
 * That accident is not hypothetical: the `conversation-projection` pass
 * rejects a phrasing claimed by two capabilities, so any multi-capability
 * fixture spreading `CHAT_BASE` twice would emit a collision diagnostic it
 * never meant to test and stop being a single-purpose witness. Every fixture
 * with two chat capabilities must give the second one its own discriminator.
 *
 * `conformance` appears in every line so a fixture phrasing can never collide
 * with an authored production phrasing either.
 */
export function conformanceTriggers(discriminator: string): readonly string[] {
  return [
    `conformance ${discriminator} gatilho um`,
    `conformance ${discriminator} gatilho dois`,
    `conformance ${discriminator} gatilho três`,
    `conformance ${discriminator} gatilho quatro`,
    `conformance ${discriminator} gatilho cinco`,
    `conformance ${discriminator} gatilho seis`,
  ]
}

/**
 * A well-formed chat-tier capability, minus its `kind`.
 *
 * `conversationTriggers` (LE2-033) carries exactly
 * `MIN_CONVERSATION_TRIGGERS` (6) phrasings — the floor, not a round number.
 * A base sitting ON the boundary is what lets a rejection fixture prove the
 * floor by removing ONE entry, keeping the specimen one slot away from the
 * control.
 */
export const CHAT_BASE: Omit<ChatCapabilityDefinition, "kind"> = {
  pack: FIXTURE_PACK,
  mutating: true,
  tier: "chat",
  surfaces: ["chat"],
  auth: "guest",
  legacyNames: ["conformance_tool"],
  description: "Capacidade de conformidade (fixture).",
  conversationTriggers: conformanceTriggers("base"),
  guardRefs: [{ phase: "business", name: "conformanceBusinessGuard" }],
  refusalCode: "order.default.deny",
}
