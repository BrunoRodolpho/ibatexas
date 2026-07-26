/**
 * Guard-ref resolution — FE-4.3 EXPAND (FE-T19).
 *
 * Builds a resolution map from the LIVE `PolicyBundle` guard arrays on
 * `IBATEXAS_COMPOSED_PACKS` (the actually-installed pack objects — the same
 * ones the kernel `adjudicate()`s against) and asserts that every
 * `CapabilityGuardRef` an authored `CapabilityDefinition` declares resolves
 * to a real function in that live bundle.
 *
 * This is deliberately an INDEPENDENT materialization, not a re-export of
 * `definitions.ts`'s own data (FE-4.3: "ensure each surviving check diffs
 * the source against an independent materialization … a generated bundle
 * can never silently ship as refuse-everything"). Resolution walks
 * `pack.policy.{stateGuards,authGuards,business}` — the objects the kernel
 * evaluates — never the authored `guardRefs` themselves.
 *
 * # Why key off `GuardMetadata.name`, not `Function.name`
 *
 * `readGuardMetadata(guard)?.name` is an explicit string SET AT AUTHORING
 * TIME via `nameGuard`/`withMetadata` (`@adjudicate/core/kernel`), stored
 * in a non-configurable, symbol-keyed slot on the function object itself.
 * It is the SAME mechanism the kernel already uses to name guards in
 * `AdjudicationTraceEntry.guardName` / `LearningEvent.guardId` — so
 * resolution here can never disagree with what the kernel's own tracing
 * reports. Critically, it is independent of the JS engine's derived
 * `Function.name`, which:
 *   - is empty for a function RETURNED BY a factory call (`const g =
 *     someFactory(...)` does NOT trigger ECMAScript's anonymous-function
 *     name-inference — that only applies to a FunctionExpression/
 *     ArrowFunction literal on the right-hand side, never a CallExpression)
 *     — verified empirically: `requireTenantBindingGuard` (the
 *     `requireTenantBinding()` factory result, used in 5 of 6 packs'
 *     `authGuards`) has `Function.name === ""` in every pack that defines
 *     it, with no attached metadata either. See "Known gap" below.
 *   - is actively MISLEADING, not just absent, for `nameGuard`-wrapped L2
 *     factory guards: `createConfirmGuard`/`createEscalateGuard`/
 *     `createRewriteGuard`/`createDataClassificationGuard` all return a
 *     function whose OWN `Function.name` is the generic factory-internal
 *     name `"guard"` — e.g. `clampUpdateToStockCap`, `escalateLargeCancel`,
 *     `confirmLargeTicket`, `refuseCardPanInPix`, and `redactPiiInPix` in
 *     `pack-orders` all report `Function.name === "guard"` at runtime; only
 *     `GuardMetadata.name` carries their real identity.
 *   - is not guaranteed stable under a future minifier/bundler pass over
 *     this code (this repo's actual build is plain `tsc`, so it happens
 *     not to mangle names today, but that is an accident of the current
 *     build, not a guarantee the resolution mechanism should depend on).
 *
 * `Function.name` is used ONLY as a fallback when no `GuardMetadata.name`
 * is attached AND the runtime name is non-empty — this covers the common
 * case of a guard defined as a plain top-level `function foo(...)` or
 * `const foo = (envelope, state) => …` (JS name-inference DOES apply to a
 * bare arrow/function-expression initializer), which is the majority of
 * guards in every pack today.
 *
 * # Known gap — `requireTenantBindingGuard`
 *
 * `requireTenantBinding<K,P,S>(...)` (the `@adjudicate/primitives` L2
 * factory) is called directly as a `const requireTenantBindingGuard = …`
 * initializer in `pack-orders`, `pack-payments`, `pack-reservations`,
 * `pack-customer-onboarding`, and `pack-whatsapp` — none of them wrap it in
 * `nameGuard`, so it is UNRESOLVABLE by this mechanism today (empty
 * `Function.name`, no metadata). This is a real, bounded, single-guard gap
 * shared identically across five packs, not scattered noise. The authored
 * `CapabilityDefinition.guardRefs` in `definitions.ts` deliberately OMITS
 * `requireTenantBindingGuard` rather than reference an unresolvable name —
 * seeing it excluded from every pack's guard-ref list is expected, not a
 * bug. Fixing it (a one-line `nameGuard("requireTenantBindingGuard", …)`
 * wrap at each of the 5 call sites, identity-preserving and behavior-
 * neutral per `withMetadata`'s contract) is flagged as a follow-up, kept
 * out of this EXPAND-only, packs-composed-only change to avoid touching
 * five separate hand-authored pack policy files.
 */

