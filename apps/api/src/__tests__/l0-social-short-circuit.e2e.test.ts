/**
 * LE2-007 turn-seam e2e — the L0 social short-circuit, proven through a REAL
 * `handleTurn` with an instrument that CANNOT be satisfied by a model call.
 *
 * WHY THIS SHAPE. "Zero model calls" is a claim about the WIRE, and the failure mode
 * this repo has been bitten by twice (LE2-002's structurally-dead feature, BKL-230's
 * never-passed executor argument) is a green test that never crossed the real gate.
 * So the model here is `throwingModel()`: if the planner's extraction pass, the claim
 * planner, or the responder's synthesis reaches it, the turn fails loudly. A counting
 * spy would let a regression through with a number nobody asserted; a fake that
 * cannot be called cannot be fooled.
 *
 * WHAT IS REAL: `handleTurn` + `createConductor`, the production planner
 * (`createIbatexasPlanner`), the production RESPONDER (`createIbatexasResponder` — the
 * harness's opt-in `realResponder`, because an L0 turn's whole deliverable IS its
 * template), the real composed policy router + audited kernel, the real
 * `WebConfirmChannel.matchToParked`, and the real per-turn funnel seam wired into both
 * halves exactly as `bootstrapClaustrum` wires it.
 *
 * The pure-core pins (lexicon closure, the smalltalk census, the reserved
 * personalization slot, the closed-hours note mechanism) live in
 * `src/claustrum/__tests__/funnel-tier.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup.js";

// ── Client-boundary mocks (must be hoisted in the TEST file, not the harness) ──
// An L0 turn touches NONE of these — that is part of the point — but the confirm-window
// suite below drives a real checkout to open the park, and a mock that is absent is a
// mock that can silently reach a real service.

const { redisFake, stripeConfirm, stripeUpdate, stripeRetrieve } = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  return {
    redisFake: { strings, hashes },
    stripeConfirm: vi.fn(),
    stripeUpdate: vi.fn(),
    stripeRetrieve: vi.fn(),
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
    paymentIntents: {
      confirm: stripeConfirm,
      update: stripeUpdate,
      retrieve: stripeRetrieve,
    },
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
  throwingModel,
} = await import("./customer-e2e-harness.js");
const { createL0Funnel, funnelStage, renderL0Reply } = await import(
  "../claustrum/funnel-tier.js"
);
const { rk } = await import("@ibatexas/tools");
const { loadCartCtx } = await import("../claustrum/resolve-and-assemble.js");

type TelemetryPort = Parameters<typeof composeCustomerConductor>[0]["telemetry"];

const CUSTOMER = "cus_le2007_owner";
const CONVERSATION = "conv_le2007";
const CART_ID = "cart_le2007";
const CHECKOUT_UTTERANCE = "fecha o pedido, pago no pix, retiro no balcão";

function seedEnv(): void {
  process.env.APP_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.MEDUSA_URL = "http://medusa.test";
  process.env.MEDUSA_ADMIN_EMAIL = "admin@test.local";
  process.env.MEDUSA_ADMIN_PASSWORD = "harness-password";
  process.env.STRIPE_SECRET_KEY = "sk_test_le2007";
  process.env.KERNEL_TENANT_ID = "ibatexas";
}

/** Records the funnel tier at the loop's ONCE-PER-TURN seam — the same read
 *  `bootstrapClaustrum`'s `emitTurn` performs to stamp the per-turn trace line. */
