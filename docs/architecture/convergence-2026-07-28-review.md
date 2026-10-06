# Architecture convergence — 2026-07-28 review

> **Status record, updated 2026-08-04.** The Architecture Review of 2026-07-28
> (evidence baseline `c21d907f`, branch `dev`) produced seven recommendations,
> R1–R7. This doc is the in-repo record of each recommendation's terminal
> disposition and, where a recommendation is blocked, the **explicit prerequisite**
> that gates it. Per-slice evidence lives in the PR bodies and commit messages;
> the full cycle-by-cycle ledger lives in the governor workspace
> (`improve-code-architecture/ibatexas/GOVERNOR.md`, outside this repo).

**LANDED 2026-08-04.** All 35 program PRs merged to `dev` in cascade order under
the owner's explicit admin authorization, followed by two cross-stack
integration fixes (#508: `selectionAnchors` on the harness's inert
`WorkflowRuntime` stub, the compile-time collision the stub is designed to
catch; #509: the r2s8 union-probe utterance disambiguated past the
default-wired funnel — the F-1 alias class). Dev's full CI is green at
`47d5519b` (472 files / 7,293 passing). Every PR was verified per-slice — line
review, suite arithmetic, and revert-to-red — before it was opened; the full
merged-suite CI run is the empirical census that exactly two cross-stack
collisions existed. Branch pointers below now resolve directly on `dev`.

## Per-recommendation disposition

| Rec | Intent | Disposition | Evidence / blocking prerequisite |
|-----|--------|-------------|----------------------------------|
| R1 | One customer-plane composition (`composeCustomerConductor`); bootstrap + e2e harness as its two adapters | **Implemented + verified + merged** | PRs #467, #468 (merged 2026-08-04). |
| R2 | Finish the claimdef compiler: every compilable claim type authored as one `.claim.ts` file | **Implemented, full scope** | 9 slices, PRs #469→#472→#476→#480→#482→#483→#484→#489→#490. 22/23 types generated; `PURCHASE_COMPLETED` **excluded by design** (action claim, no compiler render shape) with a census pin partitioning the registry so a second action claim must re-argue the ruling. |
| R3 | Per-kind resolution profile: one declared row per intent kind; confirm mirror derived, ctx signal channel typed | **Implemented, full scope** | 4 slices, PRs #470→#479→#491→#492. 21-row profile table on 3 independent axes; typed six-signal ctx contract (a typo'd flag is now a compile error); zero intent-kind gates remain in `resolve-and-assemble.ts` (grep-proof census). |
| R4 | One ingress-turn seam: park-reply triage decision table + ambient-context nesting in one module | **Implemented (delivered scope) — harness leg now UNBLOCKED** | PRs #475 (triage decision seam; three consumers byte-identical) and #477 (per-turn context choreography; five ingress probes), merged. The harness leg's prerequisite (#467 merged) is satisfied as of 2026-08-04 — it is the program's next actionable slice: harness onto `runTurnWithContexts`, killing the fourth `confirmWindowOpen` derivation. |
| R5 | Client-boundary seams for `@ibatexas/domain` and `@ibatexas/tools`, one canonical in-memory adapter each | **Implemented (delivered scope) — remainder blocked** | 11 slices: package seams + canonical adapters (PRs #473, #499), route composition roots (#478, #497, #505), typed triad-backend builder + sweeps (#495, #496, #504), Redis-double migrations + census (#500, #501, #502). Two remainders: (1) **owner ruling on multi()/eval doubles** — ≥25 files; decision evidence in `apps/api/src/__tests__/helpers/redis-double-census.md` (still owner-gated); (2) **composition-root threading of the 65 direct `getRedisClient` callers** — its prerequisite (the route-roots stack merged) is satisfied as of 2026-08-04; actionable. |
| R6 | Collapse add-a-kind registration fan-out: regen-owned pack mirrors, anchor factory, judgment slots | **Implemented, full scope** | 4 slices, PRs #471→#474→#493→#494 (+ #503 doc-count gate fix). 13 mirror files regen-owned; anchor factory with declared authored description (loud mint-time failure); count pins consolidated to one constant. The judgment-slot leg for the audit redactor was **refused with simulated evidence** — projecting the hand mirror would blind its own agreement gate; recorded in `docs/architecture/design/fe4-drift-gates.md` (refusal section carried by PR #494) so it is not re-proposed. |
| R7 | One candidate-assembly module in the claim planner | **Refused / superseded with evidence** | PR #498. Measurement killed the concentration claim (placeholder no-ops; predicates already shared; one site's port carries no ledger). The live hazard was **parity**, not duplication: two real drifts found and pinned with 11 directional tests. Re-proposal bar recorded in `docs/architecture/design/r7-candidate-assembly.md` (carried by PR #498). |

## What remains after the landing

1. **Actionable (governor, in flight):** the R4 harness leg (harness onto
   `runTurnWithContexts` + the production composer) and the R5
   composition-root threading (the 65 direct `getRedisClient` callers onto the
   S5/S6 seams). Both prerequisites were satisfied by the 2026-08-04 landing.
2. **Owner rulings.** The open decision surface (safety-first ordering:
   alias-clarify vs §O#9 routing, the cart-creation lock, park-nx release,
   date-anchored hours degrade; then the product findings; then the
   multi()/eval double decision) is enumerated with evidence pointers in the
   owner queue.

Once the two remaining R4/R5 legs land and the multi()/eval ruling resolves,
this doc should be retired to git history — it records the state of a program,
not a standing invariant.
