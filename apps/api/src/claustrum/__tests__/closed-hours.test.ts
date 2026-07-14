// fix B (Stage 1) — the deterministic closed-hours backstop + soft note.
//
// Contract: when the STRUCTURED signal says isClosed, a draft that falsely asserts
// the store is open OR confirms an immediate order is repaired to the canonical
// pt-BR closed-disclosure; when open, drafts pass unchanged; when closed and the
// draft already discloses closed/scheduled, it passes unchanged. The backstop
// reads the structured flag — never the prompt text.

import { describe, expect, it } from "vitest";
import type { DraftResponse } from "@claustrum/core";
import type { ScheduleSignal } from "@ibatexas/tools";
import {
  asksAboutStoreState,
  assertsClosedNow,
  assertsOpenOrImmediate,
  closedHoursBackstop,
  closedHoursDisclosure,
  closedHoursPromptNote,
  OPEN_HOURS_CORRECTION_PTBR,
} from "../closed-hours.js";

const CLOSED: ScheduleSignal = {
  isClosed: true,
  mealPeriod: "closed",
  nextOpenDay: "amanhã",
};
const OPEN: ScheduleSignal = { isClosed: false, mealPeriod: "lunch" };

const draft = (text: string): DraftResponse => ({ text });

describe("assertsOpenOrImmediate", () => {
  it("flags an affirmative open assertion", () => {
    expect(assertsOpenOrImmediate("Estamos abertos! Pode pedir.")).toBe(true);
    expect(assertsOpenOrImmediate("A loja está aberta agora.")).toBe(true);
    expect(assertsOpenOrImmediate("Estamos funcionando normalmente.")).toBe(true);
  });

  it("flags an immediate-order/delivery confirmation", () => {
    expect(assertsOpenOrImmediate("Seu pedido saiu para entrega.")).toBe(true);
    expect(assertsOpenOrImmediate("Vamos entregar agora mesmo.")).toBe(true);
    expect(assertsOpenOrImmediate("Seu pedido já está em preparo.")).toBe(true);
    expect(assertsOpenOrImmediate("Pode vir retirar agora.")).toBe(true);
    // M1: "sem taxa/custo/juros/fila" is a benefit phrase, NOT a negation — it
    // must not suppress an immediate-delivery affirmative.
    expect(
      assertsOpenOrImmediate("Fazemos a entrega sem taxa agora mesmo!"),
    ).toBe(true);
    expect(assertsOpenOrImmediate("Entregamos sem custo agora.")).toBe(true);
    // M2: the dominant pt-BR "em 30 minutos" (not just the "min" abbreviation).
    expect(assertsOpenOrImmediate("Sua entrega chega em 30 minutos.")).toBe(true);
  });

  it("does NOT flag a negated / closed statement (honest)", () => {
    expect(assertsOpenOrImmediate("Não estamos abertos agora.")).toBe(false);
    expect(
      assertsOpenOrImmediate("No momento estamos fechados, posso agendar."),
    ).toBe(false);
    expect(
      assertsOpenOrImmediate("Estamos fechados, sem entrega agora."),
    ).toBe(false);
    // M1 guard: a genuine `sem` negation (no "fechado" nearby) still suppresses —
    // "sem entrega" is a real absence, not a benefit phrase.
    expect(assertsOpenOrImmediate("Sem entrega agora.")).toBe(false);
    // F3: the negator sits INSIDE the matched 'loja … aberta' span (not just in
    // the 18-char prefix). It is an honest "the store is not open" statement.
    expect(assertsOpenOrImmediate("A loja não está aberta.")).toBe(false);
  });

  it("does NOT flag a neutral reply", () => {
    expect(assertsOpenOrImmediate("Posso anotar seu pedido para retirada agendada.")).toBe(false);
    expect(assertsOpenOrImmediate("")).toBe(false);
  });
});

