/**
 * LE2-021 — the COMPOSITION ORDER that installs the workflow runtime.
 *
 * `claustrum-bootstrap.ts` now composes the runtime, and its ordering comment
 * says the sequence IS the installation mechanism. That sentence is only worth
 * writing if getting it wrong is detectable, so this file measures the wrong
 * order rather than asserting the right one twice.
 *
 * The dangerous inversion is `installWorkflowRuntime` BEFORE
 * `registerIbatexasToolPacks`: the registry is last-write-wins per capability,
 * so the base roster silently overwrites the anchor wrapper. Nothing throws,
 * boot succeeds, the workflow is still advertised, the customer still confirms —
 * and then not one activity runs. A silent, confirm-shaped no-op is the worst
 * failure this composition can have, and it is invisible to every test that
 * only checks the right order.
 */

import { describe, expect, it } from "vitest";
import { createToolRegistry } from "@claustrum/core";
import type { ToolDefinition } from "@claustrum/core";
import type { CapabilityId, IntentKind } from "@claustrum/core";
import { FIXTURE_WORKFLOWS, FIXTURE_WORKFLOW_ID } from "@ibatexas/catalog";
import { createWorkflowRuntime, type WorkflowRuntime } from "../workflow-runtime.js";
import { installWorkflowRuntime } from "../workflow-install.js";
import { WORKFLOW_INSTANCE_PAYLOAD_KEY } from "../workflow-surface.js";

const ANCHOR = "order.checkout.create";

/** A stand-in for the pack-registered anchor tool the base roster installs. */
function baseAnchorTool(marker: string): ToolDefinition<unknown, unknown> {
  return {
    id: `ibatexas.checkout.create.${marker}`,
    capability: ANCHOR as CapabilityId,
    intentKind: ANCHOR as IntentKind,
    description: "Criar checkout.",
    inputSchema: {},
    outputSchema: {},
    riskLevel: "medium",
    execute: async () => ({ anchor: marker }),
  } satisfies ToolDefinition<unknown, unknown>;
}

/** The activity handlers the fixture corpus invokes. */
function activityTools(): ReadonlyArray<ToolDefinition<unknown, unknown>> {
  return ["order.cart.ensure", "order.reorder"].map((kind) => ({
    id: `stub.${kind}`,
    capability: kind as CapabilityId,
    intentKind: kind as IntentKind,
    description: kind,
    inputSchema: {},
    outputSchema: {},
    riskLevel: "low",
    execute: async () => ({ ok: true }),
  }));
}

function runtimeWithRecordedActivities(): {
  readonly runtime: WorkflowRuntime;
  readonly adjudicated: string[];
} {
  const adjudicated: string[] = [];
  const runtime = createWorkflowRuntime({
    workflows: FIXTURE_WORKFLOWS,
    adjudicateActivity: async (envelope) => {
      adjudicated.push(String(envelope.kind));
      return { kind: "EXECUTE" } as never;
    },
    dispatchActivity: async () => ({ ok: true }),
    claimsFor: () =>
      new Map([["order-placed", { orderId: "order_prev" }]]) as never,
  });
  return { runtime, adjudicated };
}

/** Select the fixture workflow and return its instance id. */
function selectInstance(runtime: WorkflowRuntime): string {
  const instance = runtime.select({
    turnId: "turn_order",
    workflowId: FIXTURE_WORKFLOW_ID,
    slots: {
      note: "sem cebola",
      payment_method: "pix",
      delivery_type: "pickup",
    },
    allowedIntents: [ANCHOR],
  });
  if (instance === undefined) throw new Error("fixture failed to instantiate");
  return instance.instanceId;
}

/**
 * Run whatever tool the registry resolves for the anchor.
 *
 * `resolveTool`, deliberately — that is the question the conductor's own
 * `dispatchDecision` asks, and it is last-write-wins. A `list().find(...)`
 * here would take the FIRST registration instead and would report the base
 * tool as the winner in BOTH orders, making the whole file vacuous.
 */
async function dispatchAnchor(
  tools: ReturnType<typeof createToolRegistry>,
  instanceId: string,
): Promise<unknown> {
  const ctx = {
    turnId: "turn_confirm",
    actor: { principal: "llm", role: "customer" },
  };
  const tool = tools.resolveTool(ANCHOR as CapabilityId, ctx);
  return tool.execute({ [WORKFLOW_INSTANCE_PAYLOAD_KEY]: instanceId }, ctx);
}

