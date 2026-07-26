/**
 * LE2-009 turn-seam e2e — the funnel's L1 tier (exact-match parse memoization)
 * driven through a REAL `handleTurn` into the REAL checkout executor, with mocks
 * only at the Stripe / Medusa / Redis CLIENT boundary.
 *
 * EXTENDS `customer-e2e-harness.ts` (BKL-230 / LE2-007), never rebuilds it. What
 * is real here is everything above the client boundary: the production planner
 * (so the cache sits in the real `propose`), the real resolver, the REAL audited
 * kernel, the real tool registry and the real responder. Only the model and the
 * outermost I/O clients are doubles.
 *
 * The three claims this file exists to prove, each of which dies silently without
 * a test at this seam:
 *
 *  1. AN IDENTICAL REPEAT COSTS NOTHING ON THE WIRE. Turn 2 runs against
 *     `throwingModel`, which throws on EVERY surface, so the absence of a model
 *     call is proven by construction rather than by counting — a spy would let a
 *     regression pass with a number nobody asserted. The turn is zero-call END TO
 *     END because the parse is replayed AND the reply is the customer plane's
 *     deterministic action render (`renderCustomerActionAnswer`, wired here exactly
 *     as `claustrum-bootstrap` wires it), so no seam needs to author prose.
 *     Where a turn's reply would legitimately need synthesis, the narrower
 *     `plannerThrowingModel` is used instead and the claim narrows with it: L1
 *     removes the EXTRACTION call, and only L0 answers from a template.
 *
 *  2. THE REPLAYED ENVELOPE IS RE-MINTED, NOT REPLAYED. Same kind, same payload,
 *     but a DIFFERENT `intentHash`. This is the ticket's central hazard: per
 *     `@adjudicate/core`, `nonce` is "the load-bearing idempotency key" and
 *     `intentHash` content-addresses it, so a verbatim replay would collide with
 *     the first turn's hash and the always-on fail-closed execution ledger would
 *     dedup the customer's SECOND genuine request against their first. A cache
 *     that silently eats every repeated order is a money-path defect, and the
 *     hash assertion below is the only thing standing between that and prod.
 *
 *  3. THE PARSE IS CACHED; THE ANSWER NEVER IS. Two byte-identical asks either
 *     side of a store change produce DIFFERENT decisions and DIFFERENT replies
 *     from the SAME cached parse — because RESOLVE re-hydrates, the kernel
 *     re-adjudicates against live totals, and the executor re-reads. That is the
 *     stale-answer proof, and it is the reason this tier is safe at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryPort } from "@claustrum/core";
import "./setup.js";
import type { FunnelParseMemoSeam } from "../claustrum/funnel-tier.js";

// ── Client-boundary mocks (must be hoisted in the TEST file, not the harness) ──

const { redisFake, stripeConfirm, stripeUpdate } = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  return {
    redisFake: { strings, hashes },
    stripeConfirm: vi.fn(),
    stripeUpdate: vi.fn(),
  };
});

vi.mock("redis", () => {
  const client = {
    isOpen: true,
    on: () => client,
    connect: async () => client,
    quit: async () => undefined,
    get: async (key: string) => redisFake.strings.get(key) ?? null,
    set: async (key: string, value: string) => {
      redisFake.strings.set(key, String(value));
      return "OK";
    },
    // The L1 parse cache writes through setEx (key + TTL). Absent from the
    // BKL-230 double because nothing there needed it.
    setEx: async (key: string, _ttl: number, value: string) => {
      redisFake.strings.set(key, String(value));
      return "OK";
    },
    del: async (key: string) => (redisFake.strings.delete(key) ? 1 : 0),
    hGetAll: async (key: string) => redisFake.hashes.get(key) ?? {},
    hSet: async (key: string, field: string, value: string) => {
      const h = redisFake.hashes.get(key) ?? {};
      h[field] = String(value);
      redisFake.hashes.set(key, h);
      return 1;
    },
    hDel: async () => 1,
    expire: async () => 1,
    multi: () => {
      const chain: Record<string, unknown> = {
        hSet: () => chain,
        expire: () => chain,
        exec: async () => [],
      };
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
  plannerThrowingModel,
  scriptedModel,
  throwingModel,
} = await import("./customer-e2e-harness.js");
const { createParseFunnel, funnelStage } = await import("../claustrum/funnel-tier.js");
const { createRedisParseCacheStore } = await import("../claustrum/parse-memo.js");
const { renderCustomerActionAnswer } = await import("../claustrum/customer-action-render.js");
const { rk } = await import("@ibatexas/tools");
const { loadCartCtx } = await import("../claustrum/resolve-and-assemble.js");

const CUSTOMER = "cus_le2009_owner";
const CART_ID = "cart_le2009";

/** Names BOTH slots the checkout guards require, so the turn reaches the money band. */
const CHECKOUT_UTTERANCE = "fecha o pedido, pago no pix, retiro no balcão";

