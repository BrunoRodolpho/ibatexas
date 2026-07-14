// Deterministic closed-hours grounding + backstop (Plan 1 "fix B", Stage 1).
//
// The dev model is a 4B (Nemotron) that will NOT reliably obey a soft "the store
// is closed" prompt, so closed-hours correctness needs a DETERMINISTIC backstop —
// not just prompt text. This module is the single home for BOTH layers, sharing
// one structured signal so they can never disagree:
//
//   - closedHoursPromptNote()  — the SOFT layer: a pt-BR store-state instruction
//     injected into the planner + responder LLM context. GATED on turn relevance
//     (BKL-026 store-hours slice + the greeting-blurt fix): it returns "" on a
//     phatic small-talk turn (a bare "oi" must never draw a store-status blurt), and
//     on the OPEN path it is emitted ONLY when the customer actually asks about the
//     store's open-state/hours (the weak 4B otherwise over-weights an always-on
//     "the store is open" note and volunteers it on unrelated turns). The CLOSED
//     safety note is kept on every non-small-talk turn (an order turn while closed
//     MUST carry it). A caller that passes no `userText` (scripted/golden-fixture
//     path) skips the gates → byte-identical to the pre-gate note.
//   - closedHoursBackstop()    — the HARD layer: a post-completion repair that reads
//     the STRUCTURED signal (never the prompt text). It is TWO-SIDED: while CLOSED it
//     overrides any draft that falsely asserts the store is open or confirms an
//     immediate order; while OPEN it overrides any draft that falsely asserts the
//     store is closed right now. Conservative on both sides (negated / general
//     future-closure phrasings pass through).
//
// Decided policy (binding): closed-hours ACCEPTS scheduled-pickup orders, REFUSES
// immediate delivery, and the bot must NEVER say "estamos abertos" while closed.
// All customer-facing strings are pt-BR (CLAUDE.md Hard Rule #4).

import type { DraftResponse } from "@claustrum/core";
import type { ScheduleSignal } from "@ibatexas/tools";
import { isSmalltalkOnly } from "./interrogative-discriminator.js";

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
 * Confirmation for an ACCEPTED scheduled-pickup order placed while closed (F6).
 * The generic `closedHoursDisclosure` is an OFFER ("Posso registrar…") — wrong for
 * a customer whose order DID go through. This acknowledges the accepted order instead.
 * Reserved for the caller that has PROVEN a scheduled-pickup checkout was accepted
 * this turn (never used for delivery/immediate orders). `awaitingPixPayment` reflects
 * the QR-first-then-confirm PIX flow: the checkout EXECUTEd + generated the QR, but
 * payment is still pending (the QR is delivered on the side-channel).
 */
export function closedHoursScheduledConfirmation(
  signal: Pick<ScheduleSignal, "nextOpenDay">,
  awaitingPixPayment = false,
): string {
  const reopen = signal.nextOpenDay ? ` (retirada a partir de ${signal.nextOpenDay})` : "";
  const base = `Seu pedido foi registrado para retirada agendada${reopen}.`;
  return awaitingPixPayment
    ? `${base} Falta só concluir o pagamento via PIX para confirmar.`
    : base;
}

// Store open-state / operating-hours question markers. Diacritic-insensitive,
// word-boundaried. Deliberately NARROW (a miss just omits a soft grounding note —
// the STORE_OPEN_NOW claim path still answers hours questions when the claims
// pipeline is on); the adjective forms `abert[oa]s?`/`fechad[oa]s?` intentionally do
// NOT match the checkout verb "fechar"/"fecha" ("fechar o pedido").
const STORE_STATE_QUESTION =
  /\babert[oa]s?\b|\bfechad[oa]s?\b|\bhorario\b|\bfuncionament\w*|\bexpediente\b|\bfunciona(?:m|ndo)?\b|\breabr\w*|\bque horas\b/;

/**
 * TRUE iff the customer's message asks about the store's open-state or operating
 * hours ("estão abertos?", "que horas fecha?", "qual o horário de funcionamento?").
 * Used to GATE the OPEN grounding note so it is injected only when relevant. Pure,
 * diacritic-insensitive.
 */
export function asksAboutStoreState(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return STORE_STATE_QUESTION.test(normalize(text));
}

