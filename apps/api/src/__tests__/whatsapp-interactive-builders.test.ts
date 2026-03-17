// Unit tests for whatsapp/interactive-builders.ts — pure builders, no mocks needed.

import { describe, it, expect } from "vitest";
import {
  buildProductListMessage,
  buildCartSummaryMessage,
  buildCheckoutConfirmation,
  buildReservationOptions,
  buildYesNoConfirmation,
} from "../whatsapp/interactive-builders.js";

// ── buildProductListMessage ───────────────────────────────────────────────────

describe("buildProductListMessage", () => {
  it("builds a list with a single product", () => {
    const msg = buildProductListMessage([
      { id: "p1", title: "Costela Defumada", priceCentavos: 8900, servingInfo: "Serve 4 pessoas" },
    ]);

    expect(msg.type).toBe("list");
    expect(msg.sections).toHaveLength(1);
    expect(msg.sections[0].title).toBe("Produtos");
    expect(msg.sections[0].rows).toHaveLength(1);
    expect(msg.sections[0].rows[0].id).toBe("product_p1");
    expect(msg.sections[0].rows[0].title).toBe("Costela Defumada");
    expect(msg.sections[0].rows[0].description).toBe("R$ 89,00 • Serve 4 pessoas");
  });

  it("formats price-only description when no servingInfo", () => {
    const msg = buildProductListMessage([
      { id: "p2", title: "Brisket", priceCentavos: 12500 },
    ]);

    expect(msg.sections[0].rows[0].description).toBe("R$ 125,00");
  });

  it("sets description to undefined when no price or servingInfo", () => {
    const msg = buildProductListMessage([{ id: "p3", title: "Item Simples" }]);

    expect(msg.sections[0].rows[0].description).toBeUndefined();
  });

  it("truncates long titles to 24 chars with ellipsis", () => {
    const msg = buildProductListMessage([
      { id: "p4", title: "Costela Bovina Defumada Premium Texas Style" },
    ]);

    const title = msg.sections[0].rows[0].title;
    expect(title.length).toBeLessThanOrEqual(24);
    expect(title.endsWith("…")).toBe(true);
  });

  it("truncates long descriptions to 72 chars with ellipsis", () => {
    const longServing = "Serve aproximadamente 10 a 12 pessoas com acompanhamentos inclusos no pacote especial";
    const msg = buildProductListMessage([
      { id: "p5", title: "Costela", priceCentavos: 8900, servingInfo: longServing },
    ]);

    const desc = msg.sections[0].rows[0].description!;
    expect(desc.length).toBeLessThanOrEqual(72);
    expect(desc.endsWith("…")).toBe(true);
  });

  it("limits visible products to 8 rows", () => {
    const products = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      title: `Produto ${i}`,
    }));

    const msg = buildProductListMessage(products);
    const rows = msg.sections[0].rows;

    // 8 product rows + 1 "Ver mais" row
    expect(rows.length).toBeLessThanOrEqual(9);
    expect(rows.at(-1)!.id).toBe("more_products");
    expect(rows.at(-1)!.title).toBe("Ver mais resultados");
  });

  it("adds 'Ver mais' row when hasMore flag is true even with few products", () => {
    const msg = buildProductListMessage(
      [{ id: "p1", title: "Costela" }],
      true,
    );

    const rows = msg.sections[0].rows;
    expect(rows.at(-1)!.id).toBe("more_products");
  });

  it("does not add 'Ver mais' for exactly 8 products without hasMore", () => {
    const products = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      title: `Produto ${i}`,
    }));

    const msg = buildProductListMessage(products, false);
    const rows = msg.sections[0].rows;

    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.id !== "more_products")).toBe(true);
  });

  it("builds empty list when no products provided", () => {
    const msg = buildProductListMessage([]);

    expect(msg.sections[0].rows).toHaveLength(0);
    expect(msg.buttonText).toBe("Ver cardápio");
  });

  it("formats centavos correctly (integer to R$ with comma)", () => {
    const msg = buildProductListMessage([
      { id: "p6", title: "Item", priceCentavos: 1050 },
    ]);

    expect(msg.sections[0].rows[0].description).toBe("R$ 10,50");
  });

  it("formats zero price as R$ 0,00", () => {
    const msg = buildProductListMessage([
      { id: "p7", title: "Grátis", priceCentavos: 0 },
    ]);

    expect(msg.sections[0].rows[0].description).toBe("R$ 0,00");
  });
});

// ── buildCartSummaryMessage ───────────────────────────────────────────────────

