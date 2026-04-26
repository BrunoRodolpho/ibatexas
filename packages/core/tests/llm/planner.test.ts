import { describe, expect, it } from "vitest";
import { staticPlanner } from "../../src/llm/planner.js";
import {
  filterReadOnly,
  isMutating,
  isReadOnly,
  type ToolClassification,
} from "../../src/llm/tool-classifier.js";

describe("staticPlanner", () => {
  it("returns the fixed plan", () => {
    const p = staticPlanner({
      visibleReadTools: ["search"],
      allowedIntents: ["order.tool.propose"],
      forbiddenConcepts: ["pedido confirmado"],
    });
    const plan = p.plan(null, null);
    expect(plan.visibleReadTools).toEqual(["search"]);
    expect(plan.allowedIntents).toEqual(["order.tool.propose"]);
    expect(plan.forbiddenConcepts).toEqual(["pedido confirmado"]);
  });
});

describe("ToolClassification", () => {
  const classification: ToolClassification = {
    READ_ONLY: new Set(["search", "check_inventory"]),
    MUTATING: new Set(["add_to_cart", "create_checkout"]),
  };

  it("isReadOnly partitions correctly", () => {
    expect(isReadOnly(classification, "search")).toBe(true);
    expect(isReadOnly(classification, "add_to_cart")).toBe(false);
    expect(isReadOnly(classification, "unknown")).toBe(false);
  });

  it("isMutating partitions correctly", () => {
    expect(isMutating(classification, "add_to_cart")).toBe(true);
    expect(isMutating(classification, "search")).toBe(false);
  });

  it("filterReadOnly drops MUTATING and unknown tools", () => {
    const out = filterReadOnly(classification, [
      "search",
      "add_to_cart",
      "check_inventory",
      "unknown",
    ]);
    expect(out).toEqual(["search", "check_inventory"]);
  });

  it("filterReadOnly is the structural filter protecting the LLM tool list", () => {
    // The invariant: MUTATING tools NEVER leak through filterReadOnly.
    const out = filterReadOnly(classification, [
      "add_to_cart",
      "create_checkout",
    ]);
    expect(out).toEqual([]);
  });
});
