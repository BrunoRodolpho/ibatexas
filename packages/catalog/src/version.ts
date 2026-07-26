// The CATALOG VERSION — the monotonic serial of the business-definition root
// (LE2 Implementation Decision 13: "capability definitions and claim-registry
// references move under one versioned root with cross-reference checks; every
// turn stamps the catalog version into its trace").
//
// HAND-AUTHORED, never computed. A derived version (content hash, git sha,
// build timestamp) would change on every unrelated edit and would not be
// reviewable in a diff — the whole point of the stamp is that a human decided
// "the business definition changed" and a reviewer can see that decision.
//
// The bump discipline lives in this package's README ("Version-bump
// discipline"). In one line: bump by exactly +1 in the same commit as any
// change to the capability definitions or the claim-reference vocabulary;
// never reuse a value, never decrease.
//
// Typed `number` (not a literal) deliberately: consumers stamp it into a trace
// column, they never branch on its value. A literal type would invite
// `catalogVersion === 1` comparisons, which is exactly the runtime authority
// the catalog must never hold (Decision 13: "the catalog defines; it never
// holds runtime authority").
export const CATALOG_VERSION: number = 2