describe("buildCartSummaryMessage", () => {
  it("formats cart items with quantities and total", () => {
    const msg = buildCartSummaryMessage({
      items: [
        { title: "Costela", quantity: 2, priceCentavos: 8900 },
        { title: "Brisket", quantity: 1, priceCentavos: 12500 },
      ],
      totalCentavos: 30300,
    });

    expect(msg.type).toBe("buttons");
    expect(msg.body).toContain("2x Costela");
    expect(msg.body).toContain("R$ 89,00");
    expect(msg.body).toContain("1x Brisket");
    expect(msg.body).toContain("R$ 125,00");
    expect(msg.body).toContain("*Total: R$ 303,00*");
  });

  it("includes checkout and continue shopping buttons", () => {
    const msg = buildCartSummaryMessage({
      items: [{ title: "Item", quantity: 1, priceCentavos: 100 }],
      totalCentavos: 100,
    });

    expect(msg.buttons).toHaveLength(2);
    expect(msg.buttons[0].id).toBe("checkout");
    expect(msg.buttons[0].title).toBe("Finalizar Pedido");
    expect(msg.buttons[1].id).toBe("continue_shopping");
    expect(msg.buttons[1].title).toContain("Continuar Comprand");
  });

  it("handles empty cart", () => {
    const msg = buildCartSummaryMessage({ items: [], totalCentavos: 0 });

    expect(msg.body).toContain("*Total: R$ 0,00*");
    expect(msg.buttons).toHaveLength(2);
  });
});

// ── buildCheckoutConfirmation ─────────────────────────────────────────────────

describe("buildCheckoutConfirmation", () => {
  it("shows total and 3 payment method buttons", () => {
    const msg = buildCheckoutConfirmation(15000);

    expect(msg.type).toBe("buttons");
    expect(msg.body).toContain("R$ 150,00");
    expect(msg.body).toContain("Como deseja pagar?");
    expect(msg.buttons).toHaveLength(3);
    expect(msg.buttons.map((b) => b.id)).toEqual(["pay_pix", "pay_card", "pay_cash"]);
    expect(msg.buttons.map((b) => b.title)).toEqual(["PIX", "Cartão", "Dinheiro"]);
  });

  it("formats small amounts correctly", () => {
    const msg = buildCheckoutConfirmation(50);

    expect(msg.body).toContain("R$ 0,50");
  });
});

// ── buildReservationOptions ───────────────────────────────────────────────────

describe("buildReservationOptions", () => {
  it("builds a list of time slots", () => {
    const slots = [
      { id: "s1", time: "19:00", partySize: 4 },
      { id: "s2", time: "20:00", partySize: 4, location: "Área externa" },
    ];

    const msg = buildReservationOptions(slots);

    expect(msg.type).toBe("list");
    expect(msg.sections[0].rows).toHaveLength(2);
    expect(msg.sections[0].rows[0].id).toBe("slot_s1");
    expect(msg.sections[0].rows[0].title).toBe("19:00");
    expect(msg.sections[0].rows[0].description).toBe("Mesa para 4");
    expect(msg.sections[0].rows[1].description).toContain("Área externa");
  });

  it("limits slots to 8 rows", () => {
    const slots = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      time: `${18 + Math.floor(i / 2)}:${i % 2 === 0 ? "00" : "30"}`,
      partySize: 2,
    }));

    const msg = buildReservationOptions(slots);

    expect(msg.sections[0].rows).toHaveLength(8);
  });

  it("truncates long time strings to 24 chars", () => {
    const msg = buildReservationOptions([
      { id: "s1", time: "Sexta-feira, 15 de março de 2026, 19:00h", partySize: 2 },
    ]);

    expect(msg.sections[0].rows[0].title.length).toBeLessThanOrEqual(24);
  });

  it("handles empty slots array", () => {
    const msg = buildReservationOptions([]);

    expect(msg.sections[0].rows).toHaveLength(0);
    expect(msg.buttonText).toContain("Ver horários");
  });
});

// ── buildYesNoConfirmation ────────────────────────────────────────────────────

describe("buildYesNoConfirmation", () => {
  it("creates two buttons: Sim and Não", () => {
    const msg = buildYesNoConfirmation("Confirmar pedido?");

    expect(msg.type).toBe("buttons");
    expect(msg.body).toBe("Confirmar pedido?");
    expect(msg.buttons).toHaveLength(2);
    expect(msg.buttons[0]).toEqual({ id: "confirm_yes", title: "Sim" });
    expect(msg.buttons[1]).toEqual({ id: "confirm_no", title: "Não" });
  });

  it("passes through long question text as-is (no truncation on body)", () => {
    const longQ = "Você tem certeza que deseja cancelar a reserva para sexta-feira às 19h para 4 pessoas?";
    const msg = buildYesNoConfirmation(longQ);

    expect(msg.body).toBe(longQ);
  });
});
