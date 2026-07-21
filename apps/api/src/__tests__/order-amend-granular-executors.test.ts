/**
 * FE-T09 review fix (post-#264) — order.amend.update_qty/remove_item
 * executors.
 *
 * Two properties the Opus review found missing on the first cut:
 *
 *   1. `ambiguousItemReply` — a pure function proving the disambiguation
 *      message it builds is honest and specific ("Encontrei N itens ... —
 *      qual deles?"), and that it stays inert (returns undefined) whenever
 *      the payload does NOT carry `itemAmbiguousCount`.
 *   2. The real registered `order.amend.update_qty` / `order.amend.remove_item`
 *      tool executors: an ambiguous payload short-circuits BEFORE any live
 *      Medusa fetch or mutation — `createOrderService(...).getOrder` and
 *      `amendOrder` are proven NEVER CALLED (not "probably safe because the
 *      code returns early" — actually observed). This is the "no mutation,
 *      no park, disambiguation reply" end-to-end proof the review asked
 *      for; resolve-and-assemble.test.ts proves the upstream hydration
 *      signal (itemAmbiguousCount set, ctx.autoResolvedMoneyRef untouched).
 *
 * `@ibatexas/tools` stays REAL except `amendOrder` (spied) — mirrors
 * check-order-status-executor.test.ts's importOriginal pattern so the other
 * 18 registered tools in IBATEXAS_TOOLS still construct correctly at module
 * load. `@ibatexas/domain` is a flat factory mock (this codebase's
 * established convention for that package — see order-cancel-governance.test.ts)
 * providing only the one export this module uses.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Capsule } from "@claustrum/core";

const mockAmendOrder = vi.hoisted(() => vi.fn());
const mockGetOrder = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return { ...actual, amendOrder: mockAmendOrder };
});
vi.mock("@ibatexas/domain", () => ({
  createOrderService: () => ({ getOrder: mockGetOrder }),
}));

const { listIbatexasToolPacks, ambiguousItemReply } = await import(
  "../tools/register-ibatexas-tool-packs.js"
);

/** Minimal Capsule double — mirrors tool-roster-integrity.test.ts's mkCapsule. */
function mkCapsule(customerId: string): Capsule {
  return {
    customerId,
    channel: "web",
    conversationId: "conv-xyz",
    actor: { principal: "llm", sessionId: "conv-xyz" },
  } as unknown as Capsule;
}

function toolFor(capability: string) {
  const tool = listIbatexasToolPacks().find(
    (t) => (t.capability as unknown as string) === capability,
  );
  if (!tool) throw new Error(`tool not registered for capability ${capability}`);
  return tool;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ambiguousItemReply — pure disambiguation-message builder", () => {
  it("builds an honest, specific reply naming the item and the count", () => {
    const reply = ambiguousItemReply({ itemAmbiguousCount: 2, item: "coca" });
    expect(reply).toBeDefined();
    expect(reply!.success).toBe(false);
    expect(reply!.message).toContain("2");
    expect(reply!.message).toContain('"coca"');
    expect(reply!.message).toMatch(/qual deles/i);
  });

  it("reflects the REAL count, not a fixed sentinel", () => {
    expect(ambiguousItemReply({ itemAmbiguousCount: 5, item: "x" })!.message).toContain("5");
  });

  it("omits the quoted item name gracefully when absent", () => {
    const reply = ambiguousItemReply({ itemAmbiguousCount: 2 });
    expect(reply!.message).not.toContain("undefined");
  });

  it("returns undefined (inert) when itemAmbiguousCount is absent — the normal path is untouched", () => {
    expect(ambiguousItemReply({ item: "coca" })).toBeUndefined();
    expect(ambiguousItemReply({})).toBeUndefined();
  });

  it("returns undefined for a non-numeric itemAmbiguousCount (malformed input, fail inert not fail-open)", () => {
    expect(ambiguousItemReply({ itemAmbiguousCount: "2" })).toBeUndefined();
  });
});

describe("order.amend.update_qty / order.amend.remove_item executors — ambiguous-item short-circuit (no mutation, no live fetch)", () => {
  it.each([
    ["order.amend.update_qty", { orderId: "o-1", item: "coca", quantity: 2, itemAmbiguousCount: 2 }],
    ["order.amend.remove_item", { orderId: "o-1", item: "coca", itemAmbiguousCount: 2 }],
  ])("%s: an ambiguous payload returns the disambiguation reply WITHOUT ever calling getOrder or amendOrder", async (capability, input) => {
    const result = await toolFor(capability).execute(input, mkCapsule("c1"));

    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("2 itens"),
    });
    expect(mockGetOrder).not.toHaveBeenCalled();
    expect(mockAmendOrder).not.toHaveBeenCalled();
  });

  it("order.amend.update_qty: the NORMAL (non-ambiguous) path is unaffected — still reverse-looks-up the title and calls amendOrder", async () => {
    mockGetOrder.mockResolvedValue({
      ownershipValid: true,
      order: { items: [{ id: "li-1", title: "Hambúrguer" }] },
    });
    mockAmendOrder.mockResolvedValue({ success: true, message: "ok" });

    const result = await toolFor("order.amend.update_qty").execute(
      { orderId: "o-1", itemId: "li-1", quantity: 3 },
      mkCapsule("c1"),
    );

    expect(mockGetOrder).toHaveBeenCalledTimes(1);
    expect(mockAmendOrder).toHaveBeenCalledTimes(1);
    const [amendInput] = mockAmendOrder.mock.calls[0]!;
    expect(amendInput).toEqual({
      orderId: "o-1",
      action: "update_qty",
      itemTitle: "Hambúrguer",
      quantity: 3,
    });
    expect(result).toEqual({ success: true, message: "ok" });
  });
});
