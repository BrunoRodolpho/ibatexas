// alias-canonicalization.ts — LE2-025b, the alias gazetteer's RUNTIME half.
//
// Ticket 25: "Colloquial names resolve deterministically … through the catalog's
// alias gazetteer *before* the parse — feeding the L1 cache keys and L2 retrieval
// — and an unknown surface form clarifies, never nearest-neighbor guesses."
// LE2-025a landed the gazetteer as catalog data plus its compile gates; this is
// what reads it at parse entry.
//
// ── DETERMINISTIC, EXACT, NO NEIGHBOURS ────────────────────────────────────────
// Resolution is exact matching of whole word tokens under the CATALOG'S OWN
// normal form. No embedder, no engine, no edit distance, no stemming, no
// scoring — there is nothing on this path that could rank a guess. That is the
// ticket's rule, and it is why an unresolvable surface CLARIFIES instead of
// picking the closest row.
//
// ── WHERE IT SITS, AND THE THREE THINGS IT MUST FEED ───────────────────────────
// It runs at PARSE ENTRY, and the canonical text is what the parse is a function
// of. Three consumers, in the order the planner reaches them:
//
//   1. the L2 RETRIEVAL QUERY  — so "quero uma farofa" retrieves against the same
//      text as "quero uma farofa-de-bacon-defumado";
//   2. the L1 CACHE KEY        — so the two spellings SHARE an entry and hit each
//      other, which is the ticket's own "feeding the L1 cache keys";
//   3. the MODEL'S USER MESSAGE — and this one is load-bearing for SOUNDNESS, not
//      convenience. L1's contract is that its key digests every input the parse is
//      a function of. Key on canonical text while sending raw text to the model
//      and that contract breaks: two different questions would share one cached
//      answer. So the parse must genuinely be a function of the canonical text.
//
// ── INVISIBLE TO THE CUSTOMER (the reason this never mutates `state`) ──────────
// `CognitiveState.perception.text` is NOT rewritten. The RESPONDER reads that
// same field (`ibatexas-responder.ts`'s `userText`) and feeds it to the prose
// synthesis call, so mutating it would let a canonical handle — "costela-bovina-
// defumada" — reach a customer-facing sentence. Canonicalization is therefore
// PLANNER-LOCAL: the planner substitutes the canonical text into the message IT
// builds, and every other consumer of the turn still sees the customer's own
// words. Visible in the trace, invisible in the reply.
//
// ── AMBIGUITY: CLARIFY, NEVER A COIN FLIP ──────────────────────────────────────
// A surface naming more than one entity (the seed's real case: "costela" is both
// `costela-bovina-defumada` and `costela-defumada-congelada`, different prices and
// different fulfilment) resolves ONLY when the utterance also carries that
// reading's declared `disambiguatedBy` token. Otherwise the turn CLARIFIES.
//
// ── F-2 · A CONSUMED DISAMBIGUATOR IS REMOVED, NOT LEFT BEHIND ─────────────────
// The token that SELECTS a reading is spent by that selection. Leaving it in the
// rewritten text is what the recorded F-2 defect was, and it was live in
// production:
//
//   "combina com a costela bovina"
//     v1 -> "combina com a costela-bovina-defumada bovina"   ← dangling modifier
//     v2 -> "combina com a costela-bovina-defumada"          ← this file, today
//
// The residue is not cosmetic. The canonical text IS the parse input (see the
// three consumers above), so the parser was handed a stray adjective attached to
// nothing — and the L1 key digests that text, so the wart was pinned into the
// cache as well.
//
// SCOPED TO ADJACENCY, DELIBERATELY. Selection reads the WHOLE utterance (a
// `disambiguatedBy` token anywhere in the sentence chooses the reading); removal
// reads only the token immediately AFTER the surface, or immediately before it.
// The two nets are deliberately different sizes, and the asymmetry is the safe
// direction:
//
//   - Selection must stay exactly as it was, byte for byte. Narrowing it would
//     move utterances OFF the resolve path and ONTO the CLARIFY path, which is a
//     behaviour change to the ambiguity contract, not a text cleanup.
//   - Removal must never delete a token the customer meant separately. In
//     "Costela Defumada: Costela bovina defumada 12h." the word "bovina" is four
//     tokens away and belongs to a different phrase; splicing it out would corrupt
//     the sentence. So a NON-ADJACENT disambiguator still selects and is still
//     left in place — the resolution records {@link AliasResolution.disambiguatorConsumed}
//     as absent, which is how that residual stays visible in a trace instead of
//     being silently either cleaned or ignored.
//
// The disambiguator is folded with `normalizeDiacritics`, the SAME fold selection
// uses, so the two can never disagree about whether a token is the disambiguator.
// A multi-word `disambiguatedBy` therefore cannot select today (the presence set
// holds single word tokens) and equally cannot be consumed — consistent by
// construction rather than by a second opinion.
//
// The compile gate is what makes this safe to implement so simply: LE2-025a
// REJECTS a multi-entity surface whose edges do not declare how to tell them
// apart, so this code can never be handed an unanswerable question it has no way
// to recognise. "Unknown" here therefore means exactly "declared-ambiguous and
// undisambiguated" — a plain word with no alias edge at all is not unknown, it is
// simply not an alias, and the utterance passes through untouched.
//
// ── FAIL-SAFE ──────────────────────────────────────────────────────────────────
// No match, an empty gazetteer, a surface that does not appear: the text is
// returned BYTE-IDENTICAL. Canonicalization can only ever rewrite a span it
// positively matched.

