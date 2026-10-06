/**
 * BKL-230 (chat-wiring slice) — the conversational `order.checkout.create`
 * executor must thread the authenticated customer's PIX payer identity into
 * `createCheckout`.
 *
 * ROOT CAUSE these tests lock down: `createCheckout`'s PIX branch
 * (packages/tools/src/cart/create-checkout.ts) hard-requires
 * `extra.customerName || extra.customerEmail` because Stripe's PIX confirm needs
 * a payer. The HTTP cart route always supplied it and calls `createCheckout`
 * directly; the chat/WhatsApp registry executor called it with NO third argument,
 * so EVERY chat PIX checkout returned "Nome e email são obrigatórios para
 * pagamento PIX." — no QR, no `metadata.cartId`, no `payment_intent.succeeded`,
 * no order. create-checkout.test.ts's "payer-identity guard (BKL-230)" block
 * proves both sides of that guard at the tool seam; THIS file proves the caller
 * side — that the executor now resolves an identity and hands it over.
 *
 * PII POSTURE asserted here: the identity never comes from the model or the
 * payload. It is resolved inside the executor from the SESSION's customerId
 * only, so nothing is added to any extraction schema or prompt, and no argument
 * exists through which another customer's details could be selected (see the
 * IDOR block).
 *
 * `@ibatexas/tools` stays REAL except `createCheckout` + `getRedisClient` (both
 * spied) — mirrors order-amend-granular-executors.test.ts's importOriginal
 * pattern so the other registered tools still construct at module load, and
 * keeps `rk()` real so the asserted Redis key is the genuinely namespaced one.
 * `@ibatexas/domain` is a flat factory mock (this codebase's convention for that
 * package) providing the two exports the registry + resolver use.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Capsule } from "@claustrum/core";

const mockCreateCheckout = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockHGetAll = vi.hoisted(() => vi.fn());
const mockExpire = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return {
    ...actual,
    createCheckout: mockCreateCheckout,
    getRedisClient: mockGetRedisClient,
  };
});
vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({ getById: mockGetById }),
  createOrderService: () => ({ getOrder: vi.fn() }),
}));

const { listIbatexasToolPacks, registerIbatexasToolPacks } = await import(
  "../tools/register-ibatexas-tool-packs.js"
);
const { rk } = await import("@ibatexas/tools");
const { createToolRegistry } = await import("@claustrum/core");

const SESSION_CUSTOMER = "cus_session_owner";
const OTHER_CUSTOMER = "cus_someone_else";

/** Minimal Capsule double — mirrors order-amend-granular-executors.test.ts. */
function mkCapsule(customerId: string): Capsule {
  return {
    customerId,
    channel: "web",
    conversationId: "conv-bkl230",
    actor: { principal: "llm", sessionId: "conv-bkl230" },
  } as unknown as Capsule;
}

function checkoutTool() {
  const tool = listIbatexasToolPacks().find(
    (t) => (t.capability as unknown as string) === "order.checkout.create",
  );
  if (!tool) throw new Error("order.checkout.create is not registered");
  return tool;
}

const PIX_INPUT = { cartId: "cart_01", paymentMethod: "pix" };

/** Seed the saved-PIX-details hash PER KEY, so a test can prove which key was
 *  actually read rather than trusting a single catch-all return value. */
function seedSavedPixByKey(byKey: Record<string, Record<string, string>>) {
  mockHGetAll.mockImplementation(async (key: string) => byKey[key] ?? {});
}

/** The third argument the executor handed to createCheckout — the payer identity. */
function extraPassedToCreateCheckout(): unknown {
  expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
  return mockCreateCheckout.mock.calls[0]![2];
}

/** The AgentContext the executor handed to createCheckout. */
function ctxPassedToCreateCheckout(): { customerId?: string } {
  return mockCreateCheckout.mock.calls[0]![1] as { customerId?: string };
}

/**
 * The `createCheckout` double ENFORCES the real PIX precondition instead of
 * returning success unconditionally.
 *
 * This matters because of a hard-won lesson on this very ticket: a sibling BKL-230
 * leg stayed green over a dead money path because its mock returned the same value
 * whether the call succeeded or was a no-op, erasing the distinction the test
 * existed to prove. A `mockResolvedValue({ success: true })` here would do exactly
 * that — the wiring could regress to `createCheckout(input, ctx)` and every result
 * assertion would still pass. So this double reproduces the guard at
 * create-checkout.ts:598-605 verbatim: no payer identity ⇒ the real pt-BR failure.
 */
