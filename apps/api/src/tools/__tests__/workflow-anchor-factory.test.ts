// R6-S3 — THE ANCHOR FACTORY: coverage, the must-THROW property, and the one
// authored field.
//
// LE2-021 through LE2-024 grew three byte-identical anchor constants and a hand
// map from kind to constant. The only thing that discovered a FOURTH workflow
// whose author forgot the map entry was a throw at boot — a wall, reached by
// whoever next started the api. R6-S3 replaced the constants with a factory, so
// this file has to carry what the wall used to: proof that every anchor the real
// corpus declares is covered, by the roster or by a mint, with nothing between.
//
// THE REGISTRY AND THE ROSTER ARE REAL. `createToolRegistry` because these
// modules' whole contract is expressed in terms of it (`hasCapability` for the
// skip, `register` for the install, last-write-wins for the ordering), and
// `registerIbatexasToolPacks` because "the main roster already owns this
// capability" is a claim about the SHIPPED roster. A hand-listed stand-in would
// make this file agree with a wrong idea of what the roster carries — which is
// exactly the fact the skip branch turns on.

import { describe, expect, it, vi } from "vitest";
import "../../__tests__/setup.js";

// Same flat factory mock the sibling registration test uses: the packs registry
// constructs its executors at module load, and `@ibatexas/domain` is this
// codebase's convention for that seam. Nothing here calls a domain service —
// only registration shape is under test.
vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createOrderQueryService: () => ({
      listByCustomer: async () => ({ orders: [], count: 0 }),
    }),
  };
});

const { createToolRegistry } = await import("@claustrum/core");
const {
  FIXTURE_WORKFLOWS,
  WORKFLOW_DEFINITIONS,
  workflowSelectionAnchors,
} = await import("@ibatexas/catalog");
const { registerIbatexasToolPacks } = await import(
  "../register-ibatexas-tool-packs.js"
);
const {
  mintWorkflowAnchorTool,
  registerWorkflowAnchorTools,
  workflowAnchorToolId,
  WORKFLOW_ANCHOR_NO_OP,
} = await import("../register-workflow-anchor-tools.js");

/** The production corpus's anchors — what a booting api actually registers. */
const REAL_ANCHORS = workflowSelectionAnchors(WORKFLOW_DEFINITIONS);

