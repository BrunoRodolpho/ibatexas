// audit-metadata.ts — the audit-record extension (the decided test seam):
// materialize `ExtractionIR` + `HydratedIntentIR` (with per-field provenance)
// onto the `intent_audit` row via `@adjudicate/core`'s ADR-124 v5 `metadata`
// mechanism, so extraction accuracy and provenance coverage are observable
// DIRECTLY from the audit record rather than inferred from the collapsed
// post-resolution envelope.
//
// Wiring (see `claustrum-bootstrap.ts`'s `safeAuditedAdjudicate`): this pure
// function is passed as `AdjudicateAndAuditDeps.metadataProvider`, a
// SYNCHRONOUS hook `@adjudicate/core` runs "after buildAuditRecord and before
// sink.emit" — i.e. it receives the FINAL, POST-RESOLUTION `AuditRecord`
// (whose `envelope.payload` already carries the hydrated/resolved fields)
// and its return value is merged onto `record.metadata`. `metadata` is
// EXCLUDED from the `auditHash` pre-image (ADR-124), so this attaches
// governance/observability data without ever touching the kernel's
// tamper-evidence or the envelope's hashed shape (FE-0.4's "provenance never
// rides the kernel contract" is upheld: `envelope.payload` itself never
// carries a provenance key — only the SIDECAR `record.metadata` does).
//
// Deliberately narrow (this tracer's scope): only `order.status.transition`
// is recognized; every other capability returns `undefined` (a no-op —
// `attachAuditMetadata`/`metadataProvider` leave `record.metadata` absent
// when the provider returns undefined), so this is 100% inert for every
// other capability in the system. Later rollout slices (T11-14) extend the
// capability set this function recognizes as their own extraction schemas
// land — the shape (derive ExtractionIR + HydratedIntentIR from the final
// envelope via the capability's `CapabilityExtractionSchema`) generalizes
// directly.

import type { AuditRecord } from "@adjudicate/core";
import {
  modelProvenance,
  resolverGroundedProvenance,
} from "./field-trust.js";
import {
  hasGroundedField,
  type ExtractionIR,
  type FieldProvenanceMap,
  type HydratedIntentIR,
} from "./extraction-ir.js";
import {
  extractionFieldNames,
  type CapabilityExtractionSchema,
} from "./extraction-schema.js";
import { ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA } from "./order-status-transition.schema.js";

/** The shape materialized under `record.metadata.languageEngine`. */
export interface LanguageEngineAuditMetadata {
  readonly extractionIR: ExtractionIR;
  readonly hydratedIntentIR: HydratedIntentIR;
}

/**
 * Split a RESOLVED payload back into {extraction fields} (what the schema
 * says the model could have produced) and the REST (everything the resolver
 * added/stamped) — pure, schema-driven. Fields the schema doesn't declare are
 * NOT model output by contract (FE-1.1: the schema lists ONLY what the model
 * can produce), so they are always resolver-owned here.
 */
function splitResolvedPayload(
  schema: CapabilityExtractionSchema,
  resolvedPayload: Readonly<Record<string, unknown>>,
): {
  extractionPayload: Record<string, unknown>;
  resolverFieldNames: readonly string[];
} {
  const modelFieldNames = extractionFieldNames(schema);
  const extractionPayload: Record<string, unknown> = {};
  const resolverFieldNames: string[] = [];
  for (const [key, value] of Object.entries(resolvedPayload)) {
    if (modelFieldNames.has(key)) {
      extractionPayload[key] = value;
    } else {
      resolverFieldNames.push(key);
    }
  }
  return { extractionPayload, resolverFieldNames };
}

/**
 * order.status.transition-specific derivation (this tracer's one wired
 * capability). The resolved envelope payload is `{orderId, newStatus, ...}`
 * (see `ops-resolver.ts`'s `order.status.transition` branch — `orderId` is
 * ALWAYS resolver-filled under the FE-T05 extraction schema, since the model
 * is never shown an orderId field, and resolution in this tracer's scope is
 * always the grounded "most recent active order" fallback — see
 * `ops-order-resolution.ts`'s `resolveMostRecentActiveOrder`).
 */
function deriveOrderStatusTransition(
  resolvedPayload: Readonly<Record<string, unknown>>,
): LanguageEngineAuditMetadata {
  const schema = ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA;
  const { extractionPayload } = splitResolvedPayload(schema, resolvedPayload);

  const extractionProvenance: Record<string, ReturnType<typeof modelProvenance>> =
    {};
  for (const field of schema.fields) {
    if (field.name in extractionPayload) {
      extractionProvenance[field.name] = modelProvenance();
    }
  }
  const extractionIR: ExtractionIR = {
    capability: schema.capability,
    payload: extractionPayload,
    provenance: extractionProvenance,
  };

  // Hydration: orderId is ALWAYS resolver-filled (grounded/session-derived —
  // this tracer's scope is exactly the "meu último pedido" auto-resolve
  // path, never an explicit reference), newStatus stays model/untrusted.
  const hydratedProvenance: Record<string, FieldProvenanceMap[string]> = {
    ...extractionProvenance,
  };
  if (typeof resolvedPayload.orderId === "string") {
    hydratedProvenance.orderId = resolverGroundedProvenance();
  }
  const hydratedIntentIR: HydratedIntentIR = {
    capability: schema.capability,
    payload: resolvedPayload,
    provenance: hydratedProvenance,
    confirmationRequired: hasGroundedField(hydratedProvenance),
  };

  return { extractionIR, hydratedIntentIR };
}

/**
 * The `AdjudicateAndAuditDeps.metadataProvider` implementation: given the
 * FINAL, post-resolution `AuditRecord`, return the `{languageEngine: {...}}`
 * metadata to merge onto `record.metadata`, or `undefined` for every
 * capability this tracer does not (yet) recognize.
 */
export function buildLanguageEngineAuditMetadata(
  record: AuditRecord,
): Readonly<Record<string, unknown>> | undefined {
  const payload = record.envelope.payload as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (payload === undefined) return undefined;

  if (record.envelope.kind === "order.status.transition") {
    return { languageEngine: deriveOrderStatusTransition(payload) };
  }
  return undefined;
}
