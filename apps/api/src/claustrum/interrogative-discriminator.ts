// interrogative-discriminator.ts — the BKL-078 QUESTION-SHAPE gate (demote-only).
//
// Tonight's live-proven hallucination leak: on the `prose_preserved` path (the
// planner proposed NO claim → runClaimsValidate returned undefined → handle-turn
// §6a cannot supersede → the model's free prose reaches the customer) a genuine
// INFO-QUESTION shipped a delivered falsehood twice ("O combo família serve até 4
// pessoas"; an invented party-decoration service). This module is the pure
// discriminator the responder consults to DEMOTE such a turn to a proposition-free
// SAFE_UNKNOWN reply BEFORE any model call — never promote, never touch the render
// or claim-proposal paths.
//
// The three exported predicates:
//   - `isSmalltalkOnly(text)`   — the message is ONLY phatic tokens (greeting /
//     thanks / affirmation). Checked FIRST and WINS over everything (the BKL-110
//     0/15 bar): a '?'-bearing greeting like "oi, tudo bem?" must NEVER degrade.
//   - `hasInfoQuestion(text)`   — the message is shaped like a request for
//     information (a positive net: '?', WH markers, polar/modal openers, a NARROW
//     info-imperative, or the minimal English honesty net).
//   - `shouldDegradeToSafeUnknown(text)` = `!isSmalltalkOnly ∧ hasInfoQuestion` —
//     the gate the responder fires on. Smalltalk always beats the question net.
//
// INDEPENDENCE (load-bearing — do NOT weaken): this module MUST NOT import or
// consume `classifyRequestSpans` / any keyword net from required-claim-decomposer.
// ts. That net is the §O#15 CLAIM-closure segmenter (BKL-005 proved promoting its
// successful-empty result over prose is UNSAFE — its markers also match
// STATEMENTS). This gate is a SEPARATE, question-shape-only signal; keeping the two
// nets independent is exactly why the naive promotion fix was PROVEN-UNSAFE and
// this one is not.
//
// PURE & self-contained (mirrors required-claim-decomposer.ts): no clock / RNG / IO;
// no model import; no kernel-downstream import. WORD-BOUNDARY everything (the
// `\bpago\b` lesson — a marker must never match inside another word, e.g. "tem"
// inside "atendimento" or "pago" inside "pagode"). pt-BR, diacritic-insensitive.

/**
 * Strip diacritics + lowercase so the lexicons match accented input and the model's
 * accented echoes alike ("olá" → "ola", "você" → "voce", "não" → "nao"). Combining
 * marks (incl. the cedilla ç → c) fall in U+0300–U+036F. Pure. Mirrors the
 * closed-hours normalizer so the two stay diacritic-consistent.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Word-token extractor over a normalized string (ASCII words only, post-strip). */
const WORD_TOKEN = /[a-z0-9]+/g;

/**
 * SMALLTALK — the phatic lexemes a customer opens/closes with. When a message
 * contains ONLY these (after consuming the multiword phrases below), it is
 * smalltalk-only and is NEVER degraded, even if it carries a '?'. The set is the
 * BKL-110 0/15 corpus's vocabulary; over-including a token here is SAFE (it can
 * only KEEP a turn on the prose path — the conversational responder still answers a
 * greeting), while a genuine question always carries a residual content token
 * ("picanha", "sushi", "voces", "combo", …) that keeps it OUT of this set.
 */
export const SMALLTALK_TOKENS: ReadonlySet<string> = new Set([
  // greetings + connective fragments ("e aí", "fala aí").
  "oi", "ola", "opa", "fala", "e", "ai",
  // phatic / "how are you" answers.
  "beleza", "blz", "suave", "tranquilo", "tranquila", "boa", "bom",
  // thanks + closings.
  "obrigado", "obrigada", "obg", "valeu", "vlw", "falou", "tmj",
  // affirmations / acknowledgements.
  "ok", "okay", "sim", "nao", "certo", "show", "massa", "combinado", "isso",
  // parts of the greeting phrases below (belt-and-braces if a phrase is missed).
  "dia", "tarde", "noite", "madrugada", "tudo", "de", "muito",
]);

/**
 * Multiword smalltalk phrases — consumed (replaced by a space) BEFORE tokenizing so
 * a phrase like "tudo bem" or "e aí" does not leave a stray content-looking token.
 * `\s+` between words tolerates extra spacing; `\b` anchors keep them word-exact.
 */
