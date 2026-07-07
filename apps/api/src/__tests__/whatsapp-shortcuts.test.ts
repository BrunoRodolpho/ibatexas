// Unit tests for whatsapp/shortcuts.ts — pure functions, no mocks needed.

import { describe, it, expect } from "vitest";
import { matchShortcut, buildHelpText } from "../whatsapp/shortcuts.js";

// ── matchShortcut ─────────────────────────────────────────────────────────────

describe("matchShortcut", () => {
  // ── Menu shortcuts ────────────────────────────────────────────────────────

  describe("menu shortcuts", () => {
    it.each(["menu", "cardapio", "ver cardapio", "ver menu", "produtos"])(
      "matches '%s' as menu",
      (input) => {
        expect(matchShortcut(input)).toEqual({ type: "menu" });
      },
    );

    it("matches 'cardápio' with accent (normalized away)", () => {
      expect(matchShortcut("cardápio")).toEqual({ type: "menu" });
    });

    it("matches 'MENU' case-insensitive", () => {
      expect(matchShortcut("MENU")).toEqual({ type: "menu" });
    });

    it("matches 'Ver Cardápio' mixed case with accent", () => {
      expect(matchShortcut("Ver Cardápio")).toEqual({ type: "menu" });
    });

    it("matches with leading/trailing whitespace", () => {
      expect(matchShortcut("  menu  ")).toEqual({ type: "menu" });
    });
  });

  // ── Opt-out / opt-in shortcuts (WS3A) ─────────────────────────────────────

  describe("marketing opt-out / opt-in shortcuts", () => {
    it.each(["parar", "stop", "sair", "descadastrar", "cancelar inscricao", "PARAR"])(
      "matches '%s' as optout",
      (input) => {
        expect(matchShortcut(input)).toEqual({ type: "optout" });
      },
    );

    it.each(["voltar", "quero receber", "receber promocoes"])(
      "matches '%s' as optin",
      (input) => {
        expect(matchShortcut(input)).toEqual({ type: "optin" });
      },
    );

    it("does NOT treat a bare 'cancelar' as opt-out (order-cancel ambiguity)", () => {
      // 'cancelar' must fall through to the agent, never silently opt the customer out.
      expect(matchShortcut("cancelar")).toBeNull();
    });

    it("only matches whole-message STOP words, not mid-sentence", () => {
      expect(matchShortcut("quero parar meu pedido")).toBeNull();
    });

    // S3 — trailing/leading punctuation must not defeat an opt-out. `Parar.` is a
    // completely ordinary way to type it and previously fell through, leaving the
    // customer subscribed with no durable consent recorded (LGPD).
    it.each(["Parar.", "parar!", "STOP.", "  parar  ", "sair.", "descadastrar!"])(
      "matches punctuated/padded '%s' as optout",
      (input) => {
        expect(matchShortcut(input)).toEqual({ type: "optout" });
      },
    );

    it.each([
      "quero parar",
      "parar por favor",
      "nao quero mais receber",
      "remover meu numero",
      "pare",
    ])("matches common opt-out phrasing '%s'", (input) => {
      expect(matchShortcut(input)).toEqual({ type: "optout" });
    });

    it("still does NOT treat 'nao quero parar' as opt-out (whole-message exact only)", () => {
      // Punctuation stripping must not turn a negated phrase into a false opt-out.
      expect(matchShortcut("nao quero parar")).toBeNull();
    });

    it("preserves the '$' symbol so the r$15 welcome key still matches", () => {
      // Punctuation stripping targets \p{P} only — currency symbols survive.
      expect(matchShortcut("r$15")).toEqual({ type: "welcome" });
      expect(matchShortcut("r$15.")).toEqual({ type: "welcome" });
    });
  });

  // ── Cart shortcuts ────────────────────────────────────────────────────────

  describe("cart shortcuts", () => {
    it.each(["carrinho", "ver carrinho", "meu carrinho"])(
      "matches '%s' as cart",
      (input) => {
        expect(matchShortcut(input)).toEqual({ type: "cart" });
      },
    );

    it("matches 'CARRINHO' case-insensitive", () => {
      expect(matchShortcut("CARRINHO")).toEqual({ type: "cart" });
    });

    it("returns null for 'pedido' — falls through to LLM for order status routing", () => {
      expect(matchShortcut("pedido")).toBeNull();
    });

    it("returns null for 'meu pedido' — falls through to LLM for order status routing", () => {
      expect(matchShortcut("meu pedido")).toBeNull();
    });
  });

  // ── Reservation shortcuts ─────────────────────────────────────────────────

  describe("reservation shortcuts", () => {
    it.each(["reserva", "reservar", "fazer reserva"])(
      "matches '%s' as reservation",
      (input) => {
        expect(matchShortcut(input)).toEqual({ type: "reservation" });
      },
    );

    it("matches 'RESERVAR' case-insensitive", () => {
      expect(matchShortcut("RESERVAR")).toEqual({ type: "reservation" });
    });
  });

  // ── Help shortcuts ────────────────────────────────────────────────────────

  describe("help shortcuts", () => {
    it.each(["ajuda", "help", "comandos"])(
      "matches '%s' as help",
      (input) => {
        expect(matchShortcut(input)).toEqual({ type: "help" });
      },
    );

    it("matches 'opcoes' as menu (not help)", () => {
      expect(matchShortcut("opcoes")).toEqual({ type: "menu" });
    });

    it("matches 'opções' with accent (normalizes to 'opcoes', maps to menu)", () => {
      expect(matchShortcut("opções")).toEqual({ type: "menu" });
    });

    it("matches 'AJUDA' case-insensitive", () => {
      expect(matchShortcut("AJUDA")).toEqual({ type: "help" });
    });
  });

  // ── No match (fallthrough to LLM) ────────────────────────────────────────

  describe("no match — returns null", () => {
    it("returns null for free-text questions", () => {
      expect(matchShortcut("Quanto custa a costela?")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(matchShortcut("")).toBeNull();
    });

    it("returns null for whitespace-only input", () => {
      expect(matchShortcut("   ")).toBeNull();
    });

    it("returns null for partial keyword match", () => {
      expect(matchShortcut("menu completo")).toBeNull();
    });

    it("returns null for unknown command", () => {
      expect(matchShortcut("status")).toBeNull();
    });

    it("returns null for numeric input", () => {
      expect(matchShortcut("123")).toBeNull();
    });
  });
});

// ── buildHelpText ─────────────────────────────────────────────────────────────

describe("buildHelpText", () => {
  it("returns a string with all command keywords", () => {
    const text = buildHelpText();

    expect(text).toContain("*menu*");
    expect(text).toContain("*cardápio*");
    expect(text).toContain("*carrinho*");
    expect(text).toContain("*reserva*");
    expect(text).toContain("*ajuda*");
  });

  it("is in pt-BR", () => {
    const text = buildHelpText();

    expect(text).toContain("Olá!");
    expect(text).toContain("cardápio");
    expect(text).toContain("nosso cardápio");
  });

  it("is non-empty multi-line string", () => {
    const text = buildHelpText();

    expect(text.length).toBeGreaterThan(0);
    expect(text.split("\n").length).toBeGreaterThan(3);
  });
});
