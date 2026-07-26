// funnel-tier.ts — the LE2 parse funnel's FIRST tier (L0) and the tier-attribution
// contract every later tier reuses (LE2-007; spec §"P1 — funnel", Implementation
// Decision 8).
//
// THE PROBLEM L0 CLOSES (spec §Problem Statement #1, "the greeting problem"): "Oi"
// costs a full planner prompt against the whole capability roster, then a claim-planner
// prompt, then a synthesis prompt — three model calls, maximum price for the minimum
// question. L0 answers a social-ONLY utterance from a deterministic pt-BR template with
// ZERO model calls on the wire.
//
// ── THE TWO SECTIONS OF THIS FILE (the claims-render-precedence idiom) ───────────
//   1. PURE CORE — the closed lexicon, the social classifier, the L0 decision and the
//      templates. No clock, no IO, no logging, no global state; unit-testable alone.
//   2. THE PER-TURN SEAM — the turnId-keyed stage store + `createL0Funnel()`, the
//      stateful object the planner / responder / telemetry consume. This half owns
//      the process state and the one structured log line.
//
// ── WHY THE LEXICON IS NOT `isSmalltalkOnly` (owner decision 8) ──────────────────
// L0 is social-ONLY: greetings, thanks, farewells. `isSmalltalkOnly`
// (interrogative-discriminator.ts) is a deliberately WIDER phatic set that also holds
// the AFFIRMATION family ("ok", "sim", "certo", "isso", "beleza", "combinado") because
// over-inclusion is SAFE there — it only ever KEEPS a turn on the (clamped) prose path
// for a DEMOTE-ONLY gate. Here the direction is inverted: a match SUPERSEDES the model,
// so over-inclusion would answer a real turn with a template. An affirmative is
// therefore excluded BY CONSTRUCTION — it is the confirm-window's vocabulary
// (FE-D32/BKL-212: a bare "ok" on a parked confirmation restates the park; a "sim"
// resumes it), never L0's. The two lexicons are pinned against each other by a census
// test (`__tests__/funnel-tier.test.ts`) that enumerates BOTH deltas, so neither can
// drift into the other silently. `normalize` is IMPORTED, not re-implemented, so the
// two nets can never disagree on diacritics.
//
// CLOSED, DETERMINISTIC, NO FUZZY MATCHING (owner decision): exact tokens and exact
// multiword phrases only — no similarity, no edit distance, no stemming. An
// unrecognised social form ("oii", "bom-dia") falls through to the normal parse, which
// is the SAFE failure direction: L0 never guesses, it only recognises.
//
// MIXED UTTERANCES FALL THROUGH: any information-bearing residual token ("oi, vocês
// entregam?" → "voces", "entregam") makes the utterance non-social, so it parses
// normally. That is the whole of AC #2.

import type { CognitiveState } from "@claustrum/core";
import { logger } from "../lib/logger.js";
import { normalize } from "./interrogative-discriminator.js";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PURE CORE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Which funnel tier RESOLVED a turn — the trace's tier attribution (spec: "every turn
 * stamped with its catalog version and funnel-tier attribution").
 *
 * `L1` (byte-identical repeat → memoized parse) and `L2` (parse scoped to K plausible
 * capabilities) are DECLARED here but never emitted yet: they are their own tickets.
 * Declaring them is the extensibility this ticket owes them — a later tier adds its
 * member and its {@link FunnelStageRecord} detail keys, and every consumer (the
 * planner short-circuit, the responder, the per-turn telemetry stamp) keeps working
 * because none of them switches on the tier value.
 */
export type FunnelTier = "L0" | "L1" | "L2";

/**
 * WHY a tier claimed the turn — the machine-stable join field for the trace. Only the
 * L0 member exists today; L1/L2 append their own ("memoized_parse", "scoped_parse",
 * "full_roster_fallback") when they land.
 */
export type FunnelReason = "social_only";

