/**
 * Pure projections over the workflow corpus and the capability definitions it
 * references — LE2-020.
 *
 * Same contract as every other `generate*` in this package: inert functions over
 * authored data, no clock, no IO, no decision. The runtime consumes these; it
 * never re-derives the same facts for itself.
 */

import type { CapabilityDefinition } from "../capability-definitions/types.js"
import type {
  WorkflowActivity,
  WorkflowDefinition,
  WorkflowOutcome,
  WorkflowRouteStep,
} from "./types.js"

/**
 * The WORKFLOW-SCOPED ACCESS CLASS, projected from the catalog (LE2
 * Implementation Decision 15).
 *
 * A kind in this set is NOT parser-emittable: it must never appear in the
 * advertised tool surface and must never be accepted from a parse. Only an
 * instantiated workflow's executor may invoke it.
 *
 * This is the catalog's half — the DECLARATION. The enforcement half is a
 * subtraction at the planner's single choke point (see
 * `apps/api/src/claustrum/ibatexas-planner.ts`), and the structural half is the
 * compiler's `workflow-scoped-kind-advertised` rule, which makes "declared
 * workflow-scoped AND planner-advertised" a build error rather than a
 * contradiction two subsystems disagree about at run time.
 */
export function workflowScopedKinds(
  definitions: readonly CapabilityDefinition[],
): ReadonlySet<string> {
  const scoped = new Set<string>()
  for (const definition of definitions) {
    const record = definition as unknown as Readonly<Record<string, unknown>>
    if (record["workflowScoped"] === true && typeof record["kind"] === "string") {
      scoped.add(record["kind"])
    }
  }
  return scoped
}

/**
 * Every capability kind a workflow's ACTIVITIES invoke, across the corpus.
 *
 * The runtime uses this to decide which workflow-scoped handlers to install: a
 * workflow-scoped tool exists exactly when a loaded workflow invokes it, so an
 * empty corpus installs nothing and a kind no workflow references is reachable
 * by nothing at all.
 */
export function workflowActivityKinds(
  workflows: readonly WorkflowDefinition[],
): ReadonlySet<string> {
  const kinds = new Set<string>()
  for (const workflow of workflows) {
    for (const activity of workflow.activities) kinds.add(activity.capability)
  }
  return kinds
}

/** Every capability kind that ANCHORS a workflow (its selection capability). */
export function workflowSelectionKinds(
  workflows: readonly WorkflowDefinition[],
): ReadonlySet<string> {
  return new Set(workflows.map((workflow) => workflow.selection.capability))
}

/**
 * ONE WORKFLOW'S ANCHOR, as the host's tool factory needs to see it.
 *
 * The same anchors {@link workflowSelectionKinds} projects, carrying the two
 * things a bare kind cannot: the AUTHORED description the minted handler wears
 * (`selection.anchorDescription`), and the WORKFLOW ID that declared it — which
 * exists so a workflow that forgot the description can be NAMED in the failure
 * rather than described as "some anchor".
 */
export interface WorkflowSelectionAnchor {
  /** The workflow whose `selection` declared this anchor. */
  readonly workflowId: string
  /** The capability the SELECTION envelope carries. */
  readonly capability: string
  /** The authored pt-BR handler description, when the workflow declares one. */
  readonly description?: string
}

/**
 * Every workflow's ANCHOR, in corpus declaration order, DEDUPED BY CAPABILITY.
 *
 * The richer sibling of {@link workflowSelectionKinds}, and deduped for the same
 * reason that one returns a Set: these records drive REGISTRATION, and two
 * workflows anchored on one kind need that kind's handler registered ONCE. A list
 * with both would register twice and, under the registry's last-write-wins, make
 * the second registration silently authoritative over the first.
 *
 * FIRST DECLARATION WINS, matching the iteration order of the Set the kinds
 * projection returns. A second workflow on the same anchor contributes nothing —
 * including nothing to the description — because the handler it would describe
 * has already been described by the workflow that got there first.
 */
export function workflowSelectionAnchors(
  workflows: readonly WorkflowDefinition[],
): readonly WorkflowSelectionAnchor[] {
  const anchors: WorkflowSelectionAnchor[] = []
  const seen = new Set<string>()
  for (const workflow of workflows) {
    const capability = workflow.selection.capability
    if (seen.has(capability)) continue
    seen.add(capability)
    const description = workflow.selection.anchorDescription
    anchors.push({
      workflowId: workflow.id,
      capability,
      ...(description === undefined ? {} : { description }),
    })
  }
  return anchors
}

/** Look a workflow up by id. `undefined` for an id the corpus does not declare. */
export function findWorkflow(
  workflows: readonly WorkflowDefinition[],
  id: string,
): WorkflowDefinition | undefined {
  return workflows.find((workflow) => workflow.id === id)
}

/** The template text for an id, or `undefined` when the workflow declares none. */
export function workflowTemplateText(
  workflow: WorkflowDefinition,
  templateId: string,
): string | undefined {
  return workflow.templates.find((template) => template.id === templateId)?.text
}

