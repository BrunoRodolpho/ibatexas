// Conformance fixtures for the `workflow-runtime-shape` pass (LE2-022).
//
// Same discipline as every other file here: one fixture per rule id, each the
// minimal witness — {@link runtimeBase} with exactly ONE thing changed — and a
// control (`clean.workflow-runtime-well-formed`) that is the same base compiled
// silent, so each rejection is attributable to its single change.
//
// The base is deliberately RICHER than `workflow-shape`'s: it declares a
// compensator, a compensated step, a two-armed branch and a pre-check, because
// every rule in this pass is about one of those and a base that had none of them
// could not be one edit away from most of the fixtures.
//
// The capabilities come from `workflow-shape.ts`'s `workflowCapabilities()`,
// unchanged. They are `mutating: true` (`IDENTITY_BASE`), which is what makes
// the compensation rules fire at all — and is also why that file's own base had
// to grow a compensation statement in this ticket.

import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import { fixtureWorkflows, type ConformanceFixture } from "../types.js"
import {
  FIXTURE_ANCHOR_KIND,
  FIXTURE_STEP_KIND,
  workflowCapabilities,
  workflowPhrasings,
} from "./workflow-shape.js"

/**
 * A WELL-FORMED v1 workflow.
 *
 * `step` mutates and is compensated by `undo`; `undo` is terminal, so the
 * regress ends. `second` is reached only by the branch's `then` arm and is
 * terminal-irreversible. The route reaches TWO non-compensator activities, which
 * is what makes the two compensation outcome templates required — so the base
 * declares them, and the fixture for that rule removes one.
 *
 * Its id and phrasings are disjoint from `workflow-shape.ts`'s base: the two
 * bases are compiled in the same suite, and sharing either would trip
 * `workflow-id-duplicated` or `trigger-phrasing-collides` in every fixture here.
 */
