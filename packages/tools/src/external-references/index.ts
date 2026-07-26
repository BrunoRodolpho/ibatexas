// EXTERNAL REFERENCES — the verification half of LE2-018.
//
// `@ibatexas/catalog` DECLARES which promotions and zones the code depends on;
// this directory is where those declarations meet a live store. The split is
// the catalog package's one rule ("the catalog defines; it never holds runtime
// authority") drawn at the only place it could be: the catalog holds no key,
// no client and no IO, and everything that does lives here.
//
//   config.ts     the declared env var → the reference's key
//   probes.ts     one yes/no question per store, over the EXISTING clients
//   reconcile.ts  the whole table → a verdict, and the fail-closed assertion
//
// Consumers of a reference call `requireExternalReferenceKey`. The api's boot
// gate and `ibx catalog check --live` call `assertExternalReferencesReconcile`
// and `reconcileExternalReferences` respectively.

export {
  ExternalReferenceConfigError,
  externalReferenceKey,
  findExternalReference,
  requireExternalReferenceKey,
  type EnvLike,
} from "./config.js"

export {
  DEFAULT_EXTERNAL_REFERENCE_PROBES,
  probeDeliveryZone,
  probeMedusaPromotion,
  type ExternalReferenceProbe,
  type ExternalReferenceProbes,
  type ProbeVerdict,
} from "./probes.js"

export {
  assertExternalReferencesReconcile,
  ExternalReferenceReconciliationError,
  formatExternalReferenceMiss,
  formatExternalReferenceReport,
  reconcileExternalReferences,
  type ExternalReferenceHit,
  type ExternalReferenceMiss,
  type ExternalReferenceMissReason,
  type ExternalReferenceReconciliation,
  type ReconcileOptions,
} from "./reconcile.js"
