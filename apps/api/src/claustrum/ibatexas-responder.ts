// Decision-aware responder (Phase A — the bug fix; Phase B/C — content-addressed
// prompts + per-call LLM trace).
//
// The previous `naiveResponder` rendered a reply from ONLY the user's text and
// ignored the kernel `Decision` it was handed, so the chat could say "não tenho
// acesso ao sistema de pedidos" while the audited decision was `REFUSE ·
// order.not_found`. Chat text contradicting the audit ledger is a
// correctness/compliance defect.
//
// This responder branches on `input.decision.kind`:
//   REFUSE (a proposed action was refused)  → ExplainerPort.render(refusal)
//       VERBATIM, model-free, SECURITY-safe, deterministic.
//   REFUSE on an EMPTY plan (small-talk; the `empty_plan` "nothing to authorize"
//       sentinel)               → conversational model reply (persona prompt).
//   REQUEST_CONFIRMATION         → decision.prompt.
//   ESCALATE                     → a fixed pt-BR handoff line (model-free).
//   EXECUTE / REWRITE / DEFER    → a model reply GROUNDED in decision.kind +
//       a narrowed `acted` (DispatchResult) + capabilities.
//
// Phase B/C: the two model-call branches compose their system prompt via the
// claustrum PromptComposer (content-addressed fragments) and, when a
// TelemetryPort is wired, emit a bounded LLMTrace per call (id@hash manifest).
// When neither is injected (unit tests), it falls back to the static personas
// and emits nothing — byte-identical to the Phase-A behavior.

import type {
  DraftResponse,
  ExplainerPort,
  ModelProvider,
  ResponderPort,
  TelemetryPort,
} from "@claustrum/core";
import type { Decision } from "@adjudicate/core";
import {
  RESPONDER_ESCALATE_PTBR,
  RESPONDER_GROUNDED_PERSONA_PTBR,
  RESPONDER_PERSONA_PTBR,
} from "./prompts/personas.js";
import {
  RESPONDER_CONVERSATIONAL_SURFACE,
  RESPONDER_GROUNDED_SURFACE,
  type IbatexasPromptComposer,
} from "./prompts/ibatexas-prompts.js";
import { emitModelCallTrace } from "./llm-trace.js";
import {
  closedHoursBackstop,
  closedHoursDisclosure,
  closedHoursPromptNote,
  type ScheduleSignal,
} from "./closed-hours.js";

// Re-export so existing importers (tests) keep their import site.
export {
  RESPONDER_ESCALATE_PTBR,
  RESPONDER_GROUNDED_PERSONA_PTBR,
  RESPONDER_PERSONA_PTBR,
};

const DEFAULT_MAX_TOKENS = 1024;
const PROMPT_BUDGET = { maxTokens: 100_000 } as const;

export interface IbatexasResponderDeps {
  /** Consumed surface is exactly the ModelProvider port (`.complete()`). */
  readonly model: ModelProvider;
  /** Resolved fail-fast at boot by bootstrapClaustrum() — no fallback. */
  readonly modelId: string;
  /** Renders kernel/pack refusals to pt-BR (reused; see ibatexasExplainer). */
  readonly explainer: ExplainerPort;
  readonly maxTokens?: number;
  /** Content-addressed prompt composer (Phase B). When present, the model-call
   * branches compose their system from registered fragments. */
  readonly promptComposer?: IbatexasPromptComposer;
  /** Telemetry sink for the per-model-call LLMTrace (C1). */
  readonly telemetry?: TelemetryPort;
  /**
   * Resolve the current structured open/closed signal for THIS turn (fix B,
   * Stage 1). Called per `respond()` because the signal is time-dependent. When
   * it reports `isClosed`, the closed-hours soft note is injected into the LLM
   * context AND the deterministic backstop polices the draft so it can never
   * falsely assert the store is open / confirm an immediate order while closed.
   * Omitted in unit tests / when no schedule is wired → no closed-hours behavior.
   */
  readonly resolveScheduleSignal?: () =>
    | Promise<ScheduleSignal | undefined>
    | ScheduleSignal
    | undefined;
}

