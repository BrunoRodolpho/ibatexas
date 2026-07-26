// Direct tests for the workflow projections — the functions the RUNTIME
// consumes to decide what it offers, what it installs and what it renders.
//
// The module had no tests of its own (0/56 statements before this file). It was
// exercised only transitively, through apps/api, against the BUILT `dist` — so
// nothing in this package could tell whether a projection was still correct, and
// a change here surfaced as a failure two packages away. Every function is pure
// over authored data, so there is nothing to mock and no reason not to.
//
// Asserted against the REAL corpus wherever a real corpus exists. A projection
// tested only against a hand-built literal proves the code does what the literal
// says, not that the shipped catalog projects to something usable.

import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "../../capability-definitions/definitions.js"
import { REORDER_LAST_WORKFLOW, WORKFLOW_DEFINITIONS } from "../definitions.js"
import { FIXTURE_LINEAR_WORKFLOW, FIXTURE_WORKFLOWS } from "../fixtures.js"
import {
  findWorkflow,
  workflowActivityKinds,
  workflowOutcomeText,
  workflowScopedKinds,
  workflowSelectionKinds,
  workflowSlotNames,
  workflowTemplateText,
  workflowTriggerPhrasings,
} from "../projections.js"
import { WORKFLOW_OUTCOMES, type WorkflowDefinition } from "../types.js"

describe("workflowScopedKinds — the access class, projected from capabilities", () => {
  it("projects exactly the definitions flagged workflowScoped", () => {
    expect([...workflowScopedKinds(CAPABILITY_DEFINITIONS)]).toEqual(["order.reorder"])
  })

  it("does NOT include the reorder ANCHOR — the ask is parse-reachable", () => {
    // `order.reorder.request` is identity-tier but NOT workflow-scoped, and the
    // two are different statements. Scoped would make it unreachable from the
    // parse that has to mint the selection envelope.
    expect(workflowScopedKinds(CAPABILITY_DEFINITIONS).has("order.reorder.request")).toBe(
      false,
    )
  })

  it("reads structurally — a definition missing the flag is simply not scoped", () => {
    expect([...workflowScopedKinds([{ kind: "x" } as never])]).toEqual([])
  })

  it("ignores a scoped entry with no usable kind", () => {
    expect([...workflowScopedKinds([{ workflowScoped: true } as never])]).toEqual([])
  })
})

describe("workflowActivityKinds / workflowSelectionKinds", () => {
  it("projects the real corpus's activity and anchor kinds", () => {
    expect([...workflowActivityKinds(WORKFLOW_DEFINITIONS)]).toEqual(["order.reorder"])
    expect([...workflowSelectionKinds(WORKFLOW_DEFINITIONS)]).toEqual([
      "order.reorder.request",
    ])
  })

  it("DEDUPES across workflows — the sets drive registration, not counting", () => {
    // Two workflows invoking one kind must install its handler once. A list here
    // instead of a set would register the same tool twice and, under
    // last-write-wins, make the second registration silently authoritative.
    const twice: readonly WorkflowDefinition[] = [
      REORDER_LAST_WORKFLOW,
      { ...REORDER_LAST_WORKFLOW, id: "workflow.orders.reorder-last.copy" },
    ]
    expect([...workflowActivityKinds(twice)]).toEqual(["order.reorder"])
    expect([...workflowSelectionKinds(twice)]).toEqual(["order.reorder.request"])
  })

  it("is empty for an empty corpus — the inert-composition property", () => {
    // This is what made the runtime a no-op before LE2-021 authored the first
    // workflow, and what will keep a composition that loads none byte-identical.
    expect([...workflowActivityKinds([])]).toEqual([])
    expect([...workflowSelectionKinds([])]).toEqual([])
  })
})

describe("findWorkflow", () => {
  it("finds a declared id in the real corpus", () => {
    expect(findWorkflow(WORKFLOW_DEFINITIONS, REORDER_LAST_WORKFLOW.id)?.id).toBe(
      REORDER_LAST_WORKFLOW.id,
    )
  })

  it("returns undefined for an id the corpus does not declare", () => {
    // The runtime's `select` treats this as "not on this turn's surface" and
    // instantiates nothing, so the miss has to be a clean undefined.
    expect(findWorkflow(WORKFLOW_DEFINITIONS, "workflow.does.not.exist")).toBeUndefined()
  })
})

