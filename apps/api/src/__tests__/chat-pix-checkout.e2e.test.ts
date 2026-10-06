/**
 * BKL-230 turn-seam e2e — a chat PIX checkout driven through a REAL `handleTurn`
 * into the REAL tool executor, with mocks only at the Stripe / Medusa / Redis
 * CLIENT boundary.
 *
 * This is the first customer-plane test in the repo that reaches a real executor
 * through a real turn (see customer-e2e-harness.ts for why none existed). It is
 * the proof the wiring fix is alive through the actual gate, not merely present:
 * before the fix this turn returned "Nome e email são obrigatórios para pagamento
 * PIX." with no Stripe confirm and no `metadata.cartId`.
 *
 * The full two-turn money shape:
 *   turn 1  "fecha o pedido, pago no pix, retiro no balcão"
 *             → real planner proposes order.checkout.create
 *             → real resolver renames payment_method/delivery_type + hydrates
 *               cartId from the active-cart Redis key
 *             → real kernel: cart totals R$1.500 ⇒ confirmLargeTicket
 *               ⇒ REQUEST_CONFIRMATION ⇒ parked
 *   turn 2  "sim"
 *             → WebConfirmChannel.matchToParked matches the park
 *             → resume re-adjudicates WITH the receipt ⇒ EXECUTE
 *             → resolveTool("order.checkout.create") ⇒ the wired executor
 *             → payer identity resolved from the session's customer
 *             → REAL createCheckout ⇒ Stripe PIX confirm + metadata.cartId
 *
 * Mock placement is the whole point: `stripe` and `redis` are mocked as PACKAGES
 * and Medusa via global `fetch`, all of which reach INSIDE the built
 * `@ibatexas/tools` dist. Nothing above the executor is stubbed — no
 * `createCheckout` double, no handleTurn double.
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

// `stripeAdjudicated` (inside the tools dist) constructs `new Stripe(key)` from the
// bare `stripe` package — both packages resolve to the identical pnpm realpath, so
// this mock reaches inside the dist. Precedent: stripe-webhook-route.test.ts.
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

const CUSTOMER = "cus_bkl230_owner";
const CONVERSATION = "conv_bkl230";
const CART_ID = "cart_bkl230";

/** The utterance that names BOTH slots the checkout guards require. */
const CHECKOUT_UTTERANCE = "fecha o pedido, pago no pix, retiro no balcão";

function seedEnv(): void {
  process.env.APP_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.MEDUSA_URL = "http://medusa.test";
  process.env.MEDUSA_ADMIN_EMAIL = "admin@test.local";
  process.env.MEDUSA_ADMIN_PASSWORD = "harness-password";
  process.env.STRIPE_SECRET_KEY = "sk_test_bkl230";
  process.env.KERNEL_TENANT_ID = "ibatexas";
}

