// Shared pt-BR text folding — the ONE diacritic-stripping implementation in
// this package (LE2-033, extended by LE2-025a).
//
// Callers need the same fold for two different jobs:
//
//   - IDENTIFIER space — `compiler/safety-markers.ts`'s `normalizeReference`
//     folds `sem_gluten`, `MENU_ITEM_ALLERGENS`, `glúten` into a form where
//     separators become `_` so a marker can be matched as a whole segment.
//   - WORD space — {@link normalizeProseForm} folds *"Tira a Coca!"* into a
//     form where punctuation becomes a space and words stay words. Two
//     callers share it: `capability-definitions/conversation-triggers.ts`'s
//     `normalizeTriggerPhrasing` (LE2-033) and `alias-gazetteer.ts`'s
//     `normalizeAliasSurface` (LE2-025a).
//
// The two spaces are genuinely different and must stay different — folding a
// trigger phrasing's spaces to `_` would make every phrasing one long token,
// and folding a reference's separators to spaces would break `markerHits`'
// segment test. What is identical is the HEAD: NFD-decompose, drop combining
// marks, lowercase. That is what {@link normalizeDiacritics} is, so there is
// one place where "é === e" is decided rather than several that can drift.
//
// Deliberately a leaf module at the package root, NOT inside `compiler/`: the
// dependency direction in this package is compiler -> capability-definitions
// and never the reverse (the compiler is a build tool that reads the authored
// data; the data must not import its checker). A shared helper that both use
// therefore cannot live in either directory.
//
// No dependency is taken on `@ibatexas/tools` for this. The catalog's only
// dependency is `@adjudicate/core` and that boundary is deliberate — a few
// lines of Unicode folding is cheaper than a new edge in the build graph.
//
// Pure: no clock, no RNG, no IO, and locale-independent (never
// `toLocaleLowerCase`, which would make CI output machine-dependent).

/**
 * Fold accents and case: NFD-decompose, strip combining marks (U+0300–U+036F),
 * lowercase. `"Glúten"` -> `"gluten"`, `"COÇA"` -> `"coca"`, `"João"` ->
 * `"joao"`.
 *
 * Leaves every other character alone — separators, punctuation and whitespace
 * are the CALLER's business, because that is exactly where the two callers
 * legitimately disagree (see the module doc).
 */
export function normalizeDiacritics(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

/**
 * Fold PROSE into word space: {@link normalizeDiacritics}, then everything
 * that is not a letter, digit or space becomes a space, then whitespace runs
 * collapse and the ends are trimmed. `"Tira a Coca!"`, `"tira a co\u00e7a"` and
 * `"tira  a  coca"` all give `"tira a coca"`.
 *
 * The comparison key for every customer-spoken string this package holds \u2014 a
 * capability's trigger phrasings (LE2-033) and an alias gazetteer's surface
 * forms (LE2-025a). Both compare under this and both STORE the natural pt-BR
 * text, accents and all: the stored form is what a human reads and what gets
 * embedded downstream, and folding accents out of it would degrade the very
 * retrieval the data exists to serve.
 *
 * Deliberately does no stemming and no stop-word removal. It decides only
 * that two spellings are the same string, which is a question with one right
 * answer; whether "costelas" and "costela" are the same WORD is a language
 * question the runtime canonicalizer owns, and a build gate that guessed at
 * it would reject authored data over a linguistic opinion.
 */
export function normalizeProseForm(text: string): string {
  return normalizeDiacritics(text)
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}
