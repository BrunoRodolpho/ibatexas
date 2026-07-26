// Shared pt-BR text folding — the ONE diacritic-stripping implementation in
// this package (LE2-033).
//
// Two callers need the same fold for different jobs:
//
//   - `compiler/safety-markers.ts`'s `normalizeReference` folds an IDENTIFIER
//     (`sem_gluten`, `MENU_ITEM_ALLERGENS`, `glúten`) into identifier space,
//     where separators become `_` so a marker can be matched as a whole
//     segment.
//   - `capability-definitions/conversation-triggers.ts`'s
//     `normalizeTriggerPhrasing` folds PROSE (*"Tira a Coca!"*) into word
//     space, where punctuation becomes a space and words stay words.
//
// Their tails are genuinely different and must stay different — folding a
// trigger phrasing's spaces to `_` would make every phrasing one long token,
// and folding a reference's separators to spaces would break `markerHits`'
// segment test. What is identical is the HEAD: NFD-decompose, drop combining
// marks, lowercase. That is what lives here, so there is one place where
// "é === e" is decided rather than two that can drift apart.
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
