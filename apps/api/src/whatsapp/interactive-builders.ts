// Pre-built interactive message builders for common WhatsApp scenarios.
//
// Each builder returns a structured message that can be sent via
// sendInteractiveList / sendInteractiveButtons from client.ts.
// Constraints: list rows max 8 (UX), title max 24 chars, desc max 72 chars,
// button text max 20 chars, max 3 buttons.

import type { InteractiveButton, InteractiveRow, InteractiveSection } from "./client.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InteractiveListMessage {
  type: "list";
  body: string;
  buttonText: string;
  sections: InteractiveSection[];
}

export interface InteractiveButtonMessage {
  type: "buttons";
  body: string;
  buttons: InteractiveButton[];
}

export type InteractiveMessage = InteractiveListMessage | InteractiveButtonMessage;

interface ProductItem {
  id: string;
  title: string;
  /** Price in centavos */
  priceCentavos?: number;
  /** Serving description, e.g. "Serve 4 pessoas" */
  servingInfo?: string;
}

interface CartItem {
  title: string;
  quantity: number;
  priceCentavos: number;
}

interface Cart {
  items: CartItem[];
  totalCentavos: number;
}

interface TimeSlot {
  id: string;
  time: string;
  partySize: number;
  location?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

const MAX_ROWS = 8;
const MAX_TITLE_LEN = 24;
const MAX_DESC_LEN = 72;
const MAX_BUTTON_LEN = 20;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function formatPrice(centavos: number): string {
  return `R$ ${(centavos / 100).toFixed(2).replace(".", ",")}`;
}

// ── Builders ────────────────────────────────────────────────────────────────────

/**
 * Build a product list interactive message.
 * Shows up to 8 items; if more, adds a "Ver mais" row.
 */
export function buildProductListMessage(
  products: ProductItem[],
  hasMore = false,
): InteractiveListMessage {
  const visibleProducts = products.slice(0, MAX_ROWS - (hasMore ? 1 : 0));

  const rows: InteractiveRow[] = visibleProducts.map((p) => {
    const descParts: string[] = [];
    if (p.priceCentavos !== undefined) descParts.push(formatPrice(p.priceCentavos));
    if (p.servingInfo) descParts.push(p.servingInfo);
    const description = descParts.join(" • ") || undefined;

    return {
      id: `product_${p.id}`,
      title: truncate(p.title, MAX_TITLE_LEN),
      description: description ? truncate(description, MAX_DESC_LEN) : undefined,
    };
  });

  if (hasMore || products.length > MAX_ROWS) {
    rows.push({
      id: "more_products",
      title: "Ver mais resultados",
      description: `+${products.length - visibleProducts.length} itens disponíveis`,
    });
  }

  return {
    type: "list",
    body: "Confira nosso cardápio 🍖",
    buttonText: truncate("Ver cardápio", MAX_BUTTON_LEN),
    sections: [{ title: "Produtos", rows }],
  };
}

/**
 * Build a cart summary with action buttons.
 */
export function buildCartSummaryMessage(cart: Cart): InteractiveButtonMessage {
  const lines = cart.items.map(
    (item) => `• ${item.quantity}x ${item.title} — ${formatPrice(item.priceCentavos)}`,
  );
  lines.push("", `*Total: ${formatPrice(cart.totalCentavos)}*`);

  return {
    type: "buttons",
    body: lines.join("\n"),
    buttons: [
      { id: "checkout", title: truncate("Finalizar Pedido", MAX_BUTTON_LEN) },
      { id: "continue_shopping", title: truncate("Continuar Comprando", MAX_BUTTON_LEN) },
    ],
  };
}

/**
 * Build checkout confirmation with payment method buttons.
 */
export function buildCheckoutConfirmation(totalCentavos: number): InteractiveButtonMessage {
  return {
    type: "buttons",
    body: `Total do pedido: *${formatPrice(totalCentavos)}*\n\nComo deseja pagar?`,
    buttons: [
      { id: "pay_pix", title: "PIX" },
      { id: "pay_card", title: "Cartão" },
      { id: "pay_cash", title: "Dinheiro" },
    ],
  };
}

/**
 * Build reservation time slot options.
 */
export function buildReservationOptions(slots: TimeSlot[]): InteractiveListMessage {
  const rows: InteractiveRow[] = slots.slice(0, MAX_ROWS).map((slot) => {
    const desc = slot.location
      ? `Mesa para ${slot.partySize} • ${slot.location}`
      : `Mesa para ${slot.partySize}`;

    return {
      id: `slot_${slot.id}`,
      title: truncate(slot.time, MAX_TITLE_LEN),
      description: truncate(desc, MAX_DESC_LEN),
    };
  });

  return {
    type: "list",
    body: "Horários disponíveis 📅",
    buttonText: truncate("Ver horários", MAX_BUTTON_LEN),
    sections: [{ title: "Horários", rows }],
  };
}

/**
 * Build a generic yes/no confirmation.
 */
export function buildYesNoConfirmation(question: string): InteractiveButtonMessage {
  return {
    type: "buttons",
    body: question,
    buttons: [
      { id: "confirm_yes", title: "Sim" },
      { id: "confirm_no", title: "Não" },
    ],
  };
}
