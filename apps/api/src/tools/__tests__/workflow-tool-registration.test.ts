// LE2-021 — direct unit tests for the two CORPUS-DERIVED tool registries.
//
// Both modules exist to make a composition fail LOUDLY at boot rather than
// mid-conversation, and both of those failure branches are unreachable from a
// turn: by the time a turn runs, composition has already succeeded. So the e2e
// covers the success path and this file covers the refusals — which are the half
// that decides whether a broken corpus is caught by a developer at boot or by a
// customer halfway through a confirmed multi-step run.
//
// The registry is the REAL `createToolRegistry`, not a fake. These modules'
// entire contract is expressed in terms of it — `hasCapability` for the skip,
// `register` for the install, last-write-wins for the ordering — and a fake
// would let the tests agree with a wrong idea of it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../__tests__/setup.js";

const { rowsFake } = vi.hoisted(() => ({ rowsFake: { rows: [] as unknown[] } }));

vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createOrderQueryService: () => ({
      listByCustomer: async (customerId: string) => {
        const owned = rowsFake.rows.filter(
          (r) => (r as { customerId?: string }).customerId === customerId,
        );
        return { orders: owned, count: owned.length };
      },
    }),
  };
});

const { createToolRegistry } = await import("@claustrum/core");
const { registerWorkflowAnchorTools } = await import(
  "../register-workflow-anchor-tools.js"
);
const { registerWorkflowScopedTools } = await import(
  "../register-workflow-scoped-tools.js"
);

const CUSTOMER = "cus_le2021_registry";

/** The Capsule fields `agentCtxFromCapsule` actually reads. Spelled out rather
 *  than cast from `{}` so a future field it starts reading fails here loudly
 *  instead of surfacing as a TypeError inside the handler. */
function capsule(customerId?: string) {
  return {
    ...(customerId === undefined ? {} : { customerId }),
    conversationId: "conv_le2021_registry",
    channel: "web",
    actor: { role: "customer", principal: "llm", sessionId: "s-1" },
  } as never;
}

/** A tool definition shaped like the roster's, for the already-registered case. */
function stubTool(capability: string) {
  return {
    id: `stub.${capability}`,
    capability: capability as never,
    intentKind: capability as never,
    description: "stub",
    inputSchema: {},
    outputSchema: {},
    riskLevel: "low" as const,
    execute: () => Promise.resolve({ stub: true }),
  };
}

beforeEach(() => {
  rowsFake.rows = [];
});

describe("registerWorkflowAnchorTools", () => {
  it("registers the reorder anchor when the roster does not already own it", () => {
    const tools = createToolRegistry();
    expect(tools.hasCapability("order.reorder.request")).toBe(false);

    registerWorkflowAnchorTools(tools, ["order.reorder.request"]);

    expect(tools.hasCapability("order.reorder.request")).toBe(true);
    const registered = tools
      .list()
      .find((t) => String(t.capability) === "order.reorder.request");
    expect(registered?.id).toBe("ibatexas.order.reorderRequest.v1");
    // `capability === intentKind` — the roster-wide invariant, held here too even
    // though this tool is deliberately off the LLM-callable roster.
    expect(String(registered?.intentKind)).toBe("order.reorder.request");
  });

  it("SKIPS an anchor the main roster already owns — never shadows a real handler", () => {
    // The registry is last-write-wins, so registering over a live capability
    // would silently replace the anchor ACT with this module's stub. The LE2-020
    // fixture anchors on `order.checkout.create`, a real roster tool, and this
    // is the branch that leaves it alone.
    const tools = createToolRegistry();
    tools.register(stubTool("order.checkout.create"));

    registerWorkflowAnchorTools(tools, ["order.checkout.create"]);

    const registered = tools
      .list()
      .filter((t) => String(t.capability) === "order.checkout.create");
    expect(registered).toHaveLength(1);
    expect(registered[0]?.id).toBe("stub.order.checkout.create");
  });

  it("THROWS for an anchor with no handler on either side", () => {
    // A workflow anchored on a kind nothing can dispatch would confirm with the
    // customer and then fail. Composition time is the only cheap place to catch
    // it, so this must be a throw and not a warn.
    const tools = createToolRegistry();
    expect(() => registerWorkflowAnchorTools(tools, ["order.nope"])).toThrow(
      /anchored on "order\.nope"/,
    );
  });

  it("names the remedy in the throw, not just the fault", () => {
    const tools = createToolRegistry();
    expect(() => registerWorkflowAnchorTools(tools, ["order.nope"])).toThrow(
      /Register the tool, add its anchor handler here, or anchor the workflow on a kind that has one/,
    );
  });

  it("is a NO-OP for an empty corpus — the byte-identical property", () => {
    const tools = createToolRegistry();
    registerWorkflowAnchorTools(tools, []);
    expect(tools.list()).toHaveLength(0);
  });
});

