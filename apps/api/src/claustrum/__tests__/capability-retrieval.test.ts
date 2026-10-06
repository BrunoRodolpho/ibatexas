// capability-retrieval.test.ts — LE2-008's L2 retriever: the pure decision core,
// the fail-safe degrades, and the index it builds from the catalog.
//
// The turn-seam proof (a scoped surface really reaching the model, the forced
// low-confidence fallback, prefix stability) lives in
// `apps/api/src/__tests__/l2-scoped-parse.e2e.test.ts`. This file covers what a
// turn cannot isolate: that EVERY failure direction widens rather than narrows.
//
// The governing invariant, restated because every case below is an instance of
// it: L2 may only ever REMOVE capabilities the planners already authorized, and
// only when it is confident. Everything else — no embedder, a dead embedder, a
// small roster, a near-tie — must produce today's full roster.

import { describe, expect, it, vi } from "vitest";
import {
  buildRetrievalDocument,
  buildRetrievalQuery,
  cosineSimilarity,
  createCapabilityRetriever,
  decideScope,
  fullRosterDecision,
  marginConfidence,
  RETRIEVAL_K,
  RETRIEVAL_MARGIN_THRESHOLD,
  L2_SURFACE_VERSION,
  type EmbedderPort,
} from "../capability-retrieval.js";

const ROSTER = [
  "order.item.add",
  "order.item.remove",
  "order.item.update",
  "order.cancel",
  "order.checkout.create",
  "order.coupon.apply",
  "reservation.create",
  "reservation.cancel",
];

/** Ranked candidates with an explicit, controllable margin at the K boundary. */
function ranked(topScores: number[], kinds: string[] = ROSTER) {
  return kinds.map((kind, i) => ({ kind, score: topScores[i] ?? 0.1 }));
}

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 rather than NaN for a degenerate or mismatched vector", () => {
    // A malformed embedding must LOSE a ranking, never poison one with NaN —
    // NaN comparisons are false, which would scramble the sort silently.
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });
});

describe("marginConfidence — the boundary, not the winner", () => {
  it("measures top-1 against the FIRST EXCLUDED candidate (rank K+1)", () => {
    const scores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
    expect(marginConfidence(scores, 5)).toBeCloseTo(0.9 - 0.4);
  });

  it("is 0 when there is nothing to exclude", () => {
    // A roster at or below K: scoping would remove nothing, so there is no
    // decision to be confident about.
    expect(marginConfidence([0.9, 0.8], 5)).toBe(0);
  });

  it("is small for a cluster of near-ties straddling the cut", () => {
    // This is the amend-triad shape: several capabilities the retriever cannot
    // separate. A small margin is exactly what must trigger the fallback.
    expect(marginConfidence([0.71, 0.7, 0.7, 0.69, 0.69, 0.68], 5)).toBeLessThan(
      RETRIEVAL_MARGIN_THRESHOLD,
    );
  });
});

describe("decideScope — narrows only on confidence", () => {
  it("scopes to the top-K when the margin clears the threshold", () => {
    const decision = decideScope(ranked([0.95, 0.6, 0.55, 0.5, 0.45, 0.2, 0.1, 0.05]), ROSTER);
    expect(decision.scoped).toBe(true);
    expect(decision.reason).toBe("scoped");
    expect(decision.selected).toHaveLength(RETRIEVAL_K);
    expect(decision.selected[0]).toBe("order.item.add");
  });

  it("FALLS BACK on a near-tie at the boundary", () => {
    const decision = decideScope(
      ranked([0.71, 0.705, 0.7, 0.699, 0.698, 0.6975, 0.69, 0.68]),
      ROSTER,
    );
    expect(decision.scoped).toBe(false);
    expect(decision.reason).toBe("low_confidence");
    expect(decision.selected).toEqual([]);
  });

  it("never invents a capability the planners did not authorize", () => {
    // Retrieval runs DOWNSTREAM of the capability planners; a stale index that
    // ranks a de-authorized kind first must not resurrect it.
    const authorized = ["order.item.add", "order.cancel"];
    const decision = decideScope(
      ranked([0.95, 0.6, 0.55, 0.5, 0.45, 0.2, 0.1, 0.05]),
      authorized,
    );
    // Only 2 authorized ⇒ at/below K ⇒ nothing to scope.
    expect(decision.scoped).toBe(false);
    expect(decision.reason).toBe("roster_at_or_below_k");
  });

  it("stands down when the roster is already at or below K", () => {
    const small = ROSTER.slice(0, RETRIEVAL_K);
    const decision = decideScope(ranked([0.95, 0.5, 0.4, 0.3, 0.2], small), small);
    expect(decision.scoped).toBe(false);
    expect(decision.reason).toBe("roster_at_or_below_k");
  });

  it("selects only from the authorized set even when scoping", () => {
    const authorized = ROSTER.filter((k) => k !== "order.item.add");
    const decision = decideScope(
      ranked([0.95, 0.6, 0.55, 0.5, 0.45, 0.4, 0.2, 0.1]),
      authorized,
    );
    expect(decision.selected).not.toContain("order.item.add");
    for (const kind of decision.selected) expect(authorized).toContain(kind);
  });
});

