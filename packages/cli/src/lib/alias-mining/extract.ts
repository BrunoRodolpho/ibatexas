// extract.ts — turning recorded customer utterances into CANDIDATE SURFACE FORMS
// (LE2-026, the alias-mining loop's first stage).
//
// Ticket 26: "an offline job mines CLARIFY misses from recorded transcripts into
// ranked candidate alias mappings and produces an owner-approval report".
//
// This module is the "into candidate" half, and it is deliberately the dumbest
// part of the pipeline: it decides only WHICH WORDS a customer used as the
// OBJECT OF A REQUEST. It does not decide whether a word is an alias, does not
// consult the catalog, does not rank, and cannot reach the network. Everything
// judgemental happens in `classify.ts` against a live roster, where it can be
// checked against the world instead of against a lexicon's opinion.
//
// # Why request objects, and not a bag of words
//
// The naive miner tokenizes every utterance, drops a stop-word list and counts
// what is left. On this corpus that surfaces `pedido`, `carrinho`, `favor` and
// `retirada` at the top — the words of ORDERING, not the words for THINGS. The
// signal the ticket actually wants is narrower and has a grammar: a customer
// naming a thing they want does it in the object position of a request verb,
// after an optional article or quantity.
//
//     quero uma coca            -> coca
//     poe mais um refrigerante  -> refrigerante
//     tira a Mandioca Frita     -> mandioca frita
//
// Reading that position instead of the whole utterance is what makes the output
// reviewable by a human: every row is a noun phrase somebody asked for, so the
// question an owner answers is "is this a name for something we sell?" — one
// question, about one word, with a yes/no answer.
//
// # Why this is lexicon-driven and that is a stated limit, not a hidden one
//
// The verb list below is finite and pt-BR-specific. A request phrased with a
// verb it does not hold is INVISIBLE to the miner — it contributes no candidate
// and no evidence. That is a recall limit, and it is the safe direction to fail
// in for a loop whose output a human approves: a missed candidate costs another
// mining run, an invented one costs a wrong alias in the catalog. The report
// states the extractor's coverage so the limit is visible at review time rather
// than discovered later (see `report.ts`'s Method section).
//
// Pure: no clock, no RNG, no IO, no `process.env`.

import { normalizeProseForm } from "@ibatexas/catalog"

/**
 * Where one piece of evidence was READ from. Carried per-mention and reported
 * per-row, because LE2-026's sourcing boundary is only auditable if a reviewer
 * can see which store each row's evidence came from.
 *
 *   `labelled-event` — a `funnel.tier` / `funnel.alias.resolved` record the
 *     runtime emitted (LE2-025b, PR #426). The strongest evidence available:
 *     the runtime itself labelled this surface form as an alias miss, so the
 *     surface and its candidate handles are read out of the record rather than
 *     inferred from prose.
 *
 *   `transcript` — free text from the episodic memory store
 *     (`claustrum_memory_episodic.user_text`). Weaker: the miner infers the
 *     request object from grammar, and nothing labelled it.
 */
export const MINING_SOURCES = ["labelled-event", "transcript"] as const

/** One evidence source tag. */
export type MiningSource = (typeof MINING_SOURCES)[number]

/** One occurrence of one candidate surface form in one utterance. */
export interface CandidateMention {
  /** The candidate, folded under {@link normalizeProseForm} — the grouping key. */
  readonly surface: string
  /** The candidate as the customer spelled it, for the report's human column. */
  readonly display: string
  /** The whole utterance this came from. RAW — scrubbing happens at render. */
  readonly utterance: string
  /** Which store the utterance was read from. */
  readonly source: MiningSource
  /**
   * Whether an article or quantity sat directly in front of the object —
   * "uma agua", "dois refrigerantes", "o brisket".
   *
   * This is the miner's COUNT-NOUN signal, and `classify.ts` leans on it for
   * the one judgement it cannot make from the roster: an unmatched surface that
   * somebody quantified is a thing the store does not sell (a catalog gap); an
   * unmatched surface nobody ever quantified is far more likely to be a verb
   * phrase the extractor mis-read (noise). "quero uma agua" earns a gap row;
   * "quero saber" does not.
   */
  readonly quantified: boolean
}

// ── The lexicons ─────────────────────────────────────────────────────────────
//
// All three are compared FOLDED (`normalizeProseForm`), so they carry no
// accents: "põe" is matched as "poe", "vê" as "ve". Writing them unaccented is
// not sloppiness — an accented entry here would simply never match.

/**
 * Verbs (and verb-ish openers) that put a THING in their object position.
 *
 * Grounded in the corpus rather than in a grammar: every entry below appears in
 * `claustrum_memory_episodic` on the dev stack. Additive by design — a new verb
 * is a new row here, and re-running the miner is free.
 */