/**
 * The funnel's OBSERVABILITY CONTRACT — one stage record per funnel-resolved turn
 * (spec §Testing Decisions: "Trace stage records are the funnel's observability
 * contract: tier attribution, cache hits, retriever selections … are asserted by
 * reading the trace").
 *
 * `detail` is the tier-specific, BOUNDED extension point: L0 records the social kind;
 * L1 will record its cache key/hit; L2 its retrieved capability set and confidence.
 * Scalars only, so the record stays cheap to log and safe to persist verbatim.
 */
export interface FunnelStageRecord {
  readonly tier: FunnelTier;
  readonly reason: FunnelReason;
  readonly detail: Readonly<Record<string, string | number>>;
  /** ISO instant the tier claimed the turn. */
  readonly at: string;
}

/** The three social speech acts L0 answers. Nothing else is social. */
export type SocialKind = "greeting" | "thanks" | "farewell";

/** Word-token extractor over a normalized string (ASCII words only, post-strip).
 *  Mirrors the interrogative-discriminator's own `WORD_TOKEN`; `String.match` with a
 *  /g regex is stateless, so sharing one instance is safe. */
const WORD_TOKEN = /[a-z0-9]+/g;

/**
 * Multiword social phrases, consumed (replaced by a space) BEFORE tokenizing so a
 * phrase leaves no stray content-looking token, and CONTRIBUTING their kind (an
 * "até logo" is a farewell even though neither word is a farewell token on its own).
 * `\s+` between words tolerates extra spacing; `\b` anchors keep them word-exact.
 *
 * "boa noite" is deliberately a GREETING: it is overwhelmingly an opening in a
 * restaurant chat, and when it genuinely closes a conversation it is paired with a
 * farewell token ("boa noite, tchau"), which the precedence below resolves correctly.
 */
const SOCIAL_PHRASES: ReadonlyArray<{ readonly re: RegExp; readonly kind: SocialKind }> =
  (
    [
      ["bom dia", "greeting"],
      ["boa tarde", "greeting"],
      ["boa noite", "greeting"],
      ["boa madrugada", "greeting"],
      ["tudo bem", "greeting"],
      ["tudo bom", "greeting"],
      ["tudo certo", "greeting"],
      ["tudo joia", "greeting"],
      ["tudo tranquilo", "greeting"],
      ["como vai", "greeting"],
      ["e ai", "greeting"],
      ["fala ai", "greeting"],
      ["ate logo", "farewell"],
      ["ate mais", "farewell"],
      ["ate breve", "farewell"],
      ["ate amanha", "farewell"],
      ["ate a proxima", "farewell"],
      ["bom fim de semana", "farewell"],
    ] as ReadonlyArray<readonly [string, SocialKind]>
  ).map(([phrase, kind]) => ({
    re: new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "g"),
    kind,
  }));

/**
 * The CLOSED social token lexicon: token → the speech act it carries. Every token here
 * is unambiguously social ON ITS OWN, because a token that also has a content reading
 * ("ate" as the preposition "até 20 reais", "fala" as the imperative "fala o preço")
 * can only reach this net when it is the WHOLE utterance — any content reading brings
 * residual content tokens with it, which fails the social-only test below.
 */
const SOCIAL_TOKENS: ReadonlyMap<string, SocialKind> = new Map<string, SocialKind>([
  // ── greetings ──
  ["oi", "greeting"],
  ["ola", "greeting"],
  ["opa", "greeting"],
  ["alo", "greeting"],
  ["eae", "greeting"],
  ["eai", "greeting"],
  ["fala", "greeting"],
  // ── thanks ──
  ["obrigado", "thanks"],
  ["obrigada", "thanks"],
  ["obrigadao", "thanks"],
  ["obg", "thanks"],
  ["obgd", "thanks"],
  ["brigado", "thanks"],
  ["brigada", "thanks"],
  ["valeu", "thanks"],
  ["vlw", "thanks"],
  ["grato", "thanks"],
  ["grata", "thanks"],
  // ── farewells ──
  ["tchau", "farewell"],
  ["tchauzinho", "farewell"],
  ["xau", "farewell"],
  ["ate", "farewell"],
  ["adeus", "farewell"],
  ["falou", "farewell"],
  ["flw", "farewell"],
  ["abraco", "farewell"],
  ["abracos", "farewell"],
  ["tmj", "farewell"],
]);

