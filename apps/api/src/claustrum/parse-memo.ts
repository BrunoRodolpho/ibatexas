// parse-memo.ts — the LE2 parse funnel's L1 tier: EXACT-MATCH memoization of the
// parse (LE2-009; spec §"P1 — funnel", Implementation Decisions 10 + 12).
//
// WHAT L1 CLOSES. At the pinned temperature (`PINNED_COMPLETION_TEMPERATURE` = 0)
// the extraction call is a DETERMINISTIC FUNCTION of exactly three things: the
// system prompt, the advertised tool surface, and the utterance. A customer who
// sends the same message twice pays for that function twice. L1 memoizes it.
// This is memoization of a pure function, NOT a similarity cache — at temperature
// zero there is no false-hit risk to trade against, which is the whole reason
// decision 10 ships exact-match now and defers the semantic tier until the
// repeat-miss telemetry below earns it.
//
// ── THE DOCTRINE THIS FILE OBEYS (decision 12, non-negotiable) ──────────────────
//   CACHE THE PARSE, NEVER THE ANSWER.
// What is stored is the model's PARSE — which capability it selected and with
// which payload slots. Nothing downstream is stored: RESOLVE re-hydrates ids from
// live Redis/Medusa, the kernel re-adjudicates against current policy, executors
// re-read fresh projections, and the renderer re-renders. Two identical questions
// asked either side of a store change therefore produce DIFFERENT answers from the
// SAME cached parse — which is the stale-answer proof in the suite, not a caveat.
//
// ── WHY A CACHED ENVELOPE IS RE-MINTED, NEVER REPLAYED ─────────────────────────
// THE hazard of this ticket, and the reason {@link MemoizedParse} stores
// `{kind, payload}` pairs rather than `IntentEnvelope`s. Per `@adjudicate/core`'s
// envelope contract, `nonce` is "the load-bearing idempotency key" and
// `intentHash` content-addresses it — "two dispatches of the same logical action
// MUST share the same nonce for ledger dedup". Replaying a stored envelope
// verbatim would therefore reproduce its `intentHash`, and the ALWAYS-ON,
// fail-closed execution ledger (CLAUDE.md Hard Rule #9) would correctly dedup it
// as a re-dispatch of the FIRST action — silently swallowing the customer's
// second, genuinely-new request. A cache that eats every repeated order is a
// money-path defect, so the parse is re-minted into a fresh envelope by the
// caller with THIS turn's actor and a fresh nonce. `parse-memo` never constructs
// an envelope and never sees a nonce; that asymmetry is deliberate and pinned by
// a test.
//
// ── WHAT IS DELIBERATELY NOT CACHEABLE ─────────────────────────────────────────
// Three parse shapes are refused by {@link isCacheableParse}, all for the same
// doctrinal reason — what would be stored is not a parse the doctrine above can
// defend:
//   - a READ-ENRICHED parse (the BKL-027 one-hop loop): its second pass is
//     conditioned on live read RESULTS, so store state is baked into the parse.
//     Caching it would cache an answer wearing a parse's clothes.
//   - an EXTRACTION-FAILURE refuse (empty completion / completion error): a
//     transient wire fault. Caching it would pin a temporary outage into every
//     future repeat of that utterance until the key version moved.
//   - a SILENT parse (BKL-274 — see {@link isSilentParse}): the model returned
//     prose and selected NOTHING. Not zero-proposal — zero ARTIFACT: no
//     proposal, no read-tool call, not even an out-of-plan drop.
//
// ── WHY SILENCE IS THE THIRD REFUSAL, AND WHY IT IS NOT "ZERO PROPOSALS" ───────
// Zero proposals is NOT the defect and must stay cacheable. A parse that
// selected only READ tools, or one whose selection the constrained-generation
// wall DROPPED as out-of-plan, mints no envelope either — but both are genuine
// determinations, deterministic functions of the prompt, and replaying them
// reproduces exactly what the live path would have done. The defect is the parse
// that determined nothing at all.
//
// Two things make silence uniquely unsafe to store, and only the second is
// obvious:
//
//  1. IT IS INDISTINGUISHABLE FROM A FAULT. The extraction-failure refuse above
//     catches the failures that announce themselves (an empty completion, a
//     thrown completion, malformed tool-call JSON). Model silence announces
//     nothing: the completion is well-formed, carries text, and returns 200. At
//     this seam there is no evidence separating "correctly had nothing to
//     propose" from "failed to parse an order". Storing it commits to the
//     charitable reading for the full TTL.
//
//  2. IT IS THE ONE ENTRY SHAPE THAT CACHES THE ANSWER. This is the doctrinal
//     line, not a cost argument. A replayed NON-silent parse leaves the whole
//     pipeline something to do — RESOLVE re-hydrates, the kernel re-adjudicates,
//     executors re-read, the renderer re-renders — which is exactly why two
//     identical asks either side of a store change give different answers. A
//     replayed SILENT parse leaves nothing to vary: no envelope to hydrate,
//     nothing to adjudicate, nothing to execute. Worse, an L1 hit STAMPS the
//     turn's funnel stage, and the planner's claim seam short-circuits on a
//     stamped stage — so replaying silence also suppresses the claims plane that
//     would otherwise have answered the turn. The output becomes a pure function
//     of the cache entry. That is the definition of caching the answer, and the
//     doctrine above calls it non-negotiable.
//
// The measured consequence (BKL-274, 2026-07-27, the pinned engine epoch): a
// customer whose action-shaped ask goes silent gets silence again on the repeat
// — with no model call at all — for the full TTL. Repeating yourself is the only
// self-service remedy a customer has, and caching silence is precisely the thing
// that defeats it.
//
// The refusal is enforced on BOTH sides of the store, deliberately. WRITE side:
// the planner never stores a silent parse. READ side: {@link isSilentParse} is
// re-checked on lookup (funnel-tier.ts's `lookupParse`), so an entry written by
// an older deploy and still inside its 7-day TTL is treated as a MISS the moment
// this code ships — no key-component bump, no eviction pass, and no good entry
// thrown away. See that call site for why the read guard is the residue's whole
// answer.
//
// ── THE KEY, AND THE ADDITIVE SLOT L2 WILL USE ─────────────────────────────────
// The key is a digest over EVERY input the parse is a function of (see
// {@link buildParseCacheKey}). Three of those inputs are versions rather than
// content — `KEY_SCHEMA_VERSION`, `CATALOG_VERSION` and
// `ALIAS_CANONICALIZATION_VERSION` — and one, `surfaceVersion`, is the slot
// reserved for the L2 scoped-parse tier: when L2 lands it names its retrieval
// index/surface revision there and every pre-L2 entry becomes unreachable in the
// same move. That IS the purge: a bumped component yields a different digest, so
// stale entries can never be read and age out on their TTL. There is no separate
// invalidation path to get wrong, and no version component is ever omitted from
// the digest.
//
// ── F-2 · WHY THE CANONICALIZER EARNED A COMPONENT OF ITS OWN ─────────────────
// The utterance this key digests is not the customer's — it is the ALIAS-
// CANONICALIZED text (`ibatexas-planner.ts` passes `parseText`, and sends that
// same string to the model). That is deliberate and load-bearing: keying on one
// string while parsing another is exactly the unsoundness alias-canonicalization's
// own header refuses.
//
// It also means the canonicalizer is a LAYER THAT CHANGES WHAT THE PARSER SEES,
// and this key's contract is that every such layer is represented in it. The
// gazetteer's DATA already was (a table edit bumps `CATALOG_VERSION`); its CODE
// was not. `ALIAS_CANONICALIZATION_VERSION` closes that, and F-2 — a rewrite that
// left a consumed modifier in the text — is the measured reason it needed closing.
//
// Note the two mechanisms are independent, and BOTH now hold for F-2:
//   1. STRUCTURAL — an utterance whose canonicalization changed hashes to a
//      different key by construction, because the canonical text IS a key
//      component. Pinned so a future edit cannot quietly re-key on raw text.
//   2. DECLARED   — the revision component moves, so the invalidation does not
//      DEPEND on (1) still being true.

