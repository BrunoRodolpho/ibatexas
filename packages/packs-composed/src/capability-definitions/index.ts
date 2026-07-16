/**
 * `@ibatexas/packs-composed/capability-definitions` — FE-4 EXPAND (FE-T19)
 * + MIGRATE 1/2 (FE-T20/T21) barrel. See `types.ts` for the field contract,
 * `definitions.ts` for the authored data (18 chat-tier + 48 identity-tier),
 * `guard-resolution.ts` for the boot assertion, and the `generate-*.ts`
 * modules for the two generated families:
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
 * # This module IS the boot assertion
 *
 * `assertGuardRefsResolve` runs EAGERLY below, at module-evaluation time —
 * true boot-time semantics (FE-4.3: "a boot assertion that every guard
 * reference resolves to a real function, so a generated bundle can never
 * silently ship as refuse-everything"). Any future consumer that imports
 * this module (directly or via a subpath) gets the check for free. FE-T20's
 * 48 identity-tier definitions carry no `guardRefs` (see types.ts) — the
 * assertion treats that as valid-by-absence, not a dangling reference (see
 * `guard-resolution.ts`).
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

export {
  assertGuardRefsResolve,
  buildGuardResolutionMap,
  GuardRefResolutionError,
  type ResolvedGuard,
} from "./guard-resolution.js"

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

import { CAPABILITY_DEFINITIONS } from "./definitions.js"
import { assertGuardRefsResolve } from "./guard-resolution.js"

assertGuardRefsResolve(CAPABILITY_DEFINITIONS)
