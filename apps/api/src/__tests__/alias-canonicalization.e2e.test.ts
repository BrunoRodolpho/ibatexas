/**
 * LE2-025b turn-seam e2e — alias canonicalization at parse entry, driven through
 * a REAL `handleTurn`, with mocks only at the Redis client boundary and a
 * recording embedder.
 *
 * EXTENDS `customer-e2e-harness.ts`, never rebuilds it.
 *
 * The four claims, each of which fails SILENTLY without a test at this seam:
 *
 *  1. THE L1 SEAM. An aliased utterance and its canonical form must produce the
 *     SAME parse-cache key. Proven the only way that means anything: drive the
 *     colloquial, then drive the canonical form against a model that THROWS on
 *     the extraction surface. A hit is the only way that turn can succeed.
 *  2. THE L2 SEAM. The retrieval query must be built from the CANONICAL text.
 *     Proven by recording what the embedder was actually asked to embed.
 *  3. UN-ALIASED TEXT IS UNTOUCHED, BYTE-IDENTICALLY — read off the
 *     CompletionRequest the model received, not asserted about the helper.
 *  4. AMBIGUITY CLARIFIES, AND THE CUSTOMER NEVER SEES A HANDLE. Zero model
 *     calls, a deterministic pt-BR question, and no internal id in the reply.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CognitiveState,
  CompletionRequest,
  ModelProvider,
  TelemetryPort,
} from "@claustrum/core";
import "./setup.js";

const { redisFake } = vi.hoisted(() => ({
  redisFake: { strings: new Map<string, string>() },
}));

vi.mock("redis", () => {
  const client = {
    isOpen: true,
    on: () => client,
    connect: async () => client,
    quit: async () => undefined,
    get: async (k: string) => redisFake.strings.get(k) ?? null,
    set: async (k: string, v: string) => {
      redisFake.strings.set(k, String(v));
      return "OK";
    },
    setEx: async (k: string, _t: number, v: string) => {
      redisFake.strings.set(k, String(v));
      return "OK";
    },
    del: async (k: string) => (redisFake.strings.delete(k) ? 1 : 0),
    hGetAll: async () => ({}),
    hSet: async () => 1,
    hDel: async () => 1,
    expire: async () => 1,
    multi: () => {
      const chain: Record<string, unknown> = { hSet: () => chain, expire: () => chain, exec: async () => [] };
      return chain;
    },
    duplicate: () => client,
  };
  return { createClient: () => client };
});

const {
  composeCustomerConductor,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulCustomerSession,
  runCustomerTurn,
  scriptedModel,
  plannerThrowingModel,
  throwingModel,
} = await import("./customer-e2e-harness.js");
const { createParseFunnel, funnelStage } = await import("../claustrum/funnel-tier.js");
const { createRedisParseCacheStore } = await import("../claustrum/parse-memo.js");
const { createCapabilityRetriever } = await import("../claustrum/capability-retrieval.js");
// R1-S2 — the opt-out case below drives the PLANNER directly (see its describe).
const { createIbatexasPlanner } = await import("../claustrum/ibatexas-planner.js");
const { deriveIbatexasPlannerContext } = await import(
  "../claustrum/compose-customer-conductor.js"
);
const { IBATEXAS_COMPOSED_CAPABILITY_PLANNERS } = await import("@ibatexas/packs-composed");

const CUSTOMER = "cus_le2025b";

function seedEnv(): void {
  process.env.APP_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.KERNEL_TENANT_ID = "ibatexas";
}

/** Records every text the retriever asked to embed — the L2-seam probe. */
function recordingEmbedder(): { embedded: string[]; embed: (t: string) => Promise<readonly number[]> } {
  const embedded: string[] = [];
  return {
    embedded,
    embed: async (text: string) => {
      embedded.push(text);
      const vec = new Array<number>(16).fill(0.1);
      // Deterministic and deliberately FLAT for queries, so retrieval always takes
      // the low-confidence fallback: this file is about which TEXT reached the
      // retriever, not about what it selected (that is LE2-008's e2e).
      if (text.startsWith("search_document: ")) vec[text.length % 16] = 1;
      return vec;
    },
  };
}

