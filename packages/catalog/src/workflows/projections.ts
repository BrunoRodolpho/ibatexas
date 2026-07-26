/**
 * Pure projections over the workflow corpus and the capability definitions it
 * references — LE2-020.
 *
 * Same contract as every other `generate*` in this package: inert functions over
 * authored data, no clock, no IO, no decision. The runtime consumes these; it
 * never re-derives the same facts for itself.
 */

import type { CapabilityDefinition } from "../capability-definitions/types.js"
import type { WorkflowDefinition, WorkflowOutcome } from "./types.js"

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
 * The template text for an OUTCOME. Compiler-guaranteed present for an authored
 * workflow (`outcome-template-missing`), so `undefined` here means the caller
 * built a definition the compiler never saw.
 */
export function workflowOutcomeText(
  workflow: WorkflowDefinition,
  outcome: WorkflowOutcome,
): string | undefined {
  return workflowTemplateText(workflow, workflow.outcomes[outcome])
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