function realisticCreateCheckout(
  input: unknown,
  _ctx: unknown,
  extra?: { customerName?: string; customerEmail?: string },
) {
  const { paymentMethod } = input as { paymentMethod?: string };
  if (paymentMethod === "pix" && !extra?.customerName && !extra?.customerEmail) {
    return Promise.resolve({
      success: false,
      paymentMethod: "pix",
      message: "Nome e email são obrigatórios para pagamento PIX.",
    });
  }
  return Promise.resolve({
    success: true,
    paymentMethod,
    ...(paymentMethod === "pix" ? { pixQrCode: "https://stripe.com/pix-qr.svg" } : {}),
    message: "ok",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateCheckout.mockImplementation(realisticCreateCheckout);
  mockGetRedisClient.mockResolvedValue({ hGetAll: mockHGetAll, expire: mockExpire });
  mockHGetAll.mockResolvedValue({});
  mockExpire.mockResolvedValue(1);
  mockGetById.mockRejectedValue(new Error("customer not seeded in this test"));
});

describe("order.checkout.create executor — PIX payer identity is threaded (BKL-230)", () => {
  it("an authenticated PIX checkout passes the stored identity to createCheckout as the third argument", async () => {
    seedSavedPixByKey({
      [rk(`customer:pix:${SESSION_CUSTOMER}`)]: {
        name: "João Silva",
        email: "joao@example.com",
        cpf: "123.456.789-09",
      },
    });

    const result = await checkoutTool().execute(PIX_INPUT, mkCapsule(SESSION_CUSTOMER));

    // The regression itself: this argument used to be absent on every chat turn.
    expect(extraPassedToCreateCheckout()).toEqual({
      customerName: "João Silva",
      customerEmail: "joao@example.com",
      customerTaxId: "123.456.789-09",
    });
    // The cart id and the session's customer still flow through untouched.
    expect(mockCreateCheckout.mock.calls[0]![0]).toMatchObject({
      cartId: "cart_01",
      paymentMethod: "pix",
    });
    expect(ctxPassedToCreateCheckout().customerId).toBe(SESSION_CUSTOMER);
    // Non-vacuous: the double enforces the real guard, so a regression to
    // `createCheckout(input, ctx)` turns this into the pt-BR failure.
    expect(result).toMatchObject({
      success: true,
      paymentMethod: "pix",
      pixQrCode: "https://stripe.com/pix-qr.svg",
    });
  });

  it("refreshes the saved-PIX-details sliding TTL on read, like the web checkout does", async () => {
    seedSavedPixByKey({
      [rk(`customer:pix:${SESSION_CUSTOMER}`)]: { email: "joao@example.com" },
    });

    await checkoutTool().execute(PIX_INPUT, mkCapsule(SESSION_CUSTOMER));

    expect(mockExpire).toHaveBeenCalledWith(
      rk(`customer:pix:${SESSION_CUSTOMER}`),
      90 * 86400,
    );
  });
});

describe("order.checkout.create executor — identity precedence (BKL-230)", () => {
  it("saved PIX details WIN over the profile fallback when both exist", async () => {
    seedSavedPixByKey({
      [rk(`customer:pix:${SESSION_CUSTOMER}`)]: {
        name: "Nome Salvo PIX",
        email: "salvo-pix@example.com",
        cpf: "111.444.777-35",
      },
    });
    mockGetById.mockResolvedValue({
      name: "Nome Do Perfil",
      email: "perfil@example.com",
      cpf: "123.456.789-09",
    });

    await checkoutTool().execute(PIX_INPUT, mkCapsule(SESSION_CUSTOMER));

    expect(extraPassedToCreateCheckout()).toEqual({
      customerName: "Nome Salvo PIX",
      customerEmail: "salvo-pix@example.com",
      customerTaxId: "111.444.777-35",
    });
  });

  it("profile-only works — a customer who onboarded but never saved PIX details still checks out", async () => {
    mockHGetAll.mockResolvedValue({});
    mockGetById.mockResolvedValue({
      name: "Maria Souza",
      email: "maria@example.com",
      cpf: "123.456.789-09",
    });

    await checkoutTool().execute(PIX_INPUT, mkCapsule(SESSION_CUSTOMER));

    expect(extraPassedToCreateCheckout()).toEqual({
      customerName: "Maria Souza",
      customerEmail: "maria@example.com",
      customerTaxId: "123.456.789-09",
    });
    expect(mockGetById).toHaveBeenCalledWith(SESSION_CUSTOMER);
  });

  it("merges PER FIELD: a saved hash holding only a CPF does not blank out the profile's name/email", async () => {
    // The combination that would otherwise still hit the PIX guard and fail the
    // checkout despite the customer having a perfectly good name + email.
    seedSavedPixByKey({
      [rk(`customer:pix:${SESSION_CUSTOMER}`)]: { cpf: "111.444.777-35" },
    });
    mockGetById.mockResolvedValue({
      name: "Maria Souza",
      email: "maria@example.com",
      cpf: "123.456.789-09",
    });

    await checkoutTool().execute(PIX_INPUT, mkCapsule(SESSION_CUSTOMER));

    expect(extraPassedToCreateCheckout()).toEqual({
      customerName: "Maria Souza",
      customerEmail: "maria@example.com",
      customerTaxId: "111.444.777-35",
    });
  });

  it("ignores blank stored values so an empty string can never satisfy the PIX guard", async () => {
    // `cachePixDetailsForCustomer` persists "" for absent fields through the
    // save envelope, so a whitespace/empty row is a real shape here.
    seedSavedPixByKey({
      [rk(`customer:pix:${SESSION_CUSTOMER}`)]: { name: "   ", email: "" },
    });
    mockGetById.mockResolvedValue({ name: "", email: "  ", cpf: null });

    const result = await checkoutTool().execute(PIX_INPUT, mkCapsule(SESSION_CUSTOMER));

    expect(extraPassedToCreateCheckout()).toEqual({});
    expect(result).toMatchObject({
      success: false,
      message: "Nome e email são obrigatórios para pagamento PIX.",
    });
  });

  it("neither store has an identity → NO fabricated identity; the existing guard failure is preserved verbatim", async () => {
    mockHGetAll.mockResolvedValue({});
    mockGetById.mockResolvedValue({ name: null, email: null, cpf: null });

    const result = await checkoutTool().execute(PIX_INPUT, mkCapsule(SESSION_CUSTOMER));

    // Empty — NOT a placeholder name/email invented to slip past the guard.
    expect(extraPassedToCreateCheckout()).toEqual({});
    // The EXISTING message, unchanged by this slice (no copy changes).
    expect(result).toMatchObject({
      success: false,
      paymentMethod: "pix",
      message: "Nome e email são obrigatórios para pagamento PIX.",
    });
  });

  it("a guest session resolves nothing, performs NO identity I/O, and keeps the honest failure", async () => {
    // agentCtxFromCapsule strips guest markers, so ctx.customerId is undefined.
    const result = await checkoutTool().execute(PIX_INPUT, mkCapsule("guest:abc123"));

    expect(extraPassedToCreateCheckout()).toEqual({});
    expect(ctxPassedToCreateCheckout().customerId).toBeUndefined();
    expect(mockGetRedisClient).not.toHaveBeenCalled();
    expect(mockGetById).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      message: "Nome e email são obrigatórios para pagamento PIX.",
    });
  });

  it("survives a Redis outage by falling back to the profile (per-source failure isolation)", async () => {
    mockGetRedisClient.mockRejectedValue(new Error("redis down"));
    mockGetById.mockResolvedValue({
      name: "Maria Souza",
      email: "maria@example.com",
      cpf: null,
    });

    await checkoutTool().execute(PIX_INPUT, mkCapsule(SESSION_CUSTOMER));

    expect(extraPassedToCreateCheckout()).toEqual({
      customerName: "Maria Souza",
      customerEmail: "maria@example.com",
    });
  });
});

