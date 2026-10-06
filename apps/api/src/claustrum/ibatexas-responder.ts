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
import { logger } from "../lib/logger.js";
import {
  RESPONDER_ESCALATE_PTBR,
  RESPONDER_GROUNDED_PERSONA_PTBR,
  RESPONDER_PERSONA_PTBR,
} from "./prompts/personas.js";
import { resolvePrompt } from "./prompts/prompt-overrides.js";
import {
  RESPONDER_CONVERSATIONAL_SURFACE,
  RESPONDER_GROUNDED_SURFACE,
  type IbatexasPromptComposer,
} from "./prompts/ibatexas-prompts.js";
// BKL-262 Stage 2 — the SAME turn-shape net the Stage-1 write-twin rescue uses, so
// the two stages never disagree about whether a turn is a question or a mutation.
import { hasMutationImperative } from "./required-claim-decomposer.js";
import { emitModelCallTrace } from "./llm-trace.js";
import { completeWithEmptyRetry } from "./complete-with-retry.js";
import { PINNED_COMPLETION_TEMPERATURE } from "./model-call-defaults.js";
import {
  closedHoursBackstop,
  closedHoursDisclosure,
  closedHoursPromptNote,
  closedHoursScheduledConfirmation,
  type ScheduleSignal,
} from "./closed-hours.js";
import type { FunnelStageRecord } from "./funnel-tier.js";

// Re-export so existing importers (tests) keep their import site.
export {
  RESPONDER_ESCALATE_PTBR,
  RESPONDER_GROUNDED_PERSONA_PTBR,
  RESPONDER_PERSONA_PTBR,
};

const DEFAULT_MAX_TOKENS = 1024;
const PROMPT_BUDGET = { maxTokens: 100_000 } as const;

// F6 (BKL-031) — total responder-completion attempts (incl. the first) before
// giving up to the holding-message fallback. The 4B empties ~22% of the time;
// 3 attempts leaves ~1% residual. Config from env (Hard Rule #3).
const EMPTY_COMPLETION_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.EMPTY_COMPLETION_MAX_ATTEMPTS ?? "3", 10) || 3,
);

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
  /**
   * Per-decision-branch persona overrides (NEW-032 slice B). When a key is
   * present it REPLACES the corresponding default constant for that branch —
   * and WINS over the content-addressed `promptComposer` (an injected system is
   * the whole point on the ops plane, so the customer fragment graph must not
   * override it). When ABSENT (customer / WhatsApp planes) behavior is
   * BYTE-IDENTICAL to today — pinned by a regression test. Each override is the
   * FULL system prompt for its branch; all downstream anti-confabulation /
   * closed-hours / pt-BR guards run UNCHANGED over the model draft.
   *
   *  - `conversational` → the REFUSE-empty-plan (small-talk) + fallback branch
   *    (default {@link RESPONDER_PERSONA_PTBR}).
   *  - `grounded`       → the EXECUTE/REWRITE/DEFER branch
   *    (default {@link RESPONDER_GROUNDED_PERSONA_PTBR}).
   *  - `escalate`       → the ESCALATE fixed line
   *    (default {@link RESPONDER_ESCALATE_PTBR}).
   */
  readonly personas?: {
    readonly conversational?: string;
    readonly grounded?: string;
    readonly escalate?: string;
  };
  /**
   * Wire Truth — prompt-catalog ids for the persona overrides above, so a
   * branch that runs on an injected persona still emits a truthful (single-tag)
   * prompt manifest instead of `[]` (the workbench's `persona ?`). Bare ids are
   * passed through `manifestWithHashes` unhashed — the fragment graph does not
   * own these prompts, the catalog does. Absent → the pre-existing empty
   * manifest, byte-identical.
   */
  readonly personaIds?: {
    readonly conversational?: string;
    readonly grounded?: string;
  };
  /**
   * Wire Truth — ops-plane REFUSE conversational recovery. When true, a kernel
   * REFUSE of a PROPOSED command (non-empty plan) routes through the same
   * conversational synthesis branch the empty-plan path uses — with the
   * refusal context and the operator's original inbound in the system — so a
   * refused misparse still yields a helpful reply. Empty synthesis falls back
   * to the deterministic explainer line (never silent). NEVER set on the
   * customer plane: customer-facing refusals stay model-free by doctrine.
   */
  readonly conversationalRefusal?: boolean;
  /**
   * BKL-100 — the ops-plane read-answer governor. Injected ONLY on the ops
   * conductor (the customer / WhatsApp planes never pass it, so their behavior is
   * BYTE-IDENTICAL — pinned by the responder-personas regression bar). It gives
   * the responder two model-free hooks on the CONVERSATIONAL (REFUSE-empty-plan +
   * fallback) branch:
   *
   *  - `render(turnId)` — when a staff read (ops_snapshot / ops_sales_analytics)
   *    was captured THIS turn, returns the deterministic pt-BR answer rendered
   *    from the ACTUAL read result (or an honest "couldn't check" line). That IS
   *    the reply — the responder makes NO model call, so a read answer can never
   *    be a model-authored number. Returns `undefined` when no read was captured
   *    (the responder then does its normal conversational completion).
   *  - `clampUngrounded(text)` — a demote-only clamp applied to the model draft
   *    AFTER the existing guards, on the conversational fallback (reached only when
   *    `render` returned `undefined`, i.e. NO read this turn). A draft stating a
   *    domain number it could not have grounded is replaced by an honest nudge; it
   *    never PROMOTES a draft. Returns `null` to leave the draft untouched.
   */
  readonly readAnswer?: {
    render(turnId: string): string | undefined;
    /**
     * BKL-149 — the ops-plane ACTION governor. On an EXECUTE/REWRITE turn that
     * COMMITTED a mutation, returns the deterministic pt-BR statement of WHAT THE
     * VERB DID, rendered from the adjudicated envelope (kind + resolved payload) +
     * dispatch result — the model authors NONE of it. That IS the reply (no model
     * call), the ACTION-plane analog of `render`. Returns `undefined` when nothing
     * committed (deferred / failed dispatch) so the responder falls through to its
     * existing grounded model path (a failed EXECUTE must never read as a success).
     * A mixed read+act turn gets the read render appended by the conductor's
     * wiring. Absent dep (customer / WhatsApp) → the grounded branch is byte-identical.
     */
    renderAction?(acted: unknown, turnId: string): string | undefined;
    clampUngrounded?(
      text: string,
      allowedSources?: readonly string[],
    ): string | null;
    /**
     * Adversarial-review fix — govern the GROUNDED (EXECUTE/REWRITE/DEFER) draft:
     * appends the deterministic render of any read captured this turn (the read
     * half of a mixed read+act turn must come from the ACTUAL read, never model
     * memory) and digit-run clamps model-authored domain numbers not grounded in
     * an allowed source (acted summary / staff message / schedule note / the
     * appended render). Deterministic + demote-only; absent → grounded branch
     * byte-identical.
     */
    governGrounded?(
      text: string,
      turnId: string,
      allowedSources: readonly string[],
    ): string;
  };
  /**
   * LE2-021 — the WHOLE-WORKFLOW confirm sentence for this turn, or `undefined`
   * when the turn selected no workflow (or when the workflow runtime declines to
   * render one — see `renderConfirm`'s unresolved-param guard).
   *
   * Structural sibling of `readAnswer.render` above and injected the same way:
   * the responder cannot reach the workflow runtime, so the composition root
   * hands it a closure over `renderConfirm`. Consulted ONLY on the
   * REQUEST_CONFIRMATION branch, and only ever as a preference over
   * `decision.prompt` — never as a source of new facts. The string it returns is
   * the workflow's AUTHORED template with the kernel's own grounded sentence
   * interpolated into it, so no model authored any part of it.
   *
   * KNOWN, ACCEPTED DIVERGENCE: the PARK's `userPrompt` is written by
   * `@claustrum/core` from `decision.prompt` and cannot follow this, so the
   * BKL-212 soft-affirmative restatement quotes the kernel sentence while the
   * reply quotes the template. That is benign only because the authoring rule
   * makes the template strictly ADDITIVE around `{confirmation}` — the restated
   * sentence is then a subset of what the customer already read, never a
   * contradiction. Unifying them would mean substituting the decision itself,
   * and `observeWorkflowDecisions` is observe-only by construction.
   */
  readonly workflowConfirm?: (turnId: string) => string | undefined;
  /**
   * LE2-022 — the AUTHORED reason a workflow's FEASIBILITY PRE-CHECK refused
   * this turn, or `undefined` when none did.
   *
   * Structural sibling of {@link workflowConfirm} and injected the same way, but
   * consulted on the opposite branch: the planner dropped the anchor envelope,
   * so the turn arrives here as a REFUSE on an EMPTY plan — the same
   * respond-only shape a social turn takes. Without this seam that turn would
   * fall through to a model completion and the customer would be told, in prose
   * the model authored, why a multi-step route they asked for is not happening.
   * That is precisely a proposition the model has no grounds for: the reason
   * lives in a projection it never saw.
   *
   * The string is the pre-check's own template, rendered from grounded values —
   * so it names WHAT is missing rather than saying no in general, which is the
   * only version of this sentence a customer can act on.
   */
  readonly workflowNotice?: (turnId: string) => string | undefined;
  /**
   * BKL-078 — the QUESTION-SHAPE SAFE-UNKNOWN gate. Injected on BOTH conversational
   * conductors when ENABLE_CLAIMS_PIPELINE is on (LE2 Implementation Decision 6
   * dissolved D5, under which only the CUSTOMER conductor passed it; both planes now
   * compose the one `createSafeUnknownGate` — pinned by a composition test per plane.
   * Flag OFF never constructs it → BYTE-IDENTICAL, pinned by the personas regression
   * bar). It closes the `prose_preserved` hallucination leak on the conversational
   * (REFUSE-empty-plan) branch — reached only when NO claim survived to render
   * (runClaimsValidate returned undefined ⟺ empty candidate set; loop §6a therefore
   * cannot supersede this text). An ungrounded INFO-QUESTION that produced no
   * validated claim would otherwise fall through to a model-authored prose draft
   * that can state a delivered falsehood. When `gate(userText)` fires the branch
   * returns the deterministic proposition-free SAFE_UNKNOWN text (no model call — no
   * prose can leak), SOUNDNESS-MONOTONIC: it only moves a turn prose→SAFE_UNKNOWN,
   * never the reverse, and never touches the render / claim-proposal paths.
   *
   *  - `gate(text)` — TRUE iff the message is a non-smalltalk info-question
   *    (interrogative-discriminator.shouldDegradeToSafeUnknown). Smalltalk WINS
   *    (never degrades — the BKL-110 0/15 bar). Absent dep → the normal
   *    conversational completion runs.
   *  - `render(schedule)` — the deterministic pt-BR SAFE_UNKNOWN reply, with the
   *    closed-hours disclosure appended when the schedule signal says closed.
   */
  readonly safeUnknown?: {
    gate(text: string): boolean;
    render(schedule: ScheduleSignal | undefined, userText: string): string;
  };
  /**
   * LE2-007 — the parse funnel's tier seam, the RESPONDER half. The planner stamped
   * this turn's stage record (handleTurn runs PLAN before SYNTHESIZE), so the
   * responder does not re-classify anything: it reads the stamp and, for a tier that
   * authors its own reply (L0 today), returns that deterministic pt-BR template with
   * NO model call. Together with the planner + claim-path short-circuits that is the
   * whole zero-completions guarantee for a social turn.
   *
   * ABSENT ⟹ byte-identical to the pre-funnel responder (ops plane, agent plane, unit
   * tests). Wired on the customer plane only, from the same `createL0Funnel()`
   * instance the planner got, so the two can never disagree about a turn.
   */
  readonly funnel?: {
    stageFor(turnId: string): FunnelStageRecord | undefined;
    reply(stage: FunnelStageRecord): string | undefined;
  };
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

