// Unit tests for the `workflow-runtime-shape` pass (LE2-022).
//
// Same split as `workflow-shape.test.ts`: the conformance suite pins each rule's
// exact diagnostic BYTES in a golden, and this file asserts BEHAVIOUR — one
// minimal broken catalog per rule, plus the controls that keep the whole thing
// from passing vacuously.
//
// The controls matter more here than usual. Most of this pass's rules fire on an
// ABSENCE (no compensation, no template, an activity nothing reaches), and an
// absence-shaped rule with a weak control is exactly the shape that reports
// green over a pass that is not running.

import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "../../capability-definitions/definitions.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import { WORKFLOW_DEFINITIONS } from "../../workflows/definitions.js"
import { FIXTURE_WORKFLOWS } from "../../workflows/fixtures.js"
import type { WorkflowDefinition } from "../../workflows/types.js"
import { runWorkflowRuntimeShapePass } from "../passes/workflow-runtime-shape.js"

const ANCHOR = "conformance.workflow.anchor"
const STEP = "conformance.workflow.step"
/** A capability the table declares NON-mutating — the control for rule 1. */
const READ = "conformance.workflow.read"

function capabilities(): readonly CapabilityDefinition[] {
  return [
    { pack: "ibatexas/pack-orders", mutating: true, tier: "identity", kind: ANCHOR },
    { pack: "ibatexas/pack-orders", mutating: true, tier: "identity", kind: STEP },
    { pack: "ibatexas/pack-orders", mutating: false, tier: "identity", kind: READ },
  ] as unknown as readonly CapabilityDefinition[]
}

/**
 * A well-formed v1 workflow: `step` is compensated by `undo`, `undo` is terminal
 * so the regress ends, and `second` is reached only by the branch's `then` arm.
 * The route reaches two non-compensator activities, so both compensation
 * outcomes are required — and declared.
 */
function workflow(overrides: Record<string, unknown> = {}): WorkflowDefinition {
  return {
    id: "workflow.unit.runtime",
    title: "Fluxo",
    description: "Fixture.",
    matchers: [{ capability: ANCHOR }],
    selection: { capability: ANCHOR },
    params: [],
    prechecks: [
      {
        id: "authenticated",
        predicate: { fact: "customerIsAuthenticated", op: "isTrue" },
        template: "infeasible",
      },
    ],
    activities: [
      { id: "step", capability: STEP, payload: {}, compensation: { by: "undo" } },
      {
        id: "undo",
        capability: STEP,
        payload: {},
        compensation: { terminal: "harmless", why: "the rollback itself" },
      },
      {
        id: "second",
        capability: STEP,
        payload: {},
        compensation: { terminal: "irreversible", why: "unit fixture" },
      },
    ],
    route: [
      { activity: "step" },
      { when: { fact: "cartHasItems", op: "isTrue" }, then: ["second"], otherwise: [] },
    ],
    confirm: { template: "confirm" },
    templates: [
      { id: "confirm", text: "Confirma?" },
      { id: "completed", text: "Pronto." },
      { id: "declined", text: "Tudo bem." },
      { id: "failed", text: "Não consegui." },
      { id: "compensated", text: "Desfiz." },
      { id: "stranded", text: "Não desfiz tudo." },
      { id: "infeasible", text: "Não dá." },
    ],
    outcomes: {
      completed: "completed",
      declined: "declined",
      failed: "failed",
      compensated: "compensated",
      stranded: "stranded",
    },
    ...overrides,
  } as unknown as WorkflowDefinition
}

/** The base's activities, so a test can replace exactly one. */
function activities(): readonly Record<string, unknown>[] {
  return (workflow() as unknown as Record<string, unknown>)[
    "activities"
  ] as readonly Record<string, unknown>[]
}

/** Rule ids emitted by one run, deduped and sorted. */
function rules(workflows: readonly WorkflowDefinition[]): readonly string[] {
  const result = runWorkflowRuntimeShapePass(
    capabilities(),
    undefined,
    undefined,
    workflows,
  )
  return [...new Set(result.diagnostics.map((d) => d.rule))].sort()
}

