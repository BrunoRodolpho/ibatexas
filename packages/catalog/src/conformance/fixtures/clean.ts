// The CLEAN conformance fixtures (LE2-017) — the corpus's controls.
//
// A rejection corpus alone proves only that the compiler says SOMETHING. These
// three fixtures pin the other half of the contract: on well-formed data every
// pass is silent, and its `checked` count is not zero. The goldens record both
// numbers, so a pass that quietly stops looking at a slot shows up as a
// `checked` diff on a green fixture rather than as nothing at all.
//
// Unlike the rejection fixtures, these are typed `readonly
// CapabilityDefinition[]` — no widening cast. A clean fixture that stops being
// a legal authored literal must be a compile error.
//
// (The real catalog compiling clean is separately asserted in
// `compiler/__tests__/compile-catalog.test.ts`; that is a data test, and this
// is the compiler's own contract over data that never changes.)

import { CHAT_BASE, FIXTURE_PACK, IDENTITY_BASE } from "./base.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import type { ConformanceFixture } from "../types.js"

const MINIMAL_IDENTITY: readonly CapabilityDefinition[] = [
  { ...IDENTITY_BASE, kind: "conformance.clean.identity" },
]

const MINIMAL_CHAT: readonly CapabilityDefinition[] = [
  { ...CHAT_BASE, kind: "conformance.clean.chat" },
]

/**
 * One capability of each tier, in one Pack, with EVERY slot its tier admits
 * populated with legitimate data — including the three optional slots whose
 * empty forms are rejections elsewhere in the corpus (`successClaimLinks`,
 * `extractionSchema`, `legacyNames`).
 */
const EVERY_SLOT_POPULATED: readonly CapabilityDefinition[] = [
  {
    ...CHAT_BASE,
    kind: "conformance.clean.full-chat",
    legacyNames: ["conformance_full_chat_tool"],
    plannerAdvertisedBy: [FIXTURE_PACK],
    extractionSchema: { type: "object", properties: {} },
    successClaimLinks: ["order-placed"],
    adminLabel: "Conformidade — capacidade completa (fixture)",
    opsForbiddenDestructive: true,
  },
  {
    ...IDENTITY_BASE,
    kind: "conformance.clean.full-identity",
    legacyNames: ["conformance_full_identity_tool"],
    plannerAdvertisedBy: [FIXTURE_PACK],
    extractionSchema: { type: "object", properties: {} },
    successClaimLinks: ["note-added"],
    adminLabel: "Conformidade — capacidade de identidade (fixture)",
  },
]

export const CLEAN_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "clean.minimal-identity",
    targets: null,
    why:
      "the smallest catalog that compiles: the identity-tier base, unmodified. " +
      "The control for every identity-tier rejection fixture.",
    definitions: MINIMAL_IDENTITY,
  },
  {
    name: "clean.minimal-chat",
    targets: null,
    why:
      "the chat-tier base, unmodified — every required chat slot present and " +
      "non-empty, a guard chain and the floor it falls through to. The control " +
      "for every chat-tier rejection fixture.",
    definitions: MINIMAL_CHAT,
  },
  {
    name: "clean.every-slot-populated",
    targets: null,
    why:
      "both tiers, one Pack, every admissible slot populated. Proves the passes " +
      "are silent on RICH data, not merely on sparse data — an optional slot " +
      "carrying real content is not an incoherence, a resolving claim link is not " +
      "a dangler, and a chat capability beside an identity one is not a pack " +
      "divergence.",
    definitions: EVERY_SLOT_POPULATED,
  },
]
