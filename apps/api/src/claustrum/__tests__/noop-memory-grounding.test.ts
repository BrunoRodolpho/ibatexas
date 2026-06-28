// DEF-005: the designed no-op memory/grounding ports must NEVER throw and must
// return the empty shapes by design (not via a caught exception). These pin the
// "safe by design, not by catch" guarantee.

import { describe, expect, it } from "vitest";
import { noopGroundingProvider, noopMemoryProvider } from "../noop-memory-grounding.js";

describe("noopMemoryProvider", () => {
  it("recall returns an empty snapshot without throwing", async () => {
    const m = noopMemoryProvider();
    const snap = await m.recall("cust-1", { text: "oi" } as never);
    expect(snap.customerId).toBe("cust-1");
    expect(snap.episodic).toEqual([]);
    expect(snap.semantic).toEqual([]);
    expect(snap.procedural).toEqual([]);
    expect(snap.relational).toEqual([]);
    expect(typeof snap.assembledAt).toBe("string");
  });

  it("observe / search / recentActions never throw and return empty", async () => {
    const m = noopMemoryProvider();
    await expect(m.observe("cust-1", {} as never)).resolves.toBeUndefined();
    await expect(m.search("cust-1", { semantic: "q" }, 5)).resolves.toEqual([]);
    await expect(m.recentActions("cust-1", 0 as never)).resolves.toEqual([]);
  });
});

describe("noopGroundingProvider", () => {
  it("retrieve returns empty docs stamped with the modelId, no throw", async () => {
    const g = noopGroundingProvider("model-x");
    const docs = await g.retrieve({ text: "oi" } as never, {} as never);
    expect(docs.docs).toEqual([]);
    expect(docs.modelId).toBe("model-x");
    expect(typeof docs.retrievedAt).toBe("string");
  });

  it("attestGrounding returns no proofs (fail-closed) without throwing", async () => {
    const g = noopGroundingProvider("model-x");
    await expect(g.attestGrounding([] as never, [] as never)).resolves.toEqual([]);
  });
});
