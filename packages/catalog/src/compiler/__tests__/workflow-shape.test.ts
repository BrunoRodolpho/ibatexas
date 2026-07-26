// Unit tests for the `workflow-shape` pass (LE2-020).
//
// The conformance suite pins each rule's exact diagnostic bytes in a golden;
// this file is the other half — one minimal broken catalog per rule, asserted
// on BEHAVIOUR rather than bytes, plus the two controls that matter most: the
// REAL catalog compiles silent through this pass, and it compiles with a
// non-zero `checked` (a pass reporting `checked: 0` on the real catalog is not
// passing, it is not running).

import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "../../capability-definitions/definitions.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import { WORKFLOW_DEFINITIONS } from "../../workflows/definitions.js"
import { FIXTURE_WORKFLOWS } from "../../workflows/fixtures.js"
import type { WorkflowDefinition } from "../../workflows/types.js"
import { runWorkflowShapePass } from "../passes/workflow-shape.js"

const ANCHOR = "conformance.workflow.anchor"
const STEP = "conformance.workflow.step"

function capabilities(
  overrides: {
    readonly anchor?: Record<string, unknown>
    readonly step?: Record<string, unknown>
  } = {},
): readonly CapabilityDefinition[] {
  return [
    { pack: "ibatexas/pack-orders", mutating: true, tier: "identity", kind: ANCHOR, ...(overrides.anchor ?? {}) },
    { pack: "ibatexas/pack-orders", mutating: true, tier: "identity", kind: STEP, ...(overrides.step ?? {}) },
  ] as unknown as readonly CapabilityDefinition[]
}

function workflow(overrides: Record<string, unknown> = {}): WorkflowDefinition {
  return {
    id: "workflow.unit",
    title: "Fluxo",
    description: "Fixture.",
    matchers: [{ capability: ANCHOR }],
    selection: { capability: ANCHOR },
    params: [
      { name: "orderId", source: { from: "claim", claimType: "order-placed", field: "orderId" } },
    ],
    activities: [{ id: "step", capability: STEP, payload: { orderId: { param: "orderId" } } }],
    confirm: { template: "confirm" },
    templates: [
      { id: "confirm", text: "Confirma?" },
      { id: "completed", text: "Pronto." },
      { id: "declined", text: "Tudo bem." },
      { id: "failed", text: "Não consegui." },
    ],
    outcomes: { completed: "completed", declined: "declined", failed: "failed" },
    ...overrides,
  } as unknown as WorkflowDefinition
}

/** Rule ids emitted by one run, deduped and sorted. */
function rules(
  definitions: readonly CapabilityDefinition[],
  workflows: readonly WorkflowDefinition[],
): readonly string[] {
  const result = runWorkflowShapePass(definitions, undefined, undefined, workflows)
  return [...new Set(result.diagnostics.map((d) => d.rule))].sort()
}

describe("workflow-shape — the controls", () => {
  it("compiles the REAL catalog silent", () => {
    const result = runWorkflowShapePass(
      CAPABILITY_DEFINITIONS,
      undefined,
      undefined,
      WORKFLOW_DEFINITIONS,
    )
    expect(result.diagnostics).toEqual([])
  })

  it("actually LOOKS at the real catalog — `checked` is non-zero with zero workflows", () => {
    const result = runWorkflowShapePass(
      CAPABILITY_DEFINITIONS,
      undefined,
      undefined,
      WORKFLOW_DEFINITIONS,
    )
    // The access-class rule reads every definition, which is what keeps this
    // pass honest on a catalog that declares no workflow yet.
    expect(result.checked).toBeGreaterThanOrEqual(CAPABILITY_DEFINITIONS.length)
  })

  it("compiles the FIXTURE workflow corpus against the real catalog silent", () => {
    // The runtime's proof corpus is authored data too — if it stopped compiling,
    // every end-to-end claim built on it would be resting on an invalid workflow.
    const result = runWorkflowShapePass(
      CAPABILITY_DEFINITIONS,
      undefined,
      undefined,
      FIXTURE_WORKFLOWS,
    )
    expect(result.diagnostics).toEqual([])
  })

  it("compiles a well-formed unit workflow silent", () => {
    expect(rules(capabilities(), [workflow()])).toEqual([])
  })
})

