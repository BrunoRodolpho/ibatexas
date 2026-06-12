// schema/journey.ts — Journey file schema v1 (Zod).
//
// A *journey* is an LLM-driven end-to-end test case: a persona pursues a
// business goal against the PUBLIC surface of the running system, and the
// harness verifies the kernel's audited decisions plus goal-state
// invariants. Vocabulary: "journey" (this package, new, LLM-driven) is NOT
// an "ibx scenario" (the existing data-state engine in packages/cli).
//
// ── Act-kind semantics (GOVERNANCE — binding) ────────────────────────────────
//
//   chat    → public surface only: the conversational endpoint
//             (`POST /api/chat/messages`). Carries the persona's utterance
//             and/or the goal text the test driver pursues.
//   http    → public surface only: a plain HTTP call against a public API
//             route (method/path/body, optionally authenticated `asRole`).
//   fixture → PRECONDITIONS ONLY, via existing seed helpers. A fixture act
//             may NEVER publish NATS, mint SYSTEM-taint envelopes, or write
//             any state that later appears in `expects`/`verify` — the
//             Phase-1b reconciliation gate enforces that every asserted
//             intent kind has a matching audited envelope produced by the
//             SUT itself; this schema records the rule.
//
// ── Entity references (schema-enforced) ──────────────────────────────────────
//
// Journeys reference catalog entities by HANDLE only (kebab-case, e.g.
// `costela-bovina-defumada`). Raw Medusa entity ids (`prod_…`, `variant_…`,
// `cart_…`) are not seed-stable and are rejected by a schema-level lint
// refinement (`raw_medusa_id`) anywhere inside `acts` or `params`.

import { z } from "zod"
import type { DecisionKind } from "@adjudicate/core"
import { Channel } from "@ibatexas/types"

// ── JSON value (for params / bodies / harness-bound args) ────────────────────

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

// ── Pinned vocabularies ──────────────────────────────────────────────────────

/** `JOURNEY-NNN` — three digits, zero-padded. Variants are `params`, never new ids. */
export const JOURNEY_ID_PATTERN = /^JOURNEY-\d{3}$/

/**
 * Kernel decision kinds a journey may expect. Pinned with `satisfies`
 * against `@adjudicate/core`'s `DecisionKind` so a platform-side rename
 * fails this package's build instead of silently green-lighting journeys.
 */
export const JOURNEY_EXPECT_DECISIONS = [
  "EXECUTE",
  "REFUSE",
  "ESCALATE",
  "REQUEST_CONFIRMATION",
  "DEFER",
  "REWRITE",
] as const satisfies readonly DecisionKind[]

/**
 * Dotted lowercase intent-kind shape (e.g. `order.checkout.create`).
 * MEMBERSHIP in `KNOWN_INTENT_KINDS` is the roster gate's job
 * (`ibx journey lint`, T1a-2) — the schema only pins the shape.
 */
export const INTENT_KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/

/**
 * Raw Medusa entity-id literals — forbidden anywhere in `acts`/`params`.
 * Matches `prod_…`, `variant_…`, `cart_…` at a word boundary followed by an
 * id-like tail (Medusa ids are 26-char ULIDs; ≥8 alphanumerics keeps the
 * lint hot while letting legitimate API FIELD NAMES like `variant_id` /
 * `cart_id` through — T1a-13: the storefront line-items route's body field
 * tripped the original any-length pattern).
 */
export const RAW_MEDUSA_ID_PATTERN = /(^|[^A-Za-z0-9_])(prod|variant|cart)_[A-Za-z0-9]{8,}/

// ── Acts ─────────────────────────────────────────────────────────────────────

const actBaseFields = {
  /** Optional stable label for traces; defaults to `act-<n>:<kind>` at run time. */
  name: z.string().min(1).optional(),
  /** Free-form authoring note (never interpreted). */
  note: z.string().optional(),
}

/**
 * `chat` act — public conversational surface. At least one of:
 *   utterance → the persona's literal opening message (scripted turn)
 *   goal      → the goal text the LLM test driver pursues over turns
 */
export const ChatActSchema = z
  .object({
    kind: z.literal("chat"),
    ...actBaseFields,
    utterance: z.string().min(1).optional(),
    goal: z.string().min(1).optional(),
  })
  .strict()

