/**
 * LE2-008 turn-seam e2e — the funnel's L2 tier (scoped parse) driven through a
 * REAL `handleTurn` into the REAL checkout executor, with mocks only at the
 * Stripe / Medusa / Redis CLIENT boundary and a controllable embedder.
 *
 * EXTENDS `customer-e2e-harness.ts`, never rebuilds it.
 *
 * What this file proves, and why each claim needs the turn seam rather than a
 * unit test — every one of these is about what actually reaches the wire:
 *
 *  1. A CONFIDENT TURN REALLY SHIPS A NARROWER SURFACE. Asserted by reading the
 *     `express_intent` enum out of the CompletionRequest the model received, not
 *     by trusting the retriever's return value.
 *  2. A LOW-CONFIDENCE TURN REALLY SHIPS TODAY'S FULL ROSTER. Same seam, opposite
 *     direction — this is the "coverage can never regress" half, and it is the
 *     one that must never quietly stop working.
 *  3. THE PROMPT PREFIX IS BYTE-STABLE. The system prompt is byte-identical
 *     across a scoped turn and a fallback turn on different utterances; only
 *     `tools` varies, and the utterance is the last message. That is the exact
 *     layout decision 12 asks for (static head, variable material in the tail,
 *     utterance last), asserted at byte level.
 *  4. TIER ATTRIBUTION IS UNAMBIGUOUS. Exactly one tier per turn, read at
 *     `emitTurn` — the seam production stamps from.
 *  5. A DEAD EMBEDDER WIDENS. The failure direction that matters.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, TelemetryPort } from "@claustrum/core";
import "./setup.js";

const { redisFake, stripeConfirm, stripeUpdate } = vi.hoisted(() => ({
  redisFake: { strings: new Map<string, string>(), hashes: new Map<string, Record<string, string>>() },
  stripeConfirm: vi.fn(),
  stripeUpdate: vi.fn(),
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
    hGetAll: async (k: string) => redisFake.hashes.get(k) ?? {},
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

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    paymentIntents: { confirm: stripeConfirm, update: stripeUpdate, retrieve: vi.fn() },
  })),
}));

const {
  composeCustomerConductor,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeCartFixture,
  makeMedusaFetchFake,
  makeStatefulCustomerSession,
  runCustomerTurn,
  scriptedModel,
} = await import("./customer-e2e-harness.js");
const { createParseFunnel, funnelStage } = await import("../claustrum/funnel-tier.js");
const { createRedisParseCacheStore } = await import("../claustrum/parse-memo.js");
const { createCapabilityRetriever, RETRIEVAL_K } = await import("../claustrum/capability-retrieval.js");
const { rk } = await import("@ibatexas/tools");
const { loadCartCtx } = await import("../claustrum/resolve-and-assemble.js");

const CUSTOMER = "cus_le2008_owner";
const CART_ID = "cart_le2008";
const CHECKOUT_UTTERANCE = "fecha o pedido, pago no pix, retiro no balcão";

function seedEnv(): void {
  process.env.APP_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.MEDUSA_URL = "http://medusa.test";
  process.env.MEDUSA_ADMIN_EMAIL = "admin@test.local";
  process.env.MEDUSA_ADMIN_PASSWORD = "harness-password";
  process.env.STRIPE_SECRET_KEY = "sk_test_le2008";
  process.env.KERNEL_TENANT_ID = "ibatexas";
}

/**
 * A DETERMINISTIC embedder standing in for nomic-embed-text. Documents get an
 * axis per capability; a query is aimed at one axis with a controllable spread,
 * so a test can dial the boundary margin directly instead of hoping the real
 * model lands on the right side of the threshold. The retriever, the margin
 * arithmetic and the decision are all the REAL ones — only the vectors are
 * synthetic, which is the same boundary the harness draws everywhere else
 * (fake the outermost client, never the logic under test).
 */