describe("registerWorkflowScopedTools — the reorder activity", () => {
  it("THROWS for a scoped kind with no handler", () => {
    const tools = createToolRegistry();
    expect(() => registerWorkflowScopedTools(tools, ["order.nope"])).toThrow(
      /invokes "order\.nope"/,
    );
  });

  it("registers the reorder handler for a corpus that invokes it", () => {
    const tools = createToolRegistry();
    registerWorkflowScopedTools(tools, ["order.reorder"]);
    expect(tools.hasCapability("order.reorder")).toBe(true);
  });

  it("the handler THROWS when the previous order has vanished before execution", async () => {
    // Reaching this means the projection changed between the confirm and the
    // customer's "sim" — `confirmReorderLast` REFUSEs before the park otherwise.
    //
    // It THROWS rather than returning a soft failure, and that is the whole
    // point: the anchor wrapper OVERWRITES `message` with the outcome template,
    // so a `{success:false, message}` returned here would be silently discarded
    // and the customer would read "Pronto! Montei um carrinho novo" over a
    // reorder that never happened. A throw is what `submitActivity` can see — it
    // marks the step un-executed and the run reaches its `failed` template.
    const tools = createToolRegistry();
    registerWorkflowScopedTools(tools, ["order.reorder"]);
    const tool = tools.list().find((t) => String(t.capability) === "order.reorder");
    expect(tool).toBeDefined();

    rowsFake.rows = []; // no previous order for anybody
    await expect(
      tool?.execute({}, capsule(CUSTOMER)),
    ).rejects.toThrow(/no readable previous order at execution time/);
  });

  it("the handler THROWS for a capsule with no customer at all", async () => {
    // `ctx.customerId ?? ""` → the empty-id guard in `loadPreviousOrder` → null.
    // Same refusal, reached by a different absence.
    const tools = createToolRegistry();
    registerWorkflowScopedTools(tools, ["order.reorder"]);
    const tool = tools.list().find((t) => String(t.capability) === "order.reorder");
    await expect(tool?.execute({}, capsule())).rejects.toThrow(
      /no readable previous order/,
    );
  });
});

describe("registerWorkflowScopedTools — the LE2-024 order.cancel GUARD", () => {
  it("registers a handler for `order.cancel`, so the api can still boot", () => {
    // The retirement removed `ibatexas.order.cancel.v1` from the LLM-callable
    // roster, and `order.cancel` is a paid-cancel workflow ACTIVITY — so without
    // an entry here `registerWorkflowScopedTools` throws at composition time and
    // the api does not start. This is the regression that would reintroduce that.
    const tools = createToolRegistry();
    expect(() => registerWorkflowScopedTools(tools, ["order.cancel"])).not.toThrow();
    expect(tools.hasCapability("order.cancel")).toBe(true);
  });

  it("that handler THROWS — the 'never through the registry' contract is EXECUTABLE", async () => {
    // THE POINT OF THE ENTRY. The workflow runtime dispatches this kind through
    // `buildWorkflowRuntime`'s `dispatchOrderCancel` -> `executeOrderCancel`,
    // which settles the implied refund BEFORE the order transition. Reaching the
    // registry means that special-case was removed — and the obvious fallback
    // (`cancelOrder`) has NO PAID PATH, so it would cancel the order and leave
    // the customer's money.
    //
    // Without this case the contract would be a comment. With it, a future edit
    // that quietly rewires dispatch fails loudly instead of not refunding.
    const tools = createToolRegistry();
    registerWorkflowScopedTools(tools, ["order.cancel"]);
    const tool = tools.list().find((t) => String(t.capability) === "order.cancel");
    expect(tool).toBeDefined();

    await expect(
      Promise.resolve().then(() =>
        (tool as { execute: (i: unknown, c: unknown) => unknown }).execute({}, {}),
      ),
    ).rejects.toThrow(/reached the TOOL REGISTRY/);
  });

  it("the throw names the REMEDY and the money consequence, not just the fault", async () => {
    const tools = createToolRegistry();
    registerWorkflowScopedTools(tools, ["order.cancel"]);
    const tool = tools.list().find((t) => String(t.capability) === "order.cancel");
    let message = "";
    try {
      await Promise.resolve().then(() =>
        (tool as { execute: (i: unknown, c: unknown) => unknown }).execute({}, {}),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("dispatchOrderCancel");
    expect(message).toContain("no paid path");
    expect(message).toContain("Restore the special-case");
  });
});