/** Best-effort, BOUNDED summary of the dispatch result for model grounding.
 * Never throws; surfaces only what the reply needs ("what was done"). */
function summarizeActed(acted: unknown): Record<string, unknown> | undefined {
  if (acted === null || typeof acted !== "object") return undefined;
  const a = acted as { kind?: unknown; toolId?: unknown; result?: unknown };
  if (typeof a.kind !== "string") return undefined;
  const out: Record<string, unknown> = { dispatch: a.kind };
  const env = (acted as { envelope?: { kind?: unknown } }).envelope;
  if (env && typeof env.kind === "string") out.executed = env.kind;
  const execs = (
    acted as { executions?: ReadonlyArray<{ envelope?: { kind?: unknown } }> }
  ).executions;
  if (Array.isArray(execs)) {
    out.executed = execs
      .map((e) =>
        e !== null && typeof e === "object"
          ? (e as { envelope?: { kind?: unknown } }).envelope?.kind
          : undefined,
      )
      .filter((k): k is string => typeof k === "string");
  }
  if ("result" in a && a.result !== undefined) out.result = a.result;
  const signal = (acted as { signal?: unknown }).signal;
  if (typeof signal === "string") out.signal = signal;
  // `acted.message` is OPERATOR-FACING (can carry capability ids / internal
  // error or stack text — see @claustrum/core dispatch.ts) and is deliberately
  // NOT forwarded into the model prompt: doing so risks leaking that text to the
  // customer via the grounded reply. The F1/F1b post-completion guards police the
  // OUTPUT, but the leak is an INPUT-side concern they don't cover — so we drop it
  // at the source (restores the #89 "no operator-message leak" hardening that the
  // dev claims-runtime lineage didn't carry forward).
  return out;
}

// ── F1: post-completion consistency guard ────────────────────────────────────
//
// The grounded EXECUTE/REWRITE/DEFER branch returns the model's free text to the
// external send path. Phase A grounds the prompt in the authoritative decision
// ("não inventar"), but that is a SOFT instruction — a jailbroken/hallucinating
// model can still emit a reply that contradicts the audited action. We add a
// deterministic post-check for the one contradiction class that is UNAMBIGUOUS
// on any grounded branch: the model claiming it has no access / no authority to
// the system (the exact original-bug phrasing — "não tenho acesso ao sistema de
// pedidos") right after the kernel adjudicated a real intent and the runtime
// acted. Such a reply is provably false, so it must never reach the customer.
//
// We deliberately do NOT police "claims the action failed": when a dispatch
// genuinely fails on an EXECUTE the model SHOULD say so, and auto-substituting a
// success line there would be a worse, false-confirmation bug. The neutral
// fallback below asserts only what is always true (the request was registered in
// the audit ledger), so it can never contradict the real outcome either way.
//
// The model's ORIGINAL text is still captured in the LLMTrace emitted by
// completeWith(), so an override remains forensically visible.

/** Neutral, audit-accurate line substituted when the grounded reply contradicts
 *  the authoritative decision. Claims only that the request was registered —
 *  never a specific success/failure outcome. */
export const GROUNDED_SAFE_FALLBACK_PTBR =
  "Recebi sua solicitação e ela foi registrada. Se precisar de mais detalhes, posso ajudar.";

const NO_AUTHORITY_PATTERNS: ReadonlyArray<RegExp> = [
  /\bnao (tenho|possuo|teria) acesso\b/,
  /\bnao tenho como acessar\b/,
  /\bnao (consigo|posso|consegui|sou capaz de) acessar\b/,
  /\bsem acesso ao sistema\b/,
  /\bnao tenho (essa |a )?(autoridade|permissao|autonomia)\b/,
];