export function runtimeBase(): Record<string, unknown> {
  return {
    id: "conformance.workflow.runtime",
    title: "Fluxo de runtime de conformidade",
    description: "Fluxo de runtime de conformidade (fixture).",
    triggerPhrasings: workflowPhrasings("fluxo de runtime"),
    matchers: [{ capability: FIXTURE_ANCHOR_KIND }],
    selection: { capability: FIXTURE_ANCHOR_KIND },
    params: [
      {
        name: "history",
        source: { from: "claim", claimType: "ORDER_HISTORY", field: "historySummaryText" },
      },
    ],
    prechecks: [
      {
        id: "authenticated",
        predicate: { fact: "customerIsAuthenticated", op: "isTrue" },
        template: "infeasible",
      },
    ],
    activities: [
      {
        id: "step",
        capability: FIXTURE_STEP_KIND,
        payload: { summary: { param: "history" } },
        compensation: { by: "undo" },
      },
      {
        id: "undo",
        capability: FIXTURE_STEP_KIND,
        payload: {},
        compensation: { terminal: "harmless", why: "the rollback itself" },
      },
      {
        id: "second",
        capability: FIXTURE_STEP_KIND,
        payload: {},
        compensation: { terminal: "irreversible", why: "conformance fixture" },
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
      { id: "compensated", text: "Desfiz o que já tinha feito." },
      { id: "stranded", text: "Não consegui desfazer tudo." },
      { id: "infeasible", text: "Não dá pra fazer isso agora." },
    ],
    outcomes: {
      completed: "completed",
      declined: "declined",
      failed: "failed",
      compensated: "compensated",
      stranded: "stranded",
    },
  }
}

/** The base's activities, so a fixture can replace exactly one of them. */
function baseActivities(): readonly Record<string, unknown>[] {
  return runtimeBase()["activities"] as readonly Record<string, unknown>[]
}

export const WORKFLOW_RUNTIME_SHAPE_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "workflow-runtime-shape.mutating-activity-uncompensated",
    targets: "workflow-runtime-shape/mutating-activity-uncompensated",
    why:
      "The `second` activity routes to a capability the catalog declares " +
      "`mutating: true` and says nothing at all about undoing it. That is the " +
      "rule's whole point: an author who decided nothing CAN undo it and an author " +
      "who never thought about it produce identical data under an optional field, " +
      "and the second case is how a customer ends up holding half a workflow. The " +
      "run-time symptom is a `failed` render — which reads as 'nothing happened' — " +
      "over a mutation that is still in the store.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      activities: baseActivities().map((activity) =>
        activity["id"] === "second"
          ? { id: activity["id"], capability: activity["capability"], payload: {} }
          : activity,
      ),
    }),
  },
  {
    name: "workflow-runtime-shape.compensator-target-dangling",
    targets: "workflow-runtime-shape/compensator-target-dangling",
    alsoEmits: ["workflow-runtime-shape/activity-unreachable"],
    why:
      "`step` names `absent` as its compensator and no such activity exists. " +
      "Nothing fails at run time — the runtime resolves the id, misses, and the " +
      "mutation is simply never undone — so the rollback exists in the definition " +
      "and not in production, with the definition still reading as though it would " +
      "run. A renamed activity leaves exactly this behind. " +
      "CO-EMISSION, and a real one rather than fixture slop: pointing `step` at a " +
      "name that does not exist ORPHANS the compensator that did — `undo` is now " +
      "nobody's compensator and nothing routes it, which is precisely " +
      "`activity-unreachable`. The two diagnostics are the two ends of one " +
      "rename, which is exactly the pair a reviewer needs to see together, so it " +
      "is declared rather than engineered away.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      activities: baseActivities().map((activity) =>
        activity["id"] === "step" ? { ...activity, compensation: { by: "absent" } } : activity,
      ),
    }),
  },
  {
    name: "workflow-runtime-shape.compensator-not-terminal",
    targets: "workflow-runtime-shape/compensator-not-terminal",
    why:
      "`undo` is `step`'s compensator and declares a compensator of its own. That " +
      "asks what undoes the undo, and the regress has no authored end — so it has " +
      "to end at the build rather than at run time in a chain nobody wrote. The " +
      "second-order compensator is declared here too, so the fixture witnesses the " +
      "regress rule and not a dangling reference.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      activities: [
        ...baseActivities().map((activity) =>
          activity["id"] === "undo"
            ? { ...activity, compensation: { by: "undoTheUndo" } }
            : activity,
        ),
        {
          id: "undoTheUndo",
          capability: FIXTURE_STEP_KIND,
          payload: {},
          compensation: { terminal: "harmless", why: "the second-order rollback" },
        },
      ],
    }),
  },
  {
    name: "workflow-runtime-shape.compensator-routed",
    targets: "workflow-runtime-shape/compensator-routed",
    why:
      "The route runs `undo` as a forward step while `step` also names it as its " +
      "compensator. It would then execute TWICE on a failure — once as a step and " +
      "once as the rollback — and once on success, undoing work the customer " +
      "explicitly approved. Both are real mutations against a real order, and " +
      "neither is visible in the definition unless you read the route and the " +
      "compensation slot together.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      route: [
        { activity: "step" },
        { activity: "undo" },
        { when: { fact: "cartHasItems", op: "isTrue" }, then: ["second"], otherwise: [] },
      ],
    }),
  },
  {
    name: "workflow-runtime-shape.route-target-dangling",
    targets: "workflow-runtime-shape/route-target-dangling",
    why:
      "The branch's `then` arm routes to `absent`, which the workflow does not " +
      "declare. The step is silently skipped: no error, no diagnostic, and a route " +
      "that reads as doing one more thing than it does. This is the same authoring " +
      "slip as `activity-unreachable` seen from the other end, and naming both is " +
      "what turns a rename into a build failure instead of a behaviour change. " +
      "The arm keeps `second` alongside the dangling name deliberately: routing " +
      "to `absent` ALONE would also orphan `second` and the fixture would witness " +
      "two rules instead of one.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      route: [
        { activity: "step" },
        {
          when: { fact: "cartHasItems", op: "isTrue" },
          then: ["second", "absent"],
          otherwise: [],
        },
      ],
    }),
  },
  {
    name: "workflow-runtime-shape.activity-unreachable",
    targets: "workflow-runtime-shape/activity-unreachable",
    why:
      "`orphan` is declared, routed by nothing, and named as nobody's compensator. " +
      "It is dead in production and live in review — the most expensive kind of " +
      "dead code, because a reviewer reads it as part of what the customer " +
      "approved. Compensators are deliberately exempt from this rule: they are " +
      "reached by failure rather than by the route, and without the exemption " +
      "declaring one correctly would make it unreachable while routing it to fix " +
      "that would make it `compensator-routed`.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      activities: [
        ...baseActivities(),
        {
          id: "orphan",
          capability: FIXTURE_STEP_KIND,
          payload: {},
          compensation: { terminal: "harmless", why: "conformance fixture" },
        },
      ],
    }),
  },
  {
    name: "workflow-runtime-shape.predicate-fact-unknown",
    targets: "workflow-runtime-shape/predicate-fact-unknown",
    why:
      "The pre-check reads `claimTruth`, which is not a member of the closed " +
      "workflow fact vocabulary. That vocabulary is where this layer's " +
      "anti-confabulation guarantee lives: every legal name is a projection the " +
      "resolver grounds into the same state the kernel's guards are adjudicated " +
      "against, so a predicate cannot reach model output because no such name " +
      "compiles. At run time the failure is perfectly silent — the fact resolves " +
      "by map lookup, misses, and the predicate is FALSE forever, leaving a " +
      "pre-check that never fires or a branch permanently stuck on one arm. It is " +
      "`claim-param-type-unknown` one layer over, and `claimTruth` is chosen " +
      "precisely because it is the spelling the ticket's own wording invites.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      prechecks: [
        {
          id: "authenticated",
          predicate: { fact: "claimTruth", op: "isTrue" },
          template: "infeasible",
        },
      ],
    }),
  },
  {
    name: "workflow-runtime-shape.predicate-malformed",
    targets: "workflow-runtime-shape/predicate-malformed",
    why:
      "The branch compares with `atLeast` and declares no value to compare " +
      "against. There is nothing on the right-hand side, so the predicate is FALSE " +
      "for every fact value it will ever see — a branch that reads as conditional " +
      "and is not, with the `then` arm permanently dead. The rule polices the " +
      "other direction too (a value on an operator that takes none), because a " +
      "reviewer approves the comparison they read rather than the presence check " +
      "that actually runs.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      route: [
        { activity: "step" },
        {
          when: { fact: "cartTotalInCentavos", op: "atLeast" },
          then: ["second"],
          otherwise: [],
        },
      ],
    }),
  },
  {
    name: "workflow-runtime-shape.precheck-template-missing",
    targets: "workflow-runtime-shape/precheck-template-missing",
    why:
      "The pre-check names a template the workflow does not declare. A pre-check " +
      "exists to say WHY the workflow will not run, at the one moment a customer " +
      "is being turned down and a generic sentence is least useful; with no " +
      "template the runtime has nothing to render, and the only remaining source " +
      "for that sentence is model prose — the substitution the whole " +
      "renderer-from-claims design exists to prevent.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      prechecks: [
        {
          id: "authenticated",
          predicate: { fact: "customerIsAuthenticated", op: "isTrue" },
          template: "absent",
        },
      ],
    }),
  },
  {
    name: "workflow-runtime-shape.compensation-outcome-template-missing",
    targets: "workflow-runtime-shape/compensation-outcome-template-missing",
    why:
      "The route reaches two activities — so a run can stop in the middle — and " +
      "the workflow has no `stranded` template. Falling back to `failed` would " +
      "tell the customer NOTHING happened while a real mutation sits in the store, " +
      "which is the same false-negative shape as a false success pointed the other " +
      "way. `compensated` and `stranded` are required together for the same " +
      "reason: a workflow that can say 'I undid it' but not 'I could not' will " +
      "render the reassuring sentence for the frightening case.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      outcomes: {
        completed: "completed",
        declined: "declined",
        failed: "failed",
        compensated: "compensated",
      },
    }),
  },
]