export const SMALLTALK_PHRASES: readonly RegExp[] = [
  "bom dia", "boa tarde", "boa noite", "boa madrugada",
  "e ai", "fala ai",
  "tudo bem", "tudo bom", "tudo certo", "tudo tranquilo", "tudo joia", "tudo beleza",
  "como vai", "de boa",
].map((p) => new RegExp(`\\b${p.replace(/ /g, "\\s+")}\\b`, "g"));

/**
 * TRUE iff the message is phatic-only: after consuming the multiword phrases, every
 * remaining word token is in {@link SMALLTALK_TOKENS} (an empty residual — pure
 * punctuation/greeting — counts as smalltalk). Checked FIRST by the gate and WINS
 * over {@link hasInfoQuestion}: "oi, tudo bem?" is smalltalk despite the '?'. Pure.
 */
export function isSmalltalkOnly(text: string): boolean {
  let t = normalize(text);
  for (const phrase of SMALLTALK_PHRASES) t = t.replace(phrase, " ");
  const tokens = t.match(WORD_TOKEN) ?? [];
  return tokens.every((tok) => SMALLTALK_TOKENS.has(tok));
}

// ── The positive INFO-QUESTION net (disjunction Q1..Q4 + the D2 English net) ────
// Each regex is BOUNDARY-anchored and NON-global (so `.test()` is stateless).

/** Q1 — an explicit question mark. */
const Q1_QUESTION_MARK = /\?/;

/** Q2 — pt-BR WH interrogatives. */
const Q2_WH =
  /\b(qual|quais|quanto|quanta|quantos|quantas|quando|onde|cade|quem|o que|por que|porque|pq|que horas|como)\b/;

/**
 * Q3 — polar / modal question openers ("tem picanha?", "vocês fazem entrega?",
 * "aceitam vale?", "dá pra…?", "posso…?", "é possível…?"). `vocês são/estão` is a
 * ratified opener. Bare `tem` is a strong info opener and is word-boundaried so it
 * never fires inside "aTENdimento".
 */
const Q3_POLAR_MODAL =
  /\b(tem|aceita|aceitam|posso|consigo|pode|podem|funciona|da pra|da para|e possivel|sera que|tem como)\b|\bvoces? (sao|estao|tem|fazem|faz|aceitam?)\b/;

/**
 * Q4 — a NARROW info-imperative, carried by FOUR component nets (Q4a..Q4d below)
 * whose UNION is the Q4 marker; {@link hasInfoQuestion} ORs them. They are separate
 * literals only because the fused one scored 35 on Sonar's regex-complexity budget
 * of 20 (S5843) — the matched-string set is unchanged, one alternative per family.
 * Deliberately narrow so ACTION imperatives ("cancela meu pedido", "quero um
 * X-burguer") keep taking the intent path: only "me diz/fala/informa/explica/conta …"
 * (Q4a), "me passa/manda/envia/dá/repassa …" (Q4b, BKL-250), "quero/queria/gostaria …
 * saber" (Q4c), and "confere/verifica/vê se …" (Q4d) count as asking for information.
 *
 * BKL-250 — the HAND-IT-OVER family ("me passa o endereço do cliente", "me manda o
 * telefone dele") is the same speech act as "me diz …" with a different verb, and it
 * is the phrasing a PII probe actually uses. Its absence meant those turns matched no
 * Q1..Q4 marker (no '?', no WH word, no polar opener), `hasInfoQuestion` returned
 * false, the gate stayed shut, and the turn shipped MODEL FREE PROSE — the hole the
 * SCN-109 security probe rode. Adding the verbs shrinks that ungoverned surface;
 * because this is a POSITIVE net feeding a DEMOTE-ONLY gate, an addition can only
 * ever move a turn prose→SAFE_UNKNOWN, never the reverse, and `isSmalltalkOnly` still
 * wins ahead of it.
 *
 * Written UNACCENTED ("me da", not "me dá") because every predicate here runs over
 * {@link normalize}'s output, which strips combining marks — the file's local
 * convention, same as `\bcade\b` / `da pra` / `e possivel` above. Both the indicative
 * and the subjunctive-imperative form are listed for each verb, mirroring the
 * existing diz|diga / informa|informe / conta|conte pairing.
 */
const Q4A_TELL_ME =
  /\bme (diz|diga|fala|informa|informe|explica|explique|conta|conte)\b/;

/** Q4b — the BKL-250 HAND-IT-OVER family. See the {@link Q4A_TELL_ME} block above. */
const Q4B_HAND_IT_OVER =
  /\bme (passa|passe|manda|mande|envia|envie|da|repassa|repasse)\b/;

