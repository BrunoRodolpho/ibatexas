/**
 * `@ibatexas/packs-composed/capability-definitions` — guard-ref RESOLUTION
 * against the live installed packs, plus the boot assertion that runs it.
 *
 * # What this module is NOT, as of LE2-015
 *
 * It is no longer a re-export of the capability definitions. LE2-014 moved the
 * authored data and its twelve projection generators to `@ibatexas/catalog`
 * (LE2 Implementation Decision 13) and left this barrel re-exporting them so
 * that no call site had to change in the same commit as the move. LE2-015 is
 * the other half of that bargain: every caller now imports `@ibatexas/catalog`
 * directly, and the re-exports are gone. There is exactly ONE import path for a
 * business definition, and it is not this one.
 *
 * Import `CAPABILITY_DEFINITIONS`, the `Capability*` types, and every
 * `generate*` projection from `@ibatexas/catalog`.
 *
 * # What stayed here, and why
 *
 * `guard-resolution.ts`, for two reasons that agree:
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
 * time (FE-4.3: "a boot assertion that every guard reference resolves to a
 * real function, so a generated bundle can never silently ship as
 * refuse-everything"). The 48 identity-tier definitions carry no `guardRefs` —
 * the assertion treats that as valid-by-absence, not a dangling reference (see
 * `guard-resolution.ts`).
 *
 * Read that side effect for what it is worth and no more: it fires only for
 * whichever process happens to import this module, which is exactly why
 * `apps/api`'s real guarantee is kernel-bootstrap.ts calling
 * `assertCapabilityGuardRefsWired()` unconditionally at boot. Narrowing this
 * module's export surface therefore narrowed who trips the eager check, and
 * changed nothing about when a dangling guard-ref fails the API.
 */

export {
  assertGuardRefsResolve,
  buildGuardResolutionMap,
  GuardRefResolutionError,
  type ResolvedGuard,
} from "./guard-resolution.js"

import { CAPABILITY_DEFINITIONS } from "@ibatexas/catalog"
import { assertGuardRefsResolve } from "./guard-resolution.js"

assertGuardRefsResolve(CAPABILITY_DEFINITIONS)
