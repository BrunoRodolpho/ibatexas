// Unit tests for the PURE backfill planner (backfill-lineitem-ids-input.ts). No IO,
// no prisma — the plan is a deterministic function of the fetched rows.

import { describe, expect, it } from "vitest";
import {
  buildBackfillPlan,
  classifyItemsJson,
  DEFAULT_BACKFILL_LIMIT,
  itemHasStableId,
  type BackfillCandidateRow,
} from "../backfill-lineitem-ids-input.js";

describe("itemHasStableId", () => {
  it("is true only for an object with a non-empty string id", () => {
    expect(itemHasStableId({ id: "li_1" })).toBe(true);
    expect(itemHasStableId({ id: "li_1", variantId: "v" })).toBe(true);
  });
  it("is false for a missing / empty / non-string id, or a non-object", () => {
    expect(itemHasStableId({ variantId: "v" })).toBe(false); // pre-FE-D15 entry
    expect(itemHasStableId({ id: "" })).toBe(false);
    expect(itemHasStableId({ id: 42 })).toBe(false);
    expect(itemHasStableId(null)).toBe(false);
    expect(itemHasStableId("li_1")).toBe(false);
  });
});

describe("classifyItemsJson", () => {
  it("needs-backfill when ANY entry lacks a stable id", () => {
    expect(classifyItemsJson([{ id: "li_1" }, { variantId: "v" }])).toBe("needs-backfill");
    expect(classifyItemsJson([{ variantId: "v" }])).toBe("needs-backfill");
  });
  it("already-complete when EVERY entry carries a stable id (the idempotency guard)", () => {
    expect(classifyItemsJson([{ id: "li_1" }, { id: "li_2" }])).toBe("already-complete");
  });
  it("no-items for an empty array or a non-array", () => {
    expect(classifyItemsJson([])).toBe("no-items");
    expect(classifyItemsJson(null)).toBe("no-items");
    expect(classifyItemsJson(undefined)).toBe("no-items");
    expect(classifyItemsJson("not-an-array")).toBe("no-items");
  });
});

describe("buildBackfillPlan", () => {
  it("partitions rows into toBackfill / alreadyComplete / noItems, order-stable", () => {
    const rows: BackfillCandidateRow[] = [
      { id: "o_legacy", itemsJson: [{ variantId: "v1" }, { variantId: "v2" }] }, // needs
      { id: "o_done", itemsJson: [{ id: "li_1" }] }, // already complete
      { id: "o_empty", itemsJson: [] }, // no items
      { id: "o_partial", itemsJson: [{ id: "li_2" }, { variantId: "v3" }] }, // needs (one missing)
    ];
    expect(buildBackfillPlan(rows)).toEqual({
      toBackfill: ["o_legacy", "o_partial"],
      alreadyComplete: ["o_done"],
      noItems: ["o_empty"],
    });
  });

  it("is idempotent-friendly: a fully-backfilled sweep plans zero work", () => {
    const rows: BackfillCandidateRow[] = [
      { id: "o1", itemsJson: [{ id: "li_1" }] },
      { id: "o2", itemsJson: [{ id: "li_2" }, { id: "li_3" }] },
    ];
    const plan = buildBackfillPlan(rows);
    expect(plan.toBackfill).toEqual([]);
    expect(plan.alreadyComplete).toEqual(["o1", "o2"]);
  });

  it("empty input → empty plan", () => {
    expect(buildBackfillPlan([])).toEqual({ toBackfill: [], alreadyComplete: [], noItems: [] });
  });
});

describe("DEFAULT_BACKFILL_LIMIT", () => {
  it("is a sane positive bound", () => {
    expect(Number.isInteger(DEFAULT_BACKFILL_LIMIT)).toBe(true);
    expect(DEFAULT_BACKFILL_LIMIT).toBeGreaterThan(0);
  });
});