/** Under the R$1.000 `confirmLargeTicket` band ⇒ a one-turn EXECUTE, no park. */
const CART_TOTAL_EXECUTES = 500;
/** At/above the band ⇒ REQUEST_CONFIRMATION. The store change the repeat re-reads. */
const CART_TOTAL_PARKS = 1500;

function seedEnv(): void {
  process.env.APP_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.MEDUSA_URL = "http://medusa.test";
  process.env.MEDUSA_ADMIN_EMAIL = "admin@test.local";
  process.env.MEDUSA_ADMIN_PASSWORD = "harness-password";
  process.env.STRIPE_SECRET_KEY = "sk_test_le2009";
  process.env.KERNEL_TENANT_ID = "ibatexas";
}

/** The scripted parse every turn-1 produces — the thing that gets memoized. */
function checkoutToolCall() {
  return [
    {
      id: "tu_le2009",
      name: "express_intent",
      input: {
        capability: "order.checkout.create",
        // The SNAKE_CASE wire keys the model really emits; the real resolver
        // renames them and hydrates cartId.
        payload: { payment_method: "pix", delivery_type: "pickup" },
      },
    },
  ];
}

/**
 * One conductor over a caller-supplied model, sharing ONE funnel instance (and so
 * ONE parse cache) across every harness this test builds — which is the point:
 * turn 2 must find what turn 1 stored.
 */
