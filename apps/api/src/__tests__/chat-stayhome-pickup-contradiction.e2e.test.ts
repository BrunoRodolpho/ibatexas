/**
 * BKL-280 — the stay-home / pickup contradiction guard, at the REAL turn seam.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM THE GUARD UNIT TESTS ────────────────
 *
 * `packages/pack-orders/src/__tests__/orders-pack.test.ts` proves the guard
 * decides correctly when it is handed a ctx flag. That is only half the claim.
 * The defect this ticket fixes is a MODEL failure — the 4B emits
 * `order.checkout.create {delivery_type: "pickup", payment_method: "cash"}` for
 * a customer who just said they cannot leave the house — so the property that
 * actually matters is that the guard catches what the model gets WRONG, with
 * the real planner, the real resolver, the real kernel and the real conductor
 * in the loop. A guard-level test cannot see the seam where the utterance
 * becomes a ctx flag; this one drives it end to end.
 *
 * The model here is SCRIPTED to emit exactly the wrong payload the V7 arms
 * measured (evidence: ~/projects/scratch/language-engine-2/results/raw/
 * bkl275-truncation, epoch 54cf4353d5a32564). That is the point: the test
 * asserts the system is safe even when the model is wrong in precisely the way
 * it is known to be wrong.
 *
 * Mock preamble copied verbatim from `chat-pix-checkout.e2e.test.ts` — the
 * three `vi.mock` calls must live in the TEST file (vitest hoists mock
 * factories above every import, so a fake exported from the harness would
 * initialize too late to reach inside the built `@ibatexas/tools` dist).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup.js";

// ── Client-boundary mocks (must be hoisted in the TEST file, not the harness) ──

const { redisFake, stripeConfirm, stripeUpdate, stripeRetrieve } = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  const expires: Array<{ key: string; seconds: number }> = [];
  return {
    redisFake: { strings, hashes, expires },
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
    expire: async (key: string, seconds: number) => {
      redisFake.expires.push({ key, seconds });
      return 1;
    },
    // No `multi()`: M4 measured this file's whole run and it never reaches a
    // production multi() site, so a stub here covers nothing while silently
    // DROPPING any queued write a future path adds (census, M4). Left absent so
    // that path fails loudly instead; real Redis is the home if one needs a
    // transaction's effect (W4 RULE 3 — the adapter does not emulate multi).
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
} = await import("./customer-e2e-harness.js");
const { rk } = await import("@ibatexas/tools");
const { loadCartCtx } = await import("../claustrum/resolve-and-assemble.js");

const CUSTOMER = "cus_bkl280_owner";
const CONVERSATION = "conv_bkl280";
const CART_ID = "cart_bkl280";

/**
 * THE V7 UTTERANCE — verbatim from the evidence corpus, accents included.
 * `~/projects/scratch/language-engine-2/results/raw/bkl275-truncation/probes/
 * corpus-list.json`, case id `cash-delivery-context-embedded`.
 */
const V7_UTTERANCE =
  "não vou poder sair de casa hoje, fecha aí, pago em dinheiro na entrega";

/** A genuine pickup ask from the same corpus — the control. */
const PICKUP_UTTERANCE = "quero fechar o pedido no pix, vou retirar no balcão";

/** A genuine delivery ask from the same corpus. */
const DELIVERY_UTTERANCE = "fecha o pedido no cartão, entrega em casa";

/** The sentence the guard authors. Pinned verbatim — it is customer copy. */
const CONTRADICTION_PROMPT =
  "O pedido está marcado como retirada no local, mas sua mensagem indica entrega. Como você prefere receber: entrega no seu endereço ou retirada no local?";

/** Under the R$1.000 `confirmLargeTicket` band ⇒ a one-turn EXECUTE, no park. */
const CART_TOTAL_EXECUTES = 500;
/** At/above the band ⇒ the money guard would also want to speak. */
const CART_TOTAL_LARGE = 1500;

function seedEnv(): void {
  process.env.APP_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.MEDUSA_URL = "http://medusa.test";
  process.env.MEDUSA_ADMIN_EMAIL = "admin@test.local";
  process.env.MEDUSA_ADMIN_PASSWORD = "harness-password";
  process.env.STRIPE_SECRET_KEY = "sk_test_bkl280";
  process.env.KERNEL_TENANT_ID = "ibatexas";
}