describe("workflow-runtime-shape — the controls", () => {
  it("compiles the REAL catalog silent", () => {
    const result = runWorkflowRuntimeShapePass(
      CAPABILITY_DEFINITIONS,
      undefined,
      undefined,
      WORKFLOW_DEFINITIONS,
    )
    expect(result.diagnostics).toEqual([])
  })

  it("compiles the FIXTURE corpus against the real catalog silent", () => {
    // The runtime's v1 proof corpus is authored data too, and it is the corpus
    // every LE2-022 end-to-end claim is built on — an invalid fixture workflow
    // would make all of them rest on a definition the compiler rejects.
    const result = runWorkflowRuntimeShapePass(
      CAPABILITY_DEFINITIONS,
      undefined,
      undefined,
      FIXTURE_WORKFLOWS,
    )
    expect(result.diagnostics).toEqual([])
  })

  it("ACTUALLY LOOKS at the real corpus — `checked` scales with the workflows given", () => {
    // The vacuity control. Every rule here is a statement about a workflow, so
    // unlike `workflow-shape` this pass has nothing to inspect on a catalog with
    // no workflow — which means `checked: 0` is honest there and would be
    // meaningless as a floor. What IS meaningful: compiling MORE workflows
    // inspects strictly more, so a pass that had quietly stopped reading the
    // corpus could not produce this inequality.
    const none = runWorkflowRuntimeShapePass(CAPABILITY_DEFINITIONS, undefined, undefined, [])
    const real = runWorkflowRuntimeShapePass(
      CAPABILITY_DEFINITIONS,
      undefined,
      undefined,
      WORKFLOW_DEFINITIONS,
    )
    const both = runWorkflowRuntimeShapePass(CAPABILITY_DEFINITIONS, undefined, undefined, [
      ...WORKFLOW_DEFINITIONS,
      ...FIXTURE_WORKFLOWS,
    ])
    expect(none.checked).toBe(0)
    expect(real.checked).toBeGreaterThan(0)
    expect(both.checked).toBeGreaterThan(real.checked)
  })

  it("compiles a well-formed unit workflow silent", () => {
    expect(rules([workflow()])).toEqual([])
  })

  it("is silent on a v0 workflow that declares no route, no pre-check and no branch", () => {
    // BACKWARD COMPATIBILITY, asserted rather than assumed: a linear definition
    // with a terminal marker on its one mutating step is exactly a v0 workflow,
    // and this pass must have nothing to say about it. If the implicit route ever
    // stopped being "every non-compensator activity", `activity-unreachable`
    // would start firing on the whole pre-LE2-022 corpus.
    expect(
      rules([
        workflow({
          prechecks: undefined,
          route: undefined,
          activities: [
            {
              id: "step",
              capability: STEP,
              payload: {},
              compensation: { terminal: "harmless", why: "unit fixture" },
            },
          ],
          outcomes: { completed: "completed", declined: "declined", failed: "failed" },
        }),
      ]),
    ).toEqual([])
  })
})

