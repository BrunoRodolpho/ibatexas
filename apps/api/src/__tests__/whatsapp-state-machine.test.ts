// Unit tests for whatsapp/state-machine.ts — mock session store.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockGetSessionState = vi.hoisted(() => vi.fn());
const mockSetSessionState = vi.hoisted(() => vi.fn());

vi.mock("../whatsapp/session.js", () => ({
  getSessionState: mockGetSessionState,
  setSessionState: mockSetSessionState,
}));

import {
  handleStateMachine,
  transitionTo,
  type ConversationState,
} from "../whatsapp/state-machine.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockSetSessionState.mockResolvedValue(undefined);
});

const HASH = "abc123def456";

// ── Explicit transition matrix ──────────────────────────────────────────────

describe("handleStateMachine — transition matrix", () => {
  // ── idle state ──────────────────────────────────────────────────────────

  describe("idle state", () => {
    beforeEach(() => mockGetSessionState.mockResolvedValue("idle"));

    it("returns null for any input (delegates to LLM)", async () => {
      expect(await handleStateMachine(HASH, "oi")).toBeNull();
      expect(await handleStateMachine(HASH, "menu")).toBeNull();
      expect(await handleStateMachine(HASH, "", "product_p1")).toBeNull();
    });
  });

  // ── browsing state ────────────────────────────────────────────────────

  describe("browsing state", () => {
    beforeEach(() => mockGetSessionState.mockResolvedValue("browsing"));

    it("product tap → add_to_cart → cart_review", async () => {
      const result = await handleStateMachine(HASH, "", "product_abc123");

      expect(result).toEqual({
        action: "add_to_cart",
        params: { productId: "abc123", quantity: "1" },
        nextState: "cart_review",
      });
    });

    it("more_products tap → search_products_next → browsing", async () => {
      const result = await handleStateMachine(HASH, "", "more_products");

      expect(result).toEqual({
        action: "search_products_next",
        nextState: "browsing",
      });
    });

    it("free text returns null (delegates to LLM)", async () => {
      expect(await handleStateMachine(HASH, "quanto custa?")).toBeNull();
    });

    it("unrecognized interactive ID returns null", async () => {
      expect(await handleStateMachine(HASH, "", "unknown_id")).toBeNull();
    });
  });

  // ── cart_review state ─────────────────────────────────────────────────

  describe("cart_review state", () => {
    beforeEach(() => mockGetSessionState.mockResolvedValue("cart_review"));

    it("checkout button → show_checkout → checkout", async () => {
      const result = await handleStateMachine(HASH, "", "checkout");

      expect(result).toEqual({
        action: "show_checkout",
        nextState: "checkout",
      });
    });

    it("continue_shopping button → show_menu → browsing", async () => {
      const result = await handleStateMachine(HASH, "", "continue_shopping");

      expect(result).toEqual({
        action: "show_menu",
        nextState: "browsing",
      });
    });

    it("free text returns null", async () => {
      expect(await handleStateMachine(HASH, "remover item")).toBeNull();
    });
  });

  // ── checkout state ────────────────────────────────────────────────────

  describe("checkout state", () => {
    beforeEach(() => mockGetSessionState.mockResolvedValue("checkout"));

    it("pay_pix button → create_checkout(pix) → idle", async () => {
      const result = await handleStateMachine(HASH, "", "pay_pix");

      expect(result).toEqual({
        action: "create_checkout",
        params: { paymentMethod: "pix" },
        nextState: "idle",
      });
    });

    it("pay_card button → create_checkout(card) → idle", async () => {
      const result = await handleStateMachine(HASH, "", "pay_card");

      expect(result).toEqual({
        action: "create_checkout",
        params: { paymentMethod: "card" },
        nextState: "idle",
      });
    });

    it("pay_cash button → create_checkout(cash) → idle", async () => {
      const result = await handleStateMachine(HASH, "", "pay_cash");

      expect(result).toEqual({
        action: "create_checkout",
        params: { paymentMethod: "cash" },
        nextState: "idle",
      });
    });

    // Text-based payment selection
    it("text 'pix' → create_checkout(pix) → idle", async () => {
      const result = await handleStateMachine(HASH, "pix");

      expect(result).toEqual({
        action: "create_checkout",
        params: { paymentMethod: "pix" },
        nextState: "idle",
      });
    });

    it("text 'PIX' (case-insensitive) → create_checkout(pix)", async () => {
      const result = await handleStateMachine(HASH, "PIX");

      expect(result).toEqual({
        action: "create_checkout",
        params: { paymentMethod: "pix" },
        nextState: "idle",
      });
    });

    it("text 'cartão' → create_checkout(card) → idle", async () => {
      const result = await handleStateMachine(HASH, "cartão");

      expect(result).toEqual({
        action: "create_checkout",
        params: { paymentMethod: "card" },
        nextState: "idle",
      });
    });

    it("text 'cartao' (no accent) → create_checkout(card)", async () => {
      const result = await handleStateMachine(HASH, "cartao");

      expect(result).toEqual({
        action: "create_checkout",
        params: { paymentMethod: "card" },
        nextState: "idle",
      });
    });

    it("text 'card' (English) → create_checkout(card)", async () => {
      const result = await handleStateMachine(HASH, "card");

      expect(result).toEqual({
        action: "create_checkout",
        params: { paymentMethod: "card" },
        nextState: "idle",
      });
    });

    it("text 'dinheiro' → create_checkout(cash) → idle", async () => {
      const result = await handleStateMachine(HASH, "dinheiro");

      expect(result).toEqual({
        action: "create_checkout",
        params: { paymentMethod: "cash" },
        nextState: "idle",
      });
    });

    it("text 'cash' (English) → create_checkout(cash)", async () => {
      const result = await handleStateMachine(HASH, "cash");

      expect(result).toEqual({
        action: "create_checkout",
        params: { paymentMethod: "cash" },
        nextState: "idle",
      });
    });

    it("unrecognized text returns null", async () => {
      expect(await handleStateMachine(HASH, "boleto")).toBeNull();
    });

    it("unrecognized interactive ID returns null", async () => {
      expect(await handleStateMachine(HASH, "", "pay_boleto")).toBeNull();
    });
  });

  // ── reservation_flow state ────────────────────────────────────────────

  describe("reservation_flow state", () => {
    beforeEach(() => mockGetSessionState.mockResolvedValue("reservation_flow"));

    it("always returns null (delegates to LLM)", async () => {
      expect(await handleStateMachine(HASH, "19h")).toBeNull();
      expect(await handleStateMachine(HASH, "", "slot_s1")).toBeNull();
    });
  });

  // ── unknown/default state ─────────────────────────────────────────────

  describe("unknown/default state", () => {
    it("returns null for unrecognized state", async () => {
      mockGetSessionState.mockResolvedValue("some_unknown_state");
      expect(await handleStateMachine(HASH, "oi")).toBeNull();
    });
  });
});

