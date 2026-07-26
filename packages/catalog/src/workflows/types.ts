/**
 * WORKFLOW DEFINITIONS — the catalog half of LE2-020 (ticket 20, "journey
 * runtime v0"; implemented as **workflow** everywhere per the owner's naming
 * decision — see the package README's vocabulary note and `../index.ts`).
 *
 * A workflow is a HAND-AUTHORED, multi-step route over capabilities the catalog
 * already declares. It is the answer to LE2 Implementation Decision 14/15/17 and
 * to the spec's Out-of-Scope line *"Model-authored plans — journeys are
 * authored; an unmatched multi-step request clarifies"*: the model SELECTS and
 * PARAMETERIZES a workflow, it never composes one.
 *
 * # This file declares SHAPE ONLY — it holds no authority
 *
 * Same rule as every other module in this package (see `../index.ts`): the
 * catalog DEFINES, it never holds runtime authority. Nothing here decides
 * anything at request time. In particular:
 *
 *   - A workflow definition does not GRANT a capability. Every activity is
 *     adjudicated by the kernel individually, at run time, against current
 *     code — a definition that names `order.reorder` does not make
 *     `order.reorder` executable, it only says which envelope the runtime will
 *     submit for adjudication (LE2 Implementation Decision 17: *"journey
 *     instances pin shape, adjudicate fresh"*).
 *   - A matcher is not a router and not a regex. It is a DECLARED PRECONDITION
 *     over the capability roster the turn's capability planners already
 *     authorized — see {@link WorkflowMatcher}. It can only ever NARROW what is
 *     offered, never widen it.
 *   - A template is a pt-BR string with named placeholders. It is filled from
 *     resolved params, never from model prose.
 *
 * # v0 SHAPE (deliberately small)
 *
 * LINEAR ONLY. No conditions, no branches, no compensation — those are ticket
 * 22, and their absence here is a scope decision, not an oversight. A v0
 * workflow is: a closed set of matchers, one selection capability, params each
 * sourced from a VALIDATED CLAIM or a CUSTOMER-AUTHORED SLOT, an ordered
 * activity list, ONE confirm point, and a render template for every outcome.
 *
 * # Why params have exactly two sources
 *
 * {@link WorkflowParamSource} is a two-member union and that is the whole
 * anti-confabulation guarantee of the parameterization half: an activity's
 * payload field can be bound to a value the CLAIMS KERNEL validated, or to a
 * slot the CUSTOMER authored in the selecting utterance — and to nothing else.
 * There is deliberately no `{ from: "model" }` member and no free-text default,
 * so "the model invented this amount" is not a state the type system can
 * express. The runtime half is structural too: the param resolver takes no
 * model port (see `apps/api/src/claustrum/workflow/workflow-params.ts`).
 */

/**
 * A DECLARED PRECONDITION for offering a workflow to the parser this turn.
 *
 * Read it as: *"only offer this workflow when the turn's capability planners
 * have already authorized `capability`"*. Every matcher on a definition must
 * hold (conjunctive) — there is no `any-of`, no scoring, and no fuzzy match, in
 * the same closed-and-deterministic spirit as the L0 lexicon and the alias
 * gazetteer.
 *
 * DIRECTION IS LOAD-BEARING: a matcher is evaluated against the roster
 * `unionPlans()` produced, so auth level, cart state and the ops boundary all
 * stay strictly UPSTREAM of workflow advertisement. A workflow can therefore
 * only ever be offered to someone who could already have asked for the
 * capability directly — advertising one can never widen the surface, exactly as
 * L2's retriever can only narrow it.
 */
export interface WorkflowMatcher {
  /** An intent kind that must be in this turn's authorized roster. */
  readonly capability: string
}

/**
 * The capability the SELECTION envelope carries.
 *
 * Selecting a workflow is a governed act, not a bookkeeping one: the runtime
 * mints a real `IntentEnvelope` of this kind and the kernel adjudicates it
 * exactly as it would for a directly-parsed capability. That is what makes the
 * whole-workflow confirm real — the CONFIRM comes from the same guards, over
 * the same grounded state, that a standalone request for this capability would
 * face, with no workflow-specific bypass anywhere.
 *
 * It must NOT be a workflow-scoped kind: the selection envelope originates in a
 * parse, and a workflow-scoped kind is by definition not parser-reachable
 * (compiler rule `workflow-scoped-reference-unreachable`).
 */
export interface WorkflowSelection {
  readonly capability: string
}