function tierRecordingTelemetry(): {
  telemetry: TelemetryPort;
  tiers: Array<{ turnId: string; tier?: string; reason?: string; detail?: unknown }>;
} {
  const tiers: Array<{ turnId: string; tier?: string; reason?: string; detail?: unknown }> = [];
  return {
    tiers,
    telemetry: {
      emitTurn: async (record) => {
        const stage = funnelStage(record.turnId);
        tiers.push({
          turnId: record.turnId,
          ...(stage ? { tier: stage.tier, reason: stage.reason, detail: stage.detail } : {}),
        });
      },
      emitLLMTrace: async () => {},
      emitMemoryAccess: async () => {},
    },
  };
}

const NOTE_CALL = [
  {
    id: "tu_le2025b",
    name: "express_intent",
    input: { capability: "order.note.add", payload: { body: "anotação" } },
  },
];

function buildHarness(opts: {
  model: ReturnType<typeof scriptedModel>;
  funnel: ReturnType<typeof createParseFunnel>;
  embedder?: ReturnType<typeof recordingEmbedder>;
  telemetry?: TelemetryPort;
  realResponder?: boolean;
}) {
  vi.stubGlobal("fetch", async () => {
    throw new Error("no Medusa egress expected in this suite");
  });
  const sink = makeCapturingAuditSink();
  const harness = composeCustomerConductor({
    model: opts.model,
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink }),
    funnel: opts.funnel,
    aliasSeam: opts.funnel,
    ...(opts.funnel.lookupParse !== undefined ? { parseMemo: opts.funnel as never } : {}),
    ...(opts.embedder
      ? {
          retriever: createCapabilityRetriever({ embedder: opts.embedder }),
          scopeSeam: opts.funnel,
        }
      : {}),
    ...(opts.telemetry ? { telemetry: opts.telemetry } : {}),
    ...(opts.realResponder ? { realResponder: true } : {}),
  });
  return { harness, sink };
}

/** The user message the model ACTUALLY received on its extraction call. */
function sentUserMessage(model: ReturnType<typeof scriptedModel>): string {
  const complete = model.complete as unknown as { mock: { calls: Array<[CompletionRequest]> } };
  const req = complete.mock.calls.find((c) => (c[0].tools?.length ?? 0) > 0)?.[0];
  const messages = req?.messages ?? [];
  return String((messages[messages.length - 1] as { content?: unknown } | undefined)?.content ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  redisFake.strings.clear();
  seedEnv();
});

