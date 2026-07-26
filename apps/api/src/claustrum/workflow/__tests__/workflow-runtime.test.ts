// Unit tests for the workflow runtime's pure halves (LE2-020).
//
// The e2e (`apps/api/src/__tests__/workflow-runtime.e2e.test.ts`) proves the
// feature is alive through the real gate. This file proves the properties that
// are hard to reach from a turn: the closed-surface arithmetic, the two-source
// param rule and its fail-closed direction, and — the one the ticket calls out
// explicitly — that the advertised workflow surface is inside the L1 parse
// cache key.

import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@ibatexas/catalog";
import { CATALOG_VERSION, FIXTURE_LINEAR_WORKFLOW } from "@ibatexas/catalog";
import { buildParseCacheKey } from "../../parse-memo.js";
import {
  WORKFLOW_SCOPED_KINDS,
  isWorkflowScopedKind,
  withoutWorkflowScopedKinds,
} from "../workflow-access.js";
import {
  buildActivityPayload,
  renderWorkflowTemplate,
  resolveWorkflowParams,
} from "../workflow-params.js";
import { createWorkflowRuntime } from "../workflow-runtime.js";
import {
  sanitizeWorkflowSlots,
  START_WORKFLOW_TOOL,
  startWorkflowToolDefinition,
} from "../workflow-surface.js";

const ANCHOR = "order.checkout.create";

function runtimeOver(workflows: readonly WorkflowDefinition[] = [FIXTURE_LINEAR_WORKFLOW]) {
  return createWorkflowRuntime({
    workflows,
    adjudicateActivity: async () => ({ kind: "REFUSE" }) as never,
    dispatchActivity: async () => undefined,
  });
}

describe("the workflow-scoped access class", () => {
  it("projects `order.reorder` out of the catalog", () => {
    expect([...WORKFLOW_SCOPED_KINDS]).toEqual(["order.reorder"]);
    expect(isWorkflowScopedKind("order.reorder")).toBe(true);
    expect(isWorkflowScopedKind("order.checkout.create")).toBe(false);
  });

  it("subtracts the class from an authorized roster", () => {
    expect(withoutWorkflowScopedKinds(["order.reorder", ANCHOR])).toEqual([ANCHOR]);
  });

  it("returns the SAME array reference when nothing is subtracted", () => {
    // The byte-identical guarantee for every composition that never touches a
    // workflow-scoped kind — asserted on identity, not on equality, so a future
    // refactor that starts copying gets caught.
    const roster = [ANCHOR, "order.item.add"];
    expect(withoutWorkflowScopedKinds(roster)).toBe(roster);
  });
});

describe("the closed workflow surface", () => {
  it("offers a workflow only when EVERY matcher holds", () => {
    const runtime = runtimeOver();
    expect(runtime.advertise([ANCHOR]).map((w) => w.id)).toEqual([
      FIXTURE_LINEAR_WORKFLOW.id,
    ]);
    // The matcher's capability is absent from the roster ⟹ not offered.
    expect(runtime.advertise(["order.item.add"])).toEqual([]);
    expect(runtime.advertise([])).toEqual([]);
  });

  it("advertises only the DECLARED slot names", () => {
    const [offered] = runtimeOver().advertise([ANCHOR]);
    expect(offered?.slots).toEqual(["delivery_type", "note", "payment_method"]);
  });

  it("builds no tool at all when nothing is offered — the wire stays pre-LE2-020", () => {
    expect(startWorkflowToolDefinition([])).toBeUndefined();
  });

  it("puts the offered ids in a CLOSED enum", () => {
    const tool = startWorkflowToolDefinition(runtimeOver().advertise([ANCHOR]));
    expect(tool?.name).toBe(START_WORKFLOW_TOOL);
    const schema = tool?.inputSchema as {
      properties: { workflow: { enum: readonly string[] } };
    };
    expect(schema.properties.workflow.enum).toEqual([FIXTURE_LINEAR_WORKFLOW.id]);
  });

  it("refuses to instantiate a workflow this turn did not offer", () => {
    const runtime = runtimeOver();
    // The id is real, but the turn's roster does not satisfy its matcher.
    expect(
      runtime.select({
        turnId: "t1",
        workflowId: FIXTURE_LINEAR_WORKFLOW.id,
        slots: {},
        allowedIntents: [],
      }),
    ).toBeUndefined();
  });

  it("strips slots the workflow never declared, by NAME", () => {
    const { slots, dropped } = sanitizeWorkflowSlots(
      { note: "sem cebola", orderId: "order_INVENTED", nested: { a: 1 } },
      new Set(["note"]),
    );
    expect(slots).toEqual({ note: "sem cebola" });
    expect([...dropped].sort()).toEqual(["nested", "orderId"]);
  });
});

