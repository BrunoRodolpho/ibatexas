// BKL-078 — the QUESTION-SHAPE gate corpus. Three hard bars:
//   1. MUST-DEGRADE — genuine (non-smalltalk) info-questions, incl. tonight's two
//      live lies' shapes ("combo família serve quantas pessoas?", "vocês fazem
//      festa … com decoração?"). shouldDegradeToSafeUnknown === true.
//   2. MUST-STAY-PROSE statements (the BKL-005 corpus that PROVED naive promotion
//      unsafe) — marker-bearing STATEMENTS must NOT degrade. === false.
//   3. MUST-STAY-PROSE smalltalk (the BKL-110 0/15 hard bar) — phatic messages,
//      incl. '?'-bearing greetings, must NEVER degrade. isSmalltalkOnly wins.
//
// Plus the load-bearing INDEPENDENCE property: this module must not import the
// BKL-005-disproven claim-closure net from required-claim-decomposer.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hasInfoQuestion,
  isSmalltalkOnly,
  normalize,
  shouldDegradeToSafeUnknown,
} from "../interrogative-discriminator.js";

// ── 1. MUST-DEGRADE: non-smalltalk info-questions ─────────────────────────────
const MUST_DEGRADE: readonly string[] = [
  "o combo família serve quantas pessoas?", // live lie #1 shape
  "vocês fazem festa de aniversário com decoração?", // live lie #2 shape
  "ainda tem picanha hoje?",
  "qual a promoção de hoje?",
  "vocês têm sushi?",
  "aceitam vale-refeição?",
  "quanto tempo tá demorando um pedido agora?",
  "vocês fazem entrega?",
  "tem estacionamento?",
  "qual o valor da picanha?",
  "me diz o cardápio", // no '?' — the narrow info-imperative net (Q4)
  "quero saber se tem sobremesa", // no '?' — "quero … saber" (Q4)
  "are you open now?", // the D2 English honesty net
];

// ── 2. MUST-STAY-PROSE: BKL-005 marker-bearing STATEMENTS ─────────────────────
const MUST_STAY_PROSE_STATEMENTS: readonly string[] = [
  "meu pedido chegou, obrigado!",
  "vou pagar com pix",
  "pagode", // the \bpago\b word-boundary lesson
  "a luz apagou", // "apagou" must not trip a payment/question marker
  "já paguei",
  "adorei o atendimento", // "atendimento" must not trip \btem\b
  "cheguei em casa",
];

// ── 3. MUST-STAY-PROSE: the BKL-110 smalltalk 0/15 hard bar ────────────────────
const SMALLTALK_0_OF_15: readonly string[] = [
  "oi, tudo bem?",
  "e aí, beleza?",
  "tudo certo?",
  "como vai?",
  "boa noite!",
  "oi",
  "olá",
  "opa",
  "bom dia",
  "beleza?",
  "blz",
  "de boa",
  "obrigado!",
  "valeu",
  "tudo bem?",
];

describe("interrogative-discriminator — MUST-DEGRADE info-questions", () => {
  it.each(MUST_DEGRADE)("degrades %j to SAFE_UNKNOWN", (text) => {
    expect(hasInfoQuestion(text)).toBe(true);
    expect(isSmalltalkOnly(text)).toBe(false);
    expect(shouldDegradeToSafeUnknown(text)).toBe(true);
  });

  it("covers all 13 MUST-DEGRADE shapes (0 leaks to prose)", () => {
    const leaked = MUST_DEGRADE.filter((t) => !shouldDegradeToSafeUnknown(t));
    expect(leaked).toEqual([]);
  });
});

describe("interrogative-discriminator — MUST-STAY-PROSE (BKL-005 statements)", () => {
  it.each(MUST_STAY_PROSE_STATEMENTS)("keeps %j on the prose path", (text) => {
    expect(shouldDegradeToSafeUnknown(text)).toBe(false);
  });

  it("no BKL-005 statement is misclassified as a question-shape degrade", () => {
    const wrongly = MUST_STAY_PROSE_STATEMENTS.filter((t) =>
      shouldDegradeToSafeUnknown(t),
    );
    expect(wrongly).toEqual([]);
  });
});

describe("interrogative-discriminator — smalltalk 0/15 hard bar (BKL-110)", () => {
  it("has exactly 15 smalltalk cases (the 0/15 bar)", () => {
    expect(SMALLTALK_0_OF_15).toHaveLength(15);
  });

  it.each(SMALLTALK_0_OF_15)(
    "%j is smalltalk-only and NEVER degrades (even with '?')",
    (text) => {
      expect(isSmalltalkOnly(text)).toBe(true);
      expect(shouldDegradeToSafeUnknown(text)).toBe(false);
    },
  );

  it("0 of 15 smalltalk messages degrade", () => {
    const degraded = SMALLTALK_0_OF_15.filter((t) =>
      shouldDegradeToSafeUnknown(t),
    );
    expect(degraded).toEqual([]);
  });
});

describe("interrogative-discriminator — properties", () => {
  it("normalize strips diacritics + lowercases (ç → c, á → a)", () => {
    expect(normalize("Olá, VOCÊS têm açaí?")).toBe("ola, voces tem acai?");
  });

  it("word-boundary: 'pagode' / 'apagou' do not trip any marker", () => {
    expect(hasInfoQuestion("pagode")).toBe(false);
    expect(hasInfoQuestion("a luz apagou")).toBe(false);
    // 'atendimento' contains the letters of 'tem' but not as a word.
    expect(hasInfoQuestion("adorei o atendimento")).toBe(false);
  });

  it("is pure / order-stable (same input ⇒ same output across repeated calls)", () => {
    for (const t of [...MUST_DEGRADE, ...SMALLTALK_0_OF_15]) {
      expect(shouldDegradeToSafeUnknown(t)).toBe(shouldDegradeToSafeUnknown(t));
    }
  });

  it("INDEPENDENCE — never imports the BKL-005 claim-closure net", () => {
    const src = readFileSync(
      new URL("../interrogative-discriminator.ts", import.meta.url),
      "utf8",
    );
    // Assert on IMPORT statements only (the module's doc comment legitimately
    // NAMES the decomposer to explain why it must stay independent). No import may
    // reference the decomposer module, and classifyRequestSpans is never called.
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l))
      .join("\n");
    expect(importLines).not.toContain("required-claim-decomposer");
    expect(importLines).not.toContain("claim-registry");
    expect(src).not.toMatch(/classifyRequestSpans\s*\(/);
  });
});
