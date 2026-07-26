/**
 * `@ibatexas/catalog` — the single VERSIONED root of business definition.
 *
 * LE2 Implementation Decision 13: "The catalog package starts as minimal
 * accretion: capability definitions and claim-registry references move under
 * one versioned root with cross-reference checks; every turn stamps the
 * catalog version into its trace (the replay enabler). Nothing new is added
 * until what exists is unified."
 *
 * Read that last sentence as a constraint on this file. What is here is what
 * MOVED, plus the version and the reference vocabulary the move needs to be
 * checkable. Journeys, aliases, and the pairings graph are later tickets and
 * are deliberately absent. There is no CMS, no admin editor, and no runtime
 * mutation path — the catalog is hand-authored, code-reviewed data (that is a
 * ratified Out-of-Scope item, not an oversight).
 *
 * # The one rule this package lives by
 *
 * THE CATALOG DEFINES; IT NEVER HOLDS RUNTIME AUTHORITY.
 *
 * Everything exported here is inert data or a pure function over that data.
 * No export reads a clock, touches IO, or decides anything at request time.
 * The runtime authorities stay exactly where they are and keep their power:
 * the kernel adjudicates, `SUCCESS_CLAIM_CLASSES` clamps, `CLAIM_REGISTRY`
 * constrains generation, the installed Packs own their guards, and
 * `toolRosterDrift()` still runs fail-closed at boot in
 * `apps/api/src/claustrum-bootstrap.ts`. This package is upstream of all of
 * it and can only be wrong in ways a build gate catches.
 *
 * # Contents
 *
 *   - {@link CATALOG_VERSION} — the monotonic serial. Stamped into every
 *     turn's trace (`turn_trace.catalog_version`) so a historical turn can be
 *     re-run against exactly the catalog it saw. Bump discipline: README.
 *   - `capability-definitions/` — the authored capability data and its pure
 *     projections, moved intact from `@ibatexas/packs-composed`.
 *   - `claim-references.ts` — the claim NAME SPACES definitions may point at
 *     (mirrors, pinned to the runtime originals by apps/api tests).
 *   - `external-references.ts` — the names the catalog depends on but does NOT
 *     own: a promotion in Medusa, a zone row in the domain database (LE2-018).
 *     The table declares which store holds each reference, which env var names
 *     its key, and which code sites break without it. The catalog DECLARES;
 *     the verification (and every byte of IO it needs) lives downstream in
 *     `@ibatexas/tools`, the api's boot gate, and `ibx catalog check --live`.
 *   - `compiler/` — the catalog compiler (LE2-016/018): five fail-closed
 *     STATIC passes (referential integrity, slot dataflow, safety-implication
 *     edges, terminal coverage, external references) over the authored data,
 *     wired into `pnpm --filter @ibatexas/catalog build`, into CI, and into
 *     `ibx catalog check`. Pure build tooling — a compiler, never a runtime
 *     authority.
 *   - `build-gates/check-claim-references.ts` — cross-reference check v0, now
 *     a thin adapter over the compiler's referential-integrity edge table
 *     (same API, same messages, one table).
 *
 * # Compatibility
 *
 * This was an EXPAND-phase move: every pre-existing import path still works.
 * `@ibatexas/packs-composed/capability-definitions` re-exports the capability
 * surface below verbatim (and still runs its own eager guard-resolution boot
 * assertion), so no call site changed.
 */

export { CATALOG_VERSION } from "./version.js"

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
} from "./capability-definitions/index.js"

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
} from "./capability-definitions/index.js"

export {
  CLAIM_CLASS_REFERENCES,
  isClaimClassReference,
  isRegistryClaimTypeReference,
  REGISTRY_CLAIM_TYPE_REFERENCES,
  type ClaimClassReference,
  type RegistryClaimTypeReference,
} from "./claim-references.js"

export {
  EXTERNAL_REFERENCE_STORES,
  EXTERNAL_REFERENCES,
  type ExternalReferenceConsumer,
  type ExternalReferenceDeclaration,
  type ExternalReferenceStore,
} from "./external-references.js"

export {
  assertClaimReferencesResolve,
  CatalogCrossReferenceError,
  findClaimReferenceDanglers,
  formatClaimReferenceReport,
  type ClaimReferenceDangler,
} from "./build-gates/check-claim-references.js"

export {
  CAPABILITY_AUTH_LEVELS,
  CAPABILITY_PACK_IDS,
  CAPABILITY_SURFACES,
  CAPABILITY_TIERS,
  GUARD_PHASES,
  GUARD_REF_PHASES,
  type GuardRefPhase,
} from "./capability-definitions/vocabularies.js"

export {
  assertCatalogCompiles,
  CATALOG_PASS_IDS,
  CATALOG_PASSES,
  CatalogCompileError,
  compileCatalog,
  externalReferenceObjectName,
  formatCatalogReport,
  formatDiagnostic,
  runExternalReferencesPass,
  runReferentialIntegrityPass,
  runSafetyImplicationEdgesPass,
  runSlotDataflowPass,
  runTerminalCoveragePass,
  safetyMarkerOf,
  sortDiagnostics,
  type CatalogCompileResult,
  type CatalogDiagnostic,
  type CatalogDiagnosticSeverity,
  type CatalogPass,
  type CatalogPassId,
  type CatalogPassResult,
  type SafetyFamily,
  type SafetyMarker,
} from "./compiler/index.js"
