// Unit tests for the workflow runtime's v1 MECHANICS (LE2-022).
//
// `workflow-runtime-v1.e2e.test.ts` proves the four acceptance criteria alive
// through the real gate, over the real kernel, on the fixture corpus. This file
// proves the properties a turn cannot isolate — the ones that need a run to fail
// in a specific place, with a specific mix of compensation declarations, more
// times than a corpus can plausibly be authored to produce:
//
//   - the OUTCOME DERIVATION, over every combination of what ran and what could
//     be undone. That function decides which sentence a customer reads about a
//     half-finished run, and getting it wrong is the exact failure this ticket
//     is about;
//   - COMPENSATION ORDER, which is only observable with three steps;
//   - the v0 BACKWARD-COMPATIBILITY path (no route ⟹ linear over the declared
//     activities), asserted rather than assumed.
//
// The kernel is stubbed HERE and only here: these are statements about what the
// runtime does with a decision, not about which decision the kernel gives.

import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@ibatexas/catalog";
import { FIXTURE_LINEAR_WORKFLOW } from "@ibatexas/catalog";
import { createWorkflowRuntime, type WorkflowRuntime } from "../workflow-runtime.js";
import type { WorkflowFacts } from "../workflow-predicates.js";

const ANCHOR = "order.checkout.create";
const STEP = "order.cart.ensure";
const ACTOR = { principal: "llm", role: "customer" } as never;

/** A v1 workflow over REAL capability kinds, with everything overridable. */
function workflow(overrides: Partial<Record<string, unknown>> = {}): WorkflowDefinition {
  return {
    ...FIXTURE_LINEAR_WORKFLOW,
    id: "workflow.unit.v1",
    params: [],
    prechecks: [],
    activities: [
      { id: "one", capability: STEP, payload: {}, compensation: { by: "undoOne" } },
      {
        id: "undoOne",
        capability: STEP,
        payload: {},
        compensation: { terminal: "harmless", why: "unit" },
      },
      { id: "two", capability: STEP, payload: {}, compensation: { by: "undoTwo" } },
      {
        id: "undoTwo",
        capability: STEP,
        payload: {},
        compensation: { terminal: "harmless", why: "unit" },
      },
      {
        id: "three",
        capability: STEP,
        payload: {},
        compensation: { terminal: "irreversible", why: "unit" },
      },
    ],
    route: [{ activity: "one" }, { activity: "two" }, { activity: "three" }],
    ...overrides,
  } as unknown as WorkflowDefinition;
}

/**
 * A runtime whose kernel answers per KIND-AND-CALL: `decisions` is consumed in
 * submission order, so a test says "EXECUTE, EXECUTE, REFUSE, EXECUTE" and reads
 * back what the runtime did with that.
 */
function runtimeOver(
  definition: WorkflowDefinition,
  opts: {
    readonly decisions?: readonly string[];
    readonly facts?: WorkflowFacts;
    readonly throwOn?: ReadonlySet<number>;
  } = {},
): { readonly runtime: WorkflowRuntime; readonly submitted: string[] } {
  const submitted: string[] = [];
  const decisions = [...(opts.decisions ?? [])];
  let index = 0;
  const runtime = createWorkflowRuntime({
    workflows: [definition],
    ...(opts.facts === undefined ? {} : { projectFacts: async () => opts.facts as never }),
    adjudicateActivity: async (envelope) => {
      submitted.push(String(envelope.kind));
      const kind = decisions[index] ?? "EXECUTE";
      index += 1;
      return { kind } as never;
    },
    dispatchActivity: async () => {
      if (opts.throwOn?.has(index - 1) === true) throw new Error("executor blew up");
      return undefined;
    },
  });
  return { runtime, submitted };
}

/** Select an instance and run it, returning the trace. */
async function run(
  runtime: WorkflowRuntime,
  workflowId: string,
): Promise<NonNullable<Awaited<ReturnType<WorkflowRuntime["run"]>>>> {
  const instance = runtime.select({
    turnId: "turn_unit",
    workflowId,
    slots: {},
    allowedIntents: [ANCHOR],
  });
  if (instance === undefined) throw new Error("select returned no instance");
  const trace = await runtime.run({
    instanceId: instance.instanceId,
    turnId: "turn_unit_confirm",
    actor: ACTOR,
    ctx: {},
  });
  if (trace === undefined) throw new Error("run returned no trace");
  return trace;
}

/** The step list, flattened to what these tests reason about. */
function shape(trace: Awaited<ReturnType<typeof run>>) {
  return trace.steps.map((s) => `${s.role}:${s.activityId}:${s.executed}`);
}