/**
 * The template text for an OUTCOME.
 *
 * Compiler-guaranteed present for an authored workflow — the three base outcomes
 * by `outcome-template-missing`, the two compensation outcomes by
 * `compensation-outcome-template-missing` for any workflow that can reach them.
 * `undefined` therefore means either a definition the compiler never saw, or a
 * compensation outcome on a single-activity workflow that cannot reach it; both
 * are handled by the runtime's honest fallback sentence rather than by silence.
 */
export function workflowOutcomeText(
  workflow: WorkflowDefinition,
  outcome: WorkflowOutcome,
): string | undefined {
  const templateId = workflow.outcomes[outcome]
  return templateId === undefined
    ? undefined
    : workflowTemplateText(workflow, templateId)
}

/**
 * The customer-authored SLOT names a workflow declares — the CLOSED surface the
 * selection tool call may carry. Anything outside it is dropped at the parse
 * seam, exactly as `stripUnauthoredPayloadFields` bounds a capability payload.
 */
export function workflowSlotNames(workflow: WorkflowDefinition): ReadonlySet<string> {
  const slots = new Set<string>()
  for (const param of workflow.params) {
    if (param.source.from === "slot") slots.add(param.source.slot)
  }
  return slots
}

/**
 * A workflow's trigger phrasings as plain natural pt-BR strings, in authored
 * order — the shape the SELECTION SURFACE consumes (LE2-021).
 *
 * Natural, never folded: the fold exists to compare and validate, and the text
 * the model is shown has to be the text a customer would actually type. Authored
 * order is preserved rather than sorted, because the array is authored
 * strongest-evidence-first (the production-grounded phrasings lead) and the
 * surface truncates from the end.
 */
export function workflowTriggerPhrasings(
  workflow: WorkflowDefinition,
): readonly string[] {
  return workflow.triggerPhrasings.map((trigger) => trigger.phrasing)
}

// ── LE2-022 · the v1 shape's projections ─────────────────────────────────────

/**
 * The activity ids some OTHER activity names as its compensator.
 *
 * The definition of "compensator" in this codebase, computed rather than
 * declared: an activity is a compensator exactly when something points at it.
 * There is no `isCompensator: true` slot, deliberately — a boolean an author
 * sets and a reference an author writes are two facts that can disagree, and the
 * disagreement would decide whether the step runs forward.
 */
export function workflowCompensatorIds(
  workflow: WorkflowDefinition,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const activity of workflow.activities) {
    const compensation = activity.compensation
    if (compensation !== undefined && "by" in compensation) ids.add(compensation.by)
  }
  return ids
}

/** One activity of a workflow by id, or `undefined`. */
export function findWorkflowActivity(
  workflow: WorkflowDefinition,
  id: string,
): WorkflowActivity | undefined {
  return workflow.activities.find((activity) => activity.id === id)
}

/**
 * The ROUTE a workflow actually runs — declared, or the implicit v0 one.
 *
 * IMPLICIT means "every non-compensator activity, in declaration order,
 * unconditionally", which is byte-for-byte what LE2-020 executed. Compensators
 * are excluded because they are reached only by a failure, never by the forward
 * path; including them would run every rollback as a step (and, in the linear
 * corpus that has no route, would do so with nothing to roll back).
 *
 * Returning a synthesised route rather than a special case is what keeps the
 * runtime free of an `if (route === undefined)` branch, so the v0 and v1 paths
 * are the SAME code executing different data rather than two executors that can
 * drift.
 */
export function workflowRoute(
  workflow: WorkflowDefinition,
): readonly WorkflowRouteStep[] {
  if (workflow.route !== undefined) return workflow.route
  const compensators = workflowCompensatorIds(workflow)
  return workflow.activities
    .filter((activity) => !compensators.has(activity.id))
    .map((activity) => ({ activity: activity.id }))
}

/** Every activity id a route step can reach, in declaration order, with
 *  duplicates preserved — the compiler needs the positions, not a set. */
export function routeStepTargets(step: WorkflowRouteStep): readonly string[] {
  return "activity" in step ? [step.activity] : [...step.then, ...step.otherwise]
}

/**
 * Every activity id the route can reach on SOME path.
 *
 * A union across both arms of every branch, not a single execution: an activity
 * only the `otherwise` arm reaches is reachable, and calling it dead would make
 * `activity-unreachable` fire on correct data.
 */
export function workflowRoutedActivityIds(
  workflow: WorkflowDefinition,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const step of workflowRoute(workflow)) {
    for (const id of routeStepTargets(step)) ids.add(id)
  }
  return ids
}

/**
 * How many DISTINCT non-compensator activities the route can reach — the input
 * to "can this workflow half-happen?".
 *
 * Counted across both arms rather than along the longest path: two mutually
 * exclusive single-activity arms cannot strand each other, but a route with two
 * reachable activities is one edit away from a shape that can, and the two
 * compensation outcome templates are cheap next to a customer being told
 * nothing happened while something did.
 */
export function workflowRoutedActivityCount(workflow: WorkflowDefinition): number {
  const compensators = workflowCompensatorIds(workflow)
  return [...workflowRoutedActivityIds(workflow)].filter(
    (id) => !compensators.has(id),
  ).length
}