describe("workflow-shape — capability references", () => {
  it("rejects an activity routed at a kind the catalog does not declare", () => {
    const rejected = rules(capabilities(), [
      workflow({ activities: [{ id: "step", capability: "no.such.kind", payload: {} }] }),
    ])
    expect(rejected).toContain("capability-reference-dangling")
  })

  it("rejects a matcher gated on a kind the catalog does not declare", () => {
    const rejected = rules(capabilities(), [
      workflow({ matchers: [{ capability: "no.such.kind" }] }),
    ])
    expect(rejected).toContain("capability-reference-dangling")
  })

  it("names the failing reference on the diagnostic, not just the workflow", () => {
    const result = runWorkflowShapePass(capabilities(), undefined, undefined, [
      workflow({ activities: [{ id: "step", capability: "no.such.kind", payload: {} }] }),
    ])
    const diagnostic = result.diagnostics.find(
      (d) => d.rule === "capability-reference-dangling",
    )
    expect(diagnostic?.reference).toBe("no.such.kind")
    expect(diagnostic?.field).toBe("activities[0].capability")
    expect(diagnostic?.object).toBe("workflow:workflow.unit")
  })

  it("rejects a SELECTION anchored on a workflow-scoped kind", () => {
    expect(rules(capabilities({ anchor: { workflowScoped: true } }), [workflow()])).toEqual([
      "workflow-scoped-reference-unreachable",
    ])
  })

  it("ALLOWS an activity routed at a workflow-scoped kind — that is the point", () => {
    // The access class forbids PARSE reachability, never workflow reachability.
    // If this ever starts failing, workflow-scoped kinds are invocable by nothing.
    expect(rules(capabilities({ step: { workflowScoped: true } }), [workflow()])).toEqual([])
  })
})

describe("workflow-shape — params, sequence and identity", () => {
  it("rejects an activity binding a param the workflow never declared", () => {
    expect(
      rules(capabilities(), [
        workflow({
          activities: [{ id: "step", capability: STEP, payload: { total: { param: "total" } } }],
        }),
      ]),
    ).toEqual(["activity-param-undeclared"])
  })

  it("ALLOWS an author-written constant binding — it has a first-party source", () => {
    expect(
      rules(capabilities(), [
        workflow({
          activities: [
            { id: "step", capability: STEP, payload: { channel: { const: "web" } } },
          ],
        }),
      ]),
    ).toEqual([])
  })

  it("rejects a workflow that confirms and then does nothing", () => {
    expect(rules(capabilities(), [workflow({ activities: [] })])).toEqual([
      "activity-sequence-empty",
    ])
  })

  it("rejects two activities sharing an id", () => {
    expect(
      rules(capabilities(), [
        workflow({
          activities: [
            { id: "step", capability: STEP, payload: {} },
            { id: "step", capability: STEP, payload: {} },
          ],
        }),
      ]),
    ).toEqual(["activity-id-duplicated"])
  })

  it("rejects two workflows sharing an id", () => {
    expect(rules(capabilities(), [workflow(), workflow()])).toEqual([
      "workflow-id-duplicated",
    ])
  })
})

describe("workflow-shape — terminal coverage", () => {
  it("rejects a confirm point naming a template that does not exist", () => {
    expect(rules(capabilities(), [workflow({ confirm: { template: "absent" } })])).toEqual([
      "confirm-template-missing",
    ])
  })

  it.each(["completed", "declined", "failed"] as const)(
    "rejects a missing template for the %s outcome",
    (outcome) => {
      const outcomes: Record<string, string> = {
        completed: "completed",
        declined: "declined",
        failed: "failed",
      }
      outcomes[outcome] = "absent"
      expect(rules(capabilities(), [workflow({ outcomes })])).toEqual([
        "outcome-template-missing",
      ])
    },
  )
})

describe("workflow-shape — the access class's structural half", () => {
  it("rejects a capability that is both workflow-scoped and planner-advertised", () => {
    const definitions = capabilities({
      step: { workflowScoped: true, plannerAdvertisedBy: ["ibatexas/pack-orders"] },
    })
    expect(rules(definitions, [])).toEqual(["workflow-scoped-kind-advertised"])
  })

  it("allows a workflow-scoped capability that no planner advertises", () => {
    expect(rules(capabilities({ step: { workflowScoped: true } }), [])).toEqual([])
  })

  it("allows a planner-advertised capability that is not workflow-scoped", () => {
    expect(
      rules(capabilities({ step: { plannerAdvertisedBy: ["ibatexas/pack-orders"] } }), []),
    ).toEqual([])
  })

  it("fires with ZERO workflows authored — the rule reads capabilities, not the corpus", () => {
    const definitions = capabilities({
      anchor: { workflowScoped: true, plannerAdvertisedBy: ["ibatexas/pack-orders"] },
    })
    const result = runWorkflowShapePass(definitions, undefined, undefined, [])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.object).toBe(`capability:${ANCHOR}`)
  })
})