/**
 * Where an activity's payload value comes from. Exactly two members, forever —
 * see the module doc.
 *
 * `"claim"` — a field of a claim the CLAIMS KERNEL validated this turn. The
 * strongest source: the value is first-party-derived and independently
 * validated before the workflow ever sees it.
 *
 * `"slot"` — a value the CUSTOMER authored in the selecting utterance, carried
 * on the selection tool call's `slots` object. Model-EXTRACTED but
 * customer-AUTHORED: the model reports what the customer said, it does not
 * originate the value, and the extraction is bounded by the closed slot surface
 * the workflow declares.
 */
export type WorkflowParamSource =
  | {
      readonly from: "claim"
      /** The registry claim type whose validated value supplies this param. */
      readonly claimType: string
      /** The field of that claim's value to read. */
      readonly field: string
    }
  | {
      readonly from: "slot"
      /** The customer-authored slot name on the selection call. */
      readonly slot: string
    }

/** One named value a workflow's activities may bind. */
export interface WorkflowParam {
  readonly name: string
  readonly source: WorkflowParamSource
}

/**
 * How one payload field of one activity gets its value: a declared param, or a
 * literal the AUTHOR wrote. Both are first-party; neither can be model-authored.
 */
export type WorkflowPayloadBinding =
  | { readonly param: string }
  | { readonly const: string | number | boolean }

/**
 * One step. `capability` is adjudicated individually at run time and writes its
 * own audit row — an activity is a normal governed mutation that happens to have
 * been proposed by a workflow instead of by a parse.
 */
export interface WorkflowActivity {
  /** Unique within the workflow — the join key of the per-step trace record. */
  readonly id: string
  readonly capability: string
  readonly payload: Readonly<Record<string, WorkflowPayloadBinding>>
}

/**
 * THE confirm point. Exactly one per workflow in v0 (the field is singular, not
 * an array, so "two confirm points" is not expressible): the customer confirms
 * the WHOLE workflow once, before any activity runs, and the prompt they see is
 * rendered from `template` with grounded values.
 */
export interface WorkflowConfirmPoint {
  /** Id of the template rendering the confirm prompt. */
  readonly template: string
}

/**
 * THE CONFIRM-TEMPLATE AUTHORING RULE (LE2-021) — binding on every workflow.
 *
 * A confirm template MUST contain `{confirmation}`, and every other word in it
 * MUST be ADDITIVE framing around that placeholder. It may add context before or
 * after the kernel's sentence; it may never restate, summarise, soften,
 * contradict or replace it.
 *
 * ── WHY THIS IS A RULE AND NOT A PREFERENCE ──────────────────────────────────
 *
 * Since LE2-021 the confirm the customer READS is this template
 * (`ibatexas-responder.ts`'s `workflowConfirm` seam). But the PARK stores
 * `decision.prompt` — the kernel's own sentence — as its `userPrompt`, written
 * by `@claustrum/core` at dispatch, and nothing in the adopter can change that:
 * `observeWorkflowDecisions` is observe-only by construction, so the only way to
 * unify the two would be to substitute the decision itself, which is precisely
 * the bypass the workflow layer must never have.
 *
 * So the two strings genuinely differ, and one of them is read back to the
 * customer later: the BKL-212 soft-affirmative restatement quotes the park's
 * `userPrompt` when a customer replies "ok" instead of "sim". Under this rule
 * that restatement is a SUBSET of what they already read — the same grounded
 * question, without the framing — which is a narrowing, not a contradiction. Break
 * the rule and the restatement becomes a different question from the one that was
 * asked, at the exact moment the customer is trying to confirm.
 *
 * The reorder-last workflow's template is `{confirmation}` alone: the degenerate
 * case, where reply and park are byte-identical and the divergence is nil.
 */
export const WORKFLOW_CONFIRM_PLACEHOLDER = "{confirmation}"

/**
 * The terminal states a workflow instance can reach. Every one needs a render
 * template (compiler rule `outcome-template-missing`) — the terminal-coverage
 * guarantee, so no path can end in silence or in model-authored prose.
 *
 * `declined` is a first-class outcome, not an error: the customer said no and
 * NOTHING executed.
 */
export const WORKFLOW_OUTCOMES = ["completed", "declined", "failed"] as const

export type WorkflowOutcome = (typeof WORKFLOW_OUTCOMES)[number]