describe("LE2-025b — canonicalization at parse entry feeds the L1 key and the L2 query", () => {
  it("SEAM 1 (L1): an aliased utterance and its canonical form share a cache key and hit each other", async () => {
    const funnel = createParseFunnel({ parseCacheStore: createRedisParseCacheStore() });
    const conversationId = "conv_alias_l1";

    // Turn 1 — the COLLOQUIAL. Parses for real and memoizes under the canonical key.
    const first = buildHarness({ model: scriptedModel(NOTE_CALL), funnel });
    await runCustomerTurn(first.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: "adiciona uma farofa ao carrinho",
    });
    expect(funnel.counters?.()).toMatchObject({ misses: 1, stores: 1 });

    // Turn 2 — the CANONICAL FORM of the same request, against a model that throws
    // on the extraction surface. Only a cache hit can carry this turn.
    const second = buildHarness({
      model: plannerThrowingModel("LE2-025b L1 alias-key proof") as ReturnType<typeof scriptedModel>,
      funnel,
    });
    await runCustomerTurn(second.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: "adiciona uma farofa-de-bacon-defumado ao carrinho",
    });

    expect(funnel.counters?.()).toMatchObject({ hits: 1 });
  });

  it("SEAM 1 (negative): a DIFFERENT request does not collide with the aliased one", async () => {
    const funnel = createParseFunnel({ parseCacheStore: createRedisParseCacheStore() });
    const conversationId = "conv_alias_l1_neg";
    const first = buildHarness({ model: scriptedModel(NOTE_CALL), funnel });
    await runCustomerTurn(first.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: "adiciona uma farofa ao carrinho",
    });
    const second = buildHarness({ model: scriptedModel(NOTE_CALL), funnel });
    await runCustomerTurn(second.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: "adiciona uma mandioca ao carrinho",
    });
    // Two misses: aliasing collapses SYNONYMS, never distinct requests.
    expect(funnel.counters?.()).toMatchObject({ hits: 0, misses: 2 });
  });

  it("SEAM 2 (L2): the retrieval query is built from the CANONICAL text", async () => {
    const funnel = createParseFunnel();
    const embedder = recordingEmbedder();
    const { harness } = buildHarness({ model: scriptedModel(NOTE_CALL), funnel, embedder });

    await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: "conv_alias_l2",
      text: "adiciona uma farofa ao carrinho",
    });

    const queries = embedder.embedded.filter((t) => t.startsWith("search_query: "));
    expect(queries).toHaveLength(1);
    // The canonical handle reached retrieval…
    expect(queries[0]).toContain("farofa-de-bacon-defumado");
    // …and the raw colloquial did not survive as a bare word in the query.
    expect(queries[0]).toBe("search_query: adiciona uma farofa-de-bacon-defumado ao carrinho");
  });

  it("SEAM 3: un-aliased text reaches the model BYTE-IDENTICALLY", async () => {
    const funnel = createParseFunnel();
    const model = scriptedModel(NOTE_CALL);
    const { harness } = buildHarness({ model, funnel });
    const text = "vocês entregam em Ibaté?";

    await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: "conv_alias_passthrough",
      text,
    });

    expect(sentUserMessage(model)).toBe(text);
    expect(funnel.aliasCounters()).toMatchObject({ canonicalized: 0, resolutions: 0 });
  });

  it("an ALIASED utterance reaches the model canonicalized, and the resolution is in the trace", async () => {
    const funnel = createParseFunnel();
    const model = scriptedModel(NOTE_CALL);
    const t = tierRecordingTelemetry();
    const { harness } = buildHarness({ model, funnel, telemetry: t.telemetry });

    const result = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: "conv_alias_rewrite",
      text: "poe mais uma farofa no pedido",
    });

    expect(sentUserMessage(model)).toBe("poe mais uma farofa-de-bacon-defumado no pedido");
    // "why did it read farofa as farofa-de-bacon-defumado" stays answerable.
    expect(funnel.aliasResolutions(result.turnId)).toEqual([
      { surface: "farofa", canonical: "farofa-de-bacon-defumado" },
    ]);
    expect(funnel.aliasCounters()).toMatchObject({ canonicalized: 1, resolutions: 1 });
  });
});

describe("LE2-025b — an ambiguous surface clarifies, never guesses", () => {
  it("makes ZERO model calls, claims the turn as ALIAS, and proposes nothing", async () => {
    const funnel = createParseFunnel();
    const t = tierRecordingTelemetry();
    const { harness, sink } = buildHarness({
      // Throws on EVERY surface: the clarify reply is a deterministic template, so
      // this turn must not touch the wire at all.
      model: throwingModel("LE2-025b alias-clarify zero-call proof") as ReturnType<typeof scriptedModel>,
      funnel,
      telemetry: t.telemetry,
      realResponder: true,
    });

    const result = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: "conv_alias_clarify",
      text: "tira a costela do meu carrinho",
    });

    // NO CAPABILITY was proposed. The only record is the conductor's own
    // `noop`/REFUSE for an empty plan — the exact shape an L0 turn produces, so
    // asserting zero records would assert the conductor's behaviour, not this
    // tier's. What matters is that nothing the customer did not ask for was
    // adjudicated.
    expect(sink.records.map((r) => String(r.envelope.kind))).toEqual(["noop"]);
    // The tier is attributed at the production seam.
    expect(t.tiers[0]).toMatchObject({ tier: "ALIAS", reason: "alias_ambiguous" });
    expect((t.tiers[0]!.detail as Record<string, unknown>).surface).toBe("costela");

    // THE CUSTOMER-VISIBILITY RULE: the reply asks in their words and never leaks
    // an internal handle.
    expect(result.response).toContain("costela");
    expect(result.response).toContain("bovina");
    expect(result.response).not.toContain("costela-bovina-defumada");
    expect(result.response).not.toContain("costela-defumada-congelada");
  });

  it("the SAME surface parses normally once the utterance disambiguates it", async () => {
    const funnel = createParseFunnel();
    const model = scriptedModel(NOTE_CALL);
    const t = tierRecordingTelemetry();
    const { harness } = buildHarness({ model, funnel, telemetry: t.telemetry });

    const result = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: "conv_alias_disambiguated",
      text: "tira a costela congelada do meu carrinho",
    });

    // No clarify: the turn reached the model, canonicalized.
    expect(sentUserMessage(model)).toContain("costela-defumada-congelada");
    expect(t.tiers[0]?.tier).not.toBe("ALIAS");
    expect(funnel.aliasResolutions(result.turnId)[0]).toMatchObject({
      canonical: "costela-defumada-congelada",
      disambiguatedBy: "congelada",
    });
  });
});