function buildHarness(opts: {
  model: ReturnType<typeof scriptedModel>;
  funnel: ReturnType<typeof createParseFunnel>;
  conversationId: string;
  cartTotal: number;
  telemetry?: TelemetryPort;
}) {
  const cart = makeCartFixture({ id: CART_ID, total: opts.cartTotal });
  const medusa = makeMedusaFetchFake(cart);
  vi.stubGlobal("fetch", medusa.fetch);
  redisFake.strings.set(rk(`cart:active:session:${opts.conversationId}`), CART_ID);
  // The stored payer identity a PIX checkout requires; without it `createCheckout`
  // returns the "Nome e email são obrigatórios" refusal and never reaches Stripe —
  // i.e. the executor would not actually run and the re-mint proof would be vacuous.
  redisFake.hashes.set(rk(`customer:pix:${CUSTOMER}`), {
    name: "João Silva",
    email: "joao@example.com",
    cpf: "123.456.789-09",
  });

  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession();
  const adjudicator = makeAuditedAdjudicator({
    sink,
    projectResumeState: async (envelope) => {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      const ctx = await loadCartCtx(
        {
          tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
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
  });

  const harness = composeCustomerConductor({
    model: opts.model,
    session,
    adjudicator,
    funnel: opts.funnel,
    // Only when the funnel ACTUALLY carries L1 — the same guard the composition
    // root uses. Casting a store-less funnel in unconditionally would fake the
    // opt-out case into passing.
    ...(opts.funnel.lookupParse !== undefined
      ? { parseMemo: opts.funnel as FunnelParseMemoSeam }
      : {}),
    ...(opts.telemetry !== undefined ? { telemetry: opts.telemetry } : {}),
    realResponder: true,
    readAnswer: {
      render: () => undefined,
      renderAction: (acted: unknown) => renderCustomerActionAnswer(acted),
    },
  });
  return { harness, sink, session, medusa };
}

/** A funnel WITH the L1 parse cache wired over the mocked Redis. */
function funnelWithCache() {
  return createParseFunnel({ parseCacheStore: createRedisParseCacheStore() });
}


/**
 * Records the funnel tier + this turn's model token total at the loop's
 * ONCE-PER-TURN seam — the SAME read `bootstrapClaustrum`'s `emitTurn` performs to
 * stamp the per-turn trace line (LE2-007's idiom, reused verbatim).
 *
 * This is the only correct place to assert tier attribution: `runCustomerTurn`
 * clears the per-turn stage in its `finally` (production ingresses do the same),
 * so reading `funnelStage(turnId)` AFTER a turn always returns undefined. A test
 * that asserted there would be asserting cleanup, not attribution.
 */
function tierRecordingTelemetry(): {
  telemetry: TelemetryPort;
  tiers: Array<{ turnId: string; tier?: string; reason?: string; keyVersion?: unknown }>;
  tokens: Array<{ turnId: string; total: number }>;
} {
  const tiers: Array<{ turnId: string; tier?: string; reason?: string; keyVersion?: unknown }> = [];
  const tokens: Array<{ turnId: string; total: number }> = [];
  return {
    tiers,
    tokens,
    telemetry: {
      emitTurn: async (record) => {
        const stage = funnelStage(record.turnId);
        tiers.push({
          turnId: record.turnId,
          ...(stage
            ? { tier: stage.tier, reason: stage.reason, keyVersion: stage.detail.keyVersion }
            : {}),
        });
        tokens.push({
          turnId: record.turnId,
          total: (record.inputTokens ?? 0) + (record.outputTokens ?? 0),
        });
      },
      emitLLMTrace: async () => {},
      emitMemoryAccess: async () => {},
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  redisFake.strings.clear();
  redisFake.hashes.clear();
  seedEnv();
  stripeConfirm.mockResolvedValue({
    id: "pi_le2009",
    status: "requires_action",
    next_action: {
      pix_display_qr_code: {
        data: "00020126580014br.gov.bcb.pix-le2009",
        image_url_svg: "https://stripe.test/pix-qr.svg",
        expires_at: 1786000000,
      },
    },
  });
  stripeUpdate.mockResolvedValue({ id: "pi_le2009" });
});

describe("LE2-009 turn seam — L1 replays the parse without touching the wire", () => {
  it("an identical repeat makes ZERO model calls and re-mints a fresh envelope for the same parse", async () => {
    const funnel = funnelWithCache();
    const conversationId = "conv_le2009_hit";
    const t1 = tierRecordingTelemetry();
    const t2 = tierRecordingTelemetry();

    // ── Turn 1 — a real parse, memoized on the way out ───────────────────────
    const scripted = scriptedModel(checkoutToolCall());
    const first = buildHarness({
      model: scripted,
      funnel,
      conversationId,
      cartTotal: CART_TOTAL_EXECUTES,
      telemetry: t1.telemetry,
    });
    const turn1 = await runCustomerTurn(first.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: CHECKOUT_UTTERANCE,
    });

    expect(turn1.decision.kind).toBe("EXECUTE");
    expect(scripted.complete).toHaveBeenCalled();
    expect(funnel.counters?.()).toMatchObject({ misses: 1, hits: 0, stores: 1 });

    const executed1 = first.sink
      .byKind("order.checkout.create")
      .filter((r) => r.decision.kind === "EXECUTE");
    expect(executed1).toHaveLength(1);

    // ── Turn 2 — the SAME utterance against a model that cannot be called ────
    // `throwingModel` throws on complete/stream/embed alike, so this asserts the
    // absence of a wire call by construction rather than by counting.
    const second = buildHarness({
      model: throwingModel("LE2-009 L1 cache-hit ZERO-MODEL-CALL proof"),
      funnel,
      conversationId,
      cartTotal: CART_TOTAL_EXECUTES,
      telemetry: t2.telemetry,
    });
    const turn2 = await runCustomerTurn(second.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: CHECKOUT_UTTERANCE,
    });

    expect(turn2.decision.kind).toBe("EXECUTE");
    expect(funnel.counters?.()).toMatchObject({ hits: 1 });

    // The tier is attributed on the trace exactly as L0's is — read at emitTurn,
    // the seam production stamps it from.
    expect(t2.tiers).toEqual([
      { turnId: turn2.turnId, tier: "L1", reason: "memoized_parse", keyVersion: 1 },
    ]);
    // …and turn 1, which really parsed, carries NO tier at all.
    expect(t1.tiers).toEqual([{ turnId: turn1.turnId }]);
    // The independent second witness: the cache-hit turn billed strictly fewer
    // model tokens than the turn that parsed (the planner's usage is simply absent).
    expect(t2.tokens[0]!.total).toBeLessThan(t1.tokens[0]!.total);

    // ── The re-mint proof (claim 2) ──────────────────────────────────────────
    const executed2 = second.sink
      .byKind("order.checkout.create")
      .filter((r) => r.decision.kind === "EXECUTE");
    expect(executed2).toHaveLength(1);
    // Same parse — identical capability and identical RESOLVED payload…
    expect(executed2[0]!.envelope.kind).toBe("order.checkout.create");
    expect(executed2[0]!.envelope.payload).toEqual(executed1[0]!.envelope.payload);
    // …but a genuinely NEW dispatch. Were these equal, the always-on fail-closed
    // execution ledger would dedup the customer's second order against their first.
    expect(executed2[0]!.envelope.nonce).not.toBe(executed1[0]!.envelope.nonce);
    expect(executed2[0]!.envelope.intentHash).not.toBe(executed1[0]!.envelope.intentHash);

    // The replayed envelope really reached the executor: the money path ran again
    // on turn 2, from a parse that cost nothing on the wire. And the reply is
    // grounded in what the executor ACTUALLY did — rendered deterministically from
    // the tool's own outcome, with no model in the loop at all.
    expect(stripeConfirm).toHaveBeenCalled();
    expect(turn2.response).toContain("PIX");
  });

  it("caches the PARSE and never the ANSWER — a store change between identical asks changes the reply", async () => {
    const funnel = funnelWithCache();
    const conversationId = "conv_le2009_stale";
    const t2 = tierRecordingTelemetry();

    // ── Ask #1, cart under the money band ⇒ EXECUTE ──────────────────────────
    const first = buildHarness({
      model: scriptedModel(checkoutToolCall()),
      funnel,
      conversationId,
      cartTotal: CART_TOTAL_EXECUTES,
    });
    const turn1 = await runCustomerTurn(first.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: CHECKOUT_UTTERANCE,
    });
    expect(turn1.decision.kind).toBe("EXECUTE");

    // ── The store changes underneath: the same cart now totals R$1.500 ───────
    // ── Ask #2, byte-identical utterance ⇒ the parse is replayed, but RESOLVE
    //    re-hydrates and the kernel re-adjudicates against the LIVE total.
    const second = buildHarness({
      model: plannerThrowingModel("LE2-009 stale-answer proof"),
      funnel,
      conversationId,
      cartTotal: CART_TOTAL_PARKS,
      telemetry: t2.telemetry,
    });
    const turn2 = await runCustomerTurn(second.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: CHECKOUT_UTTERANCE,
    });

    // The cache hit happened…
    expect(funnel.counters?.()).toMatchObject({ hits: 1 });
    expect(t2.tiers[0]).toMatchObject({ tier: "L1", reason: "memoized_parse" });
    // …and yet the OUTCOME is different, because nothing downstream was cached.
    expect(turn2.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(turn2.decision.kind).not.toBe(turn1.decision.kind);
    expect(turn2.response).not.toBe(turn1.response);
    // The money guard fired on the fresh read: the second ask is parked, not paid.
    expect(second.session.parksFor(CUSTOMER)).toHaveLength(1);
  });

  it("a DIFFERENT utterance is a miss — the cache is exact-match, never similar-match", async () => {
    const funnel = funnelWithCache();
    const conversationId = "conv_le2009_exact";

    const first = buildHarness({
      model: scriptedModel(checkoutToolCall()),
      funnel,
      conversationId,
      cartTotal: CART_TOTAL_EXECUTES,
    });
    await runCustomerTurn(first.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: CHECKOUT_UTTERANCE,
    });
    expect(funnel.counters?.()).toMatchObject({ misses: 1, hits: 0 });

    // A near-paraphrase a similarity tier WOULD have matched. L1 must not:
    // proving the absence of a semantic path is the ticket's "exact match only" AC.
    const second = buildHarness({
      model: scriptedModel(checkoutToolCall()),
      funnel,
      conversationId,
      cartTotal: CART_TOTAL_EXECUTES,
    });
    await runCustomerTurn(second.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: "fecha o pedido, pago no pix, retiro no balcao",
    });

    expect(funnel.counters?.()).toMatchObject({ misses: 2, hits: 0 });
  });

  it("only-whitespace/case differences DO hit — canonicalization is the join key", async () => {
    const funnel = funnelWithCache();
    const conversationId = "conv_le2009_canon";
    const t2 = tierRecordingTelemetry();

    const first = buildHarness({
      model: scriptedModel(checkoutToolCall()),
      funnel,
      conversationId,
      cartTotal: CART_TOTAL_EXECUTES,
    });
    await runCustomerTurn(first.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: CHECKOUT_UTTERANCE,
    });

    const second = buildHarness({
      model: plannerThrowingModel("LE2-009 canonicalization hit"),
      funnel,
      conversationId,
      cartTotal: CART_TOTAL_EXECUTES,
      telemetry: t2.telemetry,
    });
    const turn2 = await runCustomerTurn(second.harness, {
      customerId: CUSTOMER,
      conversationId,
      text: `  ${CHECKOUT_UTTERANCE.toUpperCase()}   `,
    });

    expect(funnel.counters?.()).toMatchObject({ hits: 1 });
    expect(t2.tiers).toEqual([
      { turnId: turn2.turnId, tier: "L1", reason: "memoized_parse", keyVersion: 1 },
    ]);
  });

  it("without a parse cache store the planner is byte-identical to its pre-L1 behaviour", async () => {
    // The opt-out that keeps the ops/agent planes and every pre-L1 suite unchanged:
    // no store ⟹ no L1 seam ⟹ two identical turns BOTH reach the model.
    const funnel = createParseFunnel();
    expect(funnel.lookupParse).toBeUndefined();
    const conversationId = "conv_le2009_optout";

    for (const _ of [1, 2]) {
      const scripted = scriptedModel(checkoutToolCall());
      const t = tierRecordingTelemetry();
      const h = buildHarness({
        model: scripted,
        funnel,
        conversationId,
        cartTotal: CART_TOTAL_EXECUTES,
        telemetry: t.telemetry,
      });
      const turn = await runCustomerTurn(h.harness, {
        customerId: CUSTOMER,
        conversationId,
        text: CHECKOUT_UTTERANCE,
      });
      expect(turn.decision.kind).toBe("EXECUTE");
      // BOTH turns reached the extraction wire, and neither carries a tier.
      expect(scripted.complete).toHaveBeenCalled();
      expect(t.tiers).toEqual([{ turnId: turn.turnId }]);
    }
  });
});