// ── ② Capability-id leak guard (INPUT redaction + OUTPUT scrub) ───────────────
//
// The grounded EXECUTE/REWRITE/DEFER prompt serialized the raw internal capability
// KIND strings (`executed`, and the plan's `capabilities` list — e.g.
// "order.item.add", "payment.refund.issue") under a "fonte da verdade, não inventar"
// label. The weak 4B parrots those dotted identifiers into the customer reply, a Hard
// Rule #9 violation. The `dispatch` FIELD is the DispatchResult STATUS enum
// ("executed"/"failed"/"deferred") — not a capability id — and is kept.

/** Customer-safe view of the acted summary for the model prompt: drops the raw
 *  capability KIND(s) (`executed`) so they can never be echoed to the customer. The
 *  un-redacted summary is still used by executedKinds() for the F1b guard — only the
 *  model-visible copy is stripped (mirrors the `acted.message` input-drop above). */
function redactActedForPrompt(
  summary: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (summary === undefined) return undefined;
  const { executed: _executed, ...safe } = summary;
  return safe;
}

/** Defense-in-depth output scrub: TRUE iff the draft echoes one of the raw capability
 *  KIND ids that were in scope this turn (a dotted internal identifier the customer
 *  must never see). Keyed on the EXACT kinds, so it can never false-fire on ordinary
 *  pt-BR text or a decimal price. */
function draftLeaksCapabilityId(
  text: string,
  kinds: ReadonlyArray<string>,
): boolean {
  if (typeof text !== "string") return false;
  const lower = text.toLowerCase();
  return kinds.some(
    (k) => typeof k === "string" && k.includes(".") && lower.includes(k.toLowerCase()),
  );
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
 *  the authoritative decision on a turn that ACTUALLY COMMITTED a mutation. Claims
 *  only that the request was registered — honest here because a real EXECUTE ran
 *  (the contradiction case: the model wrongly said "no access" after the runtime
 *  acted). NEVER used on a no-op turn — see BKL-210. */
export const GROUNDED_SAFE_FALLBACK_PTBR =
  "Recebi sua solicitação e ela foi registrada. Se precisar de mais detalhes, posso ajudar.";

/** BKL-210 — the HONEST fallback for a clamped draft on a turn that committed
 *  NOTHING (no executed kind). The old single fallback claimed "foi registrada"
 *  even when nothing was adjudicated — live-caught firing for an injection probe
 *  AND an LGPD-erasure ask (a real false reassurance: the customer believed the
 *  request was on file). This variant asserts NO world-state change and offers
 *  the honest next step, never a receipt. */
export const NO_CAPABILITY_HONEST_FALLBACK_PTBR =
  "Não consegui concluir essa solicitação por aqui. Se preferir, posso te encaminhar para um atendente.";

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
// confirmado" is justified ONLY by an inbound settlement intent
// (payment.cash.confirm; payment.charge.confirm was retired in BKL-176) —
// NEVER by order.checkout.create or payment.pix.regenerate (those create a
// checkout/QR; they do not settle money), and NEVER by a refund (opposite money
// direction — CLAUDE.md excludes it).
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
  /** The class's domain noun (a regex fragment). Guards the F1b FALSE-FAILURE mirror
   *  so a shared verb root does not cross-flag a different-noun honest failure. */
  readonly noun?: string;
  /** BKL-194 — RECEIPT-semantics class: the action COMPLETES on receipt ("avaliação
   *  recebida" IS the success, not an in-flight status), so the PENDING_STATUS mood
   *  exemption must NOT rescue its claims ("recebid…" is this class's own completion
   *  verb — the exemption would swallow the exact live false-success). Future/
   *  conditional clauses still exempt (an honest "vou registrar" stays unflagged). */
  readonly receiptIsCompletion?: true;
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
    noun,
  };
}

