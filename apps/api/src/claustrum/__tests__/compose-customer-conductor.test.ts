// R1-S1 — the CUSTOMER composition pin, at unit cost.
//
// Every fact asserted here used to be reachable only by booting the real
// bootstrapClaustrum on testcontainers (a Postgres, a Redis, a model provider), which
// is why the e2e harness hand-copied the composition instead of calling it — and why
// the copy drifted. `composeCustomerConductor` takes its ingredients as deps, so this
// suite composes the REAL customer plane over plain objects: no infra, no network, no
// turn, no model call.
//
// Technique: spy `createIbatexasPlanner`, `createIbatexasResponder` and
// `createConductor` and read what the real composition handed each of them (the
// ops-claims-convergence.test.ts idiom). Everything else — the workflow decision
// observer, the turn binding, the customer action render — stays REAL, because those
// are the links under test.

import { describe, expect, it, vi } from "vitest";
import type { Adjudicator, ModelProvider, ResponderPort } from "@claustrum/core";
import type { Decision } from "@adjudicate/core";
import {
  composeCustomerConductor,
  type CustomerConductorDeps,
  type CustomerFunnelSeam,
} from "../compose-customer-conductor.js";
import { renderCustomerActionAnswer } from "../customer-action-render.js";
import type { ClaimsSeams } from "../claims-pipeline.js";
import type { SafeUnknownGate } from "../safe-unknown-gate.js";
import type { WorkflowRuntime } from "../workflow/workflow-runtime.js";
import { beginWorkflowTurn } from "../workflow/workflow-turn.js";

// vi.mock is hoisted above the imports; the spies are defined via vi.hoisted so the
// factories can reference them (the BKL-101 idiom).
const { createIbatexasPlannerSpy, createIbatexasResponderSpy, createConductorSpy } =
  vi.hoisted(() => ({
    // A FRESH object per call — the identity assertions (which planner instance the
    // claims seams wrap) are only meaningful if two builds are distinguishable.
    createIbatexasPlannerSpy: vi.fn((_deps: Record<string, unknown>) => ({
      propose: async () => ({ envelopes: [] }),
      proposeClaims: async () => ({ candidates: [] }),
    })),
    createIbatexasResponderSpy: vi.fn((_deps: Record<string, unknown>) => ({
      respond: async () => ({ text: "" }),
    })),
    createConductorSpy: vi.fn((_opts: Record<string, unknown>) => ({
      openCapsule: async () => ({}),
      closeCapsule: async () => {},
    })),
  }));

vi.mock("../ibatexas-planner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ibatexas-planner.js")>();
  return { ...actual, createIbatexasPlanner: createIbatexasPlannerSpy };
});

vi.mock("../ibatexas-responder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ibatexas-responder.js")>();
  return { ...actual, createIbatexasResponder: createIbatexasResponderSpy };
});

// createConductor-spy: keep every other `@claustrum/core` export REAL, so the composed
// `ConductorOptions` can be inspected.
vi.mock("@claustrum/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claustrum/core")>();
  return { ...actual, createConductor: createConductorSpy };
});

const MODEL = {} as unknown as ModelProvider;

/** A committed amend dispatch — the one input the customer action render answers. */
const COMMITTED_AMEND = {
  kind: "executed",
  envelope: {
    kind: "order.amend.add_item",
    payload: { orderId: "o1", variantId: "v1", quantity: 1, allergens: [] },
  },
  result: { ok: true },
};

/**
 * A funnel double. The composition reads exactly one field off it (`lookupParse`,
 * the L1 presence probe) and otherwise passes the INSTANCE around, which is the
 * property under test — so a structural stand-in is enough and an identity-bearing
 * one is required.
 */
function funnelDouble(opts: { readonly withL1: boolean }): CustomerFunnelSeam {
  const base: Record<string, unknown> = {
    decide: () => undefined,
    stageFor: () => undefined,
    reply: () => undefined,
  };
  if (opts.withL1) {
    base["lookupParse"] = async () => undefined;
    base["storeParse"] = async () => {};
  }
  return base as unknown as CustomerFunnelSeam;
}

interface Doubles {
  readonly rawAdjudicator: Adjudicator;
  readonly rawDecision: Decision;
  readonly workflowRuntime: WorkflowRuntime;
  readonly recordSelectionDecision: ReturnType<typeof vi.fn>;
  readonly innerAdjudicate: ReturnType<typeof vi.fn>;
  readonly funnel: CustomerFunnelSeam;
  readonly claimsSeamsFor: ReturnType<typeof vi.fn>;
  readonly safeUnknownGateFor: ReturnType<typeof vi.fn>;
  readonly claimsSeams: ClaimsSeams;
}