describe("workflowTemplateText / workflowOutcomeText", () => {
  it("resolves every OUTCOME to authored text, for every workflow in both corpora", () => {
    // The terminal-coverage guarantee, read from the data rather than from the
    // compiler that enforces it: no path may end in silence.
    for (const workflow of [...WORKFLOW_DEFINITIONS, ...FIXTURE_WORKFLOWS]) {
      for (const outcome of WORKFLOW_OUTCOMES) {
        const text = workflowOutcomeText(workflow, outcome)
        expect(text, `${workflow.id}/${outcome}`).toBeTypeOf("string")
        expect(text?.trim(), `${workflow.id}/${outcome}`).not.toBe("")
      }
    }
  })

  it("resolves every CONFIRM point to authored text", () => {
    for (const workflow of [...WORKFLOW_DEFINITIONS, ...FIXTURE_WORKFLOWS]) {
      const text = workflowTemplateText(workflow, workflow.confirm.template)
      expect(text, workflow.id).toBeTypeOf("string")
    }
  })

  it("every confirm template carries the {confirmation} placeholder", () => {
    // The authoring rule: the kernel's own grounded sentence must appear in the
    // reply. A confirm template without the placeholder would ask the customer
    // to approve a multi-step run described entirely by the catalog, with the
    // guard's grounded numbers dropped.
    for (const workflow of [...WORKFLOW_DEFINITIONS, ...FIXTURE_WORKFLOWS]) {
      expect(
        workflowTemplateText(workflow, workflow.confirm.template),
        workflow.id,
      ).toContain("{confirmation}")
    }
  })

  it("returns undefined for a template id the workflow does not declare", () => {
    expect(workflowTemplateText(REORDER_LAST_WORKFLOW, "absent")).toBeUndefined()
  })

  it("returns undefined for an outcome pointing at a missing template", () => {
    const broken = {
      ...REORDER_LAST_WORKFLOW,
      outcomes: { ...REORDER_LAST_WORKFLOW.outcomes, failed: "absent" },
    }
    expect(workflowOutcomeText(broken, "failed")).toBeUndefined()
  })
})

describe("workflowSlotNames — the CLOSED slot surface", () => {
  it("is EMPTY for reorder-last — it declares no params at all", () => {
    // The strongest statement the definition makes: the one value the route
    // needs has no admissible source in the two-member param union, so there is
    // nothing for a model-extracted slot to bind to.
    expect([...workflowSlotNames(REORDER_LAST_WORKFLOW)]).toEqual([])
  })

  it("projects only SLOT params, never claim params", () => {
    // The fixture declares both kinds. A claim param is not customer-authored,
    // so it must never widen the surface the parse seam accepts.
    const names = [...workflowSlotNames(FIXTURE_LINEAR_WORKFLOW)].sort()
    expect(names).toEqual(["delivery_type", "note", "payment_method"])
    expect(names).not.toContain("previousOrderSummary")
  })

  it("dedupes two params bound to one slot name", () => {
    const shared: WorkflowDefinition = {
      ...FIXTURE_LINEAR_WORKFLOW,
      params: [
        { name: "a", source: { from: "slot", slot: "note" } },
        { name: "b", source: { from: "slot", slot: "note" } },
      ],
    }
    expect([...workflowSlotNames(shared)]).toEqual(["note"])
  })
})

describe("workflowTriggerPhrasings — what the selection surface shows (LE2-021)", () => {
  it("projects the natural pt-BR strings, NOT the provenance records", () => {
    // The surface shows sentences. Leaking `{phrasing, provenance, why}` onto
    // the wire would put the authoring metadata — including the review notes —
    // in front of the model.
    const phrasings = workflowTriggerPhrasings(REORDER_LAST_WORKFLOW)
    expect(phrasings).toContain("repete meu último pedido")
    expect(phrasings.every((p) => typeof p === "string")).toBe(true)
  })

  it("preserves AUTHORED order — strongest evidence first", () => {
    // Not sorted: the array is authored production-grounded-first and the
    // surface truncates from the end, so a re-sort would silently drop the
    // best-evidenced phrasing first.
    expect(workflowTriggerPhrasings(REORDER_LAST_WORKFLOW)[0]).toBe(
      "repete meu último pedido",
    )
    expect(workflowTriggerPhrasings(REORDER_LAST_WORKFLOW)).toEqual(
      REORDER_LAST_WORKFLOW.triggerPhrasings.map((t) => t.phrasing),
    )
  })

  it("keeps accents and case — the stored form is what gets embedded", () => {
    // The shared fold exists to COMPARE, never to store. Folding here would
    // degrade the very retrieval the field was added to improve.
    expect(workflowTriggerPhrasings(REORDER_LAST_WORKFLOW)).toContain(
      "quero pedir a mesma coisa da última vez",
    )
  })

  it("is empty for a workflow that declares none", () => {
    expect(
      workflowTriggerPhrasings({ ...REORDER_LAST_WORKFLOW, triggerPhrasings: [] }),
    ).toEqual([])
  })

  it("every phrasing in both corpora is non-blank", () => {
    for (const workflow of [...WORKFLOW_DEFINITIONS, ...FIXTURE_WORKFLOWS]) {
      for (const phrasing of workflowTriggerPhrasings(workflow)) {
        expect(phrasing.trim(), workflow.id).not.toBe("")
      }
    }
  })
})
