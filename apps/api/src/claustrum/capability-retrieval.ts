// capability-retrieval.ts — the LE2 parse funnel's L2 tier: SCOPED PARSE
// (LE2-008; spec §"P1 — funnel", Implementation Decision 9).
//
// WHAT L2 CLOSES. Every parse advertises the WHOLE proposable roster — 20
// capabilities for an authenticated customer — so a request to add a coke is
// scored against reservation, refund and coupon schemas it could never mean.
// L2 presents only the K≈5 most plausible capabilities, retrieved by the
// ratified local embedder over the catalog's authored pt-BR conversation
// projection, and falls back to today's full roster whenever retrieval is not
// confident. The funnel can MATCH but never REGRESS current coverage.
//
// ── WHY THE FALLBACK IS THE DESIGN, NOT A SAFETY NET ───────────────────────────
// A retriever that scopes every turn is a retriever that silently deletes
// capabilities from turns it misread: the model cannot emit what it was never
// shown, so a bad top-K is not a ranking error, it is a coverage loss. The
// confidence gate below therefore decides between "scope" and "show everything",
// and it is tuned so that a scoped turn ALWAYS still carries its capability.
// Measured (see §Evidence): every scoped turn in a held-out half retained its
// correct capability, 91/91, while 26% of turns fell back.
//
// This is also why the amend triad is NOT special-cased. `order.amend.add_item`
// / `.update_qty` / `.remove_item` share the phrase that names the situation
// ("no pedido que já fiz"), so the retriever ranks them as near-ties — and a
// near-tie is a LOW MARGIN, which is exactly the fallback's trigger. A
// per-capability carve-out would hand-patch the one cluster the corpus happens to
// expose while leaving every unmeasured near-tie unprotected; the margin gate
// covers the whole class by construction (ratified design note, LE2-008 re-dispatch).
//
// ── EVIDENCE (pre-registered protocol; full report in the LE2 results dir) ─────
// Parameters were fixed BEFORE scoring — document composition, K and threshold
// were chosen by declared RULES on a SELECTION half of the authored corpus and
// then applied UNCHANGED to a held-out CONFIRMATION half:
//
//   selection   (125 cases)  recall@5 94.4%   scoped 72.8%
//   confirmation(123 cases)  recall@5 96.7%   scoped 74.0%   containment 91/91 = 100%
//
// The corpus is a clean held-out query set: LE2-033 authored the conversation
// projection under a binding sourcing boundary that no phrasing may come from
// `packages/journeys/extraction-corpus` or the eval fixtures.
//
// ── PROMPT PREFIX STABILITY (spec decision 12) ─────────────────────────────────
// Retrieval changes only the `tools` array. The system prompt's STATIC HEAD is
// untouched, the variable material stays in its tail, and the utterance remains
// the last message — so the cacheable prefix is byte-identical across turns
// whether or not L2 scoped. Pinned by a test.
//
// ── FAIL-SAFE IN EVERY DIRECTION ───────────────────────────────────────────────
// No embedder configured, an unreachable embedder, a slow embedder, an index that
// failed to build, an utterance that embeds to nothing: every one of them yields
// NO SCOPING, i.e. today's full roster. There is no path through this module that
// can narrow the surface on bad information.

import { CAPABILITY_DEFINITIONS, generateCapabilityDescriptions, generateConversationTriggers } from "@ibatexas/catalog";
import { logger } from "../lib/logger.js";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PURE CORE — the document, the similarity, the decision
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The scoped-surface revision. Named the moment the scoped surface ships, which
 * is what purges every pre-L2 L1 parse-cache entry: `surfaceVersion` is a
 * digested component of the L1 key (parse-memo.ts), so changing it makes every
 * entry written under the full-roster regime unreachable in one move. Applied to
 * EVERY turn once L2 is wired — scoped and fallback alike — because the tier's
 * presence changes what a cached parse means, not just its surface.
 */
export const L2_SURFACE_VERSION = "l2-scoped-v1";

/** Top-K. K=5 was selected by the pre-registered rule (smallest K in {3,4,5}
 *  reaching 97% recall on the selection half; none did, so the rule's declared
 *  fallback K=5 applied and the shortfall is reported rather than absorbed). */
export const RETRIEVAL_K = 5;

/**
 * The confidence threshold on {@link marginConfidence}. Chosen as the LOWEST
 * margin at which every scoped SELECTION turn still contained its capability in
 * top-K, then confirmed unchanged on the held-out half (100% containment there
 * too). Tightening it trades coverage of the scoping win for nothing; loosening
 * it starts deleting capabilities from turns, so it moves only on harness
 * evidence (spec decision 9: "the confidence threshold tightens only on harness
 * evidence").
 */
export const RETRIEVAL_MARGIN_THRESHOLD = 0.070843;

/** nomic-embed-text's documented task prefixes. Measured best-or-equal against
 *  the bare forms, and they are what the model was trained with. */
