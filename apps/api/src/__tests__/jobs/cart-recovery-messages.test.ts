// Unit tests for buildCartRecoveryMessage — 3-tier personalized cart recovery messages.
// Pure function, no mocks needed.

import { describe, it, expect } from "vitest";
import { buildCartRecoveryMessage } from "../../jobs/cart-recovery-messages.js";

describe("buildCartRecoveryMessage", () => {
  // ── Tier 1 ────────────────────────────────────────────────────────────────

  describe("tier 1 — gentle nudge", () => {
    it("1 item, no customer name", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina"], undefined);
      expect(msg).toBe(`Oi! Seu Costela Bovina tá te esperando. Ficou alguma dúvida? Responda "meu carrinho" e eu ajudo 🛒`);
    });

    it("1 item, with customer name", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina"], "Ana");
      expect(msg).toBe(`Oi, Ana! Seu Costela Bovina tá te esperando. Ficou alguma dúvida? Responda "meu carrinho" e eu ajudo 🛒`);
    });

    it("2 items, no customer name (singular 'item')", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina", "Linguiça"], undefined);
      expect(msg).toBe(`Oi! Seu Costela Bovina e mais 1 item tá te esperando. Ficou alguma dúvida? Responda "meu carrinho" e eu ajudo 🛒`);
    });

    it("2 items, with customer name (singular 'item')", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina", "Linguiça"], "Carlos");
      expect(msg).toBe(`Oi, Carlos! Seu Costela Bovina e mais 1 item tá te esperando. Ficou alguma dúvida? Responda "meu carrinho" e eu ajudo 🛒`);
    });

    it("3 items, no customer name (plural 'itens')", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina", "Linguiça", "Fraldinha"], undefined);
      expect(msg).toBe(`Oi! Seu Costela Bovina e mais 2 itens tá te esperando. Ficou alguma dúvida? Responda "meu carrinho" e eu ajudo 🛒`);
    });

    it("3+ items, with customer name (plural 'itens')", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina", "Linguiça", "Fraldinha", "Picanha"], "Maria");
      expect(msg).toBe(`Oi, Maria! Seu Costela Bovina e mais 3 itens tá te esperando. Ficou alguma dúvida? Responda "meu carrinho" e eu ajudo 🛒`);
    });

    it("empty itemNames fallback — uses 'seus itens'", () => {
      const msg = buildCartRecoveryMessage(1, [], undefined);
      expect(msg).toBe(`Oi! Seu seus itens tá te esperando. Ficou alguma dúvida? Responda "meu carrinho" e eu ajudo 🛒`);
    });

    it("empty itemNames with customer name", () => {
      const msg = buildCartRecoveryMessage(1, [], "Pedro");
      expect(msg).toBe(`Oi, Pedro! Seu seus itens tá te esperando. Ficou alguma dúvida? Responda "meu carrinho" e eu ajudo 🛒`);
    });
  });

  // ── Tier 2 ────────────────────────────────────────────────────────────────

  describe("tier 2 — incentive (discount code)", () => {
    it("no customer name", () => {
      const msg = buildCartRecoveryMessage(2, ["Costela Bovina"], undefined);
      expect(msg).toBe(`Seu Costela Bovina vai ficar incrível — horas de fogo lento! Use VOLTA10 pra 10% off e garanta hoje. Responda "meu carrinho" 🎁`);
    });

    it("with customer name", () => {
      const msg = buildCartRecoveryMessage(2, ["Costela Bovina"], "Ana");
      expect(msg).toBe(`Ana, Seu Costela Bovina vai ficar incrível — horas de fogo lento! Use VOLTA10 pra 10% off e garanta hoje. Responda "meu carrinho" 🎁`);
    });

    it("multiple items (message stays the same regardless of item count)", () => {
      const msg = buildCartRecoveryMessage(2, ["Costela Bovina", "Linguiça", "Fraldinha"], "Carlos");
      expect(msg).toBe(`Carlos, Seu Costela Bovina vai ficar incrível — horas de fogo lento! Use VOLTA10 pra 10% off e garanta hoje. Responda "meu carrinho" 🎁`);
    });

    it("empty itemNames — message unchanged (tier 2 doesn't mention items)", () => {
      const msg = buildCartRecoveryMessage(2, [], undefined);
      expect(msg).toBe(`Seu seus defumados vai ficar incrível — horas de fogo lento! Use VOLTA10 pra 10% off e garanta hoje. Responda "meu carrinho" 🎁`);
    });
  });

  // ── Tier 3 ────────────────────────────────────────────────────────────────

  describe("tier 3 — scarcity/urgency", () => {
    it("1 item, no customer name", () => {
      const msg = buildCartRecoveryMessage(3, ["Picanha"], undefined);
      expect(msg).toBe(`Última chance — seu carrinho com Picanha expira em breve. Ainda dá tempo! Responda "meu carrinho" 🔥`);
    });

    it("1 item, with customer name", () => {
      const msg = buildCartRecoveryMessage(3, ["Picanha"], "Maria");
      expect(msg).toBe(`Maria, Última chance — seu carrinho com Picanha expira em breve. Ainda dá tempo! Responda "meu carrinho" 🔥`);
    });

    it("2 items — uses first item name only", () => {
      const msg = buildCartRecoveryMessage(3, ["Picanha", "Costela Bovina"], undefined);
      expect(msg).toBe(`Última chance — seu carrinho com Picanha expira em breve. Ainda dá tempo! Responda "meu carrinho" 🔥`);
    });

    it("3+ items — uses first item name only", () => {
      const msg = buildCartRecoveryMessage(3, ["Picanha", "Costela Bovina", "Fraldinha"], "João");
      expect(msg).toBe(`João, Última chance — seu carrinho com Picanha expira em breve. Ainda dá tempo! Responda "meu carrinho" 🔥`);
    });

    it("empty itemNames fallback — uses 'seu pedido'", () => {
      const msg = buildCartRecoveryMessage(3, [], undefined);
      expect(msg).toBe(`Última chance — seu carrinho com seu pedido expira em breve. Ainda dá tempo! Responda "meu carrinho" 🔥`);
    });

    it("empty itemNames with customer name", () => {
      const msg = buildCartRecoveryMessage(3, [], "Ana");
      expect(msg).toBe(`Ana, Última chance — seu carrinho com seu pedido expira em breve. Ainda dá tempo! Responda "meu carrinho" 🔥`);
    });
  });

  // ── Singular vs plural ────────────────────────────────────────────────────

  describe("singular vs plural 'item/itens'", () => {
    it("exactly 2 items → singular 'item'", () => {
      const msg = buildCartRecoveryMessage(1, ["A", "B"], undefined);
      expect(msg).toContain("e mais 1 item");
      expect(msg).not.toContain("itens");
    });

    it("exactly 3 items → plural 'itens'", () => {
      const msg = buildCartRecoveryMessage(1, ["A", "B", "C"], undefined);
      expect(msg).toContain("e mais 2 itens");
    });

    it("5 items → plural 'itens'", () => {
      const msg = buildCartRecoveryMessage(1, ["A", "B", "C", "D", "E"], undefined);
      expect(msg).toContain("e mais 4 itens");
    });
  });
});
