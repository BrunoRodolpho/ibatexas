/**
 * `@ibatexas/packs-composed/capability-definitions` — FE-4 EXPAND (FE-T19)
 * + MIGRATE 1 (FE-T20) barrel. See `types.ts` for the field contract,
 * `definitions.ts` for the authored data (18 chat-tier + 48 identity-tier),
 * `guard-resolution.ts` for the boot assertion, and the four
 * `generate-*.ts` modules for the intent-identity family projections
 * (`generate-chat-drivable-tool-kinds.ts` — FE-T19's original exemplar;
 * `generate-known-intent-kinds.ts`, `generate-pack-intent-kinds.ts`,
 * `generate-planner-allowed-intents.ts` — FE-T20).
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
  GuardPhase,
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

import { CAPABILITY_DEFINITIONS } from "./definitions.js"
import { assertGuardRefsResolve } from "./guard-resolution.js"

assertGuardRefsResolve(CAPABILITY_DEFINITIONS)
