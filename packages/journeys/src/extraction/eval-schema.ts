// extraction/eval-schema.ts — LE2-05 ("Eval harness v1"): the committed file
// schemas the OFFLINE harness reads.
//
// Two NEW committed asset kinds live here, both under
// `packages/journeys/extraction-eval/`:
//
//   1. ARTIFACT FIXTURES (`fixtures/*.json`) — pinned, reviewed exports of a
//      captured parse. Two sources, each shaped by what its store can
//      actually give:
//        - `"audit-gold"`: an `intent_audit` row carrying the FE-T05
//          `metadata.languageEngine` sidecar (materialized post-hoc by
//          apps/api/src/claustrum/language-engine/audit-metadata.ts). Carries
//          the full ExtractionIR + HydratedIntentIR + per-field provenance +
//          the kernel decision — every clause an authored `expectPayload` can
//          declare is observable.
//        - `"wire"`: an `llm_wire` request/response ATTEMPT pair (one row per
//          attempt; UNIQUE(turn_id, seq); correlates to turn_trace on
//          (turn_id, call_index)). Carries ONLY the raw model completion (or
//          an `express_intent` tool call) — no resolver output, so no
//          hydration, no provenance, no kernel decision.
//      Exported fixtures follow the `ibx journey from-audit` governance
//      precedent: they are REVIEWED, COMMITTED files, never live reads. The
//      harness itself never touches a database.
//
//   2. THE REFUSAL CORPUS (`refusal-corpus.yaml`) — authored utterances that
//      must parse to NO capability at all. This is the extraction-plane
//      mirror of `read-tool-corpus/schema.ts`'s `expectArgs: null` sound-
//      abstain mode ("ok IFF the tool was NOT called"), re-keyed to the
//      capability envelope: `expectCapability: null` ⇒ ok IFF no capability
//      was parsed. Nothing in the tree scored this before LE2-05.
//
// The 308 authored cases in `packages/journeys/extraction-corpus/*.yaml` are
// consumed UNMODIFIED (their `ExtractionCase`/`IrExpectation` machinery is
// reused verbatim) — this file adds no clause to them.

import { z } from "zod"
import { INTENT_KIND_PATTERN } from "../schema/journey.js"
import { DecisionKindSchema } from "./schema.js"

/**
 * The reserved capability key the ∅ (no-parse) class is reported under —
 * `AccuracyCaseResult.capability` is schema-agnostic (the read-tool producer
 * already puts a TOOL name there), so the refusal class needs its own stable
 * key. Deliberately shaped to satisfy `INTENT_KIND_PATTERN` so a refusal case
 * can be waived by the ordinary `extraction-eval-waivers.json` machinery, and
 * deliberately NOT a real IntentEnvelope kind (nothing in the kernel's
 * registry is named `eval.*`).
 */
export const EVAL_REFUSAL_CAPABILITY = "eval.refusal"

/** Guard: `EVAL_REFUSAL_CAPABILITY` must stay waivable (pinned by a unit test). */
export const EVAL_REFUSAL_CAPABILITY_IS_WAIVABLE = INTENT_KIND_PATTERN.test(EVAL_REFUSAL_CAPABILITY)

// ── Artifact fixtures ───────────────────────────────────────────────────────

export const EVAL_ARTIFACT_SOURCES = ["audit-gold", "wire"] as const
export const EvalArtifactSourceSchema = z.enum(EVAL_ARTIFACT_SOURCES)
export type EvalArtifactSource = z.infer<typeof EvalArtifactSourceSchema>

/** Structural mirror of a materialized `ExtractionIR`/`HydratedIntentIR` (the
 *  sidecar shape `expect-payload.ts` already reads — duplicated, never
 *  imported: apps/* is out of bounds for this TEST-PLANE-ONLY package). */
const EvalIrSchema = z
  .object({
    payload: z.record(z.string(), z.unknown()),
    provenance: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    confirmationRequired: z.boolean().optional(),
  })
  .strict()

/** Free-form export provenance — recorded so a committed fixture is auditable
 *  back to its row. NEVER read by the scorer (it must not influence a score). */
const EvalProvenanceSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]))

const AuditGoldArtifactSchema = z
  .object({
    /** The utterance that produced this parse — the join key to an eval case. */
    utterance: z.string().min(1),
    /** The parsed capability, or `null` when the turn produced NO envelope. */
    capability: z.string().regex(INTENT_KIND_PATTERN).nullable(),
    extractionIR: EvalIrSchema.optional(),
    hydratedIntentIR: EvalIrSchema.optional(),
    /** The kernel's `AuditRecord.decision.kind` for the turn. */
    decision: DecisionKindSchema.optional(),
    provenance: EvalProvenanceSchema.optional(),
  })
  .strict()

const WireToolCallSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict()