/**
 * The fixture capabilities, with the STEP kind declared `escalatable: true`.
 *
 * A separate builder rather than a flag on `workflowCapabilities()` because only
 * the escalated-outcome fixture wants it: the field changes which rule fires, so
 * leaking it into the shared builder would make every other fixture in this file
 * one silent edit away from demanding an `escalated` template too — and a
 * control that quietly requires more than it says is not a control.
 */
function escalatableCapabilities(): readonly CapabilityDefinition[] {
  return workflowCapabilities().map((definition) => {
    // Read STRUCTURALLY, like every other fixture builder here: a fixture
    // catalog is deliberately allowed to be any shape (that is what lets one
    // witness a malformed slot), so the union's own narrowing does not apply.
    const record = definition as unknown as Record<string, unknown>
    return (
      record["kind"] === FIXTURE_STEP_KIND ? { ...record, escalatable: true } : record
    ) as unknown as CapabilityDefinition
  })
}

/** LE2-023 — the three rejection classes the coverage + escalation rules add. */
export const LE2_023_WORKFLOW_RUNTIME_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "workflow-runtime-shape.confirm-coverage-unstated",
    targets: "workflow-runtime-shape/confirm-coverage-unstated",
    why:
      "The activity declares that the whole-workflow confirm already asked its " +
      "own confirm question, and names the facts that question stated — but the " +
      "confirm itself declares none of them. This is the rule that keeps " +
      "coverage from becoming a rubber stamp: a customer who approved a bare " +
      "\"confirma?\" has not been told an amount or a refund consequence, so " +
      "resolving a money guard's confirm on the strength of it would execute a " +
      "governed mutation against a sentence that never mentioned their money.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      activities: [
        {
          id: "step",
          capability: FIXTURE_STEP_KIND,
          payload: { summary: { param: "history" } },
          compensation: { by: "undo" },
          confirmCoveredBy: {
            basisReason: "paid_cancel_requires_confirmation",
            statesFacts: ["orderAmount", "refundConsequence"],
            why: "conformance fixture",
          },
        },
        {
          id: "undo",
          capability: FIXTURE_STEP_KIND,
          payload: {},
          compensation: { terminal: "harmless", why: "the rollback itself" },
        },
        {
          id: "second",
          capability: FIXTURE_STEP_KIND,
          payload: {},
          compensation: { terminal: "irreversible", why: "conformance fixture" },
        },
      ],
    }),
  },
  {
    name: "workflow-runtime-shape.confirm-coverage-fact-unknown",
    targets: "workflow-runtime-shape/confirm-coverage-fact-unknown",
    why:
      "The confirm declares it states a fact outside WORKFLOW_CONFIRM_FACTS. A " +
      "name the vocabulary does not know cannot be checked against a coverage " +
      "claim in either direction, so it would be a statement about what the " +
      "customer was told that is neither true nor false — the same closed-" +
      "vocabulary discipline `predicate-fact-unknown` applies one field over.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      confirm: { template: "confirm", statesFacts: ["theCustomerWasToldEverything"] },
    }),
  },
  {
    name: "workflow-runtime-shape.escalated-outcome-template-missing",
    targets: "workflow-runtime-shape/escalated-outcome-template-missing",
    why:
      "The route reaches a capability the catalog declares `escalatable: true` " +
      "and the workflow authors no `escalated` template. A run can therefore end " +
      "with a step on a staff queue and nothing authored to say so; the runtime " +
      "would fall back to `failed`, which means NOTHING RAN — literally true for " +
      "a first-step escalation and still a lie about the future, because an " +
      "owner is about to decide the very thing the customer was told did not " +
      "happen.",
    definitions: escalatableCapabilities(),
    workflows: fixtureWorkflows(runtimeBase()),
  },
  {
    name: "workflow-runtime-shape.policy-gated-activity-not-scoped",
    targets: "workflow-runtime-shape/policy-gated-activity-not-scoped",
    why:
      "The route gates `second` behind a POLICY SWITCH, but `second`'s " +
      "capability is not declared `workflowScoped: true`. A policy switch closes " +
      "a ROUTE, and a route is catalog DATA — one edited line from being open. " +
      "Behind it must sit a kind no parse can propose in the first place, or the " +
      "whole protection is a single line in a file anyone who can edit data may " +
      "change. This is the rule `workflows/types.ts` promised from ac290eb3 and " +
      "which did not exist until LE2-023 built it; a doc citing a gate that is " +
      "not there is worse than no doc, because a reviewer reads it and stops " +
      "checking.",
    definitions: workflowCapabilities(),
    workflows: fixtureWorkflows({
      ...runtimeBase(),
      route: [
        { activity: "step" },
        // The OPEN arm is the gated one. `otherwise` is the shipped path and is
        // deliberately NOT required to be scoped — requiring it would forbid a
        // policy branch from ever falling back to an ordinary capability, which
        // is exactly what a shipped arm must do.
        {
          whenPolicyOpen: "coupon_on_placed_order",
          then: ["second"],
          otherwise: [],
        },
      ],
    }),
  },
]

/**
 * The CONTROL: the same v1 base, compiled silent.
 *
 * Without it every rejection above is only half an experiment — it shows the
 * pass fires, never that it fires because of the one thing changed. It carries
 * extra weight in THIS file: several rules here are about the ABSENCE of
 * something (an unreachable activity, a missing template), and an absence-shaped
 * rule with no control is exactly the shape that passes vacuously.
 */
export const CLEAN_WORKFLOW_RUNTIME_FIXTURE: ConformanceFixture = {
  name: "clean.workflow-runtime-well-formed",
  targets: null,
  why:
    "The v1 base every rejection fixture in this file is one edit away from: a " +
    "compensated mutation, a terminal compensator that ends the regress, a " +
    "two-armed branch over a grounded fact, a pre-check with its own honest " +
    "template, and both compensation outcomes authored because the route can " +
    "reach two activities.",
  definitions: workflowCapabilities(),
  workflows: fixtureWorkflows(runtimeBase()),
}