interface Composed {
  readonly plannerDeps: Record<string, unknown>;
  /**
   * What the PRODUCTION responder factory was handed. Present on every path except a
   * `responderOverride` compose, which builds no production responder at all — read
   * {@link Composed.productionResponderBuilt} rather than this when the override is in
   * play (that is what the override cases below assert on).
   */
  readonly responderDeps: Record<string, unknown>;
  /** Did the composition construct a production responder? False iff an override
   *  replaced it before construction. */
  readonly productionResponderBuilt: boolean;
  readonly conductorOptions: Record<string, unknown>;
  readonly result: ReturnType<typeof composeCustomerConductor>;
  readonly doubles: Doubles;
}

/**
 * Compose the REAL customer plane over doubles and return what each factory was
 * handed.
 */
function composed(
  opts: {
    readonly withL1?: boolean;
    readonly safeUnknown?: SafeUnknownGate;
    readonly capabilityRetriever?: CustomerConductorDeps["capabilityRetriever"];
    readonly responderOverride?: ResponderPort;
  } = {},
): Composed {
  createIbatexasPlannerSpy.mockClear();
  createIbatexasResponderSpy.mockClear();
  createConductorSpy.mockClear();

  const rawDecision = { verdict: "EXECUTE" } as unknown as Decision;
  const innerAdjudicate = vi.fn(async () => rawDecision);
  const rawAdjudicator = {
    adjudicate: innerAdjudicate,
    adjudicatePlan: vi.fn(async () => rawDecision),
  } as unknown as Adjudicator;

  const recordSelectionDecision = vi.fn();
  const workflowRuntime = {
    recordSelectionDecision,
    renderConfirm: () => undefined,
    renderNotice: () => undefined,
  } as unknown as WorkflowRuntime;

  const funnel = funnelDouble({ withL1: opts.withL1 === true });
  // A sentinel seam so "the return is spread into the conductor deps" is observable.
  const claimsSeams = {
    investigator: { investigate: async () => ({}) },
  } as unknown as ClaimsSeams;
  const claimsSeamsFor = vi.fn(() => claimsSeams);
  const safeUnknownGateFor = vi.fn(() => opts.safeUnknown);

  const deps: CustomerConductorDeps = {
    adjudicator: rawAdjudicator,
    workflowRuntime,
    model: MODEL,
    chatModelId: "test-model",
    memory: {} as CustomerConductorDeps["memory"],
    grounding: {} as CustomerConductorDeps["grounding"],
    channels: [],
    telemetry: {} as CustomerConductorDeps["telemetry"],
    session: {} as CustomerConductorDeps["session"],
    tools: {} as CustomerConductorDeps["tools"],
    tenantResolver: {} as CustomerConductorDeps["tenantResolver"],
    resolver: {} as CustomerConductorDeps["resolver"],
    sessionLock: {} as CustomerConductorDeps["sessionLock"],
    handoff: {} as CustomerConductorDeps["handoff"],
    promptComposer: {} as CustomerConductorDeps["promptComposer"],
    explainer: {} as CustomerConductorDeps["explainer"],
    resolveScheduleSignal: () => undefined,
    funnel,
    capabilityRetriever: opts.capabilityRetriever,
    readToolExecutors: {},
    claimsSeamsFor,
    safeUnknownGateFor,
    ...(opts.responderOverride === undefined
      ? {}
      : { responderOverride: opts.responderOverride }),
  };

  const result = composeCustomerConductor(deps);
  return {
    plannerDeps: createIbatexasPlannerSpy.mock.calls[0]![0],
    // `?.` not `!`: an override compose legitimately never calls this factory. See
    // Composed.responderDeps.
    responderDeps: createIbatexasResponderSpy.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >,
    productionResponderBuilt: createIbatexasResponderSpy.mock.calls.length > 0,
    conductorOptions: createConductorSpy.mock.calls[0]![0],
    result,
    doubles: {
      rawAdjudicator,
      rawDecision,
      workflowRuntime,
      recordSelectionDecision,
      innerAdjudicate,
      funnel,
      claimsSeamsFor,
      safeUnknownGateFor,
      claimsSeams,
    },
  };
}

