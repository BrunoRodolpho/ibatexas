// The SAFETY MARKER vocabulary — allergen- and dietary-family tokens
// (LE2-016, the safety-implication-edges pass).
//
// This file holds NAMES that make a reference SAFETY-BEARING. It holds no
// policy: what happens to a safety-bearing edge is stated, with its tracker
// grounding, in `passes/safety-implication-edges.ts`.
//
// # Where these tokens come from
//
// The runtime already draws this line, in one place, for customer TEXT:
// `ALLERGEN_FAMILY_RE` in `apps/api/src/claustrum/required-claim-decomposer.ts`
//
//   /al[ée]rg|gl[úu]ten|lactose|cont[ée]m|\b(?:amendoim|nozes|castanhas?|
//    camar[ãa]o|mariscos?|soja|ovos?|leite)\b/
//
// The tables below MIRROR that regex — including its two-tier matching, which
// is load-bearing rather than incidental: `al[ée]rg` / `gl[úu]ten` / `lactose`
// are STEMS matched anywhere ("alérgenos", "glúten-free"), while the allergen
// NOUNS are `\b`-bounded so `\bovo\b` never fires inside "provolone". Both
// tiers are transposed here from pt-BR prose into the IDENTIFIER space a
// catalog reference actually lives in (`menu-item-allergens`,
// `MENU_ITEM_ALLERGENS`, `sem_gluten`), with word boundaries re-expressed as
// separator-delimited SEGMENTS.
//
// Two deliberate differences, both forced by that transposition:
//
//   - `cont[ée]m` is dropped. In prose it marks the ASSERTION ("contém
//     glúten"); as an identifier token it matches nothing a catalog names, and
//     its English form `contains` matches ordinary non-safety ids
//     ("cart-contains-item"). Every family it guards is listed directly.
//   - English tokens are added alongside the pt-BR ones. Claim ids in this
//     repo are English-hyphenated (`order-placed`, `preferences-saved`) and
//     registry types are English UPPER_SNAKE (`MENU_ITEM_ALLERGENS`), so a
//     pt-BR-only matcher would miss the exact names the catalog uses.
//
// The regex source stays the authority for customer text; this is its
// catalog-side mirror, and drift between them is a widening question for a
// human, not something a build gate can decide.
//
// # Stems are matched anywhere, on purpose
//
// A stem is not an exact-match denylist entry: a denylist can only reject
// names someone already thought of, and the ratified rulings are about a CLASS
// of assertion, not about three specific ids. `menu-item-allergens-v2` and
// `sem_gluten_list` are caught by construction — the conservative routing the
// safety pass requires.
//
// The cost is a possible false positive on a future non-safety reference that
// happens to contain a stem. That is the correct direction to be wrong in for
// an allergen gate, and the fix (an owner-ratified decision) is a reviewed
// change rather than a silent pass.
//
// Pure: no clock, no RNG, no IO.

import { normalizeDiacritics } from "../text-normalization.js"

/**
 * Which safety family a marker belongs to. Both families are compile errors —
 * the family only selects which ratified tracker row the diagnostic cites
 * (allergen -> BKL-143/BKL-123; dietary-restriction -> BKL-171).
 */
export type SafetyFamily = "allergen" | "dietary-restriction"

/** How a marker matches a normalized reference. */
export type SafetyMarkerMatch = "stem" | "word"

/** One safety-bearing token. */
export interface SafetyMarker {
  readonly token: string
  readonly match: SafetyMarkerMatch
  readonly family: SafetyFamily
}

/**
 * The ALLERGEN family — `ALLERGEN_FAMILY_RE`'s `al[ée]rg` stem and its
 * `\b`-bounded allergen nouns, plus the English forms the catalog's own
 * name spaces would use. The stem is what makes `MENU_ITEM_ALLERGENS`,
 * `allergens`, and `alergenos` all safety-bearing without enumerating them.
 */