// Completion-verb ROOTS per domain (the builder appends -ado/-ido/-ei/-ou…).
// Irregulars (feito/feita) are added as `extra` literals.
export const SUCCESS_CLAIM_CLASSES: ReadonlyArray<SuccessClaimClass> = [
  // BKL-194 — order.reorder ALSO genuinely places an order, so it justifies the
  // order-placed family (a reorder-executed turn saying "pedido criado" is honest).
  claimClass("order-placed", "pedido", "registr|confirm|realiz|finaliz|efetu|conclu|fech|cri", ["order.checkout.create", "order.reorder"], [/\bpedido\b[^.!?]{0,30}\bfeito\b/, /\bfeito\b[^.!?]{0,15}\b(?:o |seu )?pedido\b/]),
  claimClass("purchase-completed", "compra", "finaliz|conclu|realiz|confirm|efetu|fech", ["order.checkout.create"], [/\bcompra\b[^.!?]{0,20}\bfeita\b/]),
  // payment-settled = an INBOUND payment was approved/settled. A REFUND confirmation
  // is the opposite money direction and must NOT justify a "pagamento aprovado"
  // claim (review finding 12) — it justifies only the `refund-done` class below.
  // Wider negation window (30) so honest-failure phrasings aren't mis-substituted.
  // BKL-176 — `payment.charge.confirm` was RETIRED (dead taxonomy); the sole
  // remaining justifier is the inbound `payment.cash.confirm`. Deliberately NOT
  // repointed onto `payment.status.reconcile`: that kind is direction-agnostic
  // (it also reconciles refunds), so admitting it would break `payment-settled`'s
  // refund-direction exclusion (CLAUDE.md). Both remaining justifiers are still
  // zero-emitter today, so a "pagamento confirmado" claim degrades to UNKNOWN
  // absent a real settle event — the intended anti-confabulation posture.
  claimClass("payment-settled", "pagamento", "aprov|confirm|realiz|efetu|conclu|liquid|quit", ["payment.cash.confirm"], [/\b(?:esta|ta|ja)\s+pago\b/, /\bpix\s+pago\b/, /\bpaguei\b/], 30),
  claimClass("order-canceled", "pedido", "cancel", ["order.cancel"], [/\bcancelamento\b[^.!?]{0,20}\b(?:realizad|efetuad|concluid)\w*/]),
  claimClass("cart-item-added", "carrinho", "adicion|inclu|atualiz", ["order.item.add", "order.item.update", "order.item.remove"], [/\bitem\b[^.!?]{0,15}\badicionad\w*/]),
  claimClass("refund-done", "reembolso", "process|emit|realiz|efetu|conclu|confirm|aprov", ["payment.refund.issue", "payment.refund.confirm"]),
  claimClass("note-added", String.raw`observac\w*`, "adicion", ["order.note.add"]),
  // BKL-194 — order.type.switch IS an order amendment ("pedido alterado para
  // retirada"), so it joins the justifier set (prevents a latent false-clamp of an
  // honest type-switch confirmation).
  claimClass("order-amended", "pedido", "alter|atualiz", ["order.amend.request", "order.amend.add_item", "order.amend.update_qty", "order.amend.remove_item", "order.type.switch"], [/\badicionad\w*\b[^.!?]{0,15}\bao pedido\b/, /\baltera\w*\b[^.!?]{0,22}\b(?:registrad|realizad)\w*/]),
  claimClass("reservation-confirmed", "reserva", "confirm|garant|realiz|efetu|conclu", ["reservation.create", "reservation.modify", "reservation.checkin", "reservation.complete"], [/\breserva\b[^.!?]{0,20}\bfeita\b/, /\bmesa\b[^.!?]{0,20}\b(?:reservad|garantid|confirmad)\w*/, /\bcheck-?in\b[^.!?]{0,15}\b(?:feito|confirmad|realizad)\w*/, /\b(?:agendad\w*|agendamento)\b[^.!?]{0,25}\b(?:confirmad|realizad|feito|concluid)\w*/]),
  // PIX code/QR generation — justified by a checkout (PIX) or a regenerate.
  { id: "pix-generated", claim: [/\b(?:codigo )?pix\b[^.!?]{0,18}\b(?:gerad|criad|criei|gerei)\w*/, /\bgerei\b[^.!?]{0,15}\bpix\b/], negated: [/\b(?:nao|nunca|jamais)\b[^.!?]{0,14}\b(?:gerad|criad|gerei)\w*/], justifiedBy: ["order.checkout.create", "payment.pix.regenerate"], noun: "pix" },
  // Fulfillment is NEVER performed by the chat responder — any such claim is unearned.
  { id: "fulfillment-claimed", claim: [/\b(?:a caminho|saiu pra entrega|saiu para entrega|em preparo|no preparo|mandei pro preparo|ja separei|esta sendo preparad|pronto pra retirar|pronto para retirar|pode (?:vir )?(?:retirar|buscar))\b/], negated: [/\bnao\b[^.!?]{0,10}\b(?:a caminho|saiu|pronto)\b/], justifiedBy: [] },
  // ── BKL-194 sweep additions (the taxonomy outgrew the original 11 classes) ──
  //
  // review-received — THE live false-success (session 9ff869ed): "Sua avaliação de
  // 5 estrelas…foi recebida e registrada" with ZERO order.review.submit rows.
  // RECEIPT-semantics: `receiptIsCompletion` disables the PENDING_STATUS exemption
  // ("recebid…" is this class's completion verb, not an in-flight status — the
  // exemption would swallow the exact live prose). The rating sense of "nota"
  // ("sua nota foi registrada") rides here via a `nota(?! fiscal)` extra so it can
  // never cross-match the fiscal class below. Wide 60-char extra: the live gap
  // between "avaliação" and its verb was exactly 40 chars (a longer displayId
  // would have slipped the builder's default window).
  {
    ...claimClass("review-received", String.raw`avaliac\w*`, "receb|registr|envi|grav|comput", ["order.review.submit"], [
      /\bavaliac\w*\b[^.!?]{0,60}\b(?:recebid|registrad|enviad|gravad|computad)\w*/,
      /\b(?:sua |a )?nota(?! fiscal)\b[^.!?]{0,25}\b(?:recebid|registrad|enviad|gravad|computad)\w*/,
      /\bobrigad[oa]\b[^.!?]{0,20}\bavaliac\w*/,
    ]),
    receiptIsCompletion: true,
  },
  // reservation-canceled — "sua reserva foi cancelada" (the order-canceled twin;
  // that class's noun guard is "pedido", so reservations were unguarded).
  claimClass("reservation-canceled", "reserva", "cancel", ["reservation.cancel"]),
  // coupon-applied — "cupom aplicado" / "desconto aplicado".
  claimClass("coupon-applied", "cupom", "aplic|ativ|adicion|resgat", ["order.coupon.apply"], [/\bdesconto\b[^.!?]{0,20}\baplicad\w*/]),
  // address-updated — "endereço atualizado/alterado/cadastrado/removido".
  claimClass("address-updated", String.raw`endereco\w*`, "atualiz|alter|salv|cadastr|adicion|remov", ["customer.address.add", "customer.address.remove", "order.address.change"]),
  // preferences-saved — "preferências atualizadas"; the irregular short participle
  // "salvas" (not "salvadas") needs the extra literal.
  claimClass("preferences-saved", "preferencias?", "salv|atualiz|registr|grav", ["customer.preferences.update"], [/\bpreferencias?\b[^.!?]{0,25}\bsalvas?\b/]),
  // payment-method-switched — "forma de pagamento alterada". Distinct from
  // payment-settled (different verb family; the full-phrase noun keeps the bare
  // "pagamento" classes from cross-matching).
  claimClass("payment-method-switched", "(?:forma|metodo|meio)s? de pagamento", "alter|troc|mud|atualiz", ["payment.method.switch"]),
  // fiscal-emitted — "nota fiscal emitida/gerada". SYSTEM-only kind: it can never
  // execute inside a chat turn, so in practice this is unearnable on the customer
  // plane (the honest justifier is listed for the day a read surfaces real state).
  claimClass("fiscal-emitted", "nota fiscal", "emit|ger", ["order.fiscal.emit"], [/\b(?:nfc-?e|nfe|danfe)\b[^.!?]{0,30}\b(?:emitid|gerad)\w*/]),
  // data-anonymized — LGPD: "seus dados foram apagados/anonimizados/excluídos".
  // A confabulated deletion promise is a privacy harm, not just UX.
  claimClass("data-anonymized", "dados", "apag|anonimiz|exclu|remov|delet", ["customer.anonymize"]),
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

/**
 * Whether the runtime ACCEPTED a scheduled-pickup order this turn (F6). True ONLY
 * when a checkout was DISPATCHED (`order.checkout.create` ∈ executedKinds — an
 * EXECUTE/REWRITE that actually ran, never a REFUSE/DEFER), the executor did NOT
 * REPORT failure (BKL-239), AND the checkout output flagged `scheduledPickup ===
 * true`. That flag is set ONLY for pickup (no deliveryCep) placed while closed, so a
 * delivery/immediate order accepted while closed (the kernel does NOT gate
 * closed-hours) is `accepted === false` and keeps the SAFE closed-hours degrade —
 * never a false pickup confirmation.
 *
 * BKL-239 — membership in `executedKinds` is DISPATCH MECHANICS, not a business
 * outcome: @claustrum's dispatcher decides `executed` vs `failed` purely on whether
 * `tool.execute` THREW (execution/dispatch.js — it never inspects the returned
 * value), and `createCheckout` RETURNS `success:false` rather than throwing on its
 * PIX legs (packages/tools/src/cart/create-checkout.ts:133 no QR data on the
 * confirmed PaymentIntent, :188 the catch-all that converts EVERY throw in
 * `confirmPixAndGetQrCode` into a returned failure) — and :611 spreads
 * `scheduledPickup` ONTO that failure (`{ ...pixResult, scheduledPickup }`). So a
 * FAILED closed-hours scheduled PIX checkout arrived here as fully `executed`
 * carrying `{ success:false, paymentMethod:"pix", scheduledPickup:true }` and voiced
 * `closedHoursScheduledConfirmation(..., true)` — telling a customer their order was
 * registered and only the PIX payment was outstanding when NOTHING was placed. The
 * same false-claim class BKL-230/BKL-247 killed on the action-render seam.
 *
 * Gated on `success !== false` — render UNLESS failure was REPORTED (the polarity
 * ratified in BKL-247): an absent/non-boolean `success` keeps today's behaviour, so
 * no committed fixture silently stops confirming. On THIS seam the two polarities
 * coincide on any real result anyway (`CheckoutResult.success` is a REQUIRED boolean
 * — create-checkout.ts:25 — and only `createCheckout` ever stamps `scheduledPickup`),
 * so `!== false` misses no real failure while keeping both seams uniform.
 *
 * `awaitingPixPayment` reflects the QR-first-then-confirm PIX flow: a scheduled PIX
 * pickup EXECUTEs + generates the QR but payment is still pending. (A re-entry while
 * a PIX is already pending is a kernel DEFER — the checkout does NOT run that turn,
 * so there is no `acted.result` and `accepted` is correctly false.)
 */
function acceptedScheduledPickup(
  acted: unknown,
): { accepted: boolean; awaitingPixPayment: boolean } {
  if (!executedKinds(acted).has("order.checkout.create")) {
    return { accepted: false, awaitingPixPayment: false };
  }
  const result = summarizeActed(acted)?.result as
    | { scheduledPickup?: unknown; paymentMethod?: unknown; success?: unknown }
    | undefined;
  // BKL-239 — the executor's OWN outcome gates the confirmation. A reported failure
  // falls through to `accepted:false`, i.e. the SAFE closed-hours degrade the
  // delivery/immediate path already takes (offer/disclosure), never a confirmation.
  const accepted = result?.success !== false && result?.scheduledPickup === true;
  return { accepted, awaitingPixPayment: accepted && result?.paymentMethod === "pix" };
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

/** The comma/colon-delimited clause of `sentence` containing offset `start`. Scoping a
 *  mood gate to ITS clause keeps a courtesy/pending clause elsewhere in the sentence
 *  from suppressing (or exempting) a claim in a DIFFERENT clause (review finding 5). */
function clauseAround(sentence: string, start: number): string {
  const before = Math.max(sentence.lastIndexOf(",", start), sentence.lastIndexOf(":", start));
  const afters = [sentence.indexOf(",", start), sentence.indexOf(":", start)].filter((i) => i >= 0);
  const after = afters.length > 0 ? Math.min(...afters) : sentence.length;
  return sentence.slice(before + 1, after);
}

/** Whether a matched success predicate is mood-exempt (future/conditional/pending)
 *  — but evaluated CLAUSE-LOCALLY (comma/colon-delimited), so a trailing courtesy
 *  clause ("…, se precisar de algo avise") no longer suppresses a completed claim
 *  in a DIFFERENT clause (review finding 5). A clause that asserts definite success
 *  ("…com sucesso") is never pending-exempt (finding 8). */
function claimIsMoodExempt(sentence: string, claimRe: RegExp, skipPending = false): boolean {
  const m = claimRe.exec(sentence);
  if (m === null) return false;
  const clause = clauseAround(sentence, m.index);
  if (FUTURE_OR_CONDITIONAL.test(clause) || FUTURE_OR_CONDITIONAL_SE.test(clause)) return true;
  // BKL-194 — receipt-semantics classes (`receiptIsCompletion`) skip the pending
  // exemption: "recebid…" is their completion verb, not an in-flight status.
  if (!skipPending && PENDING_STATUS.test(clause) && !DEFINITE_SUCCESS.test(clause)) return true;
  return false;
}

// "Not yet" pending markers for a NEGATED success. The forward PENDING_STATUS lexicon
// covers status nouns ("aguardando", "pendente"); a negated form more often carries a
// temporal "not done YET" adverb ("ainda não foi confirmado"). Kept separate so the
// forward-direction mood gate is byte-identical.
const NEGATED_PENDING_MARKER = /\b(?:ainda|por enquanto|neste momento|no momento)\b/;

/** Whether the NEGATED clause that matched is an HONEST "not done yet" / future /
 *  conditional report rather than a FALSE FAILURE — evaluated CLAUSE-LOCALLY (same
 *  scope as {@link claimIsMoodExempt}). Keeps a committed-but-still-settling action
 *  ("ainda não foi confirmado, aguardando o PIX") from being clamped, while a flat
 *  false failure whose only pending word sits in an unrelated trailing clause still is. */
function negatedClaimIsHonestPending(sentence: string, negatedRe: RegExp): boolean {
  if (claimIsMoodExempt(sentence, negatedRe)) return true;
  const m = negatedRe.exec(sentence);
  if (m === null) return false;
  return NEGATED_PENDING_MARKER.test(clauseAround(sentence, m.index));
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
    const negatedRe = cls.negated.find((re) => re.test(sentenceText));
    if (negatedRe !== undefined) {
      // F1b MIRROR (false-failure): a negated success form is normally an HONEST
      // failure and passes through — UNLESS the runtime actually COMMITTED a
      // justifying mutation this turn, the sentence names this class's domain noun,
      // AND the negated clause is not an honest "not yet"/future/conditional report.
      // Then it is a FALSE FAILURE (a committed action reported as not done — e.g.
      // "seu pedido não foi cancelado" after order.cancel EXECUTEd), as harmful as a
      // false success, so it is clamped too. The noun guard keeps a shared verb root
      // (e.g. "registr") from cross-flagging a different-noun honest failure; the mood
      // gate keeps a committed-but-still-settling PIX checkout ("ainda não foi
      // confirmado, aguardando o pagamento") from being clamped (mirrors the forward
      // direction's clause-local mood exemption).
      if (
        cls.justifiedBy.some((k) => executed.has(k)) &&
        (cls.noun === undefined ||
          new RegExp(String.raw`\b${cls.noun}\b`).test(sentenceText)) &&
        !negatedClaimIsHonestPending(sentenceText, negatedRe)
      ) {
        return `false-failure:${cls.id}`;
      }
      continue; // honest failure
    }
    // Find the specific claim pattern that matched so the mood gate can be scoped
    // to ITS clause (not the whole sentence) — a future/conditional/pending word
    // elsewhere in the sentence no longer blanket-suppresses a completed claim.
    const matched = cls.claim.find((re) => re.test(sentenceText));
    if (matched === undefined) continue;
    if (claimIsMoodExempt(sentenceText, matched, cls.receiptIsCompletion === true)) continue; // future/conditional(/pending) clause
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

// ── F6 (BKL-064): pt-BR-only output guard (Spanish leak) ──────────────────────
//
// The 4B occasionally answers in Spanish (a known nemotron failure — the model
// drifts to the nearest high-resource Romance language). Hard Rule #4: every
// customer-facing sentence is pt-BR only. The F1/F1b guards above are pt-BR
// lexicons, so a Spanish draft slips past them unclamped — this closes that gap.
//
// DELIBERATELY CONSERVATIVE (false-positive on valid pt-BR is worse than a
// missed leak): only two triggers, each chosen to never fire on Portuguese —
//   (1) Spanish inverted punctuation ¿ / ¡ — orthographically impossible in pt-BR;
//   (2) ≥2 distinct Spanish-EXCLUSIVE tokens — each word below is not a valid
//       Portuguese word AND does not collapse onto one after diacritic-stripping
//       (so "muy"≠"muito", "pero"≠"mas", "bien"≠"bem", "gracias"≠"obrigado";
//       "olá"/"também"/"aqui"/"como" are Portuguese and are intentionally absent).
// The ñ character (never pt-BR) counts as one token-signal. A single lone token
// is NOT enough (a proper noun / brand could be a fluke), so the bar is 2.
//
// On a hit the draft is clamped to a neutral pt-BR line that asserts NO domain
// fact (never leaks a Spanish success claim); the original stays forensically
// visible in the LLMTrace from completeWith().
export const PT_BR_LANGUAGE_FALLBACK_PTBR =
  "Desculpe, tive um problema ao gerar a resposta. Pode repetir, por favor?";

const SPANISH_EXCLUSIVE_PUNCT = /[¿¡]/;
const SPANISH_ONLY_TOKENS: ReadonlyArray<string> = [
  "gracias", "hola", "usted", "ustedes", "nosotros", "ellos", "ellas",
  "muy", "ahora", "pero", "bien", "buenos", "buenas", "espanol", "manana",
];

/** Returns a signal string (for telemetry) when the draft looks like Spanish, else null. */
export function replyLeaksSpanish(text: string): string | null {
  if (SPANISH_EXCLUSIVE_PUNCT.test(text)) return "spanish_punct";
  const hasEnye = /ñ/.test(text.toLowerCase());
  // Diacritic-strip + lowercase so "español"/"mañana" match despite accents/ñ.
  const normalized = normalizePtBr(text).replace(/ñ/g, "n");
  const hits = SPANISH_ONLY_TOKENS.filter((w) =>
    new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "u").test(normalized),
  );
  const signals = hits.length + (hasEnye ? 1 : 0);
  if (signals >= 2) return `spanish_tokens:${hits.join(",")}${hasEnye ? ",ñ" : ""}`;
  return null;
}

/** BKL-210 — pick the neutral fallback by OUTCOME: the audit-accurate
 *  "registrada" line ONLY when a mutation genuinely committed this turn (the
 *  contradiction-after-EXECUTE case, where a "couldn't do it" line would be a
 *  false FAILURE); otherwise the HONEST no-op line (nothing was registered, so
 *  claiming so is a false success — the injection / LGPD-noop case). */
function neutralFallbackFor(acted: unknown): string {
  return executedKinds(acted).size > 0
    ? GROUNDED_SAFE_FALLBACK_PTBR
    : NO_CAPABILITY_HONEST_FALLBACK_PTBR;
}

/** True when `text` is either neutral fallback — used by the closed-hours /
 *  rewrite guards to detect "the success guard already clobbered this draft",
 *  now that the clobber target is outcome-dependent (BKL-210). */
function isNeutralFallback(text: string): boolean {
  return text === GROUNDED_SAFE_FALLBACK_PTBR || text === NO_CAPABILITY_HONEST_FALLBACK_PTBR;
}

/** Apply the deterministic post-completion guards to a model-produced draft:
 *  substitute the neutral line (outcome-aware, BKL-210) if the reply makes a
 *  no-authority claim (F1) or claims a success the runtime did not grant (F1b).
 *  Preserves the draft's token usage so the loop's cost accounting stays correct.
 *  This is a FULL replacement (not `withText`): a confabulated draft's
 *  artifacts/meta are deliberately discarded — only the cost accounting (usage)
 *  survives. */
function guardDraft(draft: DraftResponse, acted: unknown): DraftResponse {
  if (
    groundedReplyContradicts(draft.text) !== null ||
    replyClaimsUnearnedSuccess(draft.text, acted) !== null
  ) {
    const fallback = neutralFallbackFor(acted);
    return draft.usage === undefined
      ? { text: fallback }
      : { text: fallback, usage: draft.usage };
  }
  // F6 (BKL-064): a Spanish-leaked draft slips past the pt-BR lexicons above —
  // clamp it to a neutral pt-BR line that asserts no domain fact.
  if (replyLeaksSpanish(draft.text) !== null) {
    return draft.usage === undefined
      ? { text: PT_BR_LANGUAGE_FALLBACK_PTBR }
      : { text: PT_BR_LANGUAGE_FALLBACK_PTBR, usage: draft.usage };
  }
  return draft;
}

/** SIGNAL-6: behavior-preserving observability wrapper over `guardDraft`. When
 *  the anti-confabulation guard SUBSTITUTES a model draft (the model tried to
 *  contradict the audited decision or claim an unearned success), emit a warn so
 *  the clamp — a load-bearing safety event that was previously silent — is
 *  visible + countable in VictoriaLogs. Returns exactly what `guardDraft` returns. */
function observedGuardDraft(
  draft: DraftResponse,
  acted: unknown,
  turnId: string | undefined,
): DraftResponse {
  const guarded = guardDraft(draft, acted);
  if (guarded.text !== draft.text) {
    let guard: string;
    const unearned = replyClaimsUnearnedSuccess(draft.text, acted);
    if (groundedReplyContradicts(draft.text) !== null) {
      guard = "contradiction";
    } else if (unearned !== null) {
      guard = unearned.startsWith("false-failure:")
        ? "false_failure"
        : "unearned_success";
    } else {
      guard = "spanish_leak";
    }
    logger.warn(
      {
        component: "responder",
        event: "success_guard.clamp",
        turnId,
        guard,
      },
      "success-guard clamped a model draft to the neutral fallback",
    );
  }
  return guarded;
}

/** ② Clamp a grounded draft that echoed a raw capability KIND id to the neutral,
 *  audit-accurate fallback (the internal identifier must never reach the customer —
 *  Hard Rule #9). Preserves token usage; emits a warn so the clamp is countable. */
function clampCapabilityIdLeak(
  draft: DraftResponse,
  turnId: string | undefined,
  acted: unknown,
): DraftResponse {
  logger.warn(
    { component: "responder", event: "success_guard.clamp", turnId, guard: "capability_id_leak" },
    "responder clamped a draft that echoed a raw capability id",
  );
  // BKL-210 — outcome-aware: the accurate "registrada" only if a mutation ran.
  const fallback = neutralFallbackFor(acted);
  return draft.usage === undefined
    ? { text: fallback }
    : { text: fallback, usage: draft.usage };
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
  scheduled: { accepted: boolean; awaitingPixPayment: boolean } = {
    accepted: false,
    awaitingPixPayment: false,
  },
): DraftResponse {
  const repaired = closedHoursBackstop(draft, signal);
  if (!signal?.isClosed) return repaired;

  // F6: a scheduled-pickup order was ACCEPTED this turn. Neither the backstop's OFFER
  // disclosure nor the neutral success-guard fallback acknowledges the order went
  // through — both read as "I can register your order", telling a customer whose
  // scheduled order WAS placed that it wasn't. Substitute a confirmation, but ONLY
  // when the draft was ACTUALLY clobbered (repaired by the backstop, or replaced with
  // the neutral fallback) — a clean scheduled-confirmation draft is left untouched.
  // `scheduled.accepted` is true ONLY for a proven scheduled PICKUP (never a
  // delivery/immediate order that also EXECUTEs while closed → those keep the degrade).
  const clobbered =
    repaired.text !== draft.text || isNeutralFallback(repaired.text);
  if (scheduled.accepted && clobbered) {
    const text = closedHoursScheduledConfirmation(signal, scheduled.awaitingPixPayment);
    return repaired.usage === undefined ? { text } : { text, usage: repaired.usage };
  }

  if (isNeutralFallback(repaired.text)) {
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
  if (isNeutralFallback(draft.text)) return draft;
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

// ── ⑦ Customer-plane ungrounded-MONEY clamp ──────────────────────────────────
//
// The ops digit-run clamp (clampUngroundedOpsFact / governGroundedOpsDraft) is wired
// ONLY on the ops plane (via the readAnswer deps), so a customer/WhatsApp draft got
// NO number guard — the 4B could volunteer an invented price. We add the customer-
// plane mirror, deliberately MONEY-ANCHORED (an R$ amount): money is where a
// fabricated figure actually harms a customer, and the `R$` prefix is unambiguous, so
// this never false-clamps an innocuous number. (Non-money ungrounded numbers on the
// customer plane remain a documented follow-up — they need a customer-domain-noun
// lexicon, not the ops one.) Demote-only; preserves usage.

/** Canonical digit token of every number in a text ("R$ 89,00" / centavos 8900 →
 *  "8900") so grounded amounts are not false-clamped by pt-BR money formatting. */
function moneyDigitTokens(text: string): string[] {
  return (text.match(/\d(?:[\d.,]*\d)?/g) ?? []).map((t) => t.replace(/\D/g, ""));
}

/** The digit forms an `R$` mention can ground against, tolerant of the reais⇄centavos
 *  representation gap: a whole-reais draft ("R$ 89") and the grounded integer-centavos
 *  amount (8900, Hard Rule #2) are the SAME value. Returns the as-written digit run AND
 *  its centavos-normalized form so EITHER grounds it — a correctly-abbreviated "R$ 89"
 *  reply is no longer false-clamped against a grounded 8900. `amount` is the text after
 *  the "r$" prefix (pt-BR: "." thousands, "," decimal). */
function moneyCanonicalForms(amount: string): string[] {
  const asWritten = amount.replace(/\D/g, "");
  if (asWritten.length === 0) return [];
  const forms = new Set<string>([asWritten]);
  const comma = amount.lastIndexOf(",");
  if (comma < 0) {
    // Whole-reais mention → centavos = reais × 100 ("R$ 89" ⇒ 8900).
    forms.add(`${asWritten}00`);
  } else {
    // Decimal mention → centavos = <inteiros><2 casas> ("R$ 1.234,5" ⇒ 123450).
    const intPart = amount.slice(0, comma).replace(/\D/g, "");
    const frac = `${amount.slice(comma + 1).replace(/\D/g, "")}00`.slice(0, 2);
    const centavos = `${intPart}${frac}`.replace(/^0+(?=\d)/, "");
    if (centavos.length > 0) forms.add(centavos);
  }
  return [...forms];
}

/** TRUE iff the draft states an R$ money amount whose value is not grounded in any
 *  allowed source (the user's own message, the acted/context summary, the schedule
 *  note) — an invented price the responder must not volunteer to a customer. Compares
 *  reais⇄centavos-tolerantly (via moneyCanonicalForms) so a correctly-abbreviated
 *  grounded amount ("R$ 89" against a grounded 8900) is NOT false-clamped. */
export function statesUngroundedMoney(
  text: string,
  allowedSources: readonly string[],
): boolean {
  if (typeof text !== "string") return false;
  const allowed = new Set<string>();
  for (const s of allowedSources) {
    if (typeof s === "string") for (const t of moneyDigitTokens(s)) allowed.add(t);
  }
  const amounts = normalizePtBr(text).match(/r\$\s*\d[\d.,]*/g) ?? [];
  for (const amt of amounts) {
    const forms = moneyCanonicalForms(amt.replace(/^r\$\s*/, ""));
    if (forms.length > 0 && !forms.some((f) => allowed.has(f))) return true;
  }
  return false;
}

/** Neutral, customer-facing line substituted when a draft states an ungrounded R$
 *  amount — asserts NO figure, offers to confirm. */
export const CUSTOMER_UNGROUNDED_MONEY_FALLBACK_PTBR =
  "Prefiro confirmar esse valor antes de te passar um número. Posso verificar para você?";

/** Wire Truth — the REFUSE-recovery success lexicon. On a kernel-refused plan
 *  NOTHING executed, so a completion assertion is a false success even when it
 *  names no customer-domain noun — the 11-class mirror (customer-plane-tuned,
 *  noun-anchored) deliberately does not catch it. Review-hardened: bare
 *  done-words PLUS the ops action verbs (past/participle), with the negation
 *  exemption scoped to a WINDOW directly before the match ("não foi alterado"
 *  passes; "entendi, não posso — mas alterei o horário" is still clamped),
 *  not sentence-wide — a sentence-wide `não` was a bypass. A false positive
 *  merely degrades to the deterministic refusal line, so the lexicon errs
 *  broad. */
const REFUSAL_RECOVERY_SUCCESS_RE =
  /\b(feito|prontinho|pronto|resolvido|concluid[oa]|executad[oa]|alterad[oa]|atualizad[oa]|marcad[oa]|registrad[oa]|cadastrad[oa]|removid[oa]|apliquei|alterei|atualizei|marquei|registrei|executei|cadastrei|removi|fiz)\b/g;

export function refusalRecoveryClaimsSuccess(text: string): boolean {
  if (typeof text !== "string") return false;
  for (const sent of sentencesOf(normalizePtBr(text))) {
    if (sent.question) continue;
    const re = new RegExp(REFUSAL_RECOVERY_SUCCESS_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(sent.text)) !== null) {
      const before = sent.text.slice(Math.max(0, m.index - 24), m.index);
      if (/\b(nao|nem|sem)\b/.test(before)) continue; // negated → honest report
      return true;
    }
  }
  return false;
}

export function createIbatexasResponder(
  deps: IbatexasResponderDeps,
): ResponderPort {
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;

  /** Compose the system for a model-call branch; falls back to the static
   * persona when no composer is wired. Returns the (possibly empty) manifest.
   * `override` (NEW-032) is an injected per-branch persona that WINS over BOTH
   * the composer and the fallback — the ops plane supplies its own staff-facing
   * system. Absent → the pre-NEW-032 path exactly (byte-identical). */
  async function composeSystem(
    surface: string,
    fallback: string,
    cognition: unknown,
    capabilities: ReadonlyArray<string>,
    override?: string,
    overrideId?: string,
  ): Promise<{ system: string; fragmentManifest: ReadonlyArray<string> }> {
    if (override !== undefined) {
      // Wire Truth — a persona override carries its catalog id (when provided)
      // as a single-tag manifest, so ops trace rows name their persona.
      return { system: override, fragmentManifest: overrideId === undefined ? [] : [overrideId] };
    }
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
    /** Wire Truth — branches with a good deterministic fallback (the REFUSE
     *  recovery) pass 1: an empty completion there should fall back, not burn
     *  2 more full model calls (the F6 retry exists because the CUSTOMER
     *  fallback ghosts; the refusal line does not). */
    maxAttempts?: number;
  }): Promise<DraftResponse> {
    const startedAt = Date.now();
    // F6 (BKL-031): regenerate-on-empty — a single empty 4B completion ghosts
    // the customer. Retry (bounded, jittered) until non-empty; the last (empty)
    // completion still returns so the holding-message fallback fires.
    const { completion, attempts, recovered } = await completeWithEmptyRetry(
      () =>
        deps.model.complete({
          model: deps.modelId,
          maxTokens,
          system: args.system,
          messages: [{ role: "user", content: args.userText }],
          // FE-T01 (D3) — pin temperature so the synthesis completion is
          // deterministic on the wire instead of falling to Ollama's ~0.8
          // default (temperature was never sent before this).
          temperature: PINNED_COMPLETION_TEMPERATURE,
        }),
      { maxAttempts: args.maxAttempts ?? EMPTY_COMPLETION_MAX_ATTEMPTS },
    );
    const durationMs = Date.now() - startedAt;
    if (attempts > 1) {
      logger.warn(
        { component: "responder", event: "empty_completion_retry", turnId: args.turnId, attempts, recovered },
        recovered
          ? "responder recovered from an empty completion after retry"
          : "responder exhausted empty-completion retries — holding fallback applies",
      );
    }

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
        // FE-T01 — the SAME constant passed to `deps.model.complete()` above.
        temperature: PINNED_COMPLETION_TEMPERATURE,
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

  /** BKL-100 — demote-only ungrounded-fact clamp for the conversational fallback.
   *  Runs only when the ops-plane `readAnswer.clampUngrounded` dep is present AND
   *  the draft states a domain number it could not have grounded (no read was
   *  captured this turn — else `render` short-circuited before any model call). It
   *  REPLACES the draft with the honest nudge (preserving usage for cost
   *  accounting); it never promotes. Absent dep → the draft is returned unchanged
   *  (customer / WhatsApp planes are byte-identical). */
  function clampUngroundedConversational(
    draft: DraftResponse,
    allowedSources: readonly string[],
  ): DraftResponse {
    const clamp = deps.readAnswer?.clampUngrounded;
    // Ops plane (dep present): the full digit-run clamp. Customer/WhatsApp plane (dep
    // absent, ⑦): the money-anchored clamp — an invented R$ amount must not ship.
    const nudge =
      clamp !== undefined
        ? clamp(draft.text, allowedSources)
        : statesUngroundedMoney(draft.text, allowedSources)
          ? CUSTOMER_UNGROUNDED_MONEY_FALLBACK_PTBR
          : null;
    if (nudge === null) return draft;
    return draft.usage === undefined
      ? { text: nudge }
      : { text: nudge, usage: draft.usage };
  }

  /** Adversarial-review fix — apply `readAnswer.governGrounded` (ops plane only)
   *  to a grounded draft; absent dep → the draft is returned unchanged (customer /
   *  WhatsApp planes byte-identical). */
  function governGroundedDraft(
    draft: DraftResponse,
    turnId: string,
    allowedSources: readonly string[],
  ): DraftResponse {
    const govern = deps.readAnswer?.governGrounded;
    if (govern !== undefined) {
      const governed = govern(draft.text, turnId, allowedSources); // ops plane
      if (governed === draft.text) return draft;
      return draft.usage === undefined
        ? { text: governed }
        : { text: governed, usage: draft.usage };
    }
    // Customer/WhatsApp plane (⑦): no captured-read render to append, but still clamp
    // an ungrounded model-authored R$ amount against the grounded sources.
    if (!statesUngroundedMoney(draft.text, allowedSources)) return draft;
    return draft.usage === undefined
      ? { text: CUSTOMER_UNGROUNDED_MONEY_FALLBACK_PTBR }
      : { text: CUSTOMER_UNGROUNDED_MONEY_FALLBACK_PTBR, usage: draft.usage };
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
      const closedNote = closedHoursPromptNote(scheduleSignal, userText);
      // F6: did the runtime accept a scheduled-pickup order this turn? Drives the
      // closed-hours delivery guard's confirmation-vs-offer branch. Empty on the
      // REFUSE/DEFER/no-checkout paths (executedKinds is empty there).
      const scheduled = acceptedScheduledPickup(input.acted);

      switch (decision.kind) {
        case "REFUSE": {
          // A REFUSE on an EMPTY plan is the "nothing to authorize" sentinel
          // (small-talk / informational turn) — reply conversationally.
          if (input.plan.envelopes.length === 0) {
            // BKL-100: on the ops plane, a staff read captured this turn renders
            // the answer DETERMINISTICALLY from the actual read result — no model
            // call, so a read answer can never be an authored number. Absent dep
            // (customer / WhatsApp) or no read captured → undefined → the normal
            // conversational completion below.
            const rendered = deps.readAnswer?.render(turnId);
            if (rendered !== undefined) {
              return { text: rendered };
            }
            // ── LE2-022 · the WORKFLOW FEASIBILITY notice ─────────────────────
            // The planner refused a selected workflow before minting its anchor
            // envelope, so this turn is a REFUSE on an empty plan carrying an
            // AUTHORED pt-BR reason. Return it verbatim, with no model call: the
            // reason is read off a grounded projection the model never saw, so a
            // completion here could only paraphrase or invent it.
            //
            // FIRST among the template branches because it is the most SPECIFIC
            // fact about this turn — the customer asked for a named route and
            // there is an authored sentence about that route. The overlap with
            // L0 below is empty in practice (an L0 turn short-circuits before
            // the model call, so it can select no workflow), which makes this a
            // statement of precedence rather than a live contest.
            const workflowNotice = deps.workflowNotice?.(turnId);
            if (workflowNotice !== undefined) {
              return { text: workflowNotice };
            }
            // ── LE2-007 · L0 · the template reply, zero model calls ────────────
            // The planner stamped this turn L0 (a social-only utterance, no confirm
            // window) and skipped its extraction completion; the claim path skipped
            // its own, so nothing validated and loop §6a cannot supersede this text.
            // Render the deterministic pt-BR template and return — this is the third
            // and last completion the tier removes.
            //
            // PLACEMENT: after the deterministic read render (a captured first-party
            // read is strictly more informative than a template, and on an L0 turn
            // there is none — so this ordering is a no-op today and the right
            // precedence tomorrow), and BEFORE the SAFE_UNKNOWN gate + the raw-prose
            // branch, which are the two model-facing paths this replaces.
            //
            // GUARDS: the text is a compile-time constant pinned by tests, not model
            // output, so the model-text guards (`observedGuardDraft`'s unearned-success
            // net, `clampUngroundedConversational`'s money clamp) have nothing to
            // police — the template states no success and carries no digits. The
            // closed-hours guard DOES run: it is the one guard that reads the
            // STRUCTURED schedule signal rather than the draft's provenance, and
            // running it makes "closed-hours behaviour preserved exactly" true BY
            // CONSTRUCTION instead of by omission (the template asserts nothing about
            // open/closed, so `closedHoursBackstop` is a proven no-op and the reply is
            // byte-identical open or closed — pinned in the L0 e2e suite).
            const funnelStage = deps.funnel?.stageFor(turnId);
            const funnelReply =
              funnelStage === undefined ? undefined : deps.funnel?.reply(funnelStage);
            if (funnelReply !== undefined) {
              return closedHoursDeliveryGuard(
                { text: funnelReply },
                scheduleSignal,
                scheduled,
              );
            }
            // BKL-078 — the QUESTION-SHAPE gate (BOTH planes since LE2 decision 6;
            // on the ops plane the deterministic `readAnswer.render` above still runs
            // FIRST, so this is reached only when NO staff read was captured either).
            // This branch is the
            // `prose_preserved` seam: it is reached only when NO claim survived to
            // render (runClaimsValidate returned undefined ⟺ empty candidate set, so
            // handle-turn §6a cannot supersede this text — see the PR body's BKL-111
            // cite). On a NON-smalltalk info-question that produced no validated
            // claim, the model draft below can ship a delivered falsehood (tonight's
            // two live lies). When the gate fires we return the deterministic,
            // proposition-free SAFE_UNKNOWN text BEFORE any model call — guaranteeing
            // no prose leaks — and emit ONE PII-free `claims.terminal` (posture
            // safe_degraded). SOUNDNESS-MONOTONIC: it only moves a turn
            // prose→SAFE_UNKNOWN, never the reverse, and never touches the render or
            // claim-proposal paths. Absent dep (flag-OFF) → this whole block is
            // skipped → byte-identical to the model completion below.
            if (deps.safeUnknown?.gate(userText) === true) {
              logger.info(
                {
                  component: "claims",
                  event: "claims.terminal",
                  turnId,
                  posture: "safe_degraded",
                  reason: "ungrounded_question",
                },
                "claims terminal finalized (safe-degraded — ungrounded question shape)",
              );
              return { text: deps.safeUnknown.render(scheduleSignal, userText) };
            }
            // ── THE SURVIVING RAW-PROSE BRANCH (LE2-013) ────────────────────────
            // Everything below this line is model-authored text that reaches a user
            // without passing the three-valued claims gate — which CLAUDE.SDD.md §R
            // lists as a hard compile error ("any pathway where a plain string
            // reaches a (mock) user WITHOUT passing the three-valued Claims gate and
            // the renderer-from-claims"). LE2 Implementation Decision 6 deliberately
            // KEEPS it, for small talk: "raw prose survives only for small talk"
            // (and user story 23 — governance must never make the assistant stilted).
            // The two are in STANDING CONFLICT and this code does not resolve it.
            //
            // What LE2-013 did is NARROW it, and the narrowing is the whole ticket:
            //   · on the OPS plane the gate above is `!isSmalltalkOnly`
            //     (SafeUnknownGateOptions.retireRawProse), so the ONLY way to reach
            //     this branch is a message whose every token is in the CLOSED phatic
            //     lexicon — a set that asserts no world fact by construction;
            //   · on the CUSTOMER plane the gate is still the positive
            //     info-question net, so this branch is still reachable by an
            //     unrecognised info-bearing turn. That residual is NOT this ticket's
            //     to close (LE2-013 is ops-scoped) and is left visible on purpose.
            // Reconciling the remainder — does small talk itself become a claims
            // terminal, or does §R take an explicit smalltalk carve-out? — is the
            // OWNER's call. Do not silently resolve it here.
            //
            // Defense beneath the gate (belt-and-suspenders, retained not promoted):
            // `clampUngroundedConversational` below still demotes an ungrounded
            // domain number the model authored even on a smalltalk turn.
            const { system: base, fragmentManifest } = await composeSystem(
              RESPONDER_CONVERSATIONAL_SURFACE,
              RESPONDER_PERSONA_PTBR,
              input.cognition,
              [],
              deps.personas?.conversational,
              deps.personaIds?.conversational,
            );
            const system = base + closedNote;
            return clampUngroundedConversational(
              closedHoursDeliveryGuard(
                observedGuardDraft(
                  await completeWith({ system, fragmentManifest, userText, turnId }),
                  input.acted,
                  turnId,
                ),
                scheduleSignal,
                scheduled,
              ),
              // Numbers the model legitimately saw: the staff's own message + the
              // schedule note (echoing them back must not nudge).
              [userText, closedNote],
            );
          }
          // Wire Truth — ops-plane conversational recovery: a refused PROPOSED
          // command (often a planner misparse — an hours QUESTION planned as a
          // schedule-override WRITE, BKL-233) still deserves a reply to the
          // operator's actual message. Review-hardened posture:
          //  - SECURITY *and* AUTH refusals stay model-free: tamper lines and
          //    the deliberately role-OPAQUE permission copy must render
          //    verbatim, never be paraphrased by the 4B.
          //  - The prompt carries the EXPLAINER-rendered line (locale registry
          //    + the ops staff overlay), never the raw userFacing, and never
          //    an internal capability kind (Hard Rule #9).
          //  - ONE attempt, no empty-retry (the deterministic refusal line is
          //    a good fallback — unlike the customer plane, nothing ghosts).
          //  - If ANY guard rewrote the draft, or it claims success, or the
          //    synthesis throws or returns empty → the deterministic line.
          //    A guard substitution here would ship customer-voiced copy to
          //    staff (the no-authority clamp's truth anchor does not hold on
          //    a REFUSE turn), so a rewrite means fallback, not substitution.
          const explained = deps.explainer.render(decision.refusal);
          if (
            deps.conversationalRefusal === true &&
            decision.refusal.kind !== "SECURITY" &&
            decision.refusal.kind !== "AUTH"
          ) {
            // ── BKL-262 STAGE 2 · GROUNDED RECOVERY (owner ruling: option (c)) ──
            //
            // This branch used to SYNTHESISE the recovery reply with the model,
            // gated only by the false-SUCCESS lexicon below. That gate is a
            // LEXICON, so it catches "pronto, alterei" and lets a fabricated
            // statement of FACT through clean — which is exactly how "Funcionamos
            // todos os dias das 10h às 22h!" and a false coverage denial reached
            // operators (BKL-262's two live proofs). Stage 1 fixed the RANKING for
            // the write-twin case; everything that still falls through to here —
            // an un-twinned refused kind, a twin whose read span never fired, a
            // turn whose claims degraded to UNKNOWN, and the genuine refused
            // MUTATION — was still answered by model prose.
            //
            // The recovery reply is now COMPOSED, never authored. There is no
            // model call on this path at all, so "Store closes at 10 PM" cannot
            // appear unless a real read produced it:
            //
            //   1. `explained` — the deterministic, single-sourced pt-BR refusal,
            //      ALWAYS first. It is the load-bearing sentence: the action did
            //      NOT happen, and the operator must be told that before anything
            //      else. This is also why the composition can never mask a real
            //      refusal the way an unguarded validated render would.
            //   2. The BKL-100 deterministic READ render for this turn, when a
            //      staff read was actually captured — grounded in the read RESULT,
            //      no model call and no authored number. This is the "renders only
            //      validated facts" half.
            //   3. Otherwise, when the turn was question-SHAPED, the proposition-
            //      free epistemic self-report (the BKL-184 abstain+offer shape,
            //      the SAME `safeUnknown` seam the empty-plan branch above uses).
            //      It asserts nothing about the world.
            //
            // A turn with none of the above simply gets the refusal alone, which
            // is itself an honest self-report.
            //
            // SECURITY/AUTH are untouched above and still skip this entirely —
            // tamper lines and the role-OPAQUE permission copy render verbatim.
            const recovery: string[] = [explained];
            const groundedRead = deps.readAnswer?.render(turnId);
            if (groundedRead !== undefined) {
              recovery.push(groundedRead);
            } else if (
              // The abstention answers a QUESTION. On a MUTATION-shaped turn the
              // operator asked for an ACTION, so "não localizei essa informação"
              // answers something nobody asked and reads as a non-sequitur — the
              // refusal alone is already the complete, honest reply.
              //
              // This guard is REQUIRED rather than implied by the safe-unknown gate:
              // since LE2-013 that gate is the COMPLEMENT OF SMALL TALK, so it fires
              // on "fecha a loja amanhã" just as readily as on a real question. The
              // net reused here is the SAME `hasMutationImperative` the BKL-262
              // Stage-1 write-twin rescue turns on, so the two stages classify turn
              // shape identically instead of drifting apart.
              !hasMutationImperative(userText) &&
              deps.safeUnknown?.gate(userText) === true
            ) {
              recovery.push(deps.safeUnknown.render(scheduleSignal, userText));
            }
            const composed = recovery.join("\n\n");
            // The lexicon SURVIVES — repurposed from a gate on model prose into a
            // fail-closed TRIPWIRE on deterministic copy. Nothing here is model
            // output, so it should never fire; if it ever does, an authored refusal
            // string or a render template has drifted into claiming the refused
            // action succeeded, and the narrowest honest reply is the bare refusal.
            // Keeping it costs one regex on a rare path and removing it would delete
            // the only assertion that this composition never states a false success.
            if (refusalRecoveryClaimsSuccess(composed)) {
              logger.warn(
                {
                  component: "responder",
                  event: "success_guard.clamp",
                  turnId,
                  guard: "refusal_recovery_composed",
                },
                "composed refusal recovery claims success — deterministic refusal line applies",
              );
              return { text: explained };
            }
            return { text: composed };
          }
          // A real action refusal: render the pt-BR refusal VERBATIM (model-free,
          // single-sourced, SECURITY-safe). This is the bug fix — and the
          // fallback for every recovery degradation above.
          return { text: explained };
        }

        case "REQUEST_CONFIRMATION": {
          // LE2-021 — a WORKFLOW confirm is the whole-workflow question, and its
          // authored template is the only place that framing exists. Absent the
          // dep, or on any turn that selected no workflow, this is `undefined`
          // and the branch is byte-identical to what it always was.
          //
          // The template QUOTES the kernel's own sentence through
          // `{confirmation}` and may only ADD framing around it — see the
          // workflow corpus's authoring rule — so this never replaces the
          // grounded question, it surrounds it. And `renderConfirm` returns
          // `undefined` rather than render a template with an unresolved param,
          // so a literal `{placeholder}` can never reach a customer here.
          const authored = deps.workflowConfirm?.(turnId);
          // The guard already authored the confirm question; surface it verbatim.
          return { text: authored ?? decision.prompt };
        }

        case "ESCALATE":
          return {
            text:
              deps.personas?.escalate ??
              resolvePrompt("ibatexas/responder.escalate", RESPONDER_ESCALATE_PTBR),
          };

        case "EXECUTE":
        case "REWRITE":
        case "DEFER": {
          // BKL-149 — on the ops plane, a COMMITTED mutation's reply states WHAT
          // THE VERB DID DETERMINISTICALLY, rendered from the adjudicated envelope
          // (kind + resolved payload) + dispatch result — the model NEVER authors
          // the fact of the mutation (the exact 377ca7a1 falsehood class: a store
          // CLOSED tomorrow drew a model reply asserting the store was OPEN today).
          // Returns undefined when nothing committed (deferred / failed dispatch) →
          // the existing grounded model path below handles it honestly. Absent dep
          // (customer / WhatsApp) → undefined → byte-identical to today.
          const actionRendered = deps.readAnswer?.renderAction?.(
            input.acted,
            turnId,
          );
          if (actionRendered !== undefined) {
            return { text: actionRendered };
          }
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
            deps.personas?.grounded,
            deps.personaIds?.grounded,
          );
          // ② capability-id leak: the model-visible grounding context must NOT carry
          // raw internal capability KIND strings — the weak 4B parrots them into the
          // customer reply (Hard Rule #9). Serialize a customer-safe view (decision
          // kind + acted result/status, raw kinds stripped). `capabilities` is still
          // passed to composeSystem (its per-capability fragments are gated) but is NO
          // LONGER serialized into the prompt JSON.
          const context = {
            decision: decision.kind,
            acted: redactActedForPrompt(summarizeActed(input.acted)),
          };
          const system =
            `${baseSystem}\n\n` +
            `CONTEXTO DA DECISÃO (fonte da verdade, não inventar):\n` +
            JSON.stringify(context) +
            closedNote;
          const rawDraft = await completeWith({
            system,
            fragmentManifest,
            userText,
            turnId,
            ...(intentHash === undefined ? {} : { intentHash }),
          });
          // ② defense-in-depth: if the model still echoed a raw capability id, clamp
          // it to the neutral fallback before it can reach the customer.
          const draft = draftLeaksCapabilityId(rawDraft.text, capabilities)
            ? clampCapabilityIdLeak(rawDraft, turnId, input.acted)
            : rawDraft;
          // F1 + F1b: post-completion guards. The grounded prompt is only a soft
          // instruction — never let a model reply that contradicts the audited
          // decision (no-authority claim) OR claims a success the runtime did not
          // grant (confabulation) reach the customer. Then surface any user-relevant
          // REWRITE clamp deterministically (the model can't be trusted to).
          // BKL-100 (adversarial-review fix): on the ops plane, governGroundedDraft
          // then appends the deterministic render of any read captured this turn
          // (the read half of a mixed read+act turn) and digit-run clamps model
          // numbers not grounded in the acted summary / staff message / schedule
          // note. Dep absent (customer / WhatsApp) → byte-identical.
          return governGroundedDraft(
            closedHoursDeliveryGuard(
              surfaceRewriteClamp(observedGuardDraft(draft, input.acted, turnId), decision),
              scheduleSignal,
              scheduled,
            ),
            turnId,
            // The acted summary is what the model was PROMPTED with (the grounded
            // source of truth) — serialize it the same way the prompt does so its
            // digit runs (e.g. a real refund amount) are allowed verbatim.
            [userText, JSON.stringify(context), closedNote],
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
            deps.personas?.conversational,
            deps.personaIds?.conversational,
          );
          const system = base + closedNote;
          return clampUngroundedConversational(
            closedHoursDeliveryGuard(
              observedGuardDraft(
                await completeWith({ system, fragmentManifest, userText, turnId }),
                input.acted,
                turnId,
              ),
              scheduleSignal,
              scheduled,
            ),
            [userText, closedNote],
          );
        }
      }
    },
  };
}