describe("composeCustomerConductor — the customer action render (BKL-215/BKL-230)", () => {
  it("wires readAnswer UNCONDITIONALLY, in both safe-unknown states", () => {
    for (const gate of [
      undefined,
      { gate: () => true, render: () => "safe" } satisfies SafeUnknownGate,
    ]) {
      const { responderDeps } = composed({ safeUnknown: gate });
      expect(responderDeps).toHaveProperty("readAnswer");
    }
  });

  it("readAnswer.renderAction delegates to the real renderCustomerActionAnswer", () => {
    const { responderDeps } = composed();
    const readAnswer = responderDeps["readAnswer"] as {
      render(turnId: string): string | undefined;
      renderAction(acted: unknown, turnId: string): string | undefined;
    };

    // Anti-vacuity FIRST: this input must produce a real pt-BR line, otherwise the
    // equality below would be satisfied by two undefineds.
    const expected = renderCustomerActionAnswer(COMMITTED_AMEND);
    expect(expected).toBeTypeOf("string");
    expect(expected).not.toMatch(/erro|falh|não consegu/i);

    expect(readAnswer.renderAction(COMMITTED_AMEND, "turn-1")).toBe(expected);
    // The customer READ half is deliberately empty (customer reads flow through the
    // claims pipeline, not this port).
    expect(readAnswer.render("turn-1")).toBeUndefined();
  });
});

describe("composeCustomerConductor — the safe-unknown gate (BKL-078)", () => {
  it("omits safeUnknown when the factory declines", () => {
    const { responderDeps } = composed();
    expect(responderDeps).not.toHaveProperty("safeUnknown");
  });

  it("passes the gate the factory returned", () => {
    const gate: SafeUnknownGate = { gate: () => true, render: () => "safe" };
    const { responderDeps } = composed({ safeUnknown: gate });
    expect(responderDeps["safeUnknown"]).toBe(gate);
  });

  it("invokes the factory ONCE PER responder construction, not once per compose", () => {
    const { result, doubles } = composed();
    expect(doubles.safeUnknownGateFor).toHaveBeenCalledTimes(1);
    // The returned factory is what the managed-agent plane rebuilds responders with;
    // each rebuild must re-ask, exactly as the inline flag-read spread did.
    result.buildResponder(MODEL);
    expect(doubles.safeUnknownGateFor).toHaveBeenCalledTimes(2);
  });
});

describe("composeCustomerConductor — ONE funnel instance (LE2-007/008/009/025b)", () => {
  it("hands the SAME funnel object to the planner and the responder", () => {
    const { plannerDeps, responderDeps, doubles } = composed();
    expect(plannerDeps["funnel"]).toBe(doubles.funnel);
    expect(responderDeps["funnel"]).toBe(doubles.funnel);
    // The alias tier is the same instance too, and unconditional.
    expect(plannerDeps["aliasSeam"]).toBe(doubles.funnel);
  });

  it("omits parseMemo when the funnel carries no L1 lookup", () => {
    const { plannerDeps } = composed({ withL1: false });
    expect(plannerDeps).not.toHaveProperty("parseMemo");
  });

  it("passes the SAME instance as parseMemo when the funnel carries L1", () => {
    const { plannerDeps, doubles } = composed({ withL1: true });
    expect(plannerDeps["parseMemo"]).toBe(doubles.funnel);
  });

  it("wires the L2 retriever + scope seam only when a retriever is supplied", () => {
    const bare = composed();
    expect(bare.plannerDeps).not.toHaveProperty("retriever");
    expect(bare.plannerDeps).not.toHaveProperty("scopeSeam");

    const retriever = {
      scopeFor: async () => ({ scoped: false }),
    } as unknown as NonNullable<CustomerConductorDeps["capabilityRetriever"]>;
    const withL2 = composed({ capabilityRetriever: retriever });
    expect(withL2.plannerDeps["retriever"]).toBe(retriever);
    expect(withL2.plannerDeps["scopeSeam"]).toBe(withL2.doubles.funnel);
  });
});

describe("composeCustomerConductor — the claims seams wrap the conductor's planner (Q6b)", () => {
  it("invokes claimsSeamsFor with the SAME planner instance the conductor got", () => {
    const { conductorOptions, doubles } = composed();
    expect(doubles.claimsSeamsFor).toHaveBeenCalledTimes(1);
    const wrapped = doubles.claimsSeamsFor.mock.calls[0]![0];
    expect(wrapped).toBe(conductorOptions["planner"]);
    // Not merely equal-shaped: the planner spy mints a fresh object per call, so a
    // composition that rebuilt the planner for the seams would fail here.
    expect(createIbatexasPlannerSpy).toHaveBeenCalledTimes(1);
  });

  it("spreads the seams it returned into the conductor options", () => {
    const { conductorOptions, doubles } = composed();
    expect(conductorOptions["investigator"]).toBe(
      (doubles.claimsSeams as { investigator: unknown }).investigator,
    );
  });
});