describe("workflow-runtime-shape — compensation completeness", () => {
  it("rejects a MUTATING activity that declares neither a compensator nor a terminal marker", () => {
    expect(
      rules([
        workflow({
          activities: activities().map((activity) =>
            activity["id"] === "second" ? { id: "second", capability: STEP, payload: {} } : activity,
          ),
        }),
      ]),
    ).toEqual(["mutating-activity-uncompensated"])
  })

  it("is SILENT for the same omission on a NON-mutating capability", () => {
    // The directional half. Without it the rule could be "every activity needs a
    // compensation statement", which is a different (and wrong) rule that would
    // pass the test above just as well.
    expect(
      rules([
        workflow({
          activities: activities().map((activity) =>
            activity["id"] === "second" ? { id: "second", capability: READ, payload: {} } : activity,
          ),
        }),
      ]),
    ).toEqual([])
  })

  it("accepts BOTH terminal markers and rejects a boolean one", () => {
    for (const terminal of ["irreversible", "harmless"]) {
      expect(
        rules([
          workflow({
            activities: activities().map((activity) =>
              activity["id"] === "second"
                ? { ...activity, compensation: { terminal, why: "unit fixture" } }
                : activity,
            ),
          }),
        ]),
        terminal,
      ).toEqual([])
    }
    // `terminal: true` was never a legal spelling, and accepting it would let a
    // definition skip the irreversible/harmless decision that drives which
    // sentence a customer reads after a half-run.
    expect(
      rules([
        workflow({
          activities: activities().map((activity) =>
            activity["id"] === "second"
              ? { ...activity, compensation: { terminal: true, why: "unit fixture" } }
              : activity,
          ),
        }),
      ]),
    ).toEqual(["mutating-activity-uncompensated"])
  })

  it("rejects a compensator reference that resolves to nothing", () => {
    expect(
      rules([
        workflow({
          activities: activities().map((activity) =>
            activity["id"] === "step" ? { ...activity, compensation: { by: "absent" } } : activity,
          ),
        }),
      ]),
      // The co-emission is real: orphaning `undo` is the same rename seen from
      // its other end. Asserted rather than filtered out, so a change that
      // stopped reporting it would fail here too.
    ).toEqual(["activity-unreachable", "compensator-target-dangling"])
  })

  it("rejects a compensator that is not itself terminal", () => {
    expect(
      rules([
        workflow({
          activities: [
            ...activities().map((activity) =>
              activity["id"] === "undo"
                ? { ...activity, compensation: { by: "undoTheUndo" } }
                : activity,
            ),
            {
              id: "undoTheUndo",
              capability: STEP,
              payload: {},
              compensation: { terminal: "harmless", why: "unit fixture" },
            },
          ],
        }),
      ]),
    ).toEqual(["compensator-not-terminal"])
  })

  it("rejects a compensator the forward route ALSO runs", () => {
    expect(
      rules([
        workflow({
          route: [
            { activity: "step" },
            { activity: "undo" },
            { when: { fact: "cartHasItems", op: "isTrue" }, then: ["second"], otherwise: [] },
          ],
        }),
      ]),
    ).toEqual(["compensator-routed"])
  })
})

describe("workflow-runtime-shape — the conditional graph", () => {
  it("rejects a branch arm naming an activity the workflow does not declare", () => {
    expect(
      rules([
        workflow({
          route: [
            { activity: "step" },
            {
              when: { fact: "cartHasItems", op: "isTrue" },
              then: ["second", "absent"],
              otherwise: [],
            },
          ],
        }),
      ]),
    ).toEqual(["route-target-dangling"])
  })

  it("rejects an activity no route step reaches", () => {
    expect(
      rules([
        workflow({
          activities: [
            ...activities(),
            {
              id: "orphan",
              capability: STEP,
              payload: {},
              compensation: { terminal: "harmless", why: "unit fixture" },
            },
          ],
        }),
      ]),
    ).toEqual(["activity-unreachable"])
  })

  it("does NOT call a compensator unreachable — it is reached by failure, not by the route", () => {
    // Without this exemption the compensation rules and the graph rule would
    // contradict each other: declaring a compensator correctly would make it
    // unreachable, and routing it to fix that would make it `compensator-routed`.
    // The well-formed base already proves it, so this asserts the mechanism
    // directly — `undo` is declared, unrouted, and silent.
    const base = workflow() as unknown as Record<string, unknown>
    const route = base["route"] as readonly unknown[]
    expect(JSON.stringify(route)).not.toContain('"undo"')
    expect(rules([workflow()])).toEqual([])
  })

  it("reaches BOTH arms — an activity only the `otherwise` arm runs is reachable", () => {
    expect(
      rules([
        workflow({
          route: [
            { activity: "step" },
            { when: { fact: "cartHasItems", op: "isTrue" }, then: [], otherwise: ["second"] },
          ],
        }),
      ]),
    ).toEqual([])
  })
})