describe("order.checkout.create executor — non-PIX methods are untouched (BKL-230)", () => {
  it.each(["card", "cash"])(
    "%s: no payer identity is resolved and no identity I/O is performed",
    async (paymentMethod) => {
      await checkoutTool().execute(
        { cartId: "cart_01", paymentMethod },
        mkCapsule(SESSION_CUSTOMER),
      );

      expect(extraPassedToCreateCheckout()).toBeUndefined();
      expect(mockGetRedisClient).not.toHaveBeenCalled();
      expect(mockGetById).not.toHaveBeenCalled();
    },
  );
});

describe("order.checkout.create — reached through the REAL registry dispatch (BKL-230)", () => {
  /**
   * The turn-seam link this covers. claustrum's `dispatchDecision` executes a
   * kernel-approved intent via `capsule.tools.resolveTool(envelope.kind)`, so the
   * wiring only matters if it is reachable THROUGH that resolution — not merely
   * present in the `listIbatexasToolPacks()` array. This drives the real
   * `createToolRegistry()` + `registerIbatexasToolPacks()` + `resolveTool` path
   * with the payload shape `resolve-and-assemble` actually produces for a chat
   * checkout ("pago no pix" → wire `payment_method` → renamed to the internal
   * `paymentMethod` key; that rename is proven in resolve-and-assemble.test.ts).
   *
   * NOTE on scope: there is no customer-plane handleTurn harness in this repo to
   * hang a full turn off (the real-handleTurn harness is ops-plane only, and the
   * Docker-gated scripted-pipeline suite has no Medusa to serve the cart reads a
   * checkout needs). The chain is therefore covered link-by-link at each seam:
   * utterance→payload (resolve-and-assemble.test.ts) → registry dispatch→executor
   * (here) → identity→createCheckout (above) → PIX guard→Stripe confirm with the
   * payer + metadata.cartId (create-checkout.test.ts's guard block).
   */
  it("resolveTool('order.checkout.create') returns the wired executor, which threads the identity", async () => {
    const registry = createToolRegistry();
    registerIbatexasToolPacks(registry);

    seedSavedPixByKey({
      [rk(`customer:pix:${SESSION_CUSTOMER}`)]: {
        name: "João Silva",
        email: "joao@example.com",
        cpf: "123.456.789-09",
      },
    });

    const capsule = mkCapsule(SESSION_CUSTOMER);
    // Exactly how dispatchDecision resolves it: by the envelope's intent kind.
    const tool = registry.resolveTool(
      "order.checkout.create" as never,
      capsule,
    );
    expect(tool).toBeDefined();

    const result = await tool.execute(
      // The resolver-hydrated payload: cartId from the session's active cart,
      // paymentMethod post-rename. No pixDetails — the chat plane never has it.
      { cartId: "cart_01", paymentMethod: "pix", deliveryType: "pickup" },
      capsule,
    );

    expect(extraPassedToCreateCheckout()).toEqual({
      customerName: "João Silva",
      customerEmail: "joao@example.com",
      customerTaxId: "123.456.789-09",
    });
    // Reached through real dispatch AND past the guard the double enforces.
    expect(result).toMatchObject({
      success: true,
      paymentMethod: "pix",
      pixQrCode: "https://stripe.com/pix-qr.svg",
    });
  });
});