export const ALLERGEN_MARKERS: readonly SafetyMarker[] = [
  { token: "alerg", match: "stem", family: "allergen" },
  { token: "allerg", match: "stem", family: "allergen" },
  { token: "amendoim", match: "word", family: "allergen" },
  { token: "peanut", match: "word", family: "allergen" },
  { token: "nozes", match: "word", family: "allergen" },
  { token: "castanha", match: "word", family: "allergen" },
  { token: "nut", match: "word", family: "allergen" },
  { token: "camarao", match: "word", family: "allergen" },
  { token: "shrimp", match: "word", family: "allergen" },
  { token: "marisco", match: "word", family: "allergen" },
  { token: "shellfish", match: "word", family: "allergen" },
  { token: "soja", match: "word", family: "allergen" },
  { token: "soy", match: "word", family: "allergen" },
  { token: "ovo", match: "word", family: "allergen" },
  { token: "egg", match: "word", family: "allergen" },
  { token: "leite", match: "word", family: "allergen" },
  { token: "milk", match: "word", family: "allergen" },
  { token: "dairy", match: "word", family: "allergen" },
]

/**
 * The DIETARY-RESTRICTION family — the "sem X" axis BKL-171 rules on.
 * `gluten` and `lactose` are STEMS, exactly as `ALLERGEN_FAMILY_RE` treats
 * them: the ruling is that a "sem glúten" list IS a "não contém glúten"
 * assurance by another name, so the token alone makes a reference
 * safety-bearing however the negation is spelled (`sem_gluten`,
 * `gluten_free`, `glutenFree`).
 */
export const DIETARY_RESTRICTION_MARKERS: readonly SafetyMarker[] = [
  { token: "gluten", match: "stem", family: "dietary-restriction" },
  { token: "lactose", match: "stem", family: "dietary-restriction" },
  { token: "celiac", match: "stem", family: "dietary-restriction" },
]

/** Every safety marker, allergen family first (see {@link safetyMarkerOf}). */
export const SAFETY_MARKERS: readonly SafetyMarker[] = [
  ...ALLERGEN_MARKERS,
  ...DIETARY_RESTRICTION_MARKERS,
]

/**
 * Normalize a reference for marker matching: camelCase split, diacritics
 * stripped (`glúten` -> `gluten`, `alérgenos` -> `alergenos`), lowercased, and
 * `-` / `.` / `/` / whitespace folded to `_` so hyphen-, dot- and
 * underscore-separated ids all normalize the same way. Deterministic and
 * locale-independent (no `toLocaleLowerCase`).
 */
export function normalizeReference(reference: string): string {
  // The accent/case fold is shared with the conversation projection's own
  // normalizer (LE2-033) — see `../text-normalization.ts` for why only the
  // HEAD is shared and the separator tail below stays local to this caller.
  return normalizeDiacritics(reference.replace(/([a-z0-9])([A-Z])/g, "$1_$2")).replace(
    /[\s./\-]+/g,
    "_",
  )
}

/** Does `marker` fire on an already-normalized reference? */
function markerHits(marker: SafetyMarker, normalized: string): boolean {
  if (marker.match === "stem") return normalized.includes(marker.token)
  // `word`: the `\b` boundary of the source regex, in identifier space — the
  // token must be a whole separator-delimited segment (optionally pluralized,
  // mirroring `castanhas?` / `ovos?` / `mariscos?`).
  return normalized
    .split("_")
    .some((segment) => segment === marker.token || segment === `${marker.token}s`)
}

/**
 * The safety marker `reference` carries, or `undefined`. Allergen markers are
 * tested first, so a reference matching both families
 * (`alergenos_sem_lactose`) is reported under the stricter, longer-standing
 * ruling. Within a family, declaration order decides and the FIRST hit wins —
 * deterministic, and the diagnostic names the token that fired.
 */
export function safetyMarkerOf(reference: string): SafetyMarker | undefined {
  const normalized = normalizeReference(reference)
  return SAFETY_MARKERS.find((marker) => markerHits(marker, normalized))
}