/** Strip diacritics + lowercase so the lexicon matches accented model output. */
function normalizePtBr(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Returns the matched contradiction pattern (for telemetry/debug) or null. */
export function groundedReplyContradicts(text: string): string | null {
  const normalized = normalizePtBr(text);
  for (const re of NO_AUTHORITY_PATTERNS) {
    if (re.test(normalized)) return re.source;
  }
  return null;
}

// ── F1b: false-success (confabulation) guard ─────────────────────────────────
//
// A weak/jailbroken model can claim a customer-visible SUCCESS the runtime never
// granted — e.g. "Seu pedido já foi registrado com sucesso!" when the kernel only
// ensured an anonymous cart (`order.cart.ensure`), or REFUSED, or merely DEFERred
// awaiting payment. The grounded prompt's "não inventar" is a SOFT instruction
// the 4B ignores. This deterministic post-check makes the claim provable against
// the AUDITED runtime outcome (`input.acted`, the DispatchResult), not the model.
//
// Truth anchor: a success claim is honest ONLY when the runtime actually executed
// a mutation of the claimed class. "Executed" = dispatch ∈
// {executed, rewritten_and_executed, executed_plan} (a kernel EXECUTE decision is
// NOT enough — dispatch can still be "failed"), AND the executed envelope kind is
// one that justifies that specific claim. Critically, "pagamento aprovado/
// confirmado" is justified ONLY by a settlement intent (payment.charge/cash/
// refund.confirm) — NEVER by order.checkout.create or payment.pix.regenerate
// (those create a checkout/QR; they do not settle money).
//
// Conservative by design: it flags only clear domain success-claims that lack a
// matching execution (minimising false blocks); anything it doesn't recognise
// passes through. On a hit, the neutral GROUNDED_SAFE_FALLBACK_PTBR is substituted
// (claims only "request registered"); the model's original text stays forensically
// visible in the LLMTrace emitted by completeWith().

export interface SuccessClaimClass {
  readonly id: string;
  /** Completion-assertion patterns (any one match = a claim of this class). */
  readonly claim: ReadonlyArray<RegExp>;
  /** Negated forms that mean an HONEST failure, not a confabulation. */
  readonly negated: ReadonlyArray<RegExp>;
  /** Executed envelope kinds that make the claim TRUTHFUL. */
  readonly justifiedBy: ReadonlyArray<string>;
}

/** Build a claim class from a domain noun + a verb-root alternation. Matches BOTH
 *  "noun … verb" and "verb … noun" (pt-BR fronts participles freely); conjugations
 *  are absorbed by `\w*`. `negated` fires when nao/nunca/jamais directly precedes
 *  the verb (an honest failure report — never substituted). */
function claimClass(
  id: string,
  noun: string,
  verbs: string,
  justifiedBy: ReadonlyArray<string>,
  extra: ReadonlyArray<RegExp> = [],
  // Max chars between nao/nunca/jamais and the verb for the honest-failure negation
  // to fire. Default 14; widened for the money-sensitive payment class so phrasings
  // like "pagamento ainda nao foi devidamente aprovado" are read as a failure, not
  // substituted as a false claim (review finding 10).
  negationWindow = 14,
): SuccessClaimClass {
  // Completed-verb form from a ROOT: participle (-ado/-ada/-ido/-ida[+s]) or
  // 1st/3rd preterite (-ei/-ou/-amos/-aram). Built so NOMINALIZATIONS do not match
  // — "confirmado/confirmei" hit; "confirmação"/"cancelamento"/"registro" do not.
  const V = `(?:${verbs})(?:ad[oa]s?|id[oa]s?|ei|ou|amos|aram|iram)`;
  return {
    id,
    claim: [
      new RegExp(String.raw`\b${noun}\b[^.!?]{0,40}\b${V}\b`),
      new RegExp(String.raw`\b${V}\b[^.!?]{0,18}\b(?:o |a |os |as |seu |sua |teu )?${noun}\b`),
      ...extra,
    ],
    negated: [new RegExp(String.raw`\b(?:nao|nunca|jamais)\b[^.!?]{0,${negationWindow}}\b${V}\b`)],
    justifiedBy,
  };
}

// Completion-verb ROOTS per domain (the builder appends -ado/-ido/-ei/-ou…).
// Irregulars (feito/feita) are added as `extra` literals.
export const SUCCESS_CLAIM_CLASSES: ReadonlyArray<SuccessClaimClass> = [
  claimClass("order-placed", "pedido", "registr|confirm|realiz|finaliz|efetu|conclu|fech|cri", ["order.checkout.create"], [/\bpedido\b[^.!?]{0,30}\bfeito\b/, /\bfeito\b[^.!?]{0,15}\b(?:o |seu )?pedido\b/]),
  claimClass("purchase-completed", "compra", "finaliz|conclu|realiz|confirm|efetu|fech", ["order.checkout.create"], [/\bcompra\b[^.!?]{0,20}\bfeita\b/]),
  // payment-settled = an INBOUND payment was approved/settled. A REFUND confirmation
  // is the opposite money direction and must NOT justify a "pagamento aprovado"
  // claim (review finding 12) — it justifies only the `refund-done` class below.
  // Wider negation window (30) so honest-failure phrasings aren't mis-substituted.
  claimClass("payment-settled", "pagamento", "aprov|confirm|realiz|efetu|conclu|liquid|quit", ["payment.charge.confirm", "payment.cash.confirm"], [/\b(?:esta|ta|ja)\s+pago\b/, /\bpix\s+pago\b/, /\bpaguei\b/], 30),
  claimClass("order-canceled", "pedido", "cancel", ["order.cancel"], [/\bcancelamento\b[^.!?]{0,20}\b(?:realizad|efetuad|concluid)\w*/]),
  claimClass("cart-item-added", "carrinho", "adicion|inclu|atualiz", ["order.item.add", "order.item.update", "order.item.remove"], [/\bitem\b[^.!?]{0,15}\badicionad\w*/]),
  claimClass("refund-done", "reembolso", "process|emit|realiz|efetu|conclu|confirm|aprov", ["payment.refund.issue", "payment.refund.confirm"]),
  claimClass("note-added", String.raw`observac\w*`, "adicion", ["order.note.add"]),
  claimClass("order-amended", "pedido", "alter|atualiz", ["order.amend.request", "order.amend.add_item", "order.amend.update_qty", "order.amend.remove_item"], [/\badicionad\w*\b[^.!?]{0,15}\bao pedido\b/, /\baltera\w*\b[^.!?]{0,22}\b(?:registrad|realizad)\w*/]),
  claimClass("reservation-confirmed", "reserva", "confirm|garant|realiz|efetu|conclu", ["reservation.create", "reservation.modify", "reservation.checkin", "reservation.complete"], [/\breserva\b[^.!?]{0,20}\bfeita\b/, /\bmesa\b[^.!?]{0,20}\b(?:reservad|garantid|confirmad)\w*/, /\bcheck-?in\b[^.!?]{0,15}\b(?:feito|confirmad|realizad)\w*/, /\b(?:agendad\w*|agendamento)\b[^.!?]{0,25}\b(?:confirmad|realizad|feito|concluid)\w*/]),
  // PIX code/QR generation — justified by a checkout (PIX) or a regenerate.
  { id: "pix-generated", claim: [/\b(?:codigo )?pix\b[^.!?]{0,18}\b(?:gerad|criad|criei|gerei)\w*/, /\bgerei\b[^.!?]{0,15}\bpix\b/], negated: [/\b(?:nao|nunca|jamais)\b[^.!?]{0,14}\b(?:gerad|criad|gerei)\w*/], justifiedBy: ["order.checkout.create", "payment.pix.regenerate"] },
  // Fulfillment is NEVER performed by the chat responder — any such claim is unearned.
  { id: "fulfillment-claimed", claim: [/\b(?:a caminho|saiu pra entrega|saiu para entrega|em preparo|no preparo|mandei pro preparo|ja separei|esta sendo preparad|pronto pra retirar|pronto para retirar|pode (?:vir )?(?:retirar|buscar))\b/], negated: [/\bnao\b[^.!?]{0,10}\b(?:a caminho|saiu|pronto)\b/], justifiedBy: [] },
];

/** The envelope kinds the runtime ACTUALLY executed this turn (empty unless the
 *  dispatch genuinely committed a mutation). */
function executedKinds(acted: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  const s = summarizeActed(acted);
  if (s === undefined) return out;
  const dispatch = s.dispatch;
  if (dispatch !== "executed" && dispatch !== "rewritten_and_executed" && dispatch !== "executed_plan") {
    return out; // failed / refused / deferred / awaiting_confirmation / escalated → nothing committed
  }
  const ex = s.executed;
  if (typeof ex === "string") out.add(ex);
  else if (Array.isArray(ex)) for (const k of ex) if (typeof k === "string") out.add(k);
  return out;
}

// Clause-level mood gates — a success PREDICATE inside a question, a future/
// conditional clause, or a pending-status clause is NOT a completed assertion.
const QUESTION = /\?/;
// Split into two simpler patterns (combined via || at the call site) to keep each
// regex under the complexity budget; the union of matches is identical to the
// original single alternation. `serao?`/`va[io]`/`irao?`/`poderao?` are exact
// factorings of sera|serao / vai|vao / ira|irao / podera|poderao.
const FUTURE_OR_CONDITIONAL =
  /\b(?:serao?|va[io]|irao?|iremos|vamos|poderao?|assim que|quando|caso|logo que|apos|depois que)\b/;
const FUTURE_OR_CONDITIONAL_SE =
  /\bse (?:voce|vc|tu|o |a |houver|tiver|pagar|confirmar|quiser|precisar|der|fizer)\b/;
const PENDING_STATUS = /\b(?:recebid|em analise|sendo processad|processand|aguardand|pendente|em processament|em aberto|aguarda)/;

/** Split normalized text into sentences, tagging each with whether it is a question. */
function sentencesOf(normalized: string): ReadonlyArray<{ text: string; question: boolean }> {
  const out: Array<{ text: string; question: boolean }> = [];
  // Capture the leading non-terminator run (group 1) directly, so the trailing
  // terminator run is dropped without the super-linear `/[.!?\n;]+$/` strip.
  const re = /([^.!?\n;]+)[.!?\n;]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const body = m[1].trim();
    if (body.length > 0) out.push({ text: body, question: QUESTION.test(m[0]) });
  }
  return out;
}

