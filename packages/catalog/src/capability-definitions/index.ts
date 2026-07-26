/**
 * `@ibatexas/catalog` capability definitions — the AUTHORED business
 * definition and its pure projections. Moved here wholesale from
 * `@ibatexas/packs-composed/capability-definitions` by LE2-014 (the catalog
 * expand phase). LE2-015 completed the move: that barrel's re-exports are
 * deleted and every caller imports these names from `@ibatexas/catalog`.
 *
 * See `types.ts` for the field contract, `definitions.ts` for the authored
 * data, and the `generate-*.ts` modules for the generated families.
 *
 * The registry is currently 58 capabilities — 20 chat-tier, 38 identity-tier.
 * (The pre-move barrel's doc said "18 chat-tier + 48 identity-tier"; that was
 * the FE-T19/T20 authoring-time count and had gone stale. 58/20/38 is the
 * count the LE2 spec's own "count corrections" note ratifies, and it is what
 * `CAPABILITY_DEFINITIONS.length` actually reports. Counts in prose drift —
 * the array is the source of truth.)
 *
 * The generated families:
 *   - Intent-identity (FE-T20): `generate-chat-drivable-tool-kinds.ts`
 *     (FE-T19's original exemplar), `generate-known-intent-kinds.ts`,
 *     `generate-pack-intent-kinds.ts`, `generate-planner-allowed-intents.ts`.
 *   - Tool/driving (FE-T21): `generate-capability-descriptions.ts`,
 *     `generate-tool-to-intent-map.ts`, `generate-mutating-tool-names.ts`.
 *   - Surface/claims/prompt (FE-T22): `generate-refusal-codes.ts`,
 *     `generate-success-claim-justified-by.ts` (surface/plane membership
 *     and prompt hints reuse `generate-chat-drivable-tool-kinds.ts` and
 *     `generate-capability-descriptions.ts` respectively — see FE-T22's
 *     PR body for why no new generator was needed for either).
 *   - Presentation (FE-T23): `generate-admin-labels.ts`,
 *     `generate-auth-levels.ts`. The legacy snake_case name map (the
 *     family's third named target) needed no new generator — fully covered
 *     by FE-T21's `generate-tool-to-intent-map.ts` /
 *     `generate-mutating-tool-names.ts` — see FE-T23's PR body.
 *   - Ops-boundary (FE-T24, the FINAL migrate batch): `generate-ops-
 *     boundary-kinds.ts` (`generateForeignAdvertisedKinds` +
 *     `generateOpsForbiddenDestructiveKinds`). `WA_EXCLUDED_OPS_KINDS` — a
 *     third ops-boundary set in the same source file — is traced but
 *     deliberately NOT generated; see that module's own doc for why.
 *
 * # What did NOT move: the guard-resolution boot assertion
 *
 * `guard-resolution.ts` (and the EAGER `assertGuardRefsResolve` side effect
 * that used to fire from this barrel) stayed in `@ibatexas/packs-composed`,
 * for two reasons that point the same way:
 *
 *   1. MECHANICAL — it imports `IBATEXAS_COMPOSED_PACKS` from
 *      `packs-composed`'s own root to verify every guard ref against the live
 *      INSTALLED packs. Moving it here would make `@ibatexas/catalog` depend
 *      on `@ibatexas/packs-composed`, which already depends on the catalog:
 *      a circular `build` task graph that turbo rejects outright (the same
 *      cycle FE-T26 hit and documented in `build-generated-region.ts`).
 *   2. PRINCIPLED — and this is the real reason. Resolving a guard REFERENCE
 *      to a real guard FUNCTION in an installed pack is a statement about the
 *      RUNTIME, not about the definition. LE2 Implementation Decision 13 is
 *      explicit that "the catalog defines; it never holds runtime authority".
 *      The catalog authors the reference; the composition site proves it
 *      binds. The boot assertion belongs on the binding side.
 *
 * That barrel still performs the eager `assertGuardRefsResolve` call at
 * module-evaluation time, exactly as before — LE2-015 removed its re-exports,
 * not its boot assertion.
 *
 * # Cross-reference checking
 *
 * The catalog's own fail-closed gate is `../build-gates/
 * check-claim-references.ts`, wired into this package's `build` script: every
 * claim reference a definition carries must resolve against
 * `../claim-references.ts`. See that module for the v0 scope.
 */

export type {
  CapabilityAuthLevel,
  CapabilityDefinition,
  CapabilityGuardRef,
  CapabilityPackId,
  CapabilitySurface,
  CapabilityTier,
  ChatCapabilityDefinition,
  GuardPhase,
  IdentityCapabilityDefinition,
} from "./types.js"

export { CAPABILITY_DEFINITIONS } from "./definitions.js"

export { generateChatDrivableToolKinds } from "./generate-chat-drivable-tool-kinds.js"

export {
  generateKnownIntentKinds,
  type KnownIntentKindsExternalInputs,
} from "./generate-known-intent-kinds.js"

export {
  generateIntentKindsMirror,
  generatePackIntents,
} from "./generate-pack-intent-kinds.js"

export { generatePlannerAllowedIntents } from "./generate-planner-allowed-intents.js"

export { generateCapabilityDescriptions } from "./generate-capability-descriptions.js"

export { generateToolToIntentMap } from "./generate-tool-to-intent-map.js"

export { generateMutatingToolNames } from "./generate-mutating-tool-names.js"

export { generateRefusalCodes } from "./generate-refusal-codes.js"

export { generateJustifiedByForClaim } from "./generate-success-claim-justified-by.js"

export {
  generateAdminLabels,
  type AdminLabelExternalInputs,
} from "./generate-admin-labels.js"

export { generateChatCapabilityAuthLevels } from "./generate-auth-levels.js"

export {
  generateForeignAdvertisedKinds,
  generateOpsForbiddenDestructiveKinds,
} from "./generate-ops-boundary-kinds.js"
