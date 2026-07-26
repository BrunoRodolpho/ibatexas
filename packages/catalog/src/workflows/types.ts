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
 * The terminal states a workflow instance can reach. Every one needs a render
 * template (compiler rule `outcome-template-missing`) — the terminal-coverage
 * guarantee, so no path can end in silence or in model-authored prose.
 *
 * `declined` is a first-class outcome, not an error: the customer said no and
 * NOTHING executed.
 */
export const WORKFLOW_OUTCOMES = ["completed", "declined", "failed"] as const

export type WorkflowOutcome = (typeof WORKFLOW_OUTCOMES)[number]

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
