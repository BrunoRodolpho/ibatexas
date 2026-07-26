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
// v3 (LE2-033) — the conversation projection: `conversationTriggers`, a new
// REQUIRED slot on every chat-tier capability, populated for all 20. Both
// halves of the bump discipline's first trigger ("adding, removing, or
// editing a capability; changing any field on one" AND "the field contract
// itself") apply, so the serial moves even though no existing field changed.
// v4 (LE2-025a) — the alias gazetteer: `src/alias-gazetteer.ts`, nine authored
// surface-form -> canonical-entity edges, and the compiler pass that keeps them
// unambiguous and safety-free. No capability field changed, so the README's
// first trigger does not fire; the serial moves under the third ("a projection
// semantics change") read at its intent rather than its letter. The version is
// stamped into a turn's trace so a historical turn can be re-run against the
// business definition it saw, and the set of colloquials the system will
// canonicalize is part of that definition — the day the runtime half reads
// this table, a turn compiled under v3 and one under v4 are not replayable
// against each other.
// v5 (LE2-020) — workflows: `src/workflows/` (the definition shape, the corpus,
// and its projections), a new optional `workflowScoped` slot on the capability
// contract, `order.reorder` declared into the workflow-scoped access class, and
// the `workflow-shape` compiler pass. The README's FIRST trigger fires twice
// over: a field was added to the capability contract, and a capability's fields
// changed. It matters more than the usual bump: an instance PINS the catalog
// version it started under, so this serial is what a mid-flight workflow
// resumes against — and a turn compiled while `order.reorder` was still an
// ordinary unadvertised kind is not replayable against one compiled after it
// became workflow-scoped.
export const CATALOG_VERSION: number = 5
