// read-tool-corpus/schema.ts — FE-T13: structural validation for the
// packages/journeys/read-tool-corpus/*.yaml files.
//
// Deliberately NOT a reuse of ../schema/journey.js's `ExtractionCorpusFileSchema`
// (that schema's `capability` field is validated against `INTENT_KIND_PATTERN`,
// a dotted-lowercase IntentEnvelope-kind shape like "order.status.transition" —
// a read tool's name, "check_order_status", is snake_case and is not an
// IntentEnvelope kind at all) and its `expectPayload.extractionIR`/
// `hydratedIntentIR` assertions read a kernel-adjudicated `AuditRecord`'s
// sidecar, which a read tool call never produces (see any corpus file's own
// header for the full rationale). This is a narrower, read-tool-shaped sibling:
// `{tool, source, cases: [{id, utterance, expectArgs, note?, precedingContext?}]}`.
//
// `expectArgs: null` is a valid, meaningful case (see get_also_added.yaml /
// get_ordered_together.yaml): it documents that a SOUND extraction abstains
// entirely (no tool call) rather than guessing a lookup-key value with no
// grounding context — distinct from `expectArgs: {}` (a real, empty-args
// tool call IS expected).

import { z } from "zod"

export const ReadToolCorpusCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "id must be kebab-case"),
    utterance: z.string().min(1),
    /** Documents the earlier conversational turn a productId-style lookup
     *  key was established by (get_also_added / get_ordered_together only). */
    precedingContext: z.string().optional(),
    /** The expected tool-call arguments, OR `null` to assert a sound
     *  extraction abstains (never calls the tool) rather than guessing. */
    expectArgs: z.record(z.string(), z.unknown()).nullable(),
    note: z.string().optional(),
  })
  .strict()

export type ReadToolCorpusCase = z.infer<typeof ReadToolCorpusCaseSchema>

export const ReadToolCorpusFileSchema = z
  .object({
    tool: z.string().regex(/^[a-z][a-z0-9_]*$/, "tool must be a snake_case read-tool name"),
    source: z.string().min(1),
    cases: z.array(ReadToolCorpusCaseSchema).min(1),
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

export type ReadToolCorpusFile = z.infer<typeof ReadToolCorpusFileSchema>

export function validateReadToolCorpus(
  data: unknown,
): { ok: true; file: ReadToolCorpusFile } | { ok: false; errors: string[] } {
  const result = ReadToolCorpusFileSchema.safeParse(data)
  if (result.success) return { ok: true, file: result.data }
  return { ok: false, errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }
}
