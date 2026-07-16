// extraction-ir.ts — the two net-new IRs (FE-0.1): `ExtractionIR` and
// `HydratedIntentIR`. Everything upstream of `ExtractionIR` is the
// probabilistic model call; everything at and downstream of
// `HydratedIntentIR` is deterministic, first-party (FE-0.2 — the trust
// boundary).
//
// The CONCEPTUAL pipeline these types describe (FE-0.1, the spec's IR chain):
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
//      v                      frozen)
//
// `IntentIR` (capability selection) and `EntityIR` (entity extraction) fold
// into `ExtractionIR` (FE-0.1): the capability and the entities are two
// facets of ONE non-deterministic model emission, not two separable
// deterministic transformations.
//
// FE-T05's ACTUAL implementation (how this tracer realizes the diagram
// above): NEITHER type is constructed as a live object threaded through the
// plan -> resolve -> buildEnvelope pipeline — there is no `HydratedIntentIR`
// value passed INTO `buildEnvelope`, and no provenance field ever rides the
// envelope. Instead, both IRs are MATERIALIZED POST-HOC, at audit time, by
// `audit-metadata.ts`'s `buildLanguageEngineAuditMetadata`: given the FINAL,
// already-adjudicated `AuditRecord` (whose `envelope.payload` already carries
// whatever the resolver resolved), it re-derives {ExtractionIR,
// HydratedIntentIR} from the capability's `CapabilityExtractionSchema` (which
// fields the model could have produced) plus a small per-capability
// resolver-field allowlist (which fields the resolver stamped) — see that
// module's header for the full wiring. This keeps the diagram's SHAPE
// contract testable and observable without adding a new live data structure
// to the hot path.

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
 * Conceptually runs OUTSIDE the model call, between resolution and
 * `buildEnvelope`. As actually implemented by this tracer, though, there is
 * no live value of this type built INLINE in that pipeline and passed into
 * `buildEnvelope` — the ops resolver (`ops-resolver.ts`) rewrites the payload
 * directly and calls `buildEnvelope` with it (no `HydratedIntentIR`
 * intermediate, no `provenance` field ever added to it there). This type is
 * instead materialized POST-HOC, at audit time, from the final adjudicated
 * envelope (see `audit-metadata.ts`) — provenance never rides the envelope
 * at any point, which trivially upholds FE-0.4's "provenance never rides the
 * kernel contract" without needing a projection step at construction time.
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
