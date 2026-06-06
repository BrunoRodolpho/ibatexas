# `deep-audit/` — pre-cutover deeper audit pass (2026-05-23)

## What's in this directory

Nine specialised auditor reports plus a master synthesis, produced on
2026-05-23 against the branch `feat/adjudicate-w6-tests-docs` (102 commits
ahead of origin; W1-W6 remediation already merged). This audit was a
*deeper* pass than the original `audit/` sweep: each auditor distrusted
the W1-W6 remediation claims and verified them by walking the
implementation against the original P0/P1 findings.

The headline verdict was **NO-GO for ANY rollout (including Tier 1 shadow)**.
The audit surfaced 17 net-new P0s, 15+ P1s, broken kill-switch CLI, ghost
metrics, doc/reality drift, and unit-tests-in-disguise integration tests.
That verdict drove Waves 7-9 of correctness-remediation and the IBX-IGE
v3.0 always-on cutover (`f3bea43`) — which deleted the shadow/enforce
framework these audits had built up.

All findings here have been worked through. The current "what remains"
ledger is [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md).

## Classification

| File | Classification | One-line summary |
|---|---|---|
| `MASTER-DEEP-AUDIT.md` | Historical preserved | Master keystone: "NO-GO" verdict, 17 new P0s, drove Waves 7-9. |
| `01-architecture-coupling.md` | Historical preserved | Domain-layer as kernel-adapter, dispatcher seam race, env-var sprawl. |
| `02-remediation-verification.md` | Historical preserved | Per-fix scorecard against W1-W6 claims (VERIFIED / PARTIAL / WEAKER-THAN-CLAIMED). |
| `03-concurrency-races.md` | Historical preserved | Redis-key choreography, two-phase commit recovery, refund-cap TOCTOU. Surfaced P0-2 race v2 lineage. |
| `04-scalability-10x.md` | Historical preserved | SRE/performance 10x load audit (defer-resolver SCAN amplification, Prisma pool, etc.). Open at higher horizon. |
| `05-hidden-bugs.md` | Historical preserved | Empty-string principals, NaN refund magnitude, redactor regex order, anonymize transaction timeout. |
| `06-docs-vs-reality.md` | Historical preserved | ~140 claims checked across 19 docs; 32 drifts + 16 ghosts. Drove the doc-cleanup arc (civilization-health). |
| `07-test-quality.md` | Historical preserved | Test-quality audit: what tests CLAIM vs what they actually exercise. Drove Wave-7 fault-injection + conformance suites. |
| `08-operational-readiness.md` | Historical preserved | "Ops surface mostly paper" finding: ghost CLI, ghost dashboards, ghost metrics. Cutover deleted most assumed surface. |
| `09-code-quality-debt.md` | Historical preserved | Parallel-surface dragging (D8 deprecation backlog), pack-scaffolding boilerplate, config sprawl. |

## Current-state pointers

- **Closeout status (authoritative as of 2026-05-24):** [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md)
- **Constitutional rule:** `CLAUDE.md` rule #9 — "LLM Authority — IBX Intent-Gated Execution v3.0"
- **Always-on cutover commit:** `f3bea43` (deleted shadow/enforce/kill-switch machinery and ~11 ghost metrics)
- **Civilization-health meta-review:** [`../CIVILIZATION-HEALTH-2026-05-24.md`](../CIVILIZATION-HEALTH-2026-05-24.md)