/**
 * Where a trigger phrasing CAME FROM — the review surface, in the provenance
 * discipline LE2-033 established for the conversation projection and LE2-025a
 * carried into the alias gazetteer.
 *
 *   `production-utterance` — READ from a real customer utterance in the
 *     `intent_audit` store, then PII-SCRUBBED (order ids became `12345`, given
 *     names became `Fulano`). Grounded: somebody actually typed this at the
 *     system.
 *
 *   `authored` — a freely authored colloquial. Plausible pt-BR, no external
 *     grounding, and the class that most needs owner review.
 *
 * Deliberately a SEPARATE const from `ALIAS_PROVENANCES`, whose two members it
 * currently mirrors exactly. The two tables answer different questions (what a
 * customer calls a PRODUCT vs. how a customer asks for a ROUTE) and will not
 * stay in step — a workflow phrasing could one day be mirrored from an
 * extraction schema, which an alias surface never can. Sharing the type would
 * make the first divergence a breaking change to the other table for no reason
 * beyond that they happen to agree today.
 *
 * SOURCING BOUNDARY (binding, inherited verbatim from the conversation
 * projection's legend): no phrasing here is drawn from
 * `packages/journeys/extraction-corpus` or the extraction-eval fixtures. That
 * corpus is LE2-008's hard gate, and authoring against it would test-fit the
 * gate and destroy the measurement's independence.
 */
export const WORKFLOW_TRIGGER_PROVENANCES = ["production-utterance", "authored"] as const

/** One trigger phrasing's provenance tag. */
export type WorkflowTriggerProvenance = (typeof WORKFLOW_TRIGGER_PROVENANCES)[number]

/**
 * One way a customer asks for this workflow.
 *
 * # Why the workflow carries these and its anchor capability does not
 *
 * A workflow's anchor is identity-tier — the parser never picks it by name, so
 * it has no `conversationTriggers` and nothing would read them if it did. The
 * language surface of a workflow is the WORKFLOW: what the model is shown is
 * the `start_workflow` enum, and the only text next to each option is the
 * `description`. LE2-008 measured recall@5 = 73.8% on descriptions ALONE for
 * capabilities, which is the same gap in the same shape, and the reorder-last
 * live drive measured it again from the other side: 87.5% selection on a
 * description-only surface, with one authored idiom selecting 0/5.
 *
 * So these are not documentation. They are composed into the selection surface
 * (see the host's `startWorkflowToolDefinition`), which is why the compiler
 * polices them: a phrasing that collides with another workflow's, or with a
 * capability's conversation trigger, makes two different routes look like the
 * same request to whatever reads them.
 */
export interface WorkflowTriggerPhrasing {
  /**
   * What the customer types, in natural pt-BR — accents, spacing and all.
   * STORED natural, COMPARED under the package's shared word-space fold
   * (`normalizeTriggerPhrasing`), exactly as `conversationTriggers` and
   * `AliasEdge.surface` are. The natural form is what gets embedded and shown;
   * folding accents out of storage would degrade the retrieval this exists to
   * improve.
   */
  readonly phrasing: string
  readonly provenance: WorkflowTriggerProvenance
  /** Why this phrasing is worth carrying, in one clause. */
  readonly why: string
}

/**
 * The floor a workflow's `triggerPhrasings` must clear. SIX, the same floor
 * `MIN_CONVERSATION_TRIGGERS` sets for a chat-tier capability and for the same
 * reason: one or two phrasings cannot span imperative, desiderative and
 * interrogative askings, which are three different neighbourhoods of the
 * embedding space. A floor is enforceable where a ceiling is not.
 */
export const MIN_WORKFLOW_TRIGGER_PHRASINGS = 6

/** A pt-BR render template. Placeholders are `{paramName}`; nothing else. */
export interface WorkflowTemplate {
  readonly id: string
  readonly text: string
}

/** One hand-authored workflow. See the module doc for the v0 shape rules. */
export interface WorkflowDefinition {
  /** Stable identity — also the value the parser selects. */
  readonly id: string
  /** pt-BR label (Hard Rule #4), for operator surfaces and the tool surface. */
  readonly title: string
  /** pt-BR one-liner the parser reads when choosing between workflows. */
  readonly description: string
  /**
   * How customers ASK for this workflow — at least
   * {@link MIN_WORKFLOW_TRIGGER_PHRASINGS}, unique under the shared fold both
   * within this workflow and across the whole catalog. Composed into the
   * selection surface; see {@link WorkflowTriggerPhrasing}.
   */
  readonly triggerPhrasings: readonly WorkflowTriggerPhrasing[]
  readonly matchers: readonly WorkflowMatcher[]
  readonly selection: WorkflowSelection
  readonly params: readonly WorkflowParam[]
  /** LINEAR. Executed in array order; v0 has no conditions and no branches. */
  readonly activities: readonly WorkflowActivity[]
  readonly confirm: WorkflowConfirmPoint
  readonly templates: readonly WorkflowTemplate[]
  /** Outcome -> template id. Completeness is compiler-enforced. */
  readonly outcomes: Readonly<Record<WorkflowOutcome, string>>
}