describe("LE2-021 — installWorkflowRuntime AFTER the base roster is load-bearing", () => {
  it("RIGHT ORDER — base roster, then install ⇒ the activities run", async () => {
    const tools = createToolRegistry();
    for (const tool of activityTools()) tools.register(tool);
    tools.register(baseAnchorTool("base"));
    const { runtime, adjudicated } = runtimeWithRecordedActivities();
    installWorkflowRuntime(tools, runtime);

    const result = await dispatchAnchor(tools, selectInstance(runtime));

    expect(adjudicated).toEqual(["order.cart.ensure", "order.reorder"]);
    // The anchor act still happened — the workflow ADDS steps, never replaces.
    expect((result as { anchor?: string }).anchor).toBe("base");
    expect((result as { workflow?: { outcome?: string } }).workflow?.outcome).toBe(
      "completed",
    );
  });

  it("WRONG ORDER — install, then base roster ⇒ the wrapper is CLOBBERED and NOT ONE activity runs", async () => {
    const tools = createToolRegistry();
    for (const tool of activityTools()) tools.register(tool);
    tools.register(baseAnchorTool("base"));
    const { runtime, adjudicated } = runtimeWithRecordedActivities();
    installWorkflowRuntime(tools, runtime);
    // The inversion: the base roster is (re-)registered AFTER the install, as it
    // would be if the wiring block sat above `registerIbatexasToolPacks`.
    tools.register(baseAnchorTool("re-registered"));

    const result = await dispatchAnchor(tools, selectInstance(runtime));

    // Nothing threw. The anchor executed. The customer would have seen a normal
    // reply. And the workflow did NOTHING — this is the silent failure.
    expect((result as { anchor?: string }).anchor).toBe("re-registered");
    expect(adjudicated).toEqual([]);
    expect((result as { workflow?: unknown }).workflow).toBeUndefined();
  });

  it("an anchor with NO registered tool refuses the composition at boot", () => {
    const tools = createToolRegistry();
    for (const tool of activityTools()) tools.register(tool);
    const { runtime } = runtimeWithRecordedActivities();
    // No anchor tool registered at all — a workflow anchored on a kind nothing
    // can execute would confirm with the customer and then fail at dispatch.
    expect(() => installWorkflowRuntime(tools, runtime)).toThrow(
      /has no.*registered tool/s,
    );
  });

  it("a turn with NO instance is byte-identical to the unwrapped tool", async () => {
    const tools = createToolRegistry();
    for (const tool of activityTools()) tools.register(tool);
    tools.register(baseAnchorTool("base"));
    const { runtime, adjudicated } = runtimeWithRecordedActivities();
    installWorkflowRuntime(tools, runtime);

    // `resolveTool` so this genuinely runs the WRAPPER. Reaching for
    // `list().find(...)` here would hand back the unwrapped base tool and the
    // test would assert nothing about the wrapper's no-instance path.
    const ctx = {
      turnId: "turn_plain",
      actor: { principal: "llm", role: "customer" },
    };
    const tool = tools.resolveTool(ANCHOR as CapabilityId, ctx);
    expect(tool.id).toMatch(/\+workflow$/);
    // A plain, directly-parsed checkout: no instance id on the payload.
    const result = await tool.execute({}, ctx);

    expect(result).toEqual({ anchor: "base" });
    expect(adjudicated).toEqual([]);
  });
});

describe("LE2-021 — registerWorkflowScopedTools before install", () => {
  it("a workflow-scoped activity kind with no handler refuses the composition", async () => {
    const { registerWorkflowScopedTools } = await import(
      "../../../tools/register-workflow-scoped-tools.js"
    );
    const tools = createToolRegistry();
    expect(() =>
      registerWorkflowScopedTools(tools, new Set(["order.nonexistent.scoped"])),
    ).toThrow(/no registered.*tool and no workflow-scoped handler/s);
  });

  it("the fixture corpus's scoped kind DOES have a handler (the control)", async () => {
    const { registerWorkflowScopedTools } = await import(
      "../../../tools/register-workflow-scoped-tools.js"
    );
    const tools = createToolRegistry();
    // The base roster FIRST — the production order. `registerWorkflowScopedTools`
    // skips any kind the registry already has, so the ORDINARY activity kinds
    // (order.cart.ensure) must come from the pack roster; only the genuinely
    // workflow-scoped ones fall through to the scoped-handler table.
    for (const tool of activityTools().filter(
      (t) => String(t.capability) !== "order.reorder",
    )) {
      tools.register(tool);
    }
    const { runtime } = runtimeWithRecordedActivities();
    // Without this control the assertion above could pass on a registry that
    // rejects every kind.
    expect(() =>
      registerWorkflowScopedTools(tools, runtime.activityCapabilities()),
    ).not.toThrow();
    expect(tools.list().some((t) => String(t.capability) === "order.reorder")).toBe(
      true,
    );
  });
});