describe("workflow-runtime-shape — predicates", () => {
  it("rejects a predicate over a fact outside the closed vocabulary", () => {
    expect(
      rules([
        workflow({
          prechecks: [
            {
              id: "authenticated",
              predicate: { fact: "claimTruth", op: "isTrue" },
              template: "infeasible",
            },
          ],
        }),
      ]),
    ).toEqual(["predicate-fact-unknown"])
  })

  it("checks the predicates on ROUTE branches too, not only on pre-checks", () => {
    expect(
      rules([
        workflow({
          route: [
            { activity: "step" },
            { when: { fact: "claimTruth", op: "isTrue" }, then: ["second"], otherwise: [] },
          ],
        }),
      ]),
    ).toEqual(["predicate-fact-unknown"])
  })

  it("rejects a comparing operator with no value, and a valueless operator with one", () => {
    expect(
      rules([
        workflow({
          prechecks: [
            {
              id: "band",
              predicate: { fact: "cartTotalInCentavos", op: "atLeast" },
              template: "infeasible",
            },
          ],
        }),
      ]),
    ).toEqual(["predicate-malformed"])

    expect(
      rules([
        workflow({
          prechecks: [
            {
              id: "band",
              predicate: { fact: "cartHasItems", op: "isTrue", value: true },
              template: "infeasible",
            },
          ],
        }),
      ]),
    ).toEqual(["predicate-malformed"])
  })

  it("accepts every operator in its correct arity", () => {
    for (const [op, value] of [
      ["present", undefined],
      ["absent", undefined],
      ["isTrue", undefined],
      ["isFalse", undefined],
      ["equals", 1],
      ["atLeast", 1],
      ["below", 1],
    ] as const) {
      expect(
        rules([
          workflow({
            prechecks: [
              {
                id: "op",
                predicate: {
                  fact: "cartTotalInCentavos",
                  op,
                  ...(value === undefined ? {} : { value }),
                },
                template: "infeasible",
              },
            ],
          }),
        ]),
        op,
      ).toEqual([])
    }
  })
})

describe("workflow-runtime-shape — the honest-render templates", () => {
  it("rejects a pre-check naming a template the workflow does not declare", () => {
    expect(
      rules([
        workflow({
          prechecks: [
            {
              id: "authenticated",
              predicate: { fact: "customerIsAuthenticated", op: "isTrue" },
              template: "absent",
            },
          ],
        }),
      ]),
    ).toEqual(["precheck-template-missing"])
  })

  it("rejects a multi-step workflow missing either compensation outcome", () => {
    for (const missing of ["compensated", "stranded"]) {
      const outcomes: Record<string, string> = {
        completed: "completed",
        declined: "declined",
        failed: "failed",
        compensated: "compensated",
        stranded: "stranded",
      }
      delete outcomes[missing]
      expect(rules([workflow({ outcomes })]), missing).toEqual([
        "compensation-outcome-template-missing",
      ])
    }
  })

  it("does NOT require them of a workflow that routes one activity", () => {
    // The conditional half, and the reason the rule is not simply "always
    // required": a single-step workflow cannot half-happen, so demanding these
    // sentences would mean authoring pt-BR nobody can ever read — which is the
    // kind of text reviewers approve without reading.
    expect(
      rules([
        workflow({
          route: [{ activity: "step" }],
          activities: [
            { id: "step", capability: STEP, payload: {}, compensation: { by: "undo" } },
            {
              id: "undo",
              capability: STEP,
              payload: {},
              compensation: { terminal: "harmless", why: "unit fixture" },
            },
          ],
          outcomes: { completed: "completed", declined: "declined", failed: "failed" },
        }),
      ]),
    ).toEqual([])
  })
})
