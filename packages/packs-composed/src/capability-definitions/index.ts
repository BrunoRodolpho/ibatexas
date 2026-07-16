/**
 * `@ibatexas/packs-composed/capability-definitions` — FE-4 EXPAND barrel
 * (FE-T19). See `types.ts` for the field contract, `definitions.ts` for the
 * authored data, `guard-resolution.ts` for the boot assertion, and
 * `generate-chat-drivable-tool-kinds.ts` for the exemplar freshness
 * projection.
 *
 * # This module IS the boot assertion
 *
 * `assertGuardRefsResolve` runs EAGERLY below, at module-evaluation time —
 * true boot-time semantics (FE-4.3: "a boot assertion that every guard
 * reference resolves to a real function, so a generated bundle can never
 * silently ship as refuse-everything"). Any future consumer that imports
 * this module (directly or via a subpath) gets the check for free, with no
 * separate wiring into `apps/api/src/claustrum-bootstrap.ts` required. This
 * keeps the EXPAND step strictly additive — nothing in `apps/api` changes
 * to get this protection; it activates the moment something starts
 * importing the new registry.
 */

export type {
  CapabilityAuthLevel,
  CapabilityDefinition,
  CapabilityGuardRef,
  CapabilityPackId,
  CapabilitySurface,
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

import { CAPABILITY_DEFINITIONS } from "./definitions.js"
import { assertGuardRefsResolve } from "./guard-resolution.js"

assertGuardRefsResolve(CAPABILITY_DEFINITIONS)