// An UNAMBIGUOUS completion marker. A clause asserting "… com sucesso/êxito" is a
// definite success even if it also contains a pending word ("pedido recebido E
// registrado com sucesso"), so the pending-status exemption must NOT apply to it
// (review finding 8).
const DEFINITE_SUCCESS = /\bcom (?:sucesso|exito)\b/;

/** Whether a matched success predicate is mood-exempt (future/conditional/pending)
 *  — but evaluated CLAUSE-LOCALLY (comma/colon-delimited), so a trailing courtesy
 *  clause ("…, se precisar de algo avise") no longer suppresses a completed claim
 *  in a DIFFERENT clause (review finding 5). A clause that asserts definite success
 *  ("…com sucesso") is never pending-exempt (finding 8). */
function claimIsMoodExempt(sentence: string, claimRe: RegExp): boolean {
  const m = claimRe.exec(sentence);
  if (m === null) return false;
  const start = m.index;
  // The comma/colon-delimited clause containing the match.
  const before = Math.max(sentence.lastIndexOf(",", start), sentence.lastIndexOf(":", start));
  const afters = [sentence.indexOf(",", start), sentence.indexOf(":", start)].filter((i) => i >= 0);
  const after = afters.length > 0 ? Math.min(...afters) : sentence.length;
  const clause = sentence.slice(before + 1, after);
  if (FUTURE_OR_CONDITIONAL.test(clause) || FUTURE_OR_CONDITIONAL_SE.test(clause)) return true;
  if (PENDING_STATUS.test(clause) && !DEFINITE_SUCCESS.test(clause)) return true;
  return false;
}