import {
  ALIAS_GAZETTEER,
  normalizeDiacritics,
  normalizeProseForm,
  type AliasEdge,
} from "@ibatexas/catalog";

// ═══════════════════════════════════════════════════════════════════════════════
// 0. THE REWRITE REVISION — this layer's L1 key component
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The REWRITE ALGORITHM's revision. A digested component of the L1 parse-cache
 * key (`parse-memo.ts`), which is what makes a change to this file's semantics
 * invalidate the parses it produced.
 *
 * ── WHY THIS EXISTS (the funnel key-surface contract) ─────────────────────────
 * L1's contract is that its key digests EVERY input the parse is a function of.
 * This module is one of those inputs and had no representation in the key: the
 * gazetteer's DATA was covered (a table change ships a new `CATALOG_VERSION`,
 * already digested — see {@link SURFACE_INDEX}), but the CODE that rewrites the
 * text was not. Two deploys could therefore turn one utterance into two different
 * parse inputs under one key. F-2 is the first measured instance of exactly that,
 * and closing it without closing the hole would leave the next one to be found in
 * production too.
 *
 * ── WHY IT IS NOT A `CATALOG_VERSION` BUMP ────────────────────────────────────
 * That serial is hand-authored in `@ibatexas/catalog` and means "the business
 * definition changed" — it is what a workflow instance PINS and resumes against
 * (`packages/catalog/src/version.ts`). No catalog byte changed here; borrowing its
 * serial for an `apps/api` algorithm edit would put a false entry in a ledger other
 * machinery reads. A component of this layer's own, bumped by this layer's own
 * discipline, says the true thing.
 *
 * ── BUMP DISCIPLINE ───────────────────────────────────────────────────────────
 * +1, in the same commit, on any change to what {@link canonicalizeAliases}
 * RETURNS for some input — a new match rule, a changed rewrite span, a changed
 * ambiguity verdict. Not for comments, types, or a refactor proven output-
 * identical. Never reused, never decreased: a bump's whole effect is that every
 * parse cached under the previous revision becomes unreachable and ages out on its
 * TTL, which is a benign L1 cool-down under the fail-open parse-memo contract.
 *
 *   v1 — LE2-025b, the original rewrite. Left a consumed disambiguator in the text.
 *   v2 — F-2. The rewrite span extends over an adjacent disambiguator, so the
 *        token that selected the reading is spliced out with the surface. Every
 *        utterance carrying a surface+disambiguator adjacency canonicalizes to a
 *        DIFFERENT string than it did under v1, so every v1 parse of one is stale.
 */
export const ALIAS_CANONICALIZATION_VERSION = 2;

// ═══════════════════════════════════════════════════════════════════════════════
// 1. THE INDEX
// ═══════════════════════════════════════════════════════════════════════════════

interface IndexedSurface {
  /** The folded token sequence to match (may be multi-word). */
  readonly tokens: readonly string[];
  /** Every edge declared for this surface. >1 ⟹ the surface is ambiguous. */
  readonly edges: readonly AliasEdge[];
}

