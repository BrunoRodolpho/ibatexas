# Execution decisions — bruno-stack-agents-plan-v2.md

Running log of assumptions and decisions made during autonomous execution (started 2026-06-11).
Per the goal directive: ambiguities are resolved with the most logical engineering assumption,
documented here, and execution proceeds immediately.

## D-001 — The six pending decision requests (plan §4) are resolved by adopting the plan's own recommendations

The plan marked DR-1..DR-6 "pending user". The user instructed full execution without stopping
for clarification; each DR carries an explicit "Recommend:" produced by the verification+critique
process. Adopting them:

- **DR-1**: Nightly certification at prod parity (`claude-sonnet-4-6`); cheap-model dev profile marked non-certifying in `sim_runs`; pre-flight asserts model == certification target.
- **DR-2**: Phase 1 ships a publish-incapable NATS capture client + check-bypass leg; NATS server-side auth runbook executes at Phase-3 entry (T3-10).
- **DR-3**: Adjudicate console gets `/agents` only; coverage/run-explorer/graphs go to the QA viewer (T2-5); "never a new app" struck.
- **DR-4**: P0-9 injects `PostgresAdvisorySessionLock` now; T3-0 upstream PR bundles ChannelKind widening + lock-key strategy honoring `sessionKey`.
- **DR-5**: Coverage domain = chat-drivable registered tools × pack-declared decision kinds (cell-level) ∪ staff-route envelope kinds; waiver categories `waived-pending-WS4`, `waived-unadvertised`, `waived-quarantined`.
- **DR-6**: Projection-grade approver identity for Phase 3 (`resolvedBy` + supersession chain; `INV-AGENT-CONFIRM-LINEAGE` documents the trust boundary); kernel receipt extension deferred to Phase 4.

## D-002 — decisions.md location

The goal names `decisions.md` without a path. It lives at `/Users/thaisrodolpho/projects/decisions.md`
(sibling of the plan file it accompanies). A durable copy lands in `ibatexas/docs/agents/` with P0-10's
decision-record commit, and is kept in sync at each phase boundary.

## D-003 — Commit strategy

The plan doesn't specify granularity. Each P0/T task gets its own commit in the owning repo with the
task id in the subject (e.g. `P0-1: wire createRedisLedger into buildAdjudicator`), so the decision
record maps 1:1 to the history. Work happens on a branch `agents/phase-0` (etc.) per phase; no pushes
to any remote without explicit instruction.

## D-004 — Execution order within Phase 0

P0-1, P0-2, P0-6, P0-7, P0-8, P0-9 all touch `apps/api/src/claustrum-bootstrap.ts` → executed
sequentially (P0-1 → P0-2 → P0-6 → P0-8 → P0-7 → P0-9) to avoid merge conflicts. P0-3, P0-4, P0-11
are file-disjoint → parallel. P0-5 runs after P0-1 (rule-9 wording dependency); P0-10 closes the phase.

## D-005 — Docker dependency

Docker daemon was down at session start; started Docker Desktop (came up as 29.5.3). Testcontainer-based
acceptance tests (P0-1, P0-2, P0-9) run against it; `testcontainers@^12` was already an apps/api devDep.

## D-006 — Phase 0 baseline

`pnpm --filter @ibatexas/api test` at branch point (01d2d0a): 144 files / 1377 passed / 15 skipped / exit 0
(log: /tmp/api-test-baseline.log). "No new failures" for Phase 0 is measured against this. Note: the repo
already has an env-gated real-Redis test idiom (`REDIS_TEST_URL` skip-guards) alongside testcontainers —
agents may use either pattern where the plan says "real-Redis test".

## D-007 — CLAUDE.md "only run tests when explicitly requested" vs plan verify steps

ibatexas CLAUDE.md's Agent Behavior section discourages unprompted test runs. The plan's per-task
acceptance criteria explicitly name verify commands; executing the plan includes running them. The plan
(and the goal directive) take precedence for this initiative.