describe("closedHoursBackstop", () => {
  it("repairs a false 'open' / immediate-order draft when closed", () => {
    const out = closedHoursBackstop(
      draft("Estamos abertos! Seu pedido saiu para entrega agora."),
      CLOSED,
    );
    expect(out.text).toBe(
      "No momento estamos fechados (reabrimos amanhã). Posso registrar seu pedido para retirada agendada.",
    );
  });

  it("preserves token usage when repairing", () => {
    const out = closedHoursBackstop(
      { text: "Estamos abertos!", usage: { inputTokens: 3, outputTokens: 5 } },
      CLOSED,
    );
    expect(out.text).toBe(closedHoursDisclosure(CLOSED));
    expect(out.usage).toEqual({ inputTokens: 3, outputTokens: 5 });
  });

  it("passes a draft unchanged when the store is OPEN", () => {
    const d = draft("Estamos abertos! Pode fazer seu pedido agora.");
    expect(closedHoursBackstop(d, OPEN)).toBe(d);
  });

  it("passes a draft unchanged when no signal is provided", () => {
    const d = draft("Estamos abertos!");
    expect(closedHoursBackstop(d, undefined)).toBe(d);
  });

  it("passes a draft that already discloses closed/scheduled (closed)", () => {
    const d = draft(
      "No momento estamos fechados, mas posso registrar seu pedido para retirada agendada.",
    );
    expect(closedHoursBackstop(d, CLOSED)).toBe(d);
  });

  it("still fires while closed for a benefit-phrase / pt-BR minutes draft (M1/M2)", () => {
    // M1: "sem taxa" is a benefit, not a negation — the backstop must NOT be
    // suppressed while closed.
    expect(
      closedHoursBackstop(
        draft("Fazemos a entrega sem taxa agora mesmo!"),
        CLOSED,
      ).text,
    ).toBe(closedHoursDisclosure(CLOSED));
    // M2: the dominant pt-BR "em 30 minutos" is caught (not just the "min" abbrev).
    expect(
      closedHoursBackstop(draft("Sua entrega chega em 30 minutos."), CLOSED)
        .text,
    ).toBe(closedHoursDisclosure(CLOSED));
  });

  it("passes a draft with an in-span negator unchanged when closed (F3)", () => {
    // "não" lives inside the matched 'loja … aberta' span — honored as honest,
    // so the backstop must NOT overwrite this reply while closed.
    const d = draft("A loja não está aberta.");
    expect(closedHoursBackstop(d, CLOSED)).toBe(d);
  });

  it("works with no nextOpenDay (closed, unknown reopen)", () => {
    const signal: ScheduleSignal = { isClosed: true, mealPeriod: "closed" };
    const out = closedHoursBackstop(draft("Estamos abertos!"), signal);
    expect(out.text).toBe(
      "No momento estamos fechados. Posso registrar seu pedido para retirada agendada.",
    );
  });
});