const WireArtifactSchema = z
  .object({
    /** The user message the attempt was made for — the join key to an eval case. */
    utterance: z.string().min(1),
    /**
     * The RAW assistant completion text of this attempt, verbatim from
     * `llm_wire.response_jsonb.choices[0].message.content`. Stored raw (not
     * pre-parsed) on purpose: LE2 tickets 01–03 are about what the model
     * strands in this exact string, so the harness must own — and be able to
     * change — the reading of it. See `parseWireCompletion` in
     * `eval-score.ts`.
     */
    completion: z.string().optional(),
    /** The `express_intent` tool call, when the attempt used tool-calling
     *  instead of a text completion (`…message.tool_calls[0]`). */
    toolCall: WireToolCallSchema.optional(),
    provenance: EvalProvenanceSchema.optional(),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    if (artifact.completion === undefined && artifact.toolCall === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "empty_wire_artifact: a wire artifact must carry `completion` (the raw assistant text) " +
          "and/or `toolCall` — otherwise there is nothing to score",
      })
    }
  })

export type EvalAuditGoldArtifact = z.infer<typeof AuditGoldArtifactSchema>
export type EvalWireArtifact = z.infer<typeof WireArtifactSchema>

const EvalFixtureBaseSchema = {
  /** Bumped only on a BREAKING change to the fixture shape. */
  formatVersion: z.literal(1),
  /** Stable id (kebab-case) — appears in the report's source coverage rows. */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "id must be kebab-case"),
  /** How this file was produced (the export recipe, the run it came from…). */
  note: z.string().min(1),
  /**
   * TRUE when the rows are hand-authored to the store's schema rather than
   * exported from it. A synthetic fixture is still scored — it is simply
   * labelled everywhere it is reported, so nobody mistakes it for evidence.
   */
  synthetic: z.boolean(),
}

export const EvalFixtureFileSchema = z.discriminatedUnion("source", [
  z
    .object({
      ...EvalFixtureBaseSchema,
      source: z.literal("audit-gold"),
      artifacts: z.array(AuditGoldArtifactSchema).min(1),
    })
    .strict(),
  z
    .object({
      ...EvalFixtureBaseSchema,
      source: z.literal("wire"),
      artifacts: z.array(WireArtifactSchema).min(1),
    })
    .strict(),
])

export type EvalFixtureFile = z.infer<typeof EvalFixtureFileSchema>

// ── Refusal corpus ──────────────────────────────────────────────────────────

export const RefusalCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "id must be kebab-case"),
    utterance: z.string().min(1),
    /**
     * ALWAYS `null` — the sound-abstain assertion, spelled explicitly rather
     * than implied by the file's name (the read-tool corpus's `expectArgs:
     * null` precedent: an author reading one case must see the claim it
     * makes). A future non-null variant would be a different case kind.
     */
    expectCapability: z.null(),
    note: z.string().optional(),
  })
  .strict()

export type RefusalCase = z.infer<typeof RefusalCaseSchema>

export const RefusalCorpusFileSchema = z
  .object({
    /** Provenance: which ticket/spec section authored this corpus. */
    source: z.string().min(1),
    cases: z.array(RefusalCaseSchema).min(1),
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

export type RefusalCorpusFile = z.infer<typeof RefusalCorpusFileSchema>

// ── Named-error validation surface (mirrors schema.ts's contract) ───────────

export type EvalSchemaErrorCode =
  | "invalid_fixture"
  | "invalid_refusal_corpus"
  | "duplicate_case_id"
  | "empty_wire_artifact"
  | "schema_violation"

export interface EvalSchemaError {
  code: EvalSchemaErrorCode
  path: string
  message: string
}

const CUSTOM_CODES: ReadonlySet<EvalSchemaErrorCode> = new Set([
  "duplicate_case_id",
  "empty_wire_artifact",
])

function namedCode(issue: z.core.$ZodIssue, fallback: EvalSchemaErrorCode): EvalSchemaErrorCode {
  if (issue.code === "custom") {
    const prefix = issue.message.split(":", 1)[0] as EvalSchemaErrorCode
    if (CUSTOM_CODES.has(prefix)) return prefix
  }
  return fallback
}

function toErrors(error: z.ZodError, fallback: EvalSchemaErrorCode): EvalSchemaError[] {
  return error.issues.map((issue) => ({
    code: namedCode(issue, fallback),
    path: issue.path.join("."),
    message: issue.message,
  }))
}

export type EvalFixtureValidation =
  | { ok: true; file: EvalFixtureFile }
  | { ok: false; errors: EvalSchemaError[] }

export function validateEvalFixture(data: unknown): EvalFixtureValidation {
  const result = EvalFixtureFileSchema.safeParse(data)
  if (result.success) return { ok: true, file: result.data }
  return { ok: false, errors: toErrors(result.error, "invalid_fixture") }
}

export type RefusalCorpusValidation =
  | { ok: true; file: RefusalCorpusFile }
  | { ok: false; errors: EvalSchemaError[] }

export function validateRefusalCorpus(data: unknown): RefusalCorpusValidation {
  const result = RefusalCorpusFileSchema.safeParse(data)
  if (result.success) return { ok: true, file: result.data }
  return { ok: false, errors: toErrors(result.error, "invalid_refusal_corpus") }
}