// ── R1-S2 · THE OPT-OUT MOVED DOWN TO THE SEAM THAT OWNS IT ──────────────────
//
// This case used to compose a harness with `funnel` and omit `aliasSeam`. That
// composition no longer exists: the customer conductor is now composed by the ONE
// production composer, which fans a single funnel instance into every tier seam and
// wires `aliasSeam` UNCONDITIONALLY — deliberately, because canonicalization is
// deterministic catalog data with nothing to degrade to. So a customer plane with a
// funnel but no alias layer is not a state production can be in, and asserting it
// through the harness was asserting a divergence rather than a property.
//
// The opt-out is REAL, though — it is a PLANNER property (`aliasSeam === undefined`
// ⟹ `canonicalizeAliases` is never called), and the OPS plane relies on it. So the
// coverage moves to the seam that owns it: `createIbatexasPlanner` driven directly,
// over the same composed capability planners and the same context derivation the
// customer composition uses, so the surface the planner sees is production's.
//
// The two cases are a PAIR, and the pairing is what makes the negative meaningful: a
// "text reached the model untouched" assertion passes trivially if canonicalization
// is broken, absent, or never reached in this construction. The control proves the
// mechanism is live on the very same planner build.
describe("LE2-025b — opt-out (planner seam)", () => {
  const COLLOQUIAL = "adiciona uma farofa ao carrinho";
  const CANONICAL = "adiciona uma farofa-de-bacon-defumado ao carrinho";

  function plannerState(text: string): CognitiveState {
    return {
      perception: { text, channel: "web", receivedAt: "2026-07-25T12:00:00.000Z" },
      // The ONE field `deriveIbatexasPlannerContext` reads to decide the actor, and
      // therefore what is proposable — without a real customer the authenticated
      // kinds vanish, the tool surface can empty out, and the planner would return
      // before ever reaching the model. That would make BOTH cases vacuous.
      memory: { customerId: CUSTOMER } as unknown as CognitiveState["memory"],
      retrieval: {} as CognitiveState["retrieval"],
      tenantId: "ibatexas",
      locale: "pt-BR",
      conversationId: "conv_alias_optout",
      turnId: "turn_alias_optout",
    };
  }

  function buildPlanner(opts: { model: ModelProvider; withAliasSeam: boolean }) {
    const funnel = createParseFunnel();
    const planner = createIbatexasPlanner({
      model: opts.model,
      modelId: "mock-model",
      capabilityPlanners: IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
      deriveContext: deriveIbatexasPlannerContext,
      ...(opts.withAliasSeam ? { aliasSeam: funnel } : {}),
    });
    return { planner, funnel };
  }

  it("WITHOUT the alias seam the utterance reaches the model byte-identically", async () => {
    const model = scriptedModel(NOTE_CALL);
    const { planner, funnel } = buildPlanner({ model, withAliasSeam: false });

    await planner.propose(plannerState(COLLOQUIAL));

    // Anti-vacuity: the model must actually have been asked to parse. Without this a
    // planner that returned early (empty tool surface) would satisfy the assertion
    // below with an empty string.
    expect(sentUserMessage(model)).toBe(COLLOQUIAL);
    expect(funnel.aliasCounters()).toMatchObject({ canonicalized: 0, resolutions: 0 });
  });

  it("THE CONTROL: the SAME planner build WITH the seam does canonicalize", async () => {
    const model = scriptedModel(NOTE_CALL);
    const { planner, funnel } = buildPlanner({ model, withAliasSeam: true });

    await planner.propose(plannerState(COLLOQUIAL));

    expect(sentUserMessage(model)).toBe(CANONICAL);
    expect(funnel.aliasCounters()).toMatchObject({ canonicalized: 1, resolutions: 1 });
  });
});