import { readGuardMetadata, type Guard, type PolicyBundle } from "@adjudicate/core/kernel"

import { IBATEXAS_COMPOSED_PACKS, type ComposedPack } from "../index.js"
// LE2-014 — the capability TYPES moved to `@ibatexas/catalog` (the versioned
// business-definition root). This module stayed behind deliberately: it binds
// a definition's guard REFERENCE to a real guard FUNCTION in an installed
// pack, which is runtime authority, not definition (Decision 13). See
// `./index.js`'s doc for the full rationale (and for the turbo build cycle
// that moving it would create).
import type {
  CapabilityDefinition,
  CapabilityGuardRef,
  CapabilityPackId,
} from "@ibatexas/catalog"

const PHASES_WITH_GUARD_ARRAYS = ["stateGuards", "authGuards", "business"] as const
type PhaseWithGuardArray = (typeof PHASES_WITH_GUARD_ARRAYS)[number]

/** Maps a `PolicyBundle` array-phase key to the `GuardPhase` vocabulary used by {@link CapabilityGuardRef}. */
const ARRAY_PHASE_TO_GUARD_PHASE: Readonly<Record<PhaseWithGuardArray, CapabilityGuardRef["phase"]>> = {
  stateGuards: "state",
  authGuards: "auth",
  business: "business",
}

/**
 * Resolve one guard's stable name, or `undefined` if it cannot be resolved
 * by either mechanism described in the module doc.
 */
function resolveGuardName(guard: Guard<string, unknown, unknown>): string | undefined {
  const metaName = readGuardMetadata(guard)?.name
  if (metaName !== undefined && metaName !== "") return metaName
  const fnName = guard.name
  if (fnName !== undefined && fnName !== "") return fnName
  return undefined
}

/**
 * `${pack}::${phase}::${name}` — the resolution map's key shape. Scoped per
 * pack (not just per name) because several guard names are reused
 * verbatim, independently, across packs (e.g. every pack defines its own
 * local `requireAuthenticated`); scoped per phase too so a guard-ref that
 * names the right guard in the WRONG phase still fails resolution (moving
 * a guard between phases is a real behavior change the assertion should
 * catch).
 */
function resolutionKey(pack: CapabilityPackId, phase: CapabilityGuardRef["phase"], name: string): string {
  return `${pack}::${phase}::${name}`
}

/**
 * Thrown by {@link assertGuardRefsResolve} when an authored `CapabilityGuardRef`
 * does not resolve to a live guard. A dedicated class (not a plain `Error`)
 * so callers — e.g. `apps/api/src/plugins/kernel-bootstrap.ts`'s boot
 * sequence — can `instanceof`-discriminate it in a fatal-log branch, the
 * same idiom that file's own `PackCoverageError` / `AuditPostgresPreflightError`
 * / `EnvelopeBoundaryGateNotWiredError` already use.
 */
export class GuardRefResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GuardRefResolutionError"
  }
}

/**
 * One resolvable guard's live materialization — kept alongside the map
 * entry for the (currently unused, forward-looking) case where a future
 * analyzer wants the actual function, not just proof it exists.
 */
export interface ResolvedGuard {
  readonly pack: CapabilityPackId
  readonly phase: CapabilityGuardRef["phase"]
  readonly name: string
  readonly guard: Guard<string, unknown, unknown>
}

