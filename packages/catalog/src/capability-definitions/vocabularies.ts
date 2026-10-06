// The RUNTIME MIRRORS of the closed vocabularies `types.ts` declares as TYPE
// unions (LE2-016 — the catalog compiler's static passes).
//
// `types.ts` is the authoring contract: `CapabilityPackId`, `CapabilitySurface`,
// `CapabilityAuthLevel`, `CapabilityTier` and `GuardPhase` are string-literal
// unions, so a hand-authored `definitions.ts` literal that misspells one is
// already a compile error. That guarantee holds for the AUTHORED array and
// nowhere else: the compiler's passes take `readonly CapabilityDefinition[]`
// and must be able to reject a catalog whose values are wrong at RUNTIME —
// a conformance fixture, a widened `as` cast, a future generated catalog. A
// type union cannot be iterated at runtime, so the passes need these arrays.
//
// Every array below is EXHAUSTIVE in both directions by construction:
//   - no EXTRAS — `satisfies readonly <Union>[]` rejects a value the union
//     does not admit;
//   - no OMISSIONS — the `NoMissingMember` assertion under each array fails to
//     compile when the union gains a member this file does not list.
//
// So a vocabulary can never silently narrow. That matters more than it looks:
// a narrowed vocabulary does not make the gate loud, it makes it WRONG in the
// permissive direction (a real pack id reported as a dangling reference) or,
// worse, leaves a new member unchecked.
//
// Nothing here is a policy statement. These are name spaces; which names a
// capability is ALLOWED to reach (the safety pass) is a separate, ratified
// question answered in `../compiler/safety-markers.ts`.

import type {
  CapabilityAuthLevel,
  CapabilityPackId,
  CapabilitySurface,
  CapabilityTier,
  GuardPhase,
} from "./types.js"

/**
 * Compile-time proof that `Enumerated` covers every member of `Union`.
 * Resolves to `true` when nothing is missing, and to the MISSING MEMBERS
 * themselves otherwise — so the compile error names exactly what was forgotten
 * instead of a bare "Type 'boolean' is not assignable".
 */
type NoMissingMember<Union extends string, Enumerated extends string> =
  Exclude<Union, Enumerated> extends never ? true : Exclude<Union, Enumerated>

/**
 * The six first-party Pack ids — the runtime mirror of {@link CapabilityPackId}.
 * Order mirrors that union's declaration order in `types.ts`; order carries no
 * contract (every consumer treats this as a set).
 */
export const CAPABILITY_PACK_IDS = [
  "ibatexas/pack-orders",
  "ibatexas/pack-payments",
  "ibatexas/pack-reservations",
  "ibatexas/pack-customer-onboarding",
  "ibatexas/pack-whatsapp",
  "ibatexas/pack-ops",
] as const satisfies readonly CapabilityPackId[]

const _PACK_IDS_COMPLETE: NoMissingMember<
  CapabilityPackId,
  (typeof CAPABILITY_PACK_IDS)[number]
> = true
void _PACK_IDS_COMPLETE

/** The planes a capability can be reachable from — mirror of {@link CapabilitySurface}. */
export const CAPABILITY_SURFACES = [
  "chat",
  "staff",
  "ops",
  "system",
] as const satisfies readonly CapabilitySurface[]

const _SURFACES_COMPLETE: NoMissingMember<
  CapabilitySurface,
  (typeof CAPABILITY_SURFACES)[number]
> = true
void _SURFACES_COMPLETE

/** The auth levels — mirror of {@link CapabilityAuthLevel}. */
export const CAPABILITY_AUTH_LEVELS = [
  "guest",
  "customer",
  "staff",
  "system",
] as const satisfies readonly CapabilityAuthLevel[]

const _AUTH_LEVELS_COMPLETE: NoMissingMember<
  CapabilityAuthLevel,
  (typeof CAPABILITY_AUTH_LEVELS)[number]
> = true
void _AUTH_LEVELS_COMPLETE

/** The two authoring tiers — mirror of {@link CapabilityTier}. */
export const CAPABILITY_TIERS = [
  "chat",
  "identity",
] as const satisfies readonly CapabilityTier[]

const _TIERS_COMPLETE: NoMissingMember<
  CapabilityTier,
  (typeof CAPABILITY_TIERS)[number]
> = true
void _TIERS_COMPLETE

/**
 * Every kernel guard phase — mirror of `@adjudicate/core`'s {@link GuardPhase}
 * (`"state" | "taint" | "auth" | "business"`). This is the FULL union,
 * including `"taint"`, because a `CapabilityGuardRef.phase` field typed
 * `GuardPhase` can legally hold it.
 *
 * See {@link GUARD_REF_PHASES} for the subset a guard REFERENCE can actually
 * resolve in — the distinction the terminal-coverage pass enforces.
 */
export const GUARD_PHASES = [
  "state",
  "taint",
  "auth",
  "business",
] as const satisfies readonly GuardPhase[]

const _GUARD_PHASES_COMPLETE: NoMissingMember<
  GuardPhase,
  (typeof GUARD_PHASES)[number]
> = true
void _GUARD_PHASES_COMPLETE

/**
 * The phases a `CapabilityGuardRef` can actually name — `GuardPhase` MINUS
 * `"taint"`.
 *
 * Grounded verbatim in `types.ts`'s `CapabilityGuardRef` scope note: "`phase`
 * excludes `"taint"` in practice (the core `GuardPhase` union includes it for
 * `GuardFireStats` symmetry, but a Pack's `taint` slot is a single
 * `TaintPolicy` value, not a `Guard[]` array — there is nothing here to
 * reference by name)". A `phase: "taint"` guard ref therefore points at a
 * terminal no guard can ever produce; the type system cannot catch it (it is a
 * legal `GuardPhase`), so the compiler does.
 */
export const GUARD_REF_PHASES = ["state", "auth", "business"] as const satisfies
  readonly GuardPhase[]

/** A phase a `CapabilityGuardRef` may legally declare. */
export type GuardRefPhase = (typeof GUARD_REF_PHASES)[number]
