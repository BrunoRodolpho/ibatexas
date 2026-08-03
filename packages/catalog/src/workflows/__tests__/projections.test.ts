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
import {
  PAID_CANCEL_WORKFLOW_ID,
  REORDER_LAST_WORKFLOW,
  SWAP_FOR_COUPON_WORKFLOW_ID,
  WORKFLOW_DEFINITIONS,
} from "../definitions.js"
import { FIXTURE_LINEAR_WORKFLOW, FIXTURE_WORKFLOWS } from "../fixtures.js"
import {
  findWorkflow,
  workflowActivityKinds,
  workflowOutcomeText,
  workflowRoutedActivityCount,
  workflowScopedKinds,
  workflowSelectionAnchors,
  workflowSelectionKinds,
  workflowSlotNames,
  workflowTemplateText,
  workflowTriggerPhrasings,
} from "../projections.js"
import {
  WORKFLOW_BASE_OUTCOMES,
  WORKFLOW_COMPENSATION_OUTCOMES,
  type WorkflowDefinition,
} from "../types.js"

describe("workflowScopedKinds — the access class, projected from capabilities", () => {
  it("projects exactly the definitions flagged workflowScoped", () => {
    // LE2-023 — `order.coupon.adjust` joins the class DECLARED-BUT-UNEXECUTABLE:
    // it exists so the swap-for-coupon workflow's closed `coupon_on_placed_order`
    // branch can name a real capability, and being workflow-scoped is the first
    // of its two locks (the second is that no guard produces EXECUTE for it).
    expect([...workflowScopedKinds(CAPABILITY_DEFINITIONS)]).toEqual([
      "order.reorder",
      "order.coupon.adjust",
    ])
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
    // LE2-023 — a CONSCIOUS count pin over the production corpus, which LE2-024
    // makes THREE workflows. These two sets drive real composition-time
    // behaviour: `registerWorkflowScopedTools` throws for an activity kind with
    // no handler and `registerWorkflowAnchorTools` throws for an anchor with
    // none, so a silent change here is a boot failure or, worse, a workflow that
    // confirms with a customer and then cannot dispatch.
    //
    // `order.reorder` appears ONCE despite two workflows routing to it, and so
    // does `order.cancel` now that paid-cancel routes it as well — the dedupe the
    // next case pins directly.
    expect([...workflowActivityKinds(WORKFLOW_DEFINITIONS)]).toEqual([
      "order.reorder",
      "order.cancel",
      "order.coupon.adjust",
      "order.coupon.apply",
    ])
    expect([...workflowSelectionKinds(WORKFLOW_DEFINITIONS)]).toEqual([
      "order.reorder.request",
      "order.coupon.swap.request",
      // LE2-024 — the paid-cancel anchor. Unlike the two above it fronts a
      // capability that ALREADY had a registered tool, so its presence here is
      // also what keeps `registerWorkflowAnchorTools` from shadowing
      // `order.cancel`'s real handler: the anchor is a DIFFERENT kind, which is
      // the whole reason the ASK/ACT split exists.
      "order.cancel.request",
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

describe("workflowSelectionAnchors — the MINTABLE half of the anchor surface (R6-S3)", () => {
  it("carries every anchor's AUTHORED pt-BR description, and the workflow that authored it", () => {
    // The host mints a handler for any anchor its main roster does not carry, and
    // `selection.anchorDescription` is the ONE field of that handler a human
    // wrote. It lives here — with the workflow that means it — rather than in the
    // factory, because a factory-side default would describe a customer-facing
    // approval in a sentence nobody chose. This case is what keeps the three
    // shipped sentences from being edited into the void.
    expect(workflowSelectionAnchors(WORKFLOW_DEFINITIONS)).toEqual([
      {
        workflowId: REORDER_LAST_WORKFLOW.id,
        capability: "order.reorder.request",
        description: "Confirmar a repetição do último pedido do cliente.",
      },
      {
        workflowId: SWAP_FOR_COUPON_WORKFLOW_ID,
        capability: "order.coupon.swap.request",
        description: "Confirmar a troca de um pedido por um novo com cupom aplicado.",
      },
      {
        workflowId: PAID_CANCEL_WORKFLOW_ID,
        capability: "order.cancel.request",
        description: "Confirmar o cancelamento de um pedido já pago do cliente.",
      },
    ])
  })

  it("projects the SAME capabilities as workflowSelectionKinds, in the same order", () => {
    // Two projections over one declaration, and the host consumes both — the
    // install seam takes the kinds, the registration seam takes these. They are
    // pinned against each other here so a future edit cannot teach one about an
    // anchor the other has never heard of.
    expect(workflowSelectionAnchors(WORKFLOW_DEFINITIONS).map((a) => a.capability)).toEqual(
      [...workflowSelectionKinds(WORKFLOW_DEFINITIONS)],
    )
  })

  it("OMITS the description for a workflow that declares none", () => {
    // Both LE2-020 fixtures anchor on `order.checkout.create`, which the shipped
    // roster already owns, so neither needs a minted handler and neither authors
    // a sentence. The field is absent rather than empty: the host's mint-time
    // check reads "declared or not", and an empty string would be a third state
    // that reads as authored.
    const anchors = workflowSelectionAnchors(FIXTURE_WORKFLOWS)
    expect(anchors).toEqual([
      { workflowId: FIXTURE_LINEAR_WORKFLOW.id, capability: "order.checkout.create" },
    ])
    expect("description" in anchors[0]!).toBe(false)
  })

  it("DEDUPES by capability, first declaration winning", () => {
    // Same reason the kinds projection returns a Set: these records drive
    // REGISTRATION, and one kind needs one handler. A list with both would
    // register twice and, under last-write-wins, make the second silently
    // authoritative over the first.
    const twice: readonly WorkflowDefinition[] = [
      REORDER_LAST_WORKFLOW,
      {
        ...REORDER_LAST_WORKFLOW,
        id: "workflow.orders.reorder-last.copy",
        selection: {
          ...REORDER_LAST_WORKFLOW.selection,
          anchorDescription: "Uma segunda frase, para o mesmo handler.",
        },
      },
    ]
    expect(workflowSelectionAnchors(twice)).toEqual([
      {
        workflowId: REORDER_LAST_WORKFLOW.id,
        capability: "order.reorder.request",
        description: "Confirmar a repetição do último pedido do cliente.",
      },
    ])
  })

  it("is empty for an empty corpus — the inert-composition property", () => {
    expect(workflowSelectionAnchors([])).toEqual([])
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
  it("resolves every BASE outcome to authored text, for every workflow in both corpora", () => {
    // The terminal-coverage guarantee, read from the data rather than from the
    // compiler that enforces it: no path may end in silence.
    for (const workflow of [...WORKFLOW_DEFINITIONS, ...FIXTURE_WORKFLOWS]) {
      for (const outcome of WORKFLOW_BASE_OUTCOMES) {
        const text = workflowOutcomeText(workflow, outcome)
        expect(text, `${workflow.id}/${outcome}`).toBeTypeOf("string")
        expect(text?.trim(), `${workflow.id}/${outcome}`).not.toBe("")
      }
    }
  })

  it("resolves both COMPENSATION outcomes for every workflow that can reach them", () => {
    // LE2-022 — the requirement is conditional, so the assertion has to be too,
    // and the CONDITION is asserted from the same projection the compiler rule
    // reads rather than from a hand-listed set of workflow ids. A workflow whose
    // route reaches at most one activity cannot half-happen; one that reaches
    // more can, and owes both sentences.
    const multiStep = [...WORKFLOW_DEFINITIONS, ...FIXTURE_WORKFLOWS].filter(
      (workflow) => workflowRoutedActivityCount(workflow) > 1,
    )
    // The control: without it this loop would pass vacuously the day the corpus
    // holds only single-step workflows.
    expect(multiStep.length).toBeGreaterThan(0)
    for (const workflow of multiStep) {
      for (const outcome of WORKFLOW_COMPENSATION_OUTCOMES) {
        const text = workflowOutcomeText(workflow, outcome)
        expect(text, `${workflow.id}/${outcome}`).toBeTypeOf("string")
        expect(text?.trim(), `${workflow.id}/${outcome}`).not.toBe("")
      }
    }
  })

  it("a single-step workflow is NOT required to author them — and reorder-last does not", () => {
    // The other side of the conditional requirement, pinned so that "reorder-last
    // has no compensated template" reads as a decision rather than as a gap the
    // next reviewer closes by authoring pt-BR nobody can ever read.
    expect(workflowRoutedActivityCount(REORDER_LAST_WORKFLOW)).toBe(1)
    expect(workflowOutcomeText(REORDER_LAST_WORKFLOW, "compensated")).toBeUndefined()
    expect(workflowOutcomeText(REORDER_LAST_WORKFLOW, "stranded")).toBeUndefined()
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