const REQUEST_VERBS: ReadonlySet<string> = new Set([
  // desiderative
  "quero", "queria", "gostaria", "desejo",
  // additive
  "adiciona", "adicionar", "acrescenta", "acrescentar", "poe", "poem",
  "coloca", "colocar", "inclui", "incluir", "manda", "mandar", "traz", "trazer",
  // subtractive
  "tira", "tirar", "remove", "remover", "retira", "retirar",
  // substitutive
  "troca", "trocar", "muda", "mudar", "substitui", "substituir",
  // ordering
  "pede", "pedir", "pedi",
  // interrogative — "quanto custa a coca"
  "custa", "vende", "vendem",
  // the "me vê" opener, folded
  "ve",
])

/**
 * "tem" is a request verb ONLY in the existential reading.
 *
 * pt-BR uses the same word for "do you have X" and "does it contain X", and the
 * two point in opposite directions:
 *
 *     voces tem picanha?              -> asking for a PRODUCT      (mine it)
 *     o Brownie com Sorvete tem leite? -> asking about an INGREDIENT (do not)
 *
 * Reading the second as a request produced `leite` -> `pudim-de-leite-condensado`
 * in the first real run: an alias FROM an allergen term TO a product. The
 * gazetteer's safety binding forbids exactly that edge in both directions
 * (BKL-143 / BKL-123 / BKL-171, enforced by the `alias-gazetteer` compile pass),
 * so approving the row could not have shipped — but it would have put an
 * allergen word in front of an owner as a candidate product name, which is the
 * kind of suggestion that only has to be taken seriously once.
 *
 * The readings are separated positionally: the existential one opens a clause or
 * follows a second-person subject; the ingredient one follows the thing being
 * asked about.
 */
const EXISTENTIAL_TEM_LEADERS: ReadonlySet<string> = new Set([
  "voces", "vcs", "voce", "vc", "ainda", "hoje", "ai", "la", "aqui",
])

/** True when `tem` at index `i` is the existential "do you have" reading. */
function isExistentialTem(tokens: readonly string[], i: number): boolean {
  if (tokens[i] !== "tem") return false
  const prev = i === 0 ? undefined : tokens[i - 1]
  return prev === undefined || EXISTENTIAL_TEM_LEADERS.has(prev)
}

// The verbs that are NOT in the list above, and why, because each was tried and
// measured out:
//
//   "dê" / "dá" fold to "de" / "da" — which are also pt-BR's two commonest
//   prepositions. Admitting them made every product name containing "de" emit
//   its own tail as a candidate: "Farofa de Bacon Defumado" produced `bacon`,
//   "Pudim de Leite Condensado" produced `leite`, and both were then classified
//   `propose-alias` with double-digit evidence. Those rows look completely
//   plausible on the page, which is exactly what makes them dangerous — an owner
//   approving `bacon` -> `farofa-de-bacon-defumado` would ship an edge that
//   hijacks every future bacon product. "me dê" is already reached through the
//   `me` determiner path.
//
//   "pôr" folds to "por", the preposition. Same collision, same decision;
//   "põe" ("poe") carries the additive reading with no ambiguity.

/**
 * Indefinite articles and numerals — the COUNT-NOUN signal.
 *
 * Only these set {@link CandidateMention.quantified}, and the distinction is
 * load-bearing rather than pedantic. An earlier version counted every
 * determiner, including the definite articles, and "muda o status", "quero
 * trocar a forma de pagamento" and "me mandar o menu" all came back as CATALOG
 * GAPS — the miner reporting, with a straight face, that the store should
 * consider selling a `status`. "o X" presupposes a specific X already in play;
 * "uma X" asks for one more of a kind of thing, which is what a product is.
 */
const QUANTIFIERS: ReadonlySet<string> = new Set([
  "um", "uma", "uns", "umas",
  "dois", "duas", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez",
  "mais", "menos", "outro", "outra", "outros", "outras",
])

/**
 * Words that may sit between the verb and the thing WITHOUT implying a count —
 * definite articles, possessives, demonstratives, clitics. Skipped while hunting
 * for the object's first content word; never themselves a candidate, and never
 * evidence that the object is a product.
 */
const DEFINITES: ReadonlySet<string> = new Set([
  "o", "a", "os", "as",
  "meu", "minha", "meus", "minhas",
  "esse", "essa", "este", "esta", "aquele", "aquela",
  "me", "nos", "tambem", "so", "apenas", "ai", "la",
])

