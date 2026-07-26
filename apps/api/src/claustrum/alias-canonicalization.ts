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
  /** The surface as the CUSTOMER wrote it (original casing and accents). */
  readonly surface: string;
  /** The canonical handle it was rewritten to. */
  readonly canonical: string;
  /** The token that selected this reading, when the surface was ambiguous. */
  readonly disambiguatedBy?: string;
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
      rewrites.push({ start: first.start, end: last.end, to: chosen.canonical });
      resolutions.push({
        surface: surfaceAsWritten,
        canonical: chosen.canonical,
        ...(chosen.disambiguatedBy === undefined
          ? {}
          : { disambiguatedBy: chosen.disambiguatedBy }),
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