interface ScriptedCall {
  readonly paymentMethod: string;
  readonly deliveryType: string;
}

/**
 * A planner model that emits a DIFFERENT checkout payload on each successive
 * tool-bearing call, then falls back to a plain responder.
 *
 * `scriptedModel` latches once by design (so a follow-up "sim" reads as a reply
 * to a park rather than a fresh command), which is exactly right for a
 * confirm-resume test and exactly wrong for this one: the corrected-flow case
 * needs the customer's SECOND turn to be genuinely re-planned into a NEW
 * envelope carrying `delivery`. A per-call queue gives that without abandoning
 * the session — which matters, because the property under test is that the
 * park survives, the re-plan happens on the SAME session, and the corrected
 * envelope is a different intent rather than a receipt against the wrong one.
 */
function sequencedModel(calls: ReadonlyArray<ScriptedCall>): ReturnType<typeof scriptedModel> {
  let next = 0;
  const base = scriptedModel([]);
  const complete = vi.fn(async (req: { tools?: ReadonlyArray<unknown> }) => {
    const isPlanner = (req.tools?.length ?? 0) > 0;
    const call = isPlanner ? calls[next] : undefined;
    if (isPlanner && call !== undefined) next += 1;
    return {
      model: "mock",
      stopReason: "end_turn",
      text: isPlanner
        ? call !== undefined
          ? ""
          : "ok (mock planner pass — nothing to propose)"
        : "Ok.",
      toolCalls:
        call === undefined
          ? []
          : [
              {
                id: `tu_bkl280_${next}`,
                name: "express_intent",
                input: {
                  capability: "order.checkout.create",
                  payload: {
                    payment_method: call.paymentMethod,
                    delivery_type: call.deliveryType,
                  },
                },
              },
            ],
      inputTokens: 5,
      outputTokens: 4,
    };
  });
  return { ...base, complete } as ReturnType<typeof scriptedModel>;
}

/**
 * Build a harness whose scripted model emits ONE `express_intent` carrying the
 * given checkout payload — the SNAKE_CASE wire keys the 4B really produces.
 */
function buildHarness(opts: {
  readonly call?: ScriptedCall;
  /** Successive payloads, one per planner turn — for the corrected flow. */
  readonly calls?: ReadonlyArray<ScriptedCall>;
  readonly total?: number;
}) {
  const cart = makeCartFixture({
    id: CART_ID,
    total: opts.total ?? CART_TOTAL_EXECUTES,
  });
  const medusa = makeMedusaFetchFake(cart);
  vi.stubGlobal("fetch", medusa.fetch);

  // The resolver reads the active cart by the CONVERSATION handle (BKL-028).
  redisFake.strings.set(rk(`cart:active:session:${CONVERSATION}`), CART_ID);

  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession();
  const model =
    opts.calls !== undefined
      ? sequencedModel(opts.calls)
      : scriptedModel([
          {
            id: "tu_bkl280",
            name: "express_intent",
            input: {
              capability: "order.checkout.create",
              payload: {
                payment_method: opts.call!.paymentMethod,
                delivery_type: opts.call!.deliveryType,
              },
            },
          },
        ]);

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
    model,
    session,
    adjudicator,
    realResponder: true,
  });
  return { harness, sink, session, medusa, cart };
}

function turn(harness: ReturnType<typeof buildHarness>["harness"], text: string) {
  return runCustomerTurn(harness, {
    customerId: CUSTOMER,
    conversationId: CONVERSATION,
    text,
  });
}

/** Pull the customer-facing sentence off a decision, whatever its variant. */
function userFacingOf(decision: unknown): string {
  const d = decision as {
    prompt?: unknown;
    userFacing?: unknown;
    refusal?: { userFacing?: unknown };
    confirmation?: { prompt?: unknown };
  };
  for (const candidate of [
    d.prompt,
    d.confirmation?.prompt,
    d.refusal?.userFacing,
    d.userFacing,
  ]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return "";
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  redisFake.strings.clear();
  redisFake.hashes.clear();
  redisFake.expires.length = 0;
  seedEnv();
  stripeConfirm.mockResolvedValue({ id: "pi_bkl280", status: "succeeded" });
  stripeUpdate.mockResolvedValue({ id: "pi_bkl280" });
});