/**
 * The SOFT layer: a pt-BR store-state instruction appended to the planner +
 * responder LLM context (BKL-026 grounding, store-hours slice), GATED on turn
 * relevance so the weak 4B does not over-weight an always-on note and blurt store
 * status on unrelated turns.
 *
 * - `undefined` signal (state unknown, e.g. the scripted golden-fixture path) → "".
 * - small-talk-only `userText` (a bare greeting) → "" on BOTH states: never volunteer
 *   store status on a phatic turn. Closed-path safety is still enforced by the
 *   deterministic `closedHoursBackstop`, which reads the structured signal, not this
 *   note.
 * - OPEN → the positive grounding note ONLY when the customer asks about open-state/
 *   hours (`asksAboutStoreState`); otherwise "" (the note is not safety-critical — the
 *   backstop only guards the closed path).
 * - CLOSED → the closed safety instruction on every non-small-talk turn (an order/info
 *   turn while closed MUST carry it; never say open; scheduled pickup only).
 *
 * When `userText` is omitted the gates are skipped, so the note is byte-identical to
 * the pre-gate behavior for scripted callers.
 */
export function closedHoursPromptNote(
  signal: ScheduleSignal | undefined,
  userText?: string,
): string {
  if (signal === undefined) return "";
  // Never volunteer store state on a phatic greeting/small-talk turn — the weak 4B
  // over-weights an always-on "fonte da verdade" note and blurts open/closed status
  // even when the customer only said "oi" (the greeting-blurt regression).
  if (userText !== undefined && isSmalltalkOnly(userText)) return "";
  if (!signal.isClosed) {
    // The OPEN note is NOT safety-critical (the backstop only guards the closed
    // path). Inject it ONLY when the customer actually asks about open-state/hours,
    // else it leaks onto unrelated turns. Absent `userText` → gate skipped.
    if (userText !== undefined && !asksAboutStoreState(userText)) return "";
    const period =
      signal.mealPeriod === "lunch"
        ? " (período de almoço)"
        : signal.mealPeriod === "dinner"
          ? " (período de jantar)"
          : "";
    return (
      `\n\nESTADO DA LOJA (fonte da verdade, não invente): a loja está ABERTA agora${period}. ` +
      `NÃO diga que estamos fechados. Não invente um horário específico de fechamento — ` +
      `se perguntarem o horário exato, ofereça verificar.`
    );
  }
  // CLOSED: safety-critical grounding — kept on every non-small-talk turn.
  const reopen = signal.nextOpenDay ? ` Reabrimos ${signal.nextOpenDay}.` : "";
  return (
    `\n\nESTADO DA LOJA (fonte da verdade, não invente): a loja está FECHADA agora.${reopen} ` +
    `NÃO diga que estamos abertos nem confirme entrega/retirada imediata. ` +
    `Você só pode registrar pedidos para retirada agendada.`
  );
}

// Affirmative "the store is open right now" assertions — the core falsehood the
// backstop repairs while CLOSED. All /g so a negated earlier occurrence does not mask
// a later affirmative one.
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

// Affirmative "the store is CLOSED right now" assertions — the falsehood the backstop
// repairs while OPEN (the mirror of FALSE_OPEN_PATTERNS). All /g. Present-tense /
// now-anchored so a general future/day-of-week closure ("fechamos aos domingos") does
// not match (that is not a "closed NOW" claim).
const FALSE_CLOSED_PATTERNS: ReadonlyArray<RegExp> = [
  /\bestamos fechad\w*/g,
  /\b(?:loja|restaurante|cozinha|estabelecimento)\b[^.!?]{0,12}\bfechad\w*/g,
  /\bfechad\w*\b[^.!?]{0,6}\b(?:agora|no momento|neste momento|hoje)\b/g,
  /\bno momento\b[^.!?]{0,12}\bfechad\w*/g,
];

// Negation / closed markers that flip an apparent OPEN-assertion into an HONEST
// closed statement ("nao estamos abertos", "fechado, sem entrega agora") — when
// one of these sits just before the match, the clause is NOT a falsehood.
// `sem` still negates a genuine absence ("sem entrega agora"), but must NOT cancel
// the backstop when it heads a benefit phrase ("sem taxa/custo/juros/fila"), which
// is an immediate-delivery affirmative, not a negation.
const CLOSED_NEGATORS =
  /\b(?:nao|nunca|jamais|sem(?!\s+(?:tax|custo|juro|fila)\w*)|fechad\w*|fora do horario)\b/;