const DOC_PREFIX = "search_document: ";
const QUERY_PREFIX = "search_query: ";

/**
 * The retrieval document for one capability — composition **D3**, selected by the
 * pre-registered rule over D1 (triggers only) and D2 (triggers + description).
 * Built ONLY from authored `@ibatexas/catalog` data:
 *
 *   `<kind as words>. <conversationTriggers joined>. <description>`
 *
 * The triggers carry the register the descriptions lack — a customer says "põe
 * mais uma coquinha", the description says "Adicionar um item ao carrinho do
 * cliente" — which is the whole reason the first LE2-008 cycle measured 73.8%
 * recall@5 on descriptions alone and stopped.
 *
 * PURE: same catalog ⟹ byte-identical document ⟹ byte-identical vector.
 */
export function buildRetrievalDocument(kind: string): string {
  const descriptions = generateCapabilityDescriptions(CAPABILITY_DEFINITIONS);
  const triggers = generateConversationTriggers(CAPABILITY_DEFINITIONS);
  const phrasings = triggers[kind] ?? [];
  const description = descriptions[kind] ?? "";
  return `${DOC_PREFIX}${kind.replace(/[._]/g, " ")}. ${phrasings.join(". ")}. ${description}`;
}

/** The query spelling for an utterance. */
export function buildRetrievalQuery(utterance: string): string {
  return `${QUERY_PREFIX}${utterance}`;
}

/** Cosine similarity. Returns 0 for a degenerate vector rather than NaN, so a
 *  malformed embedding can only ever LOSE a ranking, never poison one. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * The confidence signal: how far the top hit stands above the FIRST EXCLUDED
 * capability (rank K+1). Chosen over raw top-1 similarity and over the top-1/top-2
 * gap because it answers the question the decision actually asks — "is the
 * boundary of the top-K set a real boundary?" — rather than "is the winner a
 * strong winner?". A cluster of near-ties straddling the cut produces a small
 * margin and falls back, which is precisely the amend-triad behaviour above.
 *
 * Fewer than K+1 candidates (a roster at or below K) ⟹ there is nothing to
 * exclude, so scoping would be a no-op; returns 0 to take the fallback.
 */
export function marginConfidence(
  sortedScores: readonly number[],
  k: number = RETRIEVAL_K,
): number {
  if (sortedScores.length <= k) return 0;
  return (sortedScores[0] as number) - (sortedScores[k] as number);
}

export interface RetrievalCandidate {
  readonly kind: string;
  readonly score: number;
}

/** What the retriever decided for one turn — the trace's raw material. */
export interface ScopeDecision {
  /** TRUE ⟹ the surface was narrowed to {@link selected}. FALSE ⟹ full roster. */
  readonly scoped: boolean;
  /** The top-K capabilities, best first. Empty when the retriever stood down. */
  readonly selected: readonly string[];
  /** The margin this decision was made on (0 when retrieval was unavailable). */
  readonly confidence: number;
  /** Why, for the trace. */
  readonly reason:
    | "scoped"
    | "low_confidence"
    | "retriever_unavailable"
    | "roster_at_or_below_k";
}

/** The full-roster decision — the one safe answer, used for every degrade. */
export function fullRosterDecision(reason: ScopeDecision["reason"]): ScopeDecision {
  return { scoped: false, selected: [], confidence: 0, reason };
}

/**
 * PURE decision: given this turn's ranked candidates and the allowed roster,
 * scope or fall back.
 *
 * The selected set is INTERSECTED with `allowedIntents` and never invents a
 * capability: retrieval can only ever narrow what the capability planners already
 * authorized, so a stale index cannot widen the surface. That ordering — plan
 * first, retrieve second — is what keeps every existing authorization gate
 * (auth level, cart state, ops boundary) strictly upstream of this module.
 */
