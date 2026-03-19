// Conversation state machine for deterministic WhatsApp flows.
//
// Hybrid model: state machine handles known flows (faster, cheaper);
// unrecognized input falls through to the LLM agent.
//
// States: idle | browsing | cart_review | checkout
// Stored in Redis session hash: rk('wa:phone:{phoneHash}') → 'state' field
//
// Transitions:
//   idle → "menu"/"cardápio" → browsing (show product list)
//   browsing → tap product → add to cart → cart_review
//   cart_review → "Finalizar Pedido" → checkout (ask payment method)
//   checkout → "PIX"/"Cartão"/"Dinheiro" → create_checkout → idle
//   idle → "reserva" → falls through to LLM agent (reservation tools handle the flow)
//   any state → free-text that doesn't match → LLM agent (fallback)
//
// Timeout/reset: no explicit reset. State inherits the session's 24h TTL.
// Stale state (e.g. "checkout" after abandonment) returns null on unrecognized
// input, falling through to the LLM agent which handles it gracefully.

import { getSessionState, setSessionState } from "./session.js";

export type ConversationState =
  | "idle"
  | "browsing"
  | "cart_review"
  | "checkout";

export interface StateAction {
  /** The action to execute deterministically */
  action: string;
  /** Parameters for the action (e.g., product ID, payment method) */
  params?: Record<string, string>;
  /** New state to transition to after action */
  nextState: ConversationState;
}

/**
 * Try to handle user input deterministically based on current state.
 * Returns null if state machine cannot handle — caller should use LLM agent.
 */
export async function handleStateMachine(
  hash: string,
  input: string,
  interactiveId?: string,
): Promise<StateAction | null> {
  const state = (await getSessionState(hash)) as ConversationState;

  switch (state) {
    case "browsing":
      return handleBrowsing(input, interactiveId);

    case "cart_review":
      return handleCartReview(input, interactiveId);

    case "checkout":
      return handleCheckout(input, interactiveId);

    case "idle":
    default:
      return null;
  }
}

function handleBrowsing(input: string, interactiveId?: string): StateAction | null {
  // User tapped a product from the interactive list
  if (interactiveId?.startsWith("product_")) {
    const productId = interactiveId.replace("product_", "");
    return {
      action: "add_to_cart",
      params: { productId, quantity: "1" },
      nextState: "cart_review",
    };
  }

  // User tapped "Ver mais resultados"
  if (interactiveId === "more_products") {
    return {
      action: "search_products_next",
      nextState: "browsing",
    };
  }

  return null;
}

function handleCartReview(input: string, interactiveId?: string): StateAction | null {
  if (interactiveId === "checkout") {
    return {
      action: "show_checkout",
      nextState: "checkout",
    };
  }

  if (interactiveId === "continue_shopping") {
    return {
      action: "show_menu",
      nextState: "browsing",
    };
  }

  return null;
}

function handleCheckout(input: string, interactiveId?: string): StateAction | null {
  const paymentMethods: Record<string, string> = {
    pay_pix: "pix",
    pay_card: "card",
    pay_cash: "cash",
  };

  if (interactiveId && paymentMethods[interactiveId]) {
    return {
      action: "create_checkout",
      params: { paymentMethod: paymentMethods[interactiveId] },
      nextState: "idle",
    };
  }

  // Also handle text-based payment selection
  const normalized = input.toLowerCase().trim();
  if (normalized === "pix") {
    return { action: "create_checkout", params: { paymentMethod: "pix" }, nextState: "idle" };
  }
  if (normalized.includes("cartão") || normalized.includes("cartao") || normalized === "card") {
    return { action: "create_checkout", params: { paymentMethod: "card" }, nextState: "idle" };
  }
  if (normalized === "dinheiro" || normalized === "cash") {
    return { action: "create_checkout", params: { paymentMethod: "cash" }, nextState: "idle" };
  }

  return null;
}

/**
 * Transition to a new state. Wraps setSessionState for consistency.
 */
export async function transitionTo(hash: string, newState: ConversationState): Promise<void> {
  await setSessionState(hash, newState);
}
