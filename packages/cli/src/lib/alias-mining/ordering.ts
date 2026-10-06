// ordering.ts — the one string collation the miner sorts under (LE2-026).
//
// A mining report is a DETERMINISM ARTIFACT: two runs over unchanged stores must
// produce the same rows in the same order, on any machine, or the diff between
// two reports stops meaning "the vocabulary moved" and starts meaning "something
// about the environment differed". Every ordering in the miner therefore names
// its collation instead of taking whatever the platform's default happens to be.
//
// Byte-wise, NO locale collation — the same choice `sortDiagnostics` makes in
// `packages/catalog/src/compiler/diagnostics.ts`, and for the same stated reason
// there: locale collation would make output machine-dependent. `localeCompare`
// would be the more "natural" reading for a human scanning pt-BR surface forms
// (it sorts "água" next to "agua" rather than after "z"), and that is exactly
// the tradeoff being declined — a report that sorts differently under a
// different ICU build is worse than one that sorts a little oddly everywhere.
//
// Pure: no clock, no RNG, no IO, no locale.

/**
 * Byte-wise string comparison: -1, 0 or 1, never locale-aware.
 *
 * Use this for EVERY string ordering in the miner. A bare `.sort()` is not an
 * acceptable substitute even where its output happens to match today: it sorts
 * by `String(x)`, which silently stringifies non-strings (an entry tuple becomes
 * `"catalog-gap,8"`) and leaves the collation unstated.
 */
export function compare(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** {@link compare} lifted to a keyed comparator, for sorting objects/tuples. */
export function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => compare(key(a), key(b))
}
