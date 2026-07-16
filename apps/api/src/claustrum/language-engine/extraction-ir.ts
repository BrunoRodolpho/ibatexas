// extraction-ir.ts — the two net-new IRs (FE-0.1): `ExtractionIR` and
// `HydratedIntentIR`. Everything upstream of `ExtractionIR` is the
// probabilistic model call; everything at and downstream of
// `HydratedIntentIR` is deterministic, first-party (FE-0.2 — the trust
// boundary).
//
//   User Text
//      | ExtractionIR      — language -> untrusted {capability, typed
//      v                      directives} (the boundary artifact of the
//                             single model call)
//   ExtractionIR
//      | HydratedIntentIR  — references -> resolved entities + per-field
//      v                      provenance (deterministic, OUTSIDE the model
//                             call — the trust boundary)
//   HydratedIntentIR
//      | IntentEnvelope    — resolved intent -> kernel contract (EXISTS,
//      v                      frozen; provenance is projected away here)
//
// `IntentIR` (capability selection) and `EntityIR` (entity extraction) fold
// into `ExtractionIR` (FE-0.1): the capability and the entities are two
// facets of ONE non-deterministic model emission, not two separable
// deterministic transformations.

import type { FieldProvenance } from "./field-trust.js";

/** Per-field provenance, keyed by the field's name in `payload`. */
export type FieldProvenanceMap = Readonly<Record<string, FieldProvenance>>;

/**
 * `ExtractionIR` — what the model extracted from a single utterance: the
 * capability it selected and the typed directive fields it could produce,
 * each tagged with its provenance. Untrusted by construction (P1): its
 * payload values are natural language / model output, its identifiers
 * unresolved. Produced by the single constrained model call (the planner's
 * `express_intent` completion); never mutated afterward.
 */
export interface ExtractionIR<TPayload = Readonly<Record<string, unknown>>> {
  readonly capability: string;
  readonly payload: TPayload;
  readonly provenance: FieldProvenanceMap;
}

/**
 * `HydratedIntentIR` — the deterministic resolution of an `ExtractionIR`:
 * natural-language references resolved to owner/tenant-scoped entities,
 * identity/tenant/clock stamped from the authenticated session (never from
 * model input), and per-field provenance attached (FE-1.5). An auto-resolved
 * (guessed) target is tagged `grounded` and `confirmationRequired` is set —
 * the kernel's REQUEST_CONFIRMATION park idiom is what actually enforces the
 * confirmation; this flag records WHY hydration asked for it.
 *
 * Runs OUTSIDE the model call. `IntentEnvelope` (existing, frozen) is built
 * FROM this — the envelope carries `payload` (and the runtime-stamped
 * identity fields) but never `provenance`: it is projected away at
 * `buildEnvelope` (FE-0.4) so the kernel contract stays byte-identical in
 * shape and hash to today's.
 */
export interface HydratedIntentIR<TPayload = Readonly<Record<string, unknown>>> {
  readonly capability: string;
  readonly payload: TPayload;
  readonly provenance: FieldProvenanceMap;
  /**
   * True when at least one field's provenance is `grounded` (an auto-resolved
   * guess, not an authoritative/explicit resolution) — the kernel-level
   * REQUEST_CONFIRMATION park idiom is expected to fire for this intent.
   */
  readonly confirmationRequired: boolean;
}

/** True when `provenance` carries at least one `grounded`-trust field. */
export function hasGroundedField(provenance: FieldProvenanceMap): boolean {
  return Object.values(provenance).some((p) => p.trust === "grounded");
}