/**
 * Words that END an object phrase. Reaching one means the noun phrase is over:
 * "tira a coca DO meu pedido" stops at "do", yielding "coca" and not
 * "coca do meu pedido".
 *
 * `de` and `da` are boundaries and ONLY boundaries — see the note under
 * {@link REQUEST_VERBS} for what happened when they were also read as verbs.
 * Truncating "Farofa de Bacon Defumado" to `farofa` is the alias we want.
 */
const BOUNDARIES: ReadonlySet<string> = new Set([
  "no", "na", "nos", "nas", "do", "da", "dos", "das", "de",
  "em", "para", "pra", "pro", "por", "com", "sem", "ate",
  "e", "ou", "que", "se", "ao", "aos", "a", "o",
  "favor", "ja", "agora", "hoje", "amanha", "porfavor", "tambem",
  "pedido", "carrinho", "conta", "mesa", "reserva",
  // Prepositional contractions with a pronoun — "adiciona uma coca-cola NELE".
  // Without these the object swallowed the reference and produced candidates
  // like `coca cola nele`, which are unreviewable as alias rows.
  "nele", "nela", "neles", "nelas", "nesse", "nessa", "neste", "nesta",
  "naquele", "naquela", "disso", "dele", "dela", "nisso",
])

/**
 * Clause separators. The utterance is split on these BEFORE folding, because
 * `normalizeProseForm` turns punctuation into spaces and a request's object
 * would otherwise run straight through a sentence boundary: "quero um Brisket
 * Americano. fecha o pedido" yielded the candidate `Brisket Americano fecha`.
 * Splitting first costs nothing — a clause with no verb simply contributes
 * nothing — and removes an entire class of unreviewable rows.
 */
const CLAUSE_SPLIT = /[.!?;:,\n]+/

/** Maximum content tokens in one candidate phrase. */
const MAX_PHRASE_TOKENS = 3

/**
 * True for a token that is only a number ("2", "500ml" is NOT this). Digits
 * alone are quantities, never names.
 */
function isBareNumber(token: string): boolean {
  return /^\d+$/.test(token)
}

/** One request object found in an utterance: the folded phrase + its signals. */
export interface RequestObject {
  /** The folded noun phrase. */
  readonly surface: string
  /** Whether an article or quantity preceded it — see {@link CandidateMention.quantified}. */
  readonly quantified: boolean
}

/**
 * Pull every request-object noun phrase out of ONE utterance.
 *
 * Returns the folded phrase AND — when the phrase is multi-token — its head
 * word, because both are legitimate alias candidates and only a human can say
 * which one the catalog wants: "coca cola" and "coca" are both real surface
 * forms, and the corpus contains both spellings.
 *
 * Order is the order of appearance; duplicates within one utterance are kept
 * (the caller de-duplicates by utterance when counting evidence).
 */
export function extractRequestObjects(utterance: string): readonly RequestObject[] {
  const out: RequestObject[] = []
  for (const clause of utterance.split(CLAUSE_SPLIT)) {
    const tokens = normalizeProseForm(clause).split(" ").filter(Boolean)
    for (let i = 0; i < tokens.length; i++) {
      if (!isRequestVerbAt(tokens, i)) continue
      out.push(...objectAt(tokens, i))
    }
  }
  return out
}

/** Does a request verb sit at `i`, in a reading that takes a product object? */
function isRequestVerbAt(tokens: readonly string[], i: number): boolean {
  const token = tokens[i]
  if (token === undefined) return false
  return REQUEST_VERBS.has(token) || isExistentialTem(tokens, i)
}

/**
 * Walk past articles and quantities to the object's first content word.
 *
 * Returns where the noun phrase starts and whether anything on the way implied
 * a COUNT — see {@link CandidateMention.quantified} for why only the indefinite
 * readings set it.
 */
function skipDeterminers(
  tokens: readonly string[],
  from: number,
): { readonly start: number; readonly quantified: boolean } {
  let j = from
  let quantified = false
  while (j < tokens.length) {
    const t = tokens[j] as string
    if (QUANTIFIERS.has(t) || isBareNumber(t)) quantified = true
    else if (!DEFINITES.has(t)) break
    j++
  }
  return { start: j, quantified }
}

/** Collect the noun phrase beginning at `from`, stopping at the first boundary. */
function nounPhraseAt(tokens: readonly string[], from: number): readonly string[] {
  const phrase: string[] = []
  let j = from
  while (j < tokens.length && phrase.length < MAX_PHRASE_TOKENS) {
    const t = tokens[j] as string
    if (BOUNDARIES.has(t) || REQUEST_VERBS.has(t) || isBareNumber(t)) break
    phrase.push(t)
    j++
  }
  return phrase
}

