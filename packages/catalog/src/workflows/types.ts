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
 * # THE SHAPE, v0 THEN v1
 *
 * v0 (LE2-020) was LINEAR ONLY: a closed set of matchers, one selection
 * capability, params each sourced from a VALIDATED CLAIM or a CUSTOMER-AUTHORED
 * SLOT, an ordered activity list, ONE confirm point, and a render template for
 * every outcome.
 *
 * v1 (LE2-022) adds the three things a linear list cannot say, all of them as
 * DECLARED DATA and none of them as a runtime authority:
 *
 *   - {@link WorkflowPrecheck} — feasibility, asked BEFORE any confirm is shown.
 *   - {@link WorkflowRouteStep} — conditional edges over the activity pool.
 *   - {@link WorkflowCompensation} — what undoes a step, or the authored
 *     statement that nothing does.
 *
 * All three are additive: a definition that declares none of them is a v0
 * definition and behaves exactly as it did. The ONE confirm point is unchanged
 * and still singular — v1 adds branches to what runs, never a second moment at
 * which a customer is asked.
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
 * HOW A COMPENSATOR IS DECLARED — LE2-022.
 *
 * A closed two-member union, and the shape is the guarantee: "this mutating
 * activity has no compensator" is not expressible as an OMISSION. It can only
 * be said out loud, with a reason, as `{terminal: true, why}` — and the
 * compiler rejects a mutating activity that says neither
 * (`mutating-activity-uncompensated`).
 *
 * That asymmetry is the whole point. An author who forgets to think about
 * rollback and an author who decided rollback is impossible produce IDENTICAL
 * data under an optional field, and the first case is how a customer ends up
 * with half a workflow and no account of it. Under this union they produce
 * different data, and only one of them compiles.
 *
 * `{by}` — the id of ANOTHER activity in the same workflow that UNDOES this
 * one. A compensator is an activity in every sense: same envelope, same kernel
 * adjudication, same guards, same audit row. There is no privileged "rollback"
 * path that skips policy, because a rollback is itself a governed mutation
 * (refunding, cancelling and deleting are exactly the acts a policy most wants
 * to see).
 *
 * `{terminal, why}` — this mutation is not undone, and the marker says WHICH of
 * the two very different reasons applies. `why` is required and is authored
 * prose for a REVIEWER, not for a customer — it is the sentence that makes the
 * decision auditable in a diff.
 */
export type WorkflowCompensation =
  | {
      /** The activity id that UNDOES this one. Must itself be terminal. */
      readonly by: string
    }
  | {
      readonly terminal: WorkflowTerminalMarker
      /** Why this mutation is not compensated. Reviewer-facing, in one clause. */
      readonly why: string
    }

/**
 * The two reasons a mutation carries no compensator — LE2-022.
 *
 * Two markers rather than one boolean, because they answer the SAME question
 * with opposite consequences for the customer, and the question is: *if this
 * activity ran and a later step then failed, is the customer left holding
 * something they did not agree to keep?*
 *
 *   `"irreversible"` — YES, and nothing can put it back. A captured payment, a
 *     dispatched WhatsApp message, a cart rebuilt out from under them. A run
 *     that gets this far and then fails reaches the `stranded` outcome, and the
 *     customer is told so.
 *   `"harmless"` — NO. The effect is idempotent or invisible: ensuring a cart
 *     exists, re-reading state, writing something the customer would never
 *     notice. A run that fails after only these reaches `failed`, which is
 *     honest, because nothing the customer would care about happened.
 *
 * A single boolean would collapse both into the alarming reading and make every
 * half-run render "something could not be undone" — including for a cart-ensure,
 * which is a sentence that frightens a customer about nothing and teaches them
 * to ignore the one that matters. The marker is authored data next to a required
 * `why`, so choosing the softer one is a visible claim in a diff, not a default.
 */
export const WORKFLOW_TERMINAL_MARKERS = ["irreversible", "harmless"] as const

export type WorkflowTerminalMarker = (typeof WORKFLOW_TERMINAL_MARKERS)[number]

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
  /**
   * LE2-022 — how this activity is undone if a LATER step fails, or the
   * authored statement that it is not undone at all. REQUIRED (by the compiler,
   * not by the type) for every activity whose capability the catalog declares
   * `mutating: true` — see {@link WorkflowCompensation}.
   *
   * Optional in the TYPE because a non-mutating activity legitimately has
   * nothing to compensate, and because the rule is a property of the capability
   * being routed to, which lives in a different table this type cannot see.
   */
  readonly compensation?: WorkflowCompensation
}

/**
 * THE OPERATORS A DECLARED PREDICATE MAY USE — LE2-022. Closed, and small on
 * purpose.
 *
 * Every member is TOTAL over a possibly-absent fact: an absent fact makes
 * `present` false, `absent` true, and every other operator false. There is no
 * operator whose answer on missing data is "it depends", because a workflow
 * predicate decides whether a governed mutation runs and "we could not tell" has
 * exactly one safe reading.
 *
 * There is deliberately no `not`, no `and`/`or`, and no expression tree. A
 * predicate is one fact, one operator, one authored literal — legible in a diff,
 * evaluable without an interpreter, and impossible to grow into a rule engine by
 * accident. Two conditions worth combining are two branches worth declaring.
 */