export function decideScope(
  ranked: readonly RetrievalCandidate[],
  allowedIntents: readonly string[],
  opts: { readonly k?: number; readonly threshold?: number } = {},
): ScopeDecision {
  const k = opts.k ?? RETRIEVAL_K;
  const threshold = opts.threshold ?? RETRIEVAL_MARGIN_THRESHOLD;
  const allowed = new Set(allowedIntents);
  const inRoster = ranked.filter((c) => allowed.has(c.kind));
  if (inRoster.length <= k) return fullRosterDecision("roster_at_or_below_k");
  const confidence = marginConfidence(
    inRoster.map((c) => c.score),
    k,
  );
  if (confidence < threshold) {
    return { scoped: false, selected: [], confidence, reason: "low_confidence" };
  }
  return {
    scoped: true,
    selected: inRoster.slice(0, k).map((c) => c.kind),
    confidence,
    reason: "scoped",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. THE EMBEDDER SEAM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The minimal embedding port L2 needs. A dedicated port rather than
 * `@ibatexas/tools`' `generateEmbedding` deliberately: that client is
 * Redis-cached, keyed for PRODUCT SEARCH, and asserts the vector matches
 * `EMBEDDING_DIMENSION` (1536 for the default OpenAI provider) — pointing it at
 * nomic-embed-text's 768 dims would make it throw on every call. L2's retriever
 * is a different task against a different, ratified model, so it gets its own
 * thin client and shares only the env idiom.
 */
export interface EmbedderPort {
  embed(text: string): Promise<readonly number[]>;
}

/**
 * The ratified local embedder (BKL-034 env idiom: `OLLAMA_EMBED_URL` /
 * `OLLAMA_EMBED_MODEL`, read at CALL time per FE-D26's lazy-env discipline).
 *
 * `undefined` when either var is unset — which is not an error but the honest
 * "no retriever configured" state, and it makes L2 a designed no-op (full roster)
 * on any stack that has not provisioned the embedder.
 */
export function createOllamaEmbedder(
  opts: { readonly timeoutMs?: number } = {},
): EmbedderPort | undefined {
  const baseUrl = process.env.OLLAMA_EMBED_URL;
  const model = process.env.OLLAMA_EMBED_MODEL;
  if (baseUrl === undefined || model === undefined || baseUrl === "" || model === "") {
    return undefined;
  }
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return {
    async embed(text: string): Promise<readonly number[]> {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`ollama embeddings HTTP ${res.status}`);
      const body = (await res.json()) as { embedding?: number[] };
      const vec = body.embedding;
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error("ollama embeddings returned no vector");
      }
      return vec;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. THE RETRIEVER
// ═══════════════════════════════════════════════════════════════════════════════

export interface CapabilityRetriever {
  /**
   * Rank the roster for this utterance and decide. NEVER THROWS and never
   * narrows on bad information: every failure path returns a full-roster
   * decision, so the worst case is today's behaviour.
   */
  scopeFor(utterance: string, allowedIntents: readonly string[]): Promise<ScopeDecision>;
}

/**
 * Build the retriever. The index (one vector per chat-tier capability) is built
 * ONCE, lazily, on the first turn that needs it, and reused for the process —
 * 20 embed calls, off the boot path so a slow embedder delays a turn rather than
 * readiness. A failed build is retried on the next turn rather than latched,
 * because the usual cause is a transient embedder outage.
 */
export function createCapabilityRetriever(deps: {
  readonly embedder: EmbedderPort;
  readonly k?: number;
  readonly threshold?: number;
}): CapabilityRetriever {
  const k = deps.k ?? RETRIEVAL_K;
  const threshold = deps.threshold ?? RETRIEVAL_MARGIN_THRESHOLD;
  let index: ReadonlyArray<{ kind: string; vec: readonly number[] }> | undefined;
  let building: Promise<void> | undefined;
  let warnedOnce = false;

  const warn = (event: string, error: unknown): void => {
    if (warnedOnce) return;
    warnedOnce = true;
    logger.warn(
      {
        component: "funnel",
        event: `funnel.l2.${event}`,
        error: error instanceof Error ? error.message : String(error),
      },
      "funnel L2: retriever unavailable — full-roster surface for this process (logged once)",
    );
  };

  async function ensureIndex(): Promise<void> {
    if (index !== undefined) return;
    building ??= (async () => {
      const kinds = Object.keys(generateConversationTriggers(CAPABILITY_DEFINITIONS));
      const built: Array<{ kind: string; vec: readonly number[] }> = [];
      for (const kind of kinds) {
        built.push({ kind, vec: await deps.embedder.embed(buildRetrievalDocument(kind)) });
      }
      index = built;
      logger.info(
        { component: "funnel", event: "funnel.l2.index_built", capabilities: built.length },
        `funnel L2: retrieval index built over ${built.length} capability documents`,
      );
    })().finally(() => {
      building = undefined;
    });
    await building;
  }

  return {
    async scopeFor(
      utterance: string,
      allowedIntents: readonly string[],
    ): Promise<ScopeDecision> {
      if (allowedIntents.length <= k) return fullRosterDecision("roster_at_or_below_k");
      try {
        await ensureIndex();
        const live = index;
        if (live === undefined || live.length === 0) {
          return fullRosterDecision("retriever_unavailable");
        }
        const q = await deps.embedder.embed(buildRetrievalQuery(utterance));
        const ranked = live
          .map((e) => ({ kind: e.kind, score: cosineSimilarity(q, e.vec) }))
          .sort((a, b) => b.score - a.score);
        return decideScope(ranked, allowedIntents, { k, threshold });
      } catch (error) {
        // Unreachable / slow / malformed embedder, or a failed index build. The
        // ONLY safe answer is the surface the system had before this tier existed.
        warn("scope_failed", error);
        return fullRosterDecision("retriever_unavailable");
      }
    },
  };
}