import { createHash } from "node:crypto";
import { CATALOG_VERSION } from "@ibatexas/catalog";
import { getRedisClient, rk } from "@ibatexas/tools";
import { logger } from "../lib/logger.js";
import { ALIAS_CANONICALIZATION_VERSION } from "./alias-canonicalization.js";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PURE CORE — canonicalization, the key, the stored shape
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The STORED-SHAPE schema version. Bump on any breaking change to
 * {@link MemoizedParse}, or to the MEANING of a component
 * {@link buildParseCacheKey} already digests — a bump makes every prior entry
 * unreachable, which is this cache's purge mechanism (see the module header).
 *
 * ADDING a new digested component is NOT one of those cases and does not need a
 * bump: a new component changes the digest for every input, so it is already a
 * total purge on its own, and `keyVersion` is also written into each entry and
 * re-checked on read — a bump that did not correspond to a stored-shape change
 * would make that read guard assert something untrue. `ALIAS_CANONICALIZATION_
 * VERSION` (F-2) was added under exactly this reading.
 */
export const KEY_SCHEMA_VERSION = 1;

/** The Redis key namespace. Always built through `rk()` (Hard Rule #7). */
const KEY_PREFIX = "funnel:l1:parse";

/**
 * Entry TTL. A parse is only valid while every keyed input still holds; the
 * digest already guarantees that, so the TTL exists to bound STORAGE, not
 * correctness. Seven days keeps a busy store's repeat set resident across a
 * weekend while letting a retired utterance fall out on its own.
 */