describe("LE2-022 — the OUTCOME of a run that stopped part-way", () => {
  it("NOTHING executed ⇒ `failed`", async () => {
    // The v0 meaning, unchanged. Anything else here would tell a customer a
    // rollback happened over an empty run.
    const { runtime } = runtimeOver(workflow(), { decisions: ["REFUSE"] });
    const trace = await run(runtime, "workflow.unit.v1");

    expect(trace.run.outcome).toBe("failed");
    expect(trace.run.activitiesExecuted).toBe(0);
    expect(trace.run.compensationsExecuted).toBe(0);
    expect(trace.steps.filter((s) => s.role === "compensation")).toEqual([]);
  });

  it("everything that ran was UNDONE ⇒ `compensated`", async () => {
    const { runtime } = runtimeOver(workflow(), {
      // one EXECUTEs, two is refused, then the compensator for one EXECUTEs.
      decisions: ["EXECUTE", "REFUSE", "EXECUTE"],
    });
    const trace = await run(runtime, "workflow.unit.v1");

    expect(trace.run.outcome).toBe("compensated");
    expect(trace.run.failedActivityId).toBe("two");
    expect(trace.run.compensationsExecuted).toBe(1);
    expect(shape(trace)).toEqual([
      "activity:one:true",
      "activity:two:false",
      "compensation:undoOne:true",
    ]);
  });

  it("a compensator that did NOT execute ⇒ `stranded`, not `compensated`", async () => {
    // The sharpest case. The rollback was declared, was submitted, and the
    // kernel refused it — so the mutation is still there. Reporting
    // `compensated` would tell the customer they were put back exactly when they
    // were not, which is the same false-success shape as any other.
    const { runtime } = runtimeOver(workflow(), {
      decisions: ["EXECUTE", "REFUSE", "REFUSE"],
    });
    const trace = await run(runtime, "workflow.unit.v1");

    expect(trace.run.outcome).toBe("stranded");
    expect(trace.run.compensationsExecuted).toBe(0);
    expect(shape(trace)).toEqual([
      "activity:one:true",
      "activity:two:false",
      "compensation:undoOne:false",
    ]);
  });

  it("an executed IRREVERSIBLE step ⇒ `stranded`, even with nothing else to undo", async () => {
    const { runtime } = runtimeOver(
      workflow({ route: [{ activity: "three" }, { activity: "one" }] }),
      { decisions: ["EXECUTE", "REFUSE"] },
    );
    const trace = await run(runtime, "workflow.unit.v1");

    expect(trace.run.outcome).toBe("stranded");
    // Nothing was submitted as a rollback — there is none to submit, which is
    // exactly what `irreversible` declares.
    expect(trace.steps.filter((s) => s.role === "compensation")).toEqual([]);
  });

  it("only HARMLESS steps executed ⇒ `failed`, not `stranded`", async () => {
    // The other half of the two-valued terminal marker, and the reason it is two
    // valued: under a single boolean this run would tell a customer something
    // could not be undone, about a cart-ensure. That sentence frightens them
    // about nothing and teaches them to ignore the one that matters.
    const { runtime } = runtimeOver(
      workflow({ route: [{ activity: "undoOne" }, { activity: "one" }] }),
      { decisions: ["EXECUTE", "REFUSE"] },
    );
    const trace = await run(runtime, "workflow.unit.v1");

    expect(trace.run.outcome).toBe("failed");
    expect(trace.run.activitiesExecuted).toBe(1);
    expect(trace.run.compensationsExecuted).toBe(0);
  });

  it("STRANDED OUTRANKS COMPENSATED when a run produced both", async () => {
    // One un-undone mutation outranks any number of clean rollbacks, because it
    // is the half a human has to deal with.
    const { runtime } = runtimeOver(
      workflow({ route: [{ activity: "one" }, { activity: "three" }, { activity: "two" }] }),
      // one EXECUTEs, three (irreversible) EXECUTEs, two is refused, then the
      // rollback for `one` EXECUTEs.
      { decisions: ["EXECUTE", "EXECUTE", "REFUSE", "EXECUTE"] },
    );
    const trace = await run(runtime, "workflow.unit.v1");

    expect(trace.run.compensationsExecuted).toBe(1);
    expect(trace.run.outcome).toBe("stranded");
  });
});