/** `http` act — public HTTP surface (staff probes, forged-actor probes…). */
export const HttpActSchema = z
  .object({
    kind: z.literal("http"),
    ...actBaseFields,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    /**
     * Public route path, must start with `/`. `:name` segments are resolved
     * from ctx.vars at execution time (e.g. `/api/orders/:orderId/cancel`) —
     * journeys never carry raw entity ids (T1a-13 harness).
     */
    path: z.string().regex(/^\//, "path must start with /"),
    /**
     * JSON body. String values that are exactly `:name` are resolved from
     * ctx.vars at execution time (same convention as path segments).
     */
    body: JsonValueSchema.optional(),
    /** Auth identity for the call; executors default to `anonymous`. */
    asRole: z.enum(["anonymous", "customer", "staff"]).optional(),
    /**
     * Response captures: varName → dot-path into the parsed JSON response
     * (e.g. `{ cartId: "cart.id" }`). The harness surfaces each captured
     * value into ctx.vars for later acts (T1a-13).
     */
    capture: z.record(z.string(), z.string()).optional(),
  })
  .strict()

/**
 * `fixture` act — PRECONDITIONS ONLY (see governance header). Names an
 * existing seed helper plus its params; may never produce state that the
 * journey later asserts in `expects`/`verify`.
 */
export const FixtureActSchema = z
  .object({
    kind: z.literal("fixture"),
    ...actBaseFields,
    /** Name of an existing seed helper (e.g. `seedCustomer`). */
    seed: z.string().min(1),
    params: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict()

export const ActSchema = z.discriminatedUnion("kind", [
  ChatActSchema,
  HttpActSchema,
  FixtureActSchema,
])

export type ChatAct = z.infer<typeof ChatActSchema>
export type HttpAct = z.infer<typeof HttpActSchema>
export type FixtureAct = z.infer<typeof FixtureActSchema>
export type JourneyAct = z.infer<typeof ActSchema>
export type ActKind = JourneyAct["kind"]

// ── Expects / verify ─────────────────────────────────────────────────────────

/**
 * One expected audited kernel decision: `{intentKind, decision}`.
 *
 * `optional: true` (T1b-1) marks the entry as a RECONCILIATION ALLOWANCE,
 * not a requirement: the trajectory matcher never requires it (the harness
 * filters optional entries out of the expected steps), but the
 * reconciliation gate accepts observed envelopes matching its
 * (intentKind, decision) tuple as EXPLAINED. Use it for envelopes the run
 * legitimately produces but does not assert — e.g. an executor's inner
 * projection-level transitions that share the customer audit namespace.
 * Optional entries claim NO coverage (gates/coverage.ts skips them).
 */
export const ExpectSchema = z
  .object({
    intentKind: z
      .string()
      .regex(INTENT_KIND_PATTERN, "intentKind must be dotted lowercase (e.g. order.checkout.create)"),
    decision: z.enum(JOURNEY_EXPECT_DECISIONS),
    optional: z.boolean().optional(),
  })
  .strict()

/** One goal-state invariant: harness-resolved id + YAML-bound args. */
export const VerifySchema = z
  .object({
    /** Invariant id resolved by the harness (T1a-10); `ibx journey lint` checks it resolves. */
    invariant: z.string().min(1),
    args: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict()

export type JourneyExpect = z.infer<typeof ExpectSchema>
export type JourneyVerify = z.infer<typeof VerifySchema>

// ── Journey file ─────────────────────────────────────────────────────────────

export const JourneyStatusSchema = z.enum(["active", "blocked"])
export type JourneyStatus = z.infer<typeof JourneyStatusSchema>

/** Channels a journey can drive (mirrors `Channel` from @ibatexas/types). */
export const JourneyChannelSchema = z.enum(Channel)

const journeyObjectSchema = z
  .object({
    id: z.string().regex(JOURNEY_ID_PATTERN, "id must match JOURNEY-NNN"),
    title: z.string().min(1),
    /** Why the business cares — the journey's reason to exist. */
    businessCase: z.string().min(1),
    /** Persona descriptor handed to the LLM test driver (pt-BR persona text allowed). */
    persona: z.string().min(1),
    channel: JourneyChannelSchema,
    /** Variant parameters — variants are params, never new JOURNEY ids. */
    params: z.record(z.string(), JsonValueSchema).optional(),
    /** Sequential acts (executed strictly in order). */
    acts: z.array(ActSchema).min(1),
    /** Expected audited kernel decisions (matched by the audit oracle). */
    expects: z.array(ExpectSchema),
    /** Goal-state invariants re-executed by the harness with YAML-bound args. */
    verify: z.array(VerifySchema),
    status: JourneyStatusSchema,
    /** Ids of the gaps blocking this journey (required iff status=blocked). */
    blocked_by: z.array(z.string().min(1)).default([]),
    /** Provenance: plan/spec reference that authored this journey. */
    source: z.string().min(1),
  })
  .strict()

/** Deep-walks a JSON-ish tree and reports paths containing raw Medusa ids. */
function findRawMedusaIds(
  value: unknown,
  path: (string | number)[],
  hits: (string | number)[][],
): void {
  if (typeof value === "string") {
    if (RAW_MEDUSA_ID_PATTERN.test(value)) hits.push(path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => findRawMedusaIds(item, [...path, i], hits))
    return
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (RAW_MEDUSA_ID_PATTERN.test(key)) hits.push([...path, key])
      findRawMedusaIds(child, [...path, key], hits)
    }
  }
}

export const JourneyFileSchema = journeyObjectSchema.superRefine((journey, ctx) => {
  // 1. Schema-level lint: no raw Medusa entity ids anywhere in acts/params —
  //    journeys reference catalog entities by HANDLE only.
  const hits: (string | number)[][] = []
  findRawMedusaIds(journey.acts, ["acts"], hits)
  findRawMedusaIds(journey.params ?? {}, ["params"], hits)
  for (const hitPath of hits) {
    ctx.addIssue({
      code: "custom",
      path: hitPath,
      message:
        "raw_medusa_id: raw Medusa entity ids (prod_/variant_/cart_) are not seed-stable — reference catalog entities by handle only",
    })
  }

  // 2. blocked/blocked_by consistency.
  if (journey.status === "blocked" && journey.blocked_by.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["blocked_by"],
      message: "blocked_without_reason: status=blocked requires at least one blocked_by id",
    })
  }
  if (journey.status === "active" && journey.blocked_by.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["blocked_by"],
      message: "active_with_blockers: status=active must have an empty blocked_by list",
    })
  }

  // 3. chat acts need driver input: utterance and/or goal.
  journey.acts.forEach((act, i) => {
    if (act.kind === "chat" && act.utterance === undefined && act.goal === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["acts", i],
        message: "chat_act_missing_text: a chat act needs an utterance and/or a goal",
      })
    }
  })
})