// ── transitionTo ──────────────────────────────────────────────────────────────

describe("transitionTo", () => {
  it("calls setSessionState with hash and new state", async () => {
    await transitionTo(HASH, "checkout");

    expect(mockSetSessionState).toHaveBeenCalledWith(HASH, "checkout");
  });

  it("can transition to all valid states", async () => {
    const states: ConversationState[] = [
      "idle",
      "browsing",
      "cart_review",
      "checkout",
      "reservation_flow",
    ];

    for (const state of states) {
      await transitionTo(HASH, state);
    }

    expect(mockSetSessionState).toHaveBeenCalledTimes(states.length);
  });
});

// ── Property / invariant tests (budget: <=150 lines) ──────────────────────────

describe("state machine invariants", () => {
  // Invariant 1: Cannot reach checkout without going through cart_review
  it("no checkout without prior cart_review (confirmation gate)", async () => {
    // From idle, there is no direct path to checkout
    mockGetSessionState.mockResolvedValue("idle");
    const fromIdle = await handleStateMachine(HASH, "", "checkout");
    expect(fromIdle).toBeNull();

    // From browsing, tapping checkout does not go to checkout
    mockGetSessionState.mockResolvedValue("browsing");
    const fromBrowsing = await handleStateMachine(HASH, "", "checkout");
    expect(fromBrowsing).toBeNull();

    // Only from cart_review can we reach checkout
    mockGetSessionState.mockResolvedValue("cart_review");
    const fromCart = await handleStateMachine(HASH, "", "checkout");
    expect(fromCart).not.toBeNull();
    expect(fromCart!.nextState).toBe("checkout");
  });

  // Invariant 2: No payment processing without being in checkout state
  it("no payment without checkout state (cart required)", async () => {
    const paymentIds = ["pay_pix", "pay_card", "pay_cash"];
    const nonCheckoutStates: ConversationState[] = ["idle", "browsing", "cart_review", "reservation_flow"];

    for (const state of nonCheckoutStates) {
      mockGetSessionState.mockResolvedValue(state);
      for (const payId of paymentIds) {
        const result = await handleStateMachine(HASH, "", payId);
        // None of these should produce a create_checkout action
        if (result !== null) {
          expect(result.action).not.toBe("create_checkout");
        }
      }
    }
  });

  // Invariant 3: No double-checkout — checkout always transitions to idle
  it("no double-checkout — checkout transitions to idle on payment", async () => {
    mockGetSessionState.mockResolvedValue("checkout");

    const allPayments = [
      { input: "pix", interactiveId: undefined },
      { input: "", interactiveId: "pay_pix" },
      { input: "", interactiveId: "pay_card" },
      { input: "", interactiveId: "pay_cash" },
      { input: "dinheiro", interactiveId: undefined },
      { input: "cartão", interactiveId: undefined },
    ];

    for (const { input, interactiveId } of allPayments) {
      const result = await handleStateMachine(HASH, input, interactiveId);
      expect(result).not.toBeNull();
      expect(result!.nextState).toBe("idle");
      expect(result!.action).toBe("create_checkout");
    }
  });

  // Random event sequence: 20 random events should never throw
  it("random event sequence never throws unhandled error", async () => {
    const states: ConversationState[] = ["idle", "browsing", "cart_review", "checkout", "reservation_flow"];
    const interactiveIds = [
      undefined, "product_x1", "more_products", "checkout",
      "continue_shopping", "pay_pix", "pay_card", "pay_cash",
      "unknown_thing", "slot_s1", "confirm_yes",
    ];
    const textInputs = [
      "oi", "pix", "cartão", "dinheiro", "cash", "card",
      "", "menu", "carrinho", "quanto custa?",
    ];

    for (let i = 0; i < 20; i++) {
      const randomState = states[Math.floor(Math.random() * states.length)];
      const randomId = interactiveIds[Math.floor(Math.random() * interactiveIds.length)];
      const randomText = textInputs[Math.floor(Math.random() * textInputs.length)];

      mockGetSessionState.mockResolvedValue(randomState);

      // Should never throw — either returns StateAction or null
      const result = await handleStateMachine(HASH, randomText, randomId);
      expect(result === null || typeof result === "object").toBe(true);

      if (result !== null) {
        expect(typeof result.action).toBe("string");
        expect(typeof result.nextState).toBe("string");
      }
    }
  });
});