describe("LE2-022 — compensation runs in REVERSE", () => {
  it("undoes the most recent step first", async () => {
    // Only observable with two compensated steps. Later steps were taken against
    // the state earlier steps produced, so undoing forwards would ask each
    // compensator to reverse a world that has already moved beneath it.
    const { runtime } = runtimeOver(
      workflow({ route: [{ activity: "one" }, { activity: "two" }, { activity: "three" }] }),
      { decisions: ["EXECUTE", "EXECUTE", "REFUSE", "EXECUTE", "EXECUTE"] },
    );
    const trace = await run(runtime, "workflow.unit.v1");

    expect(shape(trace)).toEqual([
      "activity:one:true",
      "activity:two:true",
      "activity:three:false",
      "compensation:undoTwo:true",
      "compensation:undoOne:true",
    ]);
    expect(trace.steps.map((s) => s.compensates)).toEqual([
      undefined,
      undefined,
      undefined,
      "two",
      "one",
    ]);
  });

  it("an executor that THROWS is not executed, and is compensated for", async () => {
    // The kernel said EXECUTE and the tool blew up. The mutation may or may not
    // have landed, so the honest treatment is the same as a refusal: stop, undo
    // what is known to have run, and never report the step as done.
    const { runtime } = runtimeOver(workflow(), {
      decisions: ["EXECUTE", "EXECUTE", "EXECUTE"],
      throwOn: new Set([1]),
    });
    const trace = await run(runtime, "workflow.unit.v1");

    expect(trace.steps[1]?.executed).toBe(false);
    expect(trace.steps[1]?.decision).toBe("EXECUTE");
    expect(trace.run.outcome).toBe("compensated");
  });
});

describe("LE2-022 — the conditional route", () => {
  it("plans BOTH arms from ONE fact projection, taken before anything runs", async () => {
    const facts = new Map<string, string | number | boolean>([["cartHasItems", true]]);
    const { runtime, submitted } = runtimeOver(
      workflow({
        route: [
          { when: { fact: "cartHasItems", op: "isTrue" }, then: ["one"], otherwise: ["two"] },
        ],
      }),
      { decisions: ["EXECUTE"], facts },
    );
    const trace = await run(runtime, "workflow.unit.v1");

    expect(trace.steps.map((s) => s.activityId)).toEqual(["one"]);
    expect(submitted).toHaveLength(1);
    expect(trace.run.branches).toEqual([
      {
        stepIndex: 0,
        predicate: "cartHasItems isTrue",
        held: true,
        taken: "then",
        activityIds: ["one"],
      },
    ]);
  });

  it("takes the `otherwise` arm when NO fact port is wired at all", async () => {
    // The fail-closed direction, and the shape a composition that forgot to wire
    // `projectFacts` actually has. Every predicate is false, so the conservative
    // arm runs — never the acting one, and never nothing at all.
    const { runtime } = runtimeOver(
      workflow({
        route: [
          { when: { fact: "cartHasItems", op: "isTrue" }, then: ["one"], otherwise: ["two"] },
        ],
      }),
      { decisions: ["EXECUTE"] },
    );
    const trace = await run(runtime, "workflow.unit.v1");

    expect(trace.steps.map((s) => s.activityId)).toEqual(["two"]);
    expect(trace.run.branches?.[0]?.taken).toBe("otherwise");
  });

  it("`activitiesTotal` is the RESOLVED PLAN, not the declared activity count", async () => {
    // A branchy workflow declares more activities than any single run can take,
    // and a compensator is not a step the run set out to do at all. "1 of 5"
    // would be unreadable; "1 of 1" is what this run planned.
    const { runtime } = runtimeOver(
      workflow({
        route: [
          { when: { fact: "cartHasItems", op: "isTrue" }, then: ["one"], otherwise: ["two"] },
        ],
      }),
      { decisions: ["EXECUTE"] },
    );
    const trace = await run(runtime, "workflow.unit.v1");

    expect(trace.run.activitiesTotal).toBe(1);
    expect(trace.run.activitiesExecuted).toBe(1);
    expect(trace.run.outcome).toBe("completed");
  });
});