/** Build a full harness: seeded cart + active-cart key + saved PIX details. */
function buildHarness(opts: { savedPix?: Record<string, string> } = {}) {
  const cart = makeCartFixture({ id: CART_ID });
  const medusa = makeMedusaFetchFake(cart);
  vi.stubGlobal("fetch", medusa.fetch);

  // The resolver reads the active cart by the CONVERSATION handle (BKL-028).
  redisFake.strings.set(rk(`cart:active:session:${CONVERSATION}`), CART_ID);
  if (opts.savedPix) {
    redisFake.hashes.set(rk(`customer:pix:${CUSTOMER}`), opts.savedPix);
  }

  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession();
  const model = scriptedModel([
    {
      id: "tu_bkl230",
      name: "express_intent",
      input: {
        capability: "order.checkout.create",
        // The SNAKE_CASE wire keys the model really produces; the real resolver
        // renames them to paymentMethod/deliveryType.
        payload: { payment_method: "pix", delivery_type: "pickup" },
      },
    },
  ]);

  const adjudicator = makeAuditedAdjudicator({
    sink,
    // Mirrors production's enrichResumeState: re-project the cart state from the
    // live cart before re-adjudicating the parked envelope with the receipt.
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

  const harness = composeCustomerConductor({ model, session, adjudicator });
  return { harness, sink, session, medusa, cart };
}

/** Stripe returns a confirmed PI carrying PIX QR data. */
function stripeReturnsQr(): void {
  stripeConfirm.mockResolvedValue({
    id: "pi_bkl230",
    status: "requires_action",
    next_action: {
      pix_display_qr_code: {
        data: "00020126580014br.gov.bcb.pix-bkl230",
        image_url_svg: "https://stripe.test/pix-qr.svg",
        expires_at: 1786000000,
      },
    },
  });
  stripeUpdate.mockResolvedValue({ id: "pi_bkl230" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  redisFake.strings.clear();
  redisFake.hashes.clear();
  redisFake.expires.length = 0;
  seedEnv();
  stripeReturnsQr();
});

describe("BKL-230 turn seam — chat PIX checkout reaches the executor and mints a QR", () => {
  it("two-turn confirm-resume: 'fecha o pedido, pago no pix' parks, 'sim' EXECUTEs with the stored payer identity", async () => {
    const { harness, session } = buildHarness({
      savedPix: {
        name: "João Silva",
        email: "joao@example.com",
        cpf: "123.456.789-09",
      },
    });

    // ── Turn 1 — the money band parks the checkout for confirmation ───────────
    const turn1 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: CHECKOUT_UTTERANCE,
    });

    expect(turn1.decision.kind).toBe("REQUEST_CONFIRMATION");
    const parked = session.parksFor(CUSTOMER);
    expect(parked).toHaveLength(1);
    expect(String(parked[0]!.envelope.kind)).toBe("order.checkout.create");
    // The resolver did its job: the wire keys were renamed and cartId hydrated.
    expect(parked[0]!.envelope.payload).toMatchObject({
      cartId: CART_ID,
      paymentMethod: "pix",
    });
    // Nothing touched money yet.
    expect(stripeConfirm).not.toHaveBeenCalled();

    // ── Turn 2 — "sim" resumes the park and EXECUTEs the real executor ────────
    const turn2 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "sim",
    });

    expect(turn2.decision.kind).toBe("EXECUTE");
    expect((turn2.acted as { kind?: string }).kind).toBe("executed");

    // The tool result — a REAL createCheckout return, past the payer-identity
    // guard. Before the fix this was success:false with the pt-BR guard message.
    const result = (turn2.acted as { result?: Record<string, unknown> }).result;
    expect(result).toMatchObject({
      success: true,
      paymentMethod: "pix",
      pixQrCode: "https://stripe.test/pix-qr.svg",
      // BKL-241: a real QR from this seam carries the PaymentIntent id under
      // its honest name, so the expiry monitor keys on the same id the Stripe
      // webhook writes the `pix:paid:` marker under. `orderId` keeps the same
      // `pi_…` value — it is the CLIENT tracking id and the Medusa order does
      // not exist until the webhook completes the cart.
      paymentIntentId: "pi_bkl230",
      orderId: "pi_bkl230",
    });
    expect(String(result?.["message"])).not.toContain("obrigatórios");

    // The payer identity reached Stripe verbatim — the whole point of the fix.
    expect(stripeConfirm).toHaveBeenCalledTimes(1);
    const [confirmedPi, confirmParams] = stripeConfirm.mock.calls[0]!;
    expect(confirmedPi).toBe("pi_bkl230");
    expect(confirmParams.payment_method_data).toMatchObject({
      type: "pix",
      billing_details: {
        name: "João Silva",
        email: "joao@example.com",
        tax_id: "123.456.789-09",
      },
    });

    // metadata.cartId — the handle the Stripe webhook needs to create the order.
    // Its absence was BKL-230's terminal symptom.
    expect(stripeUpdate).toHaveBeenCalledWith(
      "pi_bkl230",
      { metadata: { cartId: CART_ID } },
      expect.anything(),
    );

    // The park was cleared, so a replayed "sim" cannot double-charge.
    expect(session.parksFor(CUSTOMER)).toHaveLength(0);
  });

  it("NO stored identity: the full turn still EXECUTEs but the existing guard fires and nothing reaches Stripe", async () => {
    const { harness } = buildHarness();
    // Neither tier is populated: no saved-PIX hash is seeded, and the profile
    // tier reads through the real customer service (Prisma), which this harness
    // deliberately does not stub — that read fails and is isolated to `{}`. So
    // this is the NEITHER-store case. (Per-tier precedence, including
    // profile-only, is proven at the executor seam in
    // chat-pix-checkout-identity-wiring.test.ts, where both stores are stubbed.)
    const turn1 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: CHECKOUT_UTTERANCE,
    });
    expect(turn1.decision.kind).toBe("REQUEST_CONFIRMATION");

    const turn2 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "sim",
    });

    // Reached EXECUTE and the real executor either way — the kernel path is
    // identical; only the payer identity differs.
    expect(turn2.decision.kind).toBe("EXECUTE");
    const result = (turn2.acted as { result?: Record<string, unknown> }).result;
    // With no stored identity the EXISTING guard fires — unchanged copy, and
    // critically NO Stripe confirm (the honest failure stays inert).
    expect(result).toMatchObject({
      success: false,
      paymentMethod: "pix",
      message: "Nome e email são obrigatórios para pagamento PIX.",
    });
    expect(stripeConfirm).not.toHaveBeenCalled();
  });
});