describe("the L1 parse cache key (AC 7 — cache the parse, never instance state)", () => {
  const base = {
    utterance: "quero repetir meu último pedido",
    modelId: "mock-model",
    system: "system prompt",
    surfaceVersion: "v1",
  };
  const expressIntent = {
    name: "express_intent",
    description: "d",
    inputSchema: { type: "object" },
  };

  it("DIGESTS the advertised workflow surface — a parse made with a workflow offered cannot be replayed onto a turn without one", () => {
    const workflowTool = startWorkflowToolDefinition(runtimeOver().advertise([ANCHOR]));
    const without = buildParseCacheKey({ ...base, toolSurface: [expressIntent] });
    const with_ = buildParseCacheKey({
      ...base,
      toolSurface: [expressIntent, workflowTool as never],
    });
    expect(with_.digest).not.toBe(without.digest);
    expect(with_.key).not.toBe(without.key);
  });

  it("distinguishes two DIFFERENT offered workflow sets", () => {
    const one = startWorkflowToolDefinition([
      { id: "workflow.a", title: "A", description: "a", slots: [] },
    ]);
    const two = startWorkflowToolDefinition([
      { id: "workflow.b", title: "B", description: "b", slots: [] },
    ]);
    expect(
      buildParseCacheKey({ ...base, toolSurface: [one as never] }).digest,
    ).not.toBe(buildParseCacheKey({ ...base, toolSurface: [two as never] }).digest);
  });
});

describe("param resolution — two sources, and no third", () => {
  it("resolves a customer-authored slot and a validated claim", () => {
    const { params, unresolved } = resolveWorkflowParams(FIXTURE_LINEAR_WORKFLOW, {
      claims: new Map([["order-placed", { orderId: "order_123" }]]),
      slots: { note: "sem cebola", payment_method: "pix", delivery_type: "pickup" },
    });
    expect(unresolved).toEqual([]);
    expect(params.get("note")).toEqual({ resolved: true, value: "sem cebola" });
    expect(params.get("previousOrderId")).toEqual({ resolved: true, value: "order_123" });
  });

  it("leaves a claim-sourced param UNRESOLVED when no claim validated — never a guess", () => {
    const { params, unresolved } = resolveWorkflowParams(FIXTURE_LINEAR_WORKFLOW, {
      slots: { note: "x", payment_method: "pix", delivery_type: "pickup" },
    });
    expect(unresolved).toEqual(["previousOrderId"]);
    expect(params.get("previousOrderId")).toEqual({
      resolved: false,
      reason: 'no VALIDATED claim of type "order-placed" this turn',
    });
  });

  it("leaves a claim-sourced param UNRESOLVED when the claim carries no such field", () => {
    const { unresolved } = resolveWorkflowParams(FIXTURE_LINEAR_WORKFLOW, {
      claims: new Map([["order-placed", { somethingElse: "x" }]]),
      slots: {},
    });
    expect(unresolved).toContain("previousOrderId");
  });

  it("refuses to build a payload with a hole in it", () => {
    const resolved = new Map([
      ["known", { resolved: true as const, value: "v" }],
      ["missing", { resolved: false as const, reason: "unresolved" }],
    ]);
    expect(buildActivityPayload({ a: { param: "known" } }, resolved)).toEqual({ a: "v" });
    // A PARTIAL payload is the dangerous shape — some guards would read the
    // fields that are present and the mutation would land anyway.
    expect(
      buildActivityPayload({ a: { param: "known" }, b: { param: "missing" } }, resolved),
    ).toBeUndefined();
  });

  it("fills templates from resolved values and leaves an unknown placeholder verbatim", () => {
    const values = new Map([["note", "sem cebola"]]);
    expect(renderWorkflowTemplate("Obs: {note}", values)).toBe("Obs: sem cebola");
    // A literal `{typo}` in a dev render is how an authoring slip gets noticed.
    expect(renderWorkflowTemplate("Obs: {typo}", values)).toBe("Obs: {typo}");
  });
});