/**
 * Tokens that carry NO speech act of their own but legitimately appear inside a social
 * utterance — phrase remnants and intensifiers. They keep an utterance L0-eligible and
 * NEVER decide its kind, so a bare "bem" or a bare "boa" is NOT L0 (no family token ⇒
 * no template): they are the belt-and-braces for a phrase that did not match exactly,
 * not a second lexicon.
 */
const SOCIAL_NEUTRAL_TOKENS: ReadonlySet<string> = new Set([
  "e",
  "ai",
  "de",
  "muito",
  "mesmo",
  "tudo",
  "bem",
  "bom",
  "boa",
  "dia",
  "tarde",
  "noite",
  "madrugada",
  "certo",
  "joia",
  "tranquilo",
  "tranquila",
  "como",
  "vai",
  "entao",
  "fim",
  "semana",
]);

/**
 * The L0 recogniser: the social speech act of a SOCIAL-ONLY utterance, or `null` when
 * the utterance carries anything else (⟹ it parses normally).
 *
 * PRECEDENCE when several families appear — farewell ▷ thanks ▷ greeting: the most
 * TERMINAL act wins, because answering "obrigado, tchau" with a thanks template
 * invites a continuation the customer just closed, and answering "oi, obrigado" with
 * gratitude is warmer than a bare greeting.
 *
 * PURE, diacritic-insensitive, word-boundaried.
 */
export function classifySocialOnly(text: string): SocialKind | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  let residual = normalize(text);
  const found = new Set<SocialKind>();

  // Consume the multiword phrases first, recording each one's kind. Comparing the
  // before/after string (rather than `.test()`) keeps the /g regexes stateless.
  for (const { re, kind } of SOCIAL_PHRASES) {
    const before = residual;
    residual = residual.replace(re, " ");
    if (residual !== before) found.add(kind);
  }

  for (const token of residual.match(WORD_TOKEN) ?? []) {
    const kind = SOCIAL_TOKENS.get(token);
    if (kind !== undefined) {
      found.add(kind);
      continue;
    }
    // Anything not social and not a phrase remnant is information-bearing: the turn
    // belongs to the normal parse (AC #2 — mixed utterances still parse).
    if (!SOCIAL_NEUTRAL_TOKENS.has(token)) return null;
  }

  // Neutral-only input ("bem", "boa", pure punctuation) asserts no speech act — there
  // is nothing to answer with a template.
  if (found.size === 0) return null;
  if (found.has("farewell")) return "farewell";
  if (found.has("thanks")) return "thanks";
  return "greeting";
}

/**
 * The per-turn facts L0 needs that only the turn's INGRESS can see. Published by the
 * customer ingresses (routes/chat.ts, routes/whatsapp-webhook.ts) via
 * {@link openFunnelTurn} right before `handleTurn`.
 */
export interface FunnelTurnContext {
  /**
   * TRUE iff this turn's session has a PENDING CONFIRMATION (a park) — read from the
   * authoritative `capsule.loadedSession.pendingConfirmations`.
   *
   * FE-D32 (ratified) — while a confirm window is open, L0 MUST NOT FIRE AT ALL. Not
   * for affirmatives, not for bare courtesy: the restate-then-confirm path
   * (`webSoftAffirmativeRestateNotice` at the ingress, `matchToParked` in the loop, the
   * kernel's re-adjudication with a receipt) owns every reply in that window, and a
   * warm template dropped into it would silently answer past a pending money decision.
   */
  readonly confirmWindowOpen: boolean;
}

/** L0's verdict for a turn: the social act to template, or `undefined` (no L0). */
export interface L0Verdict {
  readonly kind: SocialKind;
}