describe("the retrieval document is built from authored catalog data", () => {
  it("carries the kind, its conversation triggers and its description", () => {
    const doc = buildRetrievalDocument("order.item.add");
    expect(doc.startsWith("search_document: ")).toBe(true);
    expect(doc).toContain("order item add");
    // The description…
    expect(doc).toContain("Adicionar um item ao carrinho do cliente.");
    // …and the register the descriptions lack, which is why L2 exists at all.
    expect(doc.length).toBeGreaterThan(200);
  });

  it("uses nomic's documented query prefix", () => {
    expect(buildRetrievalQuery("quero uma coca")).toBe("search_query: quero uma coca");
  });

  it("is PURE — same catalog, byte-identical document", () => {
    expect(buildRetrievalDocument("order.cancel")).toBe(buildRetrievalDocument("order.cancel"));
  });
});

// BKL-283 — `createOllamaEmbedder` no longer reads env and no longer answers
// "is it configured": that question moved to `resolveOllamaEmbedderConfig`, and
// the whole seam (including the property that a fully-exported shell inherits
// NOTHING) is proven in
// `apps/api/src/__tests__/bkl283-embedder-injection-seam.test.ts`.

describe("createCapabilityRetriever — every failure direction WIDENS", () => {
  const okEmbedder = (vec: number[]): EmbedderPort => ({ embed: async () => vec });

  it("falls back to the full roster when the embedder throws mid-turn", async () => {
    const retriever = createCapabilityRetriever({
      embedder: { embed: async () => { throw new Error("ECONNREFUSED"); } },
    });
    const decision = await retriever.scopeFor("quero uma coca", ROSTER);
    expect(decision.scoped).toBe(false);
    expect(decision.reason).toBe("retriever_unavailable");
  });

  it("falls back when the embedder returns a degenerate vector", async () => {
    const retriever = createCapabilityRetriever({ embedder: okEmbedder([]) });
    const decision = await retriever.scopeFor("quero uma coca", ROSTER);
    expect(decision.scoped).toBe(false);
  });

  it("never throws out of scopeFor — a retriever fault is never a turn fault", async () => {
    const retriever = createCapabilityRetriever({
      embedder: { embed: async () => { throw new Error("boom"); } },
    });
    await expect(retriever.scopeFor("qualquer coisa", ROSTER)).resolves.toBeDefined();
  });

  it("builds the index ONCE and reuses it across turns", async () => {
    const embed = vi.fn(async (text: string) =>
      text.startsWith("search_query:") ? [1, 0, 0] : [0.9, 0.1, 0],
    );
    const retriever = createCapabilityRetriever({ embedder: { embed } });
    await retriever.scopeFor("primeira", ROSTER);
    const afterFirst = embed.mock.calls.length;
    await retriever.scopeFor("segunda", ROSTER);
    // The second turn costs exactly ONE embed (its query), not another index.
    expect(embed.mock.calls.length).toBe(afterFirst + 1);
  });

  it("does not latch a failed index build — a transient outage retries", async () => {
    let fail = true;
    const embed = vi.fn(async () => {
      if (fail) throw new Error("transient");
      return [1, 0, 0];
    });
    const retriever = createCapabilityRetriever({ embedder: { embed } });
    expect((await retriever.scopeFor("a", ROSTER)).reason).toBe("retriever_unavailable");
    fail = false;
    // The next turn must be able to build; a latched failure would make one blip
    // disable L2 for the life of the process.
    const second = await retriever.scopeFor("b", ROSTER);
    expect(second.reason).not.toBe("retriever_unavailable");
  });
});

describe("the L1 interaction", () => {
  it("names a scoped-surface version, so shipping L2 purges pre-L2 parse entries", () => {
    // LE2-009 reserved `surfaceVersion` as a digested component of the parse-cache
    // key precisely so this rename would invalidate every entry written under the
    // full-roster regime. Pinning the value keeps that purge auditable in a diff.
    expect(L2_SURFACE_VERSION).toBe("l2-scoped-v1");
  });
});

describe("fullRosterDecision", () => {
  it("is inert — no selection, no confidence", () => {
    const d = fullRosterDecision("retriever_unavailable");
    expect(d).toEqual({
      scoped: false,
      selected: [],
      confidence: 0,
      reason: "retriever_unavailable",
    });
  });
});