describe("the instance and its catalog pin", () => {
  it("pins CATALOG_VERSION at instantiation and exposes it by id", () => {
    const runtime = runtimeOver();
    const instance = runtime.select({
      turnId: "t1",
      workflowId: FIXTURE_LINEAR_WORKFLOW.id,
      slots: { note: "x", payment_method: "pix", delivery_type: "pickup" },
      allowedIntents: [ANCHOR],
    });
    expect(instance?.catalogVersion).toBe(CATALOG_VERSION);
    // The id, not the turn id, is what survives a park.
    expect(runtime.instanceById(instance!.instanceId)).toBe(instance);
    expect(runtime.instanceFor("t1")).toBe(instance);
  });

  it("stops the sequence at the first activity the kernel does not EXECUTE", async () => {
    const adjudicated: string[] = [];
    const runtime = createWorkflowRuntime({
      workflows: [FIXTURE_LINEAR_WORKFLOW],
      adjudicateActivity: async (envelope) => {
        adjudicated.push(String(envelope.kind));
        return { kind: "REFUSE", basis: [{ code: "order.default.deny" }] } as never;
      },
      dispatchActivity: async () => {
        throw new Error("must never dispatch a non-EXECUTE activity");
      },
      claimsFor: () => new Map([["order-placed", { orderId: "order_123" }]]),
    });
    const instance = runtime.select({
      turnId: "t1",
      workflowId: FIXTURE_LINEAR_WORKFLOW.id,
      slots: { note: "x", payment_method: "pix", delivery_type: "pickup" },
      allowedIntents: [ANCHOR],
    })!;

    const trace = await runtime.run({
      instanceId: instance.instanceId,
      turnId: "t2",
      actor: { principal: "llm", sessionId: "s" },
      ctx: {},
    });

    // v0 is linear with no compensators, so continuing past a refusal would
    // leave a partial result nobody can undo.
    expect(adjudicated).toEqual(["order.cart.ensure"]);
    expect(trace?.run.outcome).toBe("failed");
    expect(trace?.run.failedActivityId).toBe("ensure");
    expect(trace?.run.activitiesExecuted).toBe(0);
    // The basis code is what makes two same-kind refusals distinguishable in a
    // "top failure" aggregation.
    expect(trace?.steps[0]?.basisCode).toBe("order.default.deny");
  });

  it("renders every outcome from the AUTHORED template", () => {
    const runtime = runtimeOver();
    const instance = runtime.select({
      turnId: "t1",
      workflowId: FIXTURE_LINEAR_WORKFLOW.id,
      slots: { note: "x", payment_method: "pix", delivery_type: "pickup" },
      allowedIntents: [ANCHOR],
    })!;
    expect(runtime.renderOutcome(instance, "completed")).toBe(
      "Pronto! Concluí todas as etapas do seu pedido.",
    );
    expect(runtime.renderOutcome(instance, "declined")).toBe(
      "Tudo bem, não fiz nada. É só me chamar quando quiser.",
    );
    expect(runtime.renderOutcome(instance, "failed")).toBe(
      "Não consegui concluir todas as etapas. Já chamei alguém da equipe para te ajudar.",
    );
  });
});