/**
 * The L0 DECISION (pure): fire only when the ingress published this turn's context AND
 * no confirm window is open AND the utterance is social-only.
 *
 * FAIL-CLOSED ON A MISSING CONTEXT — an `undefined` context is not "no park", it is
 * "nobody told us", so L0 stands down and the turn takes the normal (model) path. That
 * is why an ingress which never publishes (the agent plane, the ops plane, a future
 * call site that forgets) silently loses the optimisation instead of gaining a risk.
 */
export function decideL0(input: {
  readonly text: string;
  readonly context: FunnelTurnContext | undefined;
}): L0Verdict | undefined {
  if (input.context === undefined) return undefined;
  if (input.context.confirmWindowOpen) return undefined;
  const kind = classifySocialOnly(input.text);
  return kind === null ? undefined : { kind };
}

/**
 * The template's named slots. `personalization` is RESERVED AND EMPTY until ticket 28
 * (P3 memory) fills it with the grounded, render-gated recent-visit touch ("Como
 * estava o brisket?"). Rendering drops empty slots entirely, so an empty
 * personalization is BYTE-IDENTICAL to a template with no slot at all — the pin that
 * lets ticket 28 land without re-baselining these strings.
 */
export interface L0TemplateSlots {
  readonly personalization: string;
}

/** The reserved-but-unfilled slot set (ticket 28 replaces this at the call site). */
export const EMPTY_L0_SLOTS: L0TemplateSlots = { personalization: "" };

/**
 * The pt-BR L0 templates (Hard Rule #4), warm and store-state NEUTRAL. Each is a
 * sequence of segments joined with single spaces, empty segments dropped.
 *
 * They assert NOTHING about the world: no hours, no prices, no order state, no
 * open/closed claim. That is what makes them safe to ship without the claims gate
 * (spec Implementation Decision 6's small-talk carve-out) and what makes the
 * closed-hours behaviour below a no-op by construction.
 */
const L0_TEMPLATES: Readonly<
  Record<SocialKind, (slots: L0TemplateSlots) => ReadonlyArray<string>>
> = {
  greeting: (slots) => [
    "Oi! Tudo bem?",
    slots.personalization,
    "Como posso te ajudar hoje?",
  ],
  thanks: (slots) => [
    "Eu que agradeço!",
    slots.personalization,
    "Se precisar de mais alguma coisa, é só me chamar.",
  ],
  farewell: (slots) => [
    "Até logo!",
    slots.personalization,
    "Quando quiser pedir, é só me mandar uma mensagem.",
  ],
};