export const PARSE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Canonicalize an utterance into its join key: NFC, trimmed, inner whitespace
 * collapsed, case-folded.
 *
 * DIACRITICS ARE PRESERVED, deliberately. "Ibaté" and "Ibate" are DIFFERENT
 * utterances to the parser and can extract different payload slots, so folding
 * them together would be a false hit — the one thing exact-match memoization
 * exists to make impossible. This mirrors the extraction-eval harness's own
 * `normalizeUtterance` (packages/journeys/src/extraction/eval-score.ts), which
 * makes the same call for the same reason; the two are pinned to each other by a
 * test so a future edit cannot silently widen one net and not the other.
 */
export function canonicalizeUtterance(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Stable digest of an arbitrary JSON-able value — key order made irrelevant. */
function stableDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left in order
 * (array order is meaningful in a tool surface and in a payload's list slots).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Every input the parse is a function of. Each field is load-bearing — dropping
 * one would let a parse produced under one condition be served under another:
 *
 *  - `utterance`      — the question itself. The planner passes the ALIAS-
 *                       CANONICALIZED text, which is also the string it sends to
 *                       the model; see the module header's F-2 note.
 *  - `modelId`        — a different model is a different function.
 *  - `system`         — the FULLY COMPOSED system prompt, digested. This
 *                       subsumes persona edits, the fragment manifest, AND the
 *                       relevance-gated closed-hours note, so a turn parsed while
 *                       the store was closed can never serve one while it is open.
 *  - `toolSurface`    — the advertised `tools` array, digested. This is what
 *                       makes the AUTH state safe without naming it: a guest sees
 *                       7 proposable intents and an authenticated customer 20, so
 *                       the two produce different digests and never share an entry.
 *  - `surfaceVersion` — the ADDITIVE slot reserved for L2 (module header).
 */
export interface ParseCacheKeyInput {
  readonly utterance: string;
  readonly modelId: string;
  readonly system: string;
  readonly toolSurface: unknown;
  /** L2's reserved component. Defaults to the pre-L2 full-roster surface. */
  readonly surfaceVersion?: string;
}

/** The full-roster surface label — the value L2 will replace with its own. */
export const FULL_ROSTER_SURFACE_VERSION = "full-roster";

export interface ParseCacheKey {
  /** The Redis key (already `rk()`-namespaced). */
  readonly key: string;
  /** Short digest prefix, safe to log and to put in a trace stage record. */
  readonly digest: string;
  /** The schema version this key was built under (recorded in the trace). */
  readonly keyVersion: number;
}

/**
 * Build the cache key. PURE — same inputs ⟹ byte-identical key, which is what
 * makes the hit path reproducible and the version-bump purge total.
 */
export function buildParseCacheKey(input: ParseCacheKeyInput): ParseCacheKey {
  const digest = stableDigest({
    keySchemaVersion: KEY_SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    // F-2 — the alias rewrite's own revision. Like `CATALOG_VERSION`, imported
    // rather than threaded through the argument list: it is a property of the
    // deployed code, not of a call site, and a caller must not be able to claim a
    // revision the process is not running.
    aliasCanonicalizationVersion: ALIAS_CANONICALIZATION_VERSION,
    surfaceVersion: input.surfaceVersion ?? FULL_ROSTER_SURFACE_VERSION,
    modelId: input.modelId,
    utterance: canonicalizeUtterance(input.utterance),
    systemDigest: stableDigest(input.system),
    toolSurfaceDigest: stableDigest(input.toolSurface),
  });
  return {
    key: rk(`${KEY_PREFIX}:v${KEY_SCHEMA_VERSION}:${digest}`),
    digest,
    keyVersion: KEY_SCHEMA_VERSION,
  };
}

/**
 * The stored parse: what the model SELECTED, never what the system then did with
 * it. Deliberately envelope-free (module header) and id-free — no cartId, no
 * orderId, nothing a resolver hydrates, because those are live state.
 */
export interface MemoizedParse {
  /** The proposed capability/payload pairs, in emission order. */
  readonly proposals: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
  /** Read-tool calls the model made (advertisement-level; never executed here). */
  readonly readToolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
  /** Capabilities the model proposed that the plan disallowed (telemetry parity). */
  readonly dropped: ReadonlyArray<string>;
  /** The schema version the entry was written under — re-checked on read. */
  readonly keyVersion: number;
}

/**
 * BKL-274 — did this parse produce ANY artifact at all?
 *
 * SILENT means zero of everything the parse can emit: no proposal, no read-tool
 * call, no out-of-plan drop. Each term is load-bearing and each one is a
 * NARROWING — dropping any of them would refuse a legitimate entry:
 *
 *  - `proposals`     — the obvious one, but on its own it is the WRONG
 *                      predicate: read-only and dropped-only parses have zero
 *                      proposals and are perfectly cacheable.
 *  - `readToolCalls` — the model selected READ tools. That is a determination
 *                      about the utterance, and (when the reads were not
 *                      executed — an executed read makes the parse
 *                      read-enriched and refused by the clause above) it is
 *                      still a pure function of the prompt.
 *  - `dropped`       — the model DID select a capability and the deterministic
 *                      constrained-generation wall rejected it. The wall is
 *                      deterministic, so a replay reproduces the live verdict
 *                      exactly; the drop is already visible in the trace as
 *                      `droppedOutOfPlan`. Nothing here is a failure to parse.
 *
 * Deliberately takes the STORED shape rather than three loose booleans, so the
 * predicate is computed from the very object about to be written and the two can
 * never drift apart.
 */
export function isSilentParse(parse: {
  readonly proposals: ReadonlyArray<unknown>;
  readonly readToolCalls: ReadonlyArray<unknown>;
  readonly dropped: ReadonlyArray<unknown>;
}): boolean {
  return (
    parse.proposals.length === 0 &&
    parse.readToolCalls.length === 0 &&
    parse.dropped.length === 0
  );
}

/**
 * Is this parse safe to memoize? See the module header's "deliberately not
 * cacheable" section — all three refusals exist because what would be stored is
 * store state, a transient fault, or (BKL-274) no parse at all.
 *
 * Every field is REQUIRED, `silent` included. It would have been less churn to
 * default it to `false`, and that is exactly the shape this ticket exists to
 * repair: the defect was a call site passing an unconsidered `extractionFailed:
 * false`. A required field makes every future caller answer the question.
 */
export function isCacheableParse(input: {
  readonly readEnriched: boolean;
  readonly extractionFailed: boolean;
  readonly silent: boolean;
}): boolean {
  return !input.readEnriched && !input.extractionFailed && !input.silent;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. THE STORE PORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The persistence seam. A port (not a direct Redis call) so the planner's cache
 * path is drivable in a unit test without a Redis double, while production wires
 * {@link createRedisParseCacheStore}.
 *
 * FAIL-OPEN IS THE CONTRACT: every implementation MUST swallow its own transport
 * faults and report a MISS rather than throw. A cache is an optimisation; a
 * cache outage that breaks turns would be strictly worse than no cache. The
 * Redis implementation below is the reference for that discipline.
 */
export interface ParseCacheStore {
  get(key: string): Promise<MemoizedParse | undefined>;
  set(key: string, value: MemoizedParse, ttlSeconds: number): Promise<void>;
}

/** Structural guard for a value read back out of Redis. */
function isMemoizedParse(value: unknown): value is MemoizedParse {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<MemoizedParse>;
  return (
    Array.isArray(v.proposals) &&
    Array.isArray(v.readToolCalls) &&
    Array.isArray(v.dropped) &&
    typeof v.keyVersion === "number" &&
    v.proposals.every(
      (p) => p !== null && typeof p === "object" && typeof (p as { kind?: unknown }).kind === "string",
    )
  );
}

/**
 * The production store. Redis via `getRedisClient()`, keys via `rk()`
 * (Hard Rule #7 — the key is already namespaced by `buildParseCacheKey`).
 *
 * Every fault degrades to a miss and a once-per-process warning: an unreachable
 * Redis, a malformed entry, a schema-version mismatch (an entry written by an
 * older deploy that is still inside its TTL). None of them can fail a turn.
 */
export function createRedisParseCacheStore(): ParseCacheStore {
  let warnedOnce = false;
  const warn = (event: string, error: unknown): void => {
    if (warnedOnce) return;
    warnedOnce = true;
    logger.warn(
      {
        component: "funnel",
        event: `funnel.l1.${event}`,
        error: error instanceof Error ? error.message : String(error),
      },
      "funnel L1: parse cache unavailable — degrading to miss for this process (logged once)",
    );
  };
  return {
    async get(key: string): Promise<MemoizedParse | undefined> {
      try {
        const redis = await getRedisClient();
        const raw = await redis.get(key);
        if (raw === null || raw === undefined) return undefined;
        const parsed: unknown = JSON.parse(raw);
        if (!isMemoizedParse(parsed)) return undefined;
        // An entry from an older stored-shape schema is ignored, not trusted.
        // The key already embeds the version, so this is belt-and-braces.
        if (parsed.keyVersion !== KEY_SCHEMA_VERSION) return undefined;
        return parsed;
      } catch (error) {
        warn("get_failed", error);
        return undefined;
      }
    },
    async set(key: string, value: MemoizedParse, ttlSeconds: number): Promise<void> {
      try {
        const redis = await getRedisClient();
        await redis.setEx(key, ttlSeconds, JSON.stringify(value));
      } catch (error) {
        warn("set_failed", error);
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. TELEMETRY — the residual repeat-miss rate (the semantic tier's evidence gate)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The counters decision 10 names as the precondition for ever building the
 * semantic tier: "the embedding-similarity tier stays specced but deferred until
 * trace telemetry shows the residual repeat-miss rate justifies it".
 *
 * `repeatMisses` is the load-bearing one and the only non-obvious definition: a
 * miss on an utterance this process HAS canonicalized before. Because an exact
 * repeat under unchanged conditions always hits, a repeat MISS means the
 * utterance came back while some OTHER keyed input had moved (a redeploy's new
 * prompt, a catalog bump, an eviction, or — the interesting case — a near-repeat
 * that canonicalizes differently). That number, not the raw miss count, is what a
 * semantic tier would have to beat, and it is why the seen-set is keyed on the
 * canonical utterance ALONE rather than on the full cache key.
 */
export interface ParseCacheCounters {
  readonly hits: number;
  readonly misses: number;
  readonly repeatMisses: number;
  readonly stores: number;
  /**
   * Parses refused by {@link isCacheableParse} on the WRITE side — read-enriched,
   * extraction-failed, or (BKL-274) silent.
   */
  readonly bypasses: number;
  /**
   * BKL-274, READ side: lookups that FOUND a stored entry and refused to serve it
   * because {@link isSilentParse} held. Counted separately from `misses` on
   * purpose — this is the only number that shows the pre-fix residue draining. It
   * decays to zero within one TTL of the fix shipping and must then STAY zero;
   * a non-zero value afterwards means something is writing silence again.
   */
  readonly silentEntriesIgnored: number;
}

/** Bound on the distinct canonical utterances tracked for the repeat signal. */
const MAX_SEEN_UTTERANCES = 5_000;

export interface ParseCacheTelemetry {
  recordHit(): void;
  /** @param canonical the canonicalized utterance, for the repeat-miss signal. */
  recordMiss(canonical: string): void;
  recordStore(): void;
  recordBypass(): void;
  /** BKL-274 — a stored entry was found, judged silent, and NOT served. */
  recordSilentEntryIgnored(): void;
  snapshot(): ParseCacheCounters;
}

export function createParseCacheTelemetry(): ParseCacheTelemetry {
  let hits = 0;
  let misses = 0;
  let repeatMisses = 0;
  let stores = 0;
  let bypasses = 0;
  let silentEntriesIgnored = 0;
  // Insertion-ordered Map used as an LRU-ish bound, the same idiom funnel-tier.ts
  // uses for its per-turn maps.
  const seen = new Set<string>();
  return {
    recordHit: () => {
      hits += 1;
    },
    recordMiss: (canonical: string) => {
      misses += 1;
      if (seen.has(canonical)) {
        repeatMisses += 1;
      } else {
        if (seen.size >= MAX_SEEN_UTTERANCES) {
          const oldest = seen.values().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
        seen.add(canonical);
      }
    },
    recordStore: () => {
      stores += 1;
    },
    recordBypass: () => {
      bypasses += 1;
    },
    recordSilentEntryIgnored: () => {
      silentEntriesIgnored += 1;
    },
    snapshot: () => ({
      hits,
      misses,
      repeatMisses,
      stores,
      bypasses,
      silentEntriesIgnored,
    }),
  };
}
