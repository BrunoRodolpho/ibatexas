// Deterministic closed-hours grounding + backstop (Plan 1 "fix B", Stage 1).
//
// The dev model is a 4B (Nemotron) that will NOT reliably obey a soft "the store
// is closed" prompt, so closed-hours correctness needs a DETERMINISTIC backstop —
// not just prompt text. This module is the single home for BOTH layers, sharing
// one structured signal so they can never disagree:
//
//   - closedHoursPromptNote()  — the SOFT layer: a pt-BR instruction injected into
//     the planner + responder LLM context telling the model the store is closed
//     (and when it reopens). Empty string when open, so prompts stay byte-identical
//     to today on the open path.
//   - closedHoursBackstop()    — the HARD layer: a post-completion repair that, when
//     the STRUCTURED signal says isClosed, overrides any draft that falsely asserts
//     the store is open or confirms an immediate order with the canonical
//     closed-disclosure. It reads the structured `isClosed` flag, NEVER the prompt
//     text, and is conservative (only triggers while closed).
//
// Decided policy (binding): closed-hours ACCEPTS scheduled-pickup orders, REFUSES
// immediate delivery, and the bot must NEVER say "estamos abertos" while closed.
// All customer-facing strings are pt-BR (CLAUDE.md Hard Rule #4).

import type { DraftResponse } from "@claustrum/core";
import type { ScheduleSignal } from "@ibatexas/tools";

export type { ScheduleSignal };

/** Strip diacritics + lowercase so the lexicon matches accented model output. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * The canonical customer-facing closed-hours disclosure (pt-BR). Offers scheduled
 * pickup — the decided policy — and never asserts the store is open. Reused by the
 * deterministic backstop as the repair text.
 */
export function closedHoursDisclosure(
  signal: Pick<ScheduleSignal, "nextOpenDay">,
): string {
  const reopen = signal.nextOpenDay ? ` (reabrimos ${signal.nextOpenDay})` : "";
  return `No momento estamos fechados${reopen}. Posso registrar seu pedido para retirada agendada.`;
}

/**
 * The SOFT layer: a pt-BR instruction appended to the planner + responder LLM
 * context when the store is closed. Returns "" when open (so the composed prompt
 * is byte-identical to today on the open path).
 */
export function closedHoursPromptNote(
  signal: ScheduleSignal | undefined,
): string {
  if (signal === undefined || !signal.isClosed) return "";
  const reopen = signal.nextOpenDay ? ` Reabrimos ${signal.nextOpenDay}.` : "";
  return (
    `\n\nESTADO DA LOJA (fonte da verdade, não invente): a loja está FECHADA agora.${reopen} ` +
    `NÃO diga que estamos abertos nem confirme entrega/retirada imediata. ` +
    `Você só pode registrar pedidos para retirada agendada.`
  );
}

// Affirmative "the store is open right now" assertions — the core falsehood the
// backstop repairs. All /g so a negated earlier occurrence does not mask a later
// affirmative one.
const FALSE_OPEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\bestamos abert\w*/g,
  /\bestamos (?:funcionando|atendendo|em funcionamento)\b/g,
  /\b(?:loja|restaurante|cozinha|estabelecimento)\b[^.!?]{0,12}\b(?:abert\w*|funcionando)\b/g,
  /\babert\w*\b[^.!?]{0,6}\b(?:agora|no momento|neste momento|hoje)\b/g,
];

// Affirmative "your immediate order/delivery is happening now" confirmations.
const FALSE_IMMEDIATE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bentreg\w*\b[^.!?]{0,18}\b(?:agora|imediat\w*|ja ja|em \d+\s*min(?:uto)?s?|hoje)\b/g,
  /\b(?:sai|saiu|saira|sairao)\b[^.!?]{0,6}\b(?:para|pra)\b[^.!?]{0,4}\bentrega\b/g,
  /\ba caminho\b/g,
  /\bem preparo\b/g,
  /\b(?:pode|podem|podemos)\b[^.!?]{0,12}\b(?:retirar|buscar)\b[^.!?]{0,6}\bagora\b/g,
];

// Negation / closed markers that flip an apparent open-assertion into an HONEST
// closed statement ("nao estamos abertos", "fechado, sem entrega agora") — when
// one of these sits just before the match, the clause is NOT a falsehood.
// `sem` still negates a genuine absence ("sem entrega agora"), but must NOT cancel
// the backstop when it heads a benefit phrase ("sem taxa/custo/juros/fila"), which
// is an immediate-delivery affirmative, not a negation.
const CLOSED_NEGATORS =
  /\b(?:nao|nunca|jamais|sem(?!\s+(?:tax|custo|juro|fila)\w*)|fechad\w*|fora do horario)\b/;

/** True when an affirmative (non-negated) match of any pattern exists. */
function matchesAffirmative(
  normalized: string,
  patterns: ReadonlyArray<RegExp>,
): boolean {
  for (const re of patterns) {
    for (const m of normalized.matchAll(re)) {
      const idx = m.index ?? 0;
      const before = normalized.slice(Math.max(0, idx - 18), idx);
      // Honor a negator sitting just BEFORE the match AND one embedded INSIDE the
      // matched span — e.g. "a loja nao esta aberta", where the "nao" lives between
      // "loja" and "aberta" inside m[0] and the 18-char prefix alone would miss it.
      // Test the prefix PLUS the matched text so such honest closed statements pass.
      if (!CLOSED_NEGATORS.test(before + m[0])) return true;
    }
  }
  return false;
}

/**
 * Whether a draft (declaratively, non-negated) asserts the store is open right now
 * or confirms an immediate order/delivery — the two falsehoods forbidden while
 * closed. Conservative: questions, negated forms, and any closed/scheduled framing
 * pass through.
 */
export function assertsOpenOrImmediate(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const normalized = normalize(text);
  return (
    matchesAffirmative(normalized, FALSE_OPEN_PATTERNS) ||
    matchesAffirmative(normalized, FALSE_IMMEDIATE_PATTERNS)
  );
}

/**
 * The deterministic backstop. When the structured signal says the store is closed
 * AND the draft falsely asserts open / confirms an immediate order, REPAIR the text
 * to the canonical closed-disclosure (preserving token usage for cost accounting).
 * No-op when open or when the draft already discloses closed/scheduled correctly.
 * Reads the structured `isClosed` flag — never parses the prompt text.
 */
export function closedHoursBackstop(
  draft: DraftResponse,
  signal: ScheduleSignal | undefined,
): DraftResponse {
  if (signal === undefined || !signal.isClosed) return draft;
  if (!assertsOpenOrImmediate(draft.text)) return draft;
  const text = closedHoursDisclosure(signal);
  return draft.usage === undefined ? { text } : { text, usage: draft.usage };
}
