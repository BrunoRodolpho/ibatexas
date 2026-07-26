/**
 * The AUTHORED workflow corpus — LE2-020.
 *
 * # Why this array is empty
 *
 * Ticket 20 builds the workflow RUNTIME, and its own words are *"the reusable
 * journey runtime — deliberately separated from any customer-facing journey"*.
 * The seed workflows the spec names (swap-for-coupon, reorder-last, paid-cancel
 * — Implementation Decision 18) are later tickets, and authoring one here to
 * make this file look populated would ship an un-reviewed customer-facing
 * conversational route under a runtime ticket.
 *
 * So v0 ships the machinery with ZERO production workflows, and the runtime is
 * proven end-to-end against {@link FIXTURE_WORKFLOWS} instead — a corpus that is
 * openly a fixture, exactly as the conformance suite's fabricated capabilities
 * are (`packages/catalog/src/conformance/fixtures/`).
 *
 * # What an empty corpus means at run time (all three are load-bearing)
 *
 *   1. `advertiseWorkflows([])` returns an empty surface, so `buildToolSurface`
 *      adds no `start_workflow` tool and the wire is byte-identical to pre-020.
 *   2. `installWorkflowRuntime` wraps nothing, so no tool's behaviour changes.
 *   3. The `workflow-shape` compiler pass still has real work: its access-class
 *      rule reads every capability definition, so `checked` is non-zero on the
 *      real catalog even with no workflow authored (the pass contract in
 *      `../compiler/diagnostics.ts` — *"a pass reporting `checked: 0` on the
 *      real catalog is not passing, it is not running"*).
 *
 * Landing the first real workflow is therefore a one-line change here plus its
 * own review, which is the whole point of keeping the corpus data.
 */

import type { WorkflowDefinition } from "./types.js"

/**
 * Every workflow the production catalog declares. See the module doc for why
 * this is empty in v0 and what that means at run time.
 */
export const WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] = []