export type Journey = z.infer<typeof JourneyFileSchema>

// ── Named-error validation surface (consumed by `ibx journey lint`) ──────────

/** Stable machine-readable codes for schema failures. */
export type JourneySchemaErrorCode =
  | "invalid_journey_id"
  | "invalid_channel"
  | "invalid_decision"
  | "unknown_act_kind"
  | "raw_medusa_id"
  | "blocked_without_reason"
  | "active_with_blockers"
  | "chat_act_missing_text"
  | "schema_violation"

export interface JourneySchemaError {
  code: JourneySchemaErrorCode
  path: string
  message: string
}

const CUSTOM_CODES: readonly JourneySchemaErrorCode[] = [
  "raw_medusa_id",
  "blocked_without_reason",
  "active_with_blockers",
  "chat_act_missing_text",
]

function namedCode(issue: z.core.$ZodIssue): JourneySchemaErrorCode {
  if (issue.code === "custom") {
    const prefix = issue.message.split(":", 1)[0] as JourneySchemaErrorCode
    return CUSTOM_CODES.includes(prefix) ? prefix : "schema_violation"
  }
  const [head, , leaf] = issue.path
  if (head === "id") return "invalid_journey_id"
  if (head === "channel") return "invalid_channel"
  if (head === "expects" && leaf === "decision") return "invalid_decision"
  // A bad `kind` makes the act discriminated union unmatchable: zod reports
  // either on the discriminator path or as a union error on the act element
  // itself (path length 2 = ["acts", index]).
  if (
    head === "acts" &&
    (leaf === "kind" || (issue.code === "invalid_union" && issue.path.length === 2))
  ) {
    return "unknown_act_kind"
  }
  return "schema_violation"
}

export type JourneyValidation =
  | { ok: true; journey: Journey }
  | { ok: false; errors: JourneySchemaError[] }

/**
 * Validate an untyped document (e.g. parsed YAML) against the journey
 * schema, mapping zod issues to stable named error codes.
 */
export function validateJourney(data: unknown): JourneyValidation {
  const result = JourneyFileSchema.safeParse(data)
  if (result.success) return { ok: true, journey: result.data }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      code: namedCode(issue),
      path: issue.path.join("."),
      message: issue.message,
    })),
  }
}