/** A registry carrying the REAL main roster, as `claustrum-bootstrap` builds it. */
function rosteredRegistry(): ReturnType<typeof createToolRegistry> {
  const tools = createToolRegistry();
  registerIbatexasToolPacks(tools);
  return tools;
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

describe("factory coverage — every corpus anchor is covered, and the roster wins", () => {
  it("leaves NO anchor of the real corpus undispatchable", () => {
    // THE PROPERTY THE BOOT THROW USED TO DISCOVER, asserted here instead — over
    // the shipped corpus and the shipped roster, at test time rather than at
    // whoever-boots-next time.
    const tools = rosteredRegistry();
    registerWorkflowAnchorTools(tools, REAL_ANCHORS);

    // The control: a corpus that went empty would pass the loop below vacuously.
    expect(REAL_ANCHORS.length).toBeGreaterThan(0);
    for (const anchor of REAL_ANCHORS) {
      expect(tools.hasCapability(anchor.capability), anchor.workflowId).toBe(true);
    }
  });

  it("partitions the real corpus into ROSTER-OWNED and MINTED, with nothing left over", () => {
    // The union is total BY CONSTRUCTION now (the factory mints whatever the
    // roster does not carry), so what is worth pinning is the PARTITION: which
    // side each shipped anchor falls on. All three fall to the mint, because all
    // three are the ASK half of an ASK/ACT split that `IBATEXAS_TOOLS`
    // deliberately does not publish — see the module's roster note.
    const roster = rosteredRegistry();
    const rosterOwned = REAL_ANCHORS.filter((a) => roster.hasCapability(a.capability));
    const minted = REAL_ANCHORS.filter((a) => !roster.hasCapability(a.capability));

    expect(rosterOwned).toEqual([]);
    expect(minted.map((a) => a.capability)).toEqual([
      "order.reorder.request",
      "order.coupon.swap.request",
      "order.cancel.request",
    ]);
  });

  it("mints each one BYTE-FOR-BYTE as the hand-written constants did", () => {
    // R6-S3's zero-behaviour-change claim, in-suite. The three ids, capabilities,
    // intent kinds, descriptions and risk levels are the pre-refactor values; the
    // registration diff that produced them is the commit's evidence, and this is
    // what keeps them from drifting afterwards.
    const tools = rosteredRegistry();
    registerWorkflowAnchorTools(tools, REAL_ANCHORS);
    const minted = Object.fromEntries(
      REAL_ANCHORS.map((anchor) => [
        anchor.capability,
        tools
          .list()
          .filter((t) => String(t.capability) === anchor.capability)
          .at(-1),
      ]),
    );

    expect(minted["order.reorder.request"]?.id).toBe("ibatexas.order.reorderRequest.v1");
    expect(minted["order.reorder.request"]?.description).toBe(
      "Confirmar a repetição do último pedido do cliente.",
    );
    expect(minted["order.coupon.swap.request"]?.id).toBe(
      "ibatexas.order.couponSwapRequest.v1",
    );
    expect(minted["order.coupon.swap.request"]?.description).toBe(
      "Confirmar a troca de um pedido por um novo com cupom aplicado.",
    );
    expect(minted["order.cancel.request"]?.id).toBe("ibatexas.order.cancelRequest.v1");
    expect(minted["order.cancel.request"]?.description).toBe(
      "Confirmar o cancelamento de um pedido já pago do cliente.",
    );
    for (const anchor of REAL_ANCHORS) {
      const tool = minted[anchor.capability];
      // `capability === intentKind`, and the risk of the ANCHOR is never the risk
      // of the route it opens.
      expect(String(tool?.intentKind), anchor.capability).toBe(anchor.capability);
      expect(tool?.riskLevel, anchor.capability).toBe("low");
      expect(tool?.inputSchema, anchor.capability).toEqual({});
      expect(tool?.outputSchema, anchor.capability).toEqual({});
    }
  });

  it("the MAIN ROSTER WINS — the LE2-020 fixture corpus is minted over, never shadowed", () => {
    // The real main-roster-wins case, over real data: both LE2-020 fixtures
    // anchor on `order.checkout.create`, which the shipped roster owns.
    //
    // It is also the control that proves the SKIP RUNS BEFORE THE MINT rather
    // than alongside it: neither fixture declares `selection.anchorDescription`,
    // so a factory that minted first would throw here instead of leaving the
    // roster's real checkout handler in place.
    const fixtureAnchors = workflowSelectionAnchors(FIXTURE_WORKFLOWS);
    expect(fixtureAnchors.map((a) => a.capability)).toEqual(["order.checkout.create"]);
    expect(fixtureAnchors[0]?.description).toBeUndefined();

    const tools = rosteredRegistry();
    const before = tools
      .list()
      .filter((t) => String(t.capability) === "order.checkout.create")
      .map((t) => t.id);
    expect(before.length).toBeGreaterThan(0);

    expect(() => registerWorkflowAnchorTools(tools, fixtureAnchors)).not.toThrow();

    const after = tools
      .list()
      .filter((t) => String(t.capability) === "order.checkout.create")
      .map((t) => t.id);
    expect(after).toEqual(before);
  });

  it("the roster wins even for an anchor that DOES declare a description", () => {
    // The sharp version. Above, removing the skip would fail on the missing
    // description — a red test, but for the wrong reason. Here the anchor is
    // fully mintable and the roster still owns it, so the only thing keeping the
    // planted handler alive is the skip itself. The registry is last-write-wins,
    // so a mint here would silently replace a real capability's real ACT with a
    // no-op that answers `{approved: true}`.
    const anchor = REAL_ANCHORS[0];
    expect(anchor?.description).toBeTypeOf("string");

    const tools = createToolRegistry();
    tools.register(stubTool(anchor!.capability));
    registerWorkflowAnchorTools(tools, [anchor!]);

    const registered = tools
      .list()
      .filter((t) => String(t.capability) === anchor!.capability);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.id).toBe(`stub.${anchor!.capability}`);
  });

  it("is a NO-OP for an empty corpus — the byte-identical property", () => {
    const tools = createToolRegistry();
    registerWorkflowAnchorTools(tools, []);
    expect(tools.list()).toHaveLength(0);
  });

  it("the boot WALL is now UNREACHABLE for the shipped corpus", () => {
    // `registerWorkflowAnchorTools` still ends each iteration with LE2-021's
    // throw — no anchor leaves this function undispatchable — and nothing drives
    // it any more: the mint either succeeded or threw naming the workflow. This
    // case asserts the CAUSE of unreachability rather than the branch, which is
    // the only honest way to test a line that cannot be reached. Every shipped
    // anchor is either roster-owned or mintable, so the register loop can never
    // fall through to it.
    const roster = rosteredRegistry();
    for (const anchor of REAL_ANCHORS) {
      const mintable =
        anchor.description !== undefined && anchor.description.trim() !== "";
      expect(
        roster.hasCapability(anchor.capability) || mintable,
        `${anchor.workflowId} is neither roster-owned nor mintable`,
      ).toBe(true);
    }
  });
});

