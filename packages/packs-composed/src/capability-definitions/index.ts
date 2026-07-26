/**
 * `@ibatexas/packs-composed/capability-definitions` — the COMPATIBILITY
 * BARREL over `@ibatexas/catalog`, plus the guard-resolution boot assertion.
 *
 * # What happened here (LE2-014, the catalog expand phase)
 *
 * The authored capability data and its twelve projection generators MOVED to
 * `@ibatexas/catalog`, the single versioned root of business definition (LE2
 * Implementation Decision 13). This barrel now re-exports them.
 *
 * That move was ACCRETION, not a rewrite: this module's export surface is
 * byte-for-byte the same set of names it had before, in the same shapes, with
 * the same eager side effect. Every existing import site —
 * `claustrum-bootstrap.ts`, `register-ibatexas-tool-packs.ts`,
 * `kernel-bootstrap.ts`, the admin freshness test, the ops drift tests, this
 * package's own test suite — was left untouched, and should stay that way.
 * New code SHOULD import from `@ibatexas/catalog` directly.
 *
 * See `@ibatexas/catalog`'s `src/capability-definitions/index.ts` for the
 * per-generator documentation (which module feeds which generated family) and
 * its README for the `CATALOG_VERSION` bump discipline.
 *
 * # What did NOT move, and why this file still exists
 *
 * `guard-resolution.ts` stayed, for two reasons that agree:
 *
 *   1. MECHANICAL — it imports `IBATEXAS_COMPOSED_PACKS` from this package's
 *      root to verify guard refs against the live INSTALLED packs. Moving it
 *      into the catalog would make `@ibatexas/catalog` depend on
 *      `@ibatexas/packs-composed`, which depends on the catalog: a circular
 *      turbo `build` graph, rejected outright (the same cycle FE-T26 hit and
 *      documented in `../codegen/build-generated-region.ts`).
 *   2. PRINCIPLED — and this is the real reason. Resolving a guard REFERENCE
 *      to a real guard FUNCTION in an installed pack is a claim about the
 *      RUNTIME, not about the definition. Decision 13 is explicit that "the
 *      catalog defines; it never holds runtime authority". The catalog
 *      authors the reference; this composition site proves it binds.
 *
 * # This module IS the boot assertion (unchanged)
 *
 * `assertGuardRefsResolve` still runs EAGERLY below, at module-evaluation
 * time — true boot-time semantics (FE-4.3: "a boot assertion that every guard
 * reference resolves to a real function, so a generated bundle can never
 * silently ship as refuse-everything"). Any consumer that imports this module
 * (directly or via the subpath) gets the check for free, exactly as before.
 * The 48 identity-tier definitions carry no `guardRefs` — the assertion treats
 * that as valid-by-absence, not a dangling reference (see
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
} from "@ibatexas/catalog"

export {
  CAPABILITY_DEFINITIONS,
  generateAdminLabels,
  generateCapabilityDescriptions,
  generateChatCapabilityAuthLevels,
  generateChatDrivableToolKinds,
  generateForeignAdvertisedKinds,
  generateIntentKindsMirror,
  generateJustifiedByForClaim,
  generateKnownIntentKinds,
  generateMutatingToolNames,
  generateOpsForbiddenDestructiveKinds,
  generatePackIntents,
  generatePlannerAllowedIntents,
  generateRefusalCodes,
  generateToolToIntentMap,
  type AdminLabelExternalInputs,
  type KnownIntentKindsExternalInputs,
} from "@ibatexas/catalog"

export {
  assertGuardRefsResolve,
  buildGuardResolutionMap,
  GuardRefResolutionError,
  type ResolvedGuard,
} from "./guard-resolution.js"

import { CAPABILITY_DEFINITIONS } from "@ibatexas/catalog"
import { assertGuardRefsResolve } from "./guard-resolution.js"

assertGuardRefsResolve(CAPABILITY_DEFINITIONS)