/** Q4c — the "quero/queria/gostaria (de) saber" family. */
const Q4C_WANT_TO_KNOW = /\b(quero|queria|gostaria)\s+(de\s+)?saber\b/;

/** Q4d — the "confere/verifica/vê se …" family. */
const Q4D_CHECK_WHETHER = /\b(confere|conferir|verifica|verificar|ve se)\b/;

/**
 * D2 — the minimal English honesty net. An English question must degrade honestly
 * (SAFE_UNKNOWN) rather than ship English prose. Uses only markers UNAMBIGUOUS in a
 * pt-BR message (multiword "are you"/"do you"/"can you" + unambiguous WH words);
 * deliberately excludes bare "do"/"is" (pt-BR "do" = de+o).
 */
const D2_ENGLISH =
  /\b(are you|are u|do you|does|can you|could you|will you|what|how|when|where|why|who)\b/;

/**
 * TRUE iff the message is shaped like a request for information (Q1..Q4 or the D2
 * English net). A POSITIVE net: an unmatched message contributes nothing. Pure.
 */
export function hasInfoQuestion(text: string): boolean {
  const t = normalize(text);
  return (
    Q1_QUESTION_MARK.test(t) ||
    Q2_WH.test(t) ||
    Q3_POLAR_MODAL.test(t) ||
    Q4A_TELL_ME.test(t) ||
    Q4B_HAND_IT_OVER.test(t) ||
    Q4C_WANT_TO_KNOW.test(t) ||
    Q4D_CHECK_WHETHER.test(t) ||
    D2_ENGLISH.test(t)
  );
}

/**
 * The gate the BKL-078 responder seam fires on: DEGRADE this turn to a
 * proposition-free SAFE_UNKNOWN reply iff it is a NON-smalltalk info-question.
 * Smalltalk WINS (never degrades — the BKL-110 0/15 bar). DEMOTE-ONLY by
 * construction: a `true` only ever moves a turn prose→SAFE_UNKNOWN. Pure.
 */
export function shouldDegradeToSafeUnknown(text: string): boolean {
  return !isSmalltalkOnly(text) && hasInfoQuestion(text);
}

/**
 * LE2-013 — the RAW-PROSE RETIREMENT gate: DEGRADE iff the message is NOT
 * smalltalk-only. The strictly-stronger sibling of
 * {@link shouldDegradeToSafeUnknown}, and the whole of ticket 13's first
 * acceptance criterion.
 *
 * ── Why the positive net is not enough ───────────────────────────────────────
 * {@link hasInfoQuestion} is a POSITIVE net (Q1..Q4 + the D2 English net), so its
 * MISSES are exactly the hole this ticket closes: an information-bearing turn that
 * matches no marker ("me passa o faturamento da semana", "preciso do total de
 * ontem", "confirmação do fornecedor pra amanhã") is neither smalltalk nor a
 * recognised question, so the responder's empty-plan branch shipped model prose —
 * a digit-free factual assertion that the ops digit clamp
 * (`clampUngroundedOpsFact`) cannot see, because the clamp only demotes ungrounded
 * NUMBERS. Widening the positive net indefinitely is a losing game; INVERTING the
 * default is not. So on the ops plane the question becomes "is this small talk?"
 * — the ONE discriminator that is a closed, enumerated lexicon
 * ({@link SMALLTALK_TOKENS} + {@link SMALLTALK_PHRASES}, the BKL-110 0/15 corpus)
 * rather than an open-ended net — and everything else terminates at the
 * deterministic SAFE_UNKNOWN render.
 *
 * ── Still DEMOTE-ONLY, still sound ───────────────────────────────────────────
 * A `true` can only ever move a turn prose→SAFE_UNKNOWN. It never promotes, never
 * touches the render or claim-proposal paths, and it is reached only AFTER the
 * deterministic read render and BEFORE any model call (see the responder's
 * REFUSE/empty-plan branch), so a genuinely VALIDATED claim still supersedes it at
 * handle-turn §6a. Over-including a token in the smalltalk lexicon is the ONLY
 * failure direction, and it merely keeps a turn on the (clamped) prose path.
 *
 * PURE. Deliberately plane-agnostic: the PLANE choice lives in
 * `safe-unknown-gate.ts` (`SafeUnknownGateOptions.retireRawProse`), because the
 * customer plane's own retirement is a separate, spec-level decision.
 */
export function shouldRetireRawProse(text: string): boolean {
  return !isSmalltalkOnly(text);
}