describe("BKL-280 — stay-home utterance vs delivery_type pickup, at the turn seam", () => {
  it("THE DEFECT: the V7 utterance + the model's wrong pickup payload is ASKED, not executed", async () => {
    const { harness, session } = buildHarness({
      call: { paymentMethod: "cash", deliveryType: "pickup" },
    });

    const t = await turn(harness, V7_UTTERANCE);

    // The kernel asked instead of acting.
    expect(t.decision.kind).toBe("REQUEST_CONFIRMATION");
    // …and it asked THIS question. The cart is under the money band, so no
    // other checkout guard could have produced a confirmation here.
    expect(userFacingOf(t.decision)).toBe(CONTRADICTION_PROMPT);
    // The customer actually SEES the sentence (realResponder is wired).
    expect(t.response).toBe(CONTRADICTION_PROMPT);

    // NOTHING executed: no order, no money.
    expect((t.acted as { kind?: string } | undefined)?.kind).not.toBe("executed");
    expect(stripeConfirm).not.toHaveBeenCalled();

    // The wrong envelope is parked, not discarded — the customer can still
    // resolve it, and the parked payload still carries the model's `pickup`
    // (the guard corrects the OUTCOME, it never rewrites the model's words).
    const parked = session.parksFor(CUSTOMER);
    expect(parked).toHaveLength(1);
    expect(String(parked[0]!.envelope.kind)).toBe("order.checkout.create");
    expect(parked[0]!.envelope.payload).toMatchObject({
      cartId: CART_ID,
      paymentMethod: "cash",
      deliveryType: "pickup",
    });
  });

  it("the same utterance with the CORRECT delivery payload sails through (the guard reads the CONTRADICTION, not the words)", async () => {
    // Same stay-home sentence — but this time the model bound the slot
    // correctly. There is no contradiction, so there must be no question.
    const { harness, session } = buildHarness({
      call: { paymentMethod: "cash", deliveryType: "delivery" },
    });

    const t = await turn(harness, V7_UTTERANCE);

    expect(t.decision.kind).toBe("EXECUTE");
    expect(session.parksFor(CUSTOMER)).toHaveLength(0);
  });

  it("CORRECTED FLOW: the customer answers 'entrega' and the SAME session re-plans into a delivery checkout that EXECUTEs", async () => {
    // ONE session, two turns. Turn 1 the model gets it wrong and the guard
    // asks; turn 2 the customer answers the question and the corrected
    // checkout goes through.
    const { harness, session } = buildHarness({
      calls: [
        { paymentMethod: "cash", deliveryType: "pickup" },
        { paymentMethod: "cash", deliveryType: "delivery" },
      ],
    });

    const t1 = await turn(harness, V7_UTTERANCE);
    expect(t1.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(userFacingOf(t1.decision)).toBe(CONTRADICTION_PROMPT);
    expect(session.parksFor(CUSTOMER)).toHaveLength(1);
    const parkedHash = session.parksFor(CUSTOMER)[0]!.envelope.intentHash;

    // Turn 2 — the customer answers with a CHOICE, not a "sim". "entrega"
    // matches none of the confirm/deny/defer lexicons, so the conductor
    // RE-PLANS rather than resuming the parked pickup envelope. That is the
    // seam that makes the guard's question meaningful: the answer changes the
    // PAYLOAD, which changes the intentHash, which is a brand-new adjudication
    // in which the contradiction no longer exists. A "sim" could only ever
    // resolve the envelope that was actually parked — it can never turn the
    // wrong payload into the right one, which is why the guard asks a CHOICE
    // question rather than a yes/no one.
    const t2 = await turn(harness, "entrega, por favor");

    expect(t2.decision.kind).toBe("EXECUTE");
    const plan = t2.plan as {
      envelopes?: ReadonlyArray<{ payload?: unknown; intentHash?: string }>;
    };
    // The corrected envelope carries DELIVERY — the customer got what they asked for…
    expect(plan.envelopes?.[0]?.payload).toMatchObject({
      deliveryType: "delivery",
    });
    // …and it is a genuinely DIFFERENT intent, not the parked one waved through.
    expect(plan.envelopes?.[0]?.intentHash).not.toBe(parkedHash);
  });

  it("a STALE receipt cannot bypass the ask — an unrelated prior 'sim' is not an answer to this question", async () => {
    // The binding hazard: receipts are scoped to an intentHash, not to a
    // question. A park from THIS turn is the only thing a "sim" may resolve, so
    // a receipt minted elsewhere must leave the contradiction standing. Here
    // the guard-level pin (orders-pack.test.ts) proves the kernel gate; this
    // one proves the turn seam never hands the kernel a mismatched receipt —
    // the parked hash and the envelope hash are the same object.
    const { harness, session } = buildHarness({
      call: { paymentMethod: "cash", deliveryType: "pickup" },
    });
    const t1 = await turn(harness, V7_UTTERANCE);
    expect(t1.decision.kind).toBe("REQUEST_CONFIRMATION");

    const parked = session.parksFor(CUSTOMER);
    expect(parked).toHaveLength(1);
    const plan = t1.plan as {
      envelopes?: ReadonlyArray<{ intentHash?: string }>;
    };
    expect(parked[0]!.envelope.intentHash).toBe(plan.envelopes?.[0]?.intentHash);
    // Nothing has executed while the question stands.
    expect(stripeConfirm).not.toHaveBeenCalled();
  });

  // ── CONTROLS ───────────────────────────────────────────────────────────

  it("CONTROL — a plain pickup ask is completely unaffected (one-turn EXECUTE)", async () => {
    const { harness, session } = buildHarness({
      call: { paymentMethod: "pix", deliveryType: "pickup" },
    });

    const t = await turn(harness, PICKUP_UTTERANCE);

    expect(t.decision.kind).toBe("EXECUTE");
    expect(session.parksFor(CUSTOMER)).toHaveLength(0);
  });

  it("CONTROL — a plain delivery ask is completely unaffected (one-turn EXECUTE)", async () => {
    const { harness, session } = buildHarness({
      call: { paymentMethod: "card", deliveryType: "delivery" },
    });

    const t = await turn(harness, DELIVERY_UTTERANCE);

    expect(t.decision.kind).toBe("EXECUTE");
    expect(session.parksFor(CUSTOMER)).toHaveLength(0);
  });

  it("CONTROL — the NEGATED-mention trap stays silent ('não quero delivery não … vou retirar')", async () => {
    // The utterance that cost the bare English "delivery" marker its place in
    // the net: a pickup customer who says the word while declining it. A false
    // positive here would be a needless question on a correct checkout.
    const { harness, session } = buildHarness({
      call: { paymentMethod: "cash", deliveryType: "pickup" },
    });

    const t = await turn(
      harness,
      "não quero delivery não, fecha em dinheiro, vou retirar",
    );

    expect(t.decision.kind).toBe("EXECUTE");
    expect(session.parksFor(CUSTOMER)).toHaveLength(0);
  });

  // ── THE MONEY LADDER ───────────────────────────────────────────────────

  it("MONEY BAND UNCHANGED — a large-ticket DELIVERY checkout still asks the money question", async () => {
    const { harness } = buildHarness({
      call: { paymentMethod: "card", deliveryType: "delivery" },
      total: CART_TOTAL_LARGE,
    });

    const t = await turn(harness, DELIVERY_UTTERANCE);

    expect(t.decision.kind).toBe("REQUEST_CONFIRMATION");
    const said = userFacingOf(t.decision);
    expect(said).toContain("R$");
    expect(said).not.toBe(CONTRADICTION_PROMPT);
  });

  it("ORDERING — on a CONTRADICTING large-ticket cart the contradiction is asked, not the money", async () => {
    // Both guards match this envelope and first-non-null wins. If the money
    // guard spoke first, a "sim" would satisfy it and the wrong pickup checkout
    // would EXECUTE — the defect, for the most expensive carts.
    const { harness } = buildHarness({
      call: { paymentMethod: "card", deliveryType: "pickup" },
      total: CART_TOTAL_LARGE,
    });

    const t = await turn(harness, V7_UTTERANCE);

    expect(t.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(userFacingOf(t.decision)).toBe(CONTRADICTION_PROMPT);
    expect(stripeConfirm).not.toHaveBeenCalled();
  });
});