/**
 * The gazetteer, indexed by folded surface. Built ONCE — the table is inert
 * catalog data, so there is nothing to invalidate at runtime; a catalog change
 * ships a new process (and bumps `CATALOG_VERSION`, which is already a digested
 * component of the L1 parse-cache key, so cached parses built under the old
 * gazetteer become unreachable in the same move).
 *
 * Sorted LONGEST-FIRST so a multi-word surface wins over a single-word one that
 * is a prefix of it — otherwise "calabresa" would consume the first token of
 * "calabresa americana" and the longer, more specific edge could never match.
 */
const SURFACE_INDEX: readonly IndexedSurface[] = (() => {
  const byFolded = new Map<string, AliasEdge[]>();
  for (const edge of ALIAS_GAZETTEER) {
    const key = normalizeProseForm(edge.surface);
    if (key.length === 0) continue;
    const list = byFolded.get(key) ?? [];
    list.push(edge);
    byFolded.set(key, list);
  }
  return [...byFolded.entries()]
    .map(([key, edges]) => ({ tokens: key.split(" "), edges }))
    .sort((a, b) => b.tokens.length - a.tokens.length);
})();

/**
 * Every canonical handle, as a folded token sequence.
 *
 * WHY THIS EXISTS — IDEMPOTENCE. A handle is built from the very words the alias
 * names: `farofa-de-bacon-defumado` tokenizes to `farofa de bacon defumado`, whose
 * FIRST token is the alias surface `farofa`. Without this guard, canonicalizing
 * already-canonical text expands the alias again and yields
 * `farofa-de-bacon-defumado-de-bacon-defumado`.
 *
 * That is not a cosmetic bug: the whole point of this layer is that an aliased
 * utterance and its canonical form land on the SAME L1 cache key, and a
 * non-idempotent rewrite guarantees they cannot. Caught by the L1 seam test, which
 * is exactly the failure that test exists to catch.
 *
 * A canonical handle is TERMINAL — it is already the answer — so its span is
 * consumed before alias matching and never rewritten.
 */
const CANONICAL_INDEX: readonly (readonly string[])[] = (() => {
  const seen = new Set<string>();
  const out: (readonly string[])[] = [];
  for (const edge of ALIAS_GAZETTEER) {
    const folded = normalizeProseForm(edge.canonical);
    if (folded.length === 0 || seen.has(folded)) continue;
    seen.add(folded);
    out.push(folded.split(" "));
  }
  return out.sort((a, b) => b.length - a.length);
})();

// ═══════════════════════════════════════════════════════════════════════════════
// 2. THE RESULT SHAPE
// ═══════════════════════════════════════════════════════════════════════════════

/** One resolved alias — the trace's answer to "why did it read X as Y". */
export interface AliasResolution {
  /**
   * The ALIAS SURFACE as the CUSTOMER wrote it (original casing and accents).
   *
   * The surface only — never the disambiguator, even when F-2's rewrite consumed
   * one. This field answers "which gazetteer edge fired", and the edge is keyed on
   * the surface; {@link AliasResolution.disambiguatedBy} answers the other half.
   */
  readonly surface: string;
  /** The canonical handle it was rewritten to. */
  readonly canonical: string;
  /** The token that selected this reading, when the surface was ambiguous. */
  readonly disambiguatedBy?: string;
  /**
   * F-2 — was the selecting token also SPLICED OUT of the rewritten text?
   *
   * Present only on the adjacent case (the module header's "scoped to adjacency"
   * note). Absent with {@link AliasResolution.disambiguatedBy} present means the
   * token selected this reading from somewhere else in the sentence and was
   * deliberately left where the customer wrote it — the bounded residual, visible
   * in a trace rather than inferred from the text.
   */
  readonly disambiguatorConsumed?: true;
}

/** A surface that names several entities with nothing in the utterance to choose. */
export interface AmbiguousSurface {
  readonly surface: string;
  /** The candidate handles, in gazetteer order — for the clarify question. */
  readonly candidates: readonly string[];
  /** The tokens that WOULD have chosen, in the same order as `candidates`. */
  readonly disambiguators: readonly string[];
}

