// parse-memo-planner.test.ts — LE2-009's L1 seam AS THE REAL PLANNER DRIVES IT.
//
// The e2e (apps/api/src/__tests__/chat-l1-parse-memo.e2e.test.ts) proves the tier
// at the turn seam. This file covers the two decisions that live INSIDE `propose`
// and that a turn-level test cannot isolate, both of which fail silently — the
// cache would simply hold something it should not, and every assertion downstream
// would still pass:
//
//   1. WHICH PARSES ARE WRITTEN. A read-enriched parse (the BKL-027 one-hop loop)
//      is conditioned on live read RESULTS, so caching it would smuggle store
//      state into every future repeat of that utterance — the exact violation of
//      "cache the parse, never the answer". Same for an extraction failure, which
//      would pin a transient wire fault.
//   2. WHAT A HIT REPLAYS. The re-mint: same capability and payload, a FRESH
//      nonce. Asserted here at unit range in addition to the e2e because it is
//      the ticket's money-path hazard (a verbatim replay reproduces the
//      `intentHash` and the fail-closed execution ledger dedups the customer's
//      second request against their first).

import { describe, expect, it, vi } from "vitest";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import type { CognitiveState, Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { createIbatexasPlanner, EXPRESS_INTENT_TOOL } from "../ibatexas-planner.js";
import { createParseFunnel } from "../funnel-tier.js";
import type { MemoizedParse, ParseCacheStore } from "../parse-memo.js";

/** An in-memory store — the port exists precisely so this needs no Redis double. */
function memoryStore(): ParseCacheStore & { readonly entries: Map<string, MemoizedParse> } {
  const entries = new Map<string, MemoizedParse>();
  return {
    entries,
    get: async (key) => entries.get(key),
    set: async (key, value) => {
      entries.set(key, value);
    },
  };
}

function mkState(text: string, turnId = "turn-1"): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-07-26T00:00:00.000Z" },
    memory: {},
    retrieval: { docs: [], retrievedAt: "2026-07-26T00:00:00.000Z", modelId: "m" },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId,
  } as unknown as CognitiveState;
}

function capPlanner(
  visibleReadTools: string[],
  allowedIntents: string[],
): CapabilityPlanner<unknown, unknown> {
  return { plan: () => ({ visibleReadTools, allowedIntents }) };
}

/** Emits the given tool calls per successive completion (hop 1, hop 2, …). */
function mockModel(sequences: Array<Array<{ id: string; name: string; input: unknown }>>): {
  model: ModelProvider;
  complete: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const complete = vi.fn(async (_req: CompletionRequest): Promise<Completion> => {
    const calls = sequences[Math.min(i, sequences.length - 1)] ?? [];
    i += 1;
    return {
      model: "mock",
      stopReason: calls.length > 0 ? "tool_use" : "end_turn",
      text: calls.length > 0 ? "" : "ok (mock conversational reply)",
      toolCalls: calls as Completion["toolCalls"],
      inputTokens: 1,
      outputTokens: 1,
    };
  });
  return {
    complete,
    model: {
      complete,
      stream: () => {
        throw new Error("stream unused");
      },
      embed: async () => {
        throw new Error("embed unused");
      },
    },
  };
}

const INTENTS = ["order.item.add", "order.cart.ensure"];
const READS = ["get_cart"];

function expressIntent(capability: string, payload: unknown) {
  return { id: `tc-${capability}`, name: EXPRESS_INTENT_TOOL, input: { capability, payload } };
}

function buildPlanner(opts: {
  model: ModelProvider;
  store: ParseCacheStore;
  readToolExecutors?: Record<string, (input: unknown, state: CognitiveState) => Promise<unknown>>;
}) {
  const funnel = createParseFunnel({ parseCacheStore: opts.store });
  const planner = createIbatexasPlanner({
    model: opts.model,
    modelId: "mock-model",
    capabilityPlanners: [capPlanner(READS, INTENTS)],
    parseMemo: funnel as never,
    ...(opts.readToolExecutors ? { readToolExecutors: opts.readToolExecutors } : {}),
  });
  return { planner, funnel };
}