describe("composeCustomerConductor — the workflow decision observer (LE2-021)", () => {
  it("hands the conductor the OBSERVER WRAPPER, never the raw adjudicator dep", () => {
    const { conductorOptions, doubles } = composed();
    expect(conductorOptions["adjudicator"]).not.toBe(doubles.rawAdjudicator);
  });

  it("the wrapper delegates to the raw adjudicator AND records the turn's decision", async () => {
    const { conductorOptions, doubles } = composed();
    const adjudicator = conductorOptions["adjudicator"] as Adjudicator;

    const decision = await beginWorkflowTurn(
      { turnId: "turn-obs-1", channel: "web" },
      async () =>
        adjudicator.adjudicate(
          {} as Parameters<Adjudicator["adjudicate"]>[0],
          {} as Parameters<Adjudicator["adjudicate"]>[1],
          {} as Parameters<Adjudicator["adjudicate"]>[2],
        ),
    );

    // Delegation: the inner port decided, and its decision came back unchanged.
    expect(doubles.innerAdjudicate).toHaveBeenCalledTimes(1);
    expect(decision).toBe(doubles.rawDecision);
    // Observation: the runtime saw it, keyed by the bound turn.
    expect(doubles.recordSelectionDecision).toHaveBeenCalledWith(
      "turn-obs-1",
      doubles.rawDecision,
    );
  });
});

describe("composeCustomerConductor — the responder override (R1-S2)", () => {
  /** A distinguishable inert responder — identity is the whole assertion. */
  const override: ResponderPort = { respond: async () => ({ text: "override" }) };

  it("hands the conductor the OVERRIDE ITSELF, and builds no production responder", () => {
    const { conductorOptions, productionResponderBuilt, doubles } = composed({
      responderOverride: override,
    });
    expect(conductorOptions["responder"]).toBe(override);
    // The short-circuit is part of the contract: no production responder is
    // constructed, so the per-construction safe-unknown factory is not invoked either.
    expect(productionResponderBuilt).toBe(false);
    expect(doubles.safeUnknownGateFor).not.toHaveBeenCalled();
  });

  it("keeps the PRODUCTION-built responder when no override is supplied", () => {
    const { conductorOptions, productionResponderBuilt } = composed();
    expect(productionResponderBuilt).toBe(true);
    // Anti-vacuity: the previous case's sentinel must not be what production returns,
    // or `toBe(override)` above would hold for the wrong reason.
    expect(conductorOptions["responder"]).not.toBe(override);
    expect(conductorOptions["responder"]).toBe(
      createIbatexasResponderSpy.mock.results[0]!.value,
    );
  });

  it("returns a PRODUCTION-shaped buildResponder in BOTH states", () => {
    for (const responderOverride of [undefined, override]) {
      const { result } = composed({ responderOverride });
      const before = createIbatexasResponderSpy.mock.calls.length;
      const built = result.buildResponder(MODEL);
      // It went through the production factory (not the override), and it is that
      // factory's product — so the managed-agent plane's H1 recomposition path is
      // unaffected by the divergence.
      expect(createIbatexasResponderSpy.mock.calls.length).toBe(before + 1);
      expect(built).not.toBe(override);
      const deps = createIbatexasResponderSpy.mock.calls[before]![0];
      expect(deps["modelId"]).toBe("test-model");
      expect(deps).toHaveProperty("readAnswer");
    }
  });
});

describe("composeCustomerConductor — the returned factories", () => {
  it("returns the conductor the factory built plus both port factories", () => {
    const { result } = composed();
    expect(result.conductor).toBe(createConductorSpy.mock.results[0]!.value);
    expect(result.buildPlanner).toBeTypeOf("function");
    expect(result.buildResponder).toBeTypeOf("function");
  });

  it("buildPlanner rebuilds over the model it is given (the managed-agent plane's H1 path)", () => {
    const { result } = composed();
    const cappedModel = {} as unknown as ModelProvider;
    result.buildPlanner(cappedModel);
    const rebuilt = createIbatexasPlannerSpy.mock.calls[1]![0];
    expect(rebuilt["model"]).toBe(cappedModel);
    // Same everything else — the ONLY divergence between the planes is the model.
    expect(rebuilt["modelId"]).toBe("test-model");
  });
});