export interface CanonicalizationResult {
  /** The text the PARSE should use. Byte-identical to the input when nothing matched. */
  readonly text: string;
  readonly resolutions: readonly AliasResolution[];
  /** Non-empty ⟹ the turn must CLARIFY rather than parse. */
  readonly ambiguous: readonly AmbiguousSurface[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. THE CANONICALIZER
// ═══════════════════════════════════════════════════════════════════════════════

/** Word tokens with their offsets in the ORIGINAL string, so a rewrite can splice
 *  the original text rather than rebuild it (rebuilding would drop the customer's
 *  punctuation and casing from the parse input for no reason). */
const WORD_TOKEN = /[\p{L}\p{N}]+/gu;

interface PositionedToken {
  readonly raw: string;
  /** Diacritic- and case-folded, matching what `normalizeProseForm` yields for a
   *  token that (by construction) carries no punctuation. The catalog's OWN
   *  normalizer is imported, never re-implemented, so the runtime net and the
   *  compile-time net can never disagree about what "linguiça" folds to. */
  readonly folded: string;
  readonly start: number;
  readonly end: number;
}

function tokenize(text: string): readonly PositionedToken[] {
  const out: PositionedToken[] = [];
  for (const m of text.matchAll(WORD_TOKEN)) {
    const raw = m[0];
    out.push({
      raw,
      folded: normalizeDiacritics(raw),
      start: m.index,
      end: m.index + raw.length,
    });
  }
  return out;
}

/**
 * F-2 — the disambiguator occurrence the rewrite is allowed to SPEND.
 *
 * The token immediately AFTER the surface span, else the one immediately BEFORE
 * it. Following-first because pt-BR post-modifies ("costela bovina", "costela
 * congelada") and that is the shape every recorded instance takes; the preceding
 * slot is checked so the rule is about ADJACENCY rather than about word order.
 *
 * Returns nothing when neither neighbour is the disambiguator, or when the
 * neighbour is already CONSUMED — an already-claimed token belongs to another
 * surface's span or to a canonical handle the idempotence pre-pass protected, and
 * splicing it out from under that owner would corrupt the very text this layer
 * exists to keep faithful.
 */
function findAdjacentDisambiguator(
  tokens: readonly PositionedToken[],
  surfaceStart: number,
  surfaceLength: number,
  foldedDisambiguator: string,
  consumed: ReadonlySet<number>,
): { readonly index: number; readonly token: PositionedToken } | undefined {
  for (const index of [surfaceStart + surfaceLength, surfaceStart - 1]) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (consumed.has(index)) continue;
    if (token.folded !== foldedDisambiguator) continue;
    return { index, token };
  }
  return undefined;
}

/**
 * Resolve every alias surface in `text` against the catalog gazetteer.
 *
 * PURE. Same text + same catalog ⟹ byte-identical result, which is what lets the
 * L1 key be computed from the output.
 */
export function canonicalizeAliases(text: string): CanonicalizationResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text, resolutions: [], ambiguous: [] };
  }
  const tokens = tokenize(text);
  if (tokens.length === 0) return { text, resolutions: [], ambiguous: [] };
  const present = new Set(tokens.map((t) => t.folded));

  const resolutions: AliasResolution[] = [];
  const ambiguous: AmbiguousSurface[] = [];
  // Spans to rewrite, collected then applied right-to-left so earlier offsets
  // stay valid.
  const rewrites: Array<{ start: number; end: number; to: string }> = [];
  const consumed = new Set<number>();

  // IDEMPOTENCE PRE-PASS: consume spans that are ALREADY canonical handles, so an
  // alias contained inside one cannot be expanded a second time. Longest-first, and
  // never rewritten — a handle is terminal.
  for (const handle of CANONICAL_INDEX) {
    for (let i = 0; i + handle.length <= tokens.length; i += 1) {
      let hit = true;
      for (let k = 0; k < handle.length; k += 1) {
        if ((tokens[i + k] as PositionedToken).folded !== handle[k]) {
          hit = false;
          break;
        }
      }
      if (!hit) continue;
      for (let k = 0; k < handle.length; k += 1) consumed.add(i + k);
    }
  }

  for (const entry of SURFACE_INDEX) {
    for (let i = 0; i + entry.tokens.length <= tokens.length; i += 1) {
      // Never let two surfaces claim the same token.
      let free = true;
      for (let k = 0; k < entry.tokens.length; k += 1) {
        if (consumed.has(i + k)) free = false;
      }
      if (!free) continue;
      let hit = true;
      for (let k = 0; k < entry.tokens.length; k += 1) {
        if ((tokens[i + k] as PositionedToken).folded !== entry.tokens[k]) {
          hit = false;
          break;
        }
      }
      if (!hit) continue;

      const first = tokens[i] as PositionedToken;
      const last = tokens[i + entry.tokens.length - 1] as PositionedToken;
      const surfaceAsWritten = text.slice(first.start, last.end);

      // ── Choose the reading ────────────────────────────────────────────────
      let chosen: AliasEdge | undefined;
      if (entry.edges.length === 1) {
        chosen = entry.edges[0];
      } else {
        // Declared-ambiguous (the compile gate guarantees every edge here carries
        // a `disambiguatedBy`). Exactly one matching token decides; zero — or
        // several, which is equally unanswerable — clarifies.
        const matching = entry.edges.filter((e) => {
          const token = e.disambiguatedBy;
          return token !== undefined && present.has(normalizeDiacritics(token));
        });
        if (matching.length === 1) chosen = matching[0];
      }

      for (let k = 0; k < entry.tokens.length; k += 1) consumed.add(i + k);

      if (chosen === undefined) {
        ambiguous.push({
          surface: surfaceAsWritten,
          candidates: entry.edges.map((e) => e.canonical),
          disambiguators: entry.edges.map((e) => e.disambiguatedBy ?? ""),
        });
        continue;
      }

      // ── F-2 · SPEND THE DISAMBIGUATOR ──────────────────────────────────────
      // The canonical handle already SAYS what the disambiguator said (it is
      // built from those very words — `costela-bovina-defumada` contains
      // "bovina"), so leaving the token behind duplicates the modifier. Extend
      // the rewrite span over the ADJACENT occurrence so one splice replaces
      // "costela bovina" with the handle, taking whatever separated them with it.
      // Non-adjacent occurrences are left alone — see the module header.
      const adjacent =
        chosen.disambiguatedBy === undefined
          ? undefined
          : findAdjacentDisambiguator(
              tokens,
              i,
              entry.tokens.length,
              normalizeDiacritics(chosen.disambiguatedBy),
              consumed,
            );
      if (adjacent !== undefined) {
        consumed.add(adjacent.index);
        rewrites.push({
          // `Math.min`/`Math.max` rather than a branch on which side won: the
          // span is simply the hull of the surface and the token it spent.
          start: Math.min(first.start, adjacent.token.start),
          end: Math.max(last.end, adjacent.token.end),
          to: chosen.canonical,
        });
      } else {
        rewrites.push({ start: first.start, end: last.end, to: chosen.canonical });
      }
      resolutions.push({
        surface: surfaceAsWritten,
        canonical: chosen.canonical,
        ...(chosen.disambiguatedBy === undefined
          ? {}
          : { disambiguatedBy: chosen.disambiguatedBy }),
        ...(adjacent === undefined ? {} : { disambiguatorConsumed: true as const }),
      });
    }
  }

  // An ambiguous surface means the turn clarifies, so the rewritten text is never
  // used — but return the ORIGINAL text in that case rather than a half-rewritten
  // one, so nothing downstream can accidentally parse a partially-canonicalized
  // utterance.
  if (ambiguous.length > 0) {
    return { text, resolutions: [], ambiguous };
  }
  if (rewrites.length === 0) {
    // Byte-identical passthrough — the fail-safe, and the common case.
    return { text, resolutions: [], ambiguous: [] };
  }
  let out = text;
  for (const r of [...rewrites].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, r.start)}${r.to}${out.slice(r.end)}`;
  }
  return { text: out, resolutions, ambiguous: [] };
}

/**
 * The deterministic pt-BR clarify question for an ambiguous surface (Hard Rule
 * #4). Names the readings in the customer's own vocabulary — the canonical
 * handles are internal ids, so the DISAMBIGUATING TOKENS are what gets voiced.
 *
 * Asserts nothing about the world: it does not claim either product exists, is in
 * stock, or costs anything. It asks which of two words the customer meant, which
 * is a question about their sentence, not a claim about the store — so it is safe
 * to render without the claims gate, exactly like L0's templates.
 */
export function renderAliasClarify(ambiguous: readonly AmbiguousSurface[]): string {
  const first = ambiguous[0];
  if (first === undefined) return "";
  const options = first.disambiguators.filter((d) => d.length > 0);
  if (options.length < 2) {
    return `Você pode me dizer qual "${first.surface}" você quer, por favor?`;
  }
  const last = options[options.length - 1] as string;
  const head = options.slice(0, -1).join(", ");
  return (
    `Só pra eu não errar: quando você diz "${first.surface}", ` +
    `você quer a ${head} ou a ${last}?`
  );
}