/** Returns the matched success-claim class id (for telemetry/debug) when the reply
 *  ASSERTS (declaratively, present/past) a customer-visible success the runtime did
 *  not grant, else null. Questions, future/conditional, pending-status, and negated
 *  (honest-failure) phrasings are intentionally NOT flagged. */
/** Scan ONE sentence for a success-claim class the runtime did not justify. Honest
 *  failures (negated forms) and mood-exempt clauses (future/conditional/pending) are
 *  skipped. Returns the matched class id, or null when the sentence makes no unearned
 *  claim. Extracted from replyClaimsUnearnedSuccess so both bodies stay within the
 *  cognitive-complexity budget; behavior is identical (same iteration + ordering). */
function unearnedClaimInSentence(
  sentenceText: string,
  executed: ReadonlySet<string>,
): string | null {
  for (const cls of SUCCESS_CLAIM_CLASSES) {
    if (cls.negated.some((re) => re.test(sentenceText))) continue; // honest failure
    // Find the specific claim pattern that matched so the mood gate can be scoped
    // to ITS clause (not the whole sentence) — a future/conditional/pending word
    // elsewhere in the sentence no longer blanket-suppresses a completed claim.
    const matched = cls.claim.find((re) => re.test(sentenceText));
    if (matched === undefined) continue;
    if (claimIsMoodExempt(sentenceText, matched)) continue; // future/conditional/pending clause
    if (!cls.justifiedBy.some((k) => executed.has(k))) return cls.id;
  }
  return null;
}

