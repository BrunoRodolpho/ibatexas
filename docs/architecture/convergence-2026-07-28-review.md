# Architecture convergence — 2026-07-28 review

> **Status record, updated 2026-08-04.** The Architecture Review of 2026-07-28
> (evidence baseline `c21d907f`, branch `dev`) produced seven recommendations,
> R1–R7. This doc is the in-repo record of each recommendation's terminal
> disposition and, where a recommendation is blocked, the **explicit prerequisite**
> that gates it. Per-slice evidence lives in the PR bodies and commit messages;
> the full cycle-by-cycle ledger lives in the governor workspace
> (`improve-code-architecture/ibatexas/GOVERNOR.md`, outside this repo).

All delivery happened as stacked PRs off `dev`; **nothing below has merged yet**
(`dev` is still at the review baseline). Every PR was verified per-slice —
line review, suite arithmetic, and revert-to-red — before it was opened, and
every open PR is gate-clean as of this doc's date. Files cited from a branch
are marked with the PR that carries them; those pointers resolve on `dev` once
the cascade completes.

## Per-recommendation disposition

| Rec | Intent | Disposition | Evidence / blocking prerequisite |
|-----|--------|-------------|----------------------------------|
| R1 | One customer-plane composition (`composeCustomerConductor`); bootstrap + e2e harness as its two adapters | **Implemented + verified — merge-gated** | PRs #467, #468. Prerequisite: the repo's required review on `dev` (1 approval; auto-merge disabled; admin bypass deliberately unused). |
| R2 | Finish the claimdef compiler: every compilable claim type authored as one `.claim.ts` file | **Implemented, full scope** | 9 slices, PRs #469→#472→#476→#480→#482→#483→#484→#489→#490. 22/23 types generated; `PURCHASE_COMPLETED` **excluded by design** (action claim, no compiler render shape) with a census pin partitioning the registry so a second action claim must re-argue the ruling. |
| R3 | Per-kind resolution profile: one declared row per intent kind; confirm mirror derived, ctx signal channel typed | **Implemented, full scope** | 4 slices, PRs #470→#479→#491→#492. 21-row profile table on 3 independent axes; typed six-signal ctx contract (a typo'd flag is now a compile error); zero intent-kind gates remain in `resolve-and-assemble.ts` (grep-proof census). |
| R4 | One ingress-turn seam: park-reply triage decision table + ambient-context nesting in one module | **Implemented (delivered scope) — harness leg blocked** | PRs #475 (triage decision seam; three consumers byte-identical) and #477 (per-turn context choreography; five ingress probes). Prerequisite for the harness leg: **#467 must merge first** — the harness became the production composer's second adapter in the R1 stack, so converging it onto `runTurnWithContexts` builds on that merge. |
| R5 | Client-boundary seams for `@ibatexas/domain` and `@ibatexas/tools`, one canonical in-memory adapter each | **Implemented (delivered scope) — remainder blocked** | 11 slices: package seams + canonical adapters (PRs #473, #499), route composition roots (#478, #497, #505), typed triad-backend builder + sweeps (#495, #496, #504), Redis-double migrations + census (#500, #501, #502). Two blocked remainders: (1) **owner ruling on multi()/eval doubles** — ≥25 files; decision evidence in `apps/api/src/__tests__/helpers/redis-double-census.md` (carried by PR #501); (2) **composition-root threading of the 65 direct `getRedisClient` callers** — prerequisite: the route-roots stack (#478→#497→#505) merged, since the threading lands on those roots. |
| R6 | Collapse add-a-kind registration fan-out: regen-owned pack mirrors, anchor factory, judgment slots | **Implemented, full scope** | 4 slices, PRs #471→#474→#493→#494 (+ #503 doc-count gate fix). 13 mirror files regen-owned; anchor factory with declared authored description (loud mint-time failure); count pins consolidated to one constant. The judgment-slot leg for the audit redactor was **refused with simulated evidence** — projecting the hand mirror would blind its own agreement gate; recorded in `docs/architecture/design/fe4-drift-gates.md` (refusal section carried by PR #494) so it is not re-proposed. |
| R7 | One candidate-assembly module in the claim planner | **Refused / superseded with evidence** | PR #498. Measurement killed the concentration claim (placeholder no-ops; predicates already shared; one site's port carries no ledger). The live hazard was **parity**, not duplication: two real drifts found and pinned with 11 directional tests. Re-proposal bar recorded in `docs/architecture/design/r7-candidate-assembly.md` (carried by PR #498). |

## What unblocks the blocked items

1. **The merge cascade.** Six stack bases carry full CI: #467 (R1), #469 (R2),
   #470 (R3), #471 (R6), #473 (R5), #475 (R4). Merging any base auto-retargets
   its stack's next PR to `dev`; the retargeted PR needs one CI nudge
   (close/reopen or an empty commit) before its own merge. **Merge an
   audit-fix carrier first** — #469, #473, or this PR — because `dev` itself
   predates the 2026-08-03 advisory wave (undici / fast-uri / brace-expansion
   floor bumps) and its push-CI reds on the audit step until a carrier lands.
   This PR is the smallest such carrier (doc + audit fix only).
2. **Owner rulings.** The open decision surface (safety-first ordering:
   alias-clarify vs §O#9 routing, the cart-creation lock, park-nx release,
   date-anchored hours degrade; then the product findings; then the
   multi()/eval double decision) is enumerated with evidence pointers in the
   owner queue delivered alongside the PR set.

Once the cascade completes and the two R5 remainders are either delivered or
ruled out of scope, this doc should be updated (or retired to git history) —
it records the state of a program, not a standing invariant.