describe("closedHoursPromptNote", () => {
  it("is empty when the signal is absent (unknown state — keeps scripted prompts byte-identical)", () => {
    expect(closedHoursPromptNote(undefined)).toBe("");
  });

  it("grounds the OPEN state so the model does not guess/say closed (BKL-026)", () => {
    const note = closedHoursPromptNote(OPEN);
    expect(note).toContain("ABERTA");
    expect(note).toContain("almoço"); // OPEN.mealPeriod === "lunch"
    expect(note).not.toContain("FECHADA");
    // Must not invent a specific closing hour (the signal carries no close time).
    expect(note).toContain("Não invente");
  });

  it("instructs the model not to claim open and offers scheduled pickup when closed", () => {
    const note = closedHoursPromptNote(CLOSED);
    expect(note).toContain("FECHADA");
    expect(note).toContain("amanhã");
    expect(note).toContain("retirada agendada");
  });

  // ── Relevance gating (greeting-blurt fix + ① + ⑤) ──────────────────────────
  it("is EMPTY on a small-talk greeting, whether OPEN or CLOSED (no unsolicited blurt)", () => {
    for (const greeting of ["oi", "Bom dia", "Olá, tudo bem?", "boa noite"]) {
      expect(closedHoursPromptNote(OPEN, greeting)).toBe("");
      expect(closedHoursPromptNote(CLOSED, greeting)).toBe("");
    }
  });

  it("is EMPTY on the OPEN path when the customer did NOT ask about hours (①)", () => {
    expect(closedHoursPromptNote(OPEN, "adiciona uma costela ao meu pedido")).toBe("");
    expect(closedHoursPromptNote(OPEN, "quanto custa a picanha?")).toBe("");
  });

  it("EMITS the OPEN note only when the customer asks about open-state/hours", () => {
    for (const q of ["vocês estão abertos?", "que horas fecha?", "qual o horário de funcionamento?"]) {
      const note = closedHoursPromptNote(OPEN, q);
      expect(note).toContain("ABERTA");
    }
  });

  it("KEEPS the CLOSED safety note on a non-small-talk turn while closed (order/info)", () => {
    const note = closedHoursPromptNote(CLOSED, "quero uma picanha entregue agora");
    expect(note).toContain("FECHADA");
    expect(note).toContain("retirada agendada");
  });

  it("keeps scripted callers (no userText) byte-identical (backward-compat)", () => {
    expect(closedHoursPromptNote(OPEN)).toContain("ABERTA");
    expect(closedHoursPromptNote(CLOSED)).toContain("FECHADA");
  });
});

describe("asksAboutStoreState", () => {
  it("matches open-state / hours questions", () => {
    for (const q of ["vocês estão abertos?", "tá aberto agora?", "que horas fecha?", "qual o horário?", "vocês funcionam hoje?"]) {
      expect(asksAboutStoreState(q)).toBe(true);
    }
  });
  it("does NOT match ordering / unrelated turns (nor the checkout verb 'fechar')", () => {
    for (const s of ["adiciona uma costela", "quero fechar o pedido", "quanto custa a picanha?", "oi"]) {
      expect(asksAboutStoreState(s)).toBe(false);
    }
  });
});

// ── OPEN-mirror backstop (③): a false 'estamos fechados' while open is repaired ──
describe("assertsClosedNow", () => {
  it("flags a present-tense closed assertion", () => {
    expect(assertsClosedNow("No momento estamos fechados.")).toBe(true);
    expect(assertsClosedNow("A loja está fechada agora.")).toBe(true);
  });
  it("does NOT flag a negated form or a general day-of-week closure", () => {
    expect(assertsClosedNow("Não estamos fechados.")).toBe(false);
    expect(assertsClosedNow("Estamos abertos!")).toBe(false);
    expect(assertsClosedNow("Normalmente estamos fechados aos domingos.")).toBe(false);
  });
});

describe("closedHoursBackstop — OPEN mirror", () => {
  it("repairs a false 'estamos fechados' when the store is OPEN", () => {
    const out = closedHoursBackstop(draft("Infelizmente estamos fechados agora."), OPEN);
    expect(out.text).toBe(OPEN_HOURS_CORRECTION_PTBR);
  });
  it("preserves token usage when repairing the open mirror", () => {
    const out = closedHoursBackstop(
      { text: "No momento estamos fechados.", usage: { inputTokens: 2, outputTokens: 4 } },
      OPEN,
    );
    expect(out.text).toBe(OPEN_HOURS_CORRECTION_PTBR);
    expect(out.usage).toEqual({ inputTokens: 2, outputTokens: 4 });
  });
  it("leaves an OPEN-asserting or neutral draft untouched while open", () => {
    const d1 = draft("Estamos abertos! Pode pedir.");
    expect(closedHoursBackstop(d1, OPEN)).toBe(d1);
    const d2 = draft("Claro, posso te ajudar com o cardápio.");
    expect(closedHoursBackstop(d2, OPEN)).toBe(d2);
  });
  it("does NOT repair a general day-of-week closure while open", () => {
    const d = draft("Normalmente estamos fechados aos domingos, mas hoje pode pedir.");
    expect(closedHoursBackstop(d, OPEN)).toBe(d);
  });
});