/** Render an L0 reply. PURE — same kind + slots ⟹ byte-identical text. */
export function renderL0Reply(
  kind: SocialKind,
  slots: L0TemplateSlots = EMPTY_L0_SLOTS,
): string {
  return L0_TEMPLATES[kind](slots)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(" ");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. THE PER-TURN SEAM (stateful)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-turn funnel state, keyed by `turnId` — the same idiom the turn_trace buffer
 * (`pendingTraces`, claustrum-bootstrap.ts) and the ops read capture
 * (`readAnswer.render(turnId)`) already use, and the only shape available on the
 * customer plane: the conductor is composed ONCE per process there (unlike the ops
 * plane's per-turn `composeOpsConductor`), so a per-turn closure does not exist.
 *
 * LRU-capped exactly like `pendingTraces`: a turn that opens a context but never
 * reaches its ingress `finally` (a mid-turn throw) can never leak unboundedly.
 */
const MAX_TRACKED_TURNS = 500;
const turnContexts = new Map<string, FunnelTurnContext>();
const turnStages = new Map<string, FunnelStageRecord>();

function evictOldest(map: Map<string, unknown>): void {
  if (map.size < MAX_TRACKED_TURNS) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/**
 * INGRESS SEAM — publish this turn's funnel context. Call AFTER `openCapsule` (the
 * turnId and the loaded session both come from the capsule) and BEFORE `handleTurn`.
 * Idempotent; pair it with {@link closeFunnelTurn} in the ingress `finally`.
 */
export function openFunnelTurn(turnId: string, context: FunnelTurnContext): void {
  evictOldest(turnContexts);
  turnContexts.set(turnId, context);
}

/** INGRESS SEAM — drop this turn's funnel state (context + stage). */
export function closeFunnelTurn(turnId: string): void {
  turnContexts.delete(turnId);
  turnStages.delete(turnId);
}

/** This turn's published context, or `undefined` when no ingress published one. */
export function funnelTurnContext(turnId: string): FunnelTurnContext | undefined {
  return turnContexts.get(turnId);
}

/**
 * This turn's stage record, or `undefined` when no tier claimed the turn. Read by the
 * responder (to render the template), by the claim path (to stay off the wire) and by
 * the once-per-turn telemetry stamp (to put tier attribution in the trace).
 */
export function funnelStage(turnId: string): FunnelStageRecord | undefined {
  return turnStages.get(turnId);
}

/**
 * The funnel seam the PLANNER consumes (`IbatexasPlannerDeps.funnel`). Absent ⇒ the
 * planner is byte-identical to its pre-L0 behaviour, which is how every other
 * composition (ops, agent plane, unit tests) opts out.
 */
export interface FunnelPlannerSeam {
  /**
   * Decide the tier for this turn and STAMP the stage record. Called at the very top
   * of `propose` — before the tool surface is built and before any model call.
   * `undefined` ⟹ no tier claimed the turn ⟹ the normal parse runs.
   */
  claim(state: CognitiveState): FunnelStageRecord | undefined;
  /** The stage stamped for this turn, if any (the claim path reads this). */
  stageFor(turnId: string): FunnelStageRecord | undefined;
}

/**
 * The funnel seam the RESPONDER consumes (`IbatexasResponderDeps.funnel`). Absent ⇒
 * byte-identical to the pre-L0 responder.
 */
export interface FunnelResponderSeam {
  stageFor(turnId: string): FunnelStageRecord | undefined;
  /** The deterministic pt-BR reply for a stamped stage, or `undefined` if the tier
   *  does not author its own reply (L1/L2 will not — they still parse). */
  reply(stage: FunnelStageRecord): string | undefined;
}

/**
 * Build the L0 funnel seam. One instance per composition, shared by the planner and
 * the responder so both read the SAME stamped stage for a turn.
 *
 * `now` is injectable so a deterministic suite can freeze the stage record's `at`.
 */
export function createL0Funnel(
  opts: { readonly now?: () => number } = {},
): FunnelPlannerSeam & FunnelResponderSeam {
  const now = opts.now ?? Date.now;
  return {
    claim(state: CognitiveState): FunnelStageRecord | undefined {
      const verdict = decideL0({
        text: state.perception.text,
        context: funnelTurnContext(state.turnId),
      });
      if (verdict === undefined) return undefined;
      const stage: FunnelStageRecord = {
        tier: "L0",
        reason: "social_only",
        detail: { socialKind: verdict.kind },
        at: new Date(now()).toISOString(),
      };
      evictOldest(turnStages);
      turnStages.set(state.turnId, stage);
      // The funnel's queryable trace line. An L0 turn writes NO turn_trace row and no
      // llm_wire exchange BY DESIGN (there is no completion to record — the absence
      // IS the win), so this line plus the per-turn conductor `turn` record
      // (claustrum-bootstrap's emitTurn, which stamps `funnelTier` from the stage) are
      // where tier attribution lives for a zero-call turn.
      logger.info(
        {
          component: "funnel",
          event: "funnel.tier",
          turnId: state.turnId,
          tier: stage.tier,
          reason: stage.reason,
          socialKind: verdict.kind,
        },
        "funnel: L0 social short-circuit — no model call this turn",
      );
      return stage;
    },
    stageFor(turnId: string): FunnelStageRecord | undefined {
      return funnelStage(turnId);
    },
    reply(stage: FunnelStageRecord): string | undefined {
      if (stage.tier !== "L0") return undefined;
      const kind = stage.detail.socialKind;
      if (kind !== "greeting" && kind !== "thanks" && kind !== "farewell") {
        return undefined;
      }
      return renderL0Reply(kind, EMPTY_L0_SLOTS);
    },
  };
}