describe("order.checkout.create executor — IDOR: identity comes from the SESSION only (BKL-230)", () => {
  it("never selects another customer's saved PIX details, even when theirs are the only ones stored", async () => {
    // Both customers have saved details; the turn belongs to SESSION_CUSTOMER.
    seedSavedPixByKey({
      [rk(`customer:pix:${OTHER_CUSTOMER}`)]: {
        name: "Vitima Alheia",
        email: "vitima@example.com",
        cpf: "111.444.777-35",
      },
      [rk(`customer:pix:${SESSION_CUSTOMER}`)]: {
        name: "Dono Da Sessao",
        email: "dono@example.com",
        cpf: "123.456.789-09",
      },
    });
    mockGetById.mockImplementation(async (id: string) => {
      if (id === OTHER_CUSTOMER) {
        return { name: "Vitima Alheia", email: "vitima@example.com", cpf: "111.444.777-35" };
      }
      return { name: "Dono Da Sessao", email: "dono@example.com", cpf: "123.456.789-09" };
    });

    await checkoutTool().execute(PIX_INPUT, mkCapsule(SESSION_CUSTOMER));

    const extra = extraPassedToCreateCheckout() as Record<string, string>;
    expect(extra).toEqual({
      customerName: "Dono Da Sessao",
      customerEmail: "dono@example.com",
      customerTaxId: "123.456.789-09",
    });
    // Nothing belonging to the other customer leaked into the payer identity.
    expect(JSON.stringify(extra)).not.toContain("Vitima");
    expect(JSON.stringify(extra)).not.toContain("vitima@example.com");
    expect(JSON.stringify(extra)).not.toContain("111.444.777-35");

    // Both stores were addressed by the SESSION's id exclusively.
    expect(mockHGetAll).toHaveBeenCalledTimes(1);
    expect(mockHGetAll).toHaveBeenCalledWith(rk(`customer:pix:${SESSION_CUSTOMER}`));
    expect(mockGetById).toHaveBeenCalledTimes(1);
    expect(mockGetById).toHaveBeenCalledWith(SESSION_CUSTOMER);
  });

  it("a customerId carried on the tool PAYLOAD cannot redirect the identity lookup", async () => {
    // The kernel payload is model/caller-shaped; only the Capsule is trusted.
    seedSavedPixByKey({
      [rk(`customer:pix:${OTHER_CUSTOMER}`)]: {
        name: "Vitima Alheia",
        email: "vitima@example.com",
      },
      [rk(`customer:pix:${SESSION_CUSTOMER}`)]: { email: "dono@example.com" },
    });
    mockGetById.mockResolvedValue({ name: null, email: null, cpf: null });

    await checkoutTool().execute(
      {
        ...PIX_INPUT,
        customerId: OTHER_CUSTOMER,
        pixDetails: {
          name: "Vitima Alheia",
          email: "vitima@example.com",
          cpf: "111.444.777-35",
        },
      },
      mkCapsule(SESSION_CUSTOMER),
    );

    // Neither the payload's customerId nor its pixDetails influenced the result.
    expect(extraPassedToCreateCheckout()).toEqual({ customerEmail: "dono@example.com" });
    expect(mockHGetAll).toHaveBeenCalledWith(rk(`customer:pix:${SESSION_CUSTOMER}`));
    expect(mockGetById).toHaveBeenCalledWith(SESSION_CUSTOMER);
  });
});