export function replyClaimsUnearnedSuccess(text: string, acted: unknown): string | null {
  if (typeof text !== "string") return null;
  const normalized = normalizePtBr(text);
  const executed = executedKinds(acted);
  for (const sent of sentencesOf(normalized)) {
    if (sent.question) continue; // a clarifying question is not a claim
    const hit = unearnedClaimInSentence(sent.text, executed);
    if (hit !== null) return hit;
  }
  return null;
}

/** Override a draft's text while preserving every other field (usage, artifacts,
 *  meta). Used where the text is AUGMENTED (not replaced) — e.g. surfacing a
 *  REWRITE clamp — so a draft's artifacts/meta are not silently dropped. */
function withText(draft: DraftResponse, text: string): DraftResponse {
  return { ...draft, text };
}

/** Apply the deterministic post-completion guards to a model-produced draft:
 *  substitute the neutral, audit-accurate line if the reply makes a no-authority
 *  claim (F1) or claims a success the runtime did not grant (F1b). Preserves the
 *  draft's token usage so the loop's cost accounting stays correct. This is a FULL
 *  replacement (not `withText`): a confabulated draft's artifacts/meta are
 *  deliberately discarded — only the cost accounting (usage) survives. */
function guardDraft(draft: DraftResponse, acted: unknown): DraftResponse {
  if (
    groundedReplyContradicts(draft.text) !== null ||
    replyClaimsUnearnedSuccess(draft.text, acted) !== null
  ) {
    return draft.usage === undefined
      ? { text: GROUNDED_SAFE_FALLBACK_PTBR }
      : { text: GROUNDED_SAFE_FALLBACK_PTBR, usage: draft.usage };
  }
  return draft;
}

/** Closed-hours delivery guard. Runs the deterministic `closedHoursBackstop`
 *  (repairs a draft that falsely asserts open / confirms an immediate order), then
 *  closes a SECOND gap: when the store isClosed and the post-guard text is the
 *  neutral GROUNDED_SAFE_FALLBACK (because F1/F1b stripped a draft that bundled an
 *  unearned success claim WITH the closed-disclosure), substitute the canonical
 *  closedHoursDisclosure(). The fallback is audit-accurate but SILENT on closure —
 *  this restores the closed/scheduling disclosure the guard dropped. Conservative:
 *  fires only while closed and only for the neutral fallback (a draft that already
 *  discloses closed, or any other text, is left untouched). The disclosure asserts
 *  nothing open, preserving the NEVER-open / never-immediate guarantee. */
function closedHoursDeliveryGuard(
  draft: DraftResponse,
  signal: ScheduleSignal | undefined,
): DraftResponse {
  const repaired = closedHoursBackstop(draft, signal);
  if (
    signal?.isClosed &&
    repaired.text === GROUNDED_SAFE_FALLBACK_PTBR
  ) {
    const text = closedHoursDisclosure(signal);
    return repaired.usage === undefined ? { text } : { text, usage: repaired.usage };
  }
  return repaired;
}