export const WORKFLOW_PREDICATE_OPERATORS = [
  "present",
  "absent",
  "isTrue",
  "isFalse",
  "equals",
  "atLeast",
  "below",
] as const

export type WorkflowPredicateOperator = (typeof WORKFLOW_PREDICATE_OPERATORS)[number]

/**
 * The operators that take an authored `value`. The complement takes none, and
 * the compiler enforces both directions (`predicate-malformed`): an `equals`
 * with no value is permanently false, and a `present` with one reads as though
 * it compares something it does not.
 */
export const WORKFLOW_PREDICATE_OPERATORS_WITH_VALUE: readonly WorkflowPredicateOperator[] =
  ["equals", "atLeast", "below"]

/**
 * ONE DECLARED PREDICATE over a GROUNDED FACT — the v1 condition primitive
 * (LE2-022), used by both feasibility pre-checks and conditional edges.
 *
 * ── WHAT `fact` MAY NAME, AND WHY THAT IS THE WHOLE SAFETY STORY ─────────────
 *
 * A member of {@link WORKFLOW_FACTS} and nothing else — a CLOSED vocabulary of
 * named projections the host reads out of the same resolver-assembled state the
 * kernel's own guards are adjudicated against. The compiler rejects any other
 * spelling (`predicate-fact-unknown`), which makes the safety property
 * structural rather than documentary: there is no fact name that means "ask the
 * model", and no authored predicate can reach model output, because the only
 * names that compile are names the resolver grounds.
 *
 * This is the same discipline {@link WorkflowParamSource} applies to VALUES,
 * applied to TRUTH. A param may come from a validated claim or a customer slot
 * and from nothing else; a predicate may read a grounded projection and nothing
 * else. In both halves the forbidden source is not policed, it is unspellable.
 *
 * ── AND WHY THE FACTS ARE FRESH, NOT PINNED ──────────────────────────────────
 *
 * An instance pins its SHAPE, never its state (LE2 Implementation Decision 17).
 * A predicate is therefore evaluated against the projection in force AT THE
 * MOMENT it is asked — at selection for a pre-check, at the branch for a
 * conditional edge — so a workflow parked overnight branches on the world as it
 * is when it resumes, not as it was when the customer asked.
 */
export interface WorkflowPredicate {
  /** A member of {@link WORKFLOW_FACTS}. Compiler-checked. */
  readonly fact: string
  readonly op: WorkflowPredicateOperator
  /** The authored comparand, for the operators that take one. */
  readonly value?: string | number | boolean
}

/**
 * A FEASIBILITY PRE-CHECK — LE2-022, AC 1.
 *
 * A precondition that must HOLD for the workflow to be worth starting at all,
 * evaluated at SELECTION — before the anchor envelope is minted, therefore
 * before the kernel can park a confirm, therefore before the customer is ever
 * shown a question. When one fails the turn renders {@link template} and stops:
 * no confirm, no envelope, no audit row, nothing to say yes to.
 *
 * ── WHY THE ORDER MATTERS MORE THAN THE CHECK ────────────────────────────────
 *
 * The anchor's own guards would refuse an infeasible workflow too, and later.
 * "Later" is the entire problem: the anchor tool wrapper runs the anchor act and
 * THEN the sequence, and a CONFIRM parks first — so without a pre-check the
 * customer is asked to approve a multi-step run that was already impossible,
 * says yes, and gets a refusal for their trouble. A pre-check moves the honest
 * sentence to before the question instead of after the answer.
 *
 * ── WHY EACH ONE CARRIES ITS OWN TEMPLATE ────────────────────────────────────
 *
 * Because the REASON is the deliverable. A single generic "não consigo fazer
 * isso agora" would be the same sentence for "you have no previous order" and
 * "your cart is empty", and a customer cannot act on either. One template per
 * pre-check makes the honest reason authored pt-BR that a reviewer can read next
 * to the predicate that produces it.
 */
export interface WorkflowPrecheck {
  /** Stable id — the trace's join key for "which pre-check refused". */
  readonly id: string
  /** Must HOLD for the workflow to be feasible. */
  readonly predicate: WorkflowPredicate
  /** Template id rendering the honest reason. Compiler-checked to exist. */
  readonly template: string
}

/**
 * ONE STEP OF A WORKFLOW'S ROUTE — LE2-022's conditional-edge shape.
 *
 * Either an activity runs, or a declared predicate chooses between two arms.
 * Both arms are REQUIRED (they may be empty arrays, which is how "do nothing on
 * the false side" is said out loud): an optional `otherwise` would let a
 * two-outcome decision look like a one-outcome one in a diff, and the arm nobody
 * wrote is the arm nobody tested.
 *
 * The arms name activity ids from the workflow's own `activities` pool rather
 * than nesting activity objects. Ids keep the pool flat and keep the trace's
 * join key (`activityId`) meaningful at any depth, and they make the two graph
 * faults NAMEABLE: an arm naming an activity that does not exist
 * (`route-target-dangling`) and an activity no arm can reach
 * (`activity-unreachable`). A nested shape can express neither, which is why
 * this one is a graph over a pool and not a tree.
 */