describe("LE2-022 — the v0 path is unchanged", () => {
  it("a definition with NO route runs every non-compensator activity in order", async () => {
    // BACKWARD COMPATIBILITY, asserted rather than assumed. The implicit route is
    // what keeps every pre-LE2-022 definition legal exactly as authored, and if
    // it ever stopped excluding compensators, every workflow with a rollback
    // would run its rollback forwards on the happy path.
    const { runtime } = runtimeOver(workflow({ route: undefined }), {
      decisions: ["EXECUTE", "EXECUTE", "EXECUTE"],
    });
    const trace = await run(runtime, "workflow.unit.v1");

    expect(trace.steps.map((s) => s.activityId)).toEqual(["one", "two", "three"]);
    expect(trace.run.outcome).toBe("completed");
    expect(trace.run.activitiesTotal).toBe(3);
  });

  it("the AUTHORED linear fixture still runs exactly its two activities", async () => {
    // The real v0 corpus entry, over the v1 executor. Its params have to resolve
    // or the run fails closed before submitting anything — which would make this
    // assert the fail-closed path rather than the linear one.
    const runtime = createWorkflowRuntime({
      workflows: [FIXTURE_LINEAR_WORKFLOW],
      claimsFor: () =>
        new Map([["ORDER_HISTORY", { historySummaryText: "Pedido #1042" }]]) as never,
      adjudicateActivity: async () => ({ kind: "EXECUTE" }) as never,
      dispatchActivity: async () => undefined,
    });
    const instance = runtime.select({
      turnId: "turn_unit",
      workflowId: FIXTURE_LINEAR_WORKFLOW.id,
      slots: { note: "sem cebola", payment_method: "pix", delivery_type: "pickup" },
      allowedIntents: [ANCHOR],
    });
    expect(instance?.unresolved).toEqual([]);
    const trace = await runtime.run({
      instanceId: instance!.instanceId,
      turnId: "turn_unit_confirm",
      actor: ACTOR,
      ctx: {},
    });

    expect(trace?.steps.map((s) => s.activityId)).toEqual(["ensure", "reorder"]);
    expect(trace?.steps.every((s) => s.role === "activity")).toBe(true);
    expect(trace?.run.outcome).toBe("completed");
  });
});

describe("LE2-022 — feasibility pre-checks", () => {
  const gated = () =>
    workflow({
      prechecks: [
        {
          id: "needs-cart",
          predicate: { fact: "cartHasItems", op: "isTrue" },
          template: "infeasible",
        },
      ],
      templates: [
        ...FIXTURE_LINEAR_WORKFLOW.templates,
        { id: "infeasible", text: "Seu carrinho está vazio." },
      ],
    });

  it("refuses with the pre-check's OWN template when the predicate does not hold", async () => {
    const { runtime, submitted } = runtimeOver(gated(), {
      facts: new Map([["cartHasItems", false]]),
    });
    runtime.select({
      turnId: "turn_unit",
      workflowId: "workflow.unit.v1",
      slots: {},
      allowedIntents: [ANCHOR],
    });

    const verdict = await runtime.checkFeasibility({ turnId: "turn_unit", actor: ACTOR });

    expect(verdict?.precheckId).toBe("needs-cart");
    expect(verdict?.reason).toBe("Seu carrinho está vazio.");
    expect(runtime.renderNotice("turn_unit")).toBe("Seu carrinho está vazio.");
    // NOTHING was submitted — the point of a pre-check is that the kernel never
    // sees an envelope for a workflow that cannot happen.
    expect(submitted).toEqual([]);
  });

  it("is SILENT when the predicate holds — the directional control", async () => {
    const { runtime } = runtimeOver(gated(), {
      facts: new Map([["cartHasItems", true]]),
    });
    runtime.select({
      turnId: "turn_unit",
      workflowId: "workflow.unit.v1",
      slots: {},
      allowedIntents: [ANCHOR],
    });

    expect(
      await runtime.checkFeasibility({ turnId: "turn_unit", actor: ACTOR }),
    ).toBeUndefined();
    expect(runtime.renderNotice("turn_unit")).toBeUndefined();
  });

  it("refuses on the FIRST failing pre-check and evaluates no further", async () => {
    // A customer can act on one specific reason; a list of everything wrong with
    // their account reads as a refusal either way, and the authored order is the
    // author's statement of which reason matters most.
    const { runtime } = runtimeOver(
      workflow({
        prechecks: [
          {
            id: "first",
            predicate: { fact: "cartHasItems", op: "isTrue" },
            template: "infeasible",
          },
          {
            id: "second",
            predicate: { fact: "customerIsAuthenticated", op: "isTrue" },
            template: "infeasible",
          },
        ],
        templates: [
          ...FIXTURE_LINEAR_WORKFLOW.templates,
          { id: "infeasible", text: "Não dá." },
        ],
      }),
      { facts: new Map() },
    );
    runtime.select({
      turnId: "turn_unit",
      workflowId: "workflow.unit.v1",
      slots: {},
      allowedIntents: [ANCHOR],
    });

    expect(
      (await runtime.checkFeasibility({ turnId: "turn_unit", actor: ACTOR }))?.precheckId,
    ).toBe("first");
  });

  it("is undefined for a workflow that declares NO pre-check", async () => {
    const { runtime } = runtimeOver(workflow());
    runtime.select({
      turnId: "turn_unit",
      workflowId: "workflow.unit.v1",
      slots: {},
      allowedIntents: [ANCHOR],
    });
    expect(
      await runtime.checkFeasibility({ turnId: "turn_unit", actor: ACTOR }),
    ).toBeUndefined();
  });
});