function fakeEmbedder(opts: { readonly confident: boolean }) {
  const axisFor = (text: string): number => {
    // Stable per-document axis from the kind embedded in the document text.
    const m = /search_document: ([a-z ]+)\./.exec(text);
    const key = m?.[1] ?? text;
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 997;
    return h % 32;
  };
  return {
    embed: async (text: string): Promise<readonly number[]> => {
      const vec = new Array<number>(32).fill(0.01);
      if (text.startsWith("search_document: ")) {
        vec[axisFor(text)] = 1;
        return vec;
      }
      // A QUERY. Confident: one sharp axis (big margin at the K boundary).
      // Otherwise: flat, so every capability ties and the margin collapses.
      if (!opts.confident) return new Array<number>(32).fill(0.5);
      const target = axisFor("search_document: order checkout create.");
      vec[target] = 1;
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

function buildHarness(opts: {
  conversationId: string;
  confident?: boolean;
  deadEmbedder?: boolean;
  noRetriever?: boolean;
  telemetry?: TelemetryPort;
  /** Share ONE funnel (and so one parse cache) across harnesses — the L1×L2 test. */
  funnel?: ReturnType<typeof createParseFunnel>;
}) {
  const cart = makeCartFixture({ id: CART_ID, total: 500 });
  vi.stubGlobal("fetch", makeMedusaFetchFake(cart).fetch);
  redisFake.strings.set(rk(`cart:active:session:${opts.conversationId}`), CART_ID);
  redisFake.hashes.set(rk(`customer:pix:${CUSTOMER}`), {
    name: "João Silva",
    email: "joao@example.com",
    cpf: "123.456.789-09",
  });

  const funnel = opts.funnel ?? createParseFunnel();
  const model = scriptedModel([
    {
      id: "tu_le2008",
      name: "express_intent",
      input: {
        capability: "order.checkout.create",
        payload: { payment_method: "pix", delivery_type: "pickup" },
      },
    },
  ]);
  const embedder = opts.deadEmbedder
    ? { embed: async (): Promise<readonly number[]> => { throw new Error("ECONNREFUSED"); } }
    : fakeEmbedder({ confident: opts.confident ?? true });
  const retriever = opts.noRetriever ? undefined : createCapabilityRetriever({ embedder });

  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession();
  const harness = composeCustomerConductor({
    model,
    session,
    adjudicator: makeAuditedAdjudicator({
      sink,
      projectResumeState: async (envelope) => {
        const payload = (envelope.payload ?? {}) as Record<string, unknown>;
        const ctx = await loadCartCtx(
          {
            tenantId: "ibatexas",
            channel: "web",
            customerId: CUSTOMER,
            staffId: null,
            isAuthenticated: true,
          } as never,
          payload as never,
          { sessionId: opts.conversationId },
        );
        return { ctx } as never;
      },
    }),
    funnel,
    ...(funnel.lookupParse !== undefined ? { parseMemo: funnel as never } : {}),
    ...(retriever ? { retriever, scopeSeam: funnel } : {}),
    ...(opts.telemetry ? { telemetry: opts.telemetry } : {}),
  });
  return { harness, sink, session, model, funnel };
}

/** The `express_intent` capability enum the model ACTUALLY received. */
function advertisedEnum(model: ReturnType<typeof scriptedModel>): string[] {
  const complete = model.complete as unknown as { mock: { calls: Array<[CompletionRequest]> } };
  const req = complete.mock.calls.find((c) => (c[0].tools?.length ?? 0) > 0)?.[0];
  const tool = req?.tools?.find((t) => t.name === "express_intent");
  const schema = tool?.inputSchema as
    | { properties?: { capability?: { enum?: string[] } } }
    | undefined;
  return schema?.properties?.capability?.enum ?? [];
}

/** The system prompt the model ACTUALLY received on its planner call. */
function advertisedSystem(model: ReturnType<typeof scriptedModel>): string {
  const complete = model.complete as unknown as { mock: { calls: Array<[CompletionRequest]> } };
  return complete.mock.calls.find((c) => (c[0].tools?.length ?? 0) > 0)?.[0].system ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  redisFake.strings.clear();
  redisFake.hashes.clear();
  seedEnv();
  stripeConfirm.mockResolvedValue({
    id: "pi_le2008",
    status: "requires_action",
    next_action: {
      pix_display_qr_code: { data: "00020126580014br.gov.bcb.pix", image_url_svg: "x", expires_at: 1786000000 },
    },
  });
  stripeUpdate.mockResolvedValue({ id: "pi_le2008" });
});

describe("LE2-008 turn seam — L2 scopes the parse, and falls back rather than lose coverage", () => {
  it("a CONFIDENT turn advertises only the top-K capabilities, and still executes", async () => {
    const t = tierRecordingTelemetry();
    const { harness, sink, model } = buildHarness({
      conversationId: "conv_l2_scoped",
      confident: true,
      telemetry: t.telemetry,
    });

    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: "conv_l2_scoped",
      text: CHECKOUT_UTTERANCE,
    });

    // The surface that reached the model really is narrower than the roster.
    const advertised = advertisedEnum(model);
    expect(advertised).toHaveLength(RETRIEVAL_K);
    expect(advertised).toContain("order.checkout.create");

    // The turn still does its job end to end.
    expect(turn.decision.kind).toBe("EXECUTE");
    expect(
      sink.byKind("order.checkout.create").filter((r) => r.decision.kind === "EXECUTE"),
    ).toHaveLength(1);

    // Trace: the retriever's selection, K and confidence, at the production seam.
    expect(t.tiers).toHaveLength(1);
    expect(t.tiers[0]).toMatchObject({ tier: "L2", reason: "scoped_parse" });
    const detail = t.tiers[0]!.detail as Record<string, unknown>;
    expect(detail.k).toBe(RETRIEVAL_K);
    expect(String(detail.selected).split(",")).toContain("order.checkout.create");
    expect(Number(detail.confidence)).toBeGreaterThan(0);
    expect(detail.scopeReason).toBe("scoped");
  });

  it("a LOW-CONFIDENCE turn falls back to TODAY'S FULL ROSTER — coverage never regresses", async () => {
    const t = tierRecordingTelemetry();
    const { harness, model } = buildHarness({
      conversationId: "conv_l2_fallback",
      confident: false,
      telemetry: t.telemetry,
    });

    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: "conv_l2_fallback",
      text: CHECKOUT_UTTERANCE,
    });

    // The whole authenticated roster went on the wire, not a scoped subset.
    const advertised = advertisedEnum(model);
    expect(advertised.length).toBeGreaterThan(RETRIEVAL_K);
    expect(advertised).toContain("order.checkout.create");
    expect(turn.decision.kind).toBe("EXECUTE");

    // The fallback is VISIBLE in the trace — the ticket's "fallback rate" AC.
    expect(t.tiers[0]).toMatchObject({ tier: "L2", reason: "full_roster_fallback" });
    expect((t.tiers[0]!.detail as Record<string, unknown>).scopeReason).toBe("low_confidence");
  });

  it("a DEAD embedder falls back too — a retriever fault never narrows the surface", async () => {
    const t = tierRecordingTelemetry();
    const { harness, model } = buildHarness({
      conversationId: "conv_l2_dead",
      deadEmbedder: true,
      telemetry: t.telemetry,
    });

    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: "conv_l2_dead",
      text: CHECKOUT_UTTERANCE,
    });

    expect(advertisedEnum(model).length).toBeGreaterThan(RETRIEVAL_K);
    expect(turn.decision.kind).toBe("EXECUTE");
    expect((t.tiers[0]!.detail as Record<string, unknown>).scopeReason).toBe(
      "retriever_unavailable",
    );
  });

  it("PREFIX STABILITY: the system prompt is byte-identical across a scoped and a fallback turn", async () => {
    // Decision 12's layout: byte-stable static head, retrieved variable material
    // in the tail, utterance last. Retrieval must therefore change `tools` and
    // NOTHING about the prompt — otherwise every scoped turn would invalidate the
    // model's cacheable prefix, which is the cost this layout exists to avoid.
    const scoped = buildHarness({ conversationId: "conv_l2_prefix_a", confident: true });
    await runCustomerTurn(scoped.harness, {
      customerId: CUSTOMER,
      conversationId: "conv_l2_prefix_a",
      text: CHECKOUT_UTTERANCE,
    });

    const fallback = buildHarness({ conversationId: "conv_l2_prefix_b", confident: false });
    await runCustomerTurn(fallback.harness, {
      customerId: CUSTOMER,
      conversationId: "conv_l2_prefix_b",
      text: "quero cancelar o pedido 4242",
    });

    const scopedSystem = advertisedSystem(scoped.model);
    const fallbackSystem = advertisedSystem(fallback.model);
    expect(scopedSystem.length).toBeGreaterThan(0);
    // BYTE-IDENTICAL — different utterances, different scope decisions, same head.
    expect(scopedSystem).toBe(fallbackSystem);
    // …while the variable material genuinely did vary.
    expect(advertisedEnum(scoped.model)).not.toEqual(advertisedEnum(fallback.model));
  });

  it("PREFIX STABILITY: the utterance is the LAST message, and the only user content", async () => {
    const { harness, model } = buildHarness({ conversationId: "conv_l2_last", confident: true });
    await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: "conv_l2_last",
      text: CHECKOUT_UTTERANCE,
    });
    const complete = model.complete as unknown as { mock: { calls: Array<[CompletionRequest]> } };
    const req = complete.mock.calls.find((c) => (c[0].tools?.length ?? 0) > 0)?.[0];
    const messages = req?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[messages.length - 1]).toMatchObject({
      role: "user",
      content: CHECKOUT_UTTERANCE,
    });
  });

  it("L1 × L2: a turn L1 resolves is attributed L1 and NEVER also L2", async () => {
    // The tier-attribution contract the funnel owes the trace: EXACTLY ONE tier
    // per turn. L2 decides its scope BEFORE the L1 lookup (the scoped surface is
    // part of L1's cache key), so the naive wiring would stamp L2 on every turn
    // including the ones L1 then resolves — double-counting the tier in the trace
    // and reporting a scoped parse for a turn that never called the model. The
    // planner therefore stamps L2 only AFTER L1 has missed.
    const funnel = createParseFunnel({ parseCacheStore: createRedisParseCacheStore() });
    const conversationId = "conv_l1_x_l2";

    // Turn 1 — L1 misses, L2 scopes, the model is called, the parse is memoized.
    const t1 = tierRecordingTelemetry();
    const first = buildHarness({ conversationId, confident: true, funnel, telemetry: t1.telemetry });
    await runCustomerTurn(first.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: CHECKOUT_UTTERANCE,
    });
    expect(t1.tiers[0]).toMatchObject({ tier: "L2", reason: "scoped_parse" });

    // Turn 2 — the identical utterance. L1 hits and the turn never reaches the
    // model, so the ONLY tier on it is L1.
    const t2 = tierRecordingTelemetry();
    const second = buildHarness({ conversationId, confident: true, funnel, telemetry: t2.telemetry });
    await runCustomerTurn(second.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: CHECKOUT_UTTERANCE,
    });

    expect(t2.tiers).toHaveLength(1);
    expect(t2.tiers[0]).toMatchObject({ tier: "L1", reason: "memoized_parse" });
    expect(t2.tiers[0]!.reason).not.toBe("scoped_parse");
    // And L2's counters did not tick for the L1-resolved turn: one scope decision
    // was recorded across both turns, not two.
    expect(funnel.scopeCounters()).toMatchObject({ scoped: 1 });
  });

  it("without a retriever the planner is byte-identical to its pre-L2 behaviour", async () => {
    const t = tierRecordingTelemetry();
    const { harness, model } = buildHarness({
      conversationId: "conv_l2_optout",
      noRetriever: true,
      telemetry: t.telemetry,
    });
    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: "conv_l2_optout",
      text: CHECKOUT_UTTERANCE,
    });
    expect(turn.decision.kind).toBe("EXECUTE");
    expect(advertisedEnum(model).length).toBeGreaterThan(RETRIEVAL_K);
    // No retriever ⇒ no stamp ⇒ the turn carries NO tier at all.
    expect(t.tiers).toEqual([{ turnId: turn.turnId }]);
  });
});
