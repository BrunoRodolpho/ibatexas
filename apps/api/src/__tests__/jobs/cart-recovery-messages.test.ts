// Unit tests for buildCartRecoveryMessage — 3-tier personalized cart recovery messages.
// Pure function, no mocks needed.

import { describe, it, expect } from "vitest";
import { buildCartRecoveryMessage } from "../../jobs/cart-recovery-messages.js";

describe("buildCartRecoveryMessage", () => {
  // ── Tier 1 ────────────────────────────────────────────────────────────────

  describe("tier 1 — gentle nudge", () => {
    it("1 item, no customer name", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina"], undefined);
      expect(msg).toBe(`Oi! Parece que Costela Bovina ficou no seu carrinho. Quer finalizar? Responda "meu carrinho" 🛒`);
    });

    it("1 item, with customer name", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina"], "Ana");
      expect(msg).toBe(`Oi, Ana! Parece que Costela Bovina ficou no seu carrinho. Quer finalizar? Responda "meu carrinho" 🛒`);
    });

    it("2 items, no customer name (singular 'item')", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina", "Linguiça"], undefined);
      expect(msg).toBe(`Oi! Parece que Costela Bovina e mais 1 item ficou no seu carrinho. Quer finalizar? Responda "meu carrinho" 🛒`);
    });

    it("2 items, with customer name (singular 'item')", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina", "Linguiça"], "Carlos");
      expect(msg).toBe(`Oi, Carlos! Parece que Costela Bovina e mais 1 item ficou no seu carrinho. Quer finalizar? Responda "meu carrinho" 🛒`);
    });

    it("3 items, no customer name (plural 'itens')", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina", "Linguiça", "Fraldinha"], undefined);
      expect(msg).toBe(`Oi! Parece que Costela Bovina e mais 2 itens ficou no seu carrinho. Quer finalizar? Responda "meu carrinho" 🛒`);
    });

    it("3+ items, with customer name (plural 'itens')", () => {
      const msg = buildCartRecoveryMessage(1, ["Costela Bovina", "Linguiça", "Fraldinha", "Picanha"], "Maria");
      expect(msg).toBe(`Oi, Maria! Parece que Costela Bovina e mais 3 itens ficou no seu carrinho. Quer finalizar? Responda "meu carrinho" 🛒`);
    });

    it("empty itemNames fallback — uses 'seus itens'", () => {
      const msg = buildCartRecoveryMessage(1, [], undefined);
      expect(msg).toBe(`Oi! Parece que seus itens ficou no seu carrinho. Quer finalizar? Responda "meu carrinho" 🛒`);
    });

    it("empty itemNames with customer name", () => {
      const msg = buildCartRecoveryMessage(1, [], "Pedro");
      expect(msg).toBe(`Oi, Pedro! Parece que seus itens ficou no seu carrinho. Quer finalizar? Responda "meu carrinho" 🛒`);
    });
  });

  // ── Tier 2 ────────────────────────────────────────────────────────────────

  describe("tier 2 — incentive (discount code)", () => {
    it("no customer name", () => {
      const msg = buildCartRecoveryMessage(2, ["Costela Bovina"], undefined);
      expect(msg).toBe(`Ainda pensando? Use o codigo VOLTA10 pra 10% off no seu pedido! Responda "meu carrinho" 🎁`);
    });

    it("with customer name", () => {
      const msg = buildCartRecoveryMessage(2, ["Costela Bovina"], "Ana");
      expect(msg).toBe(`Ainda pensando, Ana? Use o codigo VOLTA10 pra 10% off no seu pedido! Responda "meu carrinho" 🎁`);
    });

    it("multiple items (message stays the same regardless of item count)", () => {
      const msg = buildCartRecoveryMessage(2, ["Costela Bovina", "Linguiça", "Fraldinha"], "Carlos");
      expect(msg).toBe(`Ainda pensando, Carlos? Use o codigo VOLTA10 pra 10% off no seu pedido! Responda "meu carrinho" 🎁`);
    });

    it("empty itemNames — message unchanged (tier 2 doesn't mention items)", () => {
      const msg = buildCartRecoveryMessage(2, [], undefined);
      expect(msg).toBe(`Ainda pensando? Use o codigo VOLTA10 pra 10% off no seu pedido! Responda "meu carrinho" 🎁`);
    });
  });

  // ── Tier 3 ────────────────────────────────────────────────────────────────

  describe("tier 3 — scarcity/urgency", () => {
    it("1 item, no customer name", () => {
      const msg = buildCartRecoveryMessage(3, ["Picanha"], undefined);
      expect(msg).toBe(`Ultimas chances de garantir Picanha! Seu carrinho expira em breve. Responda "meu carrinho" 🔥`);
    });

    it("1 item, with customer name", () => {
      const msg = buildCartRecoveryMessage(3, ["Picanha"], "Maria");
      expect(msg).toBe(`Maria, Ultimas chances de garantir Picanha! Seu carrinho expira em breve. Responda "meu carrinho" 🔥`);
    });

    it("2 items — uses first item name only", () => {
      const msg = buildCartRecoveryMessage(3, ["Picanha", "Costela Bovina"], undefined);
      expect(msg).toBe(`Ultimas chances de garantir Picanha! Seu carrinho expira em breve. Responda "meu carrinho" 🔥`);
    });

    it("3+ items — uses first item name only", () => {
      const msg = buildCartRecoveryMessage(3, ["Picanha", "Costela Bovina", "Fraldinha"], "João");
      expect(msg).toBe(`João, Ultimas chances de garantir Picanha! Seu carrinho expira em breve. Responda "meu carrinho" 🔥`);
    });

    it("empty itemNames fallback — uses 'seu pedido'", () => {
      const msg = buildCartRecoveryMessage(3, [], undefined);
      expect(msg).toBe(`Ultimas chances de garantir seu pedido! Seu carrinho expira em breve. Responda "meu carrinho" 🔥`);
    });

    it("empty itemNames with customer name", () => {
      const msg = buildCartRecoveryMessage(3, [], "Ana");
      expect(msg).toBe(`Ana, Ultimas chances de garantir seu pedido! Seu carrinho expira em breve. Responda "meu carrinho" 🔥`);
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