describe("the must-THROW invariant — ONE property, every anchor", () => {
  it("every minted anchor carries the SAME no-op executor", () => {
    // Reference identity, not behavioural similarity. Three parallel comments
    // over three separately-written executors could each drift; one shared
    // function cannot, and this is the assertion that keeps the factory from
    // quietly growing a per-anchor executor argument later.
    expect(REAL_ANCHORS.length).toBeGreaterThan(0);
    for (const anchor of REAL_ANCHORS) {
      expect(mintWorkflowAnchorTool(anchor).execute, anchor.capability).toBe(
        WORKFLOW_ANCHOR_NO_OP,
      );
    }
  });

  it("that executor moves nothing and answers exactly {approved: true}", async () => {
    // The anchor act's whole content is the customer's approval. A `{success:
    // false, message}` returned here would be SILENTLY DISCARDED — the workflow
    // wrapper overwrites `message` with the outcome template — and the customer
    // would read "Pronto, cancelei seu pedido" over a failed anchor. So the
    // shape is pinned exactly, not loosely: an executor that grew work to do
    // would have something to report, and reporting it is the failure mode.
    const tool = mintWorkflowAnchorTool(REAL_ANCHORS[0]!);
    const result = await tool.execute({} as never, {} as never);
    expect(result).toEqual({ approved: true });
    expect(Object.keys(result as object)).toEqual(["approved"]);
  });

  it("answers the same for ANY input and ANY capsule — it reads neither", () => {
    // The structural half of "moves nothing": there is no argument through which
    // an anchor could be told what to do, so there is no payload that makes one
    // act. Driven through the minted tool because the shared executor is 0-arity
    // by design and the port is 2-arity.
    const tool = mintWorkflowAnchorTool(REAL_ANCHORS[0]!);
    const inputs: readonly unknown[] = [
      undefined,
      null,
      { orderId: "ord_1", amount: 999_999 },
      "garbage",
    ];
    return Promise.all(
      inputs.map(async (input) => {
        await expect(
          tool.execute(input as never, { customerId: "cus_x" } as never),
        ).resolves.toEqual({ approved: true });
      }),
    );
  });
});

describe("the AUTHORED description — the conscious act, and its loud absence", () => {
  it("THROWS naming the workflow and the field when a mintable anchor has none", () => {
    // The failure an author actually hits: a fourth workflow, anchored on a new
    // ASK kind, with everything but the sentence. Before R6-S3 the same mistake
    // was a missing entry in a hand map two packages away from the workflow.
    const tools = createToolRegistry();
    expect(() =>
      registerWorkflowAnchorTools(tools, [
        { workflowId: "workflow.orders.new-thing", capability: "order.nope" },
      ]),
    ).toThrow(/workflow "workflow\.orders\.new-thing" is anchored on "order\.nope"/);
  });

  it("names the REMEDY, and never mints a default sentence", () => {
    // A template would be worse than a throw: the anchor would work, the
    // customer-facing approval would be described by a sentence nobody chose,
    // and nothing would ever surface it. So the message says what to author and
    // where, and the registry stays empty.
    const tools = createToolRegistry();
    expect(() =>
      registerWorkflowAnchorTools(tools, [
        { workflowId: "workflow.orders.new-thing", capability: "order.nope" },
      ]),
    ).toThrow(/Add `selection\.anchorDescription` \(pt-BR\) to the workflow/);
    expect(tools.list()).toHaveLength(0);
  });

  it("treats a BLANK description as a missing one", () => {
    // Whitespace is the shape a half-finished authoring pass leaves behind, and
    // a blank tool description is not a weaker declaration than none — it is the
    // same absence, spelled in a way a `!== undefined` check would wave through.
    expect(() =>
      mintWorkflowAnchorTool({
        workflowId: "workflow.orders.blank",
        capability: "order.nope",
        description: "   ",
      }),
    ).toThrow(/declares no `selection\.anchorDescription`/);
  });

  it("every mintable anchor of the real corpus declares one, in pt-BR", () => {
    // Hard Rule #4 on the one authored field. Asserted over the corpus rather
    // than over the three known ids, so a fourth workflow joins this case by
    // existing.
    const roster = rosteredRegistry();
    for (const anchor of REAL_ANCHORS) {
      if (roster.hasCapability(anchor.capability)) continue;
      expect(anchor.description, anchor.workflowId).toBeTypeOf("string");
      expect(anchor.description?.trim(), anchor.workflowId).not.toBe("");
    }
  });
});

describe("workflowAnchorToolId — the one DERIVED field", () => {
  it("reproduces all three shipped ids from their kinds alone", () => {
    expect(workflowAnchorToolId("order.reorder.request")).toBe(
      "ibatexas.order.reorderRequest.v1",
    );
    expect(workflowAnchorToolId("order.coupon.swap.request")).toBe(
      "ibatexas.order.couponSwapRequest.v1",
    );
    expect(workflowAnchorToolId("order.cancel.request")).toBe(
      "ibatexas.order.cancelRequest.v1",
    );
  });

  it("keeps the head segment and camel-cases the whole tail, at any depth", () => {
    expect(workflowAnchorToolId("reservation.waitlist.join.request")).toBe(
      "ibatexas.reservation.waitlistJoinRequest.v1",
    );
    // Degenerate, and it still produces a well-formed id rather than
    // `ibatexas..v1` — a single-segment kind is not a shape any workflow can
    // declare, but an id builder that emitted an empty segment would be a
    // registry key that silently collides.
    expect(workflowAnchorToolId("order")).toBe("ibatexas.order.v1");
  });
});