/** When the kernel REWROTE the envelope with a USER-RELEVANT clamp (e.g. quantity
 *  reduced to available stock), make sure the customer is actually TOLD. The 4B
 *  can't be trusted to surface it from the grounded context, so we append the
 *  kernel's own reason deterministically. Internal security sanitizations (PII
 *  masking) are deliberately NOT surfaced — those are silent to the customer.
 *  Note: a clamp that is then re-adjudicated to a friction verb (REWRITE→CONFIRM)
 *  surfaces as REQUEST_CONFIRMATION, so this only covers the standalone REWRITE. */
function surfaceRewriteClamp(
  draft: DraftResponse,
  decision: { kind: string; reason?: unknown },
): DraftResponse {
  if (decision.kind !== "REWRITE") return draft;
  // Finding 21: guardDraft (F1/F1b) runs BEFORE this and may have substituted the
  // neutral fallback. Appending a specific clamp reason onto that generic line reads
  // as contradictory — the fallback already supersedes the clamp note, so leave it.
  if (draft.text === GROUNDED_SAFE_FALLBACK_PTBR) return draft;
  const reason = typeof decision.reason === "string" ? decision.reason.trim() : "";
  if (reason.length === 0 || /\b(pii|mascar)/i.test(reason)) return draft;
  // Finding 9: only suppress the clamp notice when the model ALREADY conveyed THIS
  // (stock/quantity) adjustment — keyed on an adjustment verb co-occurring with a
  // quantity/stock noun, NOT any "ajust" anywhere (an unrelated "Ajustei o endereço"
  // must not silence a real quantity clamp the customer needs to know about).
  const t = normalizePtBr(draft.text);
  if (
    /\b(?:ajust|reduz|diminu|limit)/.test(t) &&
    /\b(?:quantidade|estoque|unidade|qtd)\b/.test(t)
  ) {
    return draft;
  }
  const text = `${draft.text.trim()} ${reason}`.trim();
  return withText(draft, text);
}