/**
 * The candidate(s) contributed by the request verb at `verbAt`.
 *
 * A multi-word phrase yields its head word as well: an owner approving "coca"
 * and an owner approving "coca cola" are making different decisions, and the
 * report must let them make each one.
 */
function objectAt(tokens: readonly string[], verbAt: number): readonly RequestObject[] {
  const { start, quantified } = skipDeterminers(tokens, verbAt + 1)
  const phrase = nounPhraseAt(tokens, start)
  if (phrase.length === 0) return []
  const whole: RequestObject = { surface: phrase.join(" "), quantified }
  return phrase.length > 1
    ? [whole, { surface: phrase[0] as string, quantified }]
    : [whole]
}

/**
 * Fold a batch of utterances into mentions.
 *
 * De-duplicates per (utterance, surface) so one customer typing "coca" twice in
 * one sentence contributes one piece of evidence — evidence counts are counts
 * of UTTERANCES, which is the unit an owner can reason about ("nine different
 * people asked for this").
 */
export function mentionsFrom(
  utterances: readonly string[],
  source: MiningSource,
): readonly CandidateMention[] {
  const out: CandidateMention[] = []
  for (const utterance of utterances) {
    const seen = new Set<string>()
    for (const { surface, quantified } of extractRequestObjects(utterance)) {
      if (seen.has(surface)) continue
      seen.add(surface)
      out.push({
        surface,
        display: displayFormOf(utterance, surface),
        utterance,
        source,
        quantified,
      })
    }
  }
  return out
}

/**
 * Recover the customer's own spelling of a folded surface form.
 *
 * The report shows an owner what was actually typed ("Coca-Cola", not "coca
 * cola") because that is what they are deciding to put in the gazetteer, whose
 * `surface` field stores natural pt-BR. Falls back to the folded form when the
 * natural span cannot be located — which happens when folding merged
 * punctuation, and a wrong-looking display is better than a wrong surface.
 */
export function displayFormOf(utterance: string, foldedSurface: string): string {
  const words = utterance.split(/\s+/)
  const wanted = foldedSurface.split(" ").length
  // Span lengths run from 1 up to `wanted`, not just `wanted`: folding splits on
  // punctuation, so a surface of N folded words can occupy FEWER whitespace
  // words in the original. "Coca-Cola" is one word and folds to two ("coca
  // cola"), and an exact-length-only search silently missed every hyphenated
  // product name — showing the owner the folded form to approve instead of the
  // spelling their customers actually typed.
  for (let len = 1; len <= wanted; len++) {
    for (let i = 0; i + len <= words.length; i++) {
      const span = words.slice(i, i + len).join(" ")
      if (normalizeProseForm(span) === foldedSurface) return trimTrailingPunctuation(span)
    }
  }
  return foldedSurface
}

/** Characters stripped from the tail of a recovered display form. */
const TRAILING_PUNCTUATION = new Set([".", ",", "!", "?", ";", ":"])

/**
 * Drop trailing sentence punctuation — a linear backward scan, deliberately not
 * a regex.
 *
 * This ran as `span.replace(/[.,!?;:]+$/, "")` and was flagged for super-linear
 * backtracking. The shape `[class]+$` is quadratic on an adversarial tail: the
 * engine matches the run greedily, fails the anchor, gives a character back and
 * retries, from every start position. That is a nuisance on authored input and a
 * genuine denial-of-service shape HERE, because every string reaching this
 * function is raw customer transcript text — untrusted by definition, and
 * something a customer chooses freely.
 *
 * The scan below touches each trailing character at most once and cannot
 * backtrack at all, which makes the linearity structural rather than a property
 * of the pattern that someone has to re-verify after an edit.
 */
export function trimTrailingPunctuation(text: string): string {
  let end = text.length
  while (end > 0 && TRAILING_PUNCTUATION.has(text[end - 1] as string)) end--
  return text.slice(0, end)
}

/**
 * A mention built directly from a runtime-labelled event, bypassing extraction.
 *
 * The `funnel.tier` ALIAS record already CARRIES the surface form the runtime
 * failed to resolve — inferring it back out of prose would be strictly worse
 * information. Kept in this module so both mention paths land in one type.
 */
export function labelledMention(
  surface: string,
  utterance: string,
): CandidateMention {
  return {
    surface: normalizeProseForm(surface),
    display: surface,
    utterance,
    source: "labelled-event",
    // A labelled event IS the runtime reporting a failed product reference, so
    // the count-noun heuristic the transcript path needs is redundant here — the
    // label already carries what the heuristic exists to guess.
    quantified: true,
  }
}
