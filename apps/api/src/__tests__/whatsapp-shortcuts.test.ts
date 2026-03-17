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

  // ── Cart shortcuts ────────────────────────────────────────────────────────

  describe("cart shortcuts", () => {
    it.each(["carrinho", "ver carrinho", "meu carrinho", "pedido", "meu pedido"])(
      "matches '%s' as cart",
      (input) => {
        expect(matchShortcut(input)).toEqual({ type: "cart" });
      },
    );

    it("matches 'CARRINHO' case-insensitive", () => {
      expect(matchShortcut("CARRINHO")).toEqual({ type: "cart" });
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
    it.each(["ajuda", "help", "opcoes", "comandos"])(
      "matches '%s' as help",
      (input) => {
        expect(matchShortcut(input)).toEqual({ type: "help" });
      },
    );

    it("matches 'opções' with accent", () => {
      expect(matchShortcut("opções")).toEqual({ type: "help" });
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
    expect(text).toContain("ver nosso cardápio");
  });

  it("is non-empty multi-line string", () => {
    const text = buildHelpText();

    expect(text.length).toBeGreaterThan(0);
    expect(text.split("\n").length).toBeGreaterThan(3);
  });
});