export function createIbatexasResponder(
  deps: IbatexasResponderDeps,
): ResponderPort {
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;

  /** Compose the system for a model-call branch; falls back to the static
   * persona when no composer is wired. Returns the (possibly empty) manifest. */
  async function composeSystem(
    surface: string,
    fallback: string,
    cognition: unknown,
    capabilities: ReadonlyArray<string>,
  ): Promise<{ system: string; fragmentManifest: ReadonlyArray<string> }> {
    if (deps.promptComposer === undefined) {
      return { system: fallback, fragmentManifest: [] };
    }
    const composed = await deps.promptComposer.composer.compose(
      {
        cognition: cognition as never,
        capabilities: [...capabilities],
        extra: { surface },
      },
      PROMPT_BUDGET,
    );
    return {
      system: composed.system,
      fragmentManifest: composed.fragmentManifest,
    };
  }

  async function completeWith(args: {
    system: string;
    fragmentManifest: ReadonlyArray<string>;
    userText: string;
    turnId: string;
    intentHash?: string;
  }): Promise<DraftResponse> {
    const startedAt = Date.now();
    const completion = await deps.model.complete({
      model: deps.modelId,
      maxTokens,
      system: args.system,
      messages: [{ role: "user", content: args.userText }],
    });
    const durationMs = Date.now() - startedAt;

    if (deps.promptComposer !== undefined && deps.telemetry !== undefined) {
      await emitModelCallTrace({
        telemetry: deps.telemetry,
        registry: deps.promptComposer.registry,
        turnId: args.turnId,
        model: deps.modelId,
        fragmentManifest: args.fragmentManifest,
        completionText: completion.text,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        durationMs,
        at: new Date().toISOString(),
        ...(args.intentHash === undefined ? {} : { intentHash: args.intentHash }),
      });
    }

    return {
      text: completion.text,
      // F4 / cost accounting: report this turn's synthesis-model token usage so
      // the loop sums it (plan.usage + draft.usage) onto the TurnRecord.
      usage: {
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      },
    };
  }

  return {
    async respond(input): Promise<DraftResponse> {
      const decision = input.decision as Decision;
      const userText = input.cognition.perception.text;
      const turnId = input.cognition.turnId;
      const firstEnvelope = input.plan.envelopes[0] as
        | { intentHash?: string }
        | undefined;
      const intentHash = firstEnvelope?.intentHash;

      // fix B (Stage 1): resolve the structured closed-hours signal ONCE for the
      // turn. `closedNote` is the soft layer (injected into every model-call
      // branch's system prompt); `closedHoursBackstop(_, scheduleSignal)` is the
      // deterministic hard layer wrapped around every model-authored draft.
      const scheduleSignal = deps.resolveScheduleSignal
        ? ((await deps.resolveScheduleSignal()) ?? undefined)
        : undefined;
      const closedNote = closedHoursPromptNote(scheduleSignal);

      switch (decision.kind) {
        case "REFUSE": {
          // A REFUSE on an EMPTY plan is the "nothing to authorize" sentinel
          // (small-talk / informational turn) — reply conversationally.
          if (input.plan.envelopes.length === 0) {
            const { system: base, fragmentManifest } = await composeSystem(
              RESPONDER_CONVERSATIONAL_SURFACE,
              RESPONDER_PERSONA_PTBR,
              input.cognition,
              [],
            );
            const system = base + closedNote;
            return closedHoursDeliveryGuard(
              guardDraft(
                await completeWith({ system, fragmentManifest, userText, turnId }),
                input.acted,
              ),
              scheduleSignal,
            );
          }
          // A real action refusal: render the pt-BR refusal VERBATIM (model-free,
          // single-sourced, SECURITY-safe). This is the bug fix.
          return { text: deps.explainer.render(decision.refusal) };
        }

        case "REQUEST_CONFIRMATION":
          // The guard already authored the confirm question; surface it verbatim.
          return { text: decision.prompt };

        case "ESCALATE":
          return { text: RESPONDER_ESCALATE_PTBR };

        case "EXECUTE":
        case "REWRITE":
        case "DEFER": {
          // The kernel decided + the runtime acted — ground the reply in what
          // happened so it can never contradict the audited action.
          const capabilities =
            input.plan.capabilities ??
            input.plan.envelopes.map((e) => String(e.kind));
          const { system: baseSystem, fragmentManifest } = await composeSystem(
            RESPONDER_GROUNDED_SURFACE,
            RESPONDER_GROUNDED_PERSONA_PTBR,
            input.cognition,
            capabilities,
          );
          const context = {
            decision: decision.kind,
            capabilities,
            acted: summarizeActed(input.acted),
          };
          const system =
            `${baseSystem}\n\n` +
            `CONTEXTO DA DECISÃO (fonte da verdade, não inventar):\n` +
            JSON.stringify(context) +
            closedNote;
          const draft = await completeWith({
            system,
            fragmentManifest,
            userText,
            turnId,
            ...(intentHash === undefined ? {} : { intentHash }),
          });
          // F1 + F1b: post-completion guards. The grounded prompt is only a soft
          // instruction — never let a model reply that contradicts the audited
          // decision (no-authority claim) OR claims a success the runtime did not
          // grant (confabulation) reach the customer. Then surface any user-relevant
          // REWRITE clamp deterministically (the model can't be trusted to).
          return closedHoursDeliveryGuard(
            surfaceRewriteClamp(guardDraft(draft, input.acted), decision),
            scheduleSignal,
          );
        }

        default: {
          // Exhaustiveness guard — a new Decision kind must be handled here. The
          // `satisfies never` keeps the compile-time check (adding a kind without a
          // case errors) without the runtime fall-through changing.
          decision satisfies never;
          const { system: base, fragmentManifest } = await composeSystem(
            RESPONDER_CONVERSATIONAL_SURFACE,
            RESPONDER_PERSONA_PTBR,
            input.cognition,
            [],
          );
          const system = base + closedNote;
          return closedHoursDeliveryGuard(
            guardDraft(
              await completeWith({ system, fragmentManifest, userText, turnId }),
              input.acted,
            ),
            scheduleSignal,
          );
        }
      }
    },
  };
}