describe("L1 write policy — which parses may be memoized", () => {
  it("memoizes an ordinary single-pass parse", async () => {
    const store = memoryStore();
    const { model } = mockModel([[expressIntent("order.item.add", { item: "coca", quantity: 1 })]]);
    const { planner, funnel } = buildPlanner({ model, store });

    await planner.propose(mkState("quero uma coca"));

    expect(store.entries.size).toBe(1);
    const [entry] = [...store.entries.values()];
    expect(entry!.proposals).toEqual([
      { kind: "order.item.add", payload: { item: "coca", quantity: 1 } },
    ]);
    expect(funnel.counters?.()).toMatchObject({ stores: 1, bypasses: 0, misses: 1 });
  });

  it("REFUSES to memoize a READ-ENRICHED parse — live store state is baked into it", async () => {
    const store = memoryStore();
    // Hop 1 calls a read tool and proposes nothing; hop 2 proposes the intent
    // conditioned on that read's RESULT. The resulting parse is a function of the
    // store, not of the prompt, so it must never be replayed for a later turn.
    const { model } = mockModel([
      [{ id: "tc-read", name: "get_cart", input: {} }],
      [expressIntent("order.item.add", { item: "coca", quantity: 1 })],
    ]);
    const { planner, funnel } = buildPlanner({
      model,
      store,
      readToolExecutors: { get_cart: async () => ({ items: [{ title: "coca" }] }) },
    });

    const plan = await planner.propose(mkState("quero mais um do que eu já pedi"));

    // The parse itself is normal…
    expect(plan.envelopes.map((e) => e.kind)).toEqual(["order.item.add"]);
    // …but nothing was written, and the refusal is COUNTED so the bypass rate is
    // visible rather than looking like an ordinary miss.
    expect(store.entries.size).toBe(0);
    expect(funnel.counters?.()).toMatchObject({ stores: 0, bypasses: 1 });
  });

  it("does not memoize a turn that proposed nothing on a failed extraction", async () => {
    const store = memoryStore();
    // A genuinely-empty completion (no text, no tool calls) is the extraction
    // failure shape; the planner returns its REFUSE envelope and must not pin it.
    const complete = vi.fn(async (): Promise<Completion> => ({
      model: "mock",
      stopReason: "end_turn",
      text: "",
      toolCalls: [],
      inputTokens: 1,
      outputTokens: 1,
    }));
    const model: ModelProvider = {
      complete,
      stream: () => {
        throw new Error("stream unused");
      },
      embed: async () => {
        throw new Error("embed unused");
      },
    };
    const { planner } = buildPlanner({ model, store });

    await planner.propose(mkState("quero uma coca"));

    expect(store.entries.size).toBe(0);
  });
});

describe("L1 read policy — what a hit replays", () => {
  it("re-mints the envelope with a FRESH nonce instead of replaying the stored one", async () => {
    const store = memoryStore();
    const payload = { item: "coca", quantity: 1 };
    const first = mockModel([[expressIntent("order.item.add", payload)]]);
    const { planner } = buildPlanner({ model: first.model, store });

    const plan1 = await planner.propose(mkState("quero uma coca", "turn-1"));
    expect(first.complete).toHaveBeenCalledTimes(1);

    // A second planner over a model that cannot be called — proving the replay
    // came from the store — but sharing the SAME store.
    const throwing: ModelProvider = {
      complete: async () => {
        throw new Error("the extraction wire was reached on a cache hit");
      },
      stream: () => {
        throw new Error("stream unused");
      },
      embed: async () => {
        throw new Error("embed unused");
      },
    };
    const { planner: replayPlanner, funnel } = buildPlanner({ model: throwing, store });
    const plan2 = await replayPlanner.propose(mkState("quero uma coca", "turn-2"));

    // A THIRD turn, also served from the cache. Two replays are what actually
    // expose the hazard: comparing a replay only against the ORIGINAL parse is
    // satisfied by any constant nonce, so it would pass even if every replay
    // shared one identity. Asserting the replays differ from EACH OTHER is what
    // makes "fresh nonce per dispatch" testable at all — measured: a constant-nonce
    // neuter passes the original two-way assertion and fails this one.
    const plan3 = await replayPlanner.propose(mkState("quero uma coca", "turn-3"));

    expect(funnel.counters?.()).toMatchObject({ hits: 2 });
    // Same parse…
    expect(plan2.envelopes.map((e) => e.kind)).toEqual(["order.item.add"]);
    expect(plan2.envelopes[0]!.payload).toEqual(plan1.envelopes[0]!.payload);
    expect(plan3.envelopes[0]!.payload).toEqual(plan1.envelopes[0]!.payload);
    // …three pairwise-distinct identities. Any collision here means the
    // always-on fail-closed execution ledger dedups a genuine customer request
    // against an earlier one.
    const nonces = [plan1, plan2, plan3].map((p) => String(p.envelopes[0]!.nonce));
    expect(new Set(nonces).size).toBe(3);
    const hashes = [plan1, plan2, plan3].map((p) => String(p.envelopes[0]!.intentHash));
    expect(new Set(hashes).size).toBe(3);
    // A replay bills no planner tokens — the completion never happened.
    expect(plan2.usage).toBeUndefined();
    expect(plan1.usage).toBeDefined();
  });

  it("a turn whose surface differs does not read another surface's entry", async () => {
    const store = memoryStore();
    const first = mockModel([[expressIntent("order.item.add", { item: "coca", quantity: 1 })]]);
    const funnelA = createParseFunnel({ parseCacheStore: store });
    const plannerA = createIbatexasPlanner({
      model: first.model,
      modelId: "mock-model",
      capabilityPlanners: [capPlanner(READS, INTENTS)],
      parseMemo: funnelA as never,
    });
    await plannerA.propose(mkState("quero uma coca"));

    // A NARROWER roster ⇒ a different advertised tool surface ⇒ a different key.
    // This is the guard that keeps a guest's parse away from an authenticated
    // customer's, and it is the slot L2's scoped surface will vary.
    const second = mockModel([[expressIntent("order.item.add", { item: "coca", quantity: 1 })]]);
    const funnelB = createParseFunnel({ parseCacheStore: store });
    const plannerB = createIbatexasPlanner({
      model: second.model,
      modelId: "mock-model",
      capabilityPlanners: [capPlanner(READS, ["order.item.add"])],
      parseMemo: funnelB as never,
    });
    await plannerB.propose(mkState("quero uma coca"));

    expect(second.complete).toHaveBeenCalledTimes(1);
    expect(funnelB.counters?.()).toMatchObject({ hits: 0, misses: 1 });
    expect(store.entries.size).toBe(2);
  });
});