// Negation / open markers that flip an apparent CLOSED-assertion into an HONEST or
// benign statement: a negation ("nao estamos fechados"), an "aberto"/"funcionando"
// nearby, a general day-of-week closure ("fechad… aos domingos"), or a holiday note.
const OPEN_NEGATORS =
  /\b(?:nao|nunca|jamais|abert\w*|funcionando|feriado|aos? (?:domingo|sabado|segunda|terca|quarta|quinta|sexta)s?)\b/;

/** True when an affirmative (non-negated) match of any pattern exists. `negators`
 *  is the lexicon that, sitting just before / inside the matched span, marks the
 *  clause as an honest (non-affirmative) statement. `checkAfter` additionally tests a
 *  trailing window — used ONLY by the OPEN-mirror (`assertsClosedNow`) so a general
 *  day-of-week closure ("estamos fechados AOS DOMINGOS") is honored; it is left OFF
 *  for the safety-critical closed-side guard, where a nearby "fechada" must NEVER
 *  suppress a false-"open" repair. */
function matchesAffirmative(
  normalized: string,
  patterns: ReadonlyArray<RegExp>,
  negators: RegExp = CLOSED_NEGATORS,
  checkAfter = false,
): boolean {
  for (const re of patterns) {
    for (const m of normalized.matchAll(re)) {
      const idx = m.index ?? 0;
      const before = normalized.slice(Math.max(0, idx - 18), idx);
      // Honor a negator sitting just BEFORE the match AND one embedded INSIDE the
      // matched span — e.g. "a loja nao esta aberta", where the "nao" lives between
      // "loja" and "aberta" inside m[0] and the 18-char prefix alone would miss it.
      // Test the prefix PLUS the matched text so such honest statements pass.
      const after = checkAfter
        ? normalized.slice(idx + m[0].length, idx + m[0].length + 18)
        : "";
      if (!negators.test(before + m[0] + after)) return true;
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
 * Whether a draft (declaratively, non-negated) asserts the store is CLOSED right now
 * — the falsehood forbidden while OPEN (the mirror of {@link assertsOpenOrImmediate}).
 * Conservative: negated forms, an "aberto"/"funcionando" nearby, and general
 * future/day-of-week closure ("fechamos aos domingos") pass through.
 */
export function assertsClosedNow(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return matchesAffirmative(normalize(text), FALSE_CLOSED_PATTERNS, OPEN_NEGATORS, true);
}

/** Neutral open-state correction substituted when a draft falsely asserts the store
 *  is closed while it is OPEN. Asserts only the true state; drops the untrustworthy
 *  (self-contradictory) draft. */
export const OPEN_HOURS_CORRECTION_PTBR =
  "No momento estamos abertos e prontos para atender. Como posso ajudar?";

/**
 * The deterministic backstop (TWO-SIDED). Reads the structured `isClosed` flag —
 * never parses the prompt text — and repairs a draft whose store-state assertion
 * contradicts the signal:
 *   - CLOSED: a draft that falsely asserts open / confirms an immediate order → the
 *     canonical closed-disclosure.
 *   - OPEN: a draft that falsely asserts the store is closed right now → the neutral
 *     open correction.
 * No-op when the draft already agrees with the signal (or makes no store-state
 * assertion). Preserves token usage for cost accounting.
 */
export function closedHoursBackstop(
  draft: DraftResponse,
  signal: ScheduleSignal | undefined,
): DraftResponse {
  if (signal === undefined) return draft;
  if (signal.isClosed) {
    if (!assertsOpenOrImmediate(draft.text)) return draft;
    const text = closedHoursDisclosure(signal);
    return draft.usage === undefined ? { text } : { text, usage: draft.usage };
  }
  // OPEN mirror (defense-in-depth): repair a false "estamos fechados agora".
  if (!assertsClosedNow(draft.text)) return draft;
  return draft.usage === undefined
    ? { text: OPEN_HOURS_CORRECTION_PTBR }
    : { text: OPEN_HOURS_CORRECTION_PTBR, usage: draft.usage };
}
