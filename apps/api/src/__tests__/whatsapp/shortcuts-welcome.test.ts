// Unit tests for welcome shortcut group in whatsapp/shortcuts.ts

import { describe, it, expect } from "vitest";
import { matchShortcut, buildWelcomeText } from "../../whatsapp/shortcuts.js";

describe("welcome shortcuts", () => {
  it.each(["credito", "desconto", "primeira vez", "quero meu credito", "r$15"])(
    "matches '%s' as welcome",
    (input) => {
      expect(matchShortcut(input)).toEqual({ type: "welcome" });
    },
  );

  it("matches 'crédito' with accent (normalized away)", () => {
    expect(matchShortcut("crédito")).toEqual({ type: "welcome" });
  });

  it("matches 'CREDITO' case-insensitive", () => {
    expect(matchShortcut("CREDITO")).toEqual({ type: "welcome" });
  });

  it("matches 'Primeira Vez' mixed case", () => {
    expect(matchShortcut("Primeira Vez")).toEqual({ type: "welcome" });
  });

  it("returns null for partial match (e.g. 'meu credito antigo')", () => {
    expect(matchShortcut("meu credito antigo")).toBeNull();
  });
});

describe("buildWelcomeText", () => {
  it("mentions R$15 credit", () => {
    expect(buildWelcomeText()).toContain("R$15");
  });

  it("mentions taste preference options", () => {
    const text = buildWelcomeText();
    expect(text).toContain("mal-passada");
    expect(text).toContain("ao ponto");
    expect(text).toContain("bem-passada");
  });

  it("is pt-BR and mentions IbateXas", () => {
    expect(buildWelcomeText()).toContain("IbateXas");
  });
});