/**
 * Build the guard-name → live-guard resolution map from
 * `IBATEXAS_COMPOSED_PACKS`. Pure function of its input so it is
 * independently testable against a synthetic pack list, but the boot
 * self-check (`../index.ts`) always calls it with the real composed packs.
 */
export function buildGuardResolutionMap(
  packs: readonly ComposedPack[] = IBATEXAS_COMPOSED_PACKS,
): ReadonlyMap<string, ResolvedGuard> {
  const map = new Map<string, ResolvedGuard>()
  for (const pack of packs) {
    const packId = pack.id as CapabilityPackId
    const policy = pack.policy as PolicyBundle<string, unknown, unknown>
    for (const arrayPhase of PHASES_WITH_GUARD_ARRAYS) {
      const phase = ARRAY_PHASE_TO_GUARD_PHASE[arrayPhase]
      for (const guard of policy[arrayPhase]) {
        const name = resolveGuardName(guard)
        // An unresolvable guard is not an error here — plenty of live
        // guards (see "Known gap" above) currently have no stable name.
        // It only becomes an error if an authored `CapabilityGuardRef`
        // tries to point at it; see `assertGuardRefsResolve`.
        if (name === undefined) continue
        const key = resolutionKey(packId, phase, name)
        // Two guards in the same pack+phase resolving to the same name
        // would make guard-ref resolution ambiguous. Not expected today
        // (verified empirically across all 6 packs) — fail loudly if it
        // ever happens rather than silently keep the first one.
        if (map.has(key)) {
          throw new GuardRefResolutionError(
            `[capability-definitions] Ambiguous guard resolution: two guards in ` +
              `${packId} (${arrayPhase}) both resolve to the name "${name}". ` +
              `Guard-ref resolution requires unique names per pack+phase.`,
          )
        }
        map.set(key, { pack: packId, phase, name, guard })
      }
    }
  }
  return map
}

/**
 * The boot/CI assertion (FE-4.3): every `guardRef` on every authored
 * `CapabilityDefinition` MUST resolve to a real, live guard function.
 * Throws with a precise, actionable message on the first unresolved ref
 * (fail LOUD, never fail silent — "a generated bundle can never silently
 * ship as refuse-everything").
 *
 * `resolutionMap` defaults to a fresh {@link buildGuardResolutionMap} call
 * over the real composed packs — the default a real boot call site uses.
 * Tests pass a synthetic map (or a synthetic `defs` list) to exercise the
 * failure path without mutating any committed guard-ref data.
 */
export function assertGuardRefsResolve(
  defs: readonly CapabilityDefinition[],
  resolutionMap: ReadonlyMap<string, ResolvedGuard> = buildGuardResolutionMap(),
): void {
  for (const def of defs) {
    // FE-T20: `guardRefs` exists ONLY on the `tier: "chat"` union member —
    // an `IdentityCapabilityDefinition` has no such property at all (see
    // types.ts). Narrowing on `tier` (rather than `"guardRefs" in def` or
    // `?? []` against a type that no longer declares the field) is both
    // the type-correct and the semantically-honest check: identity-tier
    // instances have NOTHING to resolve — valid-by-absence, never a
    // dangling reference — while a `tier: "chat"` instance's `guardRefs`
    // is REQUIRED (non-optional) so it is always iterable here.
    if (def.tier !== "chat") continue
    for (const ref of def.guardRefs) {
      const key = resolutionKey(def.pack, ref.phase, ref.name)
      if (!resolutionMap.has(key)) {
        throw new GuardRefResolutionError(
          `[capability-definitions] Unresolved guard-ref on capability "${def.kind}": ` +
            `no live guard named "${ref.name}" in ${def.pack}'s "${ref.phase}" phase. ` +
            `A guard-ref must name a guard that actually exists in that pack's ` +
            `PolicyBundle (see guard-resolution.ts's resolution rules) — this assertion ` +
            `exists so a renamed, removed, or moved guard is caught at boot, not silently ` +
            `left dangling in descriptive metadata.`,
        )
      }
    }
  }
}
