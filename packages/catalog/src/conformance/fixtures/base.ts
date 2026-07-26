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

/** A well-formed chat-tier capability, minus its `kind`. */
export const CHAT_BASE: Omit<ChatCapabilityDefinition, "kind"> = {
  pack: FIXTURE_PACK,
  mutating: true,
  tier: "chat",
  surfaces: ["chat"],
  auth: "guest",
  legacyNames: ["conformance_tool"],
  description: "Capacidade de conformidade (fixture).",
  guardRefs: [{ phase: "business", name: "conformanceBusinessGuard" }],
  refusalCode: "order.default.deny",
}
