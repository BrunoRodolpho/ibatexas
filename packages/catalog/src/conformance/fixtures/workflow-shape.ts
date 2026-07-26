// Conformance fixtures for the `workflow-shape` pass (LE2-020).
//
// One fixture per rule id, each the minimal witness: a well-formed workflow
// (`workflowBase()`) with exactly ONE thing changed. The control is
// `clean.workflow-well-formed` in `clean.ts` — the same base, compiled silent.
//
// Every fixture declares its own capabilities, so the workflows here reference
// kinds that exist inside the fixture rather than inheriting the real catalog.
// Two capabilities is the budget the suite enforces, which is exactly what a
// workflow needs: an ANCHOR (the selection capability, parse-reachable) and a
// STEP (an activity's capability).

import { fixtureCatalog, fixtureWorkflows, type ConformanceFixture } from "../types.js"
import { IDENTITY_BASE } from "./base.js"

/** The fixture catalog's parse-reachable anchor kind. */
export const FIXTURE_ANCHOR_KIND = "conformance.workflow.anchor"
/** The fixture catalog's activity kind. */
export const FIXTURE_STEP_KIND = "conformance.workflow.step"

/**
 * The two capabilities every workflow fixture routes over. Identity-tier so the
 * chat-tier passes (slot dataflow, conversation projection, terminal coverage)
 * stay silent and each fixture keeps emitting only its own rule.
 */
export function workflowCapabilities(
  overrides: {
    readonly anchor?: Readonly<Record<string, unknown>>
    readonly step?: Readonly<Record<string, unknown>>
  } = {},
) {
  return fixtureCatalog(
    { ...IDENTITY_BASE, kind: FIXTURE_ANCHOR_KIND, ...(overrides.anchor ?? {}) },
    { ...IDENTITY_BASE, kind: FIXTURE_STEP_KIND, ...(overrides.step ?? {}) },
  )
}

/**
 * A WELL-FORMED workflow: two matchers' worth of nothing exotic, one anchor,
 * one claim-sourced param, one activity that binds it, one confirm point, and a
 * template for the confirm point and for all three outcomes.
 *
 * Spread-and-override is how each fixture below breaks exactly one thing.
 */
/**
 * Six phrasings that clear the floor, are distinct under the shared fold, and
 * look like nothing in the real catalog — so a fixture isolating some OTHER rule
 * never also trips rule 8. `phrasingsFrom` below builds a second, disjoint set
 * for the fixtures that need two workflows.
 */
export function workflowPhrasings(prefix: string): readonly Record<string, unknown>[] {
  return ["alfa", "bravo", "charlie", "delta", "echo", "foxtrot"].map((word) => ({
    phrasing: `${prefix} ${word}`,
    provenance: "authored",
    why: "conformance fixture",
  }))
}

export function workflowBase(): Record<string, unknown> {
  return {
    id: "conformance.workflow.linear",
    title: "Fluxo de conformidade",
    description: "Fluxo de conformidade (fixture).",
    triggerPhrasings: workflowPhrasings("fluxo de conformidade"),
    matchers: [{ capability: FIXTURE_ANCHOR_KIND }],
    selection: { capability: FIXTURE_ANCHOR_KIND },
    // A REAL registry claim type (`claim-param-type-unknown` targets the wrong
    // vocabulary deliberately, and only in its own fixture). The base has to be
    // otherwise-clean or every fixture in this file would carry a second,
    // unrelated diagnostic and stop isolating the rule it names.
    params: [
      {
        name: "history",
        source: { from: "claim", claimType: "ORDER_HISTORY", field: "historySummaryText" },
      },
    ],
    activities: [
      { id: "step", capability: FIXTURE_STEP_KIND, payload: { summary: { param: "history" } } },
    ],
    confirm: { template: "confirm" },
    templates: [
      { id: "confirm", text: "Confirma?" },
      { id: "completed", text: "Pronto." },
      { id: "declined", text: "Tudo bem." },
      { id: "failed", text: "Não consegui." },
    ],
    outcomes: { completed: "completed", declined: "declined", failed: "failed" },
  }
}

