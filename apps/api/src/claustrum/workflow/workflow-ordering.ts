// The workflow layer's STATED COLLATION (LE2-020).
//
// Every ordered thing this layer produces is a determinism artifact, and two of
// them are load-bearing well beyond readability:
//
//   - `AdvertisedWorkflow.slots` goes into the `start_workflow` tool
//     DESCRIPTION, which is part of the tool surface `buildParseCacheKey`
//     digests. An order that wobbled between two otherwise identical turns
//     would change the L1 cache key and turn every repeat into a miss — a
//     silent, expensive regression that no test would name.
//   - `WorkflowParamResolution.unresolved` is logged verbatim and decides a
//     run's fail-closed path, so it must read the same way twice.
//
// `Array.prototype.sort()` with no comparator coerces elements to strings and
// compares UTF-16 code units. For an array that is ALREADY `string[]` that is
// exactly what this comparator does — so adopting it changes no order anywhere
// (see the PR's note; nothing moved). What it changes is that the collation is
// now STATED rather than inherited from a default that would silently become
// wrong the day someone sorts numbers or tuples with it.
//
// Locale-independent BY CONSTRUCTION: no `localeCompare`, so CI output cannot
// depend on the machine's locale. Same idiom as the catalog compiler's
// `sortDiagnostics` (`packages/catalog/src/compiler/diagnostics.ts`), which
// states the identical rule for the same reason.

/**
 * Byte-wise (UTF-16 code unit) comparison of two strings. Total and
 * locale-independent.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A new array of `values` in stated code-unit order. Never sorts in place —
 * the input may be a caller's array (or, worse, one it exposes as readonly),
 * and an ordering helper has no business mutating it.
 */
export function sortedByCodeUnits(values: Iterable<string>): readonly string[] {
  return [...values].sort(compareCodeUnits);
}
