// extraction/schema.ts — the extraction-corpus file schema (FE-T06, FE-2.1).
//
// A per-capability extraction corpus is a NEW, DISTINCT committed asset from
// a *journey* (schema/journey.ts): a journey is a full multi-act end-to-end
// business scenario driven against a live running system; an extraction
// CASE is a single `{utterance -> expected {capability, payload subset}}`
// pair (spec FE-2.1) — narrow, capability-scoped, and asserted purely at the
// audit-record level (no HTTP acts, no fixtures, no live server). Same
// AUTHORING STYLE as journeys (YAML + Zod schema + named error codes + a
// loader), deliberately NOT the same shape.
//
// Independent-truth discipline (FE-2.1 / FE-2.2): the `expectPayload` block
// on each case is AUTHORED, pinned by this file — it is NEVER derived from
// the model under test. `compileExpectPayload` (expect-payload.ts) turns it
// into the same `PayloadPredicate` the oracle's `where` clause already
// consumes (oracle/audit-trail-matcher.ts) — no new assertion mechanism, a
// declarative compiler in front of the existing one.

import { z } from "zod"
import { INTENT_KIND_PATTERN } from "../schema/journey.js"

/** Mirrors `FieldProvenanceTrust` (apps/api language-engine/field-trust.ts) —
 *  duplicated here (not imported: apps/* is never imported by this
 *  TEST-PLANE-ONLY package, check-bypass leg 6/7) since it is a small, stable,
 *  closed vocabulary the front-end spec (FE-0.4) freezes. */
export const FIELD_TRUST_VALUES = ["untrusted", "grounded", "authoritative"] as const
export const FieldTrustSchema = z.enum(FIELD_TRUST_VALUES)
export type FieldTrust = z.infer<typeof FieldTrustSchema>

/**
 * What a case expects of ONE materialized IR (ExtractionIR or
 * HydratedIntentIR) — deliberately partial: an author declares only what the
 * case is meant to pin, everything else is unchecked.
 *
 *   - `payload`         — exact key/value pairs the IR's payload MUST carry.
 *   - `payloadExactKeys` — when true (default for extractionIR — see
 *     `ExtractionCaseSchema`'s refine below), the IR's payload key SET must
 *     equal exactly `Object.keys(payload)` — no extra keys. This is how a
 *     case pins "the model extracted ONLY {newStatus}" (FE-T05 AC1), not
 *     merely "at least these fields."
 *   - `payloadPresent`  — field names that must be present with a non-empty
 *     value, WITHOUT pinning the exact value (for resolver-stamped
 *     identifiers such as a hydrated `orderId`, whose concrete value is
 *     seed/run-dependent and not authored ahead of time).
 *   - `provenanceTrust` — expected `FieldProvenance.trust` per field name.
 */
export const IrExpectationSchema = z
  .object({
    payload: z.record(z.string(), z.unknown()).optional(),
    payloadExactKeys: z.boolean().optional(),
    payloadPresent: z.array(z.string().min(1)).optional(),
    provenanceTrust: z.record(z.string(), FieldTrustSchema).optional(),
  })
  .strict()

export type IrExpectation = z.infer<typeof IrExpectationSchema>

/**
 * `expectPayload` — the declarative assertion surface (FE-2.2). `extractionIR`
 * is required (every case pins what the model was expected to produce);
 * `hydratedIntentIR` is optional (a case may stop at the model's raw output).
 */
export const ExpectPayloadSchema = z
  .object({
    extractionIR: IrExpectationSchema,
    hydratedIntentIR: z
      .object({
        ...IrExpectationSchema.shape,
        /** Expected `HydratedIntentIR.confirmationRequired`. */
        confirmationRequired: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type ExpectPayload = z.infer<typeof ExpectPayloadSchema>

export const ExtractionCaseSchema = z
  .object({
    /** Stable, kebab-case case id (unique within the file). */
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "id must be kebab-case (e.g. most-recent-order-to-ready)"),
    /** The literal utterance driven against the model (pt-BR). */
    utterance: z.string().min(1),
    expectPayload: ExpectPayloadSchema,
    /** Free-form authoring note (never interpreted). */
    note: z.string().optional(),
  })
  .strict()

export type ExtractionCase = z.infer<typeof ExtractionCaseSchema>

export const ExtractionCorpusFileSchema = z
  .object({
    /** The chat-drivable capability every case in this file targets. */
    capability: z
      .string()
      .regex(INTENT_KIND_PATTERN, "capability must be dotted lowercase (e.g. order.status.transition)"),
    /** Provenance: which ticket/spec section authored this corpus. */
    source: z.string().min(1),
    cases: z.array(ExtractionCaseSchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>()
    file.cases.forEach((c, i) => {
      if (seen.has(c.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", i, "id"],
          message: `duplicate_case_id: case id "${c.id}" already used earlier in this file`,
        })
      }
      seen.add(c.id)
    })
  })

export type ExtractionCorpusFile = z.infer<typeof ExtractionCorpusFileSchema>

// ── Named-error validation surface (mirrors schema/journey.ts's contract) ────

export type ExtractionSchemaErrorCode =
  | "invalid_capability"
  | "invalid_case_id"
  | "duplicate_case_id"
  | "schema_violation"

export interface ExtractionSchemaError {
  code: ExtractionSchemaErrorCode
  path: string
  message: string
}

const CUSTOM_CODES: ReadonlySet<ExtractionSchemaErrorCode> = new Set(["duplicate_case_id"])

function namedCode(issue: z.core.$ZodIssue): ExtractionSchemaErrorCode {
  if (issue.code === "custom") {
    const prefix = issue.message.split(":", 1)[0] as ExtractionSchemaErrorCode
    return CUSTOM_CODES.has(prefix) ? prefix : "schema_violation"
  }
  const [head, , leaf] = issue.path
  if (head === "capability") return "invalid_capability"
  if (head === "cases" && leaf === "id") return "invalid_case_id"
  return "schema_violation"
}

export type ExtractionCorpusValidation =
  | { ok: true; file: ExtractionCorpusFile }
  | { ok: false; errors: ExtractionSchemaError[] }

/** Validate an untyped document (e.g. parsed YAML) against the corpus schema. */
export function validateExtractionCorpus(data: unknown): ExtractionCorpusValidation {
  const result = ExtractionCorpusFileSchema.safeParse(data)
  if (result.success) return { ok: true, file: result.data }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      code: namedCode(issue),
      path: issue.path.join("."),
      message: issue.message,
    })),
  }
}