export const WORKFLOW_SHAPE_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "workflow-shape.capability-reference-dangling",
    targets: "workflow-shape/capability-reference-dangling",
    why:
      "The activity routes to `conformance.workflow.absent`, a kind no capability " +
      "definition declares. Nothing catches this at run time in a useful way: the " +
      "policy router's unknown-kind branch default-REFUSEs, so the workflow would " +
      "confirm with the customer, run its first steps, and then fail on a step that " +
      "was never executable — the worst possible moment to discover a typo.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...workflowBase(),
      activities: [
        {
          id: "step",
          capability: "conformance.workflow.absent",
          payload: { summary: { param: "history" } },
        },
      ],
    }),
  },
  {
    name: "workflow-shape.workflow-scoped-reference-unreachable",
    targets: "workflow-shape/workflow-scoped-reference-unreachable",
    why:
      "The anchor capability is declared workflow-scoped, and the workflow selects " +
      "through it. A workflow-scoped kind is never advertised and never accepted " +
      "from a parse, so this selection envelope can never be minted — the workflow " +
      "is permanently unreachable while looking perfectly well-formed. The failure " +
      "mode is silence, which is why it has to be a build error.",
    definitions: workflowCapabilities({ anchor: { workflowScoped: true } }),
    workflows: fixtureWorkflows(workflowBase()),
  },
  {
    name: "workflow-shape.activity-param-undeclared",
    targets: "workflow-shape/activity-param-undeclared",
    why:
      "The activity binds a param named `total` that the workflow never declares. A " +
      "param is the whole statement of WHERE a value comes from — a validated claim " +
      "or a customer-authored slot — so an unbound binding is a payload field with " +
      "no admissible source at all, and the only way to fill it would be the one " +
      "way this design forbids: letting the model invent it.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...workflowBase(),
      activities: [
        { id: "step", capability: FIXTURE_STEP_KIND, payload: { total: { param: "total" } } },
      ],
    }),
  },
  {
    name: "workflow-shape.claim-param-type-unknown",
    targets: "workflow-shape/claim-param-type-unknown",
    why:
      "The param sources from `order-placed`, which is a SUCCESS CLAIM CLASS — one of " +
      "the responder's anti-confabulation guard ids — and not a member of the registry " +
      "claim-type vocabulary the planner selects from. The two are constantly confused " +
      "because both are called 'claims' (SDD §K: map, do not equate), and only the " +
      "registry types carry a validated VALUE at all. This is not a hypothetical " +
      "authoring slip: LE2-020's own fixture shipped exactly this spelling. It has to " +
      "be a BUILD error because at run time it is perfectly silent — the resolver looks " +
      "the type up in a map, misses, and leaves the param UNRESOLVED forever, so the " +
      "workflow simply never runs and no diagnostic is emitted anywhere.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...workflowBase(),
      params: [
        ...(workflowBase()["params"] as readonly unknown[]),
        { name: "previous", source: { from: "claim", claimType: "order-placed", field: "orderId" } },
      ],
    }),
  },
  {
    name: "workflow-shape.activity-sequence-empty",
    targets: "workflow-shape/activity-sequence-empty",
    why:
      "A workflow with no activities asks the customer to approve something and then " +
      "does nothing. That is worse than having no workflow: it teaches the customer " +
      "that confirming is a formality, which is exactly the intuition the whole " +
      "confirm-window design depends on NOT being true.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({ ...workflowBase(), activities: [] }),
  },
  {
    name: "workflow-shape.activity-id-duplicated",
    targets: "workflow-shape/activity-id-duplicated",
    why:
      "Two activities share the id `step`. Nothing is lost at run time — both still " +
      "execute — which is what makes it dangerous: the per-step trace records are " +
      "keyed by activity id, so an operator drilling into a failed step sees two " +
      "different mutations collapsed onto one row and draws a confident wrong " +
      "conclusion about which one failed.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...workflowBase(),
      activities: [
        { id: "step", capability: FIXTURE_STEP_KIND, payload: { summary: { param: "history" } } },
        { id: "step", capability: FIXTURE_STEP_KIND, payload: {} },
      ],
    }),
  },
  {
    name: "workflow-shape.confirm-template-missing",
    targets: "workflow-shape/confirm-template-missing",
    why:
      "The confirm point names a template the workflow does not declare. The confirm " +
      "prompt is the ONE sentence the customer reads before approving a multi-step " +
      "run; with no template the runtime has nothing to render, and the only " +
      "remaining source for that sentence is model prose — which is precisely the " +
      "thing the renderer-from-claims design exists to prevent.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({ ...workflowBase(), confirm: { template: "absent" } }),
  },
  {
    name: "workflow-shape.outcome-template-missing",
    targets: "workflow-shape/outcome-template-missing",
    why:
      "The `failed` outcome names no template. Failure is the outcome nobody authors " +
      "and the one where an honest sentence matters most: without it a half-run " +
      "workflow ends in silence, and the customer is left not knowing which of the " +
      "steps they approved actually happened.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...workflowBase(),
      outcomes: { completed: "completed", declined: "declined", failed: "" },
    }),
  },
  {
    name: "workflow-shape.workflow-id-duplicated",
    targets: "workflow-shape/workflow-id-duplicated",
    why:
      "Two definitions claim the id `conformance.workflow.linear`. The id is what the " +
      "parser selects and what an instance pins itself to, so a duplicate does not " +
      "fail — it resolves to whichever definition the corpus happens to list first, " +
      "making the customer's selection depend on array order.",
    definitions: workflowCapabilities(),
    // The SECOND copy carries a disjoint phrasing set. Sharing one would also
    // trip `trigger-phrasing-collides`, and a fixture emitting two rules stops
    // being a witness for either.
    workflows: fixtureWorkflows(workflowBase(), {
      ...workflowBase(),
      triggerPhrasings: workflowPhrasings("outro fluxo de conformidade"),
    }),
  },
  {
    name: "workflow-shape.trigger-phrasings-below-floor",
    targets: "workflow-shape/trigger-phrasings-below-floor",
    why:
      "The workflow declares two trigger phrasings against a floor of six. The " +
      "phrasings are composed into the `start_workflow` tool description — they are " +
      "on the wire, not in the docs — so a workflow below the floor is reachable " +
      "only through its one-line description. LE2-021 measured that surface against " +
      "the real engine at 87.5% selection, with an ordinary pt-BR idiom selecting " +
      "0/5. And the failure is SILENT: a non-selection produces no envelope, no " +
      "audit row and no diagnostic, so nothing downstream can tell the difference " +
      "between a customer who did not ask and a customer whose asking was not " +
      "understood.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...workflowBase(),
      triggerPhrasings: workflowPhrasings("fluxo de conformidade").slice(0, 2),
    }),
  },
  {
    name: "workflow-shape.trigger-phrasing-duplicated",
    targets: "workflow-shape/trigger-phrasing-duplicated",
    why:
      "Two of this workflow's own phrasings are the same sentence under the shared " +
      "word-space fold — differing only in case, an accent and an exclamation mark. " +
      "The floor counts ENTRIES, so the workflow clears it while covering one fewer " +
      "way of asking than its author believed, and nothing at run time can report " +
      "the shortfall. The fold is `normalizeTriggerPhrasing`, the same one " +
      "`conversationTriggers` and the alias gazetteer compare under, so 'same' means " +
      "one thing catalog-wide.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...workflowBase(),
      triggerPhrasings: [
        ...workflowPhrasings("fluxo de conformidade"),
        {
          phrasing: "Fluxo de conformidade ALFÁ!",
          provenance: "authored",
          why: "the same sentence as the first entry, once folded",
        },
      ],
    }),
  },
  {
    name: "workflow-shape.trigger-phrasing-collides",
    targets: "workflow-shape/trigger-phrasing-collides",
    why:
      "A second workflow claims a phrasing the first already owns. This is the " +
      "dangerous member of the family: it does not DEGRADE selection, it makes it a " +
      "coin flip, and the customer gets a confidently-executed wrong route while " +
      "both definitions look correct read in isolation. The rule spans namespaces " +
      "for the same reason — a capability's `conversationTriggers` and a workflow's " +
      "phrasings both feed the same surface, so one sentence meaning two different " +
      "things is a contradiction no runtime can resolve at the moment it matters.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows(workflowBase(), {
      ...workflowBase(),
      id: "conformance.workflow.rival",
      triggerPhrasings: [
        {
          phrasing: "fluxo de conformidade alfa",
          provenance: "authored",
          why: "already owned by conformance.workflow.linear",
        },
        ...workflowPhrasings("fluxo rival"),
      ],
    }),
  },
  {
    name: "workflow-shape.workflow-scoped-kind-advertised",
    targets: "workflow-shape/workflow-scoped-kind-advertised",
    why:
      "One capability is declared workflow-scoped AND recorded as planner-advertised. " +
      "The two say opposite things about whether the parser may propose this kind, " +
      "and there is no reading under which both are true. Left to run time the " +
      "subtraction wins silently, so the authored data and the observed behaviour " +
      "disagree with nothing to point at.",
    definitions: fixtureCatalog({
      ...IDENTITY_BASE,
      kind: FIXTURE_STEP_KIND,
      workflowScoped: true,
      plannerAdvertisedBy: ["ibatexas/pack-orders"],
    }),
  },
]

/**
 * The CONTROL: the same base workflow over the same two capabilities, compiled
 * silent. Without it every rejection fixture above is only half an experiment —
 * it shows the pass fires, never that it fires because of the one thing changed.
 */
export const CLEAN_WORKFLOW_FIXTURE: ConformanceFixture = {
  name: "clean.workflow-well-formed",
  targets: null,
  why:
    "The base every workflow-shape rejection fixture is one edit away from: " +
    "references that resolve, a parse-reachable anchor, a bound param, a confirm " +
    "template and a template for all three outcomes. It is the control that makes " +
    "each rejection attributable to its single change.",
  definitions: workflowCapabilities(),
  workflows: fixtureWorkflows(workflowBase()),
}