export type WorkflowRouteStep =
  | {
      /** Run this activity unconditionally. */
      readonly activity: string
    }
  | {
      readonly when: WorkflowPredicate
      /** Activity ids to run, in order, when the predicate HOLDS. */
      readonly then: readonly string[]
      /** Activity ids to run, in order, when it does not. */
      readonly otherwise: readonly string[]
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
 * The terminal states EVERY workflow can reach, whatever its shape. Each needs a
 * render template (compiler rule `outcome-template-missing`) — the
 * terminal-coverage guarantee, so no path can end in silence or in
 * model-authored prose.
 */
export const WORKFLOW_BASE_OUTCOMES = ["completed", "declined", "failed"] as const

/**
 * The two outcomes only a MULTI-STEP run can reach — LE2-022.
 *
 * They are separated from the base three because they are the two honest
 * answers to "some of it ran and then it stopped", and telling them apart is the
 * point:
 *
 *   `compensated` — a step failed, every mutation that had already happened was
 *     UNDONE by its declared compensator, and every compensator reached EXECUTE.
 *     The customer is back where they started and can be told so.
 *   `stranded` — a step failed and something that ran could NOT be undone:
 *     either it was declared terminal, or its compensator did not reach EXECUTE.
 *     The customer is NOT back where they started, and the reply must not
 *     pretend otherwise.
 *
 * Collapsing the two into `failed` is the failure this ticket exists to prevent.
 * `failed` means NOTHING ran; using it for a half-run would tell a customer
 * nothing happened while a real mutation sits in the store — which is the same
 * false-negative shape as a false success, pointed the other way.
 *
 * Required (compiler rule `compensation-outcome-template-missing`) exactly when
 * a workflow routes MORE THAN ONE non-compensator activity, because that is
 * precisely when a run can half-happen. A single-activity workflow can only
 * complete, decline or fail, so authoring these would be writing sentences no
 * customer can ever read — which reviewers rubber-stamp.
 */
export const WORKFLOW_COMPENSATION_OUTCOMES = ["compensated", "stranded"] as const

/**
 * Every terminal state a workflow instance can REACH and must have text for.
 *
 * `declined` is a first-class outcome, not an error: the customer said no and
 * NOTHING executed.
 */
export const WORKFLOW_OUTCOMES = [
  ...WORKFLOW_BASE_OUTCOMES,
  ...WORKFLOW_COMPENSATION_OUTCOMES,
] as const

export type WorkflowOutcome = (typeof WORKFLOW_OUTCOMES)[number]

/** The three outcomes every workflow must author, whatever its shape. */
export type WorkflowBaseOutcome = (typeof WORKFLOW_BASE_OUTCOMES)[number]

/** The two a multi-step workflow must author as well. */
export type WorkflowCompensationOutcome =
  (typeof WORKFLOW_COMPENSATION_OUTCOMES)[number]

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
  /**
   * LE2-022 — FEASIBILITY PRE-CHECKS, evaluated in array order at SELECTION.
   * The FIRST one that does not hold refuses the workflow before any confirm is
   * shown; absent or empty means "always feasible to ask about", which is the
   * v0 behaviour exactly.
   */
  readonly prechecks?: readonly WorkflowPrecheck[]
  /**
   * The ACTIVITY POOL — every step this workflow can run, including the
   * compensators, which are activities like any other and are named from a
   * {@link WorkflowCompensation} rather than from the route.
   *
   * Not the execution order once {@link WorkflowDefinition.route} is declared.
   * Order still matters when it is not: see `route`.
   */
  readonly activities: readonly WorkflowActivity[]
  /**
   * LE2-022 — the ROUTE: which activities run, in which order, and under which
   * declared conditions.
   *
   * ABSENT ⟹ the v0 semantics, unchanged and byte-identical: every
   * non-compensator activity, in declaration order, unconditionally. That is the
   * default rather than a migration step — a linear workflow should not have to
   * spell a route to say it is linear, and every v0 definition stays legal
   * exactly as authored.
   */
  readonly route?: readonly WorkflowRouteStep[]
  readonly confirm: WorkflowConfirmPoint
  readonly templates: readonly WorkflowTemplate[]
  /**
   * Outcome -> template id. Completeness is compiler-enforced: the three base
   * outcomes always (`outcome-template-missing`), and the two compensation
   * outcomes for any workflow that routes more than one non-compensator activity
   * (`compensation-outcome-template-missing`).
   *
   * The compensation half is typed OPTIONAL and enforced by the compiler rather
   * than required by the type, because whether those outcomes are reachable is a
   * property of the route — which this record cannot see.
   */
  readonly outcomes: Readonly<Record<WorkflowBaseOutcome, string>> &
    Readonly<Partial<Record<WorkflowCompensationOutcome, string>>>
}
