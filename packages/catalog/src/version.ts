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
// v6 (LE2-021) — the workflow corpus's claim-param vocabulary is corrected and
// the correction is enforced: the fixture workflow's claim param moved from
// `{claimType: "order-placed", field: "orderId"}` (a success-class id and a
// field no registry type carries) to `{claimType: "ORDER_HISTORY", field:
// "historySummaryText"}`, and the new `claim-param-type-unknown` rule in the
// `workflow-shape` pass makes the old spelling a build error. The README's
// FIRST trigger does not fire — no capability field changed — but the THIRD
// does, read at its intent: an instance PINS this serial, and a workflow
// compiled while `order-placed` was an accepted claim-param type is not
// replayable against one compiled after it stopped being one.
// v7 (LE2-021) — the first CUSTOMER-FACING workflow. Four changes, one serial
// because they land in one commit: (a) a new capability,
// `order.reorder.request`, the reorder-last workflow's identity-tier governance
// anchor; (b) `WORKFLOW_DEFINITIONS` stops being empty —
// `workflow.orders.reorder-last` is authored into it; (c) the workflow contract
// in `src/workflows/types.ts` gains `triggerPhrasings`, and those phrasings now
// FEED the selection surface, so what the model is offered for a given
// utterance genuinely differs before and after this serial; (d) two new
// `workflow-shape` rules police them.
//
// The README's FIRST trigger fires (a capability was added). It is bumped from
// 6 rather than folded into it deliberately: v6 is already pushed as a distinct
// catalog, and the README's "Never reuse a value — two different catalogs
// sharing a version breaks replay" is unconditional. A workflow INSTANCE pins
// this serial and resumes against it across the confirm park, which makes the
// no-reuse rule load-bearing here rather than bookkeeping.
// v8 (LE2-022) — the WORKFLOW RUNTIME v1 contract. The workflow definition
// shape gains four things, and every one of them changes what a definition
// MEANS rather than only what it may say: `prechecks` (feasibility, evaluated
// before any confirm is shown), `route` (conditional edges over the activity
// pool), `WorkflowActivity.compensation` (what undoes a step, or the authored
// statement that nothing does), and two new outcomes — `compensated` and
// `stranded` — with the `outcomes` record's compensation half now conditionally
// required. The `workflow-runtime-shape` pass and its ten rules police all of
// it, and both authored corpora move with the contract: the reorder-last
// activity declares a terminal marker, and the fixture corpus gains a second
// workflow exercising the three new mechanisms.
//
// The README's FIRST trigger does NOT fire — no capability was added and no
// capability field changed. The THIRD does, and here it fires at its letter
// rather than only at its intent: an instance PINS this serial and RESUMES on
// the shape it pinned, so a workflow instantiated under v7 and one instantiated
// under v8 are not the same run even for byte-identical authored data — v7 had
// no route to resume onto, no pre-check that could have refused before the
// park, and no compensator to run on the way out. That is precisely the
// no-reuse rule's load-bearing case, and LE2-022's own park/resume AC is a test
// of it.
// v9 (LE2-023) — the SWAP-FOR-COUPON contract. `src/workflows/types.ts` gains
// four things, and the README's workflow-contract trigger fires on all of them
// because each changes what a definition MEANS, not only what it may say:
// `WorkflowConfirmCoverage` + `WorkflowConfirmPoint.statesFacts` (an activity's
// own REQUEST_CONFIRMATION may be declared already-asked by the whole-workflow
// confirm — the narrowest possible refinement of LE2-022's blanket rule, and the
// first time a definition can say anything about what its confirm TOLD the
// customer); the `whenPolicyOpen` route step plus `policyOpen` (a branch that is
// compiled in and closed by absence); and the `escalated` outcome (a run that
// stopped because a human must now decide — the first outcome whose story is not
// over when the run ends). `src/workflows/facts.ts` gains five members, which is
// a projection-semantics change under the README's fifth trigger.
//
// It matters for replay in the way v8's note describes and then some: an
// instance pins this serial and RESUMES on the shape it pinned, and a workflow
// instantiated under v8 had no way to express that its confirm covered a step's
// own confirm. The same authored bytes therefore do not describe the same run
// across the boundary — a v8 instance stops at an activity confirm that a v9 one
// resolves, which is a different set of mutations for one customer "sim".
// v10 (LE2-023, second slice) — the CAPABILITY CONTRACT gains `escalatable?:
// true`, so the README's SECOND trigger fires at its letter ("src/capability-
// definitions/types.ts — the field contract itself"), and four capabilities gain
// the field (`order.cancel`, `payment.refund.issue`, `payment.dispute.open`,
// `reservation.create`), which is the FIRST trigger as well.
//
// Bumped from 9 rather than folded into it because v9 is already pushed, and the
// README's "never reuse a value" is unconditional. It is load-bearing here for
// the usual reason and one more: the new `escalated-outcome-template-missing`
// rule reads this field, so a workflow that compiled clean under v9 can fail to
// compile under v10 without a single byte of its own definition changing.
// v11 (LE2-023, third slice) — a new CAPABILITY: `order.coupon.swap.request`,
// the swap-for-coupon workflow's identity-tier governance anchor. The README's
// FIRST trigger, at its letter ("adding… a capability").
//
// Bumped from 10 rather than folded into it for the same unconditional reason
// the last two slices were, and with the same replay consequence: this serial is
// what an instance PINS, and a turn adjudicated when this kind did not exist is
// not reproducible against a catalog where it does. The anchor is also the one
// kind whose absence changes what the PARSER is offered — `advertise` gates the
// workflow on its matchers, and a definition anchored on a kind the catalog does
// not declare is `capability-reference-dangling`, a build error — so v10 and v11
// genuinely describe two different surfaces rather than two spellings of one.
export const CATALOG_VERSION: number = 11