function tierRecordingTelemetry(): {
  telemetry: NonNullable<TelemetryPort>;
  tiers: Array<{ turnId: string; tier?: string; reason?: string }>;
  /** Per-turn model token totals as `handleTurn` summed them (plan.usage +
   *  draft.usage) — the wire cost the funnel exists to remove. */
  tokens: Array<{ turnId: string; total: number }>;
} {
  const tiers: Array<{ turnId: string; tier?: string; reason?: string }> = [];
  const tokens: Array<{ turnId: string; total: number }> = [];
  return {
    tiers,
    tokens,
    telemetry: {
      emitTurn: async (record) => {
        const stage = funnelStage(record.turnId);
        tiers.push({
          turnId: record.turnId,
          ...(stage ? { tier: stage.tier, reason: stage.reason } : {}),
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

/**
 * A customer harness with the funnel wired into both real seams. `model` is the
 * caller's instrument — `throwingModel()` for a zero-call proof, `scriptedModel()`
 * when the turn is SUPPOSED to reach the wire.
 */
function buildL0Harness(
  opts: {
    model?: ReturnType<typeof throwingModel>;
    scheduleSignal?: { isClosed: boolean; nextOpenDay?: string };
    seedCart?: boolean;
  } = {},
) {
  const cart = makeCartFixture({ id: CART_ID });
  const medusa = makeMedusaFetchFake(cart);
  vi.stubGlobal("fetch", medusa.fetch);
  if (opts.seedCart) {
    redisFake.strings.set(rk(`cart:active:session:${CONVERSATION}`), CART_ID);
  }

  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession();
  const funnel = createL0Funnel();
  const { telemetry, tiers, tokens } = tierRecordingTelemetry();
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
        { sessionId: CONVERSATION },
      );
      return { ctx } as never;
    },
  });

  const harness = composeCustomerConductor({
    model: opts.model ?? throwingModel(),
    session,
    adjudicator,
    funnel,
    realResponder: true,
    telemetry,
    ...(opts.scheduleSignal
      ? { scheduleSignal: opts.scheduleSignal as never }
      : {}),
  });
  return { harness, session, sink, tiers, tokens, medusa };
}

const social = (text: string) => ({
  customerId: CUSTOMER,
  conversationId: CONVERSATION,
  text,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  redisFake.strings.clear();
  redisFake.hashes.clear();
  seedEnv();
  stripeConfirm.mockResolvedValue({
    id: "pi_le2007",
    status: "requires_action",
    next_action: {
      pix_display_qr_code: {
        data: "00020126580014br.gov.bcb.pix-le2007",
        image_url_svg: "https://stripe.test/pix-qr.svg",
        expires_at: 1786000000,
      },
    },
  });
  stripeUpdate.mockResolvedValue({ id: "pi_le2007" });
});

describe("LE2-007 — a social-only turn is answered with ZERO model calls", () => {
  it.each([
    ["Oi", "greeting"],
    ["Bom dia!", "greeting"],
    ["oi, tudo bem?", "greeting"],
    ["obrigado!", "thanks"],
    ["valeu", "thanks"],
    ["tchau", "farewell"],
    ["até logo!", "farewell"],
  ])(
    "%j → the %s template, and the model is never called",
    async (text, kind) => {
      const { harness } = buildL0Harness();
      const turn = await runCustomerTurn(harness, social(text));
      // The instrument: `throwingModel` throws on `complete`. Reaching this line with
      // the template as the reply IS the zero-call proof — no model call happened at
      // the planner, the claim path, or the responder.
      expect(turn.response).toBe(renderL0Reply(kind as never));
      // The plan is the respond-only shape: nothing proposed, nothing adjudicated.
      expect((turn.plan as { envelopes: unknown[] }).envelopes).toEqual([]);
      expect(turn.decision.kind).toBe("REFUSE");
    },
  );

  it("stamps tier attribution readable at the loop's once-per-turn seam", async () => {
    const { harness, tiers } = buildL0Harness();
    const turn = await runCustomerTurn(harness, social("Oi"));
    expect(tiers).toEqual([
      { turnId: turn.turnId, tier: "L0", reason: "social_only" },
    ]);
  });

  it("costs ZERO tokens on the TurnRecord, where a model turn costs some", async () => {
    // The wire-cost assertion, stated as a CONTRAST so it cannot pass vacuously:
    // `handleTurn` sums plan.usage + draft.usage onto the TurnRecord, and that sum is
    // what feeds the per-session token fold, `llm_token_usage`, and the cost
    // dashboards. An L0 turn reports zero because neither seam made a call; the same
    // harness on a non-social turn reports a real cost.
    const l0 = buildL0Harness();
    const l0Turn = await runCustomerTurn(l0.harness, social("obrigado"));
    expect(l0Turn.response).toBe(renderL0Reply("thanks"));
    expect(l0.tokens).toEqual([{ turnId: l0Turn.turnId, total: 0 }]);

    const model = scriptedModel([], { responderText: "Claro!" });
    const paid = buildL0Harness({ model: model as never });
    const paidTurn = await runCustomerTurn(paid.harness, social("quero uma coca"));
    expect(paid.tokens.at(-1)).toEqual({
      turnId: paidTurn.turnId,
      total: expect.any(Number) as never,
    });
    expect(paid.tokens.at(-1)!.total).toBeGreaterThan(0);
  });
});

describe("LE2-007 — a MIXED utterance still parses (AC #2)", () => {
  it("'oi, vocês entregam em Ibaté?' reaches the REAL planner on the wire", async () => {
    const model = scriptedModel([], { responderText: "Deixa eu verificar." });
    const { harness, tiers } = buildL0Harness({ model: model as never });
    const turn = await runCustomerTurn(
      harness,
      social("oi, vocês entregam em Ibaté?"),
    );
    // The planner (and then the responder) genuinely called the model…
    expect((model.complete as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThanOrEqual(1);
    // …no tier claimed the turn, so the trace carries no tier attribution…
    expect(tiers).toEqual([{ turnId: turn.turnId }]);
    // …and the reply is model-authored, not an L0 template.
    expect(turn.response).not.toBe(renderL0Reply("greeting"));
  });

  it("a bare action request is untouched by the funnel", async () => {
    const model = scriptedModel([], { responderText: "Anotado." });
    const { harness, tiers } = buildL0Harness({ model: model as never });
    const turn = await runCustomerTurn(harness, social("quero uma coca gelada"));
    expect((model.complete as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThanOrEqual(1);
    expect(tiers).toEqual([{ turnId: turn.turnId }]);
  });
});

describe("LE2-007 — FE-D32: L0 stands down inside an open confirm window", () => {
  it("a greeting during a parked confirmation keeps the confirm path: no L0, park survives, 'sim' still EXECUTEs", async () => {
    // Turn 1 — a real R$1.500 checkout: the money band parks REQUEST_CONFIRMATION.
    const model = scriptedModel(
      [
        {
          id: "tu_le2007",
          name: "express_intent",
          input: {
            capability: "order.checkout.create",
            payload: { payment_method: "pix", delivery_type: "pickup" },
          },
        },
      ],
      { responderText: "Ok." },
    );
    const { harness, session, tiers } = buildL0Harness({
      model: model as never,
      seedCart: true,
    });
    const turn1 = await runCustomerTurn(harness, social(CHECKOUT_UTTERANCE));
    expect(turn1.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(session.parksFor(CUSTOMER)).toHaveLength(1);

    // Turn 2 — a bare GREETING while that confirmation is pending. L0 is the cheapest
    // possible answer and it must NOT fire: the customer is one utterance away from a
    // money decision, and a warm template would answer past it.
    const callsBefore = (model.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const turn2 = await runCustomerTurn(harness, social("Oi"));
    expect(turn2.response).not.toBe(renderL0Reply("greeting"));
    // No tier claimed turn 2 → no tier attribution on its trace.
    expect(tiers.at(-1)).toEqual({ turnId: turn2.turnId });
    // The turn went to the wire exactly as it did before L0 existed…
    expect(
      (model.complete as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(callsBefore);
    // …and the park SURVIVED untouched, so the confirm window is still open.
    expect(session.parksFor(CUSTOMER)).toHaveLength(1);

    // Turn 3 — the ratified restate-then-confirm path completes: "sim" resumes the
    // SAME parked envelope through the audited kernel with a receipt.
    const turn3 = await runCustomerTurn(harness, social("sim"));
    expect(turn3.decision.kind).toBe("EXECUTE");
    expect(session.parksFor(CUSTOMER)).toHaveLength(0);
  });

  it("bare courtesy during a park also stays on the confirm path", async () => {
    const model = scriptedModel(
      [
        {
          id: "tu_le2007b",
          name: "express_intent",
          input: {
            capability: "order.checkout.create",
            payload: { payment_method: "pix", delivery_type: "pickup" },
          },
        },
      ],
      { responderText: "Ok." },
    );
    const { harness, session } = buildL0Harness({
      model: model as never,
      seedCart: true,
    });
    await runCustomerTurn(harness, social(CHECKOUT_UTTERANCE));
    expect(session.parksFor(CUSTOMER)).toHaveLength(1);

    const turn = await runCustomerTurn(harness, social("obrigado"));
    expect(turn.response).not.toBe(renderL0Reply("thanks"));
    expect(session.parksFor(CUSTOMER)).toHaveLength(1);
  });
});

describe("LE2-007 — closed hours: the L0 reply is store-state neutral", () => {
  it("a greeting while CLOSED renders byte-identically to a greeting while OPEN", async () => {
    const closed = buildL0Harness({
      scheduleSignal: { isClosed: true, nextOpenDay: "amanhã às 18h" },
    });
    const closedTurn = await runCustomerTurn(closed.harness, social("Oi"));

    const open = buildL0Harness({ scheduleSignal: { isClosed: false } });
    const openTurn = await runCustomerTurn(open.harness, social("Oi"));

    // The deterministic closed-hours backstop runs over the template in both states
    // (it is the one guard that reads the STRUCTURED signal), and the template asserts
    // nothing about open/closed — so it passes through untouched either way. That is
    // "closed-hours note behaviour preserved exactly" by construction: a greeting
    // never carried a closure note before L0 (the note is suppressed on phatic turns)
    // and it never carries one now.
    expect(closedTurn.response).toBe(renderL0Reply("greeting"));
    expect(closedTurn.response).toBe(openTurn.response);
    expect(closedTurn.response).not.toMatch(/fechad|abert|agendad/i);
  });

  it("a farewell while CLOSED is likewise neutral", async () => {
    const { harness } = buildL0Harness({
      scheduleSignal: { isClosed: true, nextOpenDay: "amanhã às 18h" },
    });
    const turn = await runCustomerTurn(harness, social("tchau"));
    expect(turn.response).toBe(renderL0Reply("farewell"));
  });
});
