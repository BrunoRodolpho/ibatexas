// field-trust.ts — the Identity/State/Directive field-trust taxonomy (FE-0.3)
// and the per-field provenance tag (FE-0.4).
//
// This is the reusable IR foundation FE-T05 (the first tracer) establishes for
// every later extraction slice (T11-14). It is IN-REPO front-end typing — it
// describes how the Language Engine reasons about a field's origin and
// trustworthiness BEFORE the field reaches the frozen `@adjudicate/core`
// kernel. None of this rides the kernel contract: `HydratedIntentIR`'s
// provenance is projected away at `buildEnvelope` (see envelope.ts in this
// module) and is consumed only in-repo (validation, gating, audit).
//
// ── The three field classes (FE-0.3) ────────────────────────────────────────
//
//   Identity  — actor, session, role, nonce, tenant, clock. Producer: runtime
//               composition. Trust: authoritative. NEVER derived from model
//               output, payload, tool-call fields, or conversation text.
//   State     — ownership, current status, totals, stock caps. Producer:
//               first-party systems (loaded read-only, customer/staff-scoped).
//               An identifier field in this class is consumed ONLY as a lookup
//               key; the returned ownership/state FACT — not the id string —
//               gates execution.
//   Directive — quantity, new status, payment method, note text, and similar
//               user-intent content (including a natural-language reference
//               the model copies verbatim). Producer: user/model. Trust:
//               untrusted until adjudicated — every consumer must validate it
//               against authoritative State before it can execute.
//
// The canonical one-line invariant (FE-0.3): no identity or adjudicated-
// against-state input may be model-derived; identifier fields gate only via
// re-derived ownership facts; directive fields stay untrusted and every
// consumer must adjudicate them against authoritative state before execution.
export type FieldTrustClass = "identity" | "state" | "directive";

/** Who produced a field's value. */
export type FieldProvenanceProducer = "model" | "runtime" | "resolver";

/** How the value was arrived at. */
export type FieldProvenanceConfidence = "explicit" | "inferred" | "resolved";

/** How much the runtime trusts the value, absent further adjudication. */
export type FieldProvenanceTrust = "untrusted" | "grounded" | "authoritative";

/**
 * The per-field provenance tag (FE-0.4). Carried on `HydratedIntentIR`,
 * consumed in-repo, projected away before the envelope reaches the kernel.
 */
export interface FieldProvenance {
  readonly producer: FieldProvenanceProducer;
  readonly confidence: FieldProvenanceConfidence;
  readonly trust: FieldProvenanceTrust;
}

/**
 * A model-emitted natural-language payload value — untrusted by construction
 * (FE-0.4 representative mapping: "a model natural-language payload value").
 */
export function modelProvenance(
  confidence: FieldProvenanceConfidence = "explicit",
): FieldProvenance {
  return { producer: "model", confidence, trust: "untrusted" };
}

/**
 * An auto-resolved ("most recent" / "last order") target — a GUESS, so it is
 * `grounded`, never `authoritative` (FE-0.4: "an auto-resolved 'most recent'
 * target → {resolver, resolved, grounded}... forces a confirmation").
 */
export function resolverGroundedProvenance(): FieldProvenance {
  return { producer: "resolver", confidence: "resolved", trust: "grounded" };
}

/**
 * A resolved identifier from an EXPLICIT reference (e.g. a display number or
 * an exact name match) — `authoritative` (FE-0.4: "a resolved identifier from
 * an explicit reference → {resolver, resolved, authoritative}").
 */
export function resolverAuthoritativeProvenance(): FieldProvenance {
  return {
    producer: "resolver",
    confidence: "resolved",
    trust: "authoritative",
  };
}

/**
 * An injected actor/nonce/clock/tenant field — Identity class, always
 * authoritative (FE-0.4: "an injected actor/nonce/clock → {runtime,
 * authoritative, authoritative}").
 */
export function runtimeIdentityProvenance(): FieldProvenance {
  return { producer: "runtime", confidence: "explicit", trust: "authoritative" };
}
